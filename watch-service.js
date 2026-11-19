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
    if (disabled) return original.call(this, target, changed, signal);
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
  Object.defineProperty(fs, 'watch', {value:watch, configurable:true, writable:true});
  return () => {
    disposed = true;
    if (Object.getOwnPropertyDescriptor(fs, 'watch')?.value === watch) Reflect.deleteProperty(fs, 'watch');
    fail(new Error('File observation plugin unloaded'));
    return worker.terminate().then(() => {});
  };
}
