// Use the same pre-existing host browser dependency as the physical acceptance
// suite. This runner installs nothing and stores artifacts only in verification.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SIMULATION_BROWSER||'webkit';
assert.ok(['firefox','webkit'].includes(engine),'Use headless Firefox or WebKit');
const base=process.argv[2]||'http://127.0.0.1:8765';
const output=path.join(__dirname,'../verification/render-performance');

(async()=>{
  const browser=await playwright[engine].launch({headless:true});
  const errors=[];let result;
  try{
    const page=await browser.newPage({viewport:{width:800,height:650}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/checks/render-performance-browser.html');
    await page.waitForFunction(()=>window.result,{},{timeout:120000});
    result=await page.evaluate(()=>window.result);result.browserErrors=errors;
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2)+'\n');
    assert.equal(result.pass,true,JSON.stringify(result,null,2));assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'progressive-regressions.png'),fullPage:true});
    console.log('PASS: actual GPU idle/composite caching, bounded progressive sampling, independent radiance/Stokes jitter mean, observation invalidation, diagnostic provenance, GPU budget disjoint fallback/recovery and manual float filtering.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
