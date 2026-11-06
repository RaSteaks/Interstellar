// Compare the exact Schwarzschild screen with the production connection ODE
// using actual three-dimensional fluid, Stokes transfer and identical rays.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SIMULATION_BROWSER||'webkit';
assert.ok(['firefox','webkit'].includes(engine));
const base=process.argv[2]||'http://127.0.0.1:18786';
const output=path.join(__dirname,'../verification/grmhd3d/screen',engine);
fs.mkdirSync(output,{recursive:true});

(async()=>{
 const browser=await playwright[engine].launch({headless:true});
 const page=await browser.newPage();
 const report={browser:engine,version:browser.version(),cases:[],errors:[]};
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
 try{
  await page.goto(base+'/checks/physical-browser.html');await page.waitForFunction(()=>window.result);
  for(const radius of [15,3,1.5]){
   const result=await page.evaluate(async radius=>{
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
   report.cases.push(result);
   assert.equal(result.analytic.mode,'schwarzschild-plane');assert.equal(result.numerical.mode,'connection-ode');
   for(const mode of [result.analytic,result.numerical]){assert.equal(mode.invalid,0);assert.equal(mode.unfinished,0);}
   assert.ok(result.radiance.norm>0&&result.stokes.norm>0);
   // The ODE has finite transport and geodesic tolerances; this compares the
   // physical screen/Stokes result, including the emitter's gauge projection.
   assert.ok(result.radiance.relative<1e-4,JSON.stringify(result));assert.ok(result.stokes.relative<1e-4,JSON.stringify(result));
  }
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.passed=true;
  console.log('PASS: exact Schwarzschild screen agrees with connection-ODE radiance and full Stokes outside and inside the horizon.');
 }catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
