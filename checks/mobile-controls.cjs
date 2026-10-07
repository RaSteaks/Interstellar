// Run the real product page with the host's existing Playwright/Chrome runtime.
// Phone emulation checks layout and interaction; it does not emulate Safari's
// browser toolbar or replace the application's state, shaders, or event handlers.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.argv[2]||'http://127.0.0.1:8765';
const output=path.join(__dirname,'../verification/mobile-controls');
const executable=process.env.CHROME_EXECUTABLE||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const viewports=[{width:320,height:568},{width:320,height:480},{width:390,height:844},{width:390,height:520},{width:430,height:932},{width:430,height:568}];
const groups=['physics-group','imaging-group','camera-group','model-group'];
const stateKeys=['scene','model','spin','charge','band','display','exposure','tilt','density','zoom','observer','paused','falling','presetCustomized'];
const pickState=observation=>Object.fromEntries(stateKeys.map(key=>[key,observation[key]]));
const overlap=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
const closeTo=(a,b,message)=>assert.ok(Math.abs(a-b)<=1,message+': '+a+' vs '+b);

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:executable,headless:true,args:process.platform==='darwin'?['--use-angle=metal','--ignore-gpu-blocklist']:['--enable-unsafe-swiftshader']});
  const report={method:'Actual product DOM, native disclosures and production WebGL under Chromium touch/mobile emulation; 320/390/430px portrait and short viewports; immediate actual framebuffer readback detects blank composites; no Safari toolbar emulation',mobileSafariVerified:false,safariRuntime:'An actual iPhone Safari runtime is unavailable to this runner; Chromium emulation does not verify Safari toolbar/safe-area behavior.',cases:[],errors:[]};
  let activePage;
  const initialize=async(context,unsupportedFullscreen=false)=>{
    const page=await context.newPage();activePage=page;
    page.on('pageerror',error=>report.errors.push(error.message));
    await page.addInitScript(({unsupportedFullscreen})=>{
      // Substitute only the optional tool registry, exposing the same shared
      // public observation/configuration interface used by the production UI.
      window.observationTools={};Object.defineProperty(document,'modelContext',{configurable:true,value:{registerTool(tool){observationTools[tool.name]=tool;}}});
      window.canvasProbe={writes:{width:0,height:0},composites:0,visibleLight:0,width:0,height:0};
      for(const key of ['width','height']){
        const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
        Object.defineProperty(HTMLCanvasElement.prototype,key,{...descriptor,set(value){if(this.id==='cosmos')window.canvasProbe.writes[key]++;return descriptor.set.call(this,value);}});
      }
      // preserveDrawingBuffer=false allows presentation to clear late readback.
      // Read immediately after the real default-framebuffer composite instead.
      const draw=WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.drawArrays=function(...args){
        draw.apply(this,args);
        if(this.canvas.id!=='cosmos'||this.getParameter(this.FRAMEBUFFER_BINDING)!==null)return;
        const pixels=new Uint8Array(this.drawingBufferWidth*this.drawingBufferHeight*4);this.readPixels(0,0,this.drawingBufferWidth,this.drawingBufferHeight,this.RGBA,this.UNSIGNED_BYTE,pixels);
        let light=0;for(let i=0;i<pixels.length;i+=4)light+=pixels[i]+pixels[i+1]+pixels[i+2];
        Object.assign(window.canvasProbe,{composites:window.canvasProbe.composites+1,visibleLight:light,width:this.drawingBufferWidth,height:this.drawingBufferHeight});
      };
      if(unsupportedFullscreen){
        Object.defineProperty(Element.prototype,'requestFullscreen',{configurable:true,writable:true,value:undefined});
        Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false});
      }
    },{unsupportedFullscreen});
    await page.goto(base+'/dist/');await page.waitForFunction(()=>window.observationTools?.get_observation);
    return page;
  };
  const observe=page=>page.evaluate(()=>observationTools.get_observation.execute({}));
  const configure=(page,options)=>page.evaluate(o=>observationTools.configure_observation.execute(o),options);
  const settle=page=>page.waitForFunction(()=>{
    const r=observationTools.get_observation.execute({}).render;
    return r.progressiveSamples===r.progressiveTarget&&r.diagnosticCurrent&&!r.diagnosticPending&&window.canvasProbe.visibleLight>0;
  },{},{timeout:30000});
  const rect=locator=>locator.evaluate(element=>element.getBoundingClientRect().toJSON());
  const assertBounds=(r,w,h,label)=>{
    assert.ok(r.width>0&&r.height>0,label+' has no visible box');
    assert.ok(r.left>=-.5&&r.right<=w+.5,label+' exceeds horizontal viewport '+JSON.stringify(r));
    assert.ok(r.top>=-.5&&r.bottom<=h+.5,label+' exceeds vertical viewport '+JSON.stringify(r));
  };
  const shortScrollProbe=page=>page.evaluate(()=>{
    const panel=document.getElementById('controls'),header=document.querySelector('.panel-top'),toggle=document.querySelector('.control-toggle'),box=element=>element.getBoundingClientRect().toJSON();
    return [.25,.5,.75].map(fraction=>{
      panel.scrollTop=(panel.scrollHeight-panel.clientHeight)*fraction;
      const h=header.getBoundingClientRect(),style=getComputedStyle(header),hit=document.elementFromPoint(h.left+3,h.top+3);
      return {fraction,scrollTop:panel.scrollTop,header:box(header),close:box(toggle),position:style.position,background:style.backgroundColor,opacity:style.opacity,zIndex:style.zIndex,headerOwnsTopLayer:hit===header||header.contains(hit),labels:Array.from(header.querySelectorAll('.eyebrow,#controls-title,.preset-heading > label,#preset-customized,#scene-choice')).filter(element=>element.getBoundingClientRect().height>0).map(element=>({name:element.id||element.className,box:box(element)}))};
    });
  });
  const assertShortHeader=probes=>{
    for(const probe of probes){
      assert.equal(probe.position,'sticky','Short-screen header is not retained during outer scrolling');
      assert.ok(Number(probe.zIndex)>0&&Number(probe.opacity)===1&&probe.headerOwnsTopLayer,'Short-screen header does not own the opaque top layer');
      const alpha=probe.background.startsWith('rgba(')?Number(probe.background.slice(probe.background.lastIndexOf(',')+1,-1)):probe.background==='transparent'?0:1;
      assert.equal(alpha,1,'Short-screen header background is translucent');
      assert.ok(probe.close.top>=probe.header.top-.5&&probe.close.bottom<=probe.header.bottom+.5,'Close button floated over scrolled body content');
      for(const label of probe.labels)assert.equal(overlap(probe.close,label.box),false,'Close overlaps sticky header content '+label.name);
    }
  };
  const reachableControl=async(page,id,viewport)=>{
    // Native scrollIntoView honors the dynamically measured sticky-header
    // scroll padding; a viewport box alone would miss a covered control.
    await page.locator('#'+id).evaluate(element=>element.scrollIntoView({block:'nearest',inline:'nearest'}));
    const result=await page.locator('#'+id).evaluate(element=>{
      const r=element.getBoundingClientRect(),header=document.querySelector('.panel-top').getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {box:r.toJSON(),header:header.toJSON(),hit:hit===element||element.contains(hit)};
    });
    assertBounds(result.box,viewport.width,viewport.height,'Short-screen '+id);
    assert.ok(result.box.top>=result.header.bottom-.5,'Sticky header covers '+id);assert.equal(result.hit,true,'Visible control cannot receive a pointer: '+id);
    return result;
  };
  try{
    for(const viewport of viewports)for(const scene of ['quasar','m87']){
      const context=await browser.newContext({viewport,deviceScaleFactor:1,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
      try{
        const page=await initialize(context);await configure(page,{scene,paused:true,density:16000,observer:'static',exposure:1.35,zoom:1.15});await settle(page);
        await page.locator('.control-toggle').click();
        for(const id of groups)if(await page.locator('#'+id).getAttribute('open')===null)await page.locator('#'+id+' > summary').click();
        // Start geometry inspection at the header, then exercise actual scroll
        // containers separately from the fixed playback/action row.
        await page.locator('#controls').evaluate(element=>{element.scrollTop=0;});
        await page.locator('.control-scroll').evaluate(element=>{element.scrollTop=0;});
        const layout=await page.evaluate(()=>{
          const panel=document.getElementById('controls'),scroll=panel.querySelector('.control-scroll'),box=element=>element.getBoundingClientRect().toJSON();
          const visible=element=>element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0;
          return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,panel:box(panel),close:box(document.querySelector('.control-toggle')),header:box(panel.querySelector('.panel-top')),footer:box(panel.querySelector('.panel-actions')),scroll:{box:box(scroll),width:scroll.scrollWidth,clientWidth:scroll.clientWidth,height:scroll.scrollHeight,clientHeight:scroll.clientHeight},
            labels:Array.from(panel.querySelectorAll('.eyebrow,.panel-code,#controls-title,.panel-subtitle,.preset-heading > label,#preset-customized,#scene-choice')).filter(visible).map(element=>({name:element.id||element.className,box:box(element)})),
            targets:Array.from(document.querySelectorAll('#control-shell summary,#controls button,#controls input[type="range"],#controls select,#controls a')).filter(visible).map(element=>({name:element.id||element.textContent.trim(),box:box(element)})),
            selects:Array.from(panel.querySelectorAll('select')).map(element=>({id:element.id,font:parseFloat(getComputedStyle(element).fontSize)})),solverInModel:document.getElementById('model-group').contains(document.getElementById('solver-readout'))};
        });
        assert.equal(layout.width,viewport.width);assert.equal(layout.documentWidth,viewport.width,'Document has horizontal overflow');
        assertBounds(layout.panel,layout.width,layout.height,'Mobile sheet');assertBounds(layout.close,layout.width,layout.height,'Close control');
        assert.ok(layout.close.left>=layout.panel.left&&layout.close.right<=layout.panel.right&&layout.close.top>=layout.panel.top&&layout.close.bottom<=layout.header.bottom,'Close control is not inside the sheet header');
        for(const label of layout.labels)assert.equal(overlap(layout.close,label.box),false,'Close overlaps header content '+label.name);
        assert.equal(overlap(layout.close,layout.footer),false,'Close control overlaps footer');
        assert.ok(layout.scroll.width<=layout.scroll.clientWidth+1,'Parameter group content has horizontal overflow');
        for(const target of layout.targets){
          assert.ok(target.box.width>=43.5&&target.box.height>=43.5,'Touch target below 44px: '+JSON.stringify(target));
          assert.ok(target.box.left>=layout.panel.left-.5&&target.box.right<=layout.panel.right+.5,'Control exceeds sheet width: '+target.name);
        }
        for(const select of layout.selects)assert.ok(select.font>=16,'Native mobile select text below 16px: '+select.id);
        assert.equal(layout.solverInModel,true,'Solver details remain outside the model disclosure');
        assert.equal(await page.locator('#solver-readout').isVisible(),scene==='m87');
        let scrolling,customHeader=null;
        if(viewport.height>520){
          assert.ok(layout.scroll.height>layout.scroll.clientHeight,'Expanded mobile groups do not provide an independent scroll region');
          await page.locator('.control-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});
          scrolling=await page.evaluate(()=>({top:document.querySelector('.control-scroll').scrollTop,header:document.querySelector('.panel-top').getBoundingClientRect().toJSON(),footer:document.querySelector('.panel-actions').getBoundingClientRect().toJSON()}));
          assert.ok(scrolling.top>0,'Middle controls did not scroll');closeTo(scrolling.header.top,layout.header.top,'Header moved with middle scroll');closeTo(scrolling.footer.top,layout.footer.top,'Footer moved with middle scroll');
          assertBounds(scrolling.footer,viewport.width,viewport.height,'Fixed footer');
        }else{
          // Very short screens scroll body/actions behind an opaque sticky
          // header. The close control must remain with that header at each
          // intermediate offset instead of covering physical readouts/text.
          const probes=await shortScrollProbe(page);assertShortHeader(probes);
          const exposure=await reachableControl(page,'exposure',viewport);
          await page.locator('#controls').evaluate(element=>{element.scrollTop=element.scrollHeight;});
          const reset=await reachableControl(page,'reset',viewport);
          scrolling={top:await page.locator('#controls').evaluate(element=>element.scrollTop),probes,exposure,reset};
          assert.ok(scrolling.top>0,'Short-screen outer sheet did not scroll');
          if(scene==='quasar'){
            const originalHeight=layout.header.height;await configure(page,{spin:.7});await settle(page);
            await page.waitForFunction(previous=>{
              const header=document.getElementById('control-header').getBoundingClientRect(),padding=parseFloat(getComputedStyle(document.getElementById('controls')).scrollPaddingTop);
              return observationTools.get_observation.execute({}).presetCustomized&&header.height>previous&&padding>=header.height-.5;
            },originalHeight);
            const growth=await page.evaluate(()=>({height:document.getElementById('control-header').getBoundingClientRect().height,padding:parseFloat(getComputedStyle(document.getElementById('controls')).scrollPaddingTop)}));
            const customProbes=await shortScrollProbe(page);assertShortHeader(customProbes);
            customHeader={before:originalHeight,...growth,probes:customProbes,exposure:await reachableControl(page,'exposure',viewport),reset:await reachableControl(page,'reset',viewport)};
          }
        }
        const stateBefore=pickState(await observe(page)),disclosuresBefore=await page.locator('.control-group').evaluateAll(elements=>elements.map(element=>({id:element.id,open:element.open})));
        await page.locator('.control-toggle').click();assert.equal((await observe(page)).controlsExpanded,false);
        await page.locator('.control-toggle').click();assert.equal((await observe(page)).controlsExpanded,true);
        assert.deepEqual(pickState(await observe(page)),stateBefore,'Closing/reopening changed observation parameters');
        assert.deepEqual(await page.locator('.control-group').evaluateAll(elements=>elements.map(element=>({id:element.id,open:element.open}))),disclosuresBefore,'Closing/reopening reset inner disclosure state');
        await page.keyboard.press('Escape');assert.equal((await observe(page)).controlsExpanded,false);assert.equal(await page.locator('.control-toggle').evaluate(element=>document.activeElement===element),true);
        assert.deepEqual(pickState(await observe(page)),stateBefore,'Escape changed observation parameters');

        // Changed viewport height must render a new nonempty image. Repeated
        // resize/fullscreen/visual-viewport notifications at the same size must
        // preserve the settled backing store and avoid redundant composites.
        const shortened={width:viewport.width,height:Math.max(360,viewport.height-80)},beforeResize=await page.evaluate(()=>canvasProbe.composites);
        await page.setViewportSize(shortened);
        // Resize events arrive after setViewportSize resolves; waiting only for
        // old settled metrics can accidentally accept the preceding viewport.
        await page.waitForFunction(before=>canvasProbe.composites>before&&canvasProbe.height===document.getElementById('cosmos').height,beforeResize);await settle(page);
        const changed=await page.evaluate(()=>({probe:{...canvasProbe},canvas:{width:document.getElementById('cosmos').width,height:document.getElementById('cosmos').height}}));
        assert.ok(changed.probe.visibleLight>0);assert.equal(changed.probe.width,changed.canvas.width);assert.equal(changed.probe.height,changed.canvas.height);
        const duplicate=await page.evaluate(async()=>{
          const before={writes:{...canvasProbe.writes},composites:canvasProbe.composites};
          window.dispatchEvent(new Event('resize'));document.dispatchEvent(new Event('fullscreenchange'));document.dispatchEvent(new Event('fullscreenchange'));window.visualViewport?.dispatchEvent(new Event('resize'));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return {before,after:{writes:{...canvasProbe.writes},composites:canvasProbe.composites,visibleLight:canvasProbe.visibleLight}};
        });
        assert.deepEqual(duplicate.after.writes,duplicate.before.writes,'Duplicate notification cleared the cached canvas');assert.equal(duplicate.after.composites,duplicate.before.composites,'Duplicate notification submitted a new composite');assert.ok(duplicate.after.visibleLight>0);
        const beforeRestore=await page.evaluate(()=>canvasProbe.composites);await page.setViewportSize(viewport);
        await page.waitForFunction(before=>canvasProbe.composites>before,beforeRestore);await settle(page);await page.locator('.control-toggle').click();
        await page.locator('#controls').evaluate(element=>{element.scrollTop=0;});await page.locator('.control-scroll').evaluate(element=>{element.scrollTop=0;});
        await page.screenshot({path:path.join(output,`${scene}-${viewport.width}x${viewport.height}-controls.png`)});
        report.cases.push({scene,viewport,layout,scrolling,customHeader,statePreserved:true,escapeFocus:true,changedViewport:changed.canvas,duplicate,imageLight:changed.probe.visibleLight});
        console.log('MOBILE PASS',scene,viewport.width+'x'+viewport.height);
      }catch(error){
        if(activePage&&!activePage.isClosed())await activePage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
        report.failureCase={scene,viewport};throw error;
      }finally{await context.close();activePage=null;}
    }
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    try{
      const page=await initialize(context,true);await configure(page,{paused:true,density:16000});await settle(page);await page.locator('.control-toggle').click();
      assert.equal(await page.locator('#fullscreen').isVisible(),false,'Unsupported fullscreen action remains visible');
      const actions=await page.locator('.scene-tools button').evaluateAll(elements=>elements.filter(element=>element.getBoundingClientRect().height>0).map(element=>({id:element.id,box:element.getBoundingClientRect().toJSON()}))),row=await rect(page.locator('.scene-tools'));
      assert.deepEqual(actions.map(action=>action.id),['pause','reset']);closeTo(actions[0].box.width,actions[1].box.width,'Unsupported-fullscreen actions have unequal widths');closeTo(actions[1].box.right,row.right,'Unsupported fullscreen leaves an empty action column');
      assert.ok(actions[0].box.width>=44&&actions[0].box.height>=44);assert.ok(actions[1].box.width>=44&&actions[1].box.height>=44);
      report.unsupportedFullscreen={actions,row};await page.screenshot({path:path.join(output,'unsupported-fullscreen.png')});
    }finally{await context.close();activePage=null;}
    assert.deepEqual(report.errors,[]);report.pass=true;
    console.log('PASS: 12 mobile scene/viewport cases, header close separation, touch targets, native select fonts, scrolling, preserved state/focus, live resize image/cache and unsupported fullscreen.');
  }catch(error){
    report.pass=false;report.failure={message:String(error),stack:error.stack};
    if(activePage&&!activePage.isClosed())await activePage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    throw error;
  }finally{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
