"use strict";

(() => {
  const canvas = document.querySelector("#cosmos");
  const scene = document.querySelector("#scene");
  const shell = document.querySelector("#control-shell");
  const toggle = shell.querySelector("summary");
  const status = document.querySelector("#status");
  const physics = globalThis.BlackHolePhysics;
  const navigation = globalThis.BlackHoleNavigation;
  const flightStatus = document.querySelector("#flight-status");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const defaults = { model: "kerr", spin: 0.65, tilt: 18, speed: 1, density: 32000, zoom: 1, yaw: 0 };
  const state = { ...defaults, paused: reducedMotion.matches, time: 0, viewZoom: defaults.zoom, reducedMotion: reducedMotion.matches, drift: 0 };
  const fields = Object.fromEntries(["spin", "tilt", "speed", "density", "zoom"].map(key => [key, document.getElementById(key)]));
  let renderer;
  let frame = 0;
  let lastTime = 0;
  let contextLost = false;
  let flightStage = "observe";
  let size = { width: 1, height: 1, dpr: 1, scale: 1 };
  // Start at full idle speed unless the system requests no automatic camera motion.
  let driftAngle = 0, driftRate = reducedMotion.matches?0:1, driftUntil = null;
  const markDriftInteraction = () => { driftUntil = performance.now(); };

  // Fixed seeds keep density changes stable. Heights belong to the Canvas
  // fallback; the GPU particles share the ray tracer's zero-thickness disk.
  function randomGenerator(seed) {
    return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  }
  const random = randomGenerator(81732);
  const particles = new Float32Array(60000 * 4);
  for (let i = 0; i < particles.length; i += 4) {
    particles[i] = Math.pow(random(), 1.65);
    particles[i + 1] = random() * Math.PI * 2;
    particles[i + 2] = Math.max(-2.8, Math.min(2.8, Math.sqrt(-2 * Math.log(Math.max(random(), 1e-6))) * Math.cos(random() * Math.PI * 2)));
    particles[i + 3] = random();
  }

  // Fixed sky directions shared by every frame; the compatibility view basis follows yaw and tilt.
  const sky = (() => {
    const generator = randomGenerator(90417), stars = [], blobs = [];
    const normal = [0.88, 0.34, 0.33], normalLength = Math.hypot(...normal), n = normal.map(v => v / normalLength);
    let u = [-n[1], n[0], 0];
    const uLength = Math.hypot(...u); u = u.map(v => v / uLength);
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const bandDirection = spread => {
      const t = generator() * 6.28318, off = (generator() * 2 - 1) * generator() * spread;
      const raw = [Math.cos(t) * u[0] + Math.sin(t) * v[0] + off * n[0], Math.cos(t) * u[1] + Math.sin(t) * v[1] + off * n[1], Math.cos(t) * u[2] + Math.sin(t) * v[2] + off * n[2]];
      const length = Math.hypot(...raw);
      return {x: raw[0] / length, y: raw[1] / length, z: raw[2] / length};
    };
    for (let i = 0; i < 760; i++) {
      const z = generator() * 2 - 1, phi = generator() * 6.28318, s = Math.sqrt(1 - z * z);
      stars.push({x: s * Math.cos(phi), y: s * Math.sin(phi), z, r: .35 + generator() ** 3 * 1.15, b: .2 + generator() * .8, warm: generator()});
    }
    // Milky-Way dust: dense faint stars concentrated along the tilted great circle.
    for (let i = 0; i < 720; i++) stars.push({...bandDirection(.32), r: .3 + generator() * .5, b: .06 + generator() * .22, warm: generator()});
    for (let i = 0; i < 26; i++) blobs.push({...bandDirection(.22), radius: .1 + generator() * .12, alpha: .014 + generator() * .03, blue: generator() < .7});
    return {stars, blobs};
  })();

  // Cache only ray geometry; live GPU particles produce all disk light each frame.
  function createWebGLRenderer() {
    const engine=globalThis.BlackHoleRaytracer.create({canvas,particles,state,physics,onNeedsFrame:requestRender});
    return engine && {...engine,draw:seconds=>engine.draw(size,seconds)};
  }

  // A WebGL canvas cannot change context type; preserve its accessible name on the replacement.
  function createCanvasRenderer() {
    const replacement=canvas.cloneNode(false);canvas.replaceWith(replacement);
    const context=replacement.getContext("2d");if(!context)throw new Error("Canvas unavailable");
    let profile=null;
    return {
      kind:"canvas",canvas:replacement,count:()=>Math.min(state.density,5000),
      draw() {
        const {width:w,height:h,scale,dpr}=size,model=physics.model(state);
        const cx=w*.5,cy=h*.5,shadowX=cx+model.offset*scale;
        if(!profile||profile.spin!==model.spin)profile={...physics.emissionProfile(model.spin,model.outer),plunge:physics.plungeProfile(model.spin)};
        context.fillStyle="#08090d";context.fillRect(0,0,w,h);
        // Sky first: stars and the Milky-Way band sit behind halo, shadow and disk.
        const flight=navigation.view(state.viewZoom,state.reducedMotion),viewYaw=state.yaw+flight.orbit+state.drift;
        const tiltAngle=state.tilt*Math.PI/180,cosYaw=Math.cos(-viewYaw),sinYaw=Math.sin(-viewYaw);
        const forwardY=Math.cos(tiltAngle),forwardZ=-Math.sin(tiltAngle),upY=Math.sin(tiltAngle),upZ=Math.cos(tiltAngle);
        const focal=flight.distance*scale;
        context.globalCompositeOperation="lighter";
        for(const blob of sky.blobs) {
          const rx=blob.x*cosYaw-blob.y*sinYaw,ry=blob.x*sinYaw+blob.y*cosYaw,depth=ry*forwardY+blob.z*forwardZ;
          if(depth<.3)continue;
          const px=cx+rx/depth*focal,py=cy-(ry*upY+blob.z*upZ)/depth*focal,radius=blob.radius*focal,rgb=blob.blue?"96,132,200":"190,140,100";
          const glow=context.createRadialGradient(px,py,0,px,py,radius);
          // Keep continuous band glow faint in compatibility mode; stars retain their contrast.
          glow.addColorStop(0,`rgba(${rgb},${blob.alpha*.08})`);glow.addColorStop(1,`rgba(${rgb},0)`);
          context.fillStyle=glow;context.fillRect(px-radius,py-radius,radius*2,radius*2);
        }
        for(const star of sky.stars) {
          const rx=star.x*cosYaw-star.y*sinYaw,ry=star.x*sinYaw+star.y*cosYaw,depth=ry*forwardY+star.z*forwardZ;
          if(depth<.3)continue;
          context.fillStyle=star.warm>.6?`rgba(255,240,220,${star.b})`:`rgba(208,222,255,${star.b})`;
          context.beginPath();context.arc(cx+rx/depth*focal,cy-(ry*upY+star.z*upZ)/depth*focal,star.r*dpr,0,Math.PI*2);context.fill();
        }
        context.globalCompositeOperation="source-over";
        const rgb="239,174,103";
        const halo=context.createRadialGradient(shadowX,cy,model.shadow*scale*.98,shadowX,cy,model.shadow*scale*1.25);
        halo.addColorStop(0,`rgba(${rgb},0)`);halo.addColorStop(.08,`rgba(${rgb},.4)`);halo.addColorStop(1,`rgba(${rgb},0)`);
        context.fillStyle=halo;context.fillRect(0,0,w,h);
        context.fillStyle="#030405";context.beginPath();context.ellipse(shadowX,cy,model.shadow*scale*(1-.045*model.spin),model.shadow*scale,0,0,Math.PI*2);context.fill();
        context.globalCompositeOperation="lighter";
        const tilt=state.tilt*Math.PI/180,inclination=Math.sin(tilt);
        for(let i=0;i<this.count();i++) {
          const n=i*4,orbit=physics.particleOrbit(particles.subarray(n,n+4),i,state.time,profile,profile.plunge),r=orbit.r,a=orbit.phi-viewYaw;
          // Share the actual inward trajectories with WebGL. Only projection and
          // lensing remain approximate in Canvas; the plunge never uses circular motion.
          const height=orbit.plunging?model.isco*.024*(model.isco/r)**(-11/7)*(Math.abs(physics.flowVelocity(r,model.spin,profile.constants).ur)/physics.flow.radialSpeed)**(-1/7):r*.024;
          const radial=Math.sqrt(r*r+model.spin*model.spin);
          const x=Math.cos(a)*radial,y=Math.sin(a)*radial,z=particles[n+2]*height;
          const perspective=100/(100+y*Math.cos(tilt)-z*inclination);
          const px=x*perspective;
          let py=(y*inclination+z*Math.cos(tilt))*perspective;
          py+=model.shadow*.62*Math.max(0,y/r)*Math.exp(-Math.pow(Math.abs(px)/(model.shadow*1.7),3))*(1-inclination);
          const hidden=Math.hypot((px-model.offset)/(1-.045*model.spin),py)<model.shadow;
          if(hidden && (y>0 || inclination>.84))continue;
          const thermal=Math.pow(physics.sampleProfile(profile,r),.25);
          const shift=Math.min(4,physics.compatibilityShift(r,a,tilt,model.spin,profile.constants));
          const alpha=Math.min(.85,(.30+particles[n+3]*.55)*Math.pow(thermal,.8)*Math.pow(shift,4));
          context.fillStyle=`rgba(255,${95+Math.min(1,thermal*shift)*130},${25+Math.min(1,thermal*shift)*105},${alpha})`;
          context.beginPath();context.arc(cx+px*scale,cy-py*scale,dpr*(.55+particles[n+3]*.55),0,Math.PI*2);context.fill();
        }
        context.globalCompositeOperation="source-over";
        // Match the reversible horizon fade used by the WebGL display pass.
        if(flight.fade>0){context.fillStyle=`rgba(0,0,0,${flight.fade})`;context.fillRect(0,0,w,h);}
      }
    };
  }

  function activeCanvas(){return renderer?.canvas || canvas;}
  function resize() {
    // Preserve native 2x Retina detail instead of asking the browser to enlarge a 1.5x canvas.
    const bounds=scene.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    size={width:Math.round(bounds.width*dpr),height:Math.round(bounds.height*dpr),dpr,scale:Math.min(bounds.width,bounds.height)*dpr*.028*state.viewZoom};
    activeCanvas().width=size.width;activeCanvas().height=size.height;requestRender();
  }
  function animate(now) {
    frame=0;
    // Hidden-page suspension and bounded elapsed time avoid jumps after returning to the page.
    const elapsed=Math.max(0,Math.min((now-lastTime)/1000,.05));
    if(!state.paused&&!document.hidden)state.time+=elapsed*state.speed;
    const movingBefore=state.viewZoom!==state.zoom;
    state.viewZoom=navigation.smoothZoom(state.viewZoom,state.zoom,elapsed,state.reducedMotion);
    size.scale=Math.min(size.width,size.height)*.028*state.viewZoom;
    const moving=state.viewZoom!==state.zoom;
    if(movingBefore&&!moving)renderer.refine?.();
    const flight=navigation.view(state.viewZoom,state.reducedMotion);
    // Idle drift runs only for the full-view framing: the zoom journey owns the orbit
    // beyond 1.4x, the open panel keeps the stage, and a recent interaction holds it off.
    // Reduced motion freezes the camera immediately, even when disk playback is enabled.
    if(state.reducedMotion)driftRate=0;
    else if(!state.paused&&!document.hidden){
      const suppressed=gestures.active||shell.open||flight.stage!=="observe"||(driftUntil!==null&&now-driftUntil<navigation.drift.waitSeconds*1000);
      const advanced=navigation.driftStep(driftAngle,driftRate,elapsed,suppressed);
      driftAngle=advanced.angle;driftRate=advanced.rate;state.drift=driftAngle;
    }
    if(flight.stage!==flightStage){
      flightStage=flight.stage;
      flightStatus.hidden=flightStage!=="approach"&&flightStage!=="inside";
      flightStatus.textContent=flightStage==="inside"?"已进入视界 · 缩小或按 Esc 返回":"接近视界 · 缩小可返回";
    }
    lastTime=now;renderer.draw(elapsed);
    // Camera easing settles while particles are paused. Park at the opaque endpoint
    // instead of spending GPU work on invisible particles; any input wakes the view.
    if((moving||(!state.paused&&flight.fade<1))&&!document.hidden&&!contextLost&&!frame)frame=requestAnimationFrame(animate);
  }
  function requestRender() {
    if(frame||document.hidden||!renderer||contextLost)return;
    lastTime=performance.now();frame=requestAnimationFrame(animate);
  }
  try {renderer=createWebGLRenderer()||createCanvasRenderer();}
  catch(error) {
    console.warn("Graphics capability unavailable; enabling compatibility renderer.",error);
    try {renderer=createCanvasRenderer();}
    catch {status.textContent="此浏览器无法显示粒子画面，请使用支持图形加速的浏览器重试。";shell.open=true;return;}
  }
  if(renderer.kind==="canvas") {
    defaults.density=5000;state.density=5000;fields.density.min="1000";fields.density.max="5000";fields.density.step="500";
    status.textContent="已启用兼容画面，最多显示 5,000 颗粒子。";
  }
  function snapshot() {
    const model=physics.model(state);
    return {model:state.model,spin:model.spin,isco:model.isco,tilt:state.tilt,speed:state.speed,density:renderer.count(),zoom:state.zoom,flight:navigation.view(state.viewZoom,state.reducedMotion),paused:state.paused,controlsExpanded:shell.open,render:renderer.metrics?{...renderer.metrics}:{mode:"canvas-projection"}};
  }
  function updateUI(message) {
    const model=physics.model(state);
    const values={spin:model.spin.toFixed(2),tilt:`${state.tilt}°`,speed:`${state.speed.toFixed(1)} ×`,density:renderer.count().toLocaleString("zh-CN"),zoom:`${state.zoom.toFixed(1)} ×`};
    Object.entries(fields).forEach(([key,element])=>{
      const value=key==="spin"?model.spin:state[key];element.value=String(value);
      element.style.setProperty("--progress",`${(value-Number(element.min))/(Number(element.max)-Number(element.min))*100}%`);
      element.setAttribute("aria-valuetext",values[key]);document.getElementById(`${key}-value`).textContent=values[key];
    });
    fields.spin.disabled=state.model==="schwarzschild";
    document.querySelector("#isco-value").textContent=`${model.isco.toFixed(2)} r_g`;
    for(const key of ["model"])document.querySelectorAll(`[data-${key}]`).forEach(button=>button.setAttribute("aria-pressed",String(button.dataset[key]===state[key])));
    document.querySelectorAll("[data-preset]").forEach(button=>{
      const chosen=button.dataset.preset==="top"?state.tilt===78&&state.zoom===.9:state.tilt===18&&state.zoom===1;
      button.setAttribute("aria-pressed",String(chosen));
    });
    document.querySelector("#pause").setAttribute("aria-pressed",String(state.paused));
    document.querySelector("#pause-label").textContent=state.paused?"播放":"暂停";
    document.querySelector("#pause-icon").setAttribute("d",state.paused?"M6 4l9 6-9 6Z":"M7 4v12M13 4v12");
    document.querySelector("#particle-count").textContent=`${renderer.count().toLocaleString("zh-CN")} PT`;
    document.querySelector("#render-state").textContent=renderer.kind==="canvas"?"兼容画面":state.paused?"画面已暂停":"实时粒子成像";
    if(message)status.textContent=message;
  }
  function applySettings(settings,message) {
    // Check the entire update before changing state so failed agent input is atomic.
    const limits={spin:[0,.95],tilt:[8,85],speed:[.1,3],density:[Number(fields.density.min),Number(fields.density.max)],zoom:[navigation.limits.min,navigation.limits.max]};
    for(const [key,value] of Object.entries(settings)) {
      if(Object.hasOwn(limits,key)) {
        const [min,max]=limits[key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)throw new Error(`${key} must be between ${min} and ${max}`);
        if((key==="tilt"||key==="density")&&!Number.isInteger(value))throw new Error(`${key} must be an integer`);
      } else if(key==="model") {if(!["schwarzschild","kerr"].includes(value))throw new Error("Unsupported model");}
      else if(key==="paused") {if(typeof value!=="boolean")throw new Error("paused must be a boolean");}
      else if(key==="yaw") {if(typeof value!=="number"||!Number.isFinite(value))throw new Error("yaw must be finite");}
      else throw new Error(`Unknown parameter: ${key}`);
    }
    Object.assign(state,settings);
    if(state.paused&&frame){cancelAnimationFrame(frame);frame=0;}
    updateUI(message);requestRender();return snapshot();
  }
  Object.entries(fields).forEach(([key,element])=>element.addEventListener("input",()=>applySettings({[key]:Number(element.value)})));
  document.querySelectorAll("[data-model]").forEach(button=>button.addEventListener("click",()=>applySettings({model:button.dataset.model},button.dataset.model==="kerr"?"已切换至克尔旋转模型。":"已切换至史瓦西非旋转模型。")));
  document.querySelectorAll("[data-preset]").forEach(button=>button.addEventListener("click",()=>{
    const top=button.dataset.preset==="top";applySettings({tilt:top?78:18,zoom:top ? .9 : 1,yaw:0},top?"已切换至俯瞰视角。":"已切换至电影视角。");
  }));
  document.querySelector("#pause").addEventListener("click",()=>applySettings({paused:!state.paused},state.paused?"粒子继续旋转。":"画面已暂停。"));
  document.querySelector("#reset").addEventListener("click",()=>{gestures.cancel();applySettings({...defaults},"观测参数已重置。");});

  shell.addEventListener("toggle",()=>{
    toggle.title=shell.open?"收起观测控制":"展开观测控制";
    // The view pans away from the open panel so the hole never sits behind it.
    scene.classList.toggle("controls-open",shell.open);
    markDriftInteraction();
  });
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    if(shell.open){shell.open=false;toggle.focus();}
    else if(state.zoom>navigation.limits.orbitStart){event.preventDefault();gestures.cancel();markDriftInteraction();applySettings({zoom:1},"已返回远观视角。");}
  });
  document.addEventListener("pointerdown",event=>{if(shell.open&&!shell.contains(event.target))shell.open=false;});
  const fullButton=document.querySelector("#fullscreen");
  fullButton.addEventListener("click",async()=>{
    try {
      if(document.fullscreenElement)await document.exitFullscreen();
      else if(scene.requestFullscreen)await scene.requestFullscreen();
      else status.textContent="此浏览器暂不支持全屏，请尝试横屏观测。";
    } catch {status.textContent="未能进入全屏，请允许全屏后重试。";}
  });
  document.addEventListener("fullscreenchange",()=>{document.querySelector("#fullscreen-label").textContent=document.fullscreenElement?"退出全屏":"全屏";fullButton.setAttribute("aria-pressed",String(Boolean(document.fullscreenElement)));resize();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden){if(frame)cancelAnimationFrame(frame);frame=0;}else requestRender();});
  reducedMotion.addEventListener("change",event=>{state.reducedMotion=event.matches;if(event.matches)applySettings({paused:true},"已按减少动态效果偏好暂停，可点击播放继续观测。");else requestRender();});

  const surface=activeCanvas();
  // The gesture owner holds idle drift for captured pointers and native trackpad
  // gestures alike; ignored buttons never latch a hold, and wheel uses the idle window.
  const gestures=navigation.bind(surface,{read:()=>state,change:settings=>{markDriftInteraction();applySettings(settings);},finish:()=>{markDriftInteraction();renderer.refine?.();}});
  window.addEventListener("blur",gestures.cancel);
  window.addEventListener("pagehide",event=>{if(!event.persisted)gestures.dispose();});
  surface.addEventListener("keydown",event=>{
    if(event.ctrlKey||event.metaKey)return;
    const edits={ArrowLeft:{yaw:state.yaw-.12},ArrowRight:{yaw:state.yaw+.12},ArrowUp:{tilt:Math.min(85,state.tilt+2)},ArrowDown:{tilt:Math.max(8,state.tilt-2)},"+":{zoom:navigation.clampZoom(state.zoom*1.15)},"=":{zoom:navigation.clampZoom(state.zoom*1.15)},"-":{zoom:navigation.clampZoom(state.zoom/1.15)}," ":{paused:!state.paused}};
    if(!Object.hasOwn(edits,event.key))return;event.preventDefault();markDriftInteraction();applySettings(edits[event.key]);
  });
  if(renderer.kind==="webgl") {
    surface.addEventListener("webglcontextlost",event=>{event.preventDefault();gestures.cancel();contextLost=true;if(frame)cancelAnimationFrame(frame);frame=0;state.paused=true;updateUI("图形画面暂时中断，正在等待恢复。");});
    surface.addEventListener("webglcontextrestored",()=>{
      try {renderer.dispose?.();const restored=createWebGLRenderer();if(!restored)throw new Error("Renderer restoration unavailable");renderer=restored;contextLost=false;updateUI("画面已恢复，点击播放继续观测。");requestRender();}
      catch {status.textContent="画面未能恢复，请刷新页面重试。";shell.open=true;}
    });
  }

  // Agent tools reuse visible observation state and never expand the controls implicitly.
  const modelContext=document.modelContext;
  if(modelContext?.registerTool) {
    const lifecycle=new AbortController();
    const register=tool=>{try{Promise.resolve(modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{/* Experimental registry support is optional. */}};
    register({name:"get_observation",title:"读取观测参数",description:"Read the black-hole model, effective spin, ISCO, rendered particle count, and collapsed control state.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){if(input&&Object.keys(input).length)throw new Error("No arguments accepted");return snapshot();}});
    register({name:"configure_observation",title:"调整黑洞观测",description:"Configure the visible local particle view with Schwarzschild or Kerr parameters. Larger zoom means a closer view. Controls stay collapsed unless the user opens them.",inputSchema:{type:"object",properties:{model:{type:"string",enum:["schwarzschild","kerr"]},spin:{type:"number",minimum:0,maximum:.95},tilt:{type:"integer",minimum:8,maximum:85},speed:{type:"number",minimum:.1,maximum:3},density:{type:"integer",minimum:Number(fields.density.min),maximum:Number(fields.density.max)},zoom:{type:"number",minimum:navigation.limits.min,maximum:navigation.limits.max},paused:{type:"boolean"}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Expected an observation object");return applySettings(input,"观测参数已更新。");}});
    window.addEventListener("pagehide",event=>{if(!event.persisted)lifecycle.abort();});
  }
  const observer=new ResizeObserver(resize);observer.observe(scene);
  updateUI(reducedMotion.matches?"已按减少动态效果偏好暂停，可点击播放继续观测。":undefined);resize();
})();
