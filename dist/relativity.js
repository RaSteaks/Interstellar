"use strict";

(() => {
  // Ingoing Cartesian Kerr–Schild coordinates, signature +++−, G=M=c=1.
  // Unlike the previous outgoing chart this chart also supports infalling cameras.
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0), add=(a,b,f=1)=>a.map((v,i)=>v+f*b[i]);
  const scale=(v,s)=>v.map(x=>x*s), clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function geometry(x,a=0,q=0,chart=1) {
    const a2=a*a,b=dot(x,x)-a2,root=Math.sqrt(b*b+4*a2*x[2]*x[2]);
    const r=Math.sqrt(Math.max((b+root)/2,1e-24)),r2=r*r,d=r2*r2+a2*x[2]*x[2];
    const dr=[x[0]*r/root,x[1]*r/root,x[2]*(r2+a2)/(r*root)],inv=1/(r2+a2);
    const numerator=(2*r-q*q)*r2,f=numerator/d;
    const df=dr.map((v,i)=>((6*r2-2*q*q*r)*v*d-numerator*(4*r*r2*v+(i===2?2*a2*x[2]:0)))/(d*d));
    const n=[(chart*r*x[0]+a*x[1])*inv,(chart*r*x[1]-a*x[0])*inv,chart*x[2]/r];
    const dinv=scale(dr,-2*r*inv*inv);
    const dn0=add(scale(dr,chart*x[0]*inv),scale(dinv,chart*r*x[0]+a*x[1]));dn0[0]+=chart*r*inv;dn0[1]+=a*inv;
    const dn1=add(scale(dr,chart*x[1]*inv),scale(dinv,chart*r*x[1]-a*x[0]));dn1[1]+=chart*r*inv;dn1[0]-=a*inv;
    const dn2=scale(dr,-chart*x[2]/r2);dn2[2]+=chart/r;
    return {r,f,n,dr,df,dn:[dn0,dn1,dn2],sigma:d/r2,chart};
  }
  function metricDot(v,w,g){return dot(v.slice(0,3),w.slice(0,3))-v[3]*w[3]+g.f*(dot(g.n,v.slice(0,3))+v[3])*(dot(g.n,w.slice(0,3))+w[3]);}
  function lower(v,g){const k=dot(g.n,v.slice(0,3))+v[3];return [...add(v.slice(0,3),g.n,g.f*k),-v[3]+g.f*k];}
  function raise(p,g){const k=dot(g.n,p.slice(0,3))-p[3];return [...add(p.slice(0,3),g.n,-g.f*k),-p[3]+g.f*k];}
  function horizon(a=0,q=0){const d=Math.sqrt(Math.max(0,1-a*a-q*q));return {outer:1+d,inner:1-d};}
  function circular(r,a=0,q=0) {
    const k=Math.sqrt(Math.max(0,r-q*q)),d=r*r-3*r+2*q*q+2*a*k;
    if(d<=0)return null;
    const den=r*Math.sqrt(d),omega=k/(r*r+a*k);
    return {energy:(r*r-2*r+q*q+a*k)/den,angularMomentum:(k*(r*r+a*a)-a*(2*r-q*q))/den,omega,ut:(r*r+a*k)/den};
  }
  function isco(a=0,q=0) {
    if(q===0){const z1=1+Math.cbrt(1-a*a)*(Math.cbrt(1+a)+Math.cbrt(1-a)),z2=Math.sqrt(3*a*a+z1*z1);return 3+z2-Math.sign(a)*Math.sqrt((3-z1)*(3+z1+2*z2));}
    // For neutral matter in Kerr–Newman the minimum circular-orbit energy
    // locates the marginally stable orbit; use a bracket, never a guessed offset.
    const derivative=r=>{const h=r*1e-5,l=circular(r-h,a,q),u=circular(r+h,a,q);return l&&u?(u.energy-l.energy)/(2*h):NaN;};
    let previous=null;const start=horizon(a,q).outer*1.0001;
    for(let i=1;i<=1800;i++){const r=start*Math.pow(32/start,i/1800),v=derivative(r);if(Number.isFinite(v)){if(previous&&previous.v<0&&v>=0){let lo=previous.r,hi=r;for(let j=0;j<50;j++){const m=(lo+hi)/2;if(derivative(m)>0)hi=m;else lo=m;}return (lo+hi)/2;}previous={r,v};}}
    throw new Error("No stable circular orbit in the requested subextremal model");
  }
  function inflowConstants(a,q=0,speed=.01) {
    const r=isco(a,q),c=circular(r,a,q),delta=r*r-2*r+a*a+q*q;
    // Radial injection boosts both E and L, making the circular and plunging
    // four-velocities agree at ISCO instead of joining different angular speeds.
    const gamma=Math.sqrt(1+r*r*speed*speed/delta);
    return {inner:r,energy:gamma*c.energy,angularMomentum:gamma*c.angularMomentum,radialSpeed:speed};
  }
  function infall(x,a=0,q=0,e=1,l=0,carter=0) {
    const g=geometry(x,a,q),r=g.r,sin2=Math.max(1e-16,1-x[2]*x[2]/(r*r));
    const delta=r*r-2*r+a*a+q*q,p=e*(r*r+a*a)-a*l,b=r*r+(l-a*e)**2+carter;
    const root=Math.sqrt(Math.max(0,p*p-delta*b)),ur=-root/g.sigma;
    // Rationalizing P−sqrt(R) removes the 0/0 at BOTH horizons.
    const rational=b/Math.max(1e-20,p+root);
    const ut=(a*(l-a*e*sin2)+p+(2*r-q*q)*rational)/g.sigma;
    const uphi=(l/sin2-a*e+a*rational)/g.sigma;
    const radial=[(r*x[0]+a*x[1])/(r*r+a*a),(r*x[1]-a*x[0])/(r*r+a*a),x[2]/r];
    return [...add(scale(radial,ur),[-x[1],x[0],0],uphi),ut];
  }
  function circularVelocity(x,a=0,q=0,ur=0) {
    const g=geometry(x,a,q),r=g.r,c=circular(r,a,q);
    const radial=[(r*x[0]+a*x[1])/(r*r+a*a),(r*x[1]-a*x[0])/(r*r+a*a),x[2]/r];
    const delta=r*r-2*r+a*a+q*q,sin2=1-x[2]*x[2]/(r*r),f=(2*r-q*q)/g.sigma;
    const tt=-1+f,tp=-a*f*sin2,pp=sin2*(r*r+a*a+a*a*f*sin2);
    const utBL=Math.sqrt((1+g.sigma/delta*ur*ur)/(-(tt+2*tp*c.omega+pp*c.omega*c.omega)));
    const ut=utBL+(2*r-q*q)/delta*ur,uphi=c.omega*utBL+a/delta*ur;
    return [...add(scale(radial,ur),[-x[1],x[0],0],uphi),ut];
  }
  function chartIntegrals(r,a=0,q=0){const h=horizon(a,q),gap=h.outer-h.inner,log=Math.log(Math.abs((r-h.outer)/(r-h.inner)));return {phi:a/gap*log,time:Math.log(Math.abs((r-h.outer)*(r-h.inner)))+(2-q*q)/gap*log};}
  function changeChart(position,v,a=0,q=0,from=1,to=-1,anchor=null) {
    const m=geometry(position,a,q,from),r=m.r,ct=position[2]/r,st=Math.sqrt(Math.max(1e-20,1-ct*ct)),delta=r*r-2*r+a*a+q*q;
    const ur=dot(m.dr,v.slice(0,3)),uth=(ct*ur-v[2])/(r*st),D=r*r+a*a;
    const phi=Math.atan2(position[1],position[0])-from*Math.atan2(a,r);
    const shift=anchor===null?0:(to-from)*(chartIntegrals(r,a,q).phi-chartIntegrals(anchor,a,q).phi);
    const targetPhi=phi+shift,x=[(r*Math.cos(targetPhi)-to*a*Math.sin(targetPhi))*st,(r*Math.sin(targetPhi)+to*a*Math.cos(targetPhi))*st,r*ct];
    const up=(position[0]*v[1]-position[1]*v[0])/(position[0]**2+position[1]**2)+from*a/D*ur+(to-from)*a/delta*ur;
    const dr=[(r*x[0]+to*a*x[1])/D,(r*x[1]-to*a*x[0])/D,ct],dt=[x[0]*ct/st,x[1]*ct/st,-r*st];
    return {position:x,vector:[...add(add(scale(dr,ur),dt,uth),[-x[1],x[0],0],up),v[3]+(to-from)*(2*r-q*q)/delta*ur]};
  }
  function observer(a=0,q=0,tilt=18,r=80,kind="static",yaw=0,chart=1) {
    // The azimuthal chart integral is anchored at the observer radius, matching
    // the shader's point/vector conversions (chartIntegral uses uDistance there).
    // The shift is exactly zero at this radius, so the camera and tetrad are
    // unchanged; the anchor only makes changeChart agree with the shader when it
    // is evaluated at any other radius.
    if(chart===-1){const base=observer(a,q,tilt,r,kind,yaw,1),converted=changeChart(base.position,base.u,a,q,1,-1,r);return {...base,position:converted.position,u:converted.vector,basis:base.basis.map(v=>changeChart(base.position,v,a,q,1,-1,r).vector),g:geometry(converted.position,a,q,-1),chart:-1};}
    const angle=tilt*Math.PI/180,radial=Math.cos(angle),position=[(r*Math.sin(yaw)+a*Math.cos(yaw))*radial,(-r*Math.cos(yaw)+a*Math.sin(yaw))*radial,r*Math.sin(angle)];
    const g=geometry(position,a,q);
    const u=kind==="infall"?infall(position,a,q):[0,0,0,1/Math.sqrt(1-g.f)];
    if(!u.every(Number.isFinite)||Math.abs(metricDot(u,u,g)+1)>1e-7)throw new Error("Observer must be future timelike");
    const candidates=[[Math.cos(yaw),Math.sin(yaw),0,0],[-Math.sin(yaw)*Math.sin(angle),Math.cos(yaw)*Math.sin(angle),Math.cos(angle),0],[Math.sin(yaw)*Math.cos(angle),-Math.cos(yaw)*Math.cos(angle),Math.sin(angle),0]];
    const basis=[];
    for(const raw of candidates){let v=add(raw,u,metricDot(raw,u,g));for(const p of basis)v=add(v,p,-metricDot(v,p,g));v=scale(v,1/Math.sqrt(metricDot(v,v,g)));basis.push(v);}
    // The forward leg points towards decreasing radius, with the transported
    // up/right legs held by the observer's local orthonormal frame.
    basis[2]=scale(basis[2],-1);
    return {position,u,basis,a,q,r,kind,g,chart:1};
  }
  function initialRay(camera,alpha,beta) {
    const d=[alpha/camera.r,beta/camera.r,1],length=Math.hypot(...d);let k=scale(camera.u,-1);
    camera.basis.forEach((b,i)=>{k=add(k,b,d[i]/length);});
    return {x:[...camera.position],p:lower(k,camera.g),time:0};
  }
  function derivative(ray,a=0,q=0,chart=1) {
    const g=geometry(ray.x,a,q,chart),k=dot(g.n,ray.p.slice(0,3))-ray.p[3],v=raise(ray.p,g);
    const force=g.df.map((df,j)=>.5*df*k*k+g.f*k*g.dn.reduce((s,row,i)=>s+row[j]*ray.p[i],0));
    return {x:v.slice(0,3),p:[...force,0],time:v[3]};
  }
  function advance(ray,a,q,h,chart=1) {
    const state=(d,f)=>({x:add(ray.x,d.x,h*f),p:add(ray.p,d.p,h*f),time:ray.time+h*f*d.time});
    const k1=derivative(ray,a,q,chart),k2=derivative(state(k1,.5),a,q,chart),k3=derivative(state(k2,.75),a,q,chart);
    const high={x:ray.x.map((v,i)=>v+h*(2*k1.x[i]/9+k2.x[i]/3+4*k3.x[i]/9)),p:ray.p.map((v,i)=>v+h*(2*k1.p[i]/9+k2.p[i]/3+4*k3.p[i]/9)),time:ray.time+h*(2*k1.time/9+k2.time/3+4*k3.time/9)};
    const k4=derivative(high,a,q,chart);
    const low={x:ray.x.map((v,i)=>v+h*(7*k1.x[i]/24+k2.x[i]/4+k3.x[i]/3+k4.x[i]/8)),p:ray.p.map((v,i)=>v+h*(7*k1.p[i]/24+k2.p[i]/4+k3.p[i]/3+k4.p[i]/8)),time:ray.time+h*(7*k1.time/24+k2.time/4+k3.time/3+k4.time/8)};
    const error=Math.max(...high.x.map((v,i)=>Math.abs(v-low.x[i])/Math.max(1,Math.abs(v))),...high.p.map((v,i)=>Math.abs(v-low.p[i])/Math.max(1,Math.abs(v))),Math.abs(high.time-low.time)/Math.max(1,Math.abs(high.time)));
    return {ray:high,error};
  }
  function trace(camera,alpha,beta,{tolerance=1e-7,maxSteps=20000,escape=150}={}) {
    let ray=initialRay(camera,alpha,beta),h=.5,status="unfinished",accepted=0,rejected=0;const hits=[],rh=horizon(camera.a,camera.q).outer;let reachedExterior=camera.r>rh*1.003;
    for(let i=0;i<maxSteps;i++) {
      const g=geometry(ray.x,camera.a,camera.q,camera.chart||1);
      if(g.r>escape){status="escaped";break;}
      if(g.r>rh*1.003)reachedExterior=true;
      const radial=dot(g.dr,raise(ray.p,g).slice(0,3));
      if((reachedExterior&&g.r<rh*1.003&&radial<0)||(camera.r<rh&&ray.p[3]<=0&&g.r>rh*.997)||g.r<.05){status="captured";break;}
      const trial=advance(ray,camera.a,camera.q,h,camera.chart||1);
      if(trial.error>tolerance&&h>1e-6){h*=Math.max(.15,.8*Math.cbrt(tolerance/trial.error));rejected++;continue;}
      const old=ray;ray=trial.ray;accepted++;
      if(old.x[2]*ray.x[2]<0){const f=old.x[2]/(old.x[2]-ray.x[2]),x=add(old.x,add(ray.x,old.x,-1),f);hits.push({x,r:geometry(x,camera.a,camera.q,camera.chart||1).r,time:old.time+f*(ray.time-old.time)});}
      h=Math.min(4,h*clamp(.9*Math.cbrt(tolerance/Math.max(1e-20,trial.error)),.5,2));
    }
    const nullError=Math.abs(dot(ray.p,raise(ray.p,geometry(ray.x,camera.a,camera.q,camera.chart||1))));
    return {ray,status,hits,accepted,rejected,nullError};
  }
  function connectionTransport(x,p,vector,a=0,q=0) {
    const g=geometry(x,a,q),k=raise(p,g),l=[...g.n,1];
    const dg=Array.from({length:3},(_,j)=>Array.from({length:4},(_,m)=>Array.from({length:4},(_,n)=>g.df[j]*l[m]*l[n]+g.f*((m<3?g.dn[m][j]:0)*l[n]+l[m]*(n<3?g.dn[n][j]:0)))));
    const cov=Array.from({length:4},(_,m)=>-.5*(k.slice(0,3).reduce((s,v,j)=>s+v*dg[j][m].reduce((t,w,n)=>t+w*vector[n],0),0)+vector.slice(0,3).reduce((s,v,j)=>s+v*dg[j][m].reduce((t,w,n)=>t+w*k[n],0),0)-(m<3?dg[m].reduce((s,row,i)=>s+k[i]*dot(row,vector),0):0)));
    return raise(cov,g);
  }
  const glsl=`
    float rayChart;
    struct Geometry {float r,f,sigma;vec3 n,dr,df;mat3 dn;};
    Geometry metric(vec3 x,float a,float charge){
      float a2=a*a,b=dot(x,x)-a2,root=sqrt(b*b+4.*a2*x.z*x.z);
      float r=sqrt(max((b+root)*.5,1e-18)),r2=r*r,den=r2*r2+a2*x.z*x.z,iv=1./(r2+a2);
      vec3 dr=vec3(x.xy*r/root,x.z*(r2+a2)/(r*root));
      float nn=(2.*r-charge*charge)*r2;vec3 df=((6.*r2-2.*charge*charge*r)*dr*den-nn*(4.*r*r2*dr+vec3(0.,0.,2.*a2*x.z)))/(den*den);
      vec3 n=vec3((rayChart*r*x.x+a*x.y)*iv,(rayChart*r*x.y-a*x.x)*iv,rayChart*x.z/r),di=-2.*r*iv*iv*dr;
      vec3 d0=rayChart*x.x*iv*dr+(rayChart*r*x.x+a*x.y)*di+vec3(rayChart*r*iv,a*iv,0.);
      vec3 d1=rayChart*x.y*iv*dr+(rayChart*r*x.y-a*x.x)*di+vec3(-a*iv,rayChart*r*iv,0.);
      vec3 d2=-rayChart*x.z/r2*dr+vec3(0.,0.,rayChart/r);
      return Geometry(r,nn/den,den/r2,n,dr,df,transpose(mat3(d0,d1,d2)));
    }
    float gdot(vec4 v,vec4 w,Geometry m){return dot(v.xyz,w.xyz)-v.w*w.w+m.f*(dot(m.n,v.xyz)+v.w)*(dot(m.n,w.xyz)+w.w);}
    vec4 lower4(vec4 v,Geometry m){float k=dot(m.n,v.xyz)+v.w;return vec4(v.xyz+m.f*k*m.n,-v.w+m.f*k);}
    vec4 raise4(vec4 p,Geometry m){float k=dot(m.n,p.xyz)-p.w;return vec4(p.xyz-m.f*k*m.n,-p.w+m.f*k);}
    void rhsAtMetric(vec3 p,float energy,Geometry m,out vec4 dx,out vec3 dp){float k=dot(m.n,p)-energy;dx=raise4(vec4(p,energy),m);dp=.5*m.df*k*k+m.f*k*transpose(m.dn)*p;}
    void rhs(vec3 x,vec3 p,float energy,float a,float charge,out vec4 dx,out vec3 dp){rhsAtMetric(p,energy,metric(x,a,charge),dx,dp);}
    void seedBS(vec3 x,vec3 p,float energy,float a,float charge,out Geometry m,out vec4 dx,out vec3 dp){m=metric(x,a,charge);rhsAtMetric(p,energy,m,dx,dp);}
    // Bogacki–Shampine 3(2) is FSAL: the accepted endpoint's final derivative
    // is exactly the next step's first derivative. Expose that static geometry
    // and derivative together, retaining all stages and the same error estimate.
    void stepBSSeeded(vec3 x,vec3 p,float time,float energy,float a,float charge,float h,vec4 firstDx,vec3 firstDp,out vec3 nx,out vec3 np,out float nt,out float error,out Geometry endpoint,out vec4 lastDx,out vec3 lastDp){
      vec4 x1=firstDx,x2,x3;vec3 p1=firstDp,p2,p3;
      rhs(x+.5*h*x1.xyz,p+.5*h*p1,energy,a,charge,x2,p2);
      rhs(x+.75*h*x2.xyz,p+.75*h*p2,energy,a,charge,x3,p3);
      vec4 delta=h*(2./9.*x1+1./3.*x2+4./9.*x3);nx=x+delta.xyz;np=p+h*(2./9.*p1+1./3.*p2+4./9.*p3);nt=time+delta.w;
      endpoint=metric(nx,a,charge);rhsAtMetric(np,energy,endpoint,lastDx,lastDp);
      vec4 low=h*(7./24.*x1+.25*x2+1./3.*x3+.125*lastDx);
      vec3 pe=h*(7./24.*p1+.25*p2+1./3.*p3+.125*lastDp);
      vec3 ex=abs(delta.xyz-low.xyz)/max(vec3(1.),abs(nx)),ep=abs(np-p-pe)/max(vec3(1.),abs(np));
      error=max(max(max(ex.x,ex.y),ex.z),max(max(ep.x,ep.y),ep.z));error=max(error,abs(delta.w-low.w)/max(1.,abs(nt)));
    }
    // Preserve the original standalone-step interface for other GLSL callers
    // and independent numerical oracles that do not retain an endpoint cache.
    void stepBS(vec3 x,vec3 p,float time,float energy,float a,float charge,float h,out vec3 nx,out vec3 np,out float nt,out float error){
      Geometry initial,endpoint;vec4 firstDx,lastDx;vec3 firstDp,lastDp;seedBS(x,p,energy,a,charge,initial,firstDx,firstDp);
      stepBSSeeded(x,p,time,energy,a,charge,h,firstDx,firstDp,nx,np,nt,error,endpoint,lastDx,lastDp);
    }
    vec4 plungeVelocity(vec3 x,float a,float charge,vec2 constants){
      Geometry m=metric(x,a,charge);float r=m.r,s2=max(1e-8,1.-x.z*x.z/(r*r)),e=constants.x,l=constants.y;
      float delta=r*r-2.*r+a*a+charge*charge,p=e*(r*r+a*a)-a*l,b=r*r+(l-a*e)*(l-a*e);
      float rr=sqrt(max(0.,p*p-delta*b)),ur=-rr/m.sigma,k=b/(p+rayChart*rr);
      float ut=(a*(l-a*e*s2)+p+(2.*r-charge*charge)*k)/m.sigma,up=(l/s2-a*e+a*k)/m.sigma;
      vec3 radial=vec3((r*x.x+rayChart*a*x.y)/(r*r+a*a),(r*x.y-rayChart*a*x.x)/(r*r+a*a),x.z/r);
      return vec4(ur*radial+up*vec3(-x.y,x.x,0.),ut);
    }
    vec4 parallelDerivative(vec3 x,vec4 p,vec4 e,float a,float charge){
      Geometry m=metric(x,a,charge);vec4 k=raise4(p,m),l=vec4(m.n,1.);float lk=dot(l,k),le=dot(l,e);
      vec3 dk=m.dn*k.xyz,de=m.dn*e.xyz;float alongK=dot(m.df,k.xyz),alongE=dot(m.df,e.xyz);
      // Directional metric derivatives use d(n)/d(x), including its mixed terms.
      vec4 first=alongK*l*le+m.f*(vec4(dk,0.)*le+l*dot(dk,e.xyz));
      vec4 second=alongE*l*lk+m.f*(vec4(de,0.)*lk+l*dot(de,k.xyz));
      vec4 last=vec4(m.df*lk*le+m.f*(transpose(m.dn)*k.xyz*le+transpose(m.dn)*e.xyz*lk),0.);
      return raise4(-.5*(first+second-last),m);
    }
  `;
  globalThis.BlackHoleRelativity=Object.freeze({dot,add,scale,clamp,geometry,metricDot,lower,raise,horizon,circular,isco,inflowConstants,infall,circularVelocity,chartIntegrals,changeChart,observer,initialRay,derivative,advance,trace,connectionTransport,glsl});
})();
