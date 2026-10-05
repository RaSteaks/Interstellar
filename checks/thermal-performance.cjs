// Interleaved, warmed real-GPU comparison. Rotating the execution order keeps
// browser/context warm-up and GPU clock changes from favoring one renderer.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.argv[2]||'http://127.0.0.1:8765',baseline=process.argv[3]||'http://127.0.0.1:8766';
const output=path.join(__dirname,'../verification/thermal');fs.mkdirSync(output,{recursive:true});
const percentile=(values,f)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*f))];
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
 const report={method:'12 warm-up + 31 measured samples per mode and variant at the unchanged production budget 128000 (interactive) / 256000 (refined); interleaved order rotates each round; GPU timer queries for trace/composite; synchronous 1-pixel readback and CPU clock for completed end-to-end (includes command-buffer round trip)',variants:[],errors:[]};
 const descriptions=[{name:'baseline',url:baseline},{name:'optimized22',url:base,radius:26,farStep:.22},{name:'expanded22',url:base,radius:2048,farStep:.22}];
 try{
  const pages=[];
  for(const description of descriptions){
   const page=await browser.newPage({viewport:{width:800,height:650}});
   // Every variant pins verification.rayBudget below, which disables the adaptive
   // budget controller in dist/physical-renderer.js for all of them, so no page
   // needs (or can receive) per-variant budget instrumentation.
   page.on('pageerror',e=>report.errors.push(e.message));await page.goto(description.url+'/checks/physical-browser.html');await page.waitForFunction(()=>window.result);
   const device=await page.evaluate(async d=>{
    document.getElementById('cosmos').width=1280;document.getElementById('cosmos').height=800;
    await runPhysicalCase({scene:'quasar',tilt:18,density:128000,observer:'static',verification:{outerRadius:d.radius,observerDistance:d.radius===26?80:undefined,skyRadius:d.radius===26?150:undefined,farStep:d.farStep,disableTimers:true,rayBudget:128000}});
    const gl=document.getElementById('cosmos').getContext('webgl2'),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'),debug=gl.getExtension('WEBGL_debug_renderer_info'),original=gl.drawArrays.bind(gl);let calls=[];
    const complete=()=>{if(gl.getParameter(gl.FRAMEBUFFER_BINDING)){gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,new Float32Array(4));}else gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));};
    gl.drawArrays=(...args)=>{complete();const query=ext?gl.createQuery():null;if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);const start=performance.now();original(...args);if(query)gl.endQuery(ext.TIME_ELAPSED_EXT);complete();calls.push({query,ms:performance.now()-start,source:'cpu-completed-readback'});};
    window.measureThermal=async(mode,i)=>{
     caseState.verification.rayBudget=mode==='drag'?128000:256000;caseState.paused=mode!=='drag';caseState.interacting=mode==='drag';if(mode==='drag')caseState.tilt=18+(i%2)*.5;if(mode==='spin')caseState.spin=.65+(i%2)*.01;if(mode==='exposure')caseState.exposure=1+(i%2)*.05;
     calls=[];complete();const before=currentEngine.metrics.geodesicBuilds,start=performance.now();currentEngine.draw({width:1280,height:800,scale:800*.028},0);complete();const endToEndMs=performance.now()-start,builds=currentEngine.metrics.geodesicBuilds-before;
     for(const call of calls)if(call.query){for(let j=0;j<100&&!gl.getQueryParameter(call.query,gl.QUERY_RESULT_AVAILABLE);j++)await new Promise(r=>setTimeout(r,2));if(!gl.getParameter(ext.GPU_DISJOINT_EXT)&&gl.getQueryParameter(call.query,gl.QUERY_RESULT_AVAILABLE)){call.ms=gl.getQueryParameter(call.query,gl.QUERY_RESULT)/1e6;call.source='gpu-query';}gl.deleteQuery(call.query);}
     return {traceMs:builds?calls[0].ms:0,compositeMs:calls.at(-1).ms,endToEndMs,source:calls[0].source,builds,rays:currentEngine.metrics.raySamples,quality:currentEngine.metrics.traceQuality};
    };
    return {vendor:debug&&gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),renderer:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),timerQueries:!!ext};
   },description);pages.push(page);report.variants.push({...description,device,samples:{drag:[],spin:[],static:[],exposure:[]}});
  }
  for(const mode of ['drag','spin','static','exposure']){
   for(let i=0;i<43;i++)for(let order=0;order<pages.length;order++){
    const index=(i+order)%pages.length,value=await pages[index].evaluate(({mode,i})=>measureThermal(mode,i),{mode,i});if(i>=12)report.variants[index].samples[mode].push(value);
   }console.log('MEASURED',mode);
  }
  for(const variant of report.variants){variant.summary={};for(const [mode,samples] of Object.entries(variant.samples))variant.summary[mode]={traceMedian:percentile(samples.map(s=>s.traceMs),.5),traceP95:percentile(samples.map(s=>s.traceMs),.95),compositeMedian:percentile(samples.map(s=>s.compositeMs),.5),compositeP95:percentile(samples.map(s=>s.compositeMs),.95),endToEndMedian:percentile(samples.map(s=>s.endToEndMs),.5),endToEndP95:percentile(samples.map(s=>s.endToEndMs),.95),sources:[...new Set(samples.map(s=>s.source))],actualRays:[...new Set(samples.map(s=>s.rays))],qualities:[...new Set(samples.map(s=>s.quality))],traceBuilds:samples.reduce((sum,s)=>sum+s.builds,0)};}
  for(const variant of report.variants.slice(1))for(const mode of ['drag','spin','static','exposure']){assert.deepEqual(variant.summary[mode].actualRays,report.variants[0].summary[mode].actualRays);assert.deepEqual(variant.summary[mode].qualities,report.variants[0].summary[mode].qualities);}
  report.reduction=Object.fromEntries(report.variants.slice(1).map(v=>[v.name,Object.fromEntries(['drag','spin'].map(mode=>[mode,1-v.summary[mode].traceMedian/report.variants[0].summary[mode].traceMedian]))]));
  assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report.reduction,null,2));
 }finally{fs.writeFileSync(path.join(output,'performance-interleaved.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
