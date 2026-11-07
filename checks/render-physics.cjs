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

// The sky is sampled along the asymptotic direction of each escaped ray. Reading the
// covariant momentum p at the r>95 cutoff leaves the bending beyond that radius
// unaccounted and shifts the lensed star field; the coordinate velocity removes it.
// Both forms are compared against a ray integrated far past the cutoff.
{
 const spin=.65,horizon=1+Math.sqrt(1-spin*spin),skyCamera=g.observer(spin,18);
 const norm=vector=>{const length=Math.hypot(...vector);return vector.map(value=>value/length);};
 const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,value,i)=>sum+value*b[i],0))))*180/Math.PI;
 let momentumError=0,velocityError=0,samples=0;
 for(const alpha of [-18,-6,6,18])for(const beta of [-18,-6,6,18]){
  let ray=g.initialRay(skyCamera,alpha,beta),atCutoff=null,captured=false,escaped=false;
  for(let i=0;i<20000;i++){
   const r=g.geometry(ray.x,spin).r;
   if(r<=horizon*1.003){captured=true;break;}
   if(r>95&&!atCutoff)atCutoff={momentum:norm(ray.p),velocity:g.skyDirection(ray,spin)};
   if(r>1e6){escaped=true;break;}
   // Geometric steps far outside the disk reach the weak-field asymptote cheaply.
   ray=g.advance(ray,spin,r>95?Math.max(1,r*.25):Math.min(3.5,Math.max(.004,r*.065),.012+.14*Math.max(0,r-horizon)));
  }
  if(captured||!atCutoff||!escaped)continue;
  const truth=g.skyDirection(ray,spin);
  momentumError=Math.max(momentumError,angle(atCutoff.momentum,truth));
  velocityError=Math.max(velocityError,angle(atCutoff.velocity,truth));
  samples++;
 }
 assert.ok(samples>=12,'sky direction sample coverage');
 assert.ok(velocityError<.05,`escape direction must match the far-field asymptote (got ${velocityError.toFixed(4)} deg)`);
 assert.ok(momentumError>10*velocityError,`the momentum shortcut must be measurably worse (got ${momentumError.toFixed(4)} deg)`);
}

// Compatibility particle inflow; exercise production functions with independent physical oracles.
{
 // A finite injected inflow must be timelike and preserve its energy and angular
 // momentum all the way to the numerical horizon cutoff, including the ergosphere.
 for(let step=0;step<=95;step++) {
   const spin=step/100,m=p.model({model:'kerr',spin}),c=p.plungeConstants(spin);
   const profile=p.emissionProfile(spin),plunge=p.plungeProfile(spin);
   assert.ok(m.emissionInner>m.horizon&&m.emissionInner<m.isco);
   assert.ok(profile.flux.every(value=>Number.isFinite(value)&&value>=0));
   assert.ok(p.sampleProfile(profile,m.isco)>0,'finite stress must keep ISCO luminous');
   assert.equal(p.thinDiskFlux(m.isco,spin),0,'the zero-stress benchmark stays unchanged');
   assert.ok(Number.isFinite(plunge.duration)&&plunge.duration>0);
   for(let i=0;i<=80;i++) {
     const r=m.emissionInner+(m.isco-m.emissionInner)*i/80;
     const x=[Math.sqrt(r*r+spin*spin),0,0],geo=g.geometry(x,spin),u=g.emitterVelocity(x,spin),cov=g.lower(u,geo);
     assert.ok(Math.abs(g.metricDot(u,u,geo)+1)<2e-7,`a=${spin}: emitter normalization at r=${r}`);
     assert.ok(Math.abs(-cov[3]-c.energy)<2e-9,'plunge energy conservation');
     assert.ok(Math.abs(x[0]*cov[1]-c.angularMomentum)<2e-9,'plunge angular momentum conservation');
     assert.ok(p.flowVelocity(r,spin,c).ur<0,'infall never reverses');
     // An outward photon has a finite past-directed covector in outgoing KS.
     // Use the rationalized quadratic root to avoid cancellation at the horizon.
     const n=geo.n[0],aa=1-geo.f*n*n,bb=2*geo.f*n,cc=.01-1-geo.f;
     const momentum=[2*cc/(-bb+Math.sqrt(bb*bb-4*aa*cc)),0,.1];
     const ray={x,p:momentum,energy:1};
     assert.ok(Math.abs(g.hamiltonian(ray,spin))<1e-9,'outgoing photon is null');
     const hit=g.hitRecord(x,momentum,1,spin);
     assert.ok(hit&&hit.shift>0&&Number.isFinite(hit.shift));
     if(i===0)assert.ok(hit.shift<.02,'near-horizon photons must fade by g^4 without a brightness floor');
   }
   for(let i=1;i<512;i++) {
     assert.ok(plunge.data[i*4]<=plunge.data[(i-1)*4],'particle radius decreases monotonically');
     assert.ok(plunge.data[i*4+1]>=plunge.data[(i-1)*4+1],'azimuth retains prograde motion');
   }
   const epsilon=1e-6;
   assert.ok(Math.abs(p.sampleProfile(profile,m.isco-epsilon)-p.sampleProfile(profile,m.isco+epsilon))<1e-4,'emission has no ISCO step');
   const seed=[.37,1.2,.1,.46];
   const start=p.particleOrbit(seed,0,0,profile,plunge),later=p.particleOrbit(seed,0,.01,profile,plunge);
   assert.ok(later.r<start.r,'live plunge particles move inward');
   const circular=p.particleOrbit(seed,1,0,profile,plunge),orbited=p.particleOrbit(seed,1,.01,profile,plunge);
   assert.equal(circular.r,orbited.r);assert.ok(orbited.phi>circular.phi);
 }
}
console.log('PASS: 96 disk profiles, observer tetrads, null initial rays, Hamiltonian gradients, conserved escaping rays, Schwarzschild capture boundary, sampled disk crossings, sky escape behind two disk hits, Kerr cache-limit counterexamples, Doppler asymmetry and compatibility particle inflow, E/L conservation, horizon redshift and live particle motion.');
