// Actual native history + production WebGL2 and UI in isolated headless engines.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SIMULATION_BROWSER||'webkit';assert.ok(['firefox','webkit'].includes(engine));
const base=process.argv[2]||'http://127.0.0.1:18786';
const smoke=process.argv.includes('--smoke'),fixture=process.env.GRMHD3D_FIXTURE;
const output=path.join(__dirname,'../verification/grmhd3d/browser',engine);fs.mkdirSync(output,{recursive:true});

(async()=>{
 const browser=await playwright[engine].launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'});
 const report={browser:engine,version:browser.version(),smoke,fixture:fixture||null,gpu:[],ui:[],errors:[],console:[]};let active;
 const attach=page=>{active=page;page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>report.console.push({type:message.type(),text:message.text()}));};
 await context.tracing.start({screenshots:true,snapshots:true});
 if(fixture)await context.route('**/dist/data/grmhd3d*',route=>{
  const name=new URL(route.request().url()).pathname.split('/').pop();return route.fulfill({path:path.join(fixture,name),contentType:name.endsWith('.json')?'application/json':'application/gzip'});
 });
 try{
  const gpu=await context.newPage();attach(gpu);await gpu.goto(base+'/checks/physical-browser.html');await gpu.waitForFunction(()=>window.result);
  for(const radius of smoke?[40]:[40,15,6,3,2.01,1.99,.7]){
   const captured=await gpu.evaluate(async radius=>{
    const result=await runPhysicalCase({scene:'grmhd3d',reuse:radius!==40,observer:'infall',look:'center',flightRadius:radius,flightLens:40,density:4096});
    return {result,png:document.getElementById('cosmos').toDataURL('image/png')};
   },radius);
   const result=captured.result;report.gpu.push({radius,...result});assert.equal(result.dataStatus,'ready');assert.equal(result.fluid,'grmhd3d');assert.equal(result.continuationStatus,'finite-3d');
   assert.equal(result.finite,true);assert.equal(result.invalidRays,0);assert.equal(result.unfinishedRays,0);assert.equal(result.waitingForData,false);assert.ok(result.light>0);assert.ok(result.polarizationError<1e-5);
   fs.writeFileSync(path.join(output,`native-r${radius}.png`),Buffer.from(captured.png.split(',')[1],'base64'));console.log('3D GPU PASS',radius,result.light);
  }
  const evolution=await gpu.evaluate(async()=>{
   await runPhysicalCase({scene:'grmhd3d',reuse:true,observer:'static',time:0,density:4096});const first=currentEngine.readback();caseState.time=4;currentEngine.draw({width:640,height:400,scale:400*.028},0);const later=currentEngine.readback();
   let norm=0,difference=0;for(let i=0;i<first.radiance.length;i++)if(i%4!==3){norm+=Math.abs(first.radiance[i]);difference+=Math.abs(first.radiance[i]-later.radiance[i]);}
   return {norm,difference,relative:difference/norm};
  });assert.ok(evolution.norm>0&&evolution.relative>.001);report.evolution=evolution;
  // Full acceptance includes the independent connection-ODE screen oracle.
  report.screen=[];
  for(const radius of smoke?[]:[15,3,1.5]){
   const result=await gpu.evaluate(async radius=>{
    const options={scene:'grmhd3d',observer:'infall',look:'center',flightRadius:radius,flightLens:40,density:1024};
    const analytic=await runPhysicalCase({...options,verification:{progressiveSamples:1,rayBudget:1024}});
    const first=currentEngine.readback();
    const numerical=await runPhysicalCase({...options,verification:{progressiveSamples:1,rayBudget:1024,forceTransportODE:true}});
    const second=currentEngine.readback();
    const compare=name=>{
     let norm=0,difference=0,maximum=0;
     for(let i=0;i<first[name].length;i++){
      if(name==='radiance'&&i%4===3)continue;
      norm+=Math.abs(first[name][i]);const delta=Math.abs(first[name][i]-second[name][i]);difference+=delta;maximum=Math.max(maximum,delta);
     }
     return {norm,difference,relative:difference/Math.max(norm,1e-30),maximum};
    };
    return {radius,analytic:{mode:analytic.screenTransport,invalid:analytic.invalidRays,unfinished:analytic.unfinishedRays,light:analytic.light,dataStatus:analytic.dataStatus},numerical:{mode:numerical.screenTransport,invalid:numerical.invalidRays,unfinished:numerical.unfinishedRays,light:numerical.light,dataStatus:numerical.dataStatus},radiance:compare('radiance'),stokes:compare('stokes')};
   },radius);
   report.screen.push(result);
   assert.equal(result.analytic.mode,'schwarzschild-plane');assert.equal(result.numerical.mode,'connection-ode');
   for(const mode of [result.analytic,result.numerical]){assert.equal(mode.invalid,0);assert.equal(mode.unfinished,0);}
   assert.ok(result.radiance.norm>0&&result.stokes.norm>0);
   // The ODE has finite transport and geodesic tolerances; this compares the
   // physical screen/Stokes result, including the emitter's gauge projection.
   assert.ok(result.radiance.relative<1e-4,JSON.stringify(result));assert.ok(result.stokes.relative<1e-4,JSON.stringify(result));
  }
  const old=await gpu.evaluate(()=>runPhysicalCase({scene:'m87',observer:'static',density:4096}));assert.equal(old.dataStatus,'ready');assert.equal(old.finite,true);assert.equal(old.invalidRays,0);assert.equal(old.unfinishedRays,0);report.legacy=old;await gpu.close();
  if(smoke){report.passed=true;console.log('PASS: native 3D smoke, actual time evolution and legacy 2D loading.');return;}

  const page=await context.newPage();attach(page);await page.addInitScript(()=>{
   window.observationTools={};Object.defineProperty(document,'modelContext',{configurable:true,value:{registerTool(tool){observationTools[tool.name]=tool;}}});
  });
  await page.goto(base+'/dist/');await page.waitForFunction(()=>window.observationTools?.get_observation);
  const observe=()=>page.evaluate(()=>observationTools.get_observation.execute({}));
  const configure=options=>page.evaluate(options=>observationTools.configure_observation.execute(options),options);
  await configure({paused:true,density:16000});await page.locator('.control-toggle').click();await page.locator('#scene-choice').selectOption('grmhd3d');
  await page.waitForFunction(()=>observationTools.get_observation.execute({}).render.dataStatus==='ready',null,{timeout:90000});
  let state=await observe();assert.equal(state.model,'schwarzschild');assert.equal(state.band,'radio');assert.equal(state.render.continuationStatus,'finite-3d');assert.equal(state.render.cacheSlots,0);
  assert.equal(await page.locator('#restore-preset').textContent(),'重置三维场景');assert.equal(await page.locator('[data-model="kerr"]').isEnabled(),false);
  await page.locator('#model-group > summary').click();assert.match(await page.locator('#solver-grid').textContent(),/96 × 64 × 32/);assert.match(await page.locator('#solver-rate').textContent(),/独立原生求解器/);
  await page.screenshot({path:path.join(output,'native-data-controls.png')});report.ui.push({case:'actual grid, finite source, metric and band locks',passed:true});
  const rejected=await page.evaluate(()=>{const before=observationTools.get_observation.execute({});try{observationTools.configure_observation.execute({model:'kerr',spin:.5});return {accepted:true};}catch(error){return {message:error.message,before,after:observationTools.get_observation.execute({})};}});
  assert.ok(rejected.message);assert.equal(rejected.before.model,rejected.after.model);assert.equal(rejected.before.spin,rejected.after.spin);
  await page.setViewportSize({width:390,height:844});await page.locator('#restore-preset').click();assert.equal((await observe()).scene,'grmhd3d');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);await page.screenshot({path:path.join(output,'mobile-data-controls.png')});
  await page.emulateMedia({reducedMotion:'no-preference'});
  // WebKit dispatches the media-query change after the emulation command.
  // Wait for the application's actual capability state before starting motion.
  await page.waitForFunction(()=>!document.getElementById('fall').disabled);
  await configure({zoom:6,density:64000});
  await page.waitForFunction(()=>{const s=observationTools.get_observation.execute({});return s.flight.r<2&&s.render.progressiveSamples===4&&!s.render.volumeGpuBusy;},null,{timeout:90000});
  assert.equal(await page.evaluate(()=>document.getElementById('cosmos').getContext('webgl2').isContextLost()),false);
  await page.screenshot({path:path.join(output,'native-dense-zoom.png')});report.ui.push({case:'eased dense-volume zoom completes without GPU work backlog or context loss',passed:true});
  await configure({zoom:1,density:16000});await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.r===40);
  await configure({falling:true,paused:false});await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.r<39.95);await configure({paused:true});
  const frozen=await observe();await page.waitForTimeout(250);assert.deepEqual((await observe()).flight,frozen.flight);report.ui.push({case:'native-field journey and pause',passed:true});
  await page.locator('#restore-preset').click();await configure({falling:false,paused:true,look:'center',zoom:3,density:64000});await page.setViewportSize({width:1280,height:800});
  await page.waitForFunction(()=>observationTools.get_observation.execute({}).render.progressiveSamples===4,null,{timeout:90000});
  await page.locator('.control-toggle').click();await page.waitForFunction(()=>getComputedStyle(document.getElementById('cosmos')).translate==='none');await page.screenshot({path:path.join(output,'native-realtime.png')});
  assert.equal(await page.locator('video').count(),0);assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.passed=true;console.log('PASS: real native 3D history, GPU exterior/interior transfer, temporal evolution, legacy field loading, finite-history controls and narrow layout.');
 }catch(error){report.failure=error.stack;process.exitCode=1;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(error);}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.tracing.stop({path:path.join(output,'trace.zip')});await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
