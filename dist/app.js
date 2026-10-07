"use strict";

(() => {
  const canvas = document.querySelector("#cosmos");
  const scene = document.querySelector("#scene");
  const shell = document.querySelector("#control-shell");
  const toggle = shell.querySelector("summary");
  const panel = document.querySelector("#controls");
  const panelHeader = document.getElementById("control-header");
  const status = document.querySelector("#status");
  const physics = globalThis.BlackHolePhysics;
  const astrophysics = globalThis.BlackHoleAstrophysics;
  const navigation = globalThis.BlackHoleNavigation;
  const flightStatus = document.querySelector("#flight-status");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Startup and reset use an 8° disk elevation; named view presets stay independent.
  // Sampling changes resolution, never gas mass or optical depth.
  const defaults={scene:"quasar",model:"kerr",spin:.65,charge:0,band:"visible",display:"intensity",observer:"infall",exposure:1,tilt:8,speed:1,density:128000,zoom:1,yaw:0,falling:false};
  const state={...defaults,paused:reducedMotion.matches,time:0,viewZoom:defaults.zoom,reducedMotion:reducedMotion.matches,drift:0,flightRadius:null,flightLens:null,waitingForData:false};
  const fields=Object.fromEntries(["spin","charge","tilt","speed","density","zoom","exposure"].map(key=>[key,document.getElementById(key)]));
  // The scene selector has its own ID; #scene is the existing canvas container.
  const choices=Object.fromEntries(["scene","band","display","observer"].map(key=>[key,document.getElementById(key==="scene"?"scene-choice":key)]));
  let renderer;
  let frame = 0;
  let lastTime = 0;
  let contextLost = false;
  let flightStage = "observe";
  let size = { width: 1, height: 1, dpr: 1, scale: 1 };
  // Start at full idle speed unless the system requests no automatic camera motion.
  let driftAngle = 0, driftRate = reducedMotion.matches?0:1, driftUntil = null;
  const markDriftInteraction = () => { driftUntil = performance.now(); };
  // Native physical/camera range drags share interaction quality with canvas
  // gestures. Display exposure never changes the physical sampling target.
  const rangePointers=new Set();

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

  // The physical path integrates evolving fluid emission along the entire ray.
  function createWebGLRenderer() {
    const engine=globalThis.BlackHolePhysicalRenderer.create({canvas,state,onNeedsFrame:requestRender,onStatus:message=>{status.textContent=message;}});
    return engine && {...engine,draw:seconds=>engine.draw(size,seconds)};
  }

  // A WebGL canvas cannot change context type; preserve its accessible name on the replacement.
  function createCanvasRenderer() {
    const replacement=canvas.cloneNode(false);replacement.setAttribute("aria-label","兼容黑洞粒子投影，不含引力透镜或视界内计算；拖动调视角、滚轮缩放、空格暂停。");canvas.replaceWith(replacement);
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
        // The compatibility projection does not fabricate a black crossing.
      }
    };
  }

  function activeCanvas(){return renderer?.canvas || canvas;}
  function resize() {
    // Preserve native 2x Retina detail instead of asking the browser to enlarge a 1.5x canvas.
    const bounds=scene.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    size={width:Math.round(bounds.width*dpr),height:Math.round(bounds.height*dpr),dpr,scale:Math.min(bounds.width,bounds.height)*dpr*.028*state.viewZoom};
    // Assigning even the same canvas dimensions clears its drawing buffer.
    // Duplicate resize/fullscreen notifications must preserve the cached image.
    const surface=activeCanvas();if(surface.width!==size.width)surface.width=size.width;if(surface.height!==size.height)surface.height=size.height;requestRender();
    syncPanelLayout();
  }
  function syncPanelLayout() {
    if(!shell.open){
      scene.style.setProperty("--panel-shift-x","0px");scene.style.setProperty("--panel-shift-y","0px");scene.style.setProperty("--panel-height","0px");scene.style.setProperty("--panel-header-height","0px");
      return;
    }
    // Keep the canvas clearance tied to the rendered panel, including wrapped
    // feedback and safe-area changes, instead of duplicating CSS height guesses.
    const panelBounds=panel.getBoundingClientRect(),sceneBounds=scene.getBoundingClientRect(),compact=(window.innerWidth||sceneBounds.width)<=600;
    scene.style.setProperty("--panel-height",`${Math.max(0,panelBounds.height)}px`);
    // Short phone sheets retain the header while their body scrolls. Its actual
    // height, including preset feedback, defines safe focus/scroll clearance.
    scene.style.setProperty("--panel-header-height",`${Math.max(0,panelHeader?.getBoundingClientRect().height||0)}px`);
    scene.style.setProperty("--panel-shift-x",compact?"0px":`${-Math.min(panelBounds.width,sceneBounds.width)/2}px`);
    // Center the phone image in the actual strip above the sheet, including its
    // bottom safe-area gap. Rect fallbacks also support non-layout test hosts.
    const sceneTop=sceneBounds.top||0,panelTop=Number.isFinite(panelBounds.top)?panelBounds.top:sceneTop+sceneBounds.height-panelBounds.height;
    const freeHeight=Math.max(0,Math.min(sceneBounds.height,panelTop-sceneTop));
    scene.style.setProperty("--panel-shift-y",compact?`${(freeHeight-sceneBounds.height)/2}px`:"0px");
  }
  function animate(now) {
    frame=0;
    // Hidden-page suspension and bounded elapsed time avoid jumps after returning to the page.
    const elapsed=Math.max(0,Math.min((now-lastTime)/1000,.05));
    const movie=astrophysics.scenes[state.scene].flow==="grmhd",ready=!movie||renderer.metrics?.dataStatus==="ready",availableTime=renderer.metrics?.latestSimulationTime??renderer.metrics?.historyEndTime??800,continuationStatus=renderer.metrics?.continuationStatus,terminalFallback=movie&&(continuationStatus==="unavailable"||continuationStatus==="failed");
    let flight=renderer.physical?astrophysics.camera(state,astrophysics.model(state)):navigation.view(state.viewZoom,state.reducedMotion);
    if(!state.paused&&!document.hidden&&ready){
      if(state.falling){
        const m=astrophysics.model(state),candidateRadius=astrophysics.advanceFall(state.flightRadius,m,state.tilt,elapsed*state.speed*8),candidateCamera=astrophysics.camera({...state,flightRadius:candidateRadius},m),candidateTime=350+state.time*8+candidateCamera.coordinateTime;
        if(movie&&candidateTime>availableTime+1e-6){
          const budget=Math.max(0,availableTime-350-state.time*8);let lo=astrophysics.minimumRadius(m,"infall"),hi=m.initialObserverDistance;
          for(let i=0;i<28;i++){const radius=(lo+hi)/2,camera=astrophysics.camera({...state,flightRadius:radius},m);if(camera.coordinateTime>budget)lo=radius;else hi=radius;}
          state.flightRadius=(lo+hi)/2;state.zoom=state.viewZoom=astrophysics.zoomForRadius(state.flightRadius,m);state.waitingForData=!terminalFallback;
          // A failed continuation has no future snapshot to wait for. Stop the
          // journey at the last valid event instead of pinning free fall forever.
          if(terminalFallback){state.falling=false;state.paused=true;updateUI(continuationStatus==="unavailable"?"持续求解不可用，已暂停在有限片段末时刻。":"持续求解已停止，已暂停在最后有效画面。");}
        } else {
          state.flightRadius=candidateRadius;state.zoom=state.viewZoom=astrophysics.zoomForRadius(state.flightRadius,m);state.waitingForData=false;
          if(state.flightRadius<=astrophysics.minimumRadius(m,"infall")+1e-9){state.falling=false;state.paused=true;updateUI("旅程已跨越外视界；暂停在当前观察位置，Esc 返回。");}
        }
      } else {
        const nextTime=state.time+elapsed*state.speed,candidateTime=350+nextTime*8+flight.coordinateTime;
        if(movie&&candidateTime>availableTime+1e-6){state.time=Math.max(state.time,(availableTime-350-flight.coordinateTime)/8);state.waitingForData=!terminalFallback;if(terminalFallback){state.falling=false;state.paused=true;updateUI(continuationStatus==="unavailable"?"持续求解不可用，已暂停在有限片段末时刻。":"持续求解已停止，已暂停在最后有效画面。");}}
        else {state.time=nextTime;state.waitingForData=false;}
      }
    }
    const movingBefore=state.viewZoom!==state.zoom;
    state.viewZoom=navigation.smoothZoom(state.viewZoom,state.zoom,elapsed,state.reducedMotion);
    size.scale=Math.min(size.width,size.height)*.028*state.viewZoom;
    const moving=state.viewZoom!==state.zoom,wasInteracting=state.interacting;
    state.interacting=gestures.active||rangePointers.size>0||moving||(state.falling&&!state.paused);
    // Finishing a drag, journey or eased zoom must refine even if the final
    // camera values are unchanged from the last coarse frame.
    if((movingBefore&&!moving)||(wasInteracting&&!state.interacting))renderer.refine?.();
    flight=renderer.physical?astrophysics.camera(state,astrophysics.model(state)):navigation.view(state.viewZoom,state.reducedMotion);
    // Idle drift runs only for the full-view framing: the zoom journey owns the orbit
    // beyond 1.4x, the open panel keeps the stage, and a recent interaction holds it off.
    // Reduced motion freezes the camera immediately, even when disk playback is enabled.
    if(state.reducedMotion)driftRate=0;
    else if(!state.paused&&!document.hidden){
      const suppressed=state.falling||gestures.active||rangePointers.size>0||shell.open||flight.stage!=="observe"||(driftUntil!==null&&now-driftUntil<navigation.drift.waitSeconds*1000);
      const advanced=navigation.driftStep(driftAngle,driftRate,elapsed,suppressed);
      driftAngle=advanced.angle;driftRate=advanced.rate;state.drift=driftAngle;
    }
    if(flight.stage!==flightStage){
      flightStage=flight.stage;
      flightStatus.hidden=flightStage!=="approach"&&flightStage!=="inside";
      flightStatus.textContent=!renderer.physical?"兼容粒子投影 · 未计算视界内观察":flightStage==="inside"?"已跨越外视界 · 外界光仍可抵达 · Esc 返回":state.observer==="static"?"接近静止观察极限 · 可切换自由落体":"沿自由落体轨迹接近视界 · Esc 返回";
    }
    lastTime=now;renderer.draw(elapsed);
    updateTimingReadout();
    if(movie&&renderer.metrics?.dataStatus!=="ready"){flightStatus.hidden=false;flightStatus.textContent=renderer.metrics?.dataStatus==="error"?"热流历史未能载入 · 展开控制选择热盘或刷新重试":"正在载入热流历史…";}
    else if(movie&&renderer.metrics?.continuationStatus==="unavailable"){flightStatus.hidden=false;flightStatus.textContent="持续求解不可用 · 已回退到有限片段播放";}
    else if(movie&&renderer.metrics?.continuationStatus==="failed"){flightStatus.hidden=false;flightStatus.textContent="持续求解已停止 · 保留最后有效画面";}
    else if(movie&&state.waitingForData){flightStatus.hidden=false;flightStatus.textContent=`等待热流数据 · 最新完整状态 t=${(renderer.metrics?.latestSimulationTime??availableTime).toFixed(0)}`;}
    else flightStatus.hidden=flightStage!=="approach"&&flightStage!=="inside";
    updateSampleReadout();
    updateSolverReadout(movie,renderer.metrics);
    if(movie&&renderer.metrics?.movieEnded&&!state.paused){
      // Keep the terminal fallback finite: no future continuation means no
      // reason to schedule another animation frame at the same observation.
      state.paused=true;state.falling=false;state.waitingForData=false;updateUI(continuationStatus==="unavailable"?"持续求解不可用，已暂停在有限片段末时刻。":"持续求解已停止，已暂停在最后有效画面。");
    }
    // Interior observers still receive light. No cinematic opacity parks them.
    if((moving||!state.paused)&&!document.hidden&&!contextLost&&!frame)frame=requestAnimationFrame(animate);
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
    Object.values(choices).forEach(element=>element.disabled=true);fields.charge.disabled=true;fields.exposure.disabled=true;
    defaults.observer="static";state.observer="static";document.querySelector('label[for="density"]').textContent="粒子数量";
    document.querySelectorAll('[data-model="reissner"],[data-model="kerr-newman"]').forEach(button=>button.disabled=true);
    status.textContent="兼容粒子投影；热流、偏振和视界内观察需要 WebGL2。";
  }
  // Compare effective spin/charge, not dormant slider values in metrics that
  // suppress them. Framing, playback, display and exposure are independent.
  function isPresetCustomized(model) {
    const preset=astrophysics.scenes[state.scene],same=(a,b)=>Math.abs(a-b)<=1e-9;
    return state.model!==preset.model||!same(model.spin,preset.spin)||!same(model.charge||0,preset.charge)||state.band!==preset.band;
  }
  function updateTimingReadout() {
    const metrics=renderer.metrics,source=metrics?.timingSource;
    const label={"gpu-query":"GPU 查询","gpu-query-pending":"等待 GPU 查询","cpu-submission":"CPU 提交耗时（GPU 计时不可用）","cpu-submission-disjoint":"CPU 提交耗时（GPU 查询失效）",mixed:"混合（GPU 查询与 CPU 提交）"}[source]||"等待首帧计时";
    // Throttled diagnostics retain their original version; stale counts must
    // not look like a completed health check for the current observation.
    const diagnostic=metrics?.diagnosticCurrent===false?" · 诊断待更新":"";
    document.querySelector("#timing-source").textContent=renderer.physical?`计时来源：${label}${diagnostic}`:"计时来源：Canvas 投影";
  }
  function updateSampleReadout() {
    const metrics=renderer.metrics,progress=renderer.physical&&metrics?.progressiveTarget>1?` · ${metrics.progressiveSamples}/${metrics.progressiveTarget} 次细化`:"";
    // Count stays the actual per-pass ray pixels. Separate progress reports the
    // finite display sampling work without inflating the configured ray budget.
    document.querySelector("#particle-count").textContent=`${renderer.count().toLocaleString("zh-CN")} ${renderer.physical?"光线":"PT"}${progress}`;
  }
  function updateSolverReadout(recorded,metrics={}) {
    const readout=document.querySelector("#solver-readout");readout.hidden=!recorded;if(!recorded)return;
    const stateLabel={loading:"初始化",ready:"持续求解",computing:"计算中",backpressure:"等待缓存消费",paused:"求解暂停",unavailable:"有限片段回退",failed:"求解失败"}[metrics.continuationStatus]||"持续求解准备中";
    document.querySelector("#solver-status").textContent=stateLabel;
    document.querySelector("#solver-latest").textContent=`最新 t=${(metrics.latestSimulationTime??metrics.historyEndTime??800).toFixed(0)}`;
    document.querySelector("#solver-observation").textContent=`观测 t=${(metrics.observationTime??metrics.simulationTime??350).toFixed(0)}`;
    document.querySelector("#solver-rate").textContent=`${(metrics.solverStepRate??0).toFixed(1)} GM/c³/s`;
    document.querySelector("#solver-history").textContent=metrics.historyMissing?"光路历史缺失 · 仅使用缓存窗口":"历史完整";
    if(metrics.continuationStatus==="unavailable")document.querySelector("#solver-history").textContent="有限片段回退 · 不宣称持续求解";
    const diagnostics=metrics.solverDiagnostics;
    document.querySelector("#solver-diagnostics").textContent=diagnostics?.length>=8?`质量 ${(diagnostics[4]*100).toFixed(3)}% · 内能 ${(diagnostics[5]*100).toFixed(3)}% · 坐标 divB~${diagnostics[6].toExponential(1)} · u漂移 ${diagnostics[7].toExponential(1)}`:"守恒与约束诊断等待中";
    const renderState=document.querySelector("#render-state");
    renderState.textContent=state.paused?"画面已暂停":state.waitingForData?"等待热流数据":metrics.continuationStatus==="computing"?"持续求解中":"相对论辐射成像";
  }
  function snapshot() {
    const model=renderer.physical?astrophysics.model(state):physics.model(state);
    return {scene:state.scene,model:state.model,spin:model.spin,charge:model.charge||0,isco:model.isco,mass:model.mass,accretionRate:model.mdot,band:state.band,display:state.display,observer:state.observer,falling:state.falling,waitingForData:state.waitingForData,exposure:state.exposure,tilt:state.tilt,speed:state.speed,density:state.density,samples:{budget:state.density,actual:renderer.count(),passes:renderer.metrics?.progressiveSamples??1,targetPasses:renderer.metrics?.progressiveTarget??1,total:renderer.metrics?.progressiveRaySamples??renderer.count()},zoom:state.zoom,flight:renderer.physical?astrophysics.camera(state,model):navigation.view(state.viewZoom,state.reducedMotion),paused:state.paused,controlsExpanded:shell.open,presetCustomized:isPresetCustomized(model),computationalRadius:renderer.physical?model.computationalRadius:null,initialObserverDistance:renderer.physical?model.initialObserverDistance:null,latestSimulationTime:renderer.metrics?.latestSimulationTime??null,observationTime:renderer.metrics?.observationTime??null,solverStepRate:renderer.metrics?.solverStepRate??0,solverDiagnostics:renderer.metrics?.solverDiagnostics??null,historyMissing:Boolean(renderer.metrics?.historyMissing),timingSource:renderer.metrics?.timingSource||(renderer.physical?"pending":"canvas-projection"),render:renderer.metrics?{...renderer.metrics}:{mode:"canvas-projection"}};
  }
  function updateUI(message) {
    const model=renderer.physical?astrophysics.model(state):physics.model(state);
    const recorded=renderer.physical&&model.flow==="grmhd";
    const customized=isPresetCustomized(model);
    document.querySelector("#preset-customized").hidden=!customized;
    document.querySelector("#preset-customized-help").hidden=!customized;
    document.querySelector("#restore-preset").hidden=!customized;
    document.querySelector("#physics-help").textContent=recorded?"模拟数据固定为克尔时空，a=0.9375、Q=0；请先选择热盘预设再调整时空。":"调整当前场景预设的物理参数。";
    const spinBound=Math.sqrt(Math.max(0,.998**2-(model.charge||0)**2));
    fields.spin.min=String(-spinBound);fields.spin.max=String(spinBound);
    fields.charge.max=String(Math.min(.95,Math.sqrt(Math.max(0,.998**2-model.spin**2))));
    const values={spin:model.spin.toFixed(3),charge:(model.charge||0).toFixed(2),tilt:`${state.tilt}°`,speed:`${state.speed.toFixed(1)} ×`,density:state.density.toLocaleString("zh-CN"),zoom:`${state.zoom.toFixed(1)} ×`,exposure:`${state.exposure.toFixed(2)} ×`};
    Object.entries(fields).forEach(([key,element])=>{
      const value=key==="spin"?model.spin:key==="charge"?(model.charge||0):state[key];element.value=String(value);
      const span=Number(element.max)-Number(element.min);
      element.style.setProperty("--progress",`${span>0?(value-Number(element.min))/span*100:0}%`);
      element.setAttribute("aria-valuetext",values[key]);document.getElementById(`${key}-value`).textContent=values[key];
    });
    // Native sliders expose the joint subextremal constraint before input.
    fields.spin.disabled=!["kerr","kerr-newman"].includes(state.model)||recorded;
    fields.charge.disabled=!["reissner","kerr-newman"].includes(state.model)||recorded||!renderer.physical;
    Object.entries(choices).forEach(([key,element])=>element.value=state[key]);
    // The current hot-plasma solver is monochromatic at 230 GHz. Disabling
    // other bands is preferable to presenting a single-frequency value as a
    // visible/X-ray band integral; those bands remain available for thermal disks.
    for(const option of choices.band.options||[])option.disabled=recorded&&option.value!=="radio";
    document.querySelector("#mass-value").textContent=model.mass?`${model.mass.toLocaleString("zh-CN")} M☉`:"投影示意";
    document.querySelector("#accretion-value").textContent=!renderer.physical?"未标定":model.mdot?model.mdot.toExponential(1):"无吸积";
    document.querySelector("#band-help").textContent={visible:"380–780 nm · 光谱积分",xray:"0.5–10 keV · 强度显色",radio:"230 GHz · 强度显色",bolometric:"总辐射 · 强度显色"}[state.band];
    document.querySelector("#display-help").textContent={intensity:"颜色由波段与辐射强度决定。",linear:"短线方向为线偏振方向，长度对应偏振比例。",circular:"橙色为正 V，蓝色为负 V；比例显示增益 20。",accuracy:"粉色为未收敛，红色为无效；绿色显示局部积分误差。"}[state.display];
    document.querySelector("#isco-value").textContent=`${model.isco.toFixed(2)} r_g`;
    document.querySelectorAll("[data-model]").forEach(button=>{
      button.setAttribute("aria-pressed",String(button.dataset.model===state.model));
      button.disabled=recorded&&button.dataset.model!=="kerr"||!renderer.physical&&["reissner","kerr-newman"].includes(button.dataset.model);
      button.title=recorded&&button.dataset.model!=="kerr"?"模拟数据固定为克尔时空，a=0.9375、Q=0":"";
    });
    document.querySelector("#computational-radius-value").textContent=renderer.physical?`${model.computationalRadius} r_g`:"投影示意";
    document.querySelector("#observer-distance-value").textContent=renderer.physical?`${model.initialObserverDistance} r_g`:"投影示意";
    updateTimingReadout();
    document.querySelectorAll("[data-preset]").forEach(button=>{
      const chosen=button.dataset.preset==="top"?state.tilt===78&&state.zoom===.9:state.tilt===18&&state.zoom===1;
      button.setAttribute("aria-pressed",String(chosen));
    });
    document.querySelector("#pause").setAttribute("aria-pressed",String(state.paused));
    document.querySelector("#pause-label").textContent=state.paused?"播放":"暂停";
    document.querySelector("#pause-icon").setAttribute("d",state.paused?"M6 4l9 6-9 6Z":"M7 4v12M13 4v12");
    updateSampleReadout();
    document.querySelector("#render-state").textContent=renderer.kind==="canvas"?"兼容示意":state.paused?"画面已暂停":"相对论辐射成像";
    const fallButton=document.querySelector("#fall");fallButton.disabled=!renderer.physical||state.reducedMotion;fallButton.setAttribute("aria-pressed",String(state.falling));fallButton.textContent=state.falling?"停止自由落体旅程":"开始自由落体旅程";
    updateSolverReadout(recorded,renderer.metrics);if(message)status.textContent=message;
  }
  // Selection and restoration use exactly the same initial physics/camera
  // patch; only an explicit configure call can override those preset values.
  function presetSettings(sceneId) {
    const preset=astrophysics.scenes[sceneId];
    return {scene:sceneId,model:preset.model,spin:preset.spin,charge:preset.charge,band:preset.band,tilt:preset.tilt,observer:preset.observer||defaults.observer,zoom:defaults.zoom,yaw:defaults.yaw,falling:false,time:0};
  }
  function applySettings(settings,message) {
    // Check the entire update before changing state so failed agent input is atomic.
    const limits={spin:[-.998,.998],charge:[0,.95],tilt:[-89,89],speed:[.1,3],density:[Number(fields.density.min),Number(fields.density.max)],zoom:[navigation.limits.min,navigation.limits.max],exposure:[.05,5]};
    for(const [key,value] of Object.entries(settings)) {
      if(Object.hasOwn(limits,key)) {
        const [min,max]=limits[key];
        if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)throw new Error(`${key} must be between ${min} and ${max}`);
        if(key==="density"&&!Number.isInteger(value))throw new Error(`${key} must be an integer`);
      } else if(key==="model") {if(!["schwarzschild","kerr","reissner","kerr-newman"].includes(value))throw new Error("Unsupported model");}
      else if(key==="scene") {if(!Object.hasOwn(astrophysics.scenes,value))throw new Error("Unsupported scene");}
      else if(key==="band") {if(!["visible","xray","radio","bolometric"].includes(value))throw new Error("Unsupported band");}
      else if(key==="display") {if(!["intensity","linear","circular","accuracy"].includes(value))throw new Error("Unsupported display");}
      else if(key==="observer") {if(!["static","infall"].includes(value))throw new Error("Unsupported observer");}
      else if(key==="paused") {if(typeof value!=="boolean")throw new Error("paused must be a boolean");}
      else if(key==="falling") {if(typeof value!=="boolean")throw new Error("falling must be a boolean");}
      else if(key==="yaw") {if(typeof value!=="number"||!Number.isFinite(value))throw new Error("yaw must be finite");}
      else throw new Error(`Unknown parameter: ${key}`);
    }
    let patch={...settings};
    const presetApplied=Object.hasOwn(patch,"scene");
    if(presetApplied)patch={...presetSettings(patch.scene),...patch,time:0};
    if(patch.falling===true)patch.observer="infall";
    const next={...state,...patch},candidate=astrophysics.model(next);
    if(candidate.spin**2+candidate.charge**2>.998**2+1e-12)throw new Error("Spin and charge must describe a subextremal black hole");
    // Reject incompatible metrics before touching any state, including time,
    // camera and playback. Changing datasets always requires an explicit scene.
    if(candidate.flow==="grmhd"&&(next.model!=="kerr"||next.spin!==.9375||next.charge!==0))throw new Error("模拟数据固定为克尔时空，a=0.9375、Q=0；请主动选择热盘预设后再修改。");
    if(candidate.flow==="grmhd"&&next.band!=="radio")throw new Error("The recorded hot-flow model currently supports the 230 GHz band");
    if(patch.falling&&(!renderer.physical||state.reducedMotion))throw new Error("Automatic free fall requires WebGL2 and motion enabled");
    if(!renderer.physical&&(["reissner","kerr-newman"].includes(next.model)||["scene","band","display","observer","charge"].some(key=>Object.hasOwn(settings,key)&&next[key]!==state[key])))throw new Error("Physical observation modes require WebGL2");
    // Only an actual change of a camera field resets the journey. Key presence is
    // not enough: requesting free fall always re-states observer=infall, and that
    // repeated value must not discard an already calibrated lens.
    const cameraChange=["scene","model","observer","spin","charge","zoom","yaw","tilt"].some(key=>Object.hasOwn(patch,key)&&patch[key]!==state[key]);
    const resuming=patch.falling===true&&!cameraChange&&Number.isFinite(state.flightRadius)&&Number.isFinite(state.flightLens);
    if(cameraChange){state.falling=false;state.flightRadius=null;state.flightLens=null;}
    const becamePaused=!state.paused&&next.paused;
    Object.assign(state,patch);
    if(presetApplied){state.viewZoom=state.zoom;state.waitingForData=false;driftAngle=state.drift=0;driftRate=0;markDriftInteraction();renderer.resetSimulation?.();}
    // Resuming keeps the lens that fixed the journey's field of view; animate has
    // replaced viewZoom with the journey's own zoom, so re-deriving the lens from
    // it would change the framing mid-fall.
    if(patch.falling===true){const camera=astrophysics.camera(state,candidate);state.flightRadius=camera.r;if(!resuming)state.flightLens=state.viewZoom*camera.r;}
    if(state.paused&&frame){cancelAnimationFrame(frame);frame=0;}
    if(becamePaused)renderer.refine?.();
    updateUI(message);requestRender();return snapshot();
  }
  Object.entries(fields).forEach(([key,element])=>{
    element.addEventListener("input",()=>{try{applySettings({[key]:Number(element.value)});}catch(error){updateUI(error.message);}});
    element.addEventListener("pointerdown",event=>{if(event.button!==0)return;if(key!=="exposure")rangePointers.add(event.pointerId);markDriftInteraction();requestRender();});
  });
  const finishRange=event=>{
    if(!rangePointers.delete(event.pointerId))return;
    markDriftInteraction();renderer.refine?.();requestRender();
  };
  document.addEventListener("pointerup",finishRange);document.addEventListener("pointercancel",finishRange);
  Object.entries(choices).forEach(([key,element])=>element.addEventListener("change",()=>{try{applySettings({[key]:element.value});}catch(error){updateUI(error.message);}}));
  document.querySelectorAll("[data-model]").forEach(button=>button.addEventListener("click",()=>{try{
    const model=button.dataset.model,patch={model};
    if(["reissner","kerr-newman"].includes(model)){patch.charge=state.charge||.6;if(model==="kerr-newman")patch.spin=Math.sign(state.spin||1)*Math.min(Math.abs(state.spin),Math.sqrt(.998**2-patch.charge**2)*.99);}
    applySettings(patch,"黑洞时空模型已切换。");
  }catch(error){updateUI(error.message);}}));
  document.querySelectorAll("[data-preset]").forEach(button=>button.addEventListener("click",()=>{
    const top=button.dataset.preset==="top";applySettings({tilt:top?78:18,zoom:top ? .9 : 1,yaw:0},top?"已切换至俯瞰视角。":"已切换至电影视角。");
  }));
  document.querySelector("#pause").addEventListener("click",()=>applySettings({paused:!state.paused},state.paused?"模拟继续播放。":"画面已暂停。"));
  document.querySelector("#fall").addEventListener("click",()=>applySettings({falling:!state.falling,paused:state.falling},state.falling?"旅程已停止，暂停在当前观察位置。":"沿当前自由落体轨迹接近，操作镜头可停止旅程。"));
  document.querySelector("#restore-preset").addEventListener("click",()=>{gestures.cancel();applySettings({scene:state.scene},"已恢复场景预设的物理参数、波段与初始视角。");});
  document.querySelector("#reset").addEventListener("click",()=>{gestures.cancel();applySettings({...defaults},"观测参数已重置。");});

  shell.addEventListener("toggle",event=>{
    // Native details events are currently non-bubbling, but keep the target
    // guard explicit so future nested disclosures cannot move the canvas.
    if(event.target&&event.target!==shell)return;
    toggle.title=shell.open?"收起观测控制":"展开观测控制";
    toggle.setAttribute("aria-label",shell.open?"收起观测控制":"展开观测控制");
    // The view pans away from the open panel so the hole never sits behind it.
    scene.classList.toggle("controls-open",shell.open);
    syncPanelLayout();
    requestAnimationFrame(syncPanelLayout);
    markDriftInteraction();
  });
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    if(shell.open){shell.open=false;toggle.focus();}
    else if(state.zoom>navigation.limits.orbitStart){event.preventDefault();gestures.cancel();markDriftInteraction();applySettings({zoom:1},"已返回远观视角。");}
  });
  document.addEventListener("pointerdown",event=>{if(shell.open&&!shell.contains(event.target))shell.open=false;});
  const fullButton=document.querySelector("#fullscreen");
  // Only expose full screen when the browser can perform the action. The
  // remaining native buttons fill the shared action row on unsupported phones.
  fullButton.hidden=typeof scene.requestFullscreen!=="function"||document.fullscreenEnabled===false;
  fullButton.addEventListener("click",async()=>{
    try {
      if(document.fullscreenElement)await document.exitFullscreen();
      else if(scene.requestFullscreen)await scene.requestFullscreen();
      else status.textContent="此浏览器暂不支持全屏，请尝试横屏观测。";
    } catch {status.textContent="未能进入全屏，请允许全屏后重试。";}
  });
  document.addEventListener("fullscreenchange",()=>{document.querySelector("#fullscreen-label").textContent=document.fullscreenElement?"退出全屏":"全屏";fullButton.setAttribute("aria-pressed",String(Boolean(document.fullscreenElement)));resize();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden){renderer.setSolverActive?.(false);if(frame)cancelAnimationFrame(frame);frame=0;}else requestRender();});
  reducedMotion.addEventListener("change",event=>{state.reducedMotion=event.matches;if(event.matches)applySettings({paused:true,falling:false},"已按减少动态效果偏好暂停；可播放物质演化，镜头保持静止。");else {updateUI();requestRender();}});

  const surface=activeCanvas();
  // The gesture owner holds idle drift for captured pointers and native trackpad
  // gestures alike; ignored buttons never latch a hold, and wheel uses the idle window.
  const gestures=navigation.bind(surface,{read:()=>state,change:settings=>{markDriftInteraction();applySettings(settings);},finish:()=>{markDriftInteraction();renderer.refine?.();requestRender();}});
  window.addEventListener("blur",()=>{gestures.cancel();if(rangePointers.size){rangePointers.clear();renderer.refine?.();requestRender();}});
  window.addEventListener("pagehide",event=>{if(!event.persisted)gestures.dispose();});
  surface.addEventListener("keydown",event=>{
    if(event.ctrlKey||event.metaKey)return;
    const edits={ArrowLeft:{yaw:state.yaw-.12},ArrowRight:{yaw:state.yaw+.12},ArrowUp:{tilt:Math.min(89,state.tilt+2)},ArrowDown:{tilt:Math.max(-89,state.tilt-2)},"+":{zoom:navigation.clampZoom(state.zoom*1.15)},"=":{zoom:navigation.clampZoom(state.zoom*1.15)},"-":{zoom:navigation.clampZoom(state.zoom/1.15)}," ":{paused:!state.paused}};
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
    register({name:"get_observation",title:"读取观测参数",description:"Read physical scene, spacetime, observer, band, actual ray samples and renderer convergence.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){if(input&&Object.keys(input).length)throw new Error("No arguments accepted");return snapshot();}});
    register({name:"configure_observation",title:"调整黑洞观测",description:"Configure spacetime, physical scene, observing band and timelike observer. Density is the target ray-sampling budget, not gas density. Falling starts/stops a proper-time geodesic journey. Controls stay collapsed.",inputSchema:{type:"object",properties:{scene:{type:"string",enum:Object.keys(astrophysics.scenes)},model:{type:"string",enum:["schwarzschild","kerr","reissner","kerr-newman"]},spin:{type:"number",minimum:-.998,maximum:.998},charge:{type:"number",minimum:0,maximum:.95},band:{type:"string",enum:["visible","xray","radio","bolometric"]},display:{type:"string",enum:["intensity","linear","circular","accuracy"]},observer:{type:"string",enum:["static","infall"]},falling:{type:"boolean"},exposure:{type:"number",minimum:.05,maximum:5},tilt:{type:"number",minimum:-89,maximum:89},speed:{type:"number",minimum:.1,maximum:3},density:{type:"integer",minimum:Number(fields.density.min),maximum:Number(fields.density.max)},zoom:{type:"number",minimum:navigation.limits.min,maximum:navigation.limits.max},paused:{type:"boolean"}},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Expected an observation object");return applySettings(input,"观测参数已更新。");}});
    window.addEventListener("pagehide",event=>{if(!event.persisted)lifecycle.abort();});
  }
  const observer=new ResizeObserver(resize);observer.observe(scene);
  // Details groups and live messages can change the panel height after the
  // outer toggle; update only the clearance variables when that happens.
  const panelObserver=new ResizeObserver(syncPanelLayout);panelObserver.observe(panel);
  // Header feedback may grow without changing the already capped sheet height.
  // Observe that row as well, keeping sticky-header scroll padding up to date.
  if(panelHeader)panelObserver.observe(panelHeader);
  updateUI(reducedMotion.matches?"已按减少动态效果偏好暂停，可点击播放继续观测。":undefined);resize();
})();
