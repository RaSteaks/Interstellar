// Validate the private continuation ABI before it is wired to the page.
// The check deliberately compares two builds and two restart paths rather
// than accepting a non-finite or unchanged post-800 frame as progress.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const zlib=require('node:zlib');

const root=path.join(__dirname,'..');
const data=path.join(root,'dist/data');
const solver=path.join(root,'dist/solver');
const metadata=JSON.parse(fs.readFileSync(path.join(data,'grmhd-torus.json')));
const wasmMetadata=JSON.parse(fs.readFileSync(path.join(solver,'grmhd-runtime.json')));
const checkpoint=zlib.gunzipSync(fs.readFileSync(path.join(data,metadata.checkpoint.path)));
assert.equal(crypto.createHash('sha256').update(checkpoint).digest('hex'),metadata.checkpoint.sha256);
assert.equal(checkpoint.toString('ascii',0,8),'GRMHDCP1');
const view=new DataView(checkpoint.buffer,checkpoint.byteOffset,checkpoint.byteLength);
const cells=view.getUint32(12,true),components=view.getUint32(16,true),stateCount=cells*components,stateOffset=40,initialTime=view.getFloat64(24,true);
assert.equal(cells,4096);assert.equal(components,12);assert.equal(initialTime,800);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(solver,'grmhd-runtime.wasm'))).digest('hex'),wasmMetadata.wasmSha256);

async function loadWasm(){
  const {instance}=await WebAssembly.instantiate(fs.readFileSync(path.join(solver,'grmhd-runtime.wasm')));
  const e=instance.exports;
  const input=new Float64Array(e.memory.buffer,e.grmhd_input_ptr(),stateCount);
  const stateBytes=checkpoint.buffer.slice(checkpoint.byteOffset+stateOffset,checkpoint.byteOffset+stateOffset+stateCount*Float64Array.BYTES_PER_ELEMENT);
  input.set(new Float64Array(stateBytes));
  return {instance,e};
}

async function runWasm(target,increment=target-initialTime){
  const run=await loadWasm();
  run.e.grmhd_init(initialTime);
  // Mirror fractional frame targets rather than only the solver's maximum dt.
  // Fine stepping used to amplify an exp/log round-trip loss at every update.
  for(let step=1;initialTime+step*increment<target;step++)assert.equal(run.e.grmhd_advance(initialTime+step*increment,1000000),1);
  assert.equal(run.e.grmhd_advance(target,1000000),1);
  assert.equal(run.e.grmhd_time(),target);
  const snapshot=new Float32Array(run.e.memory.buffer,run.e.grmhd_snapshot_ptr(),stateCount).slice();
  const diagnostics=new Float64Array(run.e.memory.buffer,run.e.grmhd_diagnostics_ptr(),run.e.grmhd_diagnostics_length()).slice();
  assert.ok(snapshot.every(Number.isFinite));
  assert.equal(diagnostics[1],1);
  assert.ok(diagnostics[2]>0&&diagnostics[3]>0);
  assert.ok(Math.abs(diagnostics[4])<1e-3&&Math.abs(diagnostics[5])<1e-3,JSON.stringify(diagnostics));
  assert.ok(Number.isFinite(diagnostics[6])&&diagnostics[6]>=0);
  assert.ok(diagnostics[7]<=1e-12,JSON.stringify(diagnostics));
  assert.ok(diagnostics[8]<=1e-12);
  assert.equal(diagnostics[10],1);
  assert.ok(Number.isFinite(diagnostics[11]));
  for(const radial of [0,63])for(let polar=0;polar<64;polar++)for(const component of [0,1]){
    const index=(radial*64+polar)*components+component;
    assert.equal(snapshot[index],Math.fround(view.getFloat64(stateOffset+index*8,true)),'fixed scalar boundary drifted');
  }
  return {snapshot,diagnostics};
}

function compare(a,b){
  let sum=0,norm=0,max=0;
  for(let i=0;i<a.length;i++){const diff=a[i]-b[i];sum+=diff*diff;norm+=a[i]*a[i];max=Math.max(max,Math.abs(diff));}
  return {l2:Math.sqrt(sum/Math.max(norm,1e-30)),max:max/Math.max(...a.map(value=>Math.abs(value)),1e-30)};
}

(async()=>{
  const direct=await runWasm(860);
  const resumed=await loadWasm();resumed.e.grmhd_init(initialTime);assert.equal(resumed.e.grmhd_advance(820,1000000),1);assert.equal(resumed.e.grmhd_advance(860,1000000),1);
  const resumedSnapshot=new Float32Array(resumed.e.memory.buffer,resumed.e.grmhd_snapshot_ptr(),stateCount).slice();
  const restartError=compare(direct.snapshot,resumedSnapshot);assert.ok(restartError.l2<=1e-12,JSON.stringify(restartError));
  const extended=(await runWasm(1600)).snapshot;
  const fine=await runWasm(1600,8/60),tiny=await runWasm(initialTime+1e-8);
  // Shared closed-boundary face fluxes conserve both scalar totals. These
  // tighter checks also exclude step-count-dependent conversion drift.
  for(const result of [fine,tiny])for(const index of [4,5])assert.ok(Math.abs(result.diagnostics[index])<1e-10,JSON.stringify(result.diagnostics));
  assert.ok(extended.some((value,index)=>value!==direct.snapshot[index]),'t=1600 must not repeat the t=860 frame');
  assert.ok(extended.every(Number.isFinite));
  for(let cell=0;cell<cells;cell++){assert.ok(Number.isFinite(Math.exp(extended[cell*components])));assert.ok(Number.isFinite(Math.exp(extended[cell*components+1])));assert.ok(extended[cell*components+2]>=0);}

  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'interstellar-solver-'));
  try {
    const rawPath=path.join(temporary,'checkpoint.raw'),nativePath=path.join(temporary,'runtime-native'),nativeOutput=path.join(temporary,'native.f32');
    fs.writeFileSync(rawPath,checkpoint);
    const compile=cp.spawnSync(process.env.RUSTC||'rustc',['-O','-C','panic=abort','-o',nativePath,path.join(root,'tools/grmhd-runtime.rs')],{encoding:'utf8'});
    assert.equal(compile.status,0,compile.stderr||compile.stdout);
    const native=cp.spawnSync(nativePath,[rawPath,'860',nativeOutput],{encoding:'utf8'});
    assert.equal(native.status,0,native.stderr||native.stdout);
    const nativeBytes=fs.readFileSync(nativeOutput);
    const nativeSnapshot=new Float32Array(nativeBytes.buffer,nativeBytes.byteOffset,nativeBytes.byteLength/Float32Array.BYTES_PER_ELEMENT);
    const nativeError=compare(direct.snapshot,nativeSnapshot);assert.ok(nativeError.l2<=1e-6,JSON.stringify(nativeError));assert.ok(nativeError.max<=1e-4,JSON.stringify(nativeError));
    const report={checkpoint:{time:initialTime,bytes:checkpoint.byteLength,sha256:metadata.checkpoint.sha256},restartError,nativeWasmError:nativeError,diagnostics860:direct.diagnostics,diagnosticsFine1600:fine.diagnostics,diagnosticsTinyStep:tiny.diagnostics,extendedTime:1600,extendedChanged:true,cacheSlots:wasmMetadata.cacheSlots};
    fs.mkdirSync(path.join(root,'verification'),{recursive:true});fs.writeFileSync(path.join(root,'verification/continuous-solver.json'),JSON.stringify(report,null,2)+'\n');
    console.log('PASS: checkpoint restore, native/Wasm tolerance, finite t=1600 continuation, fine/tiny-step conservation and exact fixed scalar boundaries.');
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
