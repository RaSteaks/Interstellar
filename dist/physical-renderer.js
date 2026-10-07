"use strict";

(() => {
  function create({canvas,state,onNeedsFrame,onStatus,verification={}}) {
    const gl=canvas.getContext("webgl2",{alpha:false,antialias:false,powerPreference:"high-performance"});
    if(!gl||!gl.getExtension("EXT_color_buffer_float"))return null;
    const R=globalThis.BlackHoleRelativity,A=globalThis.BlackHoleAstrophysics,P=globalThis.BlackHolePlasma;
    const floatLinear=Boolean(gl.getExtension("OES_texture_float_linear"));
    const gpuTimer=verification.disableTimers?null:gl.getExtension("EXT_disjoint_timer_query_webgl2");
    // Idle drift is quantized to this screen displacement (CSS px) per retrace, so
    // the ambient motion stays continuous at a few retraces per second instead of
    // one retrace per frame. See driftStep in render().
    const DRIFT_RETRACE_PIXELS=12;
    // Discrete sampling levels avoid reallocating float targets for every small
    // timing fluctuation. GPU work, rather than monitor refresh, owns the budget.
    const BUDGET_SCALES=[.125,.1875,.25,.375,.5,.625,.75,1],DIAGNOSTIC_INTERVAL=250;
    const STATIC_JITTER=[[-.25,-.25],[.25,-.25],[-.25,.25],[.25,.25]];
    // Keep the CPU packing, RGBA32F byte accounting and shader frame budget in
    // lockstep; a solver record is 12 interleaved values per 64×64 cell.
    const MAX_FLUID_FRAMES=169,MAX_DYNAMIC_SLOTS=128,HISTORY_WIDTH=64,HISTORY_CELLS=HISTORY_WIDTH*HISTORY_WIDTH,RECORD_COMPONENTS=12,RGBA_COMPONENTS=4;
    const metrics={mode:"webgl2-volume-grrt",frames:0,geodesicBuilds:0,traceWidth:0,traceHeight:0,traceQuality:"interactive",raySamples:0,unfinishedRays:0,invalidRays:0,observerDistance:80,observerKind:"infall",horizonFade:0,stokes:true,timeDependent:true,fluid:"thermal",dataStatus:"idle",frameMs:0,sourceParticles:0,historyEndTime:800,latestSimulationTime:800,observationTime:null,solverProgressTime:800,solverStepRate:0,continuationStatus:"idle",cacheSlots:MAX_DYNAMIC_SLOTS,historyMissing:false};
    const vertex=`#version 300 es
      layout(location=0) in vec2 aPosition;out vec2 vUv;
      void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}
    `;
    const fragment=`#version 300 es
      precision highp float;precision highp int;precision highp sampler2DArray;
      in vec2 vUv;layout(location=0) out vec4 radiance;layout(location=1) out vec4 stokes;layout(location=2) out vec4 diagnostic;
      uniform vec3 uOrigin;uniform vec4 uObserver,uRight,uUp,uForward;
      uniform vec2 uExtent,uConstants,uJitter;uniform float uDistance,uSpin,uCharge,uHorizon,uIsco,uInner,uOuter,uTime,uRg,uDensityUnit,uSpectrumReference,uTolerance,uChart,uRadialSpeed,uElectronRatio,uMediumStep,uDiskCount,uSkyRadius,uEmissionScale,uDiskSplit,uFarStep,uInitialStep;
      uniform int uFlow,uBand,uPolarization,uMaxSteps,uFrameCount,uHotspot,uSkyEnabled;
      uniform sampler2D uDisk,uSpectrum,uBessel,uTheta;
      uniform sampler2DArray uFluid,uVelocity,uMagnetic;
      const int MAX_FLUID_FRAMES=169; // 41 historical layers + 128 logical-time slots
      uniform float uTimes[MAX_FLUID_FRAMES];uniform int uLayers[MAX_FLUID_FRAMES];uniform vec2 uGrid;
      ${R.glsl}
      ${P.glsl}
      const float PI=3.141592653589793;
      // Azimuthal/time chart integrals. Every caller anchors the azimuthal term at
      // the observer radius; relativity.js changeChart passes the same anchor, so
      // the JS and GPU chart changes stay exact inverses.
      vec2 chartIntegral(float r){
        float gap=2.*sqrt(1.-uSpin*uSpin-uCharge*uCharge),rp=1.+gap*.5,rm=1.-gap*.5;
        float l=log(abs((r-rp)/(r-rm)));
        return vec2(uSpin/gap*l,log(abs((r-rp)*(r-rm)))+(2.-uCharge*uCharge)/gap*l);
      }
      vec4 convertVector(vec4 v,vec3 x,vec3 target,float r,float from,float to){
        // The chart change is a radius-dependent planar rotation plus a time
        // shift. Its Cartesian Jacobian stays regular on the rotation axis;
        // resolving theta/phi separately would create a spurious 0/0 there.
        Geometry m=metric(x,uSpin,uCharge);float ur=dot(m.dr,v.xyz),D=r*r+uSpin*uSpin,delta=r*r-2.*r+uSpin*uSpin+uCharge*uCharge;
        float angle=(to-from)*(atan(uSpin/r)+chartIntegral(r).x-chartIntegral(uDistance).x),co=cos(angle),si=sin(angle);
        vec2 planar=mat2(co,si,-si,co)*v.xy+(to-from)*uSpin*(1./delta-1./D)*ur*vec2(-target.y,target.x);
        return vec4(planar,v.z,v.w+(to-from)*(2.*r-uCharge*uCharge)/delta*ur);
      }
      bool radialBarrier(vec3 x,vec4 p){
        Geometry m=metric(x,uSpin,uCharge);float ct=x.z/m.r,st=sqrt(max(1e-10,1.-ct*ct));
        float L=x.x*p.y-x.y*p.x,ptheta=dot(p.xyz,vec3(x.xy*ct/st,-m.r*st));
        float Q=ptheta*ptheta+ct*ct*(L*L/(st*st)-uSpin*uSpin*p.w*p.w);
        float A=uSpin*uSpin*p.w*p.w-L*L-Q,D=(L+uSpin*p.w)*(L+uSpin*p.w)+Q;
        if(p.w<=0.||A>=0.)return p.w<=0.;
        float pc=A/(2.*p.w*p.w),qc=D/(2.*p.w*p.w),disc=qc*qc*.25+pc*pc*pc/27.;if(disc>=0.)return false;
        float scale=sqrt(-pc/3.),r=2.*scale*cos(acos(clamp(-qc/(2.*scale*scale*scale),-1.,1.))/3.);
        float potential=p.w*p.w*r*r*r*r+A*r*r+2.*D*r-uCharge*uCharge*D-uSpin*uSpin*Q;
        return r>uHorizon&&m.r<r&&potential<0.;
      }
      float luminance(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
      // CPU and GPU share logarithmic radius coordinates, retaining inner-edge detail.
      vec4 disk(float r){
        float radius=clamp(r,uInner,uOuter),index=radius<=uIsco?log(radius/uInner)/log(uIsco/uInner)*uDiskSplit:uDiskSplit+log(radius/uIsco)/log(uOuter/uIsco)*(uDiskCount-1.-uDiskSplit);
        #ifdef DISK_MANUAL_INTERPOLATION
        int lo=int(floor(index)),hi=min(lo+1,int(uDiskCount)-1);return mix(texelFetch(uDisk,ivec2(lo,0),0),texelFetch(uDisk,ivec2(hi,0),0),fract(index));
        #else
        return texture(uDisk,vec2((index+.5)/uDiskCount,.5));
        #endif
      }
      vec3 bandSpectrum(float t){return texture(uSpectrum,vec2((clamp((log(max(t,1e-20))/log(10.)-2.)/8.,0.,1.)*767.+.5)/768.,.5)).rgb;}
      float planck(float nu,float t){return plasmaPlanck(nu,t);}
      vec3 bessel(float theta){return texture(uBessel,vec2((clamp((log(theta)/log(10.)+1.3)/5.3,0.,1.)*383.+.5)/384.,.5)).xyz;}
      vec4 fluidSample(sampler2DArray tex,vec2 uv,float time){
        if(uFrameCount<1||time<uTimes[0]||time>uTimes[uFrameCount-1])return vec4(0.);
        int lo=0,hi=uFrameCount-1;
        for(int j=0;j<8;j++){int mid=(lo+hi)/2;if(uTimes[mid]<=time)lo=mid;else hi=mid;}
        int next=min(lo+1,uFrameCount-1);float f=clamp((time-uTimes[lo])/max(.0001,uTimes[next]-uTimes[lo]),0.,1.);
        return mix(texture(tex,vec3(uv,float(uLayers[lo]))),texture(tex,vec3(uv,float(uLayers[next]))),f);
      }
      vec4 cartesian(vec4 spherical,vec3 x,float r,float a){
        float ct=clamp(x.z/r,-1.,1.),st=max(1e-10,length(x.xy)/sqrt(r*r+a*a));
        float delta=r*r-2.*r+a*a+uCharge*uCharge;
        spherical.x+=(rayChart-1.)*(2.*r-uCharge*uCharge)/delta*spherical.y;
        spherical.w+=(rayChart-1.)*a/delta*spherical.y;
        vec3 dr=vec3((r*x.x+rayChart*a*x.y)/(r*r+a*a),(r*x.y-rayChart*a*x.x)/(r*r+a*a),ct);
        vec3 dt=vec3(x.xy*ct/st,-r*st),dp=vec3(-x.y,x.x,0.);
        return vec4(spherical.y*dr+spherical.z*dt+spherical.w*dp,spherical.x);
      }
      vec3 physicalPoint(vec3 x,float r){
        float phi=atan(x.y,x.x)-rayChart*atan(uSpin/r),ct=x.z/r,st=length(x.xy)/sqrt(r*r+uSpin*uSpin);
        if(rayChart<0.)phi+=2.*(chartIntegral(r).x-chartIntegral(uDistance).x);
        return vec3((r*cos(phi)-uSpin*sin(phi))*st,(r*sin(phi)+uSpin*cos(phi))*st,x.z);
      }
      vec4 evolvedVelocity(vec4 packed,vec3 x,float r,out vec4 incoming){
        float physicalPhi=atan(x.y,x.x)-rayChart*atan(uSpin/r);
        if(rayChart<0.)physicalPhi+=2.*(chartIntegral(r).x-chartIntegral(uDistance).x);
        float co=cos(physicalPhi),si=sin(physicalPhi),ct=x.z/r,st=length(x.xy)/sqrt(r*r+uSpin*uSpin);
        vec3 n=vec3(st*co,st*si,ct),ve=vec3(mat2(co,si,-si,co)*packed.xy,packed.z);
        float f=(2.*r-uCharge*uCharge)/(r*r+uSpin*uSpin*ct*ct),root=sqrt(1.+f),gamma=inversesqrt(max(1e-8,1.-dot(ve,ve)));
        vec3 coordinate=ve-(1.-1./root)*n*dot(n,ve);
        incoming=gamma*vec4(coordinate-f*n/root,root);
        if(rayChart>0.)return incoming;
        vec3 physical=vec3((r*co-uSpin*si)*st,(r*si+uSpin*co)*st,x.z);
        return convertVector(incoming,physical,x,r,1.,-1.);
      }
      vec4 thermalVelocity(vec3 x,Geometry m){
        // All thermal velocities are evaluated in the regular ingoing chart.
        // Reuse the caller's radius, sigma and ingoing null direction instead
        // of recomputing the metric for either circular or plunging matter.
        float r=m.r,delta=r*r-2.*r+uSpin*uSpin+uCharge*uCharge,ur,ut,uphi;
        if(r<=uIsco){
          float s2=max(1e-8,1.-x.z*x.z/(r*r)),e=uConstants.x,l=uConstants.y;
          float p=e*(r*r+uSpin*uSpin)-uSpin*l,b=r*r+(l-uSpin*e)*(l-uSpin*e),rr=sqrt(max(0.,p*p-delta*b)),k=b/(p+rr);
          ur=-rr/m.sigma;ut=(uSpin*(l-uSpin*e*s2)+p+(2.*r-uCharge*uCharge)*k)/m.sigma;uphi=(l/s2-uSpin*e+uSpin*k)/m.sigma;
        }else{
          ur=-uRadialSpeed*sqrt(uIsco/r);float kr=sqrt(max(0.,r-uCharge*uCharge)),omega=kr/(r*r+uSpin*kr),s2=1.-x.z*x.z/(r*r);
          float tt=-1.+m.f,tp=-uSpin*m.f*s2,pp=s2*(r*r+uSpin*uSpin+uSpin*uSpin*m.f*s2);
          float utBL=sqrt((1.+m.sigma/delta*ur*ur)/(-(tt+2.*tp*omega+pp*omega*omega)));
          ut=utBL+(2.*r-uCharge*uCharge)/delta*ur;uphi=omega*utBL+uSpin/delta*ur;
        }
        return vec4(ur*m.n+uphi*vec3(-x.y,x.x,0.),ut);
      }
      bool thermalEmitter(vec3 x,Geometry m,out vec4 velocity){
        // Axisymmetry makes the physical-azimuth rotation and its inverse
        // cancel exactly. Construct the ingoing congruence at this same point,
        // then apply only the chart Jacobian's radial twist and time shift.
        float r=m.r,D=r*r+uSpin*uSpin,delta=D-2.*r+uCharge*uCharge;Geometry regular=m;
        regular.n=vec3((r*x.x+uSpin*x.y)/D,(r*x.y-uSpin*x.x)/D,x.z/r);
        velocity=thermalVelocity(x,regular);float norm=gdot(velocity,velocity,regular);if(norm>=0.)return false;
        velocity/=sqrt(-norm);
        if(rayChart<0.){float ur=dot(m.dr,velocity.xyz);velocity.xy+=(rayChart-1.)*uSpin*(1./delta-1./D)*ur*vec2(-x.y,x.x);velocity.w+=(rayChart-1.)*(2.*r-uCharge*uCharge)/delta*ur;}
        return true;
      }
      #ifndef THERMAL_SCALAR
      void source(vec3 x,vec4 p,float time,vec4 horizontal,vec4 vertical,out vec3 color,out float alpha,out vec3 absorption,out vec3 rho,out vec4 equilibrium,out float emittedEnergy){
        color=vec3(0.);alpha=0.;absorption=vec3(0.);rho=vec3(0.);equilibrium=vec4(1.,0.,0.,0.);emittedEnergy=1.;
        if(uFlow==0)return;Geometry m=metric(x,uSpin,uCharge);float r=m.r;
        if(r<uInner||r>uOuter)return;
        // Ordinary axisymmetric thermal matter has no emission-time dependence.
        if(rayChart<0.&&(uFlow==2||uHotspot==1))time+=2.*(chartIntegral(r).y-chartIntegral(uDistance).y);
        // Finite simulation history is not wrapped or extrapolated into a
        // different epoch. Geometry and the sky continue beyond missing cells.
        if(uFlow==2&&(time<uTimes[0]||time>uTimes[uFrameCount-1]))return;
        vec4 velocity,magnetic;float ne,t,B=0.,magneticNorm=0.;
        if(uFlow==2){
          float angle=acos(clamp(x.z/r,-1.,1.))/PI;
          float theta=texture(uTheta,vec2((angle*511.+.5)/512.,.5)).r;
          vec2 uv=vec2(theta,(log(r)-uGrid.x)/uGrid.y/64.);
          if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))return;
          vec4 f=fluidSample(uFluid,uv,time);float density=exp(f.x),internal=exp(f.y),bsq=max(1e-30,f.z);
          // Suppress numerical atmosphere and unresolved, highly magnetized
          // funnel cells. The emitting jet sheath remains actual evolved fluid.
          if(density<1.5e-7*pow(r,-1.5)||bsq/density>50.)return;
          ne=density*uDensityUnit/1.67262192369e-24;
          float beta=2.*(2./3.)*internal/bsq,ratio=(1.+uElectronRatio*beta*beta)/(1.+beta*beta);
          t=(2./3.)*internal/density*1.0888198e13/(1.+ratio);
          vec4 incoming;velocity=evolvedVelocity(fluidSample(uVelocity,uv,time),x,r,incoming);
          vec3 physical=physicalPoint(x,r);float saved=rayChart;rayChart=1.;Geometry regular=metric(physical,uSpin,uCharge);
          vec4 field=cartesian(fluidSample(uMagnetic,uv,time),physical,r,uSpin);
          field+=incoming*gdot(field,incoming,regular);magneticNorm=sqrt(max(0.,gdot(field,field,regular)));rayChart=saved;
          magnetic=rayChart>0.?field:convertVector(field,physical,x,r,1.,-1.);
          B=magneticNorm*sqrt(4.*PI*uDensityUnit*8.98755179e20);
        } else {
          vec4 f=disk(r);float height=max(1e-5,f.y),z=x.z/height;
          if(abs(z)>8.)return;ne=f.z*exp(-.5*z*z);t=f.x;
          // Normalize in the regular chart before applying its time/radial
          // Jacobian. The same exact congruence is shared with the scalar path.
          if(!thermalEmitter(x,m,velocity))return;magnetic=vec4(0.);
          if(uHotspot==1){
            float spot=max(uIsco*1.8,7.),omega=1./(pow(spot,1.5)+uSpin),physicalPhi=atan(x.y,x.x);
            if(rayChart<0.)physicalPhi+=2.*atan(uSpin/r)+2.*(chartIntegral(r).x-chartIntegral(uDistance).x);
            float phase=physicalPhi-omega*time;
            float distance=(r-spot)*(r-spot)+4.*r*spot*(sin(phase*.5)*sin(phase*.5));
            t*=pow(1.+8.*exp(-distance/1.5),.25);
          }
        }
        emittedEnergy=dot(p,velocity);if(emittedEnergy<=0.)return;float g=1./emittedEnergy;
        // Optical-band integration uses B_nu(g T); g^3 is already included
        // by Planck's scaling identity. No artificial maximum g is imposed.
        if(uFlow==1){
          float hardening=1.+.7*smoothstep(1e5,1e6,t);
          if(r<uIsco)hardening*=pow(uIsco/r,.5);
          color=bandSpectrum(t*g*hardening)/pow(hardening,4.);
          float kappa=ne*6.6524587321e-25;
          // Last-scattering gray atmosphere approximation; transfer through the
          // finite column replaces a particle-weight opacity or incidence floor.
          alpha=kappa;
          if(uPolarization==1){
            vec4 k=raise4(p,m),normal=raise4(vec4(0.,0.,1.,0.),m);normal+=velocity*gdot(normal,velocity,m);normal/=sqrt(max(1e-10,gdot(normal,normal,m)));
            float mu=clamp(abs(gdot(normal,k,m))/emittedEnergy,0.,1.),pol=.11713*(1.-mu)/(1.+3.582*mu);
            vec4 h=horizontal-k*(gdot(horizontal,velocity,m)/emittedEnergy),v=vertical-k*(gdot(vertical,velocity,m)/emittedEnergy);
            float angle=atan(gdot(normal,v,m),gdot(normal,h,m))+.5*PI;
            equilibrium.yz=pol*vec2(cos(2.*angle),sin(2.*angle));
          }
        } else {
          float theta=t/5.92989658e9,nu=(uBand==2?230e9:uBand==1?2.4179892e17:5.45e14)/g;
          if(B<=0.)return;
          vec4 k=raise4(p,m);float bnorm=max(1e-30,magneticNorm),cosine=clamp(-dot(magnetic,p)/(bnorm*emittedEnergy),-.999999,.999999);
          vec4 h=horizontal-k*(gdot(horizontal,velocity,m)/emittedEnergy),v=vertical-k*(gdot(vertical,velocity,m)/emittedEnergy);
          float angle=atan(gdot(magnetic,v,m),gdot(magnetic,h,m))+.5*PI;
          float thetaFit=max(.051,theta);vec3 rotation;vec4 j=thermalSynch(ne,B,thetaFit,nu,cosine,bessel(thetaFit),rotation);
          if(theta<.051){
            // Cold foreground can rotate polarization even when its thermal
            // synchrotron emission at 230 GHz is exponentially negligible.
            float nb=2.799249e6*B;j=vec4(0.);
            rotation=vec3(ne*2.30707755e-19*nb*nb*(1.-cosine*cosine)/(9.1093837e-28*2.99792458e10*nu*nu*nu),0.,2.*ne*2.30707755e-19*nb*cosine/(9.1093837e-28*2.99792458e10*nu*nu));
          }
          float blackbody=planck(nu,t),den=max(1e-35,blackbody);
          alpha=max(0.,j.x/den);vec3 local=j.yzw/den;
          // Enforce the physical Stokes cone only outside the emissivity fit's
          // domain, where independently fitted Q/V could exceed I.
          local*=min(1.,.999*alpha/max(1e-35,length(local)));
          float co=cos(2.*angle),si=sin(2.*angle);
          absorption=vec3(local.x*co-local.y*si,local.x*si+local.y*co,local.z);
          rho=vec3(rotation.x*co,rotation.x*si,rotation.z);
          color=vec3(blackbody*g*g*g/uSpectrumReference);
          if(uBand==0)color*=vec3(.75,.85,1.);
        }
        // Keep the evolved-data edge convention; thermal matter has no
        // artificial outer fade, so its finite boundary must converge in images.
        if(uFlow==2){float edge=1.-smoothstep(uOuter*.9,uOuter,r);alpha*=edge;absorption*=edge;rho*=edge;}
      }
      #else
      // Gray LTE intensity requires only a scalar optical depth. This variant
      // omits parallel-transported screen vectors and all Stokes matrix work.
      void sourceIntensity(vec3 x,vec4 p,float time,out vec3 color,out float alpha,out float emittedEnergy){
        color=vec3(0.);alpha=0.;emittedEnergy=1.;if(uFlow==0)return;
        Geometry m=metric(x,uSpin,uCharge);float r=m.r;if(r<uInner||r>uOuter)return;
        vec4 f=disk(r);float height=max(1e-5,f.y),z=x.z/height;if(abs(z)>8.)return;
        float ne=f.z*exp(-.5*z*z),t=f.x;
        // Retarded time is required only by the prescribed moving hotspot.
        if(rayChart<0.&&uHotspot==1)time+=2.*(chartIntegral(r).y-chartIntegral(uDistance).y);
        vec4 velocity;if(!thermalEmitter(x,m,velocity))return;
        if(uHotspot==1){
          float spot=max(uIsco*1.8,7.),omega=1./(pow(spot,1.5)+uSpin),phi=atan(x.y,x.x);
          if(rayChart<0.)phi+=2.*atan(uSpin/r)+2.*(chartIntegral(r).x-chartIntegral(uDistance).x);
          float phase=phi-omega*time,distance=(r-spot)*(r-spot)+4.*r*spot*(sin(phase*.5)*sin(phase*.5));
          t*=pow(1.+8.*exp(-distance/1.5),.25);
        }
        emittedEnergy=dot(p,velocity);if(emittedEnergy<=0.)return;float g=1./emittedEnergy;
        float hardening=1.+.7*smoothstep(1e5,1e6,t);if(r<uIsco)hardening*=pow(uIsco/r,.5);
        color=bandSpectrum(t*g*hardening)/pow(hardening,4.);alpha=ne*6.6524587321e-25;
      }
      #endif
      float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
      vec3 starField(vec3 direction,float grid,float cutoff,float g){
        vec3 cell=floor(direction*grid),result=vec3(0.);
        for(int i=0;i<8;i++){vec3 c=cell+vec3(float(i&1),float((i>>1)&1),float((i>>2)&1))-.5;
          float seed=hash(c);if(seed<cutoff)continue;
          vec3 point=normalize(c+vec3(hash(c+2.),hash(c+7.),hash(c+11.))-.5);
          float width=(.075+.12*hash(c+5.))/grid,delta=length(direction-point);
          float light=exp(-delta*delta/(width*width))*(.3+2.*pow(hash(c+9.),6.));
          float temperature=3300.+9000.*hash(c+13.);vec3 intrinsic=bandSpectrum(temperature),observed=bandSpectrum(temperature*g);
          result+=observed/max(1e-20,max(max(intrinsic.x,intrinsic.y),intrinsic.z))*light;
        }return result;
      }
      vec3 sky(vec3 direction,float g){
        vec3 band=normalize(vec3(.88,.34,.33));float latitude=dot(direction,band);
        float dust=.3+.7*smoothstep(.2,.85,hash(floor(direction*8.)));
        float haze=.0005*exp(-latitude*latitude*24.)*dust;
        // The same spectral scaling used for the disk handles observer Doppler
        // colors and intensity. Fixed-color g^3 would overboost hot radio/optical
        // stars and omit the change of their observed color temperature.
        vec3 intrinsic=bandSpectrum(5000.);
        return starField(direction,70.,.91,g)+starField(direction,135.,.97,g)+bandSpectrum(5000.*g)/max(1e-20,max(max(intrinsic.x,intrinsic.y),intrinsic.z))*haze;
      }
      #ifndef THERMAL_SCALAR
      void transportStep(vec3 x,vec3 p,float energy,vec4 a,vec4 b,float h,out vec4 na,out vec4 nb){
        vec4 x1,x2,x3;vec3 p1,p2,p3;rhs(x,p,energy,uSpin,uCharge,x1,p1);
        vec4 a1=parallelDerivative(x,vec4(p,energy),a,uSpin,uCharge),b1=parallelDerivative(x,vec4(p,energy),b,uSpin,uCharge);
        vec3 x2p=x+.5*h*x1.xyz,p2p=p+.5*h*p1;rhs(x2p,p2p,energy,uSpin,uCharge,x2,p2);
        vec4 a2=parallelDerivative(x2p,vec4(p2p,energy),a+.5*h*a1,uSpin,uCharge),b2=parallelDerivative(x2p,vec4(p2p,energy),b+.5*h*b1,uSpin,uCharge);
        vec3 x3p=x+.75*h*x2.xyz,p3p=p+.75*h*p2;
        vec4 a3=parallelDerivative(x3p,vec4(p3p,energy),a+.75*h*a2,uSpin,uCharge),b3=parallelDerivative(x3p,vec4(p3p,energy),b+.75*h*b2,uSpin,uCharge);
        na=a+h*(2./9.*a1+1./3.*a2+4./9.*a3);nb=b+h*(2./9.*b1+1./3.*b2+4./9.*b3);
      }
      void recondition(vec4 p,Geometry m,inout vec4 a,inout vec4 b){
        vec4 u=vec4(-m.f*m.n/sqrt(1.+m.f),sqrt(1.+m.f)),k=raise4(p,m);
        vec4 direction=k/gdot(k,u,m)+u;direction/=sqrt(max(1e-12,gdot(direction,direction,m)));
        a+=u*gdot(a,u,m);a-=direction*gdot(a,direction,m);a/=sqrt(max(1e-12,gdot(a,a,m)));
        b+=u*gdot(b,u,m);b-=direction*gdot(b,direction,m);b-=a*gdot(b,a,m);b/=sqrt(max(1e-12,gdot(b,b,m)));
      }
      #endif
      void main(){
        rayChart=uChart;
        vec2 impact=(vUv+uJitter-.5)*uExtent;vec3 direction=normalize(vec3(impact/uDistance,1.));
        vec4 spatial=direction.x*uRight+direction.y*uUp+direction.z*uForward;
        vec4 k=-uObserver+spatial;Geometry initial=metric(uOrigin,uSpin,uCharge);vec4 initialP=lower4(k,initial);
        #ifndef THERMAL_SCALAR
        vec4 horizontal=uRight-direction.x*spatial;horizontal/=sqrt(gdot(horizontal,horizontal,initial));
        vec4 vertical=uUp-direction.y*spatial;vertical-=horizontal*gdot(vertical,horizontal,initial);vertical/=sqrt(gdot(vertical,vertical,initial));
        mat4 transfer=mat4(1.);
        #else
        float transmission=1.;
        #endif
        vec3 x=uOrigin,p=initialP.xyz;float energy=initialP.w,time=0.,h=uInitialStep;
        // The initial far-field trial scales with the empty distance to matter;
        // the usual error/medium limits still accept or reject it.
        // Keep one geometry cache: the final BS stage becomes the next seed.
        // Trial rejection and chart changes reinitialize it at unchanged x/p.
        Geometry m=initial;vec4 rayDx;vec3 rayDp;rhsAtMetric(p,energy,m,rayDx,rayDp);
        vec3 total=vec3(0.);vec4 totalStokes=vec4(0.);
        int status=0,accepted=0;float maxError=0.,depth=0.;bool reachedExterior=uDistance>uHorizon*1.00001;
        bool boundedInterior=uDistance<uHorizon&&radialBarrier(uOrigin,initialP);
        for(int i=0;i<2048;i++){
          if(i>=uMaxSteps)break;
          if(m.r>uSkyRadius){status=1;break;}
          vec4 velocity=rayDx;
          // The ingoing chart is regular across the future horizon. Backward
          // outgoing branches instead approach the eternal hole's past horizon
          // at infinite coordinate time. Terminate THAT branch, not an interior
          // observer's initially outward past light cone. Negative Killing
          // energy inside cannot connect to a stationary exterior light source.
          if(m.r>uHorizon*1.00001)reachedExterior=true;
          float radial=dot(m.dr,velocity.xyz);
          if((reachedExterior&&m.r<uHorizon*1.0005&&radial<0.)||(boundedInterior&&abs(m.r-uHorizon)<uHorizon*1e-5)||(uDistance<uHorizon&&energy<=0.&&m.r>uHorizon*.99999)||m.r<.08){status=2;break;}
          if(rayChart>0.&&m.r>2.8){
            // An interior ray that reached the well-conditioned exterior can
            // continue in the outgoing chart. Transform tangent and BOTH screen
            // vectors with the Jacobian, including physical time and azimuth.
            vec2 integral=chartIntegral(m.r)-chartIntegral(uDistance);
            float phi=atan(x.y,x.x)-atan(uSpin/m.r)-2.*integral.x,ct=x.z/m.r,st=length(x.xy)/sqrt(m.r*m.r+uSpin*uSpin);
            vec3 target=vec3((m.r*cos(phi)+uSpin*sin(phi))*st,(m.r*sin(phi)-uSpin*cos(phi))*st,x.z);
            vec4 tangent=convertVector(velocity,x,target,m.r,1.,-1.);
            #ifndef THERMAL_SCALAR
            horizontal=convertVector(horizontal,x,target,m.r,1.,-1.);vertical=convertVector(vertical,x,target,m.r,1.,-1.);
            #endif
            x=target;time-=2.*integral.y;rayChart=-1.;m=metric(x,uSpin,uCharge);p=lower4(tangent,m).xyz;rhsAtMetric(p,energy,m,rayDx,rayDp);
            h=min(h,.05);continue;
          }
          // Geometry error controls the empty far field; there is no fixed
          // 5 r_g ceiling. Constrain entry into the finite medium before applying
          // its vertical/radial scales, so a long vacuum step cannot skip a layer.
          // In the empty thermal far field, the embedded error estimator chooses
          // the accepted step. Retain the tighter geometric cap inside matter.
          float speed=max(1.,length(velocity.xyz)),limit=(uFlow==1&&m.r>uOuter?uFarStep:.22)*m.r/speed;
          if(uFlow==1&&m.r>uInner){
            float height=max(1e-5,disk(min(m.r,uOuter)).y);
            if(m.r>uOuter&&radial<0.)limit=min(limit,max(.25*height*uMediumStep,.8*(m.r-uOuter))/speed);
            if(m.r<=uOuter){
              if(x.z*velocity.z<0.||abs(x.z)<8.*height)limit=min(limit,max(.35*height*uMediumStep,.65*(abs(x.z)-5.*height))/max(.02,abs(velocity.z)));
              if(abs(x.z)<8.*height)limit=min(limit,.08*uMediumStep*m.r/speed);
            }
          }
          if(uFlow==2&&m.r<uOuter)limit=min(limit,.065*uMediumStep*m.r/max(1.,length(velocity.xyz)));
          h=min(h,limit);vec3 nx,np;float nt,error;
          stepBSSeeded(x,p,time,energy,uSpin,uCharge,h,rayDx,rayDp,nx,np,nt,error,m,rayDx,rayDp);
          // A nonfinite trial is rejected while a smaller affine step remains
          // available. Only a failure at minimum step marks the ray invalid.
          if(any(isnan(nx))||any(isnan(np))||any(isinf(nx))||any(isinf(np))){if(h>1e-5){h=max(1e-5,h*.5);seedBS(x,p,energy,uSpin,uCharge,m,rayDx,rayDp);continue;}status=4;break;}
          if(error>uTolerance&&h>1e-5){h*=max(.15,.8*pow(uTolerance/error,1./3.));seedBS(x,p,energy,uSpin,uCharge,m,rayDx,rayDp);continue;}
          vec3 midpoint=(x+nx)*.5;vec4 momentum=vec4((p+np)*.5,energy);
          #ifdef THERMAL_SCALAR
          vec3 color;float alpha,emitted;sourceIntensity(midpoint,momentum,uTime+(time+nt)*.5,color,alpha,emitted);
          // The outgoing emitter chart has a pole at the future horizon. If a
          // trial midpoint lands there, retry from the unchanged ray state; a
          // smaller accepted step reaches the existing capture boundary first.
          if(isnan(alpha)||isinf(alpha)||any(isnan(color))||any(isinf(color))||isnan(emitted)||isinf(emitted)){if(h>1e-5){h=max(1e-5,h*.5);seedBS(x,p,energy,uSpin,uCharge,m,rayDx,rayDp);continue;}status=4;break;}
          accepted++;maxError=max(maxError,error);
          if(alpha>0.){
            float optical=alpha*h*emitted*uRg,received=transmission*oneMinusExp(optical);
            total+=uEmissionScale*color*received;totalStokes.x+=uEmissionScale*received*luminance(color);
            transmission*=exp(-optical);depth+=optical;if(transmission<2.5e-8){status=3;break;}
          }
          x=nx;p=np;time=nt;
          #else
          vec4 nh=horizontal,nv=vertical;
          if(uPolarization==1)transportStep(x,p,energy,horizontal,vertical,h,nh,nv);
          vec3 color,absorption,rho;float alpha,emitted;vec4 equilibrium;
          source(midpoint,momentum,uTime+(time+nt)*.5,(horizontal+nh)*.5,(vertical+nv)*.5,color,alpha,absorption,rho,equilibrium,emitted);
          if(isnan(alpha)||isinf(alpha)||any(isnan(color))||any(isinf(color))||any(isnan(rho))||any(isinf(rho))||any(isnan(absorption))||any(isinf(absorption))||isnan(emitted)||isinf(emitted)){if(h>1e-5){h=max(1e-5,h*.5);seedBS(x,p,energy,uSpin,uCharge,m,rayDx,rayDp);continue;}status=4;break;}
          accepted++;maxError=max(maxError,error);
          if(alpha>0.||length(rho)>0.){
            float ds=h*emitted*uRg;vec4 localSource;mat4 local=attenuation(alpha,absorption,rho,ds,localSource);
            if(any(isnan(local[0]))||any(isnan(local[1]))||any(isnan(local[2]))||any(isnan(local[3]))||any(isinf(local[0]))||any(isinf(local[1]))||any(isinf(local[2]))||any(isinf(local[3]))){if(h>1e-5){accepted--;h=max(1e-5,h*.5);seedBS(x,p,energy,uSpin,uCharge,m,rayDx,rayDp);continue;}status=4;break;}
            if(uFlow==1)localSource=equilibrium*oneMinusExp(alpha*ds);
            // Constant-cell LTE source includes internal Faraday rotation.
            vec4 received=transfer*localSource;total+=uEmissionScale*color*max(0.,received.x);totalStokes+=uEmissionScale*received*luminance(color);
            transfer=transfer*local;depth+=alpha*ds;
            if(length(transfer[0])+length(transfer[1])+length(transfer[2])+length(transfer[3])<1e-7){status=3;break;}
          }
          x=nx;p=np;time=nt;horizontal=nh;vertical=nv;
          if(uPolarization==1)recondition(vec4(p,energy),m,horizontal,vertical);
          #endif
          h*=clamp(.9*pow(uTolerance/max(error,1e-15),1./3.),.5,2.);
        }
        if(status==1&&energy>0.){
          Geometry m=metric(x,uSpin,uCharge);vec3 velocity=raise4(vec4(p,energy),m).xyz;
          if(rayChart<0.){float rotation=2.*atan(uSpin/m.r)+2.*(chartIntegral(m.r).x-chartIntegral(uDistance).x),co=cos(rotation),si=sin(rotation),ur=dot(m.dr,velocity);
            vec2 target=mat2(co,si,-si,co)*x.xy;velocity.xy=mat2(co,si,-si,co)*velocity.xy+2.*uSpin*(1./(m.r*m.r-2.*m.r+uSpin*uSpin+uCharge*uCharge)-1./(m.r*m.r+uSpin*uSpin))*ur*vec2(-target.y,target.x);
          }
          // Optical stellar backgrounds do not become radio/X-ray sources just
          // because a false-color palette is selected for those instruments.
          vec3 background=uSkyEnabled==1&&(uBand==0||uBand==3)?sky(normalize(velocity),1./energy):vec3(0.);
          #ifdef THERMAL_SCALAR
          total+=background*transmission;totalStokes.x+=transmission*luminance(background);
          #else
          vec4 received=transfer*vec4(1.,0.,0.,0.);total+=background*max(0.,received.x);totalStokes+=received*luminance(background);
          #endif
        }
        if(any(isnan(total))||any(isinf(total))||any(isnan(totalStokes))||any(isinf(totalStokes))){total=vec3(0.);totalStokes=vec4(0.);status=4;}
        // status=0 is explicitly unfinished, NEVER advertised as capture.
        #ifdef THERMAL_SCALAR
        float residual=transmission;
        #else
        float residual=max(0.,transfer[0].x);
        #endif
        // Alpha exposes residual intensity transmission for scientific checks.
        radiance=vec4(max(total,vec3(0.)),residual);stokes=totalStokes;diagnostic=vec4(float(status),float(accepted),maxError,status==0?metric(x,uSpin,uCharge).r:depth);
      }
    `;
    // The optical PSF is a display cache, independent of physical radiance and
    // exposure. Manual filtering keeps unsupported float-linear devices smooth.
    const filter=`
      vec4 filtered(sampler2D tex,vec2 uv){
        #ifdef MANUAL_IMAGE_FILTER
        ivec2 last=textureSize(tex,0)-1;vec2 p=uv*vec2(last+1)-.5,f=fract(p);ivec2 a=ivec2(floor(p));
        return mix(mix(texelFetch(tex,clamp(a,ivec2(0),last),0),texelFetch(tex,clamp(a+ivec2(1,0),ivec2(0),last),0),f.x),mix(texelFetch(tex,clamp(a+ivec2(0,1),ivec2(0),last),0),texelFetch(tex,clamp(a+ivec2(1),ivec2(0),last),0),f.x),f.y);
        #else
        return texture(tex,uv);
        #endif
      }
    `;
    const glow=`#version 300 es
      precision highp float;in vec2 vUv;out vec4 color;uniform sampler2D uImage;uniform vec2 uPixel;
      ${filter}
      void main(){
        vec3 bloom=vec3(0.);
        for(int i=0;i<8;i++){float a=float(i)*.7853981634;vec2 o=vec2(cos(a),sin(a));bloom+=max(filtered(uImage,vUv+uPixel*o*6.).rgb-.8,0.)*.013+max(filtered(uImage,vUv+uPixel*o*18.).rgb-1.5,0.)*.005;}
        color=vec4(bloom,1.);
      }
    `;
    const accumulate=`#version 300 es
      precision highp float;in vec2 vUv;layout(location=0) out vec4 radiance;layout(location=1) out vec4 stokes;
      uniform sampler2D uImage,uStokes,uPreviousImage,uPreviousStokes;uniform float uWeight;
      void main(){
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        radiance=texelFetch(uImage,pixel,0);stokes=texelFetch(uStokes,pixel,0);
        if(uWeight<1.){radiance=mix(texelFetch(uPreviousImage,pixel,0),radiance,uWeight);stokes=mix(texelFetch(uPreviousStokes,pixel,0),stokes,uWeight);}
      }
    `;
    const display=`#version 300 es
      precision highp float;in vec2 vUv;out vec4 color;
      uniform sampler2D uImage,uStokes,uDiagnostic,uGlow;uniform vec2 uOutput;uniform float uExposure;uniform int uBand,uDisplay;
      ${filter}
      vec3 tone(vec3 c){c=max(c,vec3(0.));return clamp((c*(2.51*c+.03))/(c*(2.43*c+.59)+.14),0.,1.);}
      vec3 falseColor(float value){float t=clamp(value,0.,1.);return mix(mix(vec3(0.),vec3(.72,.045,.004),smoothstep(0.,.48,t)),mix(vec3(1.,.46,.025),vec3(1.,.97,.82),smoothstep(.68,1.,t)),smoothstep(.3,.85,t));}
      void main(){
        vec3 light=filtered(uImage,vUv).rgb,bloom=filtered(uGlow,vUv).rgb;
        vec3 rgb=tone((light+bloom)*uExposure);
        if(uBand!=0)rgb=falseColor(rgb.r);
        if(uDisplay==1){
          vec2 cell=floor(gl_FragCoord.xy/24.),center=(cell+.5)*24.;vec4 s=filtered(uStokes,center/uOutput);
          float degree=length(s.yz)/max(1e-12,s.x),angle=.5*atan(s.z,s.y);
          vec2 d=gl_FragCoord.xy-center,axis=vec2(cos(angle),sin(angle));
          float mark=(1.-smoothstep(.6,1.25,abs(dot(d,vec2(-axis.y,axis.x)))))*(1.-smoothstep(2.+6.*degree,3.+6.*degree,abs(dot(d,axis))));
          mark*=smoothstep(.008,.04,s.x*uExposure)*smoothstep(.01,.05,degree);rgb=mix(rgb,vec3(.92,.97,1.),mark*.85);
        } else if(uDisplay==2){vec4 s=filtered(uStokes,vUv);float v=s.w/max(1e-12,s.x),strength=clamp(abs(v)*20.,0.,1.);rgb=mix(vec3(.12,.15,.18),v>0.?vec3(1.,.46,.12):vec3(.13,.65,.9),strength)*tone(vec3(s.x*uExposure)).r;}
        // Categorical diagnostics must never blend a failed ray into its neighbor.
        else if(uDisplay==3){ivec2 dimensions=textureSize(uDiagnostic,0);vec4 d=texelFetch(uDiagnostic,min(ivec2(vUv*vec2(dimensions)),dimensions-1),0);rgb=d.x==0.?vec3(1.,.1,.8):d.x==4.?vec3(1.,0.,0.):vec3(d.y/600.,d.z*500.,.08);}
        color=vec4(pow(max(rgb,vec3(0.)),vec3(1./2.2)),1.);
      }
    `;
    const resources=[];
    function program(vs,fs){
      const shader=(type,text)=>{const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(error);}return s;};
      const v=shader(gl.VERTEX_SHADER,vs),f=shader(gl.FRAGMENT_SHADER,fs),p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));resources.push(()=>gl.deleteProgram(p));
      const uniforms={};for(let i=0;i<gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);i++){const name=gl.getActiveUniform(p,i).name;uniforms[name.replace(/\[0\]$/,"")]=gl.getUniformLocation(p,name);}return {p,u:uniforms};
    }
    // Compile the gray intensity kernel separately so unused polarization work
    // cannot remain in a runtime branch. GRMHD always uses the full program.
    // A test-only unseeded variant recomputes the same first derivative each
    // step, allowing scientific comparisons without adding a runtime GPU branch.
    const integratedFragment=verification.forceUnseededBS?fragment.replace("stepBSSeeded(x,p,time,energy,uSpin,uCharge,h,rayDx,rayDp,nx,np,nt,error,m,rayDx,rayDp);","stepBS(x,p,time,energy,uSpin,uCharge,h,nx,np,nt,error);seedBS(nx,np,energy,uSpin,uCharge,m,rayDx,rayDp);"):fragment;
    const filteredFragment=source=>floatLinear?source:source.replace("#version 300 es","#version 300 es\n#define MANUAL_IMAGE_FILTER");
    const sampledFragment=floatLinear?integratedFragment:integratedFragment.replace("#version 300 es","#version 300 es\n#define DISK_MANUAL_INTERPOLATION"),traceProgram=program(vertex,sampledFragment),scalarProgram=program(vertex,sampledFragment.replace("#version 300 es","#version 300 es\n#define THERMAL_SCALAR")),displayProgram=program(vertex,filteredFragment(display)),glowProgram=program(vertex,filteredFragment(glow)),accumulateProgram=program(vertex,accumulate);
    const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);resources.push(()=>gl.deleteBuffer(quad));
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    const textures=new Set();
    function texture(width,height,data=null,depth=0){const t=gl.createTexture(),target=depth?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D;gl.bindTexture(target,t);gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,floatLinear?gl.LINEAR:gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,floatLinear?gl.LINEAR:gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(depth)gl.texImage3D(target,0,gl.RGBA32F,width,height,depth,0,gl.RGBA,gl.FLOAT,data);else gl.texImage2D(target,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,data);textures.add(t);metrics.registeredTextures=textures.size;return t;}
    const diskCount=2048,diskTexture=texture(diskCount,1),spectrumTexture=texture(768,1),besselTexture=texture(384,1,P.besselTable());
    const thetaData=new Float32Array(512*4);
    for(let i=0;i<512;i++){const angle=i/511;let lo=0,hi=1;for(let j=0;j<40;j++){const t=(lo+hi)/2;if(t+.7/(2*Math.PI)*Math.sin(2*Math.PI*t)>angle)hi=t;else lo=t;}thetaData[i*4]=(lo+hi)/2;}
    const thetaTexture=texture(512,1,thetaData),empty=texture(1,1,new Float32Array(4),1),emptyFluidFrames={times:new Float32Array([0]),layers:new Int32Array([0]),count:1};
    let fluidTextures=[empty,empty,empty],simulation=null,continuation=null,historyFrameCount=0,fluidLayerCount=1,dynamicFrames=new Map(),fluidFrameCache=null,fluidFrameCacheDirty=true,loading=null,disposed=false,target=null,profile=null,profileKey="",geometryKey="",lastTime=-1,refined=false,refinementDue=false,timer=0,ema=25,frameCounter=0,lastWall=null,budgetScale=1,lastInteractive=false,lastActive=false,renderVersion=0,gpuPollTimer=0;
    let cachedModel=null,modelKey="",cachedCamera=null,cameraKey="",driftStep=1e-4;
    const profileCache=new Map(),spectrumCache=new Map(),gpuJobs=[];
    let glowTarget=null,accumulationTargets=[],accumulationIndex=0,displayKey="",glowKey="",progressiveKey="",progressiveSamples=0;
    let diagnosticRequested=false,diagnosticTimer=0,lastDiagnosticAt=-Infinity,budgetLevel=BUDGET_SCALES.length-1,gpuBudgetMs=null,gpuBudgetAt=0,gpuBudgetSamples=0,budgetSamplesUsed=0,budgetRegime="";
    // Scientific oracles keep their deterministic center ray unless they opt
    // into the separate display-sampling checks. Four symmetric rays have zero
    // mean camera offset; no moving observation event is accumulated.
    const progressiveEnabled=verification.forceProgressive===true||Object.keys(verification).length===0;
    const progressiveLimit=verification.progressiveSamples===1?1:STATIC_JITTER.length;
    Object.assign(metrics,{composites:0,glowBuilds:0,diagnosticReadbacks:0,progressiveSamples:0,progressiveTarget:1,progressiveRaySamples:0,budgetLevel,budgetTimingSource:"pending"});
    metrics.timingSource=gpuTimer?"gpu-query-pending":"cpu-submission";metrics.traceTimingSource=metrics.timingSource;metrics.compositeTimingSource=metrics.timingSource;metrics.endToEndTimingSource="cpu-submission";metrics.timingSamples=[];metrics.renderVersion=0;metrics.diagnosticPending=false;metrics.modelBuilds=0;metrics.profileBuilds=0;metrics.observerBuilds=0;metrics.spectrumBuilds=0;
    // The optional verification argument is local to a test renderer. Product
    // configuration never gains accuracy, camera, emissivity or oracle switches.
    const verificationKey=JSON.stringify(verification);
    function boundedCache(cache,key,value){cache.delete(key);cache.set(key,value);if(cache.size>8)cache.delete(cache.keys().next().value);return value;}
    function invalidateFluidFrameCache(){fluidFrameCacheDirty=true;}
    function sceneModel(){
      const key=[state.scene,state.model,state.spin,state.charge,verificationKey].join(":");
      if(key!==modelKey){
        modelKey=key;cachedModel=A.model(state);metrics.modelBuilds++;
        if(Number.isFinite(verification.outerRadius))cachedModel={...cachedModel,outer:verification.outerRadius,computationalRadius:verification.outerRadius,initialObserverDistance:verification.outerRadius*4,skyRadius:verification.outerRadius*7.5};
        if(Number.isFinite(verification.observerDistance))cachedModel={...cachedModel,initialObserverDistance:verification.observerDistance};
        if(Number.isFinite(verification.skyRadius))cachedModel={...cachedModel,skyRadius:verification.skyRadius};
      }return cachedModel;
    }
    function observer(m){
      const key=[modelKey,state.tilt,state.viewZoom??state.zoom,state.flightRadius,state.observer,state.yaw,state.drift].join(":");
      if(key!==cameraKey){cameraKey=key;cachedCamera=A.camera(state,m);metrics.observerBuilds++;}return cachedCamera;
    }
    function requestSimulation(){
      if(loading)return loading;metrics.dataStatus="loading";onStatus?.("正在载入热流历史与持续求解器。");
      loading=P.loadSimulation().then(data=>{
        if(disposed)return;const {records,metadata}=data,n=records.length/RECORD_COMPONENTS,nextHistoryFrameCount=metadata.times.length,nextFluidLayerCount=nextHistoryFrameCount+MAX_DYNAMIC_SLOTS;
        // Validate the layer budget and record count before publishing the new
        // object; a rejected dataset must never leave render() in GRMHD mode.
        if(nextFluidLayerCount>MAX_FLUID_FRAMES)throw new Error("GRMHD history and cache exceed the shader frame budget");
        if(n!==HISTORY_CELLS*nextHistoryFrameCount)throw new Error("GRMHD history has an unexpected record count");
        simulation=data;historyFrameCount=nextHistoryFrameCount;fluidLayerCount=nextFluidLayerCount;
        metrics.solverTextureBytes=3*HISTORY_WIDTH*HISTORY_WIDTH*fluidLayerCount*RGBA_COMPONENTS*Float32Array.BYTES_PER_ELEMENT;metrics.solverCpuCacheBytes=MAX_DYNAMIC_SLOTS*HISTORY_CELLS*RECORD_COMPONENTS*Float32Array.BYTES_PER_ELEMENT;metrics.solverMemoryBytes=metrics.solverTextureBytes+metrics.solverCpuCacheBytes;
        fluidTextures=Array.from({length:3},(_,field)=>{
          const packed=field===1?P.velocityTexture(records,metadata):new Float32Array(n*RGBA_COMPONENTS);
          if(field!==1)for(let i=0;i<n;i++)packed.set(records.subarray(i*RECORD_COMPONENTS+field*RGBA_COMPONENTS,i*RECORD_COMPONENTS+field*RGBA_COMPONENTS+RGBA_COMPONENTS),i*RGBA_COMPONENTS);
          const layers=new Float32Array(HISTORY_CELLS*fluidLayerCount*RGBA_COMPONENTS);layers.set(packed);
          return texture(HISTORY_WIDTH,HISTORY_WIDTH,layers,fluidLayerCount);
        });
        metrics.dataStatus="ready";metrics.grmhdResolution=metadata.resolution;metrics.grmhdFrames=metadata.times.length;metrics.grmhdSpin=metadata.spin;metrics.historyEndTime=metadata.times[metadata.times.length-1];metrics.latestSimulationTime=metrics.historyEndTime;metrics.solverProgressTime=metrics.historyEndTime;metrics.cacheSlots=MAX_DYNAMIC_SLOTS;
        dynamicFrames.clear();invalidateFluidFrameCache();geometryKey="";
        const factory=globalThis.BlackHoleGrmhdContinuation;
        if(factory){
          const checkpoint=metadata.checkpoint;
          continuation=factory.create({
            historyEndTime:metrics.historyEndTime,
            workerUrl:"./grmhd-worker.js?v=a230423bb1bd",
            wasmUrl:"./solver/grmhd-runtime.wasm?v=595230cc66eb",
            checkpointUrl:"./data/grmhd-torus.checkpoint.bin.gz?v=cca0365c3cb7",
            checkpointSpec:{sha256:checkpoint?.sha256,time:checkpoint?.time,stateCount:checkpoint?.stateCount,boundaryRows:checkpoint?.boundaryRows,boundaryWidth:checkpoint?.boundaryWidth,cells:metadata.resolution?.[0]*metadata.resolution?.[1],components:metadata.components?.length},
            onReady:info=>{metrics.continuationStatus="ready";metrics.solverProgressTime=Math.max(metrics.solverProgressTime,info.time);metrics.solverDiagnosticNames=info.diagnosticNames||[];onStatus?.("热流检查点已恢复；播放会在后台分批推进。");onNeedsFrame();},
            onProgress:info=>{metrics.continuationStatus=info.status;metrics.solverProgressTime=Math.max(metrics.solverProgressTime,info.latestTime||info.simulationTime||metrics.solverProgressTime);metrics.solverStepRate=info.stepRate||0;metrics.pendingSnapshots=info.pendingSnapshots||0;onNeedsFrame();},
            onSnapshot:entry=>{if(!uploadDynamicSnapshot(entry))return;metrics.solverDiagnostics=entry.diagnostics;metrics.latestSimulationTime=Math.max(metrics.latestSimulationTime,entry.time);onNeedsFrame();},
            onError:error=>{metrics.continuationStatus=error.kind==="load"?"unavailable":"failed";metrics.continuationError=error.message;metrics.continuationFallback=true;onStatus?.(error.kind==="load"?"持续求解器未能加载，已回退到有限片段播放。":"持续求解器停止，保留最后有效画面并回退到有限片段。");onNeedsFrame();}
          });
          metrics.continuationStatus="loading";
          continuation.start();
        } else {
          metrics.continuationStatus="unavailable";metrics.continuationFallback=true;onStatus?.("当前浏览器不支持持续求解，已回退到有限片段播放。");
        }
        onStatus?.("热流历史已载入；播放可继续生成 t>800 的状态。");onNeedsFrame();
      }).catch(error=>{loading=null;if(disposed)return;simulation=null;fluidTextures=[empty,empty,empty];historyFrameCount=0;fluidLayerCount=1;dynamicFrames.clear();invalidateFluidFrameCache();metrics.dataStatus="error";metrics.continuationStatus="unavailable";onStatus?.("热流历史未能载入，请选择热盘场景或刷新重试。");console.error("GRMHD history unavailable",error);onNeedsFrame();});return loading;
    }
    function upload(t,width,data){gl.bindTexture(gl.TEXTURE_2D,t);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,width,1,gl.RGBA,gl.FLOAT,data);}
    function uploadLayer(t,layer,data){gl.bindTexture(gl.TEXTURE_2D_ARRAY,t);gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,layer,HISTORY_WIDTH,HISTORY_WIDTH,1,gl.RGBA,gl.FLOAT,data);}
    function uploadDynamicSnapshot(entry){
      if(!simulation||entry.records.length!==HISTORY_CELLS*RECORD_COMPONENTS)return false;
      const layer=historyFrameCount+(entry.slot%MAX_DYNAMIC_SLOTS),records=entry.records,fluid=new Float32Array(HISTORY_CELLS*RGBA_COMPONENTS),velocity=P.velocityTexture(records,simulation.metadata),magnetic=new Float32Array(HISTORY_CELLS*RGBA_COMPONENTS);
      // Worker snapshots stay interleaved by cell; gather each RGBA field just
      // as the historical upload does instead of slicing the first 4096 cells.
      for(let i=0;i<HISTORY_CELLS;i++){const offset=i*RECORD_COMPONENTS;fluid.set(records.subarray(offset,offset+RGBA_COMPONENTS),i*RGBA_COMPONENTS);magnetic.set(records.subarray(offset+2*RGBA_COMPONENTS,offset+3*RGBA_COMPONENTS),i*RGBA_COMPONENTS);}
      uploadLayer(fluidTextures[0],layer,fluid);uploadLayer(fluidTextures[1],layer,velocity);uploadLayer(fluidTextures[2],layer,magnetic);
      dynamicFrames.set(entry.slot%MAX_DYNAMIC_SLOTS,{...entry,layer});if(dynamicFrames.size>MAX_DYNAMIC_SLOTS)dynamicFrames.delete(dynamicFrames.keys().next().value);invalidateFluidFrameCache();geometryKey="";return true;
    }
    function sampler(p,name,unit,t,array=false){if(p.u[name]===undefined)return;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(array?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D,t);gl.uniform1i(p.u[name],unit);}
    function deleteTarget(buffer){
      if(!buffer)return;
      // Rebuilding a render target also unregisters its textures, avoiding stale
      // entries and duplicate deletion when quality or output size changes.
      buffer.images.forEach(t=>{gl.deleteTexture(t);textures.delete(t);});gl.deleteFramebuffer(buffer.fbo);metrics.registeredTextures=textures.size;
    }
    function discardTarget(){
      deleteTarget(target);target=null;accumulationTargets.forEach(deleteTarget);accumulationTargets=[];progressiveSamples=0;progressiveKey="";
    }
    function createTarget(width,height,count){
      const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      const images=Array.from({length:count},(_,i)=>{const t=texture(width,height);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,t,0);return t;});gl.drawBuffers(images.map((_,i)=>gl.COLOR_ATTACHMENT0+i));
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){deleteTarget({fbo,images});throw new Error("Physical render framebuffer incomplete");}
      return {fbo,images,width,height};
    }
    function ensureTarget(width,height){
      if(target?.width===width&&target?.height===height)return;discardTarget();target=createTarget(width,height,3);
    }
    function accumulateSample(){
      if(!accumulationTargets.length)accumulationTargets=[createTarget(target.width,target.height,2),createTarget(target.width,target.height,2)];
      const previous=accumulationTargets[accumulationIndex];accumulationIndex=1-accumulationIndex;const next=accumulationTargets[accumulationIndex],p=accumulateProgram;
      // Explicit ping-pong averaging does not require EXT_float_blend and never
      // samples a texture attached to the framebuffer currently being written.
      gl.bindFramebuffer(gl.FRAMEBUFFER,next.fbo);gl.viewport(0,0,target.width,target.height);gl.useProgram(p.p);
      sampler(p,"uImage",0,target.images[0]);sampler(p,"uStokes",1,target.images[1]);sampler(p,"uPreviousImage",2,previous.images[0]);sampler(p,"uPreviousStokes",3,previous.images[1]);
      gl.uniform1f(p.u.uWeight,1/(progressiveSamples+1));gl.drawArrays(gl.TRIANGLES,0,6);
    }
    function displayImages(){return progressiveSamples>0&&metrics.progressiveTarget>1?accumulationTargets[accumulationIndex].images:target.images;}
    function updateGlow(size,images){
      const key=[renderVersion,size.width,size.height].join(":");if(key===glowKey)return;
      const scale=Math.min(.25,640/Math.max(size.width,size.height)),width=Math.max(1,Math.ceil(size.width*scale)),height=Math.max(1,Math.ceil(size.height*scale));
      if(glowTarget?.width!==width||glowTarget?.height!==height){deleteTarget(glowTarget);glowTarget=createTarget(width,height,1);}
      const p=glowProgram,started=performance.now();gl.bindFramebuffer(gl.FRAMEBUFFER,glowTarget.fbo);gl.viewport(0,0,width,height);gl.useProgram(p.p);
      sampler(p,"uImage",0,images[0]);gl.uniform2f(p.u.uPixel,1/size.width,1/size.height);
      const query=startTiming();gl.drawArrays(gl.TRIANGLES,0,6);finishTiming(query,"glow",performance.now()-started);glowKey=key;metrics.glowBuilds++;
    }
    function updateProfile(m){
      const key=[state.scene,m.spin,m.charge,m.outer,state.band,verification.spectrumReferenceTemperature].join(":");if(key===profileKey)return;profileKey=key;
      const diskKey=[state.scene,m.spin,m.charge,m.outer,m.massRate].join(":");let disk=profileCache.get(diskKey);
      if(!disk){disk=m.flow==="vacuum"?{data:new Float32Array(diskCount*4),count:diskCount,constants:R.inflowConstants(m.spin,m.charge),inner:m.horizon*1.0001,outer:m.outer,peakTemperature:25000}:A.diskProfile(m,diskCount);boundedCache(profileCache,diskKey,disk);metrics.profileBuilds++;}
      upload(diskTexture,diskCount,disk.data);
      const temperature=verification.spectrumReferenceTemperature??(m.flow==="grmhd"?1e11:disk.peakTemperature),spectrumKey=[state.band,temperature].join(":");let spectrum=spectrumCache.get(spectrumKey);
      if(!spectrum){spectrum=A.spectralTable(state.band,temperature);boundedCache(spectrumCache,spectrumKey,spectrum);metrics.spectrumBuilds++;}
      upload(spectrumTexture,768,spectrum.data);profile={...disk,reference:spectrum.reference*(m.flow==="grmhd"?1e3*.02:1)};
      if(m.flow==="grmhd")requestSimulation();
    }
    function timing(kind,ms,source,version,frame){
      // Completion polling can observe several frames together; an older
      // completion must not overwrite the newest displayed timing.
      if(frame>=(metrics[kind+"TimingFrame"]??-1)){metrics[kind+"Ms"]=ms;metrics[kind+"TimingSource"]=source;metrics[kind+"TimingFrame"]=frame;}
      if(kind==="trace"||kind==="composite")metrics.timingSource=metrics.traceTimingSource===metrics.compositeTimingSource?metrics.traceTimingSource:"mixed";
      metrics.timingSamples.push({kind,ms,source,version,frame});if(metrics.timingSamples.length>240)metrics.timingSamples.splice(0,metrics.timingSamples.length-240);
    }
    function deleteJob(job){if(job.query)gl.deleteQuery(job.query);if(job.fence)gl.deleteSync(job.fence);if(job.buffer)gl.deleteBuffer(job.buffer);}
    function diagnosticMetrics(data,version,time,frame=frameCounter){
      let unfinished=0,invalid=0;for(let i=0;i<data.length;i+=4){if(data[i]===0)unfinished++;if(data[i]===4)invalid++;}
      if(frame<(metrics.diagnosticFrame??-1))return;
      metrics.unfinishedRays=unfinished;metrics.invalidRays=invalid;// Keep the original diagnostic frame/time fields beside the buffer version.
      metrics.diagnosticFrame=frame;metrics.diagnosticVersion=version;metrics.diagnosticTime=time;metrics.diagnosticCurrent=version===renderVersion;
    }
    function pollGpuJobs(){
      gpuPollTimer=0;if(disposed)return;const now=performance.now(),disjoint=gpuTimer&&gl.getParameter(gpuTimer.GPU_DISJOINT_EXT);let diagnosticFinished=false;
      // A disjoint event invalidates the controller's previous GPU estimate as
      // well as new queries. Recover via the named wall-time fallback meanwhile.
      if(disjoint){gpuBudgetMs=null;gpuBudgetSamples=0;budgetSamplesUsed=0;}
      for(let i=gpuJobs.length-1;i>=0;i--){
        const job=gpuJobs[i],stale=job.version!==renderVersion;let ready;
        // Old timing queries remain useful under GPU backlog. Only image
        // diagnostics are version-specific; wait for their fence before reuse.
        if(job.query)ready=disjoint||gl.getQueryParameter(job.query,gl.QUERY_RESULT_AVAILABLE);
        else {const status=gl.clientWaitSync(job.fence,0,0);ready=status!==gl.TIMEOUT_EXPIRED;if(status===gl.WAIT_FAILED)job.failed=true;}
        if(!ready)continue;
        // Every asynchronous result belongs to exactly one float-buffer render.
        // A camera/physics/quality change makes all older diagnostics obsolete.
        if(!job.failed){
          if(job.query){
            const ms=disjoint?job.cpu:gl.getQueryParameter(job.query,gl.QUERY_RESULT)/1e6;timing(job.kind,ms,disjoint?"cpu-submission-disjoint":"gpu-query",job.version,job.frame);
            if(!disjoint&&job.kind==="trace"&&job.interactive&&job.regime===budgetRegime&&job.frame>=frameCounter-60){
              const perRay=ms/job.rays;gpuBudgetMs=gpuBudgetMs===null?perRay:.8*gpuBudgetMs+.2*perRay;gpuBudgetSamples++;gpuBudgetAt=now;
            }
          }else if(job.kind==="diagnostic"){
            // Moving frames may finish after the observation advances. Publish
            // their provenance with diagnosticCurrent=false rather than starving
            // slow devices of every sampled diagnostic; settling still reads exactly.
            const data=new Float32Array(job.length);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,job.buffer);gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,data);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);diagnosticMetrics(data,job.version,job.time,job.frame);
          }else if(!stale&&job.kind==="endToEnd")timing("endToEnd",now-job.start,"gpu-fence-wall-upper-bound",job.version,job.frame);
        }
        if(job.kind==="diagnostic")diagnosticFinished=true;
        deleteJob(job);gpuJobs.splice(i,1);
      }
      metrics.diagnosticPending=gpuJobs.some(job=>job.kind==="diagnostic"&&job.version===renderVersion);
      if(diagnosticFinished&&diagnosticRequested&&!document.hidden)onNeedsFrame();
      if(gpuJobs.length)gpuPollTimer=setTimeout(pollGpuJobs,8);
    }
    function enqueueJob(job){
      gpuJobs.push(job);if(gpuJobs.length>24){
        // Retain the single diagnostic PBO until its fence completes. Timing
        // history is bounded independently so backlog cannot multiply readbacks.
        let index=gpuJobs.findIndex(entry=>entry.kind!=="diagnostic"&&entry.kind!=="trace");
        if(index<0)index=gpuJobs.findIndex(entry=>entry.kind!=="diagnostic");
        const old=gpuJobs.splice(index,1)[0];deleteJob(old);
      }if(!gpuPollTimer)gpuPollTimer=setTimeout(pollGpuJobs,8);
    }
    function startTiming(){if(!gpuTimer)return null;const query=gl.createQuery();gl.beginQuery(gpuTimer.TIME_ELAPSED_EXT,query);return query;}
    function finishTiming(query,kind,cpu,work={}){
      if(query){gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);enqueueJob({query,kind,cpu,version:renderVersion,frame:frameCounter,...work});}
      else timing(kind,cpu,"cpu-submission",renderVersion,frameCounter);
    }
    function queueDiagnostic(force=false){
      if(verification.disableTimers||!diagnosticRequested||disposed||document.hidden||!target)return;
      // At most one full PBO readback is in flight. Keep the newest request, not
      // a queue of obsolete frames, and obtain exact counts after settling.
      if(gpuJobs.some(job=>job.kind==="diagnostic"))return;
      const wait=DIAGNOSTIC_INTERVAL-(performance.now()-lastDiagnosticAt);
      if(!force&&wait>0){if(!diagnosticTimer)diagnosticTimer=setTimeout(()=>{diagnosticTimer=0;onNeedsFrame();},wait);return;}
      clearTimeout(diagnosticTimer);diagnosticTimer=0;diagnosticRequested=false;lastDiagnosticAt=performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);
      const length=target.width*target.height*4,buffer=gl.createBuffer();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,buffer);gl.bufferData(gl.PIXEL_PACK_BUFFER,length*4,gl.STREAM_READ);
      gl.readBuffer(gl.COLOR_ATTACHMENT2);gl.readPixels(0,0,target.width,target.height,gl.RGBA,gl.FLOAT,0);gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
      const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);enqueueJob({kind:"diagnostic",buffer,fence,length,version:renderVersion,time:state.time,frame:frameCounter});gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.flush();metrics.diagnosticPending=true;metrics.diagnosticReadbacks++;
    }
    function adaptBudget(active,duration,regime){
      if(!active||Number.isFinite(verification.rayBudget))return;
      if(regime!==budgetRegime){budgetRegime=regime;gpuBudgetMs=null;gpuBudgetSamples=0;budgetSamplesUsed=0;}
      if(gpuTimer&&gpuBudgetMs!==null&&performance.now()-gpuBudgetAt<1000){
        ema=gpuBudgetMs*Math.max(1,metrics.raySamples)+(metrics.compositeMs||0)+(metrics.glowMs||0);metrics.budgetTimingSource="gpu-query";
        if(gpuBudgetSamples-budgetSamplesUsed<3)return;budgetSamplesUsed=gpuBudgetSamples;
      }else{
        // Without a valid GPU timer, elapsed frame time is an explicitly named
        // scheduling fallback, never advertised as measured shader execution.
        if(!(duration>0&&duration<1000))return;ema=.9*ema+.1*duration;metrics.budgetTimingSource="frame-wall";
        if(frameCounter%12!==0)return;
      }
      if(ema>36&&budgetLevel>0)budgetLevel--;
      else if(ema<24&&budgetLevel<BUDGET_SCALES.length-1)budgetLevel++;
      budgetScale=BUDGET_SCALES[budgetLevel];metrics.budgetLevel=budgetLevel;
    }
    function fluidFrameUniforms(){
      if(!simulation)return emptyFluidFrames;
      if(!fluidFrameCacheDirty&&fluidFrameCache)return fluidFrameCache;
      const dynamic=Array.from(dynamicFrames.values()).sort((a,b)=>a.time-b.time);
      // Once the circular cache has moved past a gap, retaining the old 0–800
      // history would make the shader interpolate across missing physical time.
      // Dropping that history makes the gap explicit: out-of-window emission is
      // zero and the UI reports a history-missing diagnostic.
      const keepHistory=!dynamic.length||dynamic[0].time<=metrics.historyEndTime+20.0001;
      const frames=[];
      if(keepHistory)for(let i=0;i<historyFrameCount;i++)frames.push({time:simulation.metadata.times[i],layer:i});
      for(const entry of dynamic)frames.push({time:entry.time,layer:entry.layer});
      frames.sort((a,b)=>a.time-b.time);
      const count=Math.min(MAX_FLUID_FRAMES,frames.length),times=new Float32Array(MAX_FLUID_FRAMES),layers=new Int32Array(MAX_FLUID_FRAMES);
      for(let i=0;i<count;i++){times[i]=frames[i].time;layers[i]=frames[i].layer;}
      metrics.historyMissing=Boolean(dynamic.length&&!keepHistory);
      fluidFrameCache={times,layers,count};fluidFrameCacheDirty=false;return fluidFrameCache;
    }
    function render(size,quality,jitter=[0,0]){
      const started=performance.now(),m=sceneModel(),camera=observer(m);updateProfile(m);
      const requested=state.density||160000,budget=verification.rayBudget??Math.min(quality?requested*2:Math.max(16000,requested*budgetScale),quality?650000:240000,size.width*size.height);
      const aspect=size.width/size.height,height=Math.max(32,Math.floor(Math.sqrt(budget/aspect))),width=Math.max(32,Math.floor(height*aspect));ensureTarget(width,height);renderVersion++;metrics.renderVersion=renderVersion;metrics.diagnosticCurrent=false;
      const scalar=m.flow==="thermal"&&state.display==="intensity"&&!verification.forceFullThermal,p=scalar?scalarProgram:traceProgram,u=p.u;
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,width,height);gl.useProgram(p.p);
      gl.uniform3fv(u.uOrigin,camera.position);gl.uniform4fv(u.uObserver,camera.u);gl.uniform4fv(u.uRight,camera.basis[0]);gl.uniform4fv(u.uUp,camera.basis[1]);gl.uniform4fv(u.uForward,camera.basis[2]);
      const lens=(Number.isFinite(state.flightLens)?Math.min(size.width,size.height)*.028*state.flightLens/camera.r:size.scale)*(camera.framingScale??1);
      // One output pixel spans 1/(lens*r) radians of view, so this converts the
      // drift's screen-space tolerance into an azimuth quantum. A fixed angle
      // instead would lurch by a large fraction of the viewport at wide framing.
      driftStep=DRIFT_RETRACE_PIXELS*(size.dpr||1)/(lens*Math.max(1e-6,camera.r));
      gl.uniform2f(u.uExtent,size.width/lens,size.height/lens);gl.uniform2f(u.uConstants,profile.constants.energy,profile.constants.angularMomentum);
      gl.uniform2f(u.uJitter,jitter[0]/width,jitter[1]/height);
      // The observation event's KS time shifts the retarded fluid time.  The
      // renderer never extrapolates beyond the newest complete solver snapshot.
      const observationTime=350+state.time*8+camera.coordinateTime,availableTime=metrics.latestSimulationTime??metrics.historyEndTime,simulationTime=m.flow==="grmhd"?Math.min(observationTime,availableTime):observationTime,rhoUnit=simulation?m.massRate/(simulation.metadata.accretionRateCode*m.rg*m.rg*A.constants.c)*.001:0;
      const values={uDistance:camera.r,uSpin:m.spin,uCharge:m.charge,uHorizon:m.horizon,uIsco:m.isco,uInner:profile.inner,uOuter:m.outer,uTime:simulationTime,uRg:m.rg*100,uDensityUnit:rhoUnit,uSpectrumReference:profile.reference,uTolerance:verification.tolerance??(quality?4e-5:1.5e-4),uChart:camera.chart,uRadialSpeed:profile.constants.radialSpeed,uElectronRatio:m.electronRatio||40,uMediumStep:verification.mediumStep??(quality?.45:1),uDiskCount:diskCount,uDiskSplit:profile.iscoIndex??0,uSkyRadius:m.skyRadius??150,uEmissionScale:verification.emissionEnabled===false?0:1,uFarStep:verification.farStep??.22,uInitialStep:verification.initialStep??(m.flow==="thermal"&&camera.r>m.outer?Math.max(.8,.1*(camera.r-m.outer)):.8)};
      for(const [name,value] of Object.entries(values))if(u[name]!=null)gl.uniform1f(u[name],value);
      gl.uniform1i(u.uFlow,m.flow==="vacuum"?0:m.flow==="grmhd"?(simulation?2:0):1);
      gl.uniform1i(u.uBand,["visible","xray","radio","bolometric"].indexOf(state.band));if(u.uPolarization!=null)gl.uniform1i(u.uPolarization,m.flow==="grmhd"||state.display!=="intensity"?1:0);
      gl.uniform1i(u.uMaxSteps,verification.maxSteps??(quality?2048:1200));gl.uniform1i(u.uHotspot,state.scene==="hotspot"?1:0);gl.uniform1i(u.uSkyEnabled,verification.skyEnabled===false?0:1);
      if(u.uTimes!=null){const frames=fluidFrameUniforms();if(simulation)gl.uniform2f(u.uGrid,simulation.metadata.radialStart,simulation.metadata.radialStep);else{frames.times[0]=0;frames.layers[0]=0;gl.uniform2f(u.uGrid,0,1);}gl.uniform1fv(u.uTimes,frames.times);if(u.uLayers)gl.uniform1iv(u.uLayers,frames.layers);gl.uniform1i(u.uFrameCount,frames.count);}
      sampler(p,"uDisk",0,diskTexture);sampler(p,"uSpectrum",1,spectrumTexture);sampler(p,"uBessel",2,besselTexture);sampler(p,"uTheta",3,thetaTexture);["uFluid","uVelocity","uMagnetic"].forEach((name,i)=>sampler(p,name,4+i,fluidTextures[i],true));
      const query=startTiming();gl.drawArrays(gl.TRIANGLES,0,6);finishTiming(query,"trace",performance.now()-started,{interactive:!quality,regime:state.scene+":"+scalar,rays:width*height});
      metrics.geodesicBuilds++;metrics.traceWidth=width;metrics.traceHeight=height;metrics.raySamples=width*height;metrics.traceQuality=quality?"refined":"interactive";metrics.transferMode=scalar?"scalar-intensity":"full-stokes";metrics.geodesicStepper=verification.forceUnseededBS?"bs32-unseeded":"bs32-fsal";
      metrics.observerDistance=camera.r;metrics.initialObserverDistance=m.initialObserverDistance??80;metrics.computationalRadius=m.outer;metrics.skyRadius=m.skyRadius??150;metrics.observerKind=state.observer;metrics.horizonFade=0;metrics.fluid=m.flow;metrics.observationTime=m.flow==="grmhd"?observationTime:null;metrics.simulationTime=m.flow==="grmhd"?simulationTime:null;metrics.waitingForData=m.flow==="grmhd"&&observationTime>availableTime+1e-6;metrics.movieEnded=m.flow==="grmhd"&&(metrics.continuationStatus==="unavailable"||metrics.continuationStatus==="failed")&&observationTime>=availableTime;metrics.cameraProperTime=camera.properTime;
      // Production readback is PBO/fence based; tests use readback() below to
      // obtain all channels synchronously and update exact status counts.
      diagnosticRequested=true;
    }
    function draw(size,seconds=0){
      if(disposed||document.hidden)return;frameCounter++;const started=performance.now(),duration=lastWall===null?0:started-lastWall;lastWall=started;
      const currentModel=sceneModel();
      if(currentModel.flow==="grmhd"&&simulation&&continuation){
        const solverActive=!state.paused&&!document.hidden;
        continuation.setActive(solverActive);
        if(solverActive){const eventTime=350+state.time*8+observer(currentModel).coordinateTime;continuation.advanceTo(eventTime+40);}
      } else continuation?.setActive(false);
      // Idle drift advances the camera azimuth continuously, so the retrace gate
      // quantizes it to driftStep (about DRIFT_RETRACE_PIXELS output pixels) rather
      // than to a fixed angle. View changes coarser than that still retrace exactly.
      const azimuth=Math.round((state.yaw+(state.drift||0))/Math.max(1e-9,driftStep)),key=[state.scene,state.model,state.spin,state.charge,state.tilt,state.viewZoom,state.flightRadius,state.flightLens,azimuth,state.band,state.observer,state.display,state.density,size.width,size.height,size.scale].join(":");
      const evolving=A.scenes[state.scene]?.flow==="grmhd"||state.scene==="hotspot",changed=key!==geometryKey,active=Boolean(state.interacting||(evolving&&!state.paused));
      if(changed){geometryKey=key;refinementDue=Boolean(state.paused&&!state.interacting);clearTimeout(timer);if(!active&&!state.paused)timer=setTimeout(()=>{refinementDue=true;onNeedsFrame();},180);}
      // Settling a drag, pausing playback and switching the budget can change
      // required quality without changing camera geometry. Compare quality to
      // the quality actually rendered, never an anticipated refinement flag.
      if((lastInteractive&&!state.interacting)||(lastActive&&!active))refinementDue=true;
      lastInteractive=Boolean(state.interacting);lastActive=active;
      adaptBudget(active,duration,state.scene+":"+(currentModel.flow==="thermal"&&state.display==="intensity"&&!verification.forceFullThermal));
      const quality=Boolean(!state.interacting&&(state.paused||(!active&&refinementDue)));
      const goal=progressiveEnabled&&quality&&state.paused&&!state.interacting&&state.display!=="accuracy"?progressiveLimit:1;
      const sampleKey=[key,quality,goal,evolving?state.time:0,!quality&&!Number.isFinite(verification.rayBudget)?budgetLevel:0].join(":");
      const retrace=changed||(evolving&&lastTime!==state.time)||quality!==refined||!target||sampleKey!==progressiveKey;
      if(retrace){
        progressiveSamples=0;metrics.progressiveRaySamples=0;
        render(size,quality,goal>1?STATIC_JITTER[0]:(verification.sampleJitter||[0,0]));
        progressiveKey=sampleKey;metrics.progressiveTarget=goal;
        if(goal>1)accumulateSample();progressiveSamples=1;
        lastTime=state.time;refined=quality;
      }else if(goal>1&&progressiveSamples<goal){
        render(size,quality,STATIC_JITTER[progressiveSamples]);accumulateSample();progressiveSamples++;
      }
      metrics.progressiveSamples=progressiveSamples;metrics.progressiveRaySamples=progressiveSamples*metrics.raySamples;
      if(goal>1&&progressiveSamples<goal)onNeedsFrame();
      // Finish static sampling before reading diagnostics. Active playback reads
      // at a bounded cadence; its counters always retain the originating version.
      if(goal===1||progressiveSamples===goal)queueDiagnostic(quality);
      const nextDisplayKey=[renderVersion,state.exposure,state.band,state.display,size.width,size.height].join(":");
      metrics.frameMs=ema;metrics.budgetScale=budgetScale;
      if(nextDisplayKey===displayKey)return;
      const images=displayImages();updateGlow(size,images);
      const compositeStarted=performance.now();gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,size.width,size.height);gl.useProgram(displayProgram.p);
      sampler(displayProgram,"uImage",0,images[0]);sampler(displayProgram,"uStokes",1,images[1]);sampler(displayProgram,"uDiagnostic",2,target.images[2]);sampler(displayProgram,"uGlow",3,glowTarget.images[0]);
      const displayGain=A.scenes[state.scene]?.displayGain||1;
      // Exposure only composites existing float buffers and never rebuilds the
      // model, disk/spectrum table, observer or geodesics.
      gl.uniform2f(displayProgram.u.uOutput,size.width,size.height);gl.uniform1f(displayProgram.u.uExposure,(state.exposure||1)*displayGain);
      gl.uniform1i(displayProgram.u.uBand,["visible","xray","radio","bolometric"].indexOf(state.band));gl.uniform1i(displayProgram.u.uDisplay,["intensity","linear","circular","accuracy"].indexOf(state.display));const query=startTiming();gl.drawArrays(gl.TRIANGLES,0,6);finishTiming(query,"composite",performance.now()-compositeStarted);
      if(!verification.disableTimers){const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);enqueueJob({kind:"endToEnd",fence,start:started,version:renderVersion,frame:frameCounter});gl.flush();}else timing("endToEnd",performance.now()-started,"cpu-submission",renderVersion,frameCounter);
      displayKey=nextDisplayKey;metrics.displayGain=displayGain;metrics.radianceReference=profile.reference;metrics.frames++;metrics.composites++;
    }
    function resetSimulation(){
      dynamicFrames.clear();invalidateFluidFrameCache();geometryKey="";metrics.latestSimulationTime=metrics.historyEndTime;metrics.solverProgressTime=metrics.historyEndTime;metrics.observationTime=null;metrics.simulationTime=null;metrics.historyMissing=false;metrics.waitingForData=false;
      continuation?.reset();onNeedsFrame();
    }
    function setSolverActive(value){continuation?.setActive(Boolean(value));}
    function dispose(){if(disposed)return;disposed=true;clearTimeout(timer);clearTimeout(gpuPollTimer);clearTimeout(diagnosticTimer);continuation?.destroy();gpuJobs.forEach(deleteJob);gpuJobs.length=0;discardTarget();deleteTarget(glowTarget);glowTarget=null;textures.forEach(t=>gl.deleteTexture(t));textures.clear();metrics.registeredTextures=0;resources.reverse().forEach(f=>f());}
    return {kind:"webgl",physical:true,metrics,count:()=>metrics.raySamples,draw,resetSimulation,setSolverActive,refine(){refinementDue=true;onNeedsFrame();},dispose,
      // Full synchronous test readback intentionally waits for GPU completion;
      // production diagnostics above never issue a blocking typed-array read.
      // Raw readback remains a single-ray scientific oracle. Display readback
      // optionally returns linear averaged Stokes/radiance, with unaveraged
      // diagnostic codes from the latest completed sample in either case.
      readback({display=false}={}){if(!target)return null;gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);const accumulated=display&&metrics.progressiveTarget>1&&progressiveSamples>0;
        const outputs=target.images.map((_,i)=>{const source=accumulated&&i<2?accumulationTargets[accumulationIndex]:target;gl.bindFramebuffer(gl.FRAMEBUFFER,source.fbo);const data=new Float32Array(target.width*target.height*4);gl.readBuffer(gl.COLOR_ATTACHMENT0+i);gl.readPixels(0,0,target.width,target.height,gl.RGBA,gl.FLOAT,data);return data;});gl.bindFramebuffer(gl.FRAMEBUFFER,null);diagnosticMetrics(outputs[2],renderVersion,state.time);return {width:target.width,height:target.height,renderVersion,samples:accumulated?progressiveSamples:1,radiance:outputs[0],stokes:outputs[1],diagnostic:outputs[2]};}};
  }
  globalThis.BlackHolePhysicalRenderer=Object.freeze({create});
})();
