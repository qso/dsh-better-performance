import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';

test('a newly created child is reported while sharing a directory observer', {timeout:8000}, async () => {
  const root = await mkdtemp(join(tmpdir(),'dsh-preview-test-'));
  const worker = new Worker(new URL('../watch-worker.js',import.meta.url),
    {workerData:{pollMs:200,binaryPollMs:200,idleWatchMs:0}});
  async function until(kind, id) {
    for (;;) {
      const [msg] = await once(worker,'message');
      if (msg.kind === 'error') assert.fail(msg.message);
      if (msg.kind === kind && msg.id === id) return;
    }
  }
  try {
    const ready = until('ready',1);
    worker.postMessage({kind:'open',id:1,root,file:null});
    await ready;
    const changed = until('change',1);
    await writeFile(join(root,'new.txt'),'new content');
    await changed;
    worker.postMessage({kind:'release',id:1});
  } finally { await worker.terminate(); await rm(root,{recursive:true,force:true}); }
});
