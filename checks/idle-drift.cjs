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
 let now=0,nextId=1,state;const frames=new Map(),timers=new Map(),nodes=new Map();
 class Target{
  constructor(){
   this.listeners=new Map();this.classes=new Set();this.capture=new Set();
   this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name),contains:name=>this.classes.has(name)};
   this.style={setProperty(){}};this.dataset={};this.open=false;this.clientHeight=900;
  }
  addEventListener(type,handler,options={}){
   const list=this.listeners.get(type)||[];list.push({handler,options});this.listeners.set(type,list);
  }
  fire(type,data={}){
   const event={button:0,pointerId:1,pointerType:'mouse',clientX:100,clientY:100,scale:1,deltaY:0,deltaMode:0,preventDefault(){},...data};
   for(const {handler,options} of this.listeners.get(type)||[])if(!options.signal?.aborted)handler(event);
  }
  querySelector(selector){assert.equal(selector,'summary');return node('summary');}
  setAttribute(){}focus(){}contains(){return false;}
  setPointerCapture(id){this.capture.add(id);}
  hasPointerCapture(id){return this.capture.has(id);}
  releasePointerCapture(id){this.capture.delete(id);}
  getBoundingClientRect(){return {width:1440,height:900};}
 }
 const node=id=>{if(!nodes.has(id))nodes.set(id,new Target());return nodes.get(id);};
 const document=new Target(),window=new Target(),media=new Target();
 document.hidden=false;media.matches=reduced;
 document.querySelector=selector=>node(selector.slice(1));document.getElementById=node;
 const models=['schwarzschild','kerr'].map(value=>{const element=new Target();element.dataset.model=value;return element;});
 const presets=['top','cinema'].map(value=>{const element=new Target();element.dataset.preset=value;return element;});
 document.querySelectorAll=selector=>selector==='[data-model]'?models:selector==='[data-preset]'?presets:[];
 window.matchMedia=()=>media;window.devicePixelRatio=1;
 // Keep validation bounds tied to the real page rather than a second set of limits.
 for(const [,id,attributes] of fs.readFileSync(path.join(dist,'index.html'),'utf8').matchAll(/<input id="([^"]+)"([^>]+)>/g)){
  for(const [,name,value] of attributes.matchAll(/(min|max|step|value)="([^"]+)"/g))node(id)[name]=value;
 }
 const context={document,window,console,AbortController,performance:{now:()=>now},ResizeObserver:class{observe(){}},
  requestAnimationFrame:handler=>{const id=nextId++;frames.set(id,handler);return id;},cancelAnimationFrame:id=>frames.delete(id),
  setTimeout:(handler,delay)=>{const id=nextId++;timers.set(id,{handler,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
  BlackHoleRaytracer:{create:options=>{state=options.state;return {kind:'webgl',count:()=>state.density,draw(){},refine(){},metrics:{}};}}
 };
 vm.createContext(context);
 for(const file of ['physics.js','navigation.js','app.js'])vm.runInContext(fs.readFileSync(path.join(dist,file),'utf8'),context,{filename:file});
 function advance(seconds){
  for(let i=0;i<Math.round(seconds*60);i++){
   now+=1000/60;
   for(const [id,item] of [...timers])if(item.at<=now){timers.delete(id);item.handler();}
   const pending=[...frames.values()];frames.clear();for(const handler of pending)handler(now);
  }
 }
 function preference(matches){media.matches=matches;media.fire('change',{matches});}
 return {advance,preference,state:()=>state,surface:node('cosmos'),shell:node('control-shell'),document,window,node};
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

console.log('PASS: production idle drift with ignored buttons, native/mixed gestures, multi-pointer release/cancel, blur, wheel cancellation, reduced-motion playback/preferences, pause and panel recovery.');
