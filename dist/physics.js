"use strict";

(() => {
  // Geometrized units: r is measured in GM/c² and a is the dimensionless prograde spin.
  function iscoRadius(spin) {
    const a = Math.max(-.998, Math.min(.998, spin));
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    // The sign chooses the orbit relative to the spin; negative spin is retrograde.
    return 3 + z2 - Math.sign(a) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  }

  function model(settings) {
    const spin = settings.model === "kerr" ? settings.spin : 0;
    const horizon = 1 + Math.sqrt(1 - spin * spin);
    return {
      spin,
      isco: iscoRadius(spin),
      horizon,
      // ISCO is a stability boundary, not a surface that erases infalling emitters.
      // Stay outside the coordinate singularity; outgoing photons are already strongly redshifted here.
      emissionInner: horizon * 1.003,
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

  // Finite ISCO stress and radiation-pressure-dominated plunge: Mummery et al.
  // (2024), arXiv:2405.09175, equations 47, 59 and 61. These are model choices,
  // not measured parameters or a substitute for evolving magnetic turbulence.
  const flow = Object.freeze({iscoStress:.02, radialSpeed:.01, plungeStride:5, clockScale:19});
  function plungeConstants(spin,radialSpeed=flow.radialSpeed) {
    const inner=iscoRadius(spin),root=Math.sqrt(inner);
    const angularMomentum=2*Math.sqrt(3)*(1-2*spin/(3*root));
    const circularEnergy=Math.sqrt(1-2/(3*inner));
    // A strictly marginal ISCO geodesic has zero inflow and infinite residence
    // time. Inject a small radial velocity, retaining L and solving R=r^4 u_r^2
    // for E, so the timelike four-velocity stays normalized throughout the plunge.
    const delta=inner*inner-2*inner+spin*spin;
    const aa=(inner*inner+spin*spin)**2-delta*spin*spin;
    const bb=-4*spin*inner*angularMomentum;
    const cc=spin*spin*angularMomentum**2-delta*(inner*inner+angularMomentum**2)-inner**4*radialSpeed**2;
    const energy=(-bb+Math.sqrt(bb*bb-4*aa*cc))/(2*aa);
    return {inner,energy,angularMomentum,circularEnergy,radialSpeed};
  }
  function flowVelocity(radius,spin,constants=plungeConstants(spin)) {
    // Geometry reconstruction can put an exact ISCO endpoint one ulp outside.
    if(radius>constants.inner*(1+1e-12)) {
      const ut=(1+spin/radius**1.5)/Math.sqrt(1-3/radius+2*spin/radius**1.5);
      return {ut,ur:0,uphi:ut*angularVelocity(radius,spin)};
    }
    const {energy:e,angularMomentum:l}=constants,delta=radius*radius-2*radius+spin*spin;
    const pp=e*(radius*radius+spin*spin)-spin*l;
    const radial=pp*pp-delta*(radius*radius+(l-spin*e)**2);
    const ur=-Math.sqrt(Math.max(0,radial))/(radius*radius);
    return {
      ut:(spin*(l-spin*e)+(radius*radius+spin*spin)*pp/delta)/(radius*radius),
      ur,
      uphi:(l-spin*e+spin*pp/delta)/(radius*radius)
    };
  }
  function stressedFlux(radius,spin,stress=flow.iscoStress) {
    const inner=iscoRadius(spin),x=Math.sqrt(inner),angle=Math.acos(-spin)/3;
    let boundary=x-1.5*spin*Math.log(x);
    for(let i=0;i<3;i++) {
      const root=2*Math.cos(angle-2*Math.PI*i/3);
      // The a=0 root at zero contributes zero; avoid the removable singularity.
      if(Math.abs(root)<1e-10)continue;
      const coefficient=(2*root-spin*(1+root*root))/(2*(1-root*root));
      boundary+=coefficient*Math.log(Math.abs(x-root));
    }
    const b=1-3/radius+2*spin/radius**1.5;
    return thinDiskFlux(radius,spin)+Math.max(0,stress*boundary/(Math.sqrt(radius)*b*radius**3));
  }
  function emissionProfile(spin,outer=26,count=512) {
    const constants=plungeConstants(spin),inner=(1+Math.sqrt(1-spin*spin))*1.003;
    const atIsco=stressedFlux(constants.inner,spin),flux=new Float32Array(count);
    let peak=0;
    for(let i=0;i<count;i++) {
      const r=inner+(outer-inner)*i/(count-1);
      // T_R^4/T_R,I^4=(r_I/r)^(17/7) (|u^r|/u_I)^(-1/7).
      // Use the actual normalized inflow, rather than adding a radial term to
      // circular motion without renormalizing the emitter four-velocity.
      flux[i]=r>=constants.inner?stressedFlux(r,spin):atIsco*(constants.inner/r)**(17/7)*(Math.abs(flowVelocity(r,spin,constants).ur)/constants.radialSpeed)**(-1/7);
      // Normalize against the stable disk, so a hot but heavily redshifted
      // horizon sample does not dim every orbit outside ISCO.
      if(r>=constants.inner)peak=Math.max(peak,flux[i]);
    }
    for(let i=0;i<count;i++)flux[i]/=Math.max(peak,1e-20);
    return {spin,inner,outer,isco:constants.inner,flux,peak,constants};
  }
  function plungeProfile(spin,count=512) {
    const constants=plungeConstants(spin),inner=(1+Math.sqrt(1-spin*spin))*1.003;
    const knots=[{r:constants.inner,t:0,phi:0}];
    // Integrate coordinate time and the Cartesian azimuth in the outgoing
    // Kerr-Schild coordinates used by the ray tracer, not Boyer-Lindquist time.
    const steps=4096,dr=(constants.inner-inner)/steps;
    let time=0,phase=0;
    for(let i=1;i<=steps;i++) {
      const r=constants.inner-(i-.5)*dr,v=flowVelocity(r,spin,constants),delta=r*r-2*r+spin*spin;
      const ut=v.ut-2*r/delta*v.ur,uphi=v.uphi-spin/delta*v.ur+spin/(r*r+spin*spin)*v.ur;
      time+=ut/(-v.ur)*dr;phase+=uphi/(-v.ur)*dr;
      knots.push({r:constants.inner-i*dr,t:time,phi:phase});
    }
    const data=new Float32Array(count*4);let k=1;
    for(let i=0;i<count;i++) {
      const t=time*i/(count-1);while(k<knots.length-1&&knots[k].t<t)k++;
      const a=knots[k-1],b=knots[k],f=(t-a.t)/(b.t-a.t);
      data[i*4]=a.r+(b.r-a.r)*f;data[i*4+1]=a.phi+(b.phi-a.phi)*f;
    }
    return {spin,inner,isco:constants.inner,duration:time,data,constants};
  }
  function particleOrbit(seed,index,time,profile,plunge) {
    const t=time*flow.clockScale;
    if(index%flow.plungeStride===0) {
      const age=((seed[3]+t/plunge.duration)%1+1)%1,position=age*(plunge.data.length/4-1),i=Math.floor(position),f=position-i;
      const j=Math.min(i+1,plunge.data.length/4-1),r=plunge.data[i*4]*(1-f)+plunge.data[j*4]*f;
      const phase=plunge.data[i*4+1]*(1-f)+plunge.data[j*4+1]*f;
      return {r,phi:seed[1]+(t-age*plunge.duration)*angularVelocity(plunge.isco,plunge.spin)+phase,plunging:true};
    }
    const r=profile.isco+(profile.outer-profile.isco)*seed[0];
    return {r,phi:seed[1]+t*angularVelocity(r,profile.spin),plunging:false};
  }
  function compatibilityShift(radius,phi,tilt,spin,constants) {
    // Local ZAMO Doppler factor for the Canvas fallback's straight sightline.
    // The velocity is timelike, including inside the ergosphere; this remains
    // a projection approximation because Canvas does not integrate the photon.
    const delta=radius*radius-2*radius+spin*spin;
    const aa=(radius*radius+spin*spin)**2-spin*spin*delta;
    const lapse=Math.sqrt(radius*radius*delta/aa),drag=2*spin*radius/aa;
    const v=flowVelocity(radius,spin,constants),gamma=lapse*v.ut;
    const radial=radius/Math.sqrt(delta)*v.ur/gamma,azimuth=Math.sqrt(aa)/radius*(v.uphi-drag*v.ut)/gamma;
    const nr=-Math.cos(tilt)*Math.sin(phi),np=-Math.cos(tilt)*Math.cos(phi);
    return Math.max(0,(lapse+drag*Math.sqrt(aa)/radius*np)/(gamma*(1-radial*nr-azimuth*np)));
  }

  // GLSL uses the same constants and timelike radial potential as the CPU path.
  const flowGlsl=`
    vec3 emitterBL(float r,float a,float isco,vec2 constants) {
      if(r>isco*(1.+1e-7)){float ut=(1.+a/pow(r,1.5))/sqrt(1.-3./r+2.*a/pow(r,1.5));return vec3(ut,0.,ut/(pow(r,1.5)+a));}
      float e=constants.x,l=constants.y,delta=r*r-2.*r+a*a;
      float pp=e*(r*r+a*a)-a*l;
      float ur=-sqrt(max(0.,pp*pp-delta*(r*r+(l-a*e)*(l-a*e))))/(r*r);
      return vec3((a*(l-a*e)+(r*r+a*a)*pp/delta)/(r*r),ur,(l-a*e+a*pp/delta)/(r*r));
    }
    vec4 emitterKS(vec3 x,float r,float a,float isco,vec2 constants) {
      vec3 v=emitterBL(r,a,isco,constants);float delta=r*r-2.*r+a*a;
      float ut=v.x-2.*r/delta*v.y,uphi=v.z-a/delta*v.y;
      vec2 radial=vec2(r*x.x-a*x.y,a*x.x+r*x.y)/(r*r+a*a);
      return vec4(v.y*radial+uphi*vec2(-x.y,x.x),0.,ut);
    }
  `;
  globalThis.BlackHolePhysics = Object.freeze({ iscoRadius, model, angularVelocity, thinDiskFlux, diskProfile, sampleProfile, temperature, flow, plungeConstants, flowVelocity, stressedFlux, emissionProfile, plungeProfile, particleOrbit, compatibilityShift, flowGlsl });
})();
