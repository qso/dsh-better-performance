window.__ModuleLoader__.load({
  id: 'dsh-better-performance',
  factory(require) {
    const React = require('react');
    const mediaTypes = {
      mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
      flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus',
    };

    function retainRecent(ctx, prefs) {
      const held = new Map();
      const failed = new Set();
      let disposed = false;
      let queued = false;
      function drop(id) {
        const item = held.get(id);
        if (!item) return;
        held.delete(id);
        item.ref.release();
      }
      function update() {
        queued = false;
        if (disposed) return;
        const { ids, byId } = ctx.sessions.list.getSnapshot();
        const active = ids.filter(id => byId[id]?.retainedBy.mainView > 0);
        for (const id of failed) if (!active.includes(id)) failed.delete(id);
        for (const [id, item] of held) {
          if (!ids.includes(id) || (!active.includes(id) && Date.now() - item.last > prefs.retainMinutes * 60000)) drop(id);
        }
        for (const id of active) {
          if (failed.has(id)) continue;
          let item = held.get(id);
          if (!item) {
            const ref = ctx.sessions.retain(id, { source: 'betterPerformanceRecent' });
            item = { ref, last: Date.now() };
            ref.ready.catch(() => {
              if (held.get(id)?.ref === ref) { failed.add(id); drop(id); }
            });
          }
          item.last = Date.now();
          held.delete(id);
          held.set(id, item);
        }
        for (const id of held.keys()) {
          if (held.size <= prefs.maxSessions) break;
          if (!active.includes(id)) drop(id);
        }
      }
      function schedule() {
        if (!queued && !disposed) { queued = true; queueMicrotask(update); }
      }
      const unsubscribe = ctx.sessions.list.subscribe(schedule);
      const timer = setInterval(schedule, 30000);
      schedule();
      return () => {
        disposed = true;
        unsubscribe();
        clearInterval(timer);
        for (const id of held.keys()) drop(id);
      };
    }

    // Install only on this desktop client, and restore only our own method on unload.
    function decorate(object, key, build) {
      const original = object[key];
      if (typeof original !== 'function') return () => {};
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !descriptor.configurable) return () => {};
      const wrapped = build(original);
      Object.defineProperty(object, key, { configurable: true, writable: true, value: wrapped });
      return () => {
        if (Object.getOwnPropertyDescriptor(object, key)?.value !== wrapped) return;
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else Reflect.deleteProperty(object, key);
      };
    }

    function startDirectoryReads(ctx) {
      return decorate(ctx.remote, '$stream', original => function(options) {
        const stream = original.call(this, options);
        if (!options.name?.startsWith('directory ')) return stream;
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          const iterator = iterate();
          const first = iterator.next();
          // A synchronous first invalidation starts the authorized listing while the
          // native watch is opening. Its real ready frame causes a reconciliation.
          first.catch(() => {});
          try {
            yield { value: { kind: 'change' } };
            let item = await first;
            while (!item.done) {
              yield item.value;
              item = await iterator.next();
            }
          } finally {
            await stream.dispose();
          }
        };
        return stream;
      });
    }

    // Large complete reads can use DSH's own versioned media route. Authorize
    // the same file and method through the native gateway on every logical open.
    // Range reads, policy failures, version changes and unknown wire shapes
    // stay with the original transport. Nothing leaves the desktop origin.
    function fastBytes(original, receiver, channel, endpoint, payload, signal, cap) {
      const native = () => original.call(receiver, channel, endpoint, payload, signal);
      const args = payload?.args;
      if (!Number.isSafeInteger(cap) || !args?.options || Object.keys(args.options).length ||
          typeof args.path !== 'string' || !/\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm|wav|mp3|m4a|flac)$/i.test(args.path))
        return native();
      return (async () => {
        const probe = await original.call(receiver, channel, endpoint, {
          args: { ...args, options: { range: { offset: 0, length: 1 } } },
        }, signal);
        if (!probe.ok) return probe;
        const meta = probe.value;
        if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 262144 || meta.bytes > cap ||
            !meta.absolutePath || !meta.version) return native();
        const url = new URL('api/file', document.baseURI);
        url.search = new URLSearchParams({path:meta.absolutePath, v:meta.version});
        try {
          const response = await fetch(url, { signal, redirect:'error', credentials:'same-origin' });
          if (!response.ok) return native();
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.byteLength !== meta.bytes) return native();
          return {ok:true, value:{...meta, offset:0, data, eof:true}};
        } catch (error) {
          if (signal?.aborted) throw error;
          return native();
        }
      })();
    }

    function fileIntent(ctx, enableIntent, cap) {
      const lifetime = new AbortController();
      const rpc = ctx.connection.rpc;
      let pin, timer, hover, reader;
      function releasePin() {
        clearTimeout(timer);
        pin?.controller.abort();
        pin = undefined;
      }
      function releaseReader() {
        if (reader && !reader.adopted) reader.controller.abort();
        reader = undefined;
      }
      function target(event) {
        const button = event.target?.closest?.('button');
        const row = button?.closest('li[data-files-entry="file"]');
        if (!row || row.querySelector(':scope > div > button') !== button) return;
        const root = row.closest('[data-files-root]')?.dataset.filesRoot?.replace(/\/+$/, '');
        const session = row.closest('[data-sidebar-right-session]')?.dataset.sidebarRightSession;
        const path = row.dataset.filesPath;
        if (root === undefined || !session || !path?.startsWith(root + '/')) return;
        const relative = path.slice(root.length + 1);
        const encode = s => encodeURIComponent(s).replace(/%3A/gi, ':');
        return {session, path:relative, address:'dsh-resource://file/session/' + encode(session) + '/' + relative.split('/').map(encode).join('/')};
      }
      function prepare(file) {
        if (pin?.address !== file.address) {
          releasePin();
          pin = {address:file.address, controller:new AbortController()};
          ctx.resources.pin(file.address, pin.controller.signal);
        }
        clearTimeout(timer);
        timer = setTimeout(releasePin, 2400);
        if (reader?.address === file.address) return;
        releaseReader();
        const ext = file.path.split('.').pop().toLowerCase();
        if (Object.hasOwn(mediaTypes, ext) && document.documentElement.dataset.dshSplitSidebar) return;
        const bytes = /^(png|jpe?g|webp|gif|bmp|ico|pdf)$/.test(ext) || Object.hasOwn(mediaTypes, ext);
        const text = /^(txt|md|json|ya?ml|csv|log|js|ts|tsx|jsx|py|css|sh)$/.test(ext);
        if (!bytes && !text) return;
        const controller = new AbortController();
        const job = { address:file.address, controller, generation:ctx.connection.generation.getSnapshot(), arming:true };
        reader = job;
        // Binary speculation takes place on the click itself; hover warms only
        // the shared metadata. A single running speculative read is owned here.
        try {
          const api = ctx.remote.workspaceFiles;
          const result = bytes ? api.readBytes(file.session, file.path, {}, controller.signal)
            : api.read(file.session, file.path, {offset:1}, controller.signal);
          Promise.resolve(result).catch(() => {}).finally(() => {
            if (reader === job) reader = undefined;
          });
        } finally { job.arming = false; }
      }
      function point(event) {
        clearTimeout(hover);
        const file = target(event);
        if (!file) return;
        if (event.type === 'pointerdown' && event.button === 0 || event.type === 'keydown' && ['Enter',' '].includes(event.key)) {
          prepare(file);
          return;
        }
        if (event.type === 'keydown') return;
        hover = setTimeout(() => {
          if (pin?.address === file.address) return;
          releasePin();
          pin = {address:file.address, controller:new AbortController()};
          ctx.resources.pin(file.address, pin.controller.signal);
          timer = setTimeout(releasePin, 2000);
        }, 90);
      }
      const undo = decorate(rpc, 'call', original => function(channel, endpoint, payload, signal) {
        if (channel !== '/api' || !['workspaceFiles/read','workspaceFiles/readBytes'].includes(endpoint))
          return original.call(this, channel, endpoint, payload, signal);
        const run = () => endpoint === 'workspaceFiles/readBytes'
          ? fastBytes(original, this, channel, endpoint, payload, signal, cap)
          : original.call(this, channel, endpoint, payload, signal);
        const job = reader;
        if (!job || job.adopted) return run();
        const key = endpoint + JSON.stringify(payload);
        if (job.arming) {
          job.key = key;
          job.promise = run();
          return job.promise;
        }
        if (job.key !== key || signal?.aborted || job.controller.signal.aborted ||
            job.generation !== ctx.connection.generation.getSnapshot()) return run();
        job.adopted = true;
        const cancel = () => job.controller.abort();
        signal?.addEventListener('abort', cancel, {once:true});
        return job.promise.finally(() => signal?.removeEventListener('abort', cancel));
      });
      if (enableIntent) for (const name of ['pointerover','focusin','pointerdown','keydown']) {
        document.addEventListener(name, point, {capture:true, signal:lifetime.signal});
      }
      if (enableIntent) document.addEventListener('pointerout', () => clearTimeout(hover), {capture:true, signal:lifetime.signal});
      return () => { lifetime.abort(); clearTimeout(hover); releasePin(); releaseReader(); undo(); };
    }

    function MediaBody({ content, resourceAddress }) {
      const data = content.kind === 'bytes' ? content.data : undefined;
      const type = mediaTypes[resourceAddress.split('.').pop().toLowerCase()];
      const [source, setSource] = React.useState();
      const [error, setError] = React.useState(false);
      React.useEffect(() => {
        setError(false);
        if (!data || !type) return;
        const url = URL.createObjectURL(new Blob([data], { type }));
        setSource({ url, data });
        return () => URL.revokeObjectURL(url);
      }, [data, type]);
      if (!source || source.data !== data) return null;
      if (error) return React.createElement('p', { role:'status' }, '当前播放器无法解码此文件，可从标签菜单在本机播放器中打开。');
      return React.createElement(type.startsWith('audio/') ? 'audio' : 'video', {
        controls:true, playsInline:true, preload:'auto', src:source.url, onError:() => setError(true),
        style:{ display:'block', width:'100%', maxHeight:'75vh' },
      });
    }

    async function apply(ctx) {
      let prefs = window.__DSH_BETTER_PERFORMANCE_CONFIG__;
      if (typeof window.fetch === 'function') {
        const lifetime = new AbortController();
        ctx.effect(()=>()=>lifetime.abort(),'better-performance: load settings');
        try {
          const response = await fetch(new URL('api/better-performance-config',document.baseURI),
            {signal:lifetime.signal,credentials:'same-origin',redirect:'error'});
          if (response.ok) prefs = await response.json();
        } catch {}
        if (lifetime.signal.aborted) return;
      }
      prefs ??= {maxSessions:3,retainMinutes:5,earlyDirectoryReads:true,previewIntent:true};
      if (prefs.maxSessions) ctx.effect(() => retainRecent(ctx, prefs), 'better-performance: recent sessions');
      if (prefs.earlyDirectoryReads) ctx.effect(() => startDirectoryReads(ctx), 'better-performance: early directory listing');
      ctx.effect(() => fileIntent(ctx, prefs.previewIntent, prefs.previewBytes), 'better-performance: file preview intent');
      ctx.effect(() => {
        document.documentElement.dataset.dshBetterPerformance = '0.2.0';
        document.documentElement.dataset.dshBetterPerformanceWorker = String(prefs.watchWorker === true);
        return () => {
          delete document.documentElement.dataset.dshBetterPerformance;
          delete document.documentElement.dataset.dshBetterPerformanceWorker;
        };
      }, 'better-performance: installed version');
      const id = 'dsh-better-performance/media';
      const extensions = Object.keys(mediaTypes);
      ctx.effect(() => ctx.documentPreviews.register({id, extensions, binaryExtensions:extensions,
        priority:'builtin', title:() => '媒体播放器', loading:'bytes-complete'}), 'better-performance: media preview');
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
        { name:'sidebar.right.tab.document', key:id }, MediaBody)), 'better-performance: media player');
    }
    return { inject:['sessions','remote','remote.workspaceFiles','connection','resources','documentPreviews','slots'], apply };
  }
});
