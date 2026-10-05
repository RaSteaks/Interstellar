const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const dist=path.join(__dirname,'../dist');
const speed=.02*Math.PI/180;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

// Run the production app and gesture handlers with a controllable clock. Only the
// DOM and GPU are doubles; no drift or interaction-state logic is copied here.
function fixture(reduced=false){
 let now=0,nextId=1,state,refinements=0;const frames=new Map(),timers=new Map(),nodes=new Map(),registry=new Map();
 class Target{
  constructor(){
   this.listeners=new Map();this.classes=new Set();this.capture=new Set();
   this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name),contains:name=>this.classes.has(name)};
   this.style={setProperty(){}};this.dataset={};this.open=false;this.clientHeight=900;this.attributes=new Map();
  }
  addEventListener(type,handler,options={}){
   const list=this.listeners.get(type)||[];list.push({handler,options});this.listeners.set(type,list);
  }
  fire(type,data={}){
   const event={button:0,pointerId:1,pointerType:'mouse',clientX:100,clientY:100,scale:1,deltaY:0,deltaMode:0,preventDefault(){},...data};
   for(const {handler,options} of this.listeners.get(type)||[])if(!options.signal?.aborted)handler(event);
  }
  querySelector(selector){assert.equal(selector,'summary');return node('summary');}
  setAttribute(name,value){this.attributes.set(name,value);}focus(){}contains(){return false;}
  setPointerCapture(id){this.capture.add(id);}
  hasPointerCapture(id){return this.capture.has(id);}
  releasePointerCapture(id){this.capture.delete(id);}
  getBoundingClientRect(){return {width:1440,height:900};}
 }
 const node=id=>{if(!nodes.has(id))nodes.set(id,new Target());return nodes.get(id);};
 const document=new Target(),window=new Target(),media=new Target();
 document.hidden=false;media.matches=reduced;
 document.querySelector=selector=>node(selector.slice(1));document.getElementById=node;
 const models=['schwarzschild','kerr','reissner','kerr-newman'].map(value=>{const element=new Target();element.dataset.model=value;return element;});
 const presets=['top','cinema'].map(value=>{const element=new Target();element.dataset.preset=value;return element;});
 document.querySelectorAll=selector=>selector==='[data-model]'?models:selector==='[data-preset]'?presets:[];
 window.matchMedia=()=>media;window.devicePixelRatio=1;
 document.modelContext={registerTool:tool=>registry.set(tool.name,tool)};
 node('band').options=['visible','xray','radio','bolometric'].map(value=>({value,disabled:false}));
 // Keep validation bounds tied to the real page rather than a second set of limits.
 for(const [,id,attributes] of fs.readFileSync(path.join(dist,'index.html'),'utf8').matchAll(/<input id="([^"]+)"([^>]+)>/g)){
  for(const [,name,value] of attributes.matchAll(/(min|max|step|value)="([^"]+)"/g))node(id)[name]=value;
 }
 const context={document,window,console,AbortController,performance:{now:()=>now},ResizeObserver:class{observe(){}},
  requestAnimationFrame:handler=>{const id=nextId++;frames.set(id,handler);return id;},cancelAnimationFrame:id=>frames.delete(id),
  setTimeout:(handler,delay)=>{const id=nextId++;timers.set(id,{handler,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
  BlackHolePhysicalRenderer:{create:options=>{state=options.state;return {kind:'webgl',physical:true,count:()=>state.density,draw(){},refine(){refinements++;},metrics:{dataStatus:'ready',timingSource:'cpu-submit'}};}}
 };
 vm.createContext(context);
 // Use the real timelike camera/scene logic; only rasterization remains a double.
 for(const file of ['physics.js','navigation.js','relativity.js','astrophysics.js','app.js'])vm.runInContext(fs.readFileSync(path.join(dist,file),'utf8'),context,{filename:file});
 function advance(seconds){
  for(let i=0;i<Math.round(seconds*60);i++){
   now+=1000/60;
   for(const [id,item] of [...timers])if(item.at<=now){timers.delete(id);item.handler();}
   const pending=[...frames.values()];frames.clear();for(const handler of pending)handler(now);
  }
 }
 function preference(matches){media.matches=matches;media.fire('change',{matches});}
 return {advance,preference,state:()=>state,surface:node('cosmos'),shell:node('control-shell'),document,window,node,models,refinements:()=>refinements,configure:settings=>registry.get('configure_observation').execute(settings),observe:()=>registry.get('get_observation').execute({})};
}

const baseline=fixture();baseline.advance(30);near(baseline.state().drift,30*speed);

// Ignored mouse buttons must never create a hold that their release cannot clear.
for(const button of [1,2]){
 const app=fixture();app.advance(2);
 app.surface.fire('pointerdown',{button});app.surface.fire('pointerup',{button});app.advance(12);
 near(app.state().drift,14*speed);
}

// Native trackpad gestures may emit no pointer events and may remain still for
// longer than the idle timeout; pointer release must not end a native hold either.
for(const mixed of [false,true]){
 const app=fixture();app.advance(2);
 if(mixed)app.surface.fire('pointerdown');
 app.surface.fire('gesturestart');
 if(mixed)app.surface.fire('pointerup');
 app.advance(2);const held=app.state().drift;app.advance(12);near(app.state().drift,held);
 app.surface.fire('gesturechange',{scale:1.1});app.advance(12);near(app.state().drift,held);
 app.surface.fire('gestureend');app.advance(5);near(app.state().drift,held);
 app.advance(5);assert.ok(app.state().drift>held);
}

// A remaining finger keeps the camera held; every release/cancel path can resume.
for(const release of ['pointerup','pointercancel','lostpointercapture']){
 const app=fixture();app.advance(2);
 app.surface.fire('pointerdown',{pointerId:1});app.surface.fire('pointerdown',{pointerId:2});
 app.surface.fire(release,{pointerId:2});app.advance(2);
 const held=app.state().drift;app.advance(12);near(app.state().drift,held);
 app.surface.fire(release,{pointerId:1});app.advance(5);near(app.state().drift,held);
 app.advance(5);assert.ok(app.state().drift>held);assert.equal(app.surface.capture.size,0);
}
const cancelled=fixture();cancelled.advance(2);cancelled.surface.fire('gesturestart');cancelled.advance(2);
cancelled.window.fire('blur');cancelled.advance(5);const afterCancel=cancelled.state().drift;
cancelled.advance(5);assert.ok(cancelled.state().drift>afterCancel);
const wheel=fixture();wheel.advance(2);wheel.surface.fire('wheel',{deltaY:10});wheel.window.fire('blur');
wheel.advance(5);const afterWheel=wheel.state().drift;wheel.advance(5);assert.ok(wheel.state().drift>afterWheel);

// Reduced motion is a hard camera stop even when disk playback is explicitly
// enabled, both at load and after a live preference change or hidden-page change.
const reduced=fixture(true);reduced.advance(1);reduced.surface.fire('keydown',{key:' '});reduced.advance(12);
near(reduced.state().drift,0);assert.ok(reduced.state().time>0);
for(const hidden of [false,true]){
 const app=fixture();app.advance(2);const angle=app.state().drift;
 if(hidden){app.document.hidden=true;app.document.fire('visibilitychange');}
 app.preference(true);app.advance(2);
 if(hidden){app.document.hidden=false;app.document.fire('visibilitychange');}
 app.surface.fire('keydown',{key:' '});const time=app.state().time;app.advance(12);
 near(app.state().drift,angle);assert.ok(app.state().time>time);
 app.preference(false);app.advance(4);assert.ok(app.state().drift>angle);
}

const paused=fixture();paused.advance(2);paused.surface.fire('keydown',{key:' '});paused.advance(1);
const frozen={...paused.state()};paused.advance(12);
near(paused.state().drift,frozen.drift);near(paused.state().time,frozen.time);
const panel=fixture();panel.advance(2);panel.shell.open=true;panel.shell.fire('toggle');panel.advance(2);
const panelAngle=panel.state().drift;panel.advance(12);near(panel.state().drift,panelAngle);
panel.shell.open=false;panel.shell.fire('toggle');panel.advance(5);near(panel.state().drift,panelAngle);
panel.advance(5);assert.ok(panel.state().drift>panelAngle);

// Exercise the same state owner used by native controls and the configuration
// interface: startup/reset restore 8°; preset provenance follows effective physics, not lens/display edits.
const presets=fixture();
assert.equal(presets.observe().tilt,8);assert.equal(presets.observe().presetCustomized,false);
assert.equal(fs.readFileSync(path.join(dist,'index.html'),'utf8').match(/<select id="scene-choice"[^>]*>(.*?)<\/select>/s)[1].match(/<option/g).length,10);
presets.configure({scene:'isolated',spin:.8,charge:.4});assert.equal(presets.observe().presetCustomized,false); // the metric suppresses both dormant values
presets.configure({scene:'charged'});assert.equal(presets.observe().presetCustomized,false);
presets.configure({model:'schwarzschild'});assert.equal(presets.observe().scene,'charged');assert.equal(presets.observe().spin,0);assert.equal(presets.observe().charge,0);assert.equal(presets.observe().presetCustomized,true);
assert.equal(presets.node('preset-customized').hidden,false);assert.equal(presets.node('restore-preset').hidden,false);
presets.configure({model:'kerr-newman'});assert.equal(presets.observe().presetCustomized,false);
assert.equal(presets.node('restore-preset').hidden,true);
presets.configure({scene:'quasar',paused:true,exposure:1.8,density:64000,tilt:78,display:'linear',zoom:1.4});
assert.equal(presets.observe().presetCustomized,false);
presets.configure({band:'xray'});assert.equal(presets.observe().presetCustomized,true);
presets.configure({band:'visible'});assert.equal(presets.observe().presetCustomized,false);
presets.configure({spin:.8,falling:true,paused:false});presets.advance(.2);
assert.equal(presets.observe().presetCustomized,true);assert.equal(presets.observe().falling,true);
presets.configure({paused:true});const beforeRestore={...presets.state()};
presets.node('restore-preset').fire('click');
assert.equal(presets.observe().presetCustomized,false);assert.equal(presets.observe().spin,.65);assert.equal(presets.observe().tilt,8);
assert.equal(presets.state().time,0);assert.equal(presets.state().flightRadius,null);assert.equal(presets.state().flightLens,null);assert.equal(presets.observe().falling,false);
assert.equal(presets.observe().paused,beforeRestore.paused);assert.equal(presets.observe().exposure,beforeRestore.exposure);
assert.equal(presets.state().observer,'infall');assert.equal(presets.state().drift,0);
presets.configure({spin:.8,tilt:18});presets.configure({scene:'quasar'});assert.equal(presets.observe().presetCustomized,false);assert.equal(presets.observe().tilt,8);
presets.configure({scene:'stellar'});presets.node('reset').fire('click');assert.equal(presets.observe().scene,'quasar');assert.equal(presets.observe().tilt,8);assert.equal(presets.observe().paused,true);

// GRMHD locks the recorded metric at the interface boundary, including dormant
// charge values, and rejection leaves every state field intact.
for(const scene of ['m87','sgrA','jet']){
 const app=fixture();app.configure({scene});
 for(const button of app.models)assert.equal(button.disabled,button.dataset.model!=='kerr');
 assert.equal(app.node('spin').disabled,true);assert.equal(app.node('charge').disabled,true);
 for(const option of app.node('band').options)assert.equal(option.disabled,option.value!=='radio');
 assert.match(app.node('physics-help').textContent,/模拟数据固定为克尔时空，a=0\.9375、Q=0/);
 for(const patch of [{model:'schwarzschild',exposure:2},{model:'kerr-newman',zoom:2},{spin:.65,paused:true},{charge:.4},{band:'visible',tilt:0}]){
  const before=JSON.stringify(app.state());assert.throws(()=>app.configure(patch));assert.equal(JSON.stringify(app.state()),before);
 }
 app.configure({scene:'quasar',model:'schwarzschild'});assert.equal(app.observe().scene,'quasar');assert.equal(app.observe().model,'schwarzschild');
 assert.equal(app.node('spin').disabled,true);assert.equal(app.node('charge').disabled,true);assert.equal(app.models[3].disabled,false);
}

// A paused journey is stationary and refines; native range gestures release
// their interaction hold on pointerup, cancellation and window blur.
const quality=fixture();quality.advance(.2);const prior=quality.refinements();
quality.configure({falling:true});quality.advance(.2);assert.equal(quality.state().interacting,true);
quality.configure({paused:true});quality.advance(.2);assert.equal(quality.state().interacting,false);assert.ok(quality.refinements()>prior);
for(const end of ['pointerup','pointercancel','blur']){
 quality.node('spin').fire('pointerdown',{pointerId:8});quality.advance(.2);assert.equal(quality.state().interacting,true);
 const before=quality.refinements();(end==='blur'?quality.window:quality.document).fire(end,{pointerId:8});quality.advance(.2);
 assert.equal(quality.state().interacting,false);assert.ok(quality.refinements()>before);
}
// Exposure is a display operation even during a native slider drag. Its pointer
// lifecycle must not request coarse tracing or later physical refinement.
const exposure=fixture(true);exposure.advance(.2);const exposureRefinements=exposure.refinements();
exposure.node('exposure').fire('pointerdown',{pointerId:12});exposure.advance(.2);assert.equal(exposure.state().interacting,false);
exposure.node('exposure').value='1.5';exposure.node('exposure').fire('input');exposure.advance(.2);
exposure.document.fire('pointerup',{pointerId:12});exposure.advance(.2);
assert.equal(exposure.observe().exposure,1.5);assert.equal(exposure.state().interacting,false);assert.equal(exposure.refinements(),exposureRefinements);

// Resuming the same journey must keep the lens that fixed its field of view: the
// redundant observer=infall that starts a fall is not a camera change, and once
// animate has replaced viewZoom with the journey's own zoom that value no longer
// carries the original lens calibration.
const resume=fixture();resume.advance(.2);resume.configure({zoom:5});resume.advance(3);
resume.configure({falling:true,paused:false});resume.advance(3);
const framing={lens:resume.state().flightLens,radius:resume.state().flightRadius};
assert.ok(Number.isFinite(framing.lens)&&Number.isFinite(framing.radius));
resume.configure({falling:false,paused:true});
resume.configure({falling:true,paused:false});
assert.equal(resume.state().flightLens,framing.lens);
assert.equal(resume.state().flightRadius,framing.radius);
// A genuine camera change must still discard the journey and its lens.
resume.configure({tilt:30});
assert.equal(resume.state().flightLens,null);assert.equal(resume.state().flightRadius,null);assert.equal(resume.observe().falling,false);

console.log('PASS: production idle drift, pointer/native gesture lifetimes, reduced-motion and pause; preset select/customize/revert/restore/reset, GRMHD controls and atomic interface rejection; paused journey and range release refinement; exposure drag remains display-only; journey resume keeps its calibrated lens.');
