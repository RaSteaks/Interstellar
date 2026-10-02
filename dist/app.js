"use strict";

(() => {
  const canvas = document.querySelector("#cosmos");
  const scene = document.querySelector("#scene");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const defaults = { tilt: 18, speed: 1, density: 24000, zoom: 1, palette: "amber", yaw: 0 };
  const state = { ...defaults, paused: reducedMotion.matches, time: 0 };
  let renderer;
  let frame = 0;
  let lastTime = 0;
  let size = { width: 1, height: 1, dpr: 1, center: [0.54, 0.52] };

  // Seeded randomness keeps particle positions stable across density and resize changes.
  function randomGenerator(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }
  const random = randomGenerator(81732);
  const particles = new Float32Array(40000 * 4);
  for (let i = 0; i < particles.length; i += 4) {
    particles[i] = Math.pow(random(), 1.65);
    particles[i + 1] = random() * Math.PI * 2;
    particles[i + 2] = (random() - 0.5) * 2;
    particles[i + 3] = random();
  }

  const quadVertex = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0., 1.); }
  `;
  const spaceFragment = `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uResolution;
    uniform vec2 uCenter;
    uniform float uZoom;
    uniform float uTilt;
    uniform float uTime;
    uniform float uPalette;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
    vec3 stars(vec2 p, float scale, float cutoff) {
      vec2 cell = floor(p*scale), local = fract(p*scale)-.5;
      float seed = hash(cell);
      vec2 offset = vec2(hash(cell+13.), hash(cell+27.))*.6-.3;
      float star = exp(-length(local-offset)*140.)*step(cutoff,seed);
      return mix(vec3(.46,.53,.64),vec3(.85,.77,.65),hash(cell+7.))*star;
    }
    void main() {
      float scale = min(uResolution.x,uResolution.y)*.108*uZoom;
      vec2 p = (vUv*uResolution-uCenter*uResolution)/scale;
      float r = length(p), angle = atan(p.y,p.x);
      // This screen-space lens is an artistic approximation, not a geodesic solver.
      vec2 lensUv = vUv + normalize(p+vec2(.0001)) * (.010/(r*r+.6));
      vec2 sky = lensUv * vec2(uResolution.x/uResolution.y,1.);
      vec3 color = vec3(.031,.034,.048);
      color += stars(sky,220.,.994)*.9 + stars(sky,73.,.992)*.65;
      float dust = noise(sky*7.+vec2(8.,11.))*noise(sky*19.);
      color += vec3(.037,.013,.014)*dust;
      vec3 hot = mix(vec3(1.,.65,.32), vec3(.40,.75,1.),uPalette);
      vec3 outer = mix(vec3(.68,.19,.075),vec3(.15,.38,.76),uPalette);
      float ring = exp(-abs(r-1.075)*92.);
      float glow = exp(-abs(r-1.10)*10.)*.32;
      float streak = .75+.25*sin(angle*7.+noise(p*3.)*2.+uTime*.17);
      color += hot*(ring*1.4+glow)*streak;
      float inclination = sin(radians(uTilt));
      float diskR = length(vec2(p.x,p.y/max(.14,inclination)));
      float disk = smoothstep(1.3,1.6,diskR)*(1.-smoothstep(2.3,4.6,diskR));
      float bands = .35+.35*noise(vec2(diskR*24., angle*4.-uTime*.3))+.3*sin(diskR*38.-uTime*.2);
      color += mix(hot,outer,clamp((diskR-1.3)/3.,0.,1.))*disk*bands*.29;
      // The rear image of the disk bends into a halo above and below the shadow.
      float arcR = length(vec2(p.x,p.y*1.10));
      float arc = exp(-abs(arcR-1.26)*18.)*(1.-inclination)*.22;
      color += hot*arc*(.5+.5*noise(vec2(angle*24.,uTime*.13)));
      color *= smoothstep(1.00,1.055,r);
      color = vec3(1.)-exp(-color*1.24);
      gl_FragColor=vec4(color,1.);
    }
  `;
  const particleVertex = `
    precision highp float;
    attribute vec4 aSeed;
    uniform vec2 uResolution;
    uniform vec2 uCenter;
    uniform float uZoom;
    uniform float uTilt;
    uniform float uTime;
    uniform float uYaw;
    uniform float uPalette;
    varying vec3 vColor;
    varying vec2 vPointPosition;
    varying float vBrightness;
    varying float vScale;
    void main() {
      float r=1.34+aSeed.x*3.24;
      // Kepler-inspired differential rotation makes inner particles orbit faster.
      float a=aSeed.y+uTime*2.1/pow(r,1.5)+uYaw;
      float tilt=radians(uTilt);
      float x=cos(a)*r, y=sin(a)*r;
      float thickness=aSeed.z*.038*pow(r,1.25);
      vec2 p=vec2(x,y*sin(tilt)+thickness*cos(tilt));
      float rear=smoothstep(.0,1.,y/r);
      p.y+=rear*exp(-pow(abs(x)/1.8,3.))*.83*(1.-sin(tilt));
      float depth=y*cos(tilt)-thickness*sin(tilt);
      float perspective=7.5/(7.5+depth*.18);
      p*=perspective;
      float scale=min(uResolution.x,uResolution.y)*.108*uZoom;
      vec2 pixel=uCenter*uResolution+p*scale;
      gl_Position=vec4(pixel/uResolution*2.-1.,0.,1.);
      gl_PointSize=clamp(scale*(.013+aSeed.w*.022)*perspective,1.,5.);
      vec3 inner=mix(vec3(1.,.81,.53),vec3(.75,.9,1.),uPalette);
      vec3 outer=mix(vec3(.69,.19,.075),vec3(.14,.39,.74),uPalette);
      vColor=mix(inner,outer,pow(aSeed.x,.55));
      vBrightness=(.38+aSeed.w*.65)*(1.-aSeed.x*.65)*(.73+.27*cos(a))*2.1;
      vPointPosition=p; vScale=scale;
    }
  `;
  const particleFragment = `
    precision highp float;
    uniform vec2 uResolution;
    uniform vec2 uCenter;
    varying vec3 vColor;
    varying vec2 vPointPosition;
    varying float vBrightness;
    varying float vScale;
    void main(){
      vec2 p=(gl_FragCoord.xy-uCenter*uResolution)/vScale;
      if(length(p)<1.05) discard;
      float d=length(gl_PointCoord-.5)*2.;
      float alpha=exp(-d*d*4.)*vBrightness;
      gl_FragColor=vec4(vColor*alpha,alpha);
    }
  `;

  function createWebGLRenderer() {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) return null;
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(result);
        gl.deleteShader(result);
        throw new Error(message);
      }
      return result;
    }
    function program(vertex, fragment) {
      const result = gl.createProgram();
      const shaders = [shader(gl.VERTEX_SHADER, vertex), shader(gl.FRAGMENT_SHADER, fragment)];
      shaders.forEach((item) => gl.attachShader(result, item));
      gl.linkProgram(result);
      shaders.forEach((item) => gl.deleteShader(item));
      if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
      const uniforms = {};
      ["uResolution", "uCenter", "uZoom", "uTilt", "uTime", "uYaw", "uPalette"].forEach((name) => {
        uniforms[name] = gl.getUniformLocation(result, name);
      });
      return { result, uniforms };
    }
    const space = program(quadVertex, spaceFragment);
    const disk = program(particleVertex, particleFragment);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const points = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, points);
    gl.bufferData(gl.ARRAY_BUFFER, particles, gl.STATIC_DRAW);
    function bind(item) {
      gl.useProgram(item.result);
      gl.uniform2f(item.uniforms.uResolution, size.width, size.height);
      gl.uniform2f(item.uniforms.uCenter, ...size.center);
      gl.uniform1f(item.uniforms.uZoom, state.zoom);
      gl.uniform1f(item.uniforms.uTilt, state.tilt);
      gl.uniform1f(item.uniforms.uTime, state.time);
      gl.uniform1f(item.uniforms.uYaw, state.yaw);
      gl.uniform1f(item.uniforms.uPalette, state.palette === "ice" ? 1 : 0);
    }
    return {
      kind: "webgl",
      count: () => state.density,
      draw() {
        gl.viewport(0,0,size.width,size.height);
        gl.disable(gl.BLEND);
        bind(space);
        gl.bindBuffer(gl.ARRAY_BUFFER,quad);
        const quadAttribute=gl.getAttribLocation(space.result,"aPosition");
        gl.enableVertexAttribArray(quadAttribute);
        gl.vertexAttribPointer(quadAttribute,2,gl.FLOAT,false,0,0);
        gl.drawArrays(gl.TRIANGLES,0,6);
        gl.disableVertexAttribArray(quadAttribute);
        bind(disk);
        gl.bindBuffer(gl.ARRAY_BUFFER,points);
        const seedAttribute=gl.getAttribLocation(disk.result,"aSeed");
        gl.enableVertexAttribArray(seedAttribute);
        gl.vertexAttribPointer(seedAttribute,4,gl.FLOAT,false,0,0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE,gl.ONE);
        gl.drawArrays(gl.POINTS,0,state.density);
        gl.disableVertexAttribArray(seedAttribute);
        gl.disable(gl.BLEND);
      }
    };
  }

  // A replacement canvas is needed because an existing WebGL canvas cannot switch context types.
  function createCanvasRenderer() {
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    const context = replacement.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    return {
      kind: "canvas", canvas: replacement,
      count: () => Math.min(state.density, 5000),
      draw() {
        const { width:w, height:h, center }=size;
        const cx=center[0]*w,cy=(1-center[1])*h,radius=Math.min(w,h)*.108*state.zoom;
        context.fillStyle="#08090d"; context.fillRect(0,0,w,h);
        const starRandom=randomGenerator(518);
        for(let i=0;i<260;i++) {
          context.fillStyle=`rgba(195,201,213,${.15+starRandom()*.45})`;
          context.fillRect(starRandom()*w,starRandom()*h,size.dpr,size.dpr);
        }
        const glow=context.createRadialGradient(cx,cy,radius*.95,cx,cy,radius*1.55);
        const rgb=state.palette==="ice"?"138,197,247":"239,174,103";
        glow.addColorStop(0,`rgba(${rgb},0)`);glow.addColorStop(.16,`rgba(${rgb},.45)`);glow.addColorStop(1,`rgba(${rgb},0)`);
        context.fillStyle=glow;context.fillRect(cx-radius*2,cy-radius*2,radius*4,radius*4);
        context.globalCompositeOperation="lighter";
        for(let i=0;i<this.count();i++) {
          const n=i*4,r=1.34+particles[n]*3.24,a=particles[n+1]+state.time*2.1/Math.pow(r,1.5)+state.yaw;
          const x=Math.cos(a)*r,y=Math.sin(a)*r,tilt=state.tilt*Math.PI/180;
          let py=y*Math.sin(tilt)+particles[n+2]*.038*Math.pow(r,1.25)*Math.cos(tilt);
          py+=Math.max(0,y/r)*Math.exp(-Math.pow(Math.abs(x)/1.8,3))*.83*(1-Math.sin(tilt));
          if(Math.hypot(x,py)<1.05)continue;
          context.fillStyle=state.palette==="ice"?`rgba(138,197,247,${.25*(1-particles[n]*.65)})`:`rgba(239,${170-particles[n]*95},${93-particles[n]*65},${.35*(1-particles[n]*.65)})`;
          context.beginPath();context.arc(cx+x*radius,cy-py*radius,size.dpr*(.45+particles[n+3]),0,Math.PI*2);context.fill();
        }
        context.globalCompositeOperation="source-over";
        context.fillStyle="#06070b";context.beginPath();context.arc(cx,cy,radius*1.02,0,Math.PI*2);context.fill();
        context.strokeStyle=`rgba(${rgb},.8)`;context.lineWidth=size.dpr;context.stroke();
      }
    };
  }

  function activeCanvas() { return renderer?.canvas || canvas; }
  function resize() {
    const element=activeCanvas();
    const bounds=scene.getBoundingClientRect();
    // Cap the drawing buffer rather than particle count to keep mobile GPUs responsive.
    const dpr=Math.min(window.devicePixelRatio || 1,1.6);
    size={width:Math.round(bounds.width*dpr),height:Math.round(bounds.height*dpr),dpr,center:bounds.width<1000?[.5,.43]:[.535,.52]};
    element.width=size.width;element.height=size.height;
    requestRender();
  }
  function animate(now) {
    frame=0;
    // Clamp elapsed time so returning from another tab never causes a giant orbit jump.
    if (!state.paused && !document.hidden) state.time+=Math.min((now-lastTime)/1000,.05)*state.speed;
    lastTime=now;
    renderer.draw();
    if (!state.paused && !document.hidden) frame=requestAnimationFrame(animate);
  }
  function requestRender() {
    if (frame || document.hidden || !renderer) return;
    lastTime=performance.now();
    frame=requestAnimationFrame(animate);
  }
  try {
    renderer=createWebGLRenderer() || createCanvasRenderer();
  } catch(error) {
    console.warn("WebGL unavailable; enabling compatibility renderer.",error);
    try { renderer=createCanvasRenderer(); } catch {
      document.querySelector("#status").textContent="此浏览器暂时无法显示粒子画面。请使用支持图形加速的浏览器重试。";
      return;
    }
  }
  const observer=new ResizeObserver(resize);observer.observe(scene);
  const status=document.querySelector("#status");
  const fields={};
  ["tilt","speed","density","zoom"].forEach((key)=>{ fields[key]=document.getElementById(key); });
  if(renderer.kind==="canvas") {
    // Report the actual compatibility-mode count and expose only supported densities.
    defaults.density=5000;state.density=5000;
    fields.density.min="1000";fields.density.max="5000";fields.density.step="500";
    status.textContent="已启用兼容画面，最多显示 5,000 颗粒子。";
  }
  function snapshot() {
    return {tilt:state.tilt,speed:state.speed,density:renderer.count(),zoom:state.zoom,palette:state.palette,paused:state.paused};
  }
  function updateUI(message) {
    const values={tilt:`${state.tilt}°`,speed:`${state.speed.toFixed(1)} ×`,density:renderer.count().toLocaleString("zh-CN"),zoom:`${(1/state.zoom).toFixed(1)} ×`};
    Object.entries(fields).forEach(([key,element])=>{
      element.value=String(state[key]);
      element.style.setProperty("--progress",`${(state[key]-Number(element.min))/(Number(element.max)-Number(element.min))*100}%`);
      element.setAttribute("aria-valuetext",values[key]);
      document.getElementById(`${key}-value`).textContent=values[key];
    });
    document.querySelectorAll("[data-palette]").forEach((button)=>button.setAttribute("aria-pressed",String(button.dataset.palette===state.palette)));
    document.querySelectorAll("[data-preset]").forEach((button)=>{
      const chosen=button.dataset.preset==="top"?state.tilt===78&&state.zoom===.9:state.tilt===18&&state.zoom===1;
      button.setAttribute("aria-pressed",String(chosen));
    });
    document.querySelector("#pause").setAttribute("aria-pressed",String(state.paused));
    document.querySelector("#pause-label").textContent=state.paused?"播放":"暂停";
    document.querySelector("#pause-icon").setAttribute("d",state.paused?"M6 4l9 6-9 6Z":"M7 4v12M13 4v12");
    document.querySelector("#particle-count").textContent=`${renderer.count().toLocaleString("zh-CN")} PT`;
    document.querySelector("#render-state").textContent=renderer.kind==="canvas"?"兼容画面":state.paused?"画面已暂停":"实时粒子场";
    if(message) status.textContent=message;
  }
  function applySettings(settings,message) {
    // Validate all incoming fields before touching state, including agent tool calls.
    const limits={tilt:[8,85],speed:[.1,3],density:[Number(fields.density.min),Number(fields.density.max)],zoom:[.65,1.4]};
    for(const [key,value] of Object.entries(settings)) {
      if(key in limits) {
        const [min,max]=limits[key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max) throw new Error(`${key} must be between ${min} and ${max}`);
        if((key==="tilt"||key==="density")&&!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
      } else if(key==="palette") {
        if(!["amber","ice"].includes(value)) throw new Error("Unsupported palette");
      } else if(key==="paused") {
        if(typeof value!=="boolean") throw new Error("paused must be a boolean");
      } else if(key==="yaw") {
        if(typeof value!=="number"||!Number.isFinite(value)) throw new Error("yaw must be finite");
      } else throw new Error(`Unknown parameter: ${key}`);
    }
    Object.assign(state,settings);
    if(state.paused&&frame) { cancelAnimationFrame(frame);frame=0; }
    updateUI(message);requestRender();return snapshot();
  }
  Object.entries(fields).forEach(([key,element])=>element.addEventListener("input",()=>applySettings({[key]:Number(element.value)})));
  document.querySelectorAll("[data-preset]").forEach((button)=>button.addEventListener("click",()=>{
    const top=button.dataset.preset==="top";
    applySettings({tilt:top?78:18,zoom: top ? .9 : 1,yaw:0},top?"已切换至俯瞰视角。":"已切换至电影视角。");
  }));
  document.querySelectorAll("[data-palette]").forEach((button)=>button.addEventListener("click",()=>applySettings({palette:button.dataset.palette},button.dataset.palette==="ice"?"已切换至冰蓝光谱。":"已切换至琥珀光谱。")));
  document.querySelector("#pause").addEventListener("click",()=>applySettings({paused:!state.paused},state.paused?"粒子继续旋转。":"画面已暂停，仍可调整观测参数。"));
  document.querySelector("#reset").addEventListener("click",()=>applySettings({...defaults},"观测参数已重置。"));

  const fullButton=document.querySelector("#fullscreen");
  fullButton.addEventListener("click",async()=>{
    try {
      if(document.fullscreenElement) await document.exitFullscreen();
      else if(scene.requestFullscreen) await scene.requestFullscreen();
      else { status.textContent="此浏览器暂不支持沉浸模式，请尝试横屏观测。";return; }
    } catch { status.textContent="未能进入沉浸模式，请在浏览器中允许全屏后重试。"; }
  });
  document.addEventListener("fullscreenchange",()=>{
    document.querySelector("#fullscreen-label").textContent=document.fullscreenElement?"退出沉浸":"沉浸模式";
    fullButton.setAttribute("aria-pressed",String(Boolean(document.fullscreenElement)));
    resize();
  });
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden) { if(frame)cancelAnimationFrame(frame);frame=0; }
    else requestRender();
  });
  reducedMotion.addEventListener("change",(event)=>{
    if(event.matches)applySettings({paused:true},"已按减少动态效果偏好暂停，可点击播放继续观测。");
  });

  const surface=activeCanvas();
  let drag=null;
  surface.addEventListener("pointerdown",(event)=>{
    if(event.button!==0)return;
    drag={x:event.clientX,y:event.clientY,yaw:state.yaw,tilt:state.tilt};
    surface.setPointerCapture(event.pointerId);surface.classList.add("dragging");
  });
  surface.addEventListener("pointermove",(event)=>{
    if(!drag)return;
    applySettings({yaw:drag.yaw+(event.clientX-drag.x)*.007,tilt:Math.round(Math.max(8,Math.min(85,drag.tilt+(event.clientY-drag.y)*.18)))});
  });
  function endDrag(){drag=null;surface.classList.remove("dragging");}
  surface.addEventListener("pointerup",endDrag);surface.addEventListener("pointercancel",endDrag);surface.addEventListener("lostpointercapture",endDrag);
  surface.addEventListener("wheel",(event)=>{
    // Modifier zoom preserves ordinary document scrolling and browser pinch-to-zoom.
    if(!event.altKey)return;
    event.preventDefault();
    applySettings({zoom:Math.max(.65,Math.min(1.4,state.zoom-event.deltaY*.0007))});
  },{passive:false});
  surface.addEventListener("keydown",(event)=>{
    const edits={ArrowLeft:{yaw:state.yaw-.12},ArrowRight:{yaw:state.yaw+.12},ArrowUp:{tilt:Math.min(85,state.tilt+2)},ArrowDown:{tilt:Math.max(8,state.tilt-2)},"+":{zoom:Math.min(1.4,state.zoom+.05)},"=":{zoom:Math.min(1.4,state.zoom+.05)},"-":{zoom:Math.max(.65,state.zoom-.05)}," ":{paused:!state.paused}};
    if(!edits[event.key])return;
    event.preventDefault();applySettings(edits[event.key]);
  });
  surface.setAttribute("aria-description","方向键调整视角，加减键缩放，空格播放或暂停。也可使用观测参数滑块。");
  if(renderer.kind==="webgl") {
    surface.addEventListener("webglcontextlost",(event)=>{
      event.preventDefault();
      if(frame)cancelAnimationFrame(frame);frame=0;
      state.paused=true;updateUI("图形画面暂时中断，正在等待恢复。");
    });
    surface.addEventListener("webglcontextrestored",()=>{
      try { renderer=createWebGLRenderer();updateUI("画面已恢复，点击播放继续观测。");requestRender(); }
      catch { status.textContent="画面未能恢复，请刷新页面重试。"; }
    });
  }

  // Agent actions configure the same local view; they never fetch or publish external data.
  const modelContext=document.modelContext;
  if(modelContext?.registerTool) {
    const lifecycle=new AbortController();
    const register=(tool)=>{
      try { Promise.resolve(modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{}); }
      catch { /* Unsupported experimental registries leave ordinary controls available. */ }
    };
    register({name:"get_observation",title:"读取观测参数",description:"Read the current black-hole observation settings and actual rendered particle count.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){if(input&&Object.keys(input).length)throw new Error("No arguments accepted");return snapshot();}});
    register({name:"configure_observation",title:"调整黑洞观测",description:"Configure the visible black-hole particle view. Larger zoom means a closer view. Changes only this page's local visual state.",inputSchema:{type:"object",properties:{tilt:{type:"integer",minimum:8,maximum:85},speed:{type:"number",minimum:.1,maximum:3},density:{type:"integer",minimum:Number(fields.density.min),maximum:Number(fields.density.max)},zoom:{type:"number",minimum:.65,maximum:1.4},palette:{type:"string",enum:["amber","ice"]},paused:{type:"boolean"}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Expected an observation object");return applySettings(input,"观测参数已更新。");}});
    // Keep tools after a bfcache return, unregister only when the document is discarded.
    window.addEventListener("pagehide",(event)=>{if(!event.persisted)lifecycle.abort();});
  }
  updateUI(reducedMotion.matches?"已按减少动态效果偏好暂停，可点击播放继续观测。":undefined);
  resize();
})();
