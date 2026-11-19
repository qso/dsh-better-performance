import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('a quick return reuses the retained session and unload releases every reference',async () => {
  let mod,update,cleanup,ids=['a','b','c'],active='a';
  const counts=new Map(),held=new Set();
  const window={__ModuleLoader__:{load(x){mod=x.factory(()=>({}));}},__DSH_AFTERBURN_CONFIG__:{
    maxSessions:2,retainMinutes:5,earlyDirectoryReads:false,previewIntent:false}};
  const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{window,queueMicrotask,setInterval,clearInterval});
  mod.apply({effect(fn,title){if(title.includes('recent sessions'))cleanup=fn();},
    sessions:{list:{subscribe(fn){update=fn;return ()=>{};},getSnapshot(){return {ids,
      byId:Object.fromEntries(ids.map(id=>[id,{retainedBy:{mainView:Number(active===id)}}]))};}},
      retain(id){counts.set(id,(counts.get(id)||0)+1);held.add(id);return {ready:Promise.resolve(),release(){held.delete(id);}};}}});
  try {
    for(const next of ['a','b','a','c']){active=next;update();await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(counts.get('a'),1);assert.deepEqual([...held].sort(),['a','c']);
  } finally {cleanup();}
  assert.equal(held.size,0);
});
