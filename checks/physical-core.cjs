const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
require('../dist/relativity.js');require('../dist/astrophysics.js');require('../dist/plasma.js');
const R=globalThis.BlackHoleRelativity,A=globalThis.BlackHoleAstrophysics,P=globalThis.BlackHolePlasma;
const near=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b} (tolerance ${t})`);
const relative=(a,b,t=1e-6)=>near(a/b,1,t);
// All-view image convergence reaches the configured cap because cold edge-on
// foreground columns remain significant. The production camera starts at 4R.
assert.equal(A.domain.selectedRadius,2048);
const productionDomain=A.model({scene:'quasar',model:'kerr',spin:.65,charge:0});
assert.equal(productionDomain.computationalRadius,2048);assert.equal(productionDomain.initialObserverDistance,8192);

// Published limits are independent oracles, rather than copies of the formula.
near(R.isco(0),6);near(R.isco(.95),1.9372378781396629,1e-10);
near(R.isco(.998),1.2369706551751847,1e-10);near(R.isco(-.998),8.99437445480357,1e-10);
near(R.isco(0,.8),4.8907666713,1e-7);
for(let i=0;i<96;i++){
 const a=-.998+1.996*i/95,q=i%3===0?Math.min(.7,Math.sqrt(1-a*a)*.5):0,rh=R.horizon(a,q);
 assert.ok(R.isco(a,q)>rh.outer);
 for(const r of [80,3,rh.outer*1.001,(rh.outer+rh.inner)/2]){
  const camera=R.observer(a,q,18,r,'infall'),p=R.lower(camera.u,camera.g);
  near(R.metricDot(camera.u,camera.u,camera.g),-1,2e-10);near(-p[3],1,2e-10);
  near(camera.position[0]*p[1]-camera.position[1]*p[0],0,2e-9);
  const light=R.initialRay(camera,2,-3);near(R.dot(light.p,R.raise(light.p,camera.g)),0,2e-10);
 }
 for(const chart of [-1,1]){
  const camera=R.observer(a,q,35,80,'infall',.4,chart),p=R.initialRay(camera,3,5);
  near(R.metricDot(camera.u,camera.u,camera.g),-1,1e-10);near(R.dot(p.p,R.raise(p.p,camera.g)),0,1e-10);
  camera.basis.forEach((v,j)=>{near(R.metricDot(v,camera.u,camera.g),0,1e-10);camera.basis.forEach((w,k)=>near(R.metricDot(v,w,camera.g),Number(j===k),1e-10));});
 }
 const injection=R.inflowConstants(a,q),x=[injection.inner,a,0];
 const outer=R.circularVelocity(x,a,q,-injection.radialSpeed),inner=R.infall(x,a,q,injection.energy,injection.angularMomentum);
 outer.forEach((v,j)=>near(v,inner[j],5e-9));near(R.metricDot(inner,inner,R.geometry(x,a,q)),-1,1e-9);
}

// Check analytic Hamiltonian forces against independent finite differences in
// both KS charts, including a nonzero charge and non-equatorial points.
for(const a of [-.8,0,.8])for(const q of [0,.4])for(const chart of [-1,1]){
 const ray={x:[4,3,2],p:[.7,-.2,.5,.9],time:0},force=R.derivative(ray,a,q,chart).p;
 const hamiltonian=x=>.5*R.dot(ray.p,R.raise(ray.p,R.geometry(x,a,q,chart)));
 for(let j=0;j<3;j++){const lo=[...ray.x],hi=[...ray.x];lo[j]-=1e-5;hi[j]+=1e-5;near(force[j],-(hamiltonian(hi)-hamiltonian(lo))/2e-5,2e-10);}
}
const bc=Math.sqrt(27)*Math.sqrt(1-2/80)/Math.sqrt(1-27/80**2),camera=R.observer(0,0,18,80,'static',0,-1);
assert.equal(R.trace(camera,bc*.995,0).status,'captured');assert.equal(R.trace(camera,bc*1.005,0).status,'escaped');
for(const [a,q] of [[-.9,0],[.998,0],[.6,.5]]){
 const c=R.observer(a,q,18,80,'static',0,-1),result=R.trace(c,9,2,{tolerance:1e-9});
 assert.equal(result.status,'escaped');assert.ok(result.nullError<2e-7);
 const start=R.initialRay(c,9,2),L0=start.x[0]*start.p[1]-start.x[1]*start.p[0],L=result.ray.x[0]*result.ray.p[1]-result.ray.x[1]*result.ray.p[0];
 near(L,L0,2e-6);near(result.ray.p[3],start.p[3],0.0000000001);
}

// Chart transforms must round-trip actual positions and vectors away from the
// observer anchor. GPU screen agreement is covered in grmhd3d-browser.cjs.
for(const [a,q] of [[-.9,0],[0,0],[.65,0],[.9375,0],[.6,.5]])for(const distance of [80,2048]){
 for(const fraction of [.06,.4,1]){
  const r=fraction*distance,position=[r*.7,r*.4,r*.5],vector=[.2,-.3,.4,1];
  const outgoing=R.changeChart(position,vector,a,q,1,-1,distance);
  const back=R.changeChart(outgoing.position,outgoing.vector,a,q,-1,1,distance);
  position.forEach((value,i)=>near(back.position[i],value,1e-8*Math.max(1,r)));
  vector.forEach((value,i)=>near(back.vector[i],value,1e-8));
 }
}

// A proper-time Schwarzschild infall has an independent closed radius law.
const schwarz=A.model({scene:'isolated',model:'schwarzschild',spin:0,charge:0});
const elapsed=20,expected=(80**1.5-1.5*Math.sqrt(2)*elapsed)**(2/3);
near(A.advanceFall(80,schwarz,18,elapsed),expected,2e-9);
for(const scene of ['quasar','stellar','retrograde','extreme','charged']){
 const preset=A.scenes[scene],m=A.model({scene,...preset}),profile=A.diskProfile(m);
 assert.equal(profile.count,2048);assert.equal(profile.data.length,2048*4);
 near(profile.motion[profile.iscoIndex*4],m.isco,1e-6);
 assert.ok(profile.data.every(Number.isFinite)&&profile.data.every((v,i)=>i%4===3||v>=0));
 assert.ok(profile.peakTemperature>0&&profile.boundary.gas>0&&profile.boundary.radiation>0);
 // Sample the entire widened domain, including outer cells; checking only the
 // first 512 entries would silently omit three quarters of the new table.
 for(let i=0;i<profile.count;i+=11){const r=profile.motion[i*4],sigma=profile.motion[i*4+1],rho=profile.motion[i*4+2],height=profile.motion[i*4+3]*m.rg,ur=profile.data[i*4+3];relative(2*Math.PI*r*m.rg*sigma*Math.abs(ur)*A.constants.c,m.massRate,2e-6);relative(Math.sqrt(2*Math.PI)*height*rho,sigma,2e-6);}
 for(const kind of ['static','infall'])for(const r of [m.initialObserverDistance,80,20,Math.max(A.minimumRadius(m,kind),m.horizon*1.05),A.minimumRadius(m,kind)]){
  const zoom=A.zoomForRadius(r,m,kind),pose=A.camera({zoom,viewZoom:zoom,tilt:18,yaw:0,observer:kind},m);
  relative(pose.r,r,2e-8);near(pose.fade,0);near(R.metricDot(pose.u,pose.u,pose.g),-1,1e-8);
  near(pose.initialObserverDistance,m.outer*4);assert.ok(pose.skyRadius>m.initialObserverDistance);
 }
}

// Four-times smaller physical accretion changes the solved temperatures,
// density and injection, instead of cosmetically scaling disk thickness.
for(const scene of ['quasar','retrograde','extreme','charged','hotspot']){
 assert.equal(A.scenes[scene].mdot,.015);const m=A.model({scene,...A.scenes[scene]}),profile=A.diskProfile(m),old=A.diskProfile({...m,massRate:m.massRate*4});
 assert.ok(profile.peakTemperature<old.peakTemperature&&profile.boundary.height<old.boundary.height);
 assert.notEqual(profile.constants.radialSpeed,old.constants.radialSpeed);
}
assert.equal(A.scenes.stellar.mdot,.12);assert.equal(A.scenes.m87.mdot,2e-5);assert.equal(A.scenes.sgrA.mdot,1e-8);
for(const scene of ['m87','sgrA','jet']){const m=A.model({scene,...A.scenes[scene]});near(m.outer,40);near(m.initialObserverDistance,80);near(m.skyRadius,150);near(A.framingScale(m,'infall'),1);}

// Refine quadrature and radial sampling independently at the maximum tested
// boundary. The exact ISCO sample prevents circular/infall interpolation from
// smearing a very small retrograde injection speed across the junction.
for(const spin of [-.9,0,.65,.998]){
 const m=A.model({scene:'quasar',model:'kerr',spin,charge:0},{computationalRadius:2048}),profile=A.diskProfile(m),dense=A.diskProfile(m,8192);
 const coarseFlux=A.fluxFactors(spin,0,2048),denseFlux=A.fluxFactors(spin,0,2048,8192);
 for(let i=0;i<128;i++){
  const r=m.isco*(m.outer/m.isco)**((i+.5)/128),sample=A.profileAt(profile,r),reference=A.profileAt(dense,r);
  sample.forEach((v,j)=>relative(v,reference[j],.001));
  const t=A.radialCoordinate(r,m.isco,m.outer,denseFlux.length),j=Math.floor(t),f=t-j,flux=denseFlux[j].f*(1-f)+denseFlux[Math.min(j+1,denseFlux.length-1)].f*f;
  const tc=A.radialCoordinate(r,m.isco,m.outer,coarseFlux.length),k=Math.floor(tc),fc=tc-k,approx=coarseFlux[k].f*(1-fc)+coarseFlux[Math.min(k+1,coarseFlux.length-1)].f*fc;
  relative(approx,flux,.0005);
 }
 for(const delta of [-1e-5,0,1e-5]){const r=m.isco*(1+delta),v=A.profileAt(profile,r),ref=A.profileAt(dense,r);v.forEach((value,j)=>relative(value,ref[j],.0005));}
 const at=A.profileAt(profile,m.isco),below=A.profileAt(profile,m.isco*(1-1e-7)),above=A.profileAt(profile,m.isco*(1+1e-7));
 at.forEach((v,j)=>{relative(below[j],v,.0001);relative(above[j],v,.0001);});relative(at[3],-profile.constants.radialSpeed,1e-6);
 // Each interval has a constant logarithmic spacing and their common endpoint
 // is the actual metric ISCO, rather than a nearby rounded grid radius.
 for(const [lo,hi] of [[0,profile.iscoIndex],[profile.iscoIndex,profile.count-1]]){
  const ratio=profile.motion[(lo+1)*4]/profile.motion[lo*4];for(let i=lo+2;i<=hi;i+=13)relative(profile.motion[i*4]/profile.motion[(i-1)*4],ratio,3e-7);
 }
 for(const index of [0,profile.iscoIndex,profile.count-1])near(A.radialCoordinate(profile.motion[index*4],profile.inner,profile.outer,profile.count,profile.isco,profile.iscoIndex),index,4e-5);
}

// The new distant start retains the original Schwarzschild critical shadow
// framing analytically. Infall aberration changes photon frequency normally;
// only the lens's initial screen calibration compensates for the moved camera.
for(const kind of ['static','infall']){
 const threshold=r=>{let sine=Math.sqrt(27)*Math.sqrt(1-2/r)/r;if(kind==='infall'){const speed=Math.sqrt(2/r);sine*=Math.sqrt(1-speed*speed)/(1+speed*Math.sqrt(1-sine*sine));}return r*sine/Math.sqrt(1-sine*sine);};
 for(const radius of [128,256,512,1024,2048]){const m=A.model({scene:'quasar',model:'schwarzschild'},{computationalRadius:radius});near(A.framingScale(m,kind)*threshold(m.initialObserverDistance),threshold(80),1e-12);}
}
const distant=A.model({scene:'quasar',model:'schwarzschild'},{computationalRadius:2048});
for(const radius of [4096,80,3,A.minimumRadius(distant,'infall')]){
 const zoom=A.zoomForRadius(radius,distant),pose=A.camera({zoom,tilt:18,yaw:0,observer:'infall',flightRadius:radius},distant);
 relative(pose.properTime,(distant.initialObserverDistance**1.5-radius**1.5)/(1.5*Math.sqrt(2)),2e-8);
}
// Exposure, budget and playback do not invalidate immutable physical inputs.
const cacheState={scene:'quasar',model:'kerr',spin:.65,charge:0,zoom:1,tilt:0,yaw:0,observer:'infall'},cachedModel=A.model(cacheState),cachedCamera=A.camera(cacheState,cachedModel);
assert.equal(A.model({...cacheState,exposure:4,density:240000,paused:true}),cachedModel);assert.equal(A.camera({...cacheState,exposure:4},cachedModel),cachedCamera);
assert.equal(A.diskProfile(cachedModel),A.diskProfile(cachedModel));assert.equal(A.spectralTable('visible',25000),A.spectralTable('visible',25000));
relative(A.planckNu(230e9,1e11),2*A.constants.k*1e11*(230e9)**2/A.constants.c**2,1e-8);
assert.ok(A.visible(20000)[2]>A.visible(20000)[0]);assert.ok(A.visible(3000)[0]>A.visible(3000)[2]);
near(P.besselK(0,1),.4210244382407083,2e-10);near(P.besselK(1,1),.6019072301972346,2e-10);near(P.besselK(2,1),1.6248388986351774,2e-10);

// Analytic polarized slabs and an independent RK4 matrix integration verify
// absorption, rotation/conversion, thick stability and the Stokes light cone.
const apply=(matrix,v)=>matrix.map(row=>row.reduce((s,x,i)=>s+x*v[i],0));
let slab=apply(P.attenuation(.7,[.2,0,0],[0,0,0],3),[1,0,0,0]);
near(slab[0],Math.exp(-2.1)*Math.cosh(.6));near(slab[1],-Math.exp(-2.1)*Math.sinh(.6));
slab=apply(P.attenuation(0,[0,0,0],[0,0,2],.75),[1,1,0,0]);near(slab[1],Math.cos(1.5));near(slab[2],Math.sin(1.5));near(slab[0],1);
slab=apply(P.attenuation(0,[0,0,0],[.9,0,0],2),[1,0,1,0]);near(slab[2],Math.cos(1.8));near(slab[3],Math.sin(1.8));
const alpha=.8,a=[.2,-.1,.05],rho=[.4,.2,.3],distance=2,J=[[-alpha,-a[0],-a[1],-a[2]],[-a[0],-alpha,-rho[2],rho[1]],[-a[1],rho[2],-alpha,-rho[0]],[-a[2],-rho[1],rho[0],-alpha]];
let v=[1,.3,-.2,.1];const h=distance/4096;
for(let i=0;i<4096;i++){const k1=apply(J,v),k2=apply(J,v.map((x,j)=>x+h*k1[j]/2)),k3=apply(J,v.map((x,j)=>x+h*k2[j]/2)),k4=apply(J,v.map((x,j)=>x+h*k3[j]));v=v.map((x,j)=>x+h*(k1[j]+2*k2[j]+2*k3[j]+k4[j])/6);}
apply(P.attenuation(alpha,a,rho,distance),[1,.3,-.2,.1]).forEach((x,i)=>near(x,v[i],2e-10));
for(let i=0;i<100;i++){const axis=[Math.sin(i),Math.cos(i*.7),Math.sin(i*.4)],abs=axis.map(x=>x*.2),rot=axis.map(x=>x*4),output=apply(P.attenuation(.8,abs,rot,1+i/20),[1,0,0,0]);assert.ok(output[0]>=Math.hypot(...output.slice(1))-1e-9&&output[0]<=1+1e-9);}
assert.ok(P.attenuation(1000,[500,0,0],[0,10,0],10).flat().every(Number.isFinite));

const folder=path.join(__dirname,'../dist/data'),metadata=JSON.parse(fs.readFileSync(path.join(folder,'grmhd-torus.json'))),buffer=zlib.gunzipSync(fs.readFileSync(path.join(folder,'grmhd-torus.f32.gz')));
assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'),metadata.sha256);assert.equal(buffer.byteLength,metadata.bytes);
assert.ok(metadata.maxDivB<2e-12&&metadata.maxVelocityNormError<1e-10&&metadata.times.length===41);
// Must equal the polar stretch the generator applied and both readers invert
// (dist/plasma.js velocityTexture, the shader's theta table).
assert.equal(metadata.thetaSlope,.7);
const records=new Float32Array(buffer.buffer,buffer.byteOffset,buffer.byteLength/4),vel=P.velocityTexture(records,metadata);
for(let i=0;i<vel.length;i+=4){assert.ok(vel[i]**2+vel[i+1]**2+vel[i+2]**2<1);assert.ok(vel[i+3]>=1-1e-6);}
// Orbital capture worldline; exercise production functions with independent physical oracles.
{
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
}
// Schwarzschild polarization screen; exercise production functions with independent physical oracles.
{
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
}
console.log('PASS: signed/charged ISCO, 96 timelike observer and injection families, null tetrads in both charts, Hamiltonian gradients, capture boundary, conserved escape, proper-time infall, mixed-pressure mass conservation, physical spectra, analytic/full Stokes transfer, verified causal GRMHD records, orbital capture worldlines and Schwarzschild screen transport.');
