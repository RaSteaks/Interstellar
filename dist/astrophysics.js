"use strict";

(() => {
  const R=globalThis.BlackHoleRelativity;
  const C=Object.freeze({c:299792458,G:6.67430e-11,h:6.62607015e-34,k:1.380649e-23,sigma:5.670374419e-8,solarMass:1.98847e30,proton:1.67262192369e-27,thomson:6.6524587321e-29});
  // The selected hot-disk boundary is an image-convergence policy, not a
  // physical disk edge. GRMHD keeps the finite boundary of its recorded cells.
  // Adjacent-domain images reach the cap: exactly edge-on gray-atmosphere
  // foreground columns remain unconverged at 2048 rg. Keep the real opacity
  // and report that limitation instead of tapering or shrinking the disk.
  const domain=Object.freeze({initialRadius:128,maximumRadius:2048,selectedRadius:2048,observerFactor:4,skyFactor:1.875,radialSamples:2048});
  const caches={models:new Map(),flux:new Map(),profiles:new Map(),spectra:new Map(),worldlines:new Map(),cameras:new Map()},cacheStats={models:0,flux:0,profiles:0,spectra:0,worldlines:0,cameras:0};
  function cached(kind,key,build,limit=32){
    const cache=caches[kind];if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
    const value=build();cacheStats[kind]++;cache.set(key,value);if(cache.size>limit)cache.delete(cache.keys().next().value);return value;
  }
  // These are illustrative physical configurations, not fits to measured spins.
  const scenes=Object.freeze({
    // Re-selecting the initial scene restores the same 8° disk elevation as startup.
    quasar:{name:"类星体 · 光学热盘",mass:5e8,mdot:.015,spin:.65,charge:0,model:"kerr",band:"visible",flow:"thermal",tilt:8},
    // A near-critical massive-particle capture, computed locally. This is an
    // illustrative thin disk, not a reconstruction of the Galactic Center.
    plunge:{name:"史瓦西 · 绕行坠落",mass:4.3e6,mdot:1e-4,spin:0,charge:0,model:"schwarzschild",band:"bolometric",flow:"thermal",tilt:18,observer:"infall",startRadius:80,diskOuterRadius:25,diskStructure:true,viewScale:.25,displayGain:.5,orbit:Object.freeze({energy:1,angularMomentum:3.995})},
    grmhd3d:{name:"全局三维 GRMHD · 史瓦西",mass:4.3e6,mdot:1e-8,spin:0,charge:0,model:"schwarzschild",band:"radio",flow:"grmhd3d",dataset:"grmhd3d",outerRadius:64,tilt:18,observer:"infall",startRadius:40,observationStart:160,viewScale:.25,electronRatio:10,displayGain:8,orbit:Object.freeze({energy:1,angularMomentum:3.995})},
    stellar:{name:"恒星级 · X 射线热盘",mass:10,mdot:.12,spin:.8,charge:0,model:"kerr",band:"xray",flow:"thermal",tilt:18},
    m87:{name:"M87* · 射电热流与喷流",mass:6.5e9,mdot:2e-5,spin:.9375,charge:0,model:"kerr",band:"radio",flow:"grmhd",tilt:73,observer:"static",electronRatio:40,displayGain:8},
    sgrA:{name:"银河系中心 · 射电热流",mass:4.3e6,mdot:1e-8,spin:.9375,charge:0,model:"kerr",band:"radio",flow:"grmhd",tilt:35,observer:"static",electronRatio:10,displayGain:200},
    jet:{name:"喷流基部 · 侧面观察",mass:6.5e9,mdot:2e-5,spin:.9375,charge:0,model:"kerr",band:"radio",flow:"grmhd",tilt:25,observer:"static",electronRatio:40},
    retrograde:{name:"逆行盘 · 反向自旋",mass:5e8,mdot:.015,spin:-.9,charge:0,model:"kerr",band:"visible",flow:"thermal",tilt:18},
    extreme:{name:"近极端克尔 · 内缘与细环",mass:5e8,mdot:.015,spin:.998,charge:0,model:"kerr",band:"visible",flow:"thermal",tilt:15},
    isolated:{name:"孤立黑洞 · 星空透镜",mass:1e8,mdot:0,spin:0,charge:0,model:"schwarzschild",band:"visible",flow:"vacuum",tilt:18},
    charged:{name:"带电黑洞 · 理论对照",mass:5e8,mdot:.015,spin:.55,charge:.6,model:"kerr-newman",band:"visible",flow:"thermal",tilt:18},
    hotspot:{name:"轨道热点 · 光路时延示例",mass:5e8,mdot:.015,spin:.65,charge:0,model:"kerr",band:"bolometric",flow:"thermal",tilt:18}
  });
  function model(state,{computationalRadius=domain.selectedRadius}={}) {
    const scene=scenes[state.scene]||scenes.quasar;
    const kind=state.model||scene.model,a=["kerr","kerr-newman"].includes(kind)?state.spin??scene.spin:0;
    const q=["reissner","kerr-newman"].includes(kind)?state.charge??scene.charge:0;
    // Ordinary thermal scenes use the converged numerical domain. The orbital
    // scene instead prescribes a finite physical disk, so its 80 rg observer
    // starts outside the source rather than inside an extended glowing disk.
    const outer=scene.flow==="thermal"?(scene.diskOuterRadius??R.clamp(computationalRadius,domain.initialRadius,domain.maximumRadius)):(scene.outerRadius??40);
    return cached("models",[state.scene,kind,a,q,outer].join(":"),()=>{
      const h=R.horizon(a,q),rg=C.G*scene.mass*C.solarMass/C.c**2,initialObserverDistance=scene.startRadius??(scene.flow==="thermal"?domain.observerFactor*outer:80);
      // A near-hole observer still needs the full emitting domain and a sky
      // outside that domain; moving the camera must not shrink the source.
      const sourceExtent=scene.flow==="thermal"?domain.observerFactor*outer:scene.flow==="grmhd3d"?2*outer:0;
      const skyRadius=Math.max(initialObserverDistance,sourceExtent)*domain.skyFactor;
      return Object.freeze({...scene,recorded:scene.flow==="grmhd"||scene.flow==="grmhd3d",model:kind,spin:a,charge:q,isco:R.isco(a,q),horizon:h.outer,innerHorizon:h.inner,outer,computationalRadius:outer,initialObserverDistance,skyRadius,rg,timeUnit:rg/C.c,
      // Dimensionless mdot uses L_Edd/(0.1 c²). Expose this convention in notes.
      massRate:scene.mdot*1.26e31*scene.mass/(.1*C.c**2)});
    });
  }
  function radialCoordinate(r,inner,outer,count,isco=null,iscoIndex=null){
    const radius=R.clamp(r,inner,outer);
    if(isco!==null&&iscoIndex!==null)return radius<=isco?Math.log(radius/inner)/Math.log(isco/inner)*iscoIndex:iscoIndex+Math.log(radius/isco)/Math.log(outer/isco)*(count-1-iscoIndex);
    return Math.log(radius/inner)/Math.log(outer/inner)*(count-1);
  }
  function profileAt(profile,r){
    // GPU texture centers use this same logarithmic fractional index. Both
    // paths linearly interpolate stored primitives, with no radius remapping.
    const count=profile.data.length/4,t=radialCoordinate(r,profile.inner,profile.outer,count,profile.isco??null,profile.iscoIndex??null),i=Math.floor(t),f=t-i,j=Math.min(i+1,count-1);
    return Array.from({length:4},(_,k)=>profile.data[i*4+k]*(1-f)+profile.data[j*4+k]*f);
  }
  function fluxFactors(a,q,outer,count=domain.radialSamples,stress=.02) {
    return cached("flux",[a,q,outer,count,stress].join(":"),()=>{
    const inner=R.isco(a,q),data=[];let integral=0,previous=R.circular(inner,a,q);
    const utI=previous.ut,lI=previous.angularMomentum;
    for(let i=0;i<count;i++){
      const r=inner*Math.pow(outer/inner,i/(count-1)),c=R.circular(r,a,q),dr=i?r-data[i-1].r:inner*(Math.pow(outer/inner,1/(count-1))-1);
      if(i>0)integral+=(1/previous.ut+1/c.ut)*.5*(c.angularMomentum-previous.angularMomentum);
      const eps=r*1e-5,omegaPrime=(R.circular(r+eps,a,q).omega-R.circular(r-eps,a,q).omega)/(2*eps);
      // General Page–Thorne integral works for signed Kerr AND neutral matter
      // in Kerr–Newman; an explicit stress term sets the ISCO boundary condition.
      const f=Math.max(0,-omegaPrime*c.ut*c.ut*(integral+stress*lI/utI)/(4*Math.PI*r));
      data.push({r,f,dr});previous=c;
    }
    return data;
    });
  }
  function pressureState(tc,sigma,verticalFactor) {
    const gas=C.k*tc/(.5*C.proton),rad=4*C.sigma*tc**4/(3*C.c);
    // The renderer uses rho(z)=rho0 exp(−z²/2H²), whose column is
    // sqrt(2pi) H rho0. A uniform-slab factor of 2 would overproduce mass.
    const aa=verticalFactor*gas,bb=verticalFactor*rad,cc=sigma*sigma/(2*Math.PI);
    const rho=2*cc/(bb+Math.sqrt(bb*bb+4*aa*cc)),height=sigma/(Math.sqrt(2*Math.PI)*rho);
    return {rho,height,gas:rho*gas,radiation:rad,tc};
  }
  function entropy(state){return C.k/(.5*C.proton)*(1.5*Math.log(state.tc)-Math.log(state.rho))+16*C.sigma*state.tc**3/(3*C.c*state.rho);}
  function diskProfile(m,count=domain.radialSamples) {
    return cached("profiles",[m.spin,m.charge,m.rg,m.outer,m.massRate,count].join(":"),()=>{
    const {spin:a,charge:q,rg,isco:ri,outer,massRate}=m,items=fluxFactors(a,q,outer,Math.max(domain.radialSamples,count));
    const fluxAt=r=>{const t=radialCoordinate(r,ri,outer,items.length),i=Math.floor(t),f=t-i;return items[i].f*(1-f)+items[Math.min(i+1,items.length-1)].f*f;};
    const physicalFlux=r=>massRate*C.c**2/rg**2*fluxAt(r);
    let speed=.006,boundary=null;
    // Couple steady mass conservation, mixed gas/radiation pressure and vertical
    // balance before selecting the radial injection. This is an analytic thin
    // flow; the separate GRMHD mode supplies evolved fluid primitives instead.
    const boundaryAt=velocity=>{
      const sigma=massRate/(2*Math.PI*ri*rg*Math.max(velocity,1e-7)*C.c),te=Math.pow(Math.max(physicalFlux(ri),1e-30)/C.sigma,.25);
      const tc=te*Math.pow(Math.max(1,3*.04*sigma/8),.25),c=R.circular(ri,a,q);
      // Vertical gravity is measured in the fluid's proper frame. Using the
      // coordinate epicyclic frequency would inflate high-spin disks spuriously.
      const vertical=(c.angularMomentum**2-a*a*(c.energy**2-1))*C.c**2/(rg*rg*ri**4);
      return pressureState(tc,sigma,1/vertical);
    };
    for(let iter=0;iter<64;iter++) {
      boundary=boundaryAt(speed);
      const sound=Math.sqrt((boundary.gas+boundary.radiation)/boundary.rho)/C.c;
      const next=.6*speed+.4*Math.min(.08,.35*sound),converged=Math.abs(next-speed)<speed*1e-10;speed=next;if(converged)break;
    }
    // Use the converged injection for BOTH sides of ISCO; a stale pre-update
    // pressure state would create a small artificial column discontinuity.
    boundary=boundaryAt(speed);
    const constants=R.inflowConstants(a,q,speed),sI=entropy(boundary);
    // The analytic adiabatic continuation also supplies local emitters for an
    // interior camera. Exterior rays cannot receive light from those cells.
    const rmin=m.innerHorizon+.35*(m.horizon-m.innerHorizon),iscoIndex=Math.max(1,Math.min(count-2,Math.round(Math.log(ri/rmin)/Math.log(outer/rmin)*(count-1)))),data=new Float32Array(count*4),motion=new Float32Array(count*4);
    let peakTemperature=0;
    for(let i=0;i<count;i++) {
      // Keep ISCO as an exact shared sample of two logarithmic intervals. This
      // avoids interpolating across the circular/infall junction, especially
      // for slow retrograde injection, while preserving the 2048-point budget.
      const r=i===iscoIndex?ri:i<iscoIndex?rmin*Math.pow(ri/rmin,i/iscoIndex):ri*Math.pow(outer/ri,(i-iscoIndex)/(count-1-iscoIndex));let ur,height,te,sigma,rho;
      if(r>=ri) {
        // A finite stress removes the zero-flow singularity; radial drift joins
        // the geodesic inflow with the same injected velocity at ISCO.
        ur=-speed*Math.pow(ri/r,.5);
        sigma=massRate/(2*Math.PI*r*rg*Math.abs(ur)*C.c);
        te=Math.pow(Math.max(physicalFlux(r),1e-30)/C.sigma,.25);
        const tc=te*Math.pow(Math.max(1,3*.04*sigma/8),.25),c=R.circular(r,a,q);
        const vertical=(c.angularMomentum**2-a*a*(c.energy**2-1))*C.c**2/(rg*rg*r**4);
        const s=pressureState(tc,sigma,1/vertical);height=s.height;rho=s.rho;
      } else {
        // Recover u^r directly from the timelike potential, avoiding Cartesian
        // angular contamination. Entropy conservation closes the mixed EOS.
        const delta=r*r-2*r+a*a+q*q,p=constants.energy*(r*r+a*a)-a*constants.angularMomentum;
        ur=-Math.sqrt(Math.max(0,p*p-delta*(r*r+(constants.angularMomentum-a*constants.energy)**2)))/(r*r);
        sigma=massRate/(2*Math.PI*r*rg*Math.max(1e-12,Math.abs(ur))*C.c);
        const vertical=rg*rg/C.c**2*r**4/(constants.angularMomentum**2-a*a*(constants.energy**2-1));
        let lo=Math.log(boundary.tc)-12,hi=Math.log(boundary.tc)+12;
        for(let j=0;j<56;j++){const mid=(lo+hi)/2,s=pressureState(Math.exp(mid),sigma,vertical);if(entropy(s)>sI)hi=mid;else lo=mid;}
        const s=pressureState(Math.exp((lo+hi)/2),sigma,vertical);height=s.height;rho=s.rho;te=s.tc/Math.pow(Math.max(1,3*.04*sigma/8),.25);
      }
      // Store physical temperature, scale height, mid-plane electron density
      // (cm−3), and proper radial velocity; no brightness floor is introduced.
      data.set([te,height/rg,rho/C.proton/1e6,ur],i*4);motion.set([r,sigma,rho,height/rg],i*4);
      if(r>=ri)peakTemperature=Math.max(peakTemperature,te);
    }
    return {data,motion,constants,inner:rmin,outer,count,isco:ri,iscoIndex,peakTemperature,boundary,stress:.02};
    });
  }
  function planckLambda(wavelength,temperature){const x=C.h*C.c/(wavelength*C.k*temperature);return x>700?0:2*C.h*C.c**2/(wavelength**5*Math.expm1(x));}
  function planckNu(frequency,temperature){const x=C.h*frequency/(C.k*temperature);return x>700?0:2*C.h*frequency**3/(C.c**2*Math.expm1(x));}
  const gaussian=(x,mean,left,right)=>Math.exp(-.5*((x-mean)/(x<mean?left:right))**2);
  function visible(temperature) {
    let x=0,y=0,z=0;
    // CIE 1931 matching-function fits: Wyman, Sloan & Shirley (2013).
    // Integrate spectral radiance through the observer band, not g^4 into RGB.
    for(let nm=380;nm<=780;nm+=5){const b=planckLambda(nm*1e-9,temperature)*5e-9;
      x+=b*(1.056*gaussian(nm,599.8,37.9,31)-.065*gaussian(nm,501.1,20.4,26.2)+.362*gaussian(nm,442,16,26.7));
      y+=b*(.821*gaussian(nm,568.8,46.9,40.5)+.286*gaussian(nm,530.9,16.3,31.1));
      z+=b*(1.217*gaussian(nm,437,11.8,36)+.681*gaussian(nm,459,26,13.8));
    }
    return [Math.max(0,3.2406*x-1.5372*y-.4986*z),Math.max(0,-.9689*x+1.8758*y+.0415*z),Math.max(0,.0557*x-.204*y+1.057*z)];
  }
  function spectrum(temperature,band) {
    if(band==="visible")return visible(temperature);
    if(band==="radio")return [planckNu(230e9,temperature),0,0];
    if(band==="bolometric")return [C.sigma*temperature**4/Math.PI,0,0];
    let value=0;const f0=.5*1.602176634e-16/C.h,f1=10*1.602176634e-16/C.h,n=64;
    for(let i=0;i<n;i++){const lo=f0*(f1/f0)**(i/n),hi=f0*(f1/f0)**((i+1)/n);value+=planckNu(Math.sqrt(lo*hi),temperature)*(hi-lo);}return [value,0,0];
  }
  function spectralTable(band,referenceTemperature=25000,count=768) {
    return cached("spectra",[band,referenceTemperature,count].join(":"),()=>{
    const reference=Math.max(1e-30,...spectrum(referenceTemperature,band)),data=new Float32Array(count*4);
    for(let i=0;i<count;i++){const t=10**(2+8*i/(count-1)),rgb=spectrum(t,band);data.set([...rgb.map(v=>v/reference),1],i*4);}
    return {data,reference,band};
    });
  }
  function minimumRadius(m,kind){return kind==="infall"?m.innerHorizon+.35*(m.horizon-m.innerHorizon):Math.max(2.15,m.horizon*1.12);}
  function framingScale(m,kind){
    // The screen uses impact coordinates rather than angular field of view.
    // A Schwarzschild critical cone fixes the lens calibration at the original
    // 80 rg framing, including the radial observer's aberration at the new start.
    // This changes no fluid primitive, transfer coefficient or Doppler factor.
    const critical=r=>{
      let sine=Math.sqrt(27)*Math.sqrt(1-2/r)/r;
      if(kind==="infall"){const speed=Math.sqrt(2/r);sine*=Math.sqrt(1-speed*speed)/(1+speed*Math.sqrt(1-sine*sine));}
      return r*sine/Math.sqrt(1-sine*sine);
    };
    return critical(80)/critical(m.initialObserverDistance)*(m.viewScale??1);
  }
  function radialRate(r,m,tilt){
    if(m.orbit)return R.infall([r,0,0],0,0,m.orbit.energy,m.orbit.angularMomentum)[0];
    const ct=Math.sin(tilt*Math.PI/180);return -Math.sqrt((2*r-m.charge*m.charge)*(r*r+m.spin*m.spin))/(r*r+m.spin*m.spin*ct*ct);
  }
  function advanceFall(radius,m,tilt,properElapsed){
    const minimum=minimumRadius(m,"infall"),n=Math.max(1,Math.ceil(properElapsed/.025)),dt=properElapsed/n;let r=radius;
    // Integrate proper time, rather than animating a zoom curve. All samples
    // follow the same conserved quantities used for observer aberration.
    for(let i=0;i<n&&r>minimum;i++){const k1=radialRate(r,m,tilt),k2=radialRate(Math.max(minimum,r+dt*k1/2),m,tilt),k3=radialRate(Math.max(minimum,r+dt*k2/2),m,tilt),k4=radialRate(Math.max(minimum,r+dt*k3),m,tilt);r=Math.max(minimum,r+dt*(k1+2*k2+2*k3+k4)/6);}return r;
  }
  function zoomForRadius(r,m,kind="infall"){
    const start=m.initialObserverDistance,travel=R.clamp(Math.log(start/r)/Math.log(start/minimumRadius(m,kind)),0,1);let lo=0,hi=1;
    for(let i=0;i<32;i++){const p=(lo+hi)/2;if(p*p*(3-2*p)<travel)lo=p;else hi=p;}return 1.4*Math.exp(Math.log(12/1.4)*(lo+hi)/2);
  }
  function camera(state,m) {
    const zoom=state.viewZoom??state.zoom,progress=R.clamp(Math.log(Math.max(zoom,1.4)/1.4)/Math.log(12/1.4),0,1),travel=progress*progress*(3-2*progress);
    const minimum=minimumRadius(m,state.observer);
    const start=m.initialObserverDistance,distance=Number.isFinite(state.flightRadius)?R.clamp(state.flightRadius,minimum,start):start*Math.exp(Math.log(minimum/start)*travel);
    const cameraKey=[m.spin,m.charge,start,m.skyRadius,m.viewScale,m.orbit?.energy,m.orbit?.angularMomentum,state.look,state.tilt,state.observer,distance,progress,state.yaw||0,state.drift||0].join(":");
    return cached("cameras",cameraKey,()=>{
    let angle=0,properTime=0,coordinateTime=0;
    if(state.observer==="infall"&&distance<start&&m.orbit){
      ({angle,properTime,coordinateTime}=orbitalWorldline(distance,m));
    } else if(state.observer==="infall"&&distance<start) {
      // Parameterize an E=1, L=0, Q=0 infall worldline by radius. The same
      // four-velocity determines camera aberration AND trajectory azimuth.
      const integral=cached("worldlines",[m.spin,m.charge,start,distance,state.tilt].join(":"),()=>{
      // Logarithmic quadrature resolves the near-hole part even when the
      // converged emitting domain places the initial observer thousands of rg away.
      const steps=384,dlog=Math.log(start/distance)/steps,theta=Math.PI/2-state.tilt*Math.PI/180;let orbit=0,proper=0,coordinate=0;
      for(let i=0;i<=steps;i++){const r=start*Math.exp(-i*dlog),dr=r*dlog/3*(i===0||i===steps?1:i%2?4:2),x=[r*Math.sin(theta),m.spin*Math.sin(theta),r*Math.cos(theta)],u=R.infall(x,m.spin,m.charge);
        const ur=-Math.sqrt((2*r-m.charge*m.charge)*(r*r+m.spin*m.spin))/(r*r+m.spin*m.spin*Math.cos(theta)**2);
        const up=(x[0]*u[1]-x[1]*u[0])/(x[0]*x[0]+x[1]*x[1])+m.spin/(r*r+m.spin*m.spin)*ur;
        orbit+=up/(-ur)*dr;proper+=dr/(-ur);coordinate+=u[3]/(-ur)*dr;
      }
      return {angle:orbit,properTime:proper,coordinateTime:coordinate};
      },256);({angle,properTime,coordinateTime}=integral);
    }
    // Outgoing KS is well conditioned for backward exterior capture; ingoing
    // KS is essential for an observer crossing the future horizon. Transform
    // the SAME observer/tetrad, rather than changing its physical velocity.
    const chart=distance>2.8?-1:1;
    const orbit=m.orbit&&state.observer==="infall"?{...m.orbit,phase:angle}:null;
    const yaw=(state.yaw||0)+(state.drift||0)+(orbit?0:angle),view=R.observer(m.spin,m.charge,state.tilt,distance,state.observer,yaw,chart,orbit);
    // A prescribed camera attitude is separate from the observer's motion.
    // Turn from inward to prograde as the tangential motion takes over; this
    // is a viewing convention, not gyroscope/parallel-transport dynamics.
    let heading=0;
    if(orbit&&state.look!=="center")heading=state.look==="outward"?Math.PI:Math.atan2(orbit.angularMomentum/distance,-radialRate(distance,m,state.tilt));
    const basis=heading===0?view.basis:[
      R.add(R.scale(view.basis[0],Math.cos(heading)),view.basis[2],-Math.sin(heading)),
      view.basis[1],
      R.add(R.scale(view.basis[2],Math.cos(heading)),view.basis[0],Math.sin(heading))
    ];
    return {...view,basis,progress,orbit:angle,properTime,coordinateTime,initialObserverDistance:start,skyRadius:m.skyRadius,framingScale:framingScale(m,state.observer),stage:distance<m.horizon?"inside":progress>.55?"approach":progress>0?"orbit":"observe",fade:0};
    },256);
  }
  function orbitalWorldline(radius,m){
    return cached("worldlines",["orbital",m.initialObserverDistance,radius,m.orbit.energy,m.orbit.angularMomentum].join(":"),()=>{
      const rates=logRadius=>{
        const r=Math.exp(logRadius),u=R.infall([r,0,0],0,0,m.orbit.energy,m.orbit.angularMomentum),weight=r/-u[0];
        return [m.orbit.angularMomentum/(r*r)*weight,weight,u[3]*weight];
      };
      const simpson=(lo,hi,a,b,c)=>a.map((v,i)=>(hi-lo)/6*(v+4*b[i]+c[i]));
      function integrate(lo,hi,a,b,c,whole,depth){
        const mid=(lo+hi)/2,leftMid=rates((lo+mid)/2),rightMid=rates((mid+hi)/2);
        const left=simpson(lo,mid,a,leftMid,b),right=simpson(mid,hi,b,rightMid,c),sum=left.map((v,i)=>v+right[i]),error=sum.map((v,i)=>v-whole[i]);
        if(error.every((v,i)=>Math.abs(v)<=15e-9*Math.max(1,Math.abs(sum[i]))))return sum.map((v,i)=>v+error[i]/15);
        if(depth===0)throw new Error("Orbital worldline quadrature did not converge");
        const refinedLeft=integrate(lo,mid,a,leftMid,b,left,depth-1),refinedRight=integrate(mid,hi,b,rightMid,c,right,depth-1);
        return refinedLeft.map((v,i)=>v+refinedRight[i]);
      }
      // Split at the E=1 unstable circular orbit: the near-critical slowdown
      // must be resolved even when a coarse quadrature would miss its peak.
      const boundaries=[radius,...(radius<4&&m.initialObserverDistance>4?[4]:[]),m.initialObserverDistance];
      const total=[0,0,0];
      for(let i=1;i<boundaries.length;i++){
        const lo=Math.log(boundaries[i-1]),hi=Math.log(boundaries[i]),a=rates(lo),b=rates((lo+hi)/2),c=rates(hi);
        const part=integrate(lo,hi,a,b,c,simpson(lo,hi,a,b,c),20);part.forEach((v,j)=>total[j]+=v);
      }
      return {angle:total[0],properTime:total[1],coordinateTime:total[2]};
    },256);
  }
  function observationStart(state,m){const fallback=m.observationStart??350;return m.flow==="grmhd3d"?(state.nativeObservationStart??fallback):fallback;}
  function observationTime(state,m,view=camera(state,m)){return observationStart(state,m)+state.time*8+view.coordinateTime;}
  globalThis.BlackHoleAstrophysics=Object.freeze({constants:C,domain,cacheStats,scenes,model,radialCoordinate,profileAt,fluxFactors,pressureState,entropy,diskProfile,planckLambda,planckNu,visible,spectrum,spectralTable,minimumRadius,framingScale,radialRate,advanceFall,zoomForRadius,camera,observationStart,observationTime});
})();
