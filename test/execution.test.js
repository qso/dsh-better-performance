import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {localWatch} from '../watch-service.js';

test('non-preview RPCs preserve request, result, cancellation and errors by identity',async()=>{
  let plugin,dispose;
  const body='large original tool output\n'.repeat(17000);
  const result=Promise.resolve({messages:[{role:'tool',content:body}]});
  const signal=new AbortController().signal;
  const payload={args:{messages:[{role:'tool',content:body}]}};
  let seen;
  const failure=new Error('original provider failure');
  const rpc={call(...args){seen=args;if(args[1]==='provider/error')throw failure;return result;}};
  const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
  const window={__ModuleLoader__:{load(x){plugin=x.factory(()=>({}));}},__DSH_BETTER_PERFORMANCE_CONFIG__:{watchWorker:false,
    maxSessions:0,earlyDirectoryReads:false,previewIntent:false}};
  vm.runInNewContext(source,{window,AbortController,clearTimeout});
  plugin.apply({connection:{rpc},effect(fn,title){if(title.includes('file preview intent'))dispose=fn();}});
  const wrapped=rpc.call;
  try {
    for(const endpoint of ['session/prompt','tool/result','session/history','agent/run']){
      assert.equal(rpc.call('/api',endpoint,payload,signal),result);
      assert.equal(seen[2],payload);
      assert.equal(seen[3],signal);
      assert.equal((await result).messages[0].content,body);
    }
    assert.throws(()=>rpc.call('/api','provider/error',payload,signal),error=>error===failure);
  } finally {dispose();}
  assert.notEqual(rpc.call,wrapped);
});

test('concurrent task watchers stay native while the preview iterator is active',{skip:process.platform!=='darwin'},async()=>{
  let calls=0;
  class LocalFileSystem {
    processPath(target){return target;}
    async stat(){return {type:'directory'};}
    async watch(){calls++;return async()=>{};}
  }
  const fs=new LocalFileSystem(),dir=await mkdtemp(join(tmpdir(),'dsh-watch-'));
  const controller = new AbortController();
  const files={async *changes(){const done=await fs.watch(dir,()=>{},controller.signal);
    try{yield {kind:'ready'};}finally{await done();}}};
  const native=files.changes,stop=localWatch({fs,workspaceFiles:files},{pollMs:200,binaryPollMs:200,idleWatchMs:0});
  // The desktop host keeps an event loop running. A standalone Node process
  // needs a live deadline while it waits for the unreferenced preview worker.
  const deadline = setTimeout(() => controller.abort(new Error('Preview watcher did not become ready')), 8000);
  try{
    const stream=files.changes();
    assert.equal((await stream.next()).value.kind,'ready');
    assert.equal(calls,0);
    await fs.watch(dir,()=>{},new AbortController().signal);assert.equal(calls,1);
    await stream.return();
  }finally{clearTimeout(deadline);await stop();await rm(dir,{recursive:true,force:true});}
  assert.equal(files.changes,native);
});
