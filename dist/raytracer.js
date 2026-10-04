"use strict";

(() => {
  function create({canvas,particles,state,physics,onNeedsFrame}) {
    const gl=canvas.getContext("webgl2",{alpha:false,antialias:false,powerPreference:"high-performance"});
    if(!gl||!gl.getExtension("EXT_color_buffer_float"))return null;
    const geodesics=globalThis.BlackHoleGeodesics;
    const navigation=globalThis.BlackHoleNavigation;
    const imageLayers=6,projectionRows=256;
    const metrics={mode:"webgl2-kerr-particles",diskRendering:"instanced-particles",frames:0,geodesicBuilds:0,projectionBuilds:0,particleInstances:0,traceWidth:0,traceHeight:0,traceSubmitMs:0,traceQuality:"interactive",traceBudget:0,canvasWidth:0,canvasHeight:0,imageWidth:0,imageHeight:0,refinementRequests:0,observerDistance:80,orbitAngle:0,horizonFade:0,frameMs:0,interactiveBudget:240000,centerPixels:0};
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
      // Foveal refinement remaps the shared pinhole camera onto a screen-center sub-rectangle.
      uniform vec2 uUvOffset,uUvScale;
      uniform vec3 uOrigin;
      uniform vec4 uObserver,uRight,uUp,uForward;
      uniform float uDistance,uSpin,uHorizon,uInner,uIsco,uOuter,uStepScale;
      uniform vec2 uPlungeConstants;
      uniform int uSteps;
      ${geodesics.glsl}
      ${physics.flowGlsl}
      vec4 record(vec3 x,vec3 p,float energy,int order) {
        float r=metric(x,uSpin).r;
        // The invariant contraction includes radial infall below ISCO; extending
        // the circular-orbit formula to the horizon would give invalid velocities.
        vec4 emitter=emitterKS(x,r,uSpin,uIsco,uPlungeConstants);
        float emittedEnergy=dot(p,emitter.xyz)+energy*emitter.w;
        if(emittedEnergy<=0.)return vec4(-1.,0.,0.,1.);
        float shift=1./emittedEnergy;
        // Preserve the raw plane-crossing order, including crossings outside the
        // emitting region. It separates distinct lensed images in the inverse map.
        return vec4(r,atan(x.y,x.x),shift,2.*float(order)+min(1.,abs(p.z)*shift));
      }
      void main() {
        firstHit=vec4(-1.,0.,0.,1.);secondHit=firstHit;
        // Escaping rays carry their asymptotic direction so the sky is sampled where the light came from.
        skyHit=vec4(0.,0.,0.,0.);
        vec2 impact=(uUvOffset+vUv*uUvScale-.5)*uExtent;
        vec3 direction=normalize(vec3(impact/uDistance,1.));
        vec4 velocity=-uObserver+direction.x*uRight+direction.y*uUp+direction.z*uForward;
        Geometry initial=metric(uOrigin,uSpin);
        vec4 light=vec4(initial.n,1.);
        vec4 momentum=vec4(velocity.xyz,-velocity.w)+initial.f*dot(light,velocity)*light;
        vec3 x=uOrigin,p=momentum.xyz;
        float energy=momentum.w;
        int hits=0,crossings=0;
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
            int order=crossings++;
            float fraction=oldX.z/(oldX.z-x.z);
            vec3 position=mix(oldX,x,fraction),covector=mix(oldP,p,fraction);
            float radius=metric(position,uSpin).r;
            if(radius>uInner&&radius<uOuter) {
              vec4 hit=record(position,covector,energy,order);
              if(hit.x>0.) {
                if(hits==0)firstHit=hit;else if(hits==1)secondHit=hit;
                hits++;
                // The two-hit cache limits disk emission, not the ray's endpoint.
                // Continue to capture/escape so translucent disk light retains its
                // background; later Kerr crossings must not overwrite the second hit.
              }
            }
          }
        }
        // The sky direction is the coordinate velocity dx/dlambda = p - f k n, not the
        // covariant momentum p. At the r>95 cutoff the two differ by ~0.5 degrees, which
        // would displace the lensed star field and the arcs near the shadow; the CPU
        // check asserts this same expression against the far-field asymptote.
        if(escaped){Geometry exit=metric(x,uSpin);float k=dot(exit.n,p)-energy;skyHit=vec4(normalize(p-exit.f*k*exit.n),1.);}
      }
    `;
    const projectionVertex=`#version 300 es
      precision highp float;
      precision highp int;
      uniform sampler2D uHits;
      uniform vec2 uUvOffset,uUvScale;
      uniform float uInner,uOuter,uLayers;
      out vec4 vProjection;
      const ivec2 corners[6]=ivec2[6](ivec2(0,0),ivec2(1,0),ivec2(0,1),ivec2(0,1),ivec2(1,0),ivec2(1,1));
      void main() {
        ivec2 size=textureSize(uHits,0);int cell=gl_VertexID/6,corner=gl_VertexID%6,triangle=(corner/3)*3;
        ivec2 base=ivec2(cell%(size.x-1),cell/(size.x-1));
        vec4 a=texelFetch(uHits,base+corners[triangle],0),b=texelFetch(uHits,base+corners[triangle+1],0),c=texelFetch(uHits,base+corners[triangle+2],0);
        float layer=floor(a.w*.5),angle=a.y/6.28318530718+.5;
        float db=fract((b.y-a.y)/6.28318530718+.5)-.5,dc=fract((c.y-a.y)/6.28318530718+.5)-.5;
        // Never join an emitting ray to a missing hit, another image, or a
        // discontinuity. Such triangles would stretch particles across the shadow.
        bool valid=a.x>uInner&&b.x>uInner&&c.x>uInner&&layer<uLayers;
        valid=valid&&floor(b.w*.5)==layer&&floor(c.w*.5)==layer;
        valid=valid&&max(abs(db),abs(dc))<.2&&max(abs(b.x-a.x),abs(c.x-a.x))<(uOuter-uInner)*.15;
        if(!valid){gl_Position=vec4(2.,2.,2.,1.);vProjection=vec4(0.);return;}
        vec4 hit=corner%3==0?a:corner%3==1?b:c;
        angle+=corner%3==0?0.:corner%3==1?db:dc;
        float q=(hit.x-uInner)/(uOuter-uInner);
        // Geometry data only: screen coordinate, frequency shift and incidence.
        // No particle color, opacity, density or time is ever baked into this map.
        vProjection=vec4(uUvOffset+(vec2(base+corners[corner])+.5)/vec2(size)*uUvScale,hit.z,hit.w-2.*layer);
        float x=(angle*1024.+2.+float(gl_InstanceID-1)*1024.)/1028.;
        gl_Position=vec4(x*2.-1.,(layer+q)/uLayers*2.-1.,0.,1.);
      }
    `;
    const projectionFragment=`#version 300 es
      precision highp float;
      in vec4 vProjection;
      out vec4 color;
      void main(){color=vProjection;}
    `;
    const particleVertex=`#version 300 es
      precision highp float;
      precision highp int;
      layout(location=0) in vec2 aCorner;
      layout(location=1) in vec4 aSeed;
      uniform sampler2D uProjection,uCenterProjection,uFlux,uPlunge;
      uniform vec2 uUvOffset,uUvScale,uImageSize;
      uniform float uInner,uIsco,uOuter,uSpin,uTime,uDuration,uViewYaw,uCenterMix;
      uniform int uLayer;
      out vec2 vCorner;
      out vec3 vLight;
      out float vWeight,vMu,vEdge;
      vec4 sampleMap(sampler2D map,vec2 source) {
        const int rows=${projectionRows};
        vec2 cell=vec2(fract(source.x)*1024.,clamp(source.y,0.,1.)*float(rows))-.5;
        ivec2 base=ivec2(floor(cell));vec2 f=fract(cell);
        vec4 sum=vec4(0.);float weight=0.;
        // Renormalize valid neighbors instead of interpolating a blank texel's
        // zero screen coordinate into a particle position near an image boundary.
        for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
          float w=(x==0?1.-f.x:f.x)*(y==0?1.-f.y:f.y);
          ivec2 p=ivec2(base.x+x+2,clamp(base.y+y,0,rows-1)+uLayer*rows);
          vec4 value=texelFetch(map,p,0);
          if(value.z>0.){sum+=value*w;weight+=w;}
        }
        return weight>.15?sum/weight:vec4(0.);
      }
      vec4 projection(vec2 source) {
        vec4 coarse=sampleMap(uProjection,source);
        if(uCenterMix>0.) {
          vec4 fine=sampleMap(uCenterProjection,source);
          if(fine.z>0.) {
            vec2 focus=(fine.xy-uUvOffset)/uUvScale;
            vec2 edge=smoothstep(vec2(0.),vec2(.03),focus)*(1.-smoothstep(vec2(.97),vec2(1.),focus));
            float mask=uCenterMix*edge.x*edge.y;
            if(coarse.z<=0.)return mask>.5?fine:coarse;
            return mix(coarse,fine,mask);
          }
        }
        return coarse;
      }
      vec3 spectrum(float temperature) {
        float t=clamp(temperature,0.,1.6);
        vec3 warm=mix(vec3(.62,.045,.006),vec3(1.,.48,.12),smoothstep(.18,.72,t));
        return mix(warm,vec3(1.,.92,.76),smoothstep(.72,1.30,t));
      }
      void main() {
        float t=uTime*${physics.flow.clockScale.toFixed(8)},r=mix(uIsco,uOuter,aSeed.x),phase=aSeed.y+t/(pow(r,1.5)+uSpin);
        // One fifth of the source particles follow a stationary, recycled inflow.
        // Reset happens at the dim near-horizon endpoint, never on a bright orbit.
        if(gl_InstanceID%${physics.flow.plungeStride}==0) {
          float age=fract(aSeed.w+t/uDuration),i=age*511.;int lo=int(floor(i));
          vec4 path=mix(texelFetch(uPlunge,ivec2(lo,0),0),texelFetch(uPlunge,ivec2(min(lo+1,511),0),0),fract(i));
          r=path.x;phase=aSeed.y+(t-age*uDuration)/(pow(uIsco,1.5)+uSpin)+path.y;
        }
        float q=(r-uInner)/(uOuter-uInner);
        vec2 source=vec2(fract((phase-uViewYaw)/6.28318530718+.5),q);
        vec4 hit=projection(source);
        vCorner=aCorner;vLight=vec3(0.);vWeight=0.;vMu=1.;vEdge=0.;
        if(hit.z<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
        // The local Jacobian maps a small particle ellipse through the actual
        // Kerr image. Instanced quads avoid hardware point-size limits near a caustic.
        vec4 left=projection(source-vec2(1./1024.,0.)),right=projection(source+vec2(1./1024.,0.));
        vec4 low=projection(source-vec2(0.,1./${projectionRows}.)),high=projection(source+vec2(0.,1./${projectionRows}.));
        if(left.z<=0.)left=hit;if(right.z<=0.)right=hit;if(low.z<=0.)low=hit;if(high.z<=0.)high=hit;
        float size=2.2+aSeed.w*1.8;
        vec2 along=(right.xy-left.xy)*size*.25/.55,across=(high.xy-low.xy)*size*.25*${projectionRows}./512.;
        // Bound singular magnification without adding a flat opaque disk surface.
        float extent=max(length(along*uImageSize),length(across*uImageSize));
        float fit=min(1.,48./max(extent,1.));along*=fit;across*=fit;
        gl_Position=vec4((hit.xy+aCorner.x*along+aCorner.y*across)*2.-1.,0.,1.);
        float flux=texture(uFlux,vec2((q*511.+.5)/512.,.5)).r,g=clamp(hit.z,0.,4.);
        vWeight=.35+aSeed.w*.65;vMu=hit.w;
        vEdge=1.-smoothstep(.88,1.,q);
        // Bolometric intensity scales as g^4. There is no minimum g or opacity
        // floor: distant observers receive vanishing light from the horizon.
        vLight=spectrum(pow(max(flux,0.),.25)*g)*flux*g*g*g*g*(.35+.85*sqrt(vWeight*.8+.02));
      }
    `;
    const particleFragment=`#version 300 es
      precision highp float;
      in vec2 vCorner;
      in vec3 vLight;
      in float vWeight,vMu,vEdge;
      out vec4 color;
      void main() {
        float kernel=exp(-dot(vCorner,vCorner)*5.)*(1.-smoothstep(.85,1.,max(abs(vCorner.x),abs(vCorner.y))));
        float opacity=1.-exp(-.65*.55*.8*vWeight*kernel*vEdge/max(vMu,.075));
        color=vec4(vLight*opacity,opacity);
      }
    `;
    const emitFragment=`#version 300 es
      precision highp float;
      precision highp int;
      in vec2 vUv;
      out vec4 color;
      uniform sampler2D uSky;
      // Foveal overlay: the screen-center rectangle the refined pass retraced; zero mix disables it.
      uniform sampler2D uCenterSky;
      uniform vec2 uUvOffset,uUvScale;
      uniform float uViewYaw,uCenterMix;
      float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
      vec3 hash33(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
      float vnoise(vec3 p){
        vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(hash13(i),hash13(i+vec3(1.,0.,0.)),f.x),mix(hash13(i+vec3(0.,1.,0.)),hash13(i+vec3(1.,1.,0.)),f.x),f.y),
                   mix(mix(hash13(i+vec3(0.,0.,1.)),hash13(i+vec3(1.,0.,1.)),f.x),mix(hash13(i+vec3(0.,1.,1.)),hash13(i+vec3(1.,1.,1.)),f.x),f.y),f.z);
      }
      // Milky-Way helpers shared by dust and stars: a gaussian plane, dark dust rifts
      // along it, and a bulge toward one galactic-center direction on the great circle.
      float bandProfile(vec3 dir,vec3 bandNormal){return exp(-pow(dot(dir,bandNormal)*4.8,2.));}
      float bandDust(vec3 dir){return .3+.7*smoothstep(.24,.8,vnoise(dir*7.5+3.7));}
      float bandCenter(vec3 dir){return .55+.75*smoothstep(-.25,.95,dot(dir,normalize(vec3(-.42,.62,.66))));}
      // Star cells on the direction sphere: each cell lights one gaussian star, rarity skews magnitudes.
      // The galactic-band weight is identical for all three layers, so skyColor evaluates it once
      // per pixel and passes it down rather than repeating the dust noise in every layer.
      vec3 starLayer(vec3 dir,float scale,float rarity,float sharpness,float weight,float bandBoost,float band) {
        vec3 cell=floor(dir*scale);
        vec3 random=hash33(cell+vec3(scale*.017));
        // Radial projection puts the star on the sphere, so every cell renders; d2 is squared angular distance.
        vec3 star=normalize(cell+.2+.6*random);
        float magnitude=hash13(cell+vec3(rarity*.031));
        // Coarse blackbody spread: mostly blue-white to warm white with a thin red-giant tail.
        float temperature=hash13(cell+vec3(31.7));
        vec3 tint=mix(vec3(.66,.76,1.),vec3(1.,.86,.72),temperature);
        tint=mix(tint,vec3(1.,.6,.4),smoothstep(.86,1.,temperature));
        return tint*(exp(-dot(dir-star,dir-star)*sharpness)*pow(magnitude,rarity)*weight*(.3+band*bandBoost));
      }
      // Sky sampled with the escaped ray direction, so lensing bends star positions for free.
      vec3 skyColor(vec3 dir) {
        vec3 bandNormal=normalize(vec3(.88,.34,.33));
        float large=vnoise(dir*2.6),fine=vnoise(dir*6.3+9.4);
        // Dust lanes and the bulge retain their structure, but diffuse light needs a
        // much lower gain than compact stars before the shared exposure/gamma curve.
        // The same weight drives the star layers, so it is computed once here.
        float band=bandProfile(dir,bandNormal)*bandDust(dir)*bandCenter(dir);
        const float diffuseSkyGain=.04;
        vec3 sky=vec3(.00012,.00016,.00028);
        sky+=diffuseSkyGain*band*(.5+.5*fine)*mix(vec3(.055,.078,.144),vec3(.117,.078,.055),large)*(.42+.6*large);
        sky+=starLayer(dir,17.,15.,870000.,1.1,.8,band);
        sky+=starLayer(dir,38.,22.,1600000.,.5,1.8,band);
        sky+=starLayer(dir,62.,30.,2100000.,.32,2.6,band);
        return sky;
      }
      void main() {
        vec4 escape=texture(uSky,vUv);
        if(uCenterMix>0.) {
          // Blend the refined foveal rectangle over the coarse map across a feathered seam.
          vec2 focus=(vUv-uUvOffset)/uUvScale;
          vec2 edge=smoothstep(vec2(0.),vec2(.03),focus)*(1.-smoothstep(vec2(.97),vec2(1.),focus));
          float mask=uCenterMix*edge.x*edge.y;
          if(mask>0.)escape=mix(escape,texture(uCenterSky,focus),mask);
        }
        // Use the full bilinear ramp of the escape flag so the silhouette keeps a soft antialiased edge.
        float open=smoothstep(.02,.98,escape.w);
        vec3 direction=escape.xyz/max(length(escape.xyz),1e-3);
        // Kerr axial symmetry lets orbiting reuse ray maps: rotate world sky directions
        // and disk azimuths together while keeping local frequencies unchanged.
        float c=cos(uViewYaw),s=sin(uViewYaw);
        direction=vec3(c*direction.x-s*direction.y,s*direction.x+c*direction.y,direction.z);
        // Draw the sky first; the only disk opacity comes from actual particle
        // fragments drawn later. Empty space never becomes a dark absorbing sheet.
        color=vec4(open*skyColor(direction),1.);
      }
    `;
    const displayFragment=`#version 300 es
      precision highp float;
      in vec2 vUv;
      out vec4 color;
      uniform sampler2D uImage;
      uniform vec2 uTexel;
      uniform float uDiveFade;
      vec3 bright(vec2 uv,float threshold){vec3 c=texture(uImage,uv).rgb;return max(c-vec3(threshold),vec3(0.));}
      void main() {
        vec3 light=texture(uImage,vUv).rgb;
        // Two-scale bloom: the tight core keeps the photon ring crisp, the wide halo
        // melts ring and disk rim into the sky so the silhouette reads soft.
        vec3 bloom=(bright(vUv+uTexel*vec2(3.,0.),.6)+bright(vUv-uTexel*vec2(3.,0.),.6)
                   +bright(vUv+uTexel*vec2(0.,3.),.6)+bright(vUv-uTexel*vec2(0.,3.),.6))*.08;
        vec3 halo=(bright(vUv+uTexel*vec2(9.,0.),.3)+bright(vUv-uTexel*vec2(9.,0.),.3)
                  +bright(vUv+uTexel*vec2(0.,9.),.3)+bright(vUv-uTexel*vec2(0.,9.),.3)
                  +bright(vUv+uTexel*vec2(7.,7.),.3)+bright(vUv-uTexel*vec2(7.,7.),.3)
                  +bright(vUv+uTexel*vec2(7.,-7.),.3)+bright(vUv-uTexel*vec2(7.,-7.),.3))*.028;
        vec3 mapped=vec3(1.)-exp(-(light+bloom+halo)*2.4);
        // No base lift: the shadow stays truly black so it reads against the lensed sky.
        // The horizon crossing is a cinematic endpoint; reversing zoom restores the scene.
        color=vec4(pow(mapped,vec3(.72))*(1.-uDiveFade),1.);
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
    const traceProgram=program(vertex,traceFragment,["uExtent","uUvOffset","uUvScale","uOrigin","uObserver","uRight","uUp","uForward","uDistance","uSpin","uHorizon","uInner","uIsco","uPlungeConstants","uOuter","uStepScale","uSteps"]);
    const projectionProgram=program(projectionVertex,projectionFragment,["uHits","uUvOffset","uUvScale","uInner","uOuter","uLayers"]);
    const particleProgram=program(particleVertex,particleFragment,["uProjection","uCenterProjection","uFlux","uPlunge","uUvOffset","uUvScale","uImageSize","uInner","uIsco","uOuter","uSpin","uTime","uDuration","uViewYaw","uCenterMix","uLayer"]);
    const emitProgram=program(vertex,emitFragment,["uSky","uCenterSky","uCenterMix","uUvOffset","uUvScale","uViewYaw"]);
    const displayProgram=program(vertex,displayFragment,["uImage","uTexel","uDiveFade"]);
    const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);objects.push(["buffer",quad]);
    const seeds=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,seeds);gl.bufferData(gl.ARRAY_BUFFER,particles,gl.STATIC_DRAW);objects.push(["buffer",seeds]);
    const sprite=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,sprite);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);objects.push(["buffer",sprite]);
    function texture(width,height,filter=gl.LINEAR,data=null,format=gl.RGBA16F) {
      const item=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,item);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,gl.RGBA,gl.FLOAT,data);objects.push(["texture",item]);return item;
    }
    function target(width,height,count=1,filter=gl.LINEAR,format=gl.RGBA16F) {
      const framebuffer=gl.createFramebuffer(),images=[];gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      for(let i=0;i<count;i++){const image=texture(width,height,filter,null,format);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0+i,gl.TEXTURE_2D,image,0);images.push(image);}
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
    const fluxTexture=texture(512,1),plungeTexture=texture(512,1,gl.NEAREST,null,gl.RGBA32F);
    let map=null,image=null,geometryKey="",profileKey="",refined=false,refineAt=0,timer=0,disposed=false,forceRefinement=false;
    // Foveal state plus the adaptive interactive budget ladder (rung = target coarse pixels).
    let center=null,projection=null,centerProjection=null,plunge=null,centerActive=false,centerRect=[0,0,1,1],lastTraceQuality=null;
    let rung=240000,emaSeconds=null,coarseFrames=0,lastCoarseAt=0,adaptCooldown=0;
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
      profileKey=key;const profile=physics.emissionProfile(model.spin,model.outer),data=new Float32Array(512*4);
      profile.flux.forEach((value,i)=>{data[i*4]=value;data[i*4+3]=1;});
      gl.bindTexture(gl.TEXTURE_2D,fluxTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,512,1,gl.RGBA,gl.FLOAT,data);
      plunge=physics.plungeProfile(model.spin);
      gl.bindTexture(gl.TEXTURE_2D,plungeTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,512,1,gl.RGBA,gl.FLOAT,plunge.data);
    }
    function projectMap(source,destination,model,rectangle) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,destination.framebuffer);gl.viewport(0,0,destination.width,destination.height);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.BLEND);
      gl.useProgram(projectionProgram.item);gl.disableVertexAttribArray(0);gl.disableVertexAttribArray(1);
      const u=projectionProgram.uniform;
      gl.uniform2f(u.uUvOffset,rectangle[0],rectangle[1]);gl.uniform2f(u.uUvScale,rectangle[2],rectangle[3]);
      gl.uniform1f(u.uInner,model.emissionInner);gl.uniform1f(u.uOuter,model.outer);gl.uniform1f(u.uLayers,imageLayers);
      // Rasterize the inverse geometry once per camera/model change. Periodic
      // guard copies contain geometry only and do not increase source particle count.
      for(const hits of source.images.slice(0,2)) {
        sampler(projectionProgram,"uHits",0,hits);
        gl.drawArraysInstanced(gl.TRIANGLES,0,(source.width-1)*(source.height-1)*6,3);
      }
      metrics.projectionBuilds++;
    }
    function traceMap(model,high) {
      const started=performance.now(),aspect=viewport.width/viewport.height;
      // A small viewport never traces more samples than its actual composed image can display.
      // The interactive rung adapts to measured frame cost; refinement scales with capability.
      const output=imageDimensions(viewport);
      const budget=Math.min(high?Math.max(1200000,Math.min(rung*2,2560000)):rung,output.width*output.height);
      let height=Math.max(64,Math.floor(Math.sqrt(budget/aspect))),width=Math.max(64,Math.floor(height*aspect));
      const fit=Math.min(1,maxTargetSize/width,maxTargetSize/height);
      width=Math.max(1,Math.floor(width*fit));height=Math.max(1,Math.floor(height*fit));
      if(!map||map.width!==width||map.height!==height){discard(map);map=target(width,height,3,gl.LINEAR);}
      gl.bindFramebuffer(gl.FRAMEBUFFER,map.framebuffer);gl.viewport(0,0,width,height);gl.disable(gl.BLEND);bindQuad(traceProgram);
      const flight=navigation.view(state.viewZoom??state.zoom,state.reducedMotion);
      const camera=geodesics.observer(model.spin,state.tilt,flight.distance),u=traceProgram.uniform;
      gl.uniform2f(u.uExtent,viewport.width/viewport.scale,viewport.height/viewport.scale);
      gl.uniform2f(u.uUvOffset,0,0);gl.uniform2f(u.uUvScale,1,1);
      gl.uniform3fv(u.uOrigin,camera.origin);gl.uniform4fv(u.uObserver,camera.u);
      gl.uniform4fv(u.uRight,camera.basis[0]);gl.uniform4fv(u.uUp,camera.basis[1]);gl.uniform4fv(u.uForward,camera.basis[2]);
      gl.uniform2f(u.uPlungeConstants,plunge.constants.energy,plunge.constants.angularMomentum);
      for(const [key,value] of Object.entries({uDistance:camera.distance,uSpin:model.spin,uHorizon:model.horizon,uInner:model.emissionInner,uIsco:model.isco,uOuter:model.outer,uStepScale:high ? .065 : .09}))gl.uniform1f(u[key],value);
      gl.uniform1i(u.uSteps,high?320:256);gl.drawArrays(gl.TRIANGLES,0,6);
      metrics.geodesicBuilds++;metrics.traceWidth=width;metrics.traceHeight=height;metrics.traceSubmitMs=performance.now()-started;
      metrics.traceQuality=high?"refined":"interactive";metrics.traceBudget=budget;
      lastTraceQuality=metrics.traceQuality;centerActive=false;
      if(!high) {
        // Foveal overlay: retrace the screen-center rectangle at refined quality so the
        // photon ring stays crisp while dragging. The full map above is always traced
        // first, and refined frames replace the overlay entirely.
        const side=Math.max(160,Math.min(Math.round(Math.min(output.width,output.height)*.34),Math.round(480*Math.sqrt(rung/1200000))));
        if(!center||center.width!==side){discard(center);center=target(side,side,3,gl.LINEAR);}
        gl.bindFramebuffer(gl.FRAMEBUFFER,center.framebuffer);gl.viewport(0,0,side,side);
        centerRect=[.5-.5*side/output.width,.5-.5*side/output.height,side/output.width,side/output.height];
        gl.uniform2f(u.uUvOffset,centerRect[0],centerRect[1]);gl.uniform2f(u.uUvScale,centerRect[2],centerRect[3]);
        gl.uniform1f(u.uStepScale,.065);gl.uniform1i(u.uSteps,320);gl.drawArrays(gl.TRIANGLES,0,6);
        centerActive=true;metrics.centerPixels=side*side;
      } else metrics.centerPixels=0;
      // Separate image orders prevent a direct particle and its lensed copies
      // from overwriting one another. Float32 preserves subpixel screen positions.
      if(!projection)projection=target(1028,projectionRows*imageLayers,1,gl.NEAREST,gl.RGBA32F);
      projectMap(map,projection,model,[0,0,1,1]);
      if(centerActive) {
        if(!centerProjection)centerProjection=target(1028,projectionRows*imageLayers,1,gl.NEAREST,gl.RGBA32F);
        projectMap(center,centerProjection,model,centerRect);
      }
    }
    // The interactive budget follows measured frame cost: strong GPUs trace near-refined
    // maps while dragging; weak ones fall back toward the fixed floor of earlier builds.
    function adaptToFrameCost(frameSeconds) {
      metrics.interactiveBudget=rung;
      if(lastTraceQuality!=="interactive")return;
      const now=performance.now();
      if(lastCoarseAt&&now-lastCoarseAt<=200) {
        // Idle gaps must not poison the moving average, so a drag after a pause restarts it.
        const seconds=Math.max(0,Math.min(frameSeconds,.05));
        emaSeconds=emaSeconds===null?seconds:emaSeconds*.8+seconds*.2;
        if(adaptCooldown>0)adaptCooldown--;
        else if(++coarseFrames>=8) {
          coarseFrames=0;
          const ceiling=Math.min(1200000,imageDimensions(viewport).width*imageDimensions(viewport).height);
          if(emaSeconds>.024&&rung>160000){rung=Math.max(160000,Math.round(rung*.72));adaptCooldown=4;}
          else if(emaSeconds<.015&&rung<ceiling){rung=Math.min(ceiling,Math.round(rung*1.35));adaptCooldown=4;}
        }
      } else coarseFrames=0;
      metrics.frameMs=emaSeconds===null?0:emaSeconds*1000;
      lastCoarseAt=now;
    }
    function ensureGeometry(model) {
      const key=[model.spin,state.tilt,state.viewZoom??state.zoom,viewport.width,viewport.height,model.isco,model.outer].join(":");
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
      draw(size,frameSeconds=0) {
        if(disposed)return;
        viewport=size;const model=physics.model(state),flight=navigation.view(state.viewZoom??state.zoom,state.reducedMotion);updateProfile(model);lastTraceQuality=null;ensureGeometry(model);adaptToFrameCost(frameSeconds);
        metrics.observerDistance=flight.distance;metrics.orbitAngle=state.yaw+flight.orbit+(state.drift??0);metrics.horizonFade=flight.fade;
        const {width,height}=imageDimensions(size);
        metrics.canvasWidth=size.width;metrics.canvasHeight=size.height;metrics.imageWidth=width;metrics.imageHeight=height;
        if(!image||image.width!==width||image.height!==height){discard(image);image=target(width,height);}
        gl.bindFramebuffer(gl.FRAMEBUFFER,image.framebuffer);gl.viewport(0,0,width,height);bindQuad(emitProgram);
        sampler(emitProgram,"uSky",0,map.images[2]);
        // Foveal samplers stay bound to valid textures even while the overlay is off.
        sampler(emitProgram,"uCenterSky",1,center?center.images[2]:map.images[2]);
        gl.uniform2f(emitProgram.uniform.uUvOffset,centerRect[0],centerRect[1]);gl.uniform2f(emitProgram.uniform.uUvScale,centerRect[2],centerRect[3]);
        gl.uniform1f(emitProgram.uniform.uCenterMix,centerActive?1:0);
        const viewYaw=state.yaw+flight.orbit+(state.drift??0);
        gl.uniform1f(emitProgram.uniform.uViewYaw,viewYaw);gl.drawArrays(gl.TRIANGLES,0,6);
        // Direct instanced particles: each vertex evaluates its live orbit or
        // plunge, and each fragment evaluates its own Gaussian light and opacity.
        // The projection cache stores geometry, never a rendered disk texture.
        gl.useProgram(particleProgram.item);
        sampler(particleProgram,"uProjection",0,projection.images[0]);
        sampler(particleProgram,"uCenterProjection",1,(centerProjection||projection).images[0]);
        sampler(particleProgram,"uFlux",2,fluxTexture);sampler(particleProgram,"uPlunge",3,plungeTexture);
        const pu=particleProgram.uniform;
        gl.uniform2f(pu.uUvOffset,centerRect[0],centerRect[1]);gl.uniform2f(pu.uUvScale,centerRect[2],centerRect[3]);gl.uniform2f(pu.uImageSize,width,height);
        for(const [key,value] of Object.entries({uInner:model.emissionInner,uIsco:model.isco,uOuter:model.outer,uSpin:model.spin,uTime:state.time,uDuration:plunge.duration,uViewYaw:viewYaw,uCenterMix:centerActive?1:0}))gl.uniform1f(pu[key],value);
        gl.bindBuffer(gl.ARRAY_BUFFER,sprite);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ARRAY_BUFFER,seeds);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,4,gl.FLOAT,false,0,0);gl.vertexAttribDivisor(1,1);
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        // Far images first; source particles and lensed copies share one UI count.
        for(let layer=imageLayers-1;layer>=0;layer--){gl.uniform1i(pu.uLayer,layer);gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,state.density);}
        gl.disable(gl.BLEND);gl.disableVertexAttribArray(1);gl.vertexAttribDivisor(1,0);
        metrics.particleInstances=state.density;
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,size.width,size.height);bindQuad(displayProgram);sampler(displayProgram,"uImage",0,image.images[0]);gl.uniform2f(displayProgram.uniform.uTexel,1/width,1/height);gl.uniform1f(displayProgram.uniform.uDiveFade,flight.fade);gl.drawArrays(gl.TRIANGLES,0,6);
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
