// Run against a root HTTP server; Playwright is a verification dependency only.
// PLAYWRIGHT_MODULE may point at the host's bundled package without installing
// anything into the static website. All output stays outside dist.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.argv[2]||'http://127.0.0.1:8765';
const output=path.join(__dirname,'../verification/physical');fs.mkdirSync(output,{recursive:true});
const executable=process.env.CHROME_EXECUTABLE||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);

(async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:process.platform==='darwin'?['--use-angle=metal','--ignore-gpu-blocklist']:['--enable-unsafe-swiftshader']});
 const report={gpu:[],ui:[],coefficientProbe:null,errors:[]};
 try {
  const gpu=await browser.newPage({viewport:{width:800,height:650}});
  gpu.on('pageerror',e=>report.errors.push(e.message));
  await gpu.goto(base+'/checks/physical-browser.html');await gpu.waitForFunction(()=>window.result);
  for(const options of [
   {scene:'quasar'},{scene:'stellar'},{scene:'m87',display:'linear'},{scene:'sgrA',display:'circular'},{scene:'jet'},
   {scene:'retrograde'},{scene:'extreme'},{scene:'charged'},{scene:'charged',model:'reissner',spin:0,charge:.8},{scene:'quasar',model:'schwarzschild',spin:0},{scene:'isolated'},
   {scene:'quasar',observer:'infall',viewZoom:12},{scene:'isolated',observer:'infall',viewZoom:12},{scene:'hotspot',time:8}
  ]) {
   const result=await gpu.evaluate(o=>runPhysicalCase(o),options);
   assert.equal(result.finite,true);assert.equal(result.unfinishedRays,0);assert.equal(result.invalidRays,0);
   assert.ok(result.light>0);assert.ok(result.polarizationError<1e-5);assert.equal(result.horizonFade,0);
   if(['m87','sgrA','jet'].includes(options.scene)){assert.equal(result.dataStatus,'ready');assert.ok(result.polarizationMaximum>.01);}
   if(options.viewZoom===12)assert.ok(result.observerDistance<(await gpu.evaluate(()=>BlackHoleAstrophysics.model(caseState))).horizon);
   report.gpu.push(result);console.log('GPU PASS',options.scene,options.viewZoom||1,result.raySamples);
  }
  const temporal=await gpu.evaluate(async()=>{
   await runPhysicalCase({scene:'m87',density:4096});const engine=currentEngine,first=engine.readback(),build=engine.metrics.geodesicBuilds;
   caseState.time=4;engine.draw({width:640,height:400,scale:400*.028},0);const later=engine.readback();let difference=0;
   for(let i=0;i<first.radiance.length;i++)difference+=Math.abs(first.radiance[i]-later.radiance[i]);
   const before=engine.metrics.geodesicBuilds;caseState.exposure=2;engine.draw({width:640,height:400,scale:400*.028},0);const same=engine.readback();let changed=0;
   for(let i=0;i<same.radiance.length;i++)if(same.radiance[i]!==later.radiance[i])changed++;
   return {difference,changed,build,before,after:engine.metrics.geodesicBuilds};
  });
  assert.ok(temporal.difference>1);assert.equal(temporal.changed,0);assert.equal(temporal.before,temporal.after);report.temporal=temporal;
  const coefficients=await gpu.evaluate(()=>probeCoefficients());
  for(let i=0;i<4;i++)if(coefficients.cpu.j[i]!==0)assert.ok(Math.abs(coefficients.gpu[0][i]/coefficients.cpu.j[i]-1)<.001);
  for(const [actual,expected] of [[coefficients.gpu[1][0],coefficients.cpu.planck],[coefficients.gpu[1][1],coefficients.cpu.rho[0]],[coefficients.gpu[1][2],coefficients.cpu.rho[2]],[coefficients.gpu[1][3],coefficients.cpu.hotPlanck]])assert.ok(Math.abs(actual/expected-1)<.001);
  report.coefficientProbe=coefficients;
  report.transferProbe=await gpu.evaluate(()=>probeTransfer());
  for(const test of report.transferProbe)for(let i=0;i<2;i++)for(let j=0;j<4;j++){assert.ok(Number.isFinite(test.actual[i][j]),JSON.stringify(test));assert.ok(Math.abs(test.actual[i][j]-test.expected[i][j])<1e-4,JSON.stringify(test));}
  await gpu.close();

  const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'reduce'});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(['warning','error'].includes(m.type()))report.errors.push(m.type()+': '+m.text());});
  await page.addInitScript(()=>{
   // Only the optional agent registry is substituted. The real app, DOM,
   // interaction handlers, shared validator and GPU renderer all execute.
   window.observationTools={};Object.defineProperty(document,'modelContext',{configurable:true,value:{registerTool(tool){observationTools[tool.name]=tool;}}});
  });
  await page.goto(base+'/dist/');await page.waitForFunction(()=>observationTools.get_observation);
  const observe=()=>page.evaluate(()=>observationTools.get_observation.execute({}));
  const configure=options=>page.evaluate(o=>observationTools.configure_observation.execute(o),options);
  // The live state is shared with WebMCP, but each UI group is a native
  // disclosure. Open only the group needed by a browser interaction so the
  // check covers the same keyboard/focus path as a person using the panel.
  const openGroup=async id=>{const group=page.locator(`#${id}`);if(!(await group.getAttribute('open')))await group.locator('summary').click();};
  let obs=await observe();assert.equal(obs.render.mode,'webgl2-volume-grrt');assert.equal(obs.controlsExpanded,false);assert.equal(obs.paused,true);
  assert.equal(obs.tilt,0);assert.equal(obs.presetCustomized,false);assert.ok(obs.computationalRadius>=128);assert.equal(obs.initialObserverDistance,obs.computationalRadius*4);
  assert.equal(await page.locator('#controls button').first().isVisible(),false);
  await page.locator('.control-toggle').click();assert.equal(await page.locator('#scene-choice').isVisible(),true);
  assert.equal(await page.locator('#physics-group').getAttribute('open'),'');assert.equal(await page.locator('#imaging-group').getAttribute('open'),null);assert.equal(await page.locator('#camera-group').getAttribute('open'),null);assert.equal(await page.locator('#model-group').getAttribute('open'),null);
  // Toggling an inner disclosure must never close the outer panel or change
  // the observation expansion state exposed through WebMCP.
  await page.locator('#imaging-group > summary').click();assert.equal((await observe()).controlsExpanded,true);await page.locator('#imaging-group > summary').click();
  assert.equal(await page.locator('#scene-choice option').count(),10);
  // Actual effective parameters own customization. Display-only/camera changes
  // cannot make the preset appear modified; returning physics clears it.
  await configure({exposure:1.2,zoom:1.1,display:'accuracy',density:16000});assert.equal((await observe()).presetCustomized,false);
  await configure({spin:.7});assert.equal((await observe()).presetCustomized,true);assert.equal(await page.locator('#preset-customized').isVisible(),true);
  await configure({spin:.65});assert.equal((await observe()).presetCustomized,false);assert.equal(await page.locator('#restore-preset').isVisible(),false);
  await configure({band:'bolometric'});assert.equal((await observe()).presetCustomized,true);await configure({band:'visible'});assert.equal((await observe()).presetCustomized,false);
  await configure({scene:'charged',model:'schwarzschild',zoom:3,tilt:-18});await page.screenshot({path:path.join(output,'custom-preset-desktop.png')});obs=await observe();assert.equal(obs.scene,'charged');assert.equal(obs.presetCustomized,true);assert.equal(obs.spin,0);assert.equal(obs.charge,0);
  await page.locator('#restore-preset').click();obs=await observe();assert.equal(obs.scene,'charged');assert.equal(obs.model,'kerr-newman');assert.equal(obs.spin,.55);assert.equal(obs.charge,.6);assert.equal(obs.tilt,18);assert.equal(obs.zoom,1);assert.equal(obs.paused,true);assert.equal(obs.falling,false);assert.equal(obs.presetCustomized,false);
  await configure({scene:'quasar',display:'intensity',exposure:1});assert.equal((await observe()).tilt,0);
  await openGroup('imaging-group');
  // Wait for the configured frame itself before comparing cache counters; the
  // preceding preset may also have advertised refined quality.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>{const r=observationTools.get_observation.execute({}).render;return r.traceQuality==='refined'&&r.diagnosticCurrent&&!r.diagnosticPending;});
  const exposureBefore=(await observe()).render;
  await page.locator('#exposure').focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(100);
  const exposureBox=await page.locator('#exposure').boundingBox();await page.mouse.move(exposureBox.x+exposureBox.width*.3,exposureBox.y+exposureBox.height/2);await page.mouse.down();await page.mouse.move(exposureBox.x+exposureBox.width*.45,exposureBox.y+exposureBox.height/2,{steps:3});await page.mouse.up();await page.waitForTimeout(100);
  const exposureAfter=(await observe()).render;for(const key of ['geodesicBuilds','modelBuilds','profileBuilds','observerBuilds','spectrumBuilds'])assert.equal(exposureAfter[key],exposureBefore[key],key+' changed on exposure');
  report.exposure={before:exposureBefore.geodesicBuilds,after:exposureAfter.geodesicBuilds,source:exposureAfter.timingSource};
  await configure({spin:.7,paused:false});await page.locator('#restore-preset').click();assert.equal((await observe()).paused,false);await configure({paused:true});
  await page.locator('#reset').click();obs=await observe();assert.equal(obs.tilt,0);assert.equal(obs.presetCustomized,false);assert.equal(obs.paused,true);
  await page.locator('.control-toggle').click();await page.screenshot({path:path.join(output,'thermal-default-0.png')});await page.locator('.control-toggle').click();
  report.ui.push({name:'ten native presets; modify, revert, restore; effective parameters; preserved playback; startup/reset at 0°',computationalRadius:obs.computationalRadius,initialObserverDistance:obs.initialObserverDistance});
  await page.locator('#scene-choice').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.locator('#scene-choice').selectOption('stellar');await page.waitForTimeout(300);obs=await observe();assert.equal(obs.mass,10);assert.equal(obs.band,'xray');
  await page.keyboard.press('Escape');assert.equal((await observe()).controlsExpanded,false);assert.equal(await page.locator('.control-toggle').evaluate(e=>document.activeElement===e),true);
  await page.screenshot({path:path.join(output,'stellar-desktop.png')});report.ui.push({name:'desktop, keyboard, native scene select, mass/band and Esc',samples:obs.samples});
  const unchanged=await observe();const invalid=await page.evaluate(()=>{try{observationTools.configure_observation.execute({model:'kerr-newman',spin:.99,charge:.9});return false;}catch{return true;}});
  assert.equal(invalid,true);obs=await observe();assert.equal(obs.model,unchanged.model);assert.equal(obs.spin,unchanged.spin);assert.equal(obs.charge,unchanged.charge);
  await configure({scene:'m87',display:'linear',density:32000});await page.waitForFunction(()=>observationTools.get_observation.execute({}).render.dataStatus==='ready');
  await page.waitForFunction(()=>{const r=observationTools.get_observation.execute({}).render;return r.diagnosticCurrent&&!r.diagnosticPending;});obs=await observe();assert.equal(obs.spin,.9375);assert.equal(obs.render.unfinishedRays,0);assert.equal(obs.render.invalidRays,0,JSON.stringify(obs));
  await page.screenshot({path:path.join(output,'m87-polarization.png')});
  await page.locator('.control-toggle').click();assert.equal(await page.locator('#spin').isDisabled(),true);assert.equal(await page.locator('#band option[value="visible"]').isDisabled(),true);
  for(const model of ['schwarzschild','reissner','kerr-newman'])assert.equal(await page.locator(`[data-model="${model}"]`).isDisabled(),true);
  assert.match(await page.locator('#physics-help').textContent(),/模拟数据固定为克尔时空，a=0.9375、Q=0/);
  // Include unrelated valid fields in each rejected patch to prove there are
  // no partial writes to camera, pause intent, exposure, or scene provenance.
  for(const patch of [{model:'schwarzschild',exposure:2,paused:false,zoom:2},{spin:.65,tilt:-18},{charge:.2,exposure:2},{band:'visible',density:16000}]){
   const before=await observe();const rejected=await page.evaluate(o=>{try{observationTools.configure_observation.execute(o);return false;}catch{return true;}},patch);assert.equal(rejected,true);
   const after=await observe();for(const key of ['scene','model','spin','charge','band','exposure','paused','zoom','tilt','density','falling','presetCustomized'])assert.equal(after[key],before[key],key);
  }
  await page.keyboard.press('Escape');report.ui.push({name:'recorded metric, band guard, genuine Stokes display',samples:obs.samples});
  for(const scene of ['sgrA','jet']){await configure({scene});await page.locator('.control-toggle').click();assert.equal(await page.locator('[data-model="schwarzschild"]').isDisabled(),true);assert.equal((await observe()).presetCustomized,false);await page.keyboard.press('Escape');}
  await configure({scene:'charged',density:32000});await page.waitForTimeout(250);obs=await observe();assert.equal(obs.model,'kerr-newman');assert.ok(obs.charge>0);assert.ok(obs.isco>1+Math.sqrt(1-obs.spin**2-obs.charge**2));
  await configure({scene:'isolated',observer:'infall',zoom:12,density:16000});await page.waitForFunction(()=>observationTools.get_observation.execute({}).flight.stage==='inside');
  await page.waitForTimeout(300);obs=await observe();assert.equal(obs.flight.fade,0);assert.equal(obs.render.unfinishedRays,0);assert.equal(obs.render.invalidRays,0,JSON.stringify(obs));
  await page.screenshot({path:path.join(output,'infall-interior.png')});report.ui.push({name:'interior timelike observer without cinematic fade',radius:obs.flight.r});
  await page.locator('#cosmos').focus();await page.keyboard.press('Escape');await page.waitForTimeout(250);assert.equal((await observe()).zoom,1);
  await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>!document.getElementById('fall').disabled);
  await configure({scene:'stellar',paused:false,zoom:3,density:16000,falling:true});
  const start=(await observe()).flight.r;await page.waitForTimeout(800);const advanced=(await observe()).flight.r;assert.ok(advanced<start);
  assert.equal((await observe()).falling,true);
  await configure({paused:true});const stopped=(await observe()).flight.r;await page.waitForTimeout(250);assert.equal((await observe()).flight.r,stopped);
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.getElementById('fall').disabled);await configure({paused:false});const reduced=(await observe()).flight.r;await page.waitForTimeout(250);assert.equal((await observe()).flight.r,reduced);assert.equal((await observe()).falling,false);assert.equal(await page.locator('#fall').isDisabled(),true);
  report.ui.push({name:'proper-time journey, pause, runtime reduced-motion camera freeze',start,advanced});
  await page.emulateMedia({reducedMotion:'reduce'});await configure({scene:'m87',paused:true,density:32000});await page.waitForFunction(()=>{const r=observationTools.get_observation.execute({}).render;return r.diagnosticCurrent&&!r.diagnosticPending&&r.registeredTextures===11;});const textureCount=(await observe()).render.registeredTextures;await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  await page.locator('.control-toggle').click();const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,controls:document.getElementById('controls').getBoundingClientRect().toJSON(),toggle:document.querySelector('.control-toggle').getBoundingClientRect().toJSON()}));
  assert.equal((await observe()).render.registeredTextures,textureCount);assert.equal(layout.width,layout.viewport);assert.ok(layout.controls.left>=0&&layout.controls.right<=391);assert.ok(layout.toggle.bottom<=844);
  await page.screenshot({path:path.join(output,'mobile-controls.png')});await page.keyboard.press('Escape');assert.equal((await observe()).controlsExpanded,false);
  await page.setViewportSize({width:320,height:568});await page.waitForTimeout(250);await page.locator('.control-toggle').click();const narrow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,controls:document.getElementById('controls').getBoundingClientRect().toJSON()}));assert.equal(narrow.width,narrow.viewport);assert.ok(narrow.controls.left>=0&&narrow.controls.right<=321);await page.screenshot({path:path.join(output,'mobile-controls-320.png')});await page.keyboard.press('Escape');
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(250);await page.locator('.control-toggle').click();const landscape=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,controls:document.getElementById('controls').getBoundingClientRect().toJSON()}));assert.equal(landscape.width,landscape.viewport);assert.ok(landscape.controls.top>=0&&landscape.controls.bottom<=391);await page.screenshot({path:path.join(output,'short-landscape.png')});await page.keyboard.press('Escape');assert.equal((await observe()).controlsExpanded,false);report.ui.push({name:'390×844, 320×568 and short-landscape grouped panel without overflow',layout,narrow,landscape});
  await page.close();

  const fallback=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl2'?null:original.call(this,kind,...args);};});
  await fallback.goto(base+'/dist/');await fallback.waitForTimeout(350);assert.equal(await fallback.locator('#scene-choice').isDisabled(),true);assert.equal(await fallback.locator('#fall').isDisabled(),true);assert.match(await fallback.locator('#render-state').textContent(),/兼容/);
  await fallback.locator('.control-toggle').click();assert.equal(await fallback.locator('#tilt-value').textContent(),'0°');await fallback.locator('#reset').click();assert.equal(await fallback.locator('#tilt-value').textContent(),'0°');await fallback.keyboard.press('Escape');assert.equal(await fallback.locator('.control-shell').getAttribute('open'),null);
  await fallback.screenshot({path:path.join(output,'canvas-fallback.png')});report.ui.push({name:'forced Canvas fallback, honest limits and reset'});await fallback.close();
  assert.deepEqual(report.errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('PASS: 14 actual GPU cases, float32 coefficient oracles, causal movie changes, exposure invariance, production controls, atomic validation, interior observer, proper-time journey, reduced motion, phone layout and Canvas fallback.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
