const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const context={};
for(const file of ['physics.js','geodesics.js'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist',file),'utf8'),context);
const p=context.BlackHolePhysics,g=context.BlackHoleGeodesics;

// Analytic limits and finite-temperature conditions are independent of image styling.
assert.equal(p.iscoRadius(0),6);
assert.ok(Math.abs(p.iscoRadius(.95)-1.9372378781396629)<1e-10);
let last=6;
for(let i=0;i<=95;i++){
 const a=i/100,inner=p.iscoRadius(a),profile=p.diskProfile(a);
 assert.ok(inner<=last+1e-12 && inner>1+Math.sqrt(1-a*a));last=inner;
 assert.equal(p.thinDiskFlux(inner,a),0);
 assert.ok(profile.peak>0 && profile.flux.every(v=>Number.isFinite(v)&&v>=0&&v<=1.000001));
}
for(const a of [0,.65,.95]){
 const camera=g.observer(a,18);
 assert.ok(Math.abs(g.metricDot(camera.u,camera.u,camera.geo)+1)<1e-12);
 camera.basis.forEach((e,i)=>{
  assert.ok(Math.abs(g.metricDot(e,camera.u,camera.geo))<1e-12);
  camera.basis.forEach((f,j)=>assert.ok(Math.abs(g.metricDot(e,f,camera.geo)-(i===j?1:0))<1e-12));
 });
 for(const xy of [[0,0],[-10,-2],[10,-2],[-8,3],[6,1]]){
  const ray=g.initialRay(camera,...xy);
  assert.ok(Math.abs(g.hamiltonian(ray,a))<1e-12);
 }
 // Compare the analytic force to a finite-difference Hamiltonian gradient.
 const ray={x:[7,3,2],p:[.4,-.8,.25],energy:.98},d=g.derivative(ray,a),epsilon=1e-5;
 for(let axis=0;axis<3;axis++){
  const plus={...ray,x:[...ray.x]},minus={...ray,x:[...ray.x]};plus.x[axis]+=epsilon;minus.x[axis]-=epsilon;
  const gradient=(g.hamiltonian(plus,a)-g.hamiltonian(minus,a))/(2*epsilon);
  assert.ok(Math.abs(d.p[axis]+gradient)<1e-8);
 }
 for(const xy of [[-10,-2],[10,-2],[-8,3]]){
  const traced=g.trace(camera,...xy,p.iscoRadius(a),26);
  assert.ok(traced.escaped && traced.hits.length>0);
  assert.ok(traced.maxError<3e-6 && traced.momentumError<3e-6);
  assert.ok(traced.hits.every(hit=>hit.r>p.iscoRadius(a)&&hit.r<26&&hit.shift>0&&Number.isFinite(hit.shift)));
 }
}

// Finite-distance static camera: known Schwarzschild critical impact parameter sqrt(27).
const camera=g.observer(0,18),radius=camera.distance;
const critical=Math.sqrt(27)*Math.sqrt(1-2/radius)/Math.sqrt(1-27/radius**2);
const inside=g.trace(camera,critical-.03,0,6,26,{stepScale:.05,steps:384});
const outside=g.trace(camera,critical+.03,0,6,26,{stepScale:.05,steps:384});
assert.ok(inside.captured && outside.escaped);
assert.ok(g.trace(camera,0,0,6,26).captured);

// These Schwarzschild rays cross the disk at most twice. This is a sampled
// Schwarzschild result, not a bound on all viewing angles or on Kerr images.
for(const b of [critical+.005,critical+.05,5.5,6,7.5,9,12,16,20,24]){
 const traced=g.trace(camera,b,0,6,26,{stepScale:.02,steps:900});
 assert.ok(traced.hits.length<=2,`crossings within the disk must stay <=2 at b=${b}`);
}

// Filling the disk cache does not imply capture: this two-hit Schwarzschild ray
// still reaches the sky. Kerr counterexamples keep the documented two-hit
// approximation honest; those extra crossings remain outside the emission cache.
const throughDisk=g.trace(g.observer(0,8),-7.5,-4.5,6,26,{stepScale:.03,steps:800});
assert.equal(throughDisk.hits.length,2);
assert.ok(throughDisk.escaped&&!throughDisk.captured);
for(const [spin,x,y,count] of [[.65,5,-3.5,3],[.95,-.5,-4.5,4]]){
 const traced=g.trace(g.observer(spin,18),x,y,p.iscoRadius(spin),26,{stepScale:.015,steps:1400});
 assert.equal(traced.hits.length,count);
 assert.ok(traced.escaped&&traced.maxError<2e-7);
}

// Doppler beaming asymmetry: mirrored rays must show the prograde side blueshifted
// (g>1) and the receding side redshifted (g<1) relative to each other.
const pair=g.trace(camera,-9,0,6,26,{stepScale:.03,steps:600}),mirror=g.trace(camera,9,0,6,26,{stepScale:.03,steps:600});
assert.ok(pair.hits.length>0 && mirror.hits.length>0);
assert.ok(Math.max(...pair.hits.map(h=>h.shift))>Math.max(...mirror.hits.map(h=>h.shift)));

// Shaders carry no compiler in node: assert structural validity and that every
// uniform name wired in raytracer.js is declared in some shader stage.
const raytracer=fs.readFileSync(path.join(__dirname,'../dist/raytracer.js'),'utf8');
const stages=[...raytracer.matchAll(/`#version 300 es[^`]*`/g)].map(match=>match[0]);
assert.equal(stages.length,6);
for(const stage of stages){
 for(const pairName of ['{}','()']){
  const [open,close]=pairName;let depth=0;
  for(const char of stage){
   if(char===open)depth++;else if(char===close)depth--;
   assert.ok(depth>=0,'unbalanced shader nesting');
  }
  assert.equal(depth,0,'unbalanced shader nesting');
 }
}
for(const name of raytracer.matchAll(/program\([^,]+,[^,]+,\[([^\]]*)\]/g)){
 for(const uniform of name[1].matchAll(/"([^"]+)"/g))assert.ok(raytracer.includes(`uniform ${/\b(u[A-Z])/.test(uniform[1])?'':'sampler2D '}${uniform[1]}`)||new RegExp(`uniform [\\w\\s,]*\\b${uniform[1]}\\b`).test(raytracer),`undeclared uniform ${uniform[1]}`);
}
console.log('PASS: 96 disk profiles, observer tetrads, null initial rays, Hamiltonian gradients, conserved escaping rays, Schwarzschild capture boundary, sampled disk crossings, sky escape behind two disk hits, Kerr cache-limit counterexamples, Doppler asymmetry and shader structure.');
