// Exercise the production worker, loader and Wasm with local resource transport.
// Message scheduling is real; only fetch/importScripts and the parent are adapted
// to Node so cadence and backpressure regressions do not require Playwright.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const dist=path.join(__dirname,'../dist');
const metadata=JSON.parse(fs.readFileSync(path.join(dist,'data/grmhd-torus.json')));
const snapshots=[],ring=new Map(),errors=[];
let context,progress,readyCount=0,acknowledge=true,generation=0;
const send=message=>context.self.onmessage({data:{session:1,...message}});
const waitFor=async predicate=>{
  const deadline=performance.now()+15000;
  while(!predicate()){
    assert.deepEqual(errors,[]);
    assert.ok(performance.now()<deadline,'worker timed out: '+JSON.stringify(progress));
    await new Promise(resolve=>setTimeout(resolve,1));
  }
};
const sandbox={console,performance,setTimeout,WebAssembly,Response,TextDecoder,DecompressionStream,
  fetch:async url=>new Response(fs.readFileSync(path.join(dist,url.split('?')[0])),{headers:{'Content-Type':url.includes('.wasm')?'application/wasm':'application/octet-stream'}})
};
sandbox.self={crypto:webcrypto,DecompressionStream,close(){},postMessage(message){
  if(message.type==='ready')readyCount++;
  if(message.type==='error')errors.push(message);
  if(message.type==='progress')progress=message;
  if(message.type==='reset'){generation=message.generation;ring.clear();}
  if(message.type==='snapshot'){
    const {time,slot,diagnostics}=message;
    assert.ok(new Float32Array(message.buffer).every(Number.isFinite));
    assert.equal(diagnostics[1],1);
    snapshots.push({time,slot,generation:message.generation});ring.set(slot,time);
    if(acknowledge)setTimeout(()=>send({type:'consume',slot}),0);
  }
}};
sandbox.importScripts=url=>vm.runInContext(fs.readFileSync(path.join(dist,url.split('?')[0]),'utf8'),context);
context=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dist,'grmhd-worker.js'),'utf8'),context);

(async()=>{
  send({type:'init',wasmUrl:'./solver/grmhd-runtime.wasm',checkpointUrl:'./data/grmhd-torus.checkpoint.bin.gz',checkpointSpec:{...metadata.checkpoint,cells:4096,components:12}});
  await waitFor(()=>readyCount===1);
  assert.equal(snapshots.length,0);
  send({type:'resume'});
  // At 60 FPS the renderer advances targets by 8/60, while observing target-40.
  // This used to fill 300 slots by t=840 and evict the entire causal history.
  for(let frame=1;frame<=300;frame++){
    const targetTime=800+frame*8/60;
    send({type:'advance',targetTime});
    await waitFor(()=>progress?.state==='ready'&&progress.simulationTime>=targetTime-1e-9);
  }
  assert.deepEqual(snapshots.map(frame=>frame.time),[820,840]);
  assert.equal(Math.min(...ring.values()),820,'original history must remain connected to the dynamic window');
  send({type:'advance',targetTime:845.3});
  await waitFor(()=>progress?.state==='ready'&&progress.simulationTime===845.3);
  assert.equal(snapshots.length,2,'fractional targets must not consume a slot');
  send({type:'pause'});
  assert.equal(progress.state,'paused');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(snapshots.length,2);
  send({type:'advance',targetTime:860});
  await waitFor(()=>progress?.state==='ready'&&progress.simulationTime===860);
  assert.deepEqual(snapshots.map(frame=>frame.time),[820,840,860]);

  // Backpressure retains the same fixed grid when consumption resumes.
  acknowledge=false;
  send({type:'advance',targetTime:1060});
  await waitFor(()=>progress?.state==='backpressure');
  assert.equal(progress.pendingSnapshots,8);
  send({type:'pause'});
  acknowledge=true;
  for(let i=0;i<8;i++)send({type:'consume'});
  send({type:'resume'});
  await waitFor(()=>progress?.state==='ready'&&progress.simulationTime===1060);
  // Reach the ring's first overwrite and verify its physical time span, rather
  // than merely checking that it contains no more than 128 entries.
  send({type:'advance',targetTime:3400});
  await waitFor(()=>progress?.state==='ready'&&progress.simulationTime===3400);
  assert.equal(snapshots.length,130);
  assert.ok(snapshots.every((frame,index)=>frame.time===820+index*20));
  assert.equal(ring.size,128);assert.equal(Math.min(...ring.values()),860);assert.equal(Math.max(...ring.values()),3400);
  send({type:'reset'});
  await waitFor(()=>readyCount===2);
  assert.equal(generation,1);assert.equal(ring.size,0);
  send({type:'advance',targetTime:819.9});
  await waitFor(()=>progress?.generation===1&&progress.state==='ready'&&progress.simulationTime===819.9);
  assert.equal(snapshots.length,130);
  send({type:'advance',targetTime:820});
  await waitFor(()=>ring.size===1);
  assert.deepEqual(snapshots.at(-1),{time:820,slot:0,generation:1});
  assert.deepEqual(errors,[]);
  console.log('PASS: production worker fractional targets, fixed 20-unit cadence, pause, backpressure, 128-slot time window and reset grid.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>send({type:'destroy'}));
