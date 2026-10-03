"use strict";

(() => {
  function create({canvas,particles,state,physics,onNeedsFrame}) {
    const gl=canvas.getContext("webgl2",{alpha:false,antialias:false,powerPreference:"high-performance"});
    if(!gl||!gl.getExtension("EXT_color_buffer_float"))return null;
    const geodesics=globalThis.BlackHoleGeodesics;
    const metrics={mode:"webgl2-kerr-raytrace",frames:0,geodesicBuilds:0,traceWidth:0,traceHeight:0,traceSubmitMs:0,traceQuality:"interactive",traceBudget:0,canvasWidth:0,canvasHeight:0,imageWidth:0,imageHeight:0,refinementRequests:0};
    const vertex=`#version 300 es
      layout(location=0) in vec2 aPosition;
      out vec2 vUv;
      void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}
    `;
    const traceFragment=`#version 300 es
      precision highp float;
      precision highp int;
      in vec2 vUv;
      layout(location=0) out vec4 firstHit;
      layout(location=1) out vec4 secondHit;
      layout(location=2) out vec4 skyHit;
      uniform vec2 uExtent;
      uniform vec3 uOrigin;
      uniform vec4 uObserver,uRight,uUp,uForward;
      uniform float uDistance,uSpin,uHorizon,uInner,uOuter,uStepScale;
      uniform int uSteps;
      ${geodesics.glsl}
      vec4 record(vec3 x,vec3 p,float energy) {
        float r=metric(x,uSpin).r;
        float omega=1./(pow(r,1.5)+uSpin);
        float ut=(1.+uSpin/pow(r,1.5))/sqrt(max(1.-3./r+2.*uSpin/pow(r,1.5),1e-8));
        float lz=x.x*p.y-x.y*p.x;
        float emittedEnergy=ut*(energy+omega*lz);
        if(emittedEnergy<=0.)return vec4(-1.,0.,0.,1.);
        float shift=1./emittedEnergy;
        return vec4(r,atan(x.y,x.x),shift,min(1.,abs(p.z)*shift));
      }
      void main() {
        firstHit=vec4(-1.,0.,0.,1.);secondHit=firstHit;
        // Escaping rays carry their asymptotic direction so the sky is sampled where the light came from.
        skyHit=vec4(0.,0.,0.,0.);
        vec2 impact=(vUv-.5)*uExtent;
        vec3 direction=normalize(vec3(impact/uDistance,1.));
        vec4 velocity=-uObserver+direction.x*uRight+direction.y*uUp+direction.z*uForward;
        Geometry initial=metric(uOrigin,uSpin);
        vec4 light=vec4(initial.n,1.);
        vec4 momentum=vec4(velocity.xyz,-velocity.w)+initial.f*dot(light,velocity)*light;
        vec3 x=uOrigin,p=momentum.xyz;
        float energy=momentum.w;
        int hits=0;
        bool escaped=false;
        for(int i=0;i<384;i++) {
          if(i>=uSteps)break;
          Geometry geo=metric(x,uSpin);
          if(geo.r<=uHorizon*1.003)break;
          if(geo.r>95.){escaped=true;break;}
          float h=min(min(3.5,max(.008,geo.r*uStepScale)),.012+.14*max(0.,geo.r-uHorizon));
          vec3 oldX=x,oldP=p;
          rk4(x,p,energy,uSpin,h);
          if(any(isnan(x))||any(isnan(p))||any(isinf(x))||any(isinf(p)))break;
          if(oldX.z*x.z<0.) {
            float fraction=oldX.z/(oldX.z-x.z);
            vec3 position=mix(oldX,x,fraction),covector=mix(oldP,p,fraction);
            float radius=metric(position,uSpin).r;
            if(radius>uInner&&radius<uOuter) {
              vec4 hit=record(position,covector,energy);
              if(hit.x>0.) {
                if(hits==0)firstHit=hit;else secondHit=hit;
                hits++;
                if(hits>=2)break;
              }
            }
          }
        }
        if(escaped)skyHit=vec4(normalize(p),1.);
      }
    `;
    const atlasVertex=`#version 300 es
      precision highp float;
      layout(location=0) in vec4 aSeed;
      uniform float uInner,uOuter,uSpin,uTime,uYaw;
      out float vWeight;
      void main() {
        float r=mix(uInner+.025,uOuter,aSeed.x);
        float phase=aSeed.y+uTime*19./(pow(r,1.5)+uSpin)+uYaw;
        // Two guard texels keep wrapped point centers inside the clip volume.
        float u=(fract(phase/6.28318530718+.5)*1024.+2.+float(gl_InstanceID-1)*1024.)/1028.;
        gl_Position=vec4(u*2.-1.,aSeed.x*2.-1.,0.,1.);
        gl_PointSize=2.2+aSeed.w*1.8;
        vWeight=.35+aSeed.w*.65;
      }
    `;
    const atlasFragment=`#version 300 es
      precision highp float;
      in float vWeight;
      out vec4 color;
      void main(){vec2 p=gl_PointCoord-.5;float value=exp(-dot(p,p)*20.)*vWeight;color=vec4(value);}
    `;
    const emitFragment=`#version 300 es
      precision highp float;
      precision highp int;
      in vec2 vUv;
      out vec4 color;
      uniform sampler2D uFirst,uSecond,uAtlas,uFlux,uSky;
      uniform float uInner,uOuter,uPalette;
      float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
      vec3 hash33(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
      float vnoise(vec3 p){
        vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(hash13(i),hash13(i+vec3(1.,0.,0.)),f.x),mix(hash13(i+vec3(0.,1.,0.)),hash13(i+vec3(1.,1.,0.)),f.x),f.y),
                   mix(mix(hash13(i+vec3(0.,0.,1.)),hash13(i+vec3(1.,0.,1.)),f.x),mix(hash13(i+vec3(0.,1.,1.)),hash13(i+vec3(1.,1.,1.)),f.x),f.y),f.z);
      }
      vec3 spectrum(float temperature) {
        float t=clamp(temperature,0.,1.6);
        vec3 warm=mix(vec3(.62,.045,.006),vec3(1.,.48,.12),smoothstep(.18,.72,t));
        warm=mix(warm,vec3(1.,.92,.76),smoothstep(.72,1.30,t));
        vec3 cool=mix(vec3(.04,.16,.37),vec3(.56,.85,1.),smoothstep(.15,1.10,t));
        return mix(warm,cool,uPalette);
      }
      // Star cells on the direction sphere: each cell lights one gaussian star, rarity skews magnitudes.
      vec3 starLayer(vec3 dir,float scale,float rarity,float sharpness,float weight,float bandBoost,vec3 bandNormal) {
        vec3 cell=floor(dir*scale);
        vec3 random=hash33(cell+vec3(scale*.017));
        // Radial projection puts the star on the sphere, so every cell renders; d2 is squared angular distance.
        vec3 star=normalize(cell+.2+.6*random);
        float magnitude=hash13(cell+vec3(rarity*.031));
        float band=exp(-pow(dot(dir,bandNormal)*3.4,2.));
        vec3 tint=mix(vec3(.66,.76,1.),vec3(1.,.82,.62),random.x);
        return tint*(exp(-dot(dir-star,dir-star)*sharpness)*pow(magnitude,rarity)*weight*(.3+band*bandBoost));
      }
      // Sky sampled with the escaped ray direction, so lensing bends star positions for free.
      vec3 skyColor(vec3 dir) {
        vec3 bandNormal=normalize(vec3(.88,.34,.33));
        // A narrow Milky-Way band leaves most of the sky near the deep-space base color.
        float band=exp(-pow(dot(dir,bandNormal)*3.4,2.));
        float large=vnoise(dir*2.6),fine=vnoise(dir*6.3+9.4);
        vec3 sky=vec3(.0032,.0044,.0082);
        sky+=band*(.5+.5*fine)*mix(vec3(.07,.10,.185),vec3(.15,.10,.07),large)*(.42+.6*large);
        sky+=starLayer(dir,17.,15.,870000.,1.1,.8,bandNormal);
        sky+=starLayer(dir,38.,22.,1600000.,.5,1.8,bandNormal);
        sky+=starLayer(dir,62.,30.,2100000.,.32,2.6,bandNormal);
        return sky;
      }
      vec4 emission(vec4 hit) {
        if(hit.x<=uInner||hit.x>=uOuter)return vec4(0.);
        float q=(hit.x-uInner)/(uOuter-uInner);
        float textureRadius=(q*255.+.5)/256.;
        float flux=texture(uFlux,vec2(textureRadius,.5)).r;
        float atlasAngle=(fract(hit.y/6.28318530718+.5)*1024.+2.)/1028.;
        float grain=texture(uAtlas,vec2(atlasAngle,q)).r;
        float coverage=.12+.55*grain;
        float opacity=1.-exp(-coverage*.65/max(hit.w,.075));
        float g=clamp(hit.z,.025,4.);
        float temperature=pow(max(flux,0.),.25)*g;
        // I_nu/nu^3 is invariant; the bolometric blackbody intensity scales as g^4.
        float brightness=flux*g*g*g*g*(.35+.85*sqrt(grain+.02));
        return vec4(spectrum(temperature)*brightness*opacity,opacity);
      }
      vec4 shade(ivec2 coordinate) {
        ivec2 dimensions=textureSize(uFirst,0);
        coordinate=clamp(coordinate,ivec2(0),dimensions-1);
        vec4 front=emission(texelFetch(uFirst,coordinate,0));
        vec4 back=emission(texelFetch(uSecond,coordinate,0));
        // Alpha carries the joint transmittance so the sky shows through thin disk regions.
        return vec4(front.rgb+(1.-front.a)*back.rgb,(1.-front.a)*(1.-back.a));
      }
      void main() {
        vec2 pixel=vUv*vec2(textureSize(uFirst,0))-.5;
        ivec2 base=ivec2(floor(pixel));vec2 f=fract(pixel);
        // Interpolate resolved light, rather than polar coordinates across the phi seam or shadow.
        vec4 a=mix(shade(base),shade(base+ivec2(1,0)),f.x);
        vec4 b=mix(shade(base+ivec2(0,1)),shade(base+ivec2(1,1)),f.x);
        vec4 light=mix(a,b,f.y);
        vec4 escape=texture(uSky,vUv);
        float open=smoothstep(.25,.75,escape.w);
        vec3 direction=escape.xyz/max(length(escape.xyz),1e-3);
        color=vec4(light.rgb+light.a*open*skyColor(direction),1.);
      }
    `;
    const displayFragment=`#version 300 es
      precision highp float;
      in vec2 vUv;
      out vec4 color;
      uniform sampler2D uImage;
      uniform vec2 uTexel;
      vec3 bright(vec2 uv){vec3 c=texture(uImage,uv).rgb;return max(c-vec3(.6),vec3(0.));}
      void main() {
        vec3 light=texture(uImage,vUv).rgb;
        vec3 bloom=(bright(vUv+uTexel*vec2(3.,0.))+bright(vUv-uTexel*vec2(3.,0.))
                   +bright(vUv+uTexel*vec2(0.,3.))+bright(vUv-uTexel*vec2(0.,3.)))*.08;
        vec3 mapped=vec3(1.)-exp(-(light+bloom)*2.4);
        // No base lift: the shadow stays truly black so it reads against the lensed sky.
        color=vec4(pow(mapped,vec3(.72)),1.);
      }
    `;

    const objects=[];
    function shader(type,source) {
      const item=gl.createShader(type);gl.shaderSource(item,source);gl.compileShader(item);
      if(!gl.getShaderParameter(item,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(item);gl.deleteShader(item);throw new Error(message);}
      return item;
    }
    function program(v,f,names) {
      const item=gl.createProgram(),stages=[shader(gl.VERTEX_SHADER,v),shader(gl.FRAGMENT_SHADER,f)];
      stages.forEach(stage=>gl.attachShader(item,stage));gl.linkProgram(item);stages.forEach(stage=>gl.deleteShader(stage));
      if(!gl.getProgramParameter(item,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(item));
      objects.push(["program",item]);
      return {item,uniform:Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(item,name)]))};
    }
    const traceProgram=program(vertex,traceFragment,["uExtent","uOrigin","uObserver","uRight","uUp","uForward","uDistance","uSpin","uHorizon","uInner","uOuter","uStepScale","uSteps"]);
    const atlasProgram=program(atlasVertex,atlasFragment,["uInner","uOuter","uSpin","uTime","uYaw"]);
    const emitProgram=program(vertex,emitFragment,["uFirst","uSecond","uAtlas","uFlux","uSky","uInner","uOuter","uPalette"]);
    const displayProgram=program(vertex,displayFragment,["uImage","uTexel"]);
    const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);objects.push(["buffer",quad]);
    const seeds=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,seeds);gl.bufferData(gl.ARRAY_BUFFER,particles,gl.STATIC_DRAW);objects.push(["buffer",seeds]);
    function texture(width,height,filter=gl.LINEAR,data=null) {
      const item=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,item);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,width,height,0,gl.RGBA,gl.FLOAT,data);objects.push(["texture",item]);return item;
    }
    function target(width,height,count=1,filter=gl.LINEAR) {
      const framebuffer=gl.createFramebuffer(),images=[];gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      for(let i=0;i<count;i++){const image=texture(width,height,filter);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,image,0);images.push(image);}
      gl.drawBuffers(images.map((_,i)=>gl.COLOR_ATTACHMENT0+i));
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error("Float render target unavailable");
      objects.push(["framebuffer",framebuffer]);return {framebuffer,images,width,height};
    }
    function discard(value) {
      if(!value)return;
      gl.deleteFramebuffer(value.framebuffer);value.images.forEach(image=>gl.deleteTexture(image));
      // Removed targets are not retained in the resource ledger during repeated camera changes.
      const gone=new Set([value.framebuffer,...value.images]);
      for(let i=objects.length-1;i>=0;i--)if(gone.has(objects[i][1]))objects.splice(i,1);
    }
    const atlas=target(1028,512);
    const fluxTexture=texture(256,1);
    let map=null,image=null,geometryKey="",profileKey="",refined=false,refineAt=0,timer=0,disposed=false,forceRefinement=false;
    let viewport={width:1,height:1,scale:1};
    const maxTargetSize=Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    function imageDimensions(size) {
      // Keep Retina detail through composition, while bounding per-frame work and texture limits.
      const scale=Math.min(1,2560/size.width,1440/size.height,maxTargetSize/size.width,maxTargetSize/size.height);
      return {width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))};
    }
    function bindQuad(program) {
      gl.useProgram(program.item);gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    }
    function sampler(program,name,unit,item) {
      gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,item);gl.uniform1i(program.uniform[name],unit);
    }
    function updateProfile(model) {
      const key=`${model.spin}:${model.outer}`;if(key===profileKey)return;
      profileKey=key;const profile=physics.diskProfile(model.spin,model.outer),data=new Float32Array(256*4);
      profile.flux.forEach((value,i)=>{data[i*4]=value;data[i*4+3]=1;});
      gl.bindTexture(gl.TEXTURE_2D,fluxTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,1,gl.RGBA,gl.FLOAT,data);
    }
    function traceMap(model,high) {
      const started=performance.now(),aspect=viewport.width/viewport.height;
      // A small viewport never traces more samples than its actual composed image can display.
      const output=imageDimensions(viewport),budget=Math.min(high?1200000:160000,output.width*output.height);
      let height=Math.max(64,Math.floor(Math.sqrt(budget/aspect))),width=Math.max(64,Math.floor(height*aspect));
      const fit=Math.min(1,maxTargetSize/width,maxTargetSize/height);
      width=Math.max(1,Math.floor(width*fit));height=Math.max(1,Math.floor(height*fit));
      if(!map||map.width!==width||map.height!==height){discard(map);map=target(width,height,3,gl.LINEAR);}
      gl.bindFramebuffer(gl.FRAMEBUFFER,map.framebuffer);gl.viewport(0,0,width,height);gl.disable(gl.BLEND);bindQuad(traceProgram);
      const camera=geodesics.observer(model.spin,state.tilt),u=traceProgram.uniform;
      gl.uniform2f(u.uExtent,viewport.width/viewport.scale,viewport.height/viewport.scale);
      gl.uniform3fv(u.uOrigin,camera.origin);gl.uniform4fv(u.uObserver,camera.u);
      gl.uniform4fv(u.uRight,camera.basis[0]);gl.uniform4fv(u.uUp,camera.basis[1]);gl.uniform4fv(u.uForward,camera.basis[2]);
      for(const [key,value] of Object.entries({uDistance:camera.distance,uSpin:model.spin,uHorizon:model.horizon,uInner:model.isco,uOuter:model.outer,uStepScale:high ? .065 : .11}))gl.uniform1f(u[key],value);
      gl.uniform1i(u.uSteps,high?320:224);gl.drawArrays(gl.TRIANGLES,0,6);
      metrics.geodesicBuilds++;metrics.traceWidth=width;metrics.traceHeight=height;metrics.traceSubmitMs=performance.now()-started;
      metrics.traceQuality=high?"refined":"interactive";metrics.traceBudget=budget;
    }
    function ensureGeometry(model) {
      const key=[model.spin,state.tilt,state.zoom,viewport.width,viewport.height,model.isco,model.outer].join(":");
      if(key!==geometryKey) {
        geometryKey=key;refined=forceRefinement;
        clearTimeout(timer);traceMap(model,refined);refineAt=performance.now()+140;
        // Drag release can bypass the coarse pass, including while playback is paused.
        if(!refined)timer=setTimeout(()=>{if(!disposed)onNeedsFrame();},150);
      } else if(!refined&&(forceRefinement||performance.now()>=refineAt)) {traceMap(model,true);refined=true;}
      forceRefinement=false;
    }
    return {
      kind:"webgl",count:()=>state.density,metrics,
      draw(size) {
        if(disposed)return;
        viewport=size;const model=physics.model(state);updateProfile(model);ensureGeometry(model);
        const {width,height}=imageDimensions(size);
        metrics.canvasWidth=size.width;metrics.canvasHeight=size.height;metrics.imageWidth=width;metrics.imageHeight=height;
        if(!image||image.width!==width||image.height!==height){discard(image);image=target(width,height);}
        gl.bindFramebuffer(gl.FRAMEBUFFER,atlas.framebuffer);gl.viewport(0,0,atlas.width,atlas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(atlasProgram.item);gl.bindBuffer(gl.ARRAY_BUFFER,seeds);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,0,0);
        for(const [key,value] of Object.entries({uInner:model.isco,uOuter:model.outer,uSpin:model.spin,uTime:state.time,uYaw:state.yaw}))gl.uniform1f(atlasProgram.uniform[key],value);
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
        // Seam replicas are the same source particles, not extra particles in the UI count.
        gl.drawArraysInstanced(gl.POINTS,0,state.density,3);gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER,image.framebuffer);gl.viewport(0,0,width,height);bindQuad(emitProgram);
        sampler(emitProgram,"uFirst",0,map.images[0]);sampler(emitProgram,"uSecond",1,map.images[1]);sampler(emitProgram,"uAtlas",2,atlas.images[0]);sampler(emitProgram,"uFlux",3,fluxTexture);sampler(emitProgram,"uSky",4,map.images[2]);
        gl.uniform1f(emitProgram.uniform.uInner,model.isco);gl.uniform1f(emitProgram.uniform.uOuter,model.outer);gl.uniform1f(emitProgram.uniform.uPalette,state.palette==="ice"?1:0);gl.drawArrays(gl.TRIANGLES,0,6);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,size.width,size.height);bindQuad(displayProgram);sampler(displayProgram,"uImage",0,image.images[0]);gl.uniform2f(displayProgram.uniform.uTexel,1/width,1/height);gl.drawArrays(gl.TRIANGLES,0,6);
        metrics.frames++;
      },
      refine() {
        if(disposed)return;
        clearTimeout(timer);forceRefinement=true;metrics.refinementRequests++;onNeedsFrame();
      },
      dispose() {
        disposed=true;clearTimeout(timer);
        for(const [type,item] of objects){if(type==="texture")gl.deleteTexture(item);else if(type==="framebuffer")gl.deleteFramebuffer(item);else if(type==="program")gl.deleteProgram(item);else gl.deleteBuffer(item);}
      }
    };
  }
  globalThis.BlackHoleRaytracer=Object.freeze({create});
})();
