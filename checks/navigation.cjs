const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const context={AbortController,setTimeout,clearTimeout};
vm.createContext(context);
for(const name of ['navigation.js','geodesics.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist',name),'utf8'),context);
const nav=context.BlackHoleNavigation,geo=context.BlackHoleGeodesics;
const near=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

// The complete journey is monotone and finite; its mathematical observers stay timelike.
let previous=nav.view(nav.limits.min);
for(let i=0;i<=200;i++){
 const zoom=nav.limits.min*(nav.limits.max/nav.limits.min)**(i/200),view=nav.view(zoom);
 assert.ok(view.distance<=previous.distance+1e-9 && view.fade>=previous.fade-1e-9);
 assert.ok(view.distance>=3-1e-9 && view.distance<=80);
 for(const spin of [0,.65,.95])for(const tilt of [8,18,78]){
  const camera=geo.observer(spin,tilt,view.distance);
  assert.ok(camera.geo.f<1);
  near(geo.metricDot(camera.u,camera.u,camera.geo),-1);
  for(const basis of camera.basis){near(geo.metricDot(basis,basis,camera.geo),1);near(geo.metricDot(camera.u,basis,camera.geo),0);}
  const ray=geo.initialRay(camera,.1,.2);near(geo.hamiltonian(ray,spin),0);
 }
 previous=view;
}
near(nav.view(1).distance,80);near(nav.view(12).distance,3);
assert.equal(nav.view(12).stage,'inside');assert.equal(nav.view(12).fade,1);
assert.equal(nav.view(12,true).orbit,0);assert.equal(nav.smoothZoom(1,12,.016,true),12);
for(const [from,to] of [[1,12],[12,1]]){
 let value=from;
 for(let i=0;i<90;i++){const next=nav.smoothZoom(value,to,1/60);assert.ok(next>=Math.min(from,to)&&next<=Math.max(from,to));value=next;}
 assert.equal(value,to);
}
near(nav.wheelZoom(1,{deltaY:-1,deltaMode:1}),nav.wheelZoom(1,{deltaY:-16,deltaMode:0}));
near(nav.wheelZoom(1,{deltaY:-1,deltaMode:2},720),nav.wheelZoom(1,{deltaY:-720,deltaMode:0}));

// Exercise production event handlers with a small surface double, not a second gesture implementation.
class Surface {
 constructor(){this.listeners=new Map();this.capture=new Set();this.clientHeight=720;this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
 addEventListener(type,handler,options){this.listeners.set(type,{handler,options});}
 setPointerCapture(id){this.capture.add(id);}
 hasPointerCapture(id){return this.capture.has(id);}
 releasePointerCapture(id){this.capture.delete(id);}
 fire(type,data={}){
  const event={button:0,pointerType:'touch',clientX:0,clientY:0,deltaY:0,deltaMode:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...data};
  const listener=this.listeners.get(type);if(listener&&!listener.options.signal.aborted)listener.handler(event);return event;
 }
}
const surface=new Surface(),state={zoom:1,yaw:0,tilt:18};let ended=0;
const input=nav.bind(surface,{read:()=>state,change:patch=>Object.assign(state,patch),finish:()=>ended++});
surface.fire('pointerdown',{pointerId:1,clientX:100});surface.fire('pointerdown',{pointerId:2,clientX:200});
surface.fire('pointermove',{pointerId:2,clientX:300});near(state.zoom,2);near(state.yaw,0);
surface.fire('pointerup',{pointerId:2});assert.ok(!surface.hasPointerCapture(2));
surface.fire('pointermove',{pointerId:1,clientX:110});near(state.yaw,.07);near(state.zoom,2);
surface.fire('pointercancel',{pointerId:1});assert.equal(surface.classes.size,0);assert.equal(surface.capture.size,0);
const lastYaw=state.yaw;surface.fire('pointermove',{pointerId:1,clientX:900});near(state.yaw,lastYaw);

state.zoom=1;
const wheel=surface.fire('wheel',{ctrlKey:true,deltaY:-50});assert.ok(wheel.defaultPrevented);near(state.zoom,Math.exp(.5));
assert.equal(surface.listeners.get('wheel').options.passive,false);
state.zoom=1;
surface.fire('gesturestart',{scale:1});surface.fire('gesturechange',{scale:1.5});near(state.zoom,1.5);
surface.fire('gesturechange',{scale:1.5});near(state.zoom,1.5);
surface.fire('wheel',{ctrlKey:true,deltaY:-50});near(state.zoom,1.5); // Native gesture owns duplicate wheel.
surface.fire('gestureend');
surface.fire('wheel',{ctrlKey:true,deltaY:-2000});assert.equal(state.zoom,12);
surface.fire('wheel',{ctrlKey:true,deltaY:2000});assert.equal(state.zoom,.65);
surface.fire('pointerdown',{pointerId:3});input.cancel();assert.equal(surface.capture.size,0);
input.dispose();const lastZoom=state.zoom;surface.fire('wheel',{ctrlKey:true,deltaY:-50});assert.equal(state.zoom,lastZoom);
assert.ok(ended>=3);
console.log('PASS: touch pinch/resumption/cancel, ctrl-wheel, Safari gesture deduplication, zoom limits/easing, horizon reversal and 1809 safe observer frames.');
