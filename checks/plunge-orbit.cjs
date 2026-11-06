const assert=require('node:assert/strict');
require('../dist/relativity.js');require('../dist/astrophysics.js');
const R=globalThis.BlackHoleRelativity,A=globalThis.BlackHoleAstrophysics;
const near=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected} (tolerance ${tolerance})`);
const model=A.model({scene:'plunge'});
const pose=(radius,tilt=18,yaw=.7,look='flight')=>A.camera({observer:'infall',zoom:1,tilt,yaw,look,flightRadius:radius},model);
assert.equal(model.initialObserverDistance,80);assert.equal(model.outer,25);
assert.ok(model.skyRadius>model.outer);assert.equal(model.spin,0);assert.equal(model.charge,0);

// Constants and null tetrads are measured from the metric, independently of
// the radial effective-potential formula used by the new worldline.
for(const tilt of [-60,0,18,78])for(const radius of [80,10,4.1,4,3.9,2.80001,2.79999,2.00001,2,1.99999,.7]){
 const camera=pose(radius,tilt),momentum=R.lower(camera.u,camera.g),x=camera.position;
 near(R.metricDot(camera.u,camera.u,camera.g),-1);near(-momentum[3],1);
 const angular=[x[1]*momentum[2]-x[2]*momentum[1],x[2]*momentum[0]-x[0]*momentum[2],x[0]*momentum[1]-x[1]*momentum[0]];
 near(Math.hypot(...angular),model.orbit.angularMomentum);
 const initial=pose(80,tilt),p0=R.lower(initial.u,initial.g),x0=initial.position;
 const axis=[x0[1]*p0[2]-x0[2]*p0[1],x0[2]*p0[0]-x0[0]*p0[2],x0[0]*p0[1]-x0[1]*p0[0]];
 angular.forEach((value,i)=>near(value,axis[i]));near(R.dot(x,axis),0,1e-7);
 camera.basis.forEach((v,i)=>{
  near(R.metricDot(v,camera.u,camera.g),0);
  camera.basis.forEach((w,j)=>near(R.metricDot(v,w,camera.g),Number(i===j)));
 });
 for(const [alpha,beta] of [[0,0],[3,-2],[-6,1]]){
  const ray=R.initialRay(camera,alpha,beta);near(R.dot(ray.p,R.raise(ray.p,camera.g)),0,1e-7);
 }
 assert.ok(camera.u.every(Number.isFinite)&&camera.position.every(Number.isFinite));
}

// Differentiate actual sampled events and compare with their four-velocity.
// This detects fake yaw animation, a fixed-latitude orbit, inconsistent clocks,
// and phase errors near the unstable circular orbit and either chart boundary.
for(const radius of [20,6,4.03,4,3.97,2.8,2.0001,2,1.9999,1]){
 const h=radius*1e-5,camera=pose(radius),before=pose(radius+h),after=pose(radius-h),ur=A.radialRate(radius,model,18);
 const ingoing=camera.chart===1?camera.u:R.changeChart(camera.position,camera.u,0,0,-1,1,radius).vector;
 for(let i=0;i<3;i++)near((before.position[i]-after.position[i])/(2*h)*ur,ingoing[i],2e-6);
 near((before.properTime-after.properTime)/(2*h)*ur,1,2e-6);
 near((before.coordinateTime-after.coordinateTime)/(2*h)*ur,ingoing[3],3e-6);
 // Hamilton's equations give an independent local acceleration oracle.
 const canonical=sample=>{
  const u=sample.chart===1?sample.u:R.changeChart(sample.position,sample.u,0,0,-1,1,sample.r).vector;
  return R.lower(u,R.geometry(sample.position));
 };
 const p=canonical(camera),dp=R.derivative({x:camera.position,p,time:0}).p,left=canonical(before),right=canonical(after);
 for(let i=0;i<4;i++)near((left[i]-right[i])/(2*h)*ur,dp[i],3e-6);
}
for(const radius of [80,10,4.1,4,3.9,2.05]){
 const next=A.advanceFall(radius,model,18,.01);
 assert.ok(next<radius);near(pose(next).properTime-pose(radius).properTime,.01,1e-7);
}
const horizon=pose(2),end=pose(A.minimumRadius(model,'infall'));
assert.ok(horizon.orbit/(2*Math.PI)>1.7&&horizon.orbit/(2*Math.PI)<1.9);
assert.ok(end.orbit>horizon.orbit&&end.properTime>horizon.properTime);
assert.equal(end.stage,'inside');assert.equal(end.fade,0);
// The time and spatial velocity remain continuous at the future horizon.
const outside=pose(2+1e-7),inside=pose(2-1e-7);
outside.u.forEach((value,i)=>near(value,inside.u[i],2e-6));
near(outside.coordinateTime,inside.coordinateTime,2e-6);
// Viewing attitude rotates only the spatial tetrad, including inside the
// horizon. Looking back must not alter the event, worldline or aberration.
for(const radius of [80,4,2,1]){
 const center=pose(radius,18,.7,'center'),outward=pose(radius,18,.7,'outward');
 assert.deepEqual(center.position,outward.position);assert.deepEqual(center.u,outward.u);assert.equal(center.orbit,outward.orbit);
 near(R.metricDot(center.basis[2],outward.basis[2],center.g),-1);
 for(const look of ['flight','center','outward']){
  const camera=pose(radius,18,.7,look),ray=R.initialRay(camera,3,-2);
  near(R.dot(ray.p,R.raise(ray.p,camera.g)),0,1e-7);
 }
}
console.log('PASS: inclined orbital capture, conserved energy/angular momentum, timelike/null tetrads, differentiated worldline and Hamiltonian acceleration, proper-time stepping, 1.78 exterior orbits and continuous horizon crossing.');
