import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { watch } from 'chokidar';

// Use DSH's own observation library and non-recursive settings. A directory
// and files immediately inside it need just one underlying watcher.
const roots = new Map();
const subscriptions = new Map();
const idle = new Map();
function close(root, entry) {
  if (roots.get(root) !== entry) return;
  clearTimeout(entry.timer);
  idle.delete(root);
  if (roots.get(root) === entry) roots.delete(root);
  void entry.watcher.close().catch(() => {});
}
function open(id, root, file) {
  // Reuse an explicit directory watch. A file opened directly from chat may
  // live in a huge directory that the user never expanded. Observe only that
  // filename in that case, exactly as the builtin local filesystem does.
  const directoryKey = 'directory:' + root;
  const key = file === null || roots.has(directoryKey) ? directoryKey : 'file:' + file;
  let entry = roots.get(key);
  if (!entry) {
    // On macOS, FSEventStreamStop can stall for seconds and the stream
    // can take much longer to deliver new entries. Poll only active targets
    // in the worker. Chokidar coalesces watchers for the same physical path.
    const watcher = watch(root, { depth:0, ignoreInitial:true, usePolling:true,
      interval:workerData.pollMs, binaryInterval:workerData.binaryPollMs, atomic:true,
      ...(key === directoryKey ? {} : {ignored:path => resolve(path) !== root && resolve(path) !== file}),
    });
    entry = { watcher, users:new Map(), ready:false };
    roots.set(key, entry);
    watcher.on('ready', () => {
      entry.ready = true;
      for (const id of entry.users.keys()) parentPort.postMessage({ id, kind:'ready' });
    });
    watcher.on('all', (_event, path) => {
      const changed = resolve(path);
      for (const [id, file] of entry.users) {
        if (file === null || changed === file) parentPort.postMessage({ id, kind:'change' });
      }
    });
    watcher.on('error', error => {
      for (const id of entry.users.keys()) {
        subscriptions.delete(id);
        parentPort.postMessage({ id, kind:'error', message:String(error.message || error) });
      }
      entry.users.clear();
      close(key, entry);
    });
  }
  clearTimeout(entry.timer);
  idle.delete(key);
  entry.users.set(id, file);
  subscriptions.set(id, key);
  if (entry.ready) parentPort.postMessage({ id, kind:'ready' });
}
function release(id) {
  const root = subscriptions.get(id);
  if (root === undefined) return;
  subscriptions.delete(id);
  const entry = roots.get(root);
  if (!entry || !entry.users.delete(id) || entry.users.size) return;
  entry.timer = setTimeout(() => close(root, entry), workerData.idleWatchMs);
  idle.set(root, entry);
  if (idle.size > 8) {
    const [oldRoot, old] = idle.entries().next().value;
    close(oldRoot, old);
  }
}
parentPort.on('message', msg => {
  try {
    if (msg.kind === 'open') open(msg.id, msg.root, msg.file);
    else if (msg.kind === 'release') release(msg.id);
  } catch (error) {
    parentPort.postMessage({ id:msg.id, kind:'error', message:error.message });
  }
});
parentPort.postMessage({kind:'online'});
