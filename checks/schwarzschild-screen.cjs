// Independent Christoffel check of the plane-based polarization class.
const assert=require('node:assert/strict');require('../dist/relativity.js');
const R=BlackHoleRelativity,near=(a,b,t=1e-7)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
for(const radius of [40,10,3,2.0001,2,1.5,.7])for(const tilt of [-17,45])for(const impact of [[3,2],[-5,1],[1,-8]]){
 const camera=R.observer(0,0,tilt,radius,'infall',.3),ray=R.initialRay(camera,...impact),g=camera.g,k=R.raise(ray.p,g),basis=R.schwarzschildScreen(ray.x,ray.p),h=1e-6;
 assert.ok(basis);basis.forEach((v,i)=>{near(R.metricDot(v,k,g),0);basis.forEach((w,j)=>near(R.metricDot(v,w,g),Number(i===j)));});
 const low=R.schwarzschildScreen(R.advance(ray,0,0,-h).ray.x,R.advance(ray,0,0,-h).ray.p),high=R.schwarzschildScreen(R.advance(ray,0,0,h).ray.x,R.advance(ray,0,0,h).ray.p);
 basis.forEach((v,i)=>{
  const derivative=high[i].map((value,j)=>(value-low[i][j])/(2*h)),ode=R.connectionTransport(ray.x,ray.p,v),residual=derivative.map((value,j)=>value-ode[j]);
  // Parallel modulo k is enough: the emitter's screen projection removes
  // that null gauge, while all physical screen components must vanish.
  for(const axis of [...basis,k])near(R.metricDot(residual,axis,g)/(1+Math.hypot(...k)),0,2e-7);
 });
 if(radius>2.8){
  const outgoing=R.changeChart(ray.x,k,0,0,1,-1,radius),p=R.lower(outgoing.vector,R.geometry(outgoing.position,0,0,-1)),other=R.schwarzschildScreen(outgoing.position,p,-1);
  for(let i=0;i<2;i++){
   const converted=R.changeChart(ray.x,basis[i],0,0,1,-1,radius).vector;near(R.metricDot(converted,other[i],R.geometry(outgoing.position,0,0,-1)),1);
  }
 }
}
assert.equal(R.schwarzschildScreen([3,0,0],[1,0,0,1]),null);
console.log('PASS: Schwarzschild screen orthonormality, null orthogonality, Christoffel transport modulo gauge, horizon regularity and exterior chart orientation.');
