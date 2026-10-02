"use strict";

(() => {
  // Geometrized units: r is measured in GM/c² and a is the dimensionless prograde spin.
  function iscoRadius(spin) {
    const a = Math.max(0, Math.min(0.95, spin));
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  }

  function model(settings) {
    const spin = settings.model === "kerr" ? settings.spin : 0;
    return {
      spin,
      isco: iscoRadius(spin),
      horizon: 1 + Math.sqrt(1 - spin * spin),
      outer: 26,
      // A circular shadow with a spin-dependent offset is an imaging approximation.
      shadow: Math.sqrt(27) * (1 - 0.035 * spin * spin),
      offset: -1.25 * spin * Math.cos(settings.tilt * Math.PI / 180)
    };
  }

  function angularVelocity(radius, spin) {
    return 1 / (Math.pow(radius, 1.5) + spin);
  }

  // Page–Thorne flux factor, adapted from grtrans kerr.f90/krolikc (MIT; see notices.txt).
  // The zero-spin root at zero has a vanishing coefficient and must not divide by zero.
  function thinDiskFlux(radius, spin) {
    const inner=iscoRadius(spin);
    if(radius<=inner)return 0;
    const y=Math.sqrt(radius),y0=Math.sqrt(inner),angle=Math.acos(spin)/3;
    const roots=[2*Math.cos(angle-Math.PI/3),2*Math.cos(angle+Math.PI/3),-2*Math.cos(angle)];
    let factor=1-y0/y-1.5*spin/y*Math.log(y/y0);
    roots.forEach((root,i)=>{
      if(Math.abs(root)<1e-10)return;
      const others=roots.filter((_,j)=>j!==i);
      const coefficient=3*(root-spin)**2/(y*root*(root-others[0])*(root-others[1]));
      factor-=coefficient*Math.log((y-root)/(y0-root));
    });
    const b=1-3/radius+2*spin/radius**1.5;
    return Math.max(0,factor/(b*radius**3));
  }

  function diskProfile(spin,outer=26,count=256) {
    const inner=iscoRadius(spin),flux=new Float32Array(count);
    let peak=0;
    for(let i=0;i<count;i++) {
      flux[i]=thinDiskFlux(inner+(outer-inner)*i/(count-1),spin);peak=Math.max(peak,flux[i]);
    }
    for(let i=0;i<count;i++)flux[i]/=Math.max(peak,1e-20);
    return {inner,outer,flux,peak};
  }

  function temperature(radius,inner,spin=0) {
    if(radius<=inner)return 0;
    const reference=thinDiskFlux(inner*1.6,spin);
    return Math.pow(thinDiskFlux(radius,spin)/Math.max(reference,1e-20),.25);
  }

  function sampleProfile(profile,radius) {
    if(radius<=profile.inner||radius>=profile.outer)return 0;
    const index=(radius-profile.inner)/(profile.outer-profile.inner)*(profile.flux.length-1);
    const lower=Math.floor(index),fraction=index-lower;
    return profile.flux[lower]*(1-fraction)+profile.flux[Math.min(lower+1,profile.flux.length-1)]*fraction;
  }

  globalThis.BlackHolePhysics = Object.freeze({ iscoRadius, model, angularVelocity, thinDiskFlux, diskProfile, sampleProfile, temperature });
})();
