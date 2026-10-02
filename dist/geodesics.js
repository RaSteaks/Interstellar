"use strict";

(() => {
  // Independent Kerr-Schild Hamiltonian implementation. Units G=M=c=1, spin along z.
  // Outgoing coordinates are regular for the past-directed rays traced from the observer.
  const dot = (a,b) => a.reduce((sum,value,i)=>sum+value*b[i],0);
  const add = (a,b,factor=1) => a.map((value,i)=>value+factor*b[i]);
  const mul = (a,s) => a.map(value=>value*s);

  function geometry(x,a) {
    const a2=a*a, b=dot(x,x)-a2, root=Math.sqrt(b*b+4*a2*x[2]*x[2]);
    const r2=Math.max((b+root)*.5,1e-16), r=Math.sqrt(r2);
    const den=r2*r2+a2*x[2]*x[2], inverse=1/(r2+a2);
    const dr=[x[0]*r/root,x[1]*r/root,x[2]*(r2+a2)/(r*root)];
    const f=2*r*r2/den;
    const df=mul(dr,f*(3/r-4*r*r2/den));df[2]-=f*2*a2*x[2]/den;
    const n=[(-r*x[0]+a*x[1])*inverse,(-r*x[1]-a*x[0])*inverse,-x[2]/r];
    const dInverse=mul(dr,-2*r*inverse*inverse);
    const dn0=add(mul(dr,-x[0]*inverse),mul(dInverse,-r*x[0]+a*x[1]));dn0[0]-=r*inverse;dn0[1]+=a*inverse;
    const dn1=add(mul(dr,-x[1]*inverse),mul(dInverse,-r*x[1]-a*x[0]));dn1[1]-=r*inverse;dn1[0]-=a*inverse;
    const dn2=mul(dr,x[2]/r2);dn2[2]-=1/r;
    return {r,f,n,dr,df,dn:[dn0,dn1,dn2]};
  }
  function metricDot(v,w,geo) {
    return dot(v.slice(0,3),w.slice(0,3))-v[3]*w[3]+geo.f*(dot(geo.n,v.slice(0,3))+v[3])*(dot(geo.n,w.slice(0,3))+w[3]);
  }
  function lower(v,geo) {
    const k=dot(geo.n,v.slice(0,3))+v[3];
    return [v[0]+geo.f*k*geo.n[0],v[1]+geo.f*k*geo.n[1],v[2]+geo.f*k*geo.n[2],-v[3]+geo.f*k];
  }
  function observer(spin,tilt,distance=80) {
    const angle=tilt*Math.PI/180;
    const origin=[0,-distance*Math.cos(angle),distance*Math.sin(angle)];
    const geo=geometry(origin,spin),u=[0,0,0,1/Math.sqrt(1-geo.f)];
    const basis=[];
    for(const vector of [[1,0,0,0],[0,Math.sin(angle),Math.cos(angle),0],[0,Math.cos(angle),-Math.sin(angle),0]]) {
      let e=add(vector,u,metricDot(vector,u,geo));
      for(const previous of basis)e=add(e,previous,-metricDot(e,previous,geo));
      e=mul(e,1/Math.sqrt(metricDot(e,e,geo)));basis.push(e);
    }
    return {origin,u,basis,distance,spin,geo};
  }
  function initialRay(camera,alpha,beta) {
    const direction=[alpha/camera.distance,beta/camera.distance,1];
    const length=Math.hypot(...direction);
    let v=mul(camera.u,-1);
    camera.basis.forEach((e,i)=>{v=add(v,e,direction[i]/length);});
    const p=lower(v,camera.geo);
    return {x:[...camera.origin],p:p.slice(0,3),energy:p[3]};
  }
  function hamiltonian(ray,a) {
    const geo=geometry(ray.x,a),k=dot(geo.n,ray.p)-ray.energy;
    return .5*(dot(ray.p,ray.p)-ray.energy*ray.energy-geo.f*k*k);
  }
  function derivative(ray,a) {
    const geo=geometry(ray.x,a),k=dot(geo.n,ray.p)-ray.energy;
    const gradient=geo.dn.reduce((total,dn,i)=>add(total,dn,ray.p[i]),[0,0,0]);
    return {x:add(ray.p,geo.n,-geo.f*k),p:add(mul(geo.df,.5*k*k),gradient,geo.f*k)};
  }
  function advance(ray,a,h) {
    const stage=(value,k,factor)=>({x:add(value.x,k.x,factor),p:add(value.p,k.p,factor),energy:value.energy});
    const k1=derivative(ray,a),k2=derivative(stage(ray,k1,h*.5),a);
    const k3=derivative(stage(ray,k2,h*.5),a),k4=derivative(stage(ray,k3,h),a);
    const integrate=key=>ray[key].map((value,i)=>value+h/6*(k1[key][i]+2*k2[key][i]+2*k3[key][i]+k4[key][i]));
    return {x:integrate("x"),p:integrate("p"),energy:ray.energy};
  }
  function hitRecord(x,p,energy,spin) {
    const r=geometry(x,spin).r,omega=1/(r**1.5+spin);
    const ut=(1+spin/r**1.5)/Math.sqrt(1-3/r+2*spin/r**1.5);
    const angularMomentum=x[0]*p[1]-x[1]*p[0],emitterEnergy=ut*(energy+omega*angularMomentum);
    if(!(emitterEnergy>0))return null;
    const shift=1/emitterEnergy;
    return {r,phi:Math.atan2(x[1],x[0]),shift,mu:Math.min(1,Math.abs(p[2])*shift)};
  }
  function trace(camera,alpha,beta,inner,outer,options={}) {
    let ray=initialRay(camera,alpha,beta),maxError=Math.abs(hamiltonian(ray,camera.spin));
    const initialMomentum=ray.x[0]*ray.p[1]-ray.x[1]*ray.p[0];
    const horizon=1+Math.sqrt(1-camera.spin*camera.spin),hits=[];
    const scale=options.stepScale ?? .065,limit=options.steps ?? 320;
    let captured=false,escaped=false,i=0;
    for(;i<limit;i++) {
      const r=geometry(ray.x,camera.spin).r;
      if(r<=horizon*1.003){captured=true;break;}
      if(r>90){escaped=true;break;}
      // Shrink the affine step near the horizon, especially for rapid Kerr spin.
      const next=advance(ray,camera.spin,Math.min(3.5,Math.max(.008,r*scale),.012+.14*Math.max(0,r-horizon)));
      if(ray.x[2]*next.x[2]<0) {
        const t=ray.x[2]/(ray.x[2]-next.x[2]);
        const x=add(ray.x,add(next.x,ray.x,-1),t),p=add(ray.p,add(next.p,ray.p,-1),t);
        const record=hitRecord(x,p,ray.energy,camera.spin);
        if(record&&record.r>inner&&record.r<outer)hits.push(record);
      }
      ray=next;
      const error=Math.abs(hamiltonian(ray,camera.spin));maxError=Math.max(maxError,error);
      if(!Number.isFinite(error))break;
    }
    return {ray,hits,captured,escaped,steps:i,maxError,momentumError:Math.abs(ray.x[0]*ray.p[1]-ray.x[1]*ray.p[0]-initialMomentum)};
  }

  // GPU and CPU use the same z-axis, signature and past-directed energy convention.
  const glsl = `
    struct Geometry { float r; float f; vec3 n; vec3 dr; vec3 df; };
    Geometry metric(vec3 x,float a) {
      float a2=a*a;
      float b=dot(x,x)-a2;
      float root=sqrt(b*b+4.*a2*x.z*x.z);
      float r2=max(.5*(b+root),1e-12);
      float r=sqrt(r2);
      float den=r2*r2+a2*x.z*x.z;
      Geometry g;
      g.r=r;
      g.dr=vec3(x.xy*r/root,x.z*(r2+a2)/(r*root));
      g.f=2.*r*r2/den;
      g.df=g.f*(3./r-4.*r*r2/den)*g.dr;
      g.df.z-=g.f*2.*a2*x.z/den;
      g.n=vec3((-r*x.x+a*x.y)/(r2+a2),(-r*x.y-a*x.x)/(r2+a2),-x.z/r);
      return g;
    }
    void rhs(vec3 x,vec3 p,float energy,float a,out vec3 dx,out vec3 dp) {
      Geometry g=metric(x,a);
      float inverse=1./(g.r*g.r+a*a);
      vec3 di=-2.*g.r*inverse*inverse*g.dr;
      vec3 dn0=-x.x*inverse*g.dr+(-g.r*x.x+a*x.y)*di+vec3(-g.r,a,0.)*inverse;
      vec3 dn1=-x.y*inverse*g.dr+(-g.r*x.y-a*x.x)*di+vec3(-a,-g.r,0.)*inverse;
      vec3 dn2=x.z/(g.r*g.r)*g.dr-vec3(0.,0.,1./g.r);
      float k=dot(g.n,p)-energy;
      dx=p-g.f*k*g.n;
      dp=.5*k*k*g.df+g.f*k*(p.x*dn0+p.y*dn1+p.z*dn2);
    }
    void rk4(inout vec3 x,inout vec3 p,float energy,float a,float h) {
      vec3 x1,p1,x2,p2,x3,p3,x4,p4;
      rhs(x,p,energy,a,x1,p1);
      rhs(x+h*.5*x1,p+h*.5*p1,energy,a,x2,p2);
      rhs(x+h*.5*x2,p+h*.5*p2,energy,a,x3,p3);
      rhs(x+h*x3,p+h*p3,energy,a,x4,p4);
      x+=h/6.*(x1+2.*x2+2.*x3+x4);
      p+=h/6.*(p1+2.*p2+2.*p3+p4);
    }
  `;
  globalThis.BlackHoleGeodesics=Object.freeze({geometry,metricDot,lower,observer,initialRay,hamiltonian,derivative,advance,hitRecord,trace,glsl});
})();
