const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const context={};
for(const name of ['physics','geodesics'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,`../dist/${name}.js`),'utf8'),context);
const p=context.BlackHolePhysics,g=context.BlackHoleGeodesics;

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
console.log('PASS: 96 spins, finite ISCO emission, timelike inflow, conserved E/L, outgoing-photon horizon redshift, monotone particle trajectories and live orbit/plunge motion.');
