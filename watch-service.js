import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';

// Leave custom filesystems and filesystem policy implementations that supply
// their own watch method in charge of how targets are observed.
export function localWatch(ctx, settings) {
  if (process.platform !== 'darwin') return;
  const fs = ctx.fs;
  let owner = fs;
  while (owner && !Object.hasOwn(owner, 'watch')) owner = Object.getPrototypeOf(owner);
  if (owner?.constructor?.name !== 'LocalFileSystem') return;
  const original = owner.watch;
  const files = ctx.workspaceFiles;
  const nativeChanges = files.changes;
  const changesDescriptor = Object.getOwnPropertyDescriptor(files, 'changes');
  const watchDescriptor = Object.getOwnPropertyDescriptor(fs, 'watch');
  if (typeof nativeChanges !== 'function' || changesDescriptor?.configurable === false || watchDescriptor?.configurable === false) return;
  const preview = new AsyncLocalStorage();
  // A preview feed is lazy: its watch starts during iterator.next(), after
  // changes() has returned. Scope each advance, never the caller's work.
  async function* changes(...args) {
    const source = preview.run(true, () => nativeChanges.apply(this,args)[Symbol.asyncIterator]());
    try {
      for (;;) {
        const frame = await preview.run(true, () => source.next());
        if (frame.done) return frame.value;
        yield frame.value;
      }
    } finally {
      if (source.return) await preview.run(true, () => source.return());
    }
  }
  const worker = new Worker(new URL('./watch-worker.js', import.meta.url), {execArgv:[], workerData:settings});
  const subscribers = new Map();
  let nextId = 0, disabled = false, disposed = false;
  function fail(error) {
    if (disabled) return;
    disabled = true;
    for (const sub of [...subscribers.values()]) sub.fail(error);
  }
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('File observation worker ended')));
  worker.on('message', msg => {
    const sub = subscribers.get(msg.id);
    if (!sub) return;
    if (msg.kind === 'ready') sub.ready();
    if (msg.kind === 'change') sub.changed();
    if (msg.kind === 'error') sub.fail(new Error(msg.message));
  });
  worker.unref();
  async function watch(target, changed, signal) {
    if (disabled || !preview.getStore()) return original.call(this, target, changed, signal);
    signal.throwIfAborted();
    const path = resolve(this.processPath(target));
    const directory = (await this.stat(target, signal))?.type === 'directory';
    signal.throwIfAborted();
    if (disabled) return original.call(this, target, changed, signal);
    const id = ++nextId, root = directory ? path : dirname(path);
    try {
      return await new Promise((accept, reject) => {
        let ready = false;
        const release = () => {
          if (!subscribers.delete(id)) return;
          signal.removeEventListener('abort', cancel);
          if (!disabled) worker.postMessage({kind:'release', id});
        };
        const cancel = () => { release(); reject(signal.reason); };
        subscribers.set(id, {
          changed,
          ready() { if (!ready) { ready = true; accept(async () => { release(); }); } },
          fail(error) { release(); if (ready) changed(error); else reject(error); },
        });
        signal.addEventListener('abort', cancel, {once:true});
        worker.postMessage({kind:'open', id, root, file:directory ? null : path});
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!disabled || disposed) throw error;
      return original.call(this, target, changed, signal);
    }
  }
  Object.defineProperty(files, 'changes', {value:changes, configurable:true, writable:true});
  Object.defineProperty(fs, 'watch', {value:watch, configurable:true, writable:true});
  return () => {
    disposed = true;
    if (Object.getOwnPropertyDescriptor(files, 'changes')?.value === changes) {
      if (changesDescriptor) Object.defineProperty(files, 'changes', changesDescriptor);
      else Reflect.deleteProperty(files, 'changes');
    }
    if (Object.getOwnPropertyDescriptor(fs, 'watch')?.value === watch) {
      if (watchDescriptor) Object.defineProperty(fs, 'watch', watchDescriptor);
      else Reflect.deleteProperty(fs, 'watch');
    }
    preview.disable();
    fail(new Error('File observation plugin unloaded'));
    return worker.terminate().then(() => {});
  };
}
