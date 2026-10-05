"use strict";

(() => {
  const c=2.99792458e10,e=4.80320471257e-10,me=9.1093837139e-28;
  const dataBase=typeof document!=="undefined"&&document.currentScript?.src?new URL("./data/",document.currentScript.src).href:"./data/";
  const identity=()=>Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>Number(i===j)));
  const multiply=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0)));
  function besselK(order,x) {
    // Integral representation of K_n(x); no small-temperature asymptote is
    // silently substituted into the Faraday coefficients.
    const upper=Math.acosh(1+45/x),n=256,h=upper/n;
    const f=t=>Math.exp(-x*Math.cosh(t))*Math.cosh(order*t);
    let sum=f(0)+f(upper);for(let i=1;i<n;i++)sum+=(i%2?4:2)*f(i*h);return sum*h/3;
  }
  function besselTable(count=384) {
    const data=new Float32Array(count*4);
    for(let i=0;i<count;i++){const theta=10**(-1.3+5.3*i/(count-1)),x=1/theta;data.set([besselK(0,x),besselK(1,x),besselK(2,x),theta],i*4);}return data;
  }
  function velocityTexture(records,metadata) {
    const n=records.length/12,data=new Float32Array(n*4),a=metadata.spin;
    for(let i=0;i<n;i++){
      const cell=i%4096,radial=Math.floor(cell/64),polar=cell%64,r=Math.exp(metadata.radialStart+(radial+.5)*metadata.radialStep),x=(polar+.5)/64;
      const theta=Math.PI*x+.35*Math.sin(2*Math.PI*x),st=Math.sin(theta),ct=Math.cos(theta),f=2*r/(r*r+a*a*ct*ct),root=Math.sqrt(1+f),at=i*12;
      const ut=records[at+4],ur=records[at+5],uth=records[at+6],uph=records[at+7],gamma=ut/root;
      const spatial=[ur*st+uth*r*ct-uph*a*st,uth*a*ct+uph*r*st,ur*ct-uth*r*st];
      const v=[spatial[0]/gamma+f*st/root,spatial[1]/gamma,spatial[2]/gamma+f*ct/root],along=v[0]*st+v[2]*ct;
      // Interpolate bounded Eulerian orthonormal 3-velocities, not four-vectors
      // belonging to different metric points. Convex interpolation preserves
      // subluminality even across fast, strongly curved GRMHD cells.
      data.set([v[0]+(root-1)*st*along,v[1],v[2]+(root-1)*ct*along,gamma],i*4);
    }
    return data;
  }
  function thermalCoefficients(n,b,theta,frequency,cosPitch) {
    if(n<=0||b<=0)return {j:[0,0,0,0],alpha:[0,0,0,0],rho:[0,0,0]};
    const sin=Math.sqrt(Math.max(1e-12,1-cosPitch*cosPitch)),nuB=e*b/(2*Math.PI*me*c),thetaSafe=Math.max(.051,theta);
    const k0=besselK(0,1/thetaSafe),k1=besselK(1,1/thetaSafe),k2=besselK(2,1/thetaSafe);
    const x=Math.max(1e-15,frequency/(1.5*nuB*thetaSafe**2*sin)),v=Math.cbrt(x),exp=Math.exp(-1.8899*v);
    // Dexter (2016), equations 93–101, 136, 145–147. The emissivity
    // fits retain their stated ultrarelativistic-domain limitations.
    const common=n*e*e*frequency/(Math.sqrt(3)*c*k2);
    const ii=2.5651*(1+1.92/v+.9977/(v*v))*exp,iq=2.5651*(1+.932/v+.4998/(v*v))*exp;
    const iv=(1.8138/x+3.423/(v*v)+.02955/Math.sqrt(x)+2.0377/v)*exp;
    const j=theta<.05?[0,0,0,0]:[common*ii,common*iq,0,common*4*cosPitch/(3*sin*thetaSafe)*iv];
    const h=6.62607015e-27,k=1.380649e-16,xx=h*frequency/(k*thetaSafe*5.92989658e9);
    const blackbody=2*h*frequency**3/(c*c*Math.expm1(xx));
    const alpha=j.map(v=>v/Math.max(1e-300,blackbody));
    const X=Math.sqrt(2*Math.sqrt(2)/3*1000/x);
    let fm=2.011*Math.exp(-(X**1.035)/4.7)-Math.cos(X/2)*Math.exp(-Math.sqrt(X)/2.73)-.011*Math.exp(-X/47.2);
    // Match the GPU weak-field limit without multiplying an inverse-power
    // infinity by a blend that has rounded to zero.
    const blend=.5*(1+Math.tanh(10*Math.log(Math.max(X,1e-300)/120)));
    if(blend>0)fm+=(.011*Math.exp(-X/47.2)-2**(-1/3)/3**(23/6)*1e4*Math.PI*X**(-8/3))*blend;
    const rq=n*e*e*nuB**2*sin*sin/(me*c*frequency**3)*fm*(k1/k2+6*thetaSafe);
    const rv=2*n*e*e*nuB*cosPitch/(me*c*frequency**2)*(k0-.4379*Math.log(1+.001858*X**1.503))/k2;
    return {j,alpha,rho:[rq,0,rv]};
  }
  function attenuation(alpha,polar,rho,distance) {
    // Work in optical depths so very small cgs coefficients do not underflow
    // when their powers appear in the matrix polynomial.
    alpha*=distance;polar=polar.map(x=>x*distance);rho=rho.map(x=>x*distance);distance=1;
    const [aq,au,av]=polar,[rq,ru,rv]=rho;
    // With no dichroism, gray extinction commutes with pure Faraday rotation.
    // Rodrigues' formula avoids a degenerate eigenvalue and powers of a large
    // unnormalized generator while preserving the full Q/U/V transfer.
    if(polar.every(x=>x===0)){
      const phase=Math.hypot(...rho),base=Math.exp(-alpha),id=identity();if(phase===0)return id.map(row=>row.map(x=>base*x));
      const [x,y,z]=rho.map(v=>v/phase),axis=[[0,0,0,0],[0,0,-z,y],[0,z,0,-x],[0,-y,x,0]],axis2=multiply(axis,axis),si=Math.sin(phase),co=2*Math.sin(phase/2)**2;
      return id.map((row,i)=>row.map((v,j)=>base*(v+si*axis[i][j]+co*axis2[i][j])));
    }
    const J=[[0,-aq,-au,-av],[-aq,0,-rv,ru],[-au,rv,0,-rq],[-av,-ru,rq,0]],J2=multiply(J,J),J3=multiply(J2,J);
    const d=polar.reduce((s,x)=>s+x*x,0)-rho.reduce((s,x)=>s+x*x,0),b=polar.reduce((s,x,i)=>s+x*rho[i],0),root=Math.hypot(d,2*b);
    // Rationalize the smaller eigenvalue: root+d loses all significant digits
    // in Faraday-dominated cells, even when absorption is physically nonzero.
    const l1Squared=d>=0?(root+d)/2:2*b*b/Math.max(1e-300,root-d),l2Squared=d<0?(root-d)/2:2*b*b/Math.max(1e-300,root+d);
    const l1=Math.sqrt(Math.max(0,l1Squared)),l2=Math.sqrt(Math.max(0,l2Squared)),den=l1*l1+l2*l2,base=Math.exp(-alpha*distance);
    const id=identity();
    if(den<1e-30)return id.map((row,i)=>row.map((v,j)=>base*(v+distance*J[i][j]+distance**2/2*J2[i][j]+distance**3/6*J3[i][j])));
    // Closed matrix exponential of the Lorentz-generator part of the Stokes
    // matrix. Decaying exponentials prevent overflow in optically thick cells.
    const plus=Math.exp(-(alpha-l1)*distance),minus=Math.exp(-(alpha+l1)*distance),ch=(plus+minus)/2;
    const sh=l1>1e-16?(plus-minus)/(2*l1):base*distance,co=base*Math.cos(l2*distance),si=l2>1e-16?base*Math.sin(l2*distance)/l2:base*distance;
    const coefficients=[(l2*l2*ch+l1*l1*co)/den,(l2*l2*sh+l1*l1*si)/den,(ch-co)/den,(sh-si)/den];
    return id.map((row,i)=>row.map((v,j)=>coefficients[0]*v+coefficients[1]*J[i][j]+coefficients[2]*J2[i][j]+coefficients[3]*J3[i][j]));
  }
  let cachedSimulation=null;
  async function readSimulation() {
    const [metadataResponse,dataResponse]=await Promise.all([fetch(dataBase+"grmhd-torus.json"),fetch(dataBase+"grmhd-torus.f32.gz")]);
    if(!metadataResponse.ok||!dataResponse.ok)throw new Error("GRMHD data request failed");
    const metadata=await metadataResponse.json();
    if(!globalThis.DecompressionStream)throw new Error("This browser cannot decompress the GRMHD movie");
    // SubtleCrypto exists only in secure contexts; without this check a plain-http
    // preview fails with a TypeError that reads like a corrupt movie.
    if(!globalThis.crypto?.subtle)throw new Error("Checking the GRMHD movie hash needs a secure context (https or localhost)");
    const buffer=await new Response(dataResponse.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    if(buffer.byteLength!==metadata.bytes)throw new Error("Incomplete GRMHD movie");
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",buffer)),x=>x.toString(16).padStart(2,"0")).join("");
    if(digest!==metadata.sha256)throw new Error("GRMHD movie integrity mismatch");
    return {metadata,records:new Float32Array(buffer)};
  }
  function loadSimulation(){if(!cachedSimulation)cachedSimulation=readSimulation().catch(error=>{cachedSimulation=null;throw error;});return cachedSimulation;}
  const glsl=`
    float plasmaPlanck(float nu,float t){
      // Scale radio frequencies before multiplication and use the small-x
      // expansion; the naive 1e-47 coefficient is not representable in float32.
      float x=4.799243073e-11*nu/t;if(x>80.)return 0.;
      float correction=x<.001?1.-.5*x+x*x/12.:x/(exp(x)-1.);
      return 3.07235837e-19*t*pow(nu*1e-9,2.)*correction;
    }
    float oneMinusExp(float x){return x<.01?x*(1.-.5*x+x*x/6.-x*x*x/24.):1.-exp(-x);}
    mat4 attenuation(float alpha,vec3 absorption,vec3 rho,float ds,out vec4 lteSource){
      alpha*=ds;absorption*=ds;rho*=ds;ds=1.;
      float aq=absorption.x,au=absorption.y,av=absorption.z,rq=rho.x,ru=rho.y,rv=rho.z;
      // Exact gray extinction plus rotation is regular at zero dichroism. The
      // normalized generator keeps large Faraday phases bounded in float32.
      if(all(equal(absorption,vec3(0.)))){
        float phase=length(rho),base=exp(-alpha);lteSource=vec4(oneMinusExp(alpha),0.,0.,0.);
        if(phase==0.)return base*mat4(1.);vec3 axis=rho/phase;
        mat4 J=mat4(vec4(0.),vec4(0.,0.,axis.z,-axis.y),vec4(0.,-axis.z,0.,axis.x),vec4(0.,axis.y,-axis.x,0.));
        // GLSL pow() is undefined for a negative base, even with exponent 2.
        float halfSine=sin(phase*.5);return base*(mat4(1.)+sin(phase)*J+2.*halfSine*halfSine*(J*J));
      }
      // Scale the generator BEFORE squaring/cubing it. Optical depths can
      // combine subnormal dichroism with a finite Faraday phase; working in
      // bounded coefficients avoids both underflowed eigen ratios and J^3
      // overflow without dropping the polarized transfer.
      float scale=max(max(max(abs(aq),abs(au)),abs(av)),max(max(abs(rq),abs(ru)),abs(rv)));
      if(scale==0.){lteSource=vec4(oneMinusExp(alpha),0.,0.,0.);return exp(-alpha)*mat4(1.);}
      absorption/=scale;rho/=scale;aq=absorption.x;au=absorption.y;av=absorption.z;rq=rho.x;ru=rho.y;rv=rho.z;
      mat4 J=mat4(vec4(0.,-aq,-au,-av),vec4(-aq,0.,rv,-ru),vec4(-au,-rv,0.,rq),vec4(-av,ru,-rq,0.));
      mat4 J2=J*J,J3=J2*J;float d=dot(absorption,absorption)-dot(rho,rho),b=dot(absorption,rho),root=length(vec2(d,2.*b));
      float l1sq=d>=0.?(root+d)*.5:2.*b*b/max(1e-30,root-d),l2sq=d<0.?(root-d)*.5:2.*b*b/max(1e-30,root+d);
      float l1=sqrt(max(0.,l1sq)),l2=sqrt(max(0.,l2sq)),den=l1sq+l2sq,base=exp(-alpha),p1=l1*scale,p2=l2*scale;
      if(den<1e-28){
        // Weight each nilpotent polynomial coefficient in log space before
        // multiplying its bounded matrix. An opaque cell can have base=0 and
        // scale^3=Inf separately while its exact attenuator is finite (zero).
        float logScale=log(scale),c1=exp(-alpha+logScale),c2=exp(-alpha+2.*logScale-.69314718056),c3=exp(-alpha+3.*logScale-1.79175946923);
        mat4 result=base*mat4(1.)+c1*J+c2*J2+c3*J3;lteSource=-result[0];
        lteSource.x=oneMinusExp(alpha)-c2*J2[0].x-c3*J3[0].x;return result;
      }
      float ep=exp(-max(0.,alpha-p1)),em=exp(-(alpha+p1)),ch=.5*(ep+em);
      // Bound the unselected series arms too: GPU predication may evaluate
      // both arms, so neither a 0/0 nor a huge phase power is permitted.
      float x1=pow(min(p1,.1),2.),x2=pow(min(p2,.1),2.);
      if(p1<.1)ch=base*(1.+x1*.5+x1*x1/24.+x1*x1*x1/720.);
      float sh=p1<.1?base*scale*(1.+x1/6.+x1*x1/120.+x1*x1*x1/5040.):(ep-em)/(2.*max(1e-30,l1));
      float co=base*cos(p2),si=p2<.1?base*scale*(1.-x2/6.+x2*x2/120.-x2*x2*x2/5040.):base*sin(p2)/max(1e-30,l2);
      float halfSine=sin(p2*.5),difference=(p1<.1?base*(x1*.5+x1*x1/24.+x1*x1*x1/720.):ch-base)+2.*base*halfSine*halfSine;
      float third=max(p1,p2)<.1?base*scale*((x1+x2)/6.+(x1*x1-x2*x2)/120.+(x1*x1*x1+x2*x2*x2)/5040.):sh-si;
      mat4 result=((l2sq*ch+l1sq*co)*mat4(1.)+(l2sq*sh+l1sq*si)*J+difference*J2+third*J3)/den;
      lteSource=-result[0];
      lteSource.x=.5*(oneMinusExp(max(0.,alpha-p1))+oneMinusExp(alpha+p1))-max(0.,dot(absorption,absorption)-l1sq)/den*difference;
      return result;
    }
    vec4 thermalSynch(float ne,float B,float theta,float nu,float cosine,vec3 bess,out vec3 rho){
      float st=sqrt(max(1e-8,1.-cosine*cosine)),nb=2.799249e6*B;
      float x=max(1e-12,nu/(1.5*nb*theta*theta*st)),v=pow(x,1./3.),ex=exp(-1.8899*v),k2=max(1e-30,bess.z);
      float prefactor=ne*2.30707755e-19*nu/(1.73205080757*2.99792458e10*k2);
      vec4 j=prefactor*ex*vec4(2.5651*(1.+1.92/v+.9977/(v*v)),2.5651*(1.+.932/v+.4998/(v*v)),0.,4.*cosine/(3.*st*theta)*(1.8138/x+3.423/(v*v)+.02955/sqrt(x)+2.0377/v));
      float X=sqrt(942.80904158/x);
      float f=2.011*exp(-pow(X,1.035)/4.7)-cos(X*.5)*exp(-sqrt(X)/2.73)-.011*exp(-X/47.2);
      // The weak-field limit has X=0 and zero asymptotic blend. Evaluate the
      // inverse power only in its active range, avoiding an unphysical Inf*0.
      float blend=.5*(1.+tanh(10.*log(max(X,1e-30)/120.)));
      if(blend>0.)f+=(.011*exp(-X/47.2)-pow(2.,-1./3.)/pow(3.,23./6.)*1e4*3.14159265359*pow(X,-8./3.))*blend;
      float base=.00844797245*ne/nu,ratio=nb/nu;
      float rq=base*ratio*ratio*st*st*f*(bess.y/k2+6.*theta);
      float rv=2.*base*ratio*cosine*(bess.x-.4379*log(1.+.001858*pow(X,1.503)))/k2;
      rho=vec3(rq,0.,rv);return j;
    }
  `;
  globalThis.BlackHolePlasma=Object.freeze({besselK,besselTable,velocityTexture,thermalCoefficients,attenuation,multiply,identity,loadSimulation,glsl});
})();
