// Reproducible, local-only image/domain/performance acceptance on actual WebGL.
// A synchronous one-pixel readback times completed work with a CPU clock; it
// includes the browser command-buffer round trip and is not a GPU timer query.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.argv[2]||'http://127.0.0.1:8765';
const baseline=process.argv[3]||'http://127.0.0.1:8766';
// Preserve earlier acceptance evidence when validating a new local change.
const output=process.env.THERMAL_OUTPUT?path.resolve(process.env.THERMAL_OUTPUT):path.join(__dirname,'../verification/thermal');fs.mkdirSync(output,{recursive:true});
const executable=process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const percentile=(items,f)=>[...items].sort((a,b)=>a-b)[Math.min(items.length-1,Math.floor(items.length*f))];

(async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
 const report={created:new Date().toISOString(),matrix:[],boundaries:[],convergence:[],performance:{},errors:[]};
 try{
  const page=await browser.newPage({viewport:{width:800,height:650}});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base+'/checks/physical-browser.html');await page.waitForFunction(()=>window.result);
  const device=await page.evaluate(()=>{const gl=document.getElementById('cosmos').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:ext&&gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),renderer:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),timerQuery:!!gl.getExtension('EXT_disjoint_timer_query_webgl2')};});report.device=device;
  // Fix observing event, sky endpoint, spectrum reference, exposure, and budget
  // across adjacent domains; no per-image normalization hides missing emission.
  await page.evaluate(()=>{
   const A=BlackHoleAstrophysics;window.originalAstrophysics=A;
   window.testDomain=null;window.fixedObserver=null;window.fixedReference=null;
   globalThis.BlackHoleAstrophysics={...A,
    model(state){const m=A.model(state,window.testDomain?{computationalRadius:window.testDomain}:{});return window.fixedObserver?{...m,initialObserverDistance:window.fixedObserver,skyRadius:window.fixedObserver*2}:m;},
    spectralTable(band,t,count){return A.spectralTable(band,window.fixedReference||t,count);}
   };
  });
  const run=async options=>{
   const result=await page.evaluate(o=>runPhysicalCase({...o,verification:{disableTimers:true,...o.verification}}),options);
   assert.equal(result.finite,true,JSON.stringify(result));assert.equal(result.invalidRays,0,JSON.stringify(result));assert.equal(result.unfinishedRays,0,JSON.stringify(result));return result;
  };
  const image=()=>page.evaluate(()=>{const v=currentEngine.readback();return {width:v.width,height:v.height,radiance:Array.from(v.radiance),diagnostic:Array.from(v.diagnostic)};});
  const compare=(lo,hi)=>{
   assert.equal(lo.width,hi.width);assert.equal(lo.height,hi.height);
   const y=(a,i)=>.2126*a[i]+.7152*a[i+1]+.0722*a[i+2];
   let peak=0;for(let i=0;i<hi.radiance.length;i+=4)peak=Math.max(peak,y(hi.radiance,i));const errors=[],allErrors=[],transmission=[];
   for(let i=0;i<lo.radiance.length;i+=4){const l=y(lo.radiance,i),h=y(hi.radiance,i),err=Math.abs(l-h)/Math.max(peak,1e-30);
    // The union of optical-depth masks defines the disk region. Residual
    // transmission is checked independently for rays reaching either sky image.
    allErrors.push(err);if(lo.diagnostic[i+3]>1e-8||hi.diagnostic[i+3]>1e-8)errors.push(err);
    if(hi.diagnostic[i]===1||lo.diagnostic[i]===1)transmission.push(Math.abs(lo.radiance[i+3]-hi.radiance[i+3]));
   }
   const selected=errors.length?errors:allErrors;return {mean:selected.reduce((a,b)=>a+b,0)/selected.length,p99:percentile(selected,.99),backgroundMean:transmission.length?transmission.reduce((a,b)=>a+b,0)/transmission.length:0,backgroundP99:transmission.length?percentile(transmission,.99):0,maskPixels:errors.length,transmissionPixels:transmission.length};
  };
  await page.evaluate(()=>{fixedObserver=8192;fixedReference=25000;});
  const radii=[128,256,512,1024,2048];let chosen=2048,allConverged=false;
  // Every signed-spin/elevation pair contributes to selection, including the
  // optically thick exactly edge-on view and its negative-elevation mirror.
  const configs=[-.9,0,.65,.998].flatMap(spin=>[0,18,78,-18].map(tilt=>({scene:'quasar',model:'kerr',spin,tilt,density:32000,observer:'static'})));
  for(let ri=0;ri<radii.length;ri++){
   const radius=radii[ri];await page.evaluate(r=>testDomain=r,radius);const snapshots=[];
   for(const config of configs){const result=await run({...config,verification:{skyEnabled:false}});snapshots.push(await image());report.boundaries.push({radius,...config,emissionOnly:true,...result});}
   if(ri){const comparisons=configs.map((config,i)=>({radius,previousRadius:radii[ri-1],...config,...compare(report._previous[i],snapshots[i])}));report.convergence.push(...comparisons);
    const passed=comparisons.every(c=>c.mean<.01&&c.p99<.03&&c.backgroundMean<.01&&c.backgroundP99<.03);
    console.log('DOMAIN',radii[ri-1],radius,'mean',Math.max(...comparisons.map(c=>c.mean)),'p99',Math.max(...comparisons.map(c=>c.p99)),'pass',passed);
    if(passed){chosen=radius;allConverged=true;break;}
   }report._previous=snapshots;
  }delete report._previous;report.selectedRadius=chosen;report.domainConverged=allConverged;
  await page.evaluate(r=>{testDomain=r;fixedObserver=null;fixedReference=25000;},chosen);
  for(const config of configs){const result=await run(config);report.matrix.push({...config,...result});
   await page.locator('#cosmos').screenshot({path:path.join(output,`spin-${config.spin}-tilt-${config.tilt}.png`)});
  }
  await page.evaluate(()=>fixedReference=null);
  report.stepperOracle=[];
  for(const options of [{scene:'quasar',tilt:18,density:16000},{scene:'extreme',tilt:18,density:16000},{scene:'quasar',tilt:0,density:16000},{scene:'isolated',observer:'infall',viewZoom:12,density:4096}]){
   const fsal=await run(options),first=await image(),unseeded=await run({...options,verification:{forceUnseededBS:true}}),second=await image(),error=compare(first,second);
   report.stepperOracle.push({options,fsal,unseeded,error});assert.ok(error.mean<1e-5&&error.p99<1e-4,'FSAL differs from independent unseeded steps');
  }
  // A full unpolarized matrix transfer is an independent production-path oracle
  // for the scalar kernel. This test switch is not accepted by product config.
  const scalar=await run({scene:'quasar',tilt:18,density:16000});const scalarImage=await image();
  const full=await run({scene:'quasar',tilt:18,density:16000,verification:{forceFullThermal:true}});const fullImage=await image();
  report.scalar={metrics:scalar,fullMetrics:full,error:compare(scalarImage,fullImage)};
  assert.ok(report.scalar.error.mean<1e-5&&report.scalar.error.p99<1e-4,'scalar / full transfer differs');
  report.convergenceChecks=[];
  for(const tilt of [0,18]){
   await run({scene:'quasar',tilt,density:16000});const reference=await image();
   for(const options of [{verification:{mediumStep:.225}},{verification:{tolerance:1e-5}},{verification:{initialStep:.8}},{density:32000}]){
    const result=await run({scene:'quasar',tilt,density:16000,...options});let sampled=await image();
    if(options.density){
     // Integrate the finer pixel areas into the coarser cells, accounting for
     // noninteger dimension ratios instead of matching different pixel centers.
     const fine=sampled,resampled={...reference,radiance:[]};
     for(let y=0;y<reference.height;y++)for(let x=0;x<reference.width;x++){
      const x0=x*fine.width/reference.width,x1=(x+1)*fine.width/reference.width,y0=y*fine.height/reference.height,y1=(y+1)*fine.height/reference.height,rgba=[0,0,0,0],area=(x1-x0)*(y1-y0);
      for(let fy=Math.floor(y0);fy<Math.ceil(y1);fy++)for(let fx=Math.floor(x0);fx<Math.ceil(x1);fx++){
       const weight=(Math.min(x1,fx+1)-Math.max(x0,fx))*(Math.min(y1,fy+1)-Math.max(y0,fy))/area;
       for(let k=0;k<4;k++)rgba[k]+=fine.radiance[(fy*fine.width+fx)*4+k]*weight;
      }resampled.radiance.push(...rgba);
     }sampled=resampled;
    }
    report.convergenceChecks.push({tilt,options,result,error:compare(reference,sampled)});
   }
  }
  // Completed trace and composite separately, including common JS submission
  // costs in end-to-end. Equal sample counts and tolerances are recorded below.
  const benchmark=async(url,domain)=>{
   const bench=await browser.newPage({viewport:{width:800,height:650}});await bench.goto(url+'/checks/physical-browser.html');await bench.waitForFunction(()=>window.result);
   const values=await bench.evaluate(async domain=>{
    // Renderer verification permits the legacy 26rg domain as a performance oracle.
    await runPhysicalCase({scene:'quasar',tilt:18,density:16000,observer:'static',verification:{outerRadius:domain||undefined,observerDistance:domain===26?80:undefined,skyRadius:domain===26?150:undefined,disableTimers:true}});
    const gl=document.getElementById('cosmos').getContext('webgl2'),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'),original=gl.drawArrays.bind(gl),size={width:640,height:400,scale:400*.028},samples={};let calls=[];
    const complete=()=>{const fbo=gl.getParameter(gl.FRAMEBUFFER_BINDING);if(fbo){gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,new Float32Array(4));}else gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));};
    gl.drawArrays=(...args)=>{complete();const query=ext?gl.createQuery():null;if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);const start=performance.now();original(...args);if(query)gl.endQuery(ext.TIME_ELAPSED_EXT);complete();calls.push({query,ms:performance.now()-start,source:'cpu-completed-readback'});};
    for(const mode of ['drag','spin','static','exposure']){
     samples[mode]=[];
     for(let i=0;i<19;i++){
      caseState.paused=mode!=='drag';caseState.interacting=mode==='drag';
      if(mode==='drag')caseState.tilt=18+(i%2)*.5;if(mode==='spin')caseState.spin=.65+(i%2)*.01;if(mode==='exposure')caseState.exposure=1+(i%2)*.05;
      calls=[];complete();const start=performance.now(),builds=currentEngine.metrics.geodesicBuilds;currentEngine.draw(size,0);complete();
      const endToEndMs=performance.now()-start;
      for(const call of calls)if(call.query){for(let poll=0;poll<100&&!gl.getQueryParameter(call.query,gl.QUERY_RESULT_AVAILABLE);poll++)await new Promise(r=>setTimeout(r,2));if(!gl.getParameter(ext.GPU_DISJOINT_EXT)&&gl.getQueryParameter(call.query,gl.QUERY_RESULT_AVAILABLE)){call.ms=gl.getQueryParameter(call.query,gl.QUERY_RESULT)/1e6;call.source='gpu-query';}gl.deleteQuery(call.query);}
      // Unchanged images now skip every draw; zero is the measured GPU work,
      // while end-to-end still includes the explicit verification round trip.
      if(i>=4)samples[mode].push({endToEndMs,traceMs:currentEngine.metrics.geodesicBuilds>builds?calls[0].ms:0,compositeMs:calls.at(-1)?.ms??0,timingSource:calls[0]?.source??'no-gpu-submission',raySamples:currentEngine.metrics.raySamples,quality:currentEngine.metrics.traceQuality,builds:currentEngine.metrics.geodesicBuilds-builds});
      await new Promise(r=>setTimeout(r,10));
     }
    }gl.drawArrays=original;return {samples,metrics:{...currentEngine.metrics},source:'Trace/composite: GPU TIME_ELAPSED queries, CPU completed-readback fallback. End-to-end: CPU performance.now + synchronous 1-pixel GPU readback (includes command-buffer roundtrip)'};
   },domain);await bench.close();return values;
  };
  if(!process.env.THERMAL_SKIP_PERFORMANCE){
  report.performance.baseline=await benchmark(baseline,null);report.performance.optimized=await benchmark(base,26);report.performance.expanded=await benchmark(base,chosen);
  for(const [name,value] of Object.entries(report.performance))for(const [mode,samples] of Object.entries(value.samples))value[mode]={traceMedian:percentile(samples.map(s=>s.traceMs),.5),traceP95:percentile(samples.map(s=>s.traceMs),.95),compositeMedian:percentile(samples.map(s=>s.compositeMs),.5),endToEndMedian:percentile(samples.map(s=>s.endToEndMs),.5),endToEndP95:percentile(samples.map(s=>s.endToEndMs),.95),raySamples:[...new Set(samples.map(s=>s.raySamples))],qualities:[...new Set(samples.map(s=>s.quality))],timingSources:[...new Set(samples.map(s=>s.timingSource))],traceBuilds:samples.reduce((n,s)=>n+s.builds,0)};
  for(const name of ['optimized','expanded'])for(const mode of ['drag','spin','static','exposure']){assert.deepEqual(report.performance[name][mode].raySamples,report.performance.baseline[mode].raySamples,'unequal actual ray budget');assert.deepEqual(report.performance[name][mode].qualities,report.performance.baseline[mode].qualities,'unequal integral quality');}
  report.performance.reduction={};for(const mode of ['drag','spin'])report.performance.reduction[mode]={sameBoundary:1-report.performance.optimized[mode].traceMedian/report.performance.baseline[mode].traceMedian,netExpanded:1-report.performance.expanded[mode].traceMedian/report.performance.baseline[mode].traceMedian};
  }else report.performance={source:'Final fixed-budget interleaved comparison is recorded in performance-interleaved.json'};
  assert.deepEqual(report.errors,[]);await page.close();
 }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
 console.log(JSON.stringify({selectedRadius:report.selectedRadius,domainConverged:report.domainConverged,performance:report.performance.reduction,device:report.device},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
