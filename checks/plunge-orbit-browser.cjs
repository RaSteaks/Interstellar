// Real GPU and product interactions in an isolated headless Firefox/WebKit.
// The optional agent registry is the only substituted browser API.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SIMULATION_BROWSER||'webkit';
assert.ok(['firefox','webkit'].includes(engine),'Use headless Firefox or WebKit');
const base=process.argv[2]||'http://127.0.0.1:18786';
const output=path.join(__dirname,'../verification/plunge-orbit',engine);
fs.mkdirSync(output,{recursive:true});

(async()=>{
 const browser=await playwright[engine].launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'no-preference'});
 const report={browser:engine,version:browser.version(),gpu:[],ui:[],errors:[],console:[],requests:[]};
 let activePage;
 const attach=page=>{
  activePage=page;
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',message=>report.console.push({type:message.type(),text:message.text()}));
  page.on('request',request=>report.requests.push({url:request.url(),type:request.resourceType()}));
 };
 await context.tracing.start({screenshots:true,snapshots:true});
 try{
  const gpu=await context.newPage();attach(gpu);
  await gpu.goto(base+'/checks/physical-browser.html');await gpu.waitForFunction(()=>window.result);
  // Compile the actual production flux function, rather than a copied formula.
  // Integer-mode quadrature independently checks its unit annular mean.
  const fluxSource=fs.readFileSync(path.join(__dirname,'../dist/physical-renderer.js'),'utf8').match(/      float thermalFluxPattern\([\s\S]+?\n      \}/)[0];
  const annuli=await gpu.evaluate(source=>{
   currentEngine.dispose();const gl=document.getElementById('cosmos').getContext('webgl2');
   const shader=(type,code)=>{const value=gl.createShader(type);gl.shaderSource(value,code);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(value));return value;};
   const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nlayout(location=0) in vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
   const fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;uniform float radial,seed;out vec4 color;'+source+'\nvoid main(){color=vec4(thermalFluxPattern((gl_FragCoord.x-.5)/1024.*6.28318530718,radial,seed),0.,0.,1.);}');
   const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
   const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1024,1,0,gl.RGBA,gl.FLOAT,null);
   const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);gl.drawBuffers([gl.COLOR_ATTACHMENT0]);gl.readBuffer(gl.COLOR_ATTACHMENT0);
   const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
   gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);gl.viewport(0,0,1024,1);gl.useProgram(program);const result=[];
   for(const pair of [[0,0],[.7,2.4],[-1.5,-7]]){
    gl.uniform1f(gl.getUniformLocation(program,'radial'),pair[0]);gl.uniform1f(gl.getUniformLocation(program,'seed'),pair[1]);gl.drawArrays(gl.TRIANGLES,0,3);
    const data=new Float32Array(1024*4);gl.readPixels(0,0,1024,1,gl.RGBA,gl.FLOAT,data);
    const values=Array.from({length:1024},(_,i)=>data[i*4]);result.push({mean:values.reduce((sum,value)=>sum+value,0)/1024,min:Math.min(...values),max:Math.max(...values)});
   }
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);gl.deleteTexture(texture);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);return result;
  },fluxSource);
  for(const annulus of annuli){assert.ok(Math.abs(annulus.mean-1)<1e-5);assert.ok(annulus.min>0&&annulus.max<5.27);}
  report.fluxAnnuli=annuli;
  const emission=await gpu.evaluate(async()=>{
   await runPhysicalCase({scene:'plunge',observer:'static',time:0,density:8192,verification:{progressiveSamples:1,skyEnabled:false}});
   const first=currentEngine.readback();caseState.time=4;currentEngine.draw({width:640,height:400,scale:400*.028},0);const later=currentEngine.readback();
   let light=0,change=0;for(let i=0;i<first.radiance.length;i++)if(i%4!==3){light+=Math.abs(first.radiance[i]);change+=Math.abs(first.radiance[i]-later.radiance[i]);}
   await runPhysicalCase({scene:'plunge',observer:'static',time:0,density:8192,verification:{progressiveSamples:1,skyEnabled:false,forceFullThermal:true}});
   const full=currentEngine.readback();let scalarDifference=0;for(let i=0;i<first.radiance.length;i++)if(i%4!==3)scalarDifference+=Math.abs(first.radiance[i]-full.radiance[i]);
   return {light,relativeChange:change/light,scalarDifference:scalarDifference/light};
  });
  assert.ok(emission.light>0&&emission.relativeChange>.05,'The emitting disk must evolve at a fixed observer');
  assert.ok(emission.scalarDifference<.001,'Scalar and full thermal kernels must use the same emitting structure');report.emission=emission;
  for(const radius of [80,12,4.05,3.95,2.001,1.999,.7]){
   const captured=await gpu.evaluate(async radius=>{
    const result=await runPhysicalCase({scene:'plunge',observer:'infall',flightRadius:radius,flightLens:80,density:4096});
    // Capture in the drawing task: preserveDrawingBuffer=false allows the
    // browser to clear a later screenshot of this otherwise idle test canvas.
    return {result,png:document.getElementById('cosmos').toDataURL('image/png')};
   },radius);
   const result=captured.result;
   report.gpu.push({radius,...result});
   assert.equal(result.mode,'webgl2-volume-grrt');assert.equal(result.finite,true);
   assert.equal(result.invalidRays,0);assert.equal(result.unfinishedRays,0);
   assert.ok(result.light>0);assert.equal(result.horizonFade,0);
   fs.writeFileSync(path.join(output,`gpu-r${radius}.png`),Buffer.from(captured.png.split(',')[1],'base64'));
   console.log('GPU PASS',radius,result.raySamples);
  }
  assert.ok(new Set(report.gpu.map(result=>result.light)).size===report.gpu.length,'Distinct events must render distinct images');
  for(const radius of [4.05,2.001,1.999,.7]){
   const result=await gpu.evaluate(radius=>runPhysicalCase({scene:'plunge',observer:'infall',flightRadius:radius,flightLens:80,density:16000,paused:false,interacting:true}),radius);
   assert.equal(result.traceQuality,'interactive');assert.equal(result.finite,true);assert.equal(result.invalidRays,0);assert.equal(result.unfinishedRays,0);
   report.gpu.push({radius,interactive:true,...result});
  }
  const attitude=await gpu.evaluate(async()=>{
   await runPhysicalCase({scene:'plunge',observer:'infall',flightRadius:1.999,flightLens:80,density:4096,look:'center'});
   const before=BlackHoleAstrophysics.camera(caseState,BlackHoleAstrophysics.model(caseState)),builds=currentEngine.metrics.geodesicBuilds;
   caseState.look='outward';currentEngine.draw({width:640,height:400,scale:400*.028},0);
   const image=currentEngine.readback(),after=BlackHoleAstrophysics.camera(caseState,BlackHoleAstrophysics.model(caseState));
   const light=image.radiance.reduce((sum,value,i)=>sum+(i%4===3?0:value),0);
   const png=document.getElementById('cosmos').toDataURL('image/png');
   return {before:before.u,after:after.u,builds,afterBuilds:currentEngine.metrics.geodesicBuilds,light,png};
  });
  assert.deepEqual(attitude.before,attitude.after);assert.ok(attitude.afterBuilds>attitude.builds);assert.ok(attitude.light>.001);
  fs.writeFileSync(path.join(output,'gpu-look-back-inside.png'),Buffer.from(attitude.png.split(',')[1],'base64'));
  report.ui.push({case:'GPU attitude change retraces without changing velocity',light:attitude.light,passed:true});
  for(const scene of ['quasar','isolated']){
   const result=await gpu.evaluate(scene=>runPhysicalCase({scene,density:4096}),scene);
   assert.equal(result.finite,true);assert.equal(result.invalidRays,0);assert.equal(result.unfinishedRays,0);assert.ok(result.light>0);
   report.gpu.push({baseline:true,...result});
  }
  await gpu.close();

  const page=await context.newPage();attach(page);
  await page.addInitScript(()=>{
   window.observationTools={};
   Object.defineProperty(document,'modelContext',{configurable:true,value:{registerTool(tool){window.observationTools[tool.name]=tool;}}});
  });
  await page.goto(base+'/dist/');await page.waitForFunction(()=>window.observationTools?.get_observation);
  const observe=()=>page.evaluate(()=>observationTools.get_observation.execute({}));
  const configure=options=>page.evaluate(options=>observationTools.configure_observation.execute(options),options);
  const openGroup=async id=>{const group=page.locator('#'+id);if(await group.getAttribute('open')===null)await group.locator('summary').click();};
  await configure({paused:true,density:16000});
  assert.equal((await observe()).render.mode,'webgl2-volume-grrt');
  await page.locator('.control-toggle').click();
  await page.locator('#scene-choice').selectOption('plunge');
  let observation=await observe();assert.equal(observation.scene,'plunge');assert.equal(observation.flight.r,80);assert.equal(observation.falling,false);
  assert.equal(observation.computationalRadius,25);
  for(const model of ['kerr','reissner','kerr-newman'])assert.equal(await page.locator(`[data-model="${model}"]`).isEnabled(),false);
  await openGroup('camera-group');
  assert.equal(await page.locator('label[for="tilt"]').textContent(),'轨道倾角');
  assert.equal(await page.locator('#observer').getAttribute('aria-describedby'),'observer-help');
  await page.locator('#fall').click();
  await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.r<79.95);
  observation=await observe();assert.equal(observation.falling,true);assert.ok(observation.flight.orbit>0);
  report.ui.push({case:'live journey',radius:observation.flight.r,phase:observation.flight.orbit,render:observation.render});
  await page.locator('#fall').click();const stopped=await observe();
  await page.waitForTimeout(300);assert.deepEqual((await observe()).flight,stopped.flight);
  await page.locator('#look').selectOption('outward');
  const lookingBack=await observe();assert.deepEqual(lookingBack.flight.u,stopped.flight.u);assert.equal(lookingBack.flight.r,stopped.flight.r);
  await page.locator('#fall').click();
  const resumed=await observe();assert.ok(resumed.flight.r<=stopped.flight.r&&resumed.flight.r>stopped.flight.r-.2);
  await page.locator('#pause').click();assert.equal((await observe()).paused,true);
  report.ui.push({case:'stop/resume/pause',passed:true});

  // Select a terminal event through the public lens control, then finish the
  // real journey action. Node checks cover uninterrupted full-route playback.
  await configure({falling:false,paused:true,zoom:12});
  await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.stage==='inside');
  await page.locator('#fall').click();await page.waitForFunction(()=>document.getElementById('fall').textContent==='重播绕行坠落旅程');
  await page.locator('#fall').click();await configure({paused:true});
  observation=await observe();assert.ok(observation.flight.r>79);assert.equal(observation.falling,true);
  assert.equal(observation.look,'outward');
  await configure({falling:false,paused:true});
  await page.screenshot({path:path.join(output,'desktop-controls.png')});
  report.ui.push({case:'terminal replay',passed:true});

  const rejection=await page.evaluate(()=>{
   const before=observationTools.get_observation.execute({});
   try{observationTools.configure_observation.execute({model:'kerr',spin:.4,exposure:2});return {accepted:true};}
   catch(error){return {message:error.message,before,after:observationTools.get_observation.execute({})};}
  });
  assert.match(rejection.message,/史瓦西/);
  for(const key of ['scene','model','spin','charge','exposure','paused','falling','zoom'])assert.equal(rejection.before[key],rejection.after[key]);
  report.ui.push({case:'atomic incompatible-metric rejection',passed:true});

  await page.setViewportSize({width:390,height:844});
  await page.locator('#fall').scrollIntoViewIfNeeded();
  const mobile=await page.evaluate(()=>{
   const fall=document.getElementById('fall'),rect=fall.getBoundingClientRect();
   return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,height:rect.height,width:rect.width,label:fall.textContent};
  });
  assert.equal(mobile.scroll,mobile.viewport);assert.ok(mobile.height>=44&&mobile.width>=44);
  await page.screenshot({path:path.join(output,'mobile-controls.png')});report.ui.push({case:'390px layout',...mobile});
  await page.locator('#scene-choice').focus();await page.locator('#scene-choice').press('Space');
  await page.screenshot({path:path.join(output,'native-scene-popup.png')});await page.keyboard.press('Escape');
  assert.equal((await observe()).scene,'plunge');
  await page.locator('#cosmos').focus();await page.keyboard.press('Escape');assert.equal((await observe()).controlsExpanded,false);
  report.ui.push({case:'native selector and keyboard Escape',passed:true});

  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.control-toggle').click();
  assert.equal(await page.locator('#fall').isEnabled(),false);assert.equal((await observe()).paused,true);
  const reduced=await page.evaluate(()=>{
   try{observationTools.configure_observation.execute({falling:true});return {accepted:true};}
   catch(error){return {message:error.message};}
  });
  assert.match(reduced.message,/motion/);await configure({zoom:4});
  await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.r<80);
  await page.screenshot({path:path.join(output,'reduced-motion.png')});
  report.ui.push({case:'reduced motion disables flight, manual event selection works',passed:true});
  // Preserve a product-resolution capture as well as the deliberately small
  // GPU numerical fixtures. Select the event through the real public API.
  await page.setViewportSize({width:1280,height:800});await page.emulateMedia({reducedMotion:'no-preference'});
  const showcaseZoom=await page.evaluate(()=>BlackHoleAstrophysics.zoomForRadius(8,BlackHoleAstrophysics.model({scene:'plunge'})));
  await configure({scene:'plunge',look:'flight',zoom:showcaseZoom,paused:true,density:128000});
  await page.waitForFunction(()=>{
   const render=observationTools.get_observation.execute({}).render;
   return render.progressiveSamples===4&&render.raySamples>100000;
  });
  await page.locator('#camera-group > summary').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'desktop-controls.png')});
  await page.locator('.control-toggle').click();
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('cosmos')).translate==='none');
  await page.screenshot({path:path.join(output,'realtime-scene.png')});
  assert.equal(await page.locator('video').count(),0);
  assert.ok(report.requests.every(request=>!['media'].includes(request.type)&&! /\.(mp4|webm|mov|m3u8)(?:\?|$)/i.test(request.url)));
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  report.passed=true;console.log('PASS: headless '+engine+' real GPU orbital events, live journey controls, replay, atomic rejection, native selector, narrow layout and reduced motion; no recorded media.');
 }catch(error){
  report.failure=error.stack;process.exitCode=1;
  if(activePage&&!activePage.isClosed())await activePage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  console.error(error);
 }finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await context.tracing.stop({path:path.join(output,'trace.zip')});await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
