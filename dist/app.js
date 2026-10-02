"use strict";

(() => {
  const canvas = document.querySelector("#cosmos");
  const scene = document.querySelector("#scene");
  const shell = document.querySelector("#control-shell");
  const toggle = shell.querySelector("summary");
  const status = document.querySelector("#status");
  const physics = globalThis.BlackHolePhysics;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const defaults = { model: "kerr", spin: 0.65, tilt: 18, speed: 1, density: 32000, zoom: 1, palette: "amber", yaw: 0 };
  const state = { ...defaults, paused: reducedMotion.matches, time: 0 };
  const fields = Object.fromEntries(["spin", "tilt", "speed", "density", "zoom"].map(key => [key, document.getElementById(key)]));
  let renderer;
  let frame = 0;
  let lastTime = 0;
  let contextLost = false;
  let size = { width: 1, height: 1, dpr: 1, scale: 1 };

  // Fixed seeds keep density changes stable. Gaussian heights form a thin disk rather than a tube.
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

  // Trace geometry only when camera/model parameters change; resolve animated light every frame.
  function createWebGLRenderer() {
    const engine=globalThis.BlackHoleRaytracer.create({canvas,particles,state,physics,onNeedsFrame:requestRender});
    return engine && {...engine,draw:()=>engine.draw(size)};
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
        if(!profile||profile.spin!==model.spin)profile={...physics.diskProfile(model.spin,model.outer),spin:model.spin};
        context.fillStyle="#08090d";context.fillRect(0,0,w,h);
        const rgb=state.palette==="ice"?"138,197,247":"239,174,103";
        const halo=context.createRadialGradient(shadowX,cy,model.shadow*scale*.98,shadowX,cy,model.shadow*scale*1.25);
        halo.addColorStop(0,`rgba(${rgb},0)`);halo.addColorStop(.08,`rgba(${rgb},.4)`);halo.addColorStop(1,`rgba(${rgb},0)`);
        context.fillStyle=halo;context.fillRect(0,0,w,h);
        context.fillStyle="#030405";context.beginPath();context.ellipse(shadowX,cy,model.shadow*scale*(1-.045*model.spin),model.shadow*scale,0,0,Math.PI*2);context.fill();
        context.globalCompositeOperation="lighter";
        const tilt=state.tilt*Math.PI/180,inclination=Math.sin(tilt);
        for(let i=0;i<this.count();i++) {
          const n=i*4,r=model.isco+.025+(model.outer-model.isco-.025)*particles[n];
          const a=particles[n+1]+state.time*physics.angularVelocity(r,model.spin)*19+state.yaw;
          const x=Math.cos(a)*r,y=Math.sin(a)*r,z=particles[n+2]*r*.024;
          const perspective=100/(100+y*Math.cos(tilt)-z*inclination);
          const px=x*perspective;
          let py=(y*inclination+z*Math.cos(tilt))*perspective;
          py+=model.shadow*.62*Math.max(0,y/r)*Math.exp(-Math.pow(Math.abs(px)/(model.shadow*1.7),3))*(1-inclination);
          const hidden=Math.hypot((px-model.offset)/(1-.045*model.spin),py)<model.shadow;
          if(hidden && (y>0 || inclination>.84))continue;
          const thermal=Math.pow(physics.sampleProfile(profile,r),.25);
          const gravitational=Math.sqrt(Math.max(1-3/r+2*model.spin/Math.pow(r,1.5),.01))/(1+model.spin/Math.pow(r,1.5));
          const shift=Math.max(.18,Math.min(1.6,gravitational/(1+Math.sqrt(1/r)*Math.cos(tilt)*Math.cos(a))));
          const alpha=Math.min(.85,(.30+particles[n+3]*.55)*Math.pow(thermal,.8)*Math.pow(shift,3));
          context.fillStyle=state.palette==="ice"?`rgba(138,197,247,${alpha})`:`rgba(255,${95+Math.min(1,thermal*shift)*130},${25+Math.min(1,thermal*shift)*105},${alpha})`;
          context.beginPath();context.arc(cx+px*scale,cy-py*scale,dpr*(.55+particles[n+3]*.55),0,Math.PI*2);context.fill();
        }
        context.globalCompositeOperation="source-over";
      }
    };
  }

  function activeCanvas(){return renderer?.canvas || canvas;}
  function resize() {
    const bounds=scene.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,1.5);
    size={width:Math.round(bounds.width*dpr),height:Math.round(bounds.height*dpr),dpr,scale:Math.min(bounds.width,bounds.height)*dpr*.028*state.zoom};
    activeCanvas().width=size.width;activeCanvas().height=size.height;requestRender();
  }
  function animate(now) {
    frame=0;
    // Hidden-page suspension and bounded elapsed time avoid jumps after returning to the page.
    if(!state.paused&&!document.hidden)state.time+=Math.min((now-lastTime)/1000,.05)*state.speed;
    lastTime=now;renderer.draw();
    if(!state.paused&&!document.hidden&&!contextLost)frame=requestAnimationFrame(animate);
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
    return {model:state.model,spin:model.spin,isco:model.isco,tilt:state.tilt,speed:state.speed,density:renderer.count(),zoom:state.zoom,palette:state.palette,paused:state.paused,controlsExpanded:shell.open,render:renderer.metrics?{...renderer.metrics}:{mode:"canvas-projection"}};
  }
  function updateUI(message) {
    const model=physics.model(state);
    const values={spin:model.spin.toFixed(2),tilt:`${state.tilt}°`,speed:`${state.speed.toFixed(1)} ×`,density:renderer.count().toLocaleString("zh-CN"),zoom:`${(1/state.zoom).toFixed(1)} ×`};
    Object.entries(fields).forEach(([key,element])=>{
      const value=key==="spin"?model.spin:state[key];element.value=String(value);
      element.style.setProperty("--progress",`${(value-Number(element.min))/(Number(element.max)-Number(element.min))*100}%`);
      element.setAttribute("aria-valuetext",values[key]);document.getElementById(`${key}-value`).textContent=values[key];
    });
    fields.spin.disabled=state.model==="schwarzschild";
    document.querySelector("#isco-value").textContent=`${model.isco.toFixed(2)} r_g`;
    for(const key of ["model","palette"])document.querySelectorAll(`[data-${key}]`).forEach(button=>button.setAttribute("aria-pressed",String(button.dataset[key]===state[key])));
    document.querySelectorAll("[data-preset]").forEach(button=>{
      const chosen=button.dataset.preset==="top"?state.tilt===78&&state.zoom===.9:state.tilt===18&&state.zoom===1;
      button.setAttribute("aria-pressed",String(chosen));
    });
    document.querySelector("#pause").setAttribute("aria-pressed",String(state.paused));
    document.querySelector("#pause-label").textContent=state.paused?"播放":"暂停";
    document.querySelector("#pause-icon").setAttribute("d",state.paused?"M6 4l9 6-9 6Z":"M7 4v12M13 4v12");
    document.querySelector("#particle-count").textContent=`${renderer.count().toLocaleString("zh-CN")} PT`;
    document.querySelector("#render-state").textContent=renderer.kind==="canvas"?"兼容画面":state.paused?"画面已暂停":"实时光线成像";
    if(message)status.textContent=message;
  }
  function applySettings(settings,message) {
    // Check the entire update before changing state so failed agent input is atomic.
    const limits={spin:[0,.95],tilt:[8,85],speed:[.1,3],density:[Number(fields.density.min),Number(fields.density.max)],zoom:[.65,1.4]};
    for(const [key,value] of Object.entries(settings)) {
      if(Object.hasOwn(limits,key)) {
        const [min,max]=limits[key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)throw new Error(`${key} must be between ${min} and ${max}`);
        if((key==="tilt"||key==="density")&&!Number.isInteger(value))throw new Error(`${key} must be an integer`);
      } else if(key==="model") {if(!["schwarzschild","kerr"].includes(value))throw new Error("Unsupported model");}
      else if(key==="palette") {if(!["amber","ice"].includes(value))throw new Error("Unsupported palette");}
      else if(key==="paused") {if(typeof value!=="boolean")throw new Error("paused must be a boolean");}
      else if(key==="yaw") {if(typeof value!=="number"||!Number.isFinite(value))throw new Error("yaw must be finite");}
      else throw new Error(`Unknown parameter: ${key}`);
    }
    Object.assign(state,settings);size.scale=Math.min(size.width,size.height)*.028*state.zoom;
    if(state.paused&&frame){cancelAnimationFrame(frame);frame=0;}
    updateUI(message);requestRender();return snapshot();
  }
  Object.entries(fields).forEach(([key,element])=>element.addEventListener("input",()=>applySettings({[key]:Number(element.value)})));
  document.querySelectorAll("[data-model]").forEach(button=>button.addEventListener("click",()=>applySettings({model:button.dataset.model},button.dataset.model==="kerr"?"已切换至克尔旋转模型。":"已切换至史瓦西非旋转模型。")));
  document.querySelectorAll("[data-preset]").forEach(button=>button.addEventListener("click",()=>{
    const top=button.dataset.preset==="top";applySettings({tilt:top?78:18,zoom:top ? .9 : 1,yaw:0},top?"已切换至俯瞰视角。":"已切换至电影视角。");
  }));
  document.querySelectorAll("[data-palette]").forEach(button=>button.addEventListener("click",()=>applySettings({palette:button.dataset.palette},"光谱配色已更新。")));
  document.querySelector("#pause").addEventListener("click",()=>applySettings({paused:!state.paused},state.paused?"粒子继续旋转。":"画面已暂停。"));
  document.querySelector("#reset").addEventListener("click",()=>applySettings({...defaults},"观测参数已重置。"));

  shell.addEventListener("toggle",()=>{toggle.title=shell.open?"收起观测控制":"展开观测控制";});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&shell.open){shell.open=false;toggle.focus();}});
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
  reducedMotion.addEventListener("change",event=>{if(event.matches)applySettings({paused:true},"已按减少动态效果偏好暂停，可点击播放继续观测。");});

  const surface=activeCanvas();
  let drag=null;
  surface.addEventListener("pointerdown",event=>{
    if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,yaw:state.yaw,tilt:state.tilt};surface.setPointerCapture(event.pointerId);surface.classList.add("dragging");
  });
  surface.addEventListener("pointermove",event=>{
    if(!drag)return;applySettings({yaw:drag.yaw+(event.clientX-drag.x)*.007,tilt:Math.round(Math.max(8,Math.min(85,drag.tilt+(event.clientY-drag.y)*.18)))});
  });
  function endDrag(){drag=null;surface.classList.remove("dragging");}
  for(const event of ["pointerup","pointercancel","lostpointercapture"])surface.addEventListener(event,endDrag);
  surface.addEventListener("wheel",event=>{
    // The canvas now owns the viewport; preserve browser pinch zoom, but use normal wheel for distance.
    if(event.ctrlKey||event.metaKey)return;event.preventDefault();applySettings({zoom:Math.max(.65,Math.min(1.4,state.zoom-event.deltaY*.0007))});
  },{passive:false});
  surface.addEventListener("keydown",event=>{
    const edits={ArrowLeft:{yaw:state.yaw-.12},ArrowRight:{yaw:state.yaw+.12},ArrowUp:{tilt:Math.min(85,state.tilt+2)},ArrowDown:{tilt:Math.max(8,state.tilt-2)},"+":{zoom:Math.min(1.4,state.zoom+.05)},"=":{zoom:Math.min(1.4,state.zoom+.05)},"-":{zoom:Math.max(.65,state.zoom-.05)}," ":{paused:!state.paused}};
    if(!Object.hasOwn(edits,event.key))return;event.preventDefault();applySettings(edits[event.key]);
  });
  if(renderer.kind==="webgl") {
    surface.addEventListener("webglcontextlost",event=>{event.preventDefault();contextLost=true;if(frame)cancelAnimationFrame(frame);frame=0;state.paused=true;updateUI("图形画面暂时中断，正在等待恢复。");});
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
    register({name:"configure_observation",title:"调整黑洞观测",description:"Configure the visible local particle view with Schwarzschild or Kerr parameters. Larger zoom means a closer view. Controls stay collapsed unless the user opens them.",inputSchema:{type:"object",properties:{model:{type:"string",enum:["schwarzschild","kerr"]},spin:{type:"number",minimum:0,maximum:.95},tilt:{type:"integer",minimum:8,maximum:85},speed:{type:"number",minimum:.1,maximum:3},density:{type:"integer",minimum:Number(fields.density.min),maximum:Number(fields.density.max)},zoom:{type:"number",minimum:.65,maximum:1.4},palette:{type:"string",enum:["amber","ice"]},paused:{type:"boolean"}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Expected an observation object");return applySettings(input,"观测参数已更新。");}});
    window.addEventListener("pagehide",event=>{if(!event.persisted)lifecycle.abort();});
  }
  const observer=new ResizeObserver(resize);observer.observe(scene);
  updateUI(reducedMotion.matches?"已按减少动态效果偏好暂停，可点击播放继续观测。":undefined);resize();
})();
