// Validate shipped solver provenance, genuine 3D evolution, and causal packing.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
require('../dist/plasma.js');
const root=path.join(__dirname,'..'),folder=process.argv[2]||path.join(root,'dist/data');
const metadata=JSON.parse(fs.readFileSync(path.join(folder,'grmhd3d.json')));
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const bytes=Buffer.alloc(metadata.bytes);
// Static hosting caps single files (Cloudflare Workers assets: 25 MiB); a
// larger chunk only fails at deploy time, so every published file is bounded.
const ASSET_LIMIT=25*1024*1024;
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
for(const file of walk(path.join(root,'dist')))assert.ok(fs.statSync(file).size<ASSET_LIMIT,`${path.relative(root,file)} exceeds the 25 MiB static asset limit`);
for(const chunk of metadata.chunks){
 assert.equal(fs.statSync(path.join(folder,chunk.file)).size,chunk.compressedBytes,chunk.file);
 const raw=zlib.gunzipSync(fs.readFileSync(path.join(folder,chunk.file)));assert.equal(raw.byteLength,chunk.bytes);assert.equal(hash(raw),chunk.sha256);raw.copy(bytes,chunk.offset);
}
assert.equal(metadata.solver,'Athena++');assert.equal(metadata.axisymmetric,false);
assert.equal(metadata.commit,'053bc738d5c85dac717326b4338b34c7db4e715d');
assert.equal(metadata.patchSha256,hash(fs.readFileSync(path.join(root,'tools/grmhd3d/athena.patch'))));
for(const patch of metadata.supplementalPatches||[]){
 assert.equal(patch.name,'eos-failure');assert.equal(patch.sha256,hash(fs.readFileSync(path.join(root,'tools/grmhd3d/eos-failure.patch'))));
}
assert.equal(metadata.inputSha256,hash(fs.readFileSync(path.join(root,'tools/grmhd3d/athinput.torus'))));
assert.equal(metadata.resolution.length,3);assert.ok(metadata.resolution.every(n=>Number.isInteger(n)&&n>1));
assert.ok(metadata.times.length>=2&&metadata.times.every((t,i)=>Number.isFinite(t)&&(i===0||t>metadata.times[i-1])));
assert.ok(metadata.timeRange[1]>=400);assert.equal(metadata.packing,'time,phi,radius,theta,component');
assert.equal(bytes.byteLength,metadata.bytes);assert.equal(hash(bytes),metadata.sha256);
const [nr,nt,np]=metadata.resolution,cells=nr*nt*np,records=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
assert.equal(records.length,cells*metadata.times.length*12);assert.ok(records.every(Number.isFinite));
assert.ok(metadata.maxDivB<1e-8&&metadata.maxVelocityNormError<1e-8&&metadata.maxMagneticOrthogonalityError<1e-8);
const energyAmplification=Math.max(...metadata.nativeHistory.map(row=>Math.abs(row['tot-E'])))/Math.abs(metadata.nativeHistory[0]['tot-E']);assert.ok(energyAmplification<2,'Pointwise invariants do not excuse native energy runaway');
assert.ok(metadata.initialMRIQuality.massWeightedQtheta>=10&&metadata.initialMRIQuality.massFractionQthetaAtLeast6>.9);
let densityDifference=0,densityNorm=0,velocityChange=0,magneticChange=0;
const last=(metadata.times.length-1)*cells*12;
for(let i=0;i<records.length;i+=12){assert.ok(records[i+2]>=0);assert.ok(Math.exp(records[i])>0&&Math.exp(records[i+1])>0);}
for(let r=0;r<nr;r++)for(let theta=0;theta<nt;theta++){
 const a=last+(r*nt+theta)*12,b=last+((Math.floor(np/2)*nr+r)*nt+theta)*12;
 const left=Math.exp(records[a]),right=Math.exp(records[b]);densityDifference+=(left-right)**2;densityNorm+=left*left+right*right;
}
for(let i=0;i<cells*12;i++){
 if(i%12>=4&&i%12<8)velocityChange+=(records[last+i]-records[i])**2;
 if(i%12>=8)magneticChange+=(records[last+i]-records[i])**2;
}
const azimuthalDifference=Math.sqrt(densityDifference/densityNorm);
assert.ok(azimuthalDifference>1e-3,'The native three-dimensional density must not be a revolved axisymmetric slice');
assert.ok(velocityChange>1e-5&&magneticChange>1e-5,'Momentum and magnetic fields must actually evolve');
const velocities=BlackHolePlasma.velocityTexture(records,metadata);let maxSpeedSquared=0;
for(let i=0;i<velocities.length;i+=4){
 const speed=velocities[i]**2+velocities[i+1]**2+velocities[i+2]**2;assert.ok(Number.isFinite(speed)&&speed<1);maxSpeedSquared=Math.max(maxSpeedSquared,speed);
}
const report={passed:true,resolution:metadata.resolution,timeRange:metadata.timeRange,bytes:bytes.byteLength,sha256:metadata.sha256,azimuthalDifference,velocityChange,magneticChange,maxSpeedSquared,initialMRIQuality:metadata.initialMRIQuality,nativeConstraints:{divB:metadata.maxDivB,velocityNorm:metadata.maxVelocityNormError,magneticOrthogonality:metadata.maxMagneticOrthogonalityError}};
fs.mkdirSync(path.join(root,'verification/grmhd3d'),{recursive:true});fs.writeFileSync(path.join(root,'verification/grmhd3d/data-check.json'),JSON.stringify(report,null,2));
console.log('PASS: pinned native global 3D GRMHD provenance, full-field evolution, azimuthal structure, CT/four-vector diagnostics and causal interpolation velocities.');
