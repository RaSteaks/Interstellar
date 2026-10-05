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
assert.equal(nav.view(12).stage,'approach');assert.equal(nav.view(12).fade,0);
// Compatibility never fabricates an interior frame. The physical-core test
// independently verifies actual infall and timelike tetrads across the horizon.
for(const zoom of [6.6,7,8,9,12])near(nav.view(zoom).fade,0);
assert.equal(nav.view(12,true).orbit,0);assert.equal(nav.smoothZoom(1,12,.016,true),12);
for(const [from,to] of [[1,12],[12,1]]){
 let value=from;
 for(let i=0;i<90;i++){const next=nav.smoothZoom(value,to,1/60);assert.ok(next>=Math.min(from,to)&&next<=Math.max(from,to));value=next;}
 assert.equal(value,to);
}
near(nav.wheelZoom(1,{deltaY:-1,deltaMode:1}),nav.wheelZoom(1,{deltaY:-16,deltaMode:0}));
near(nav.wheelZoom(1,{deltaY:-1,deltaMode:2},720),nav.wheelZoom(1,{deltaY:-720,deltaMode:0}));

// Idle drift: the rate ramps linearly (3 s up, 0.8 s down) and the angle only ever
// advances by rate × 0.02°/s × elapsed, so it cannot jump when suppression toggles.
const dr=nav.drift;
near(dr.degreesPerSecond,.02);near(dr.waitSeconds,6);near(dr.resumeSeconds,3);near(dr.stopSeconds,.8);
const speed=dr.degreesPerSecond*Math.PI/180;
let d={angle:0,rate:0};
for(let i=0;i<180;i++)d=nav.driftStep(d.angle,d.rate,1/60,false);
near(d.rate,1);near(d.angle,1.5*speed,1e-4); // 3 s linear ramp integrates to ≈1.5 s at full speed
const full=nav.driftStep(d.angle,d.rate,1,false);
near(full.rate,1);near(full.angle-d.angle,speed); // one full-speed second advances exactly 0.02°
const beforeStop=full.angle;
d=full;
for(let i=0;i<48;i++)d=nav.driftStep(d.angle,d.rate,1/60,true);
near(d.rate,0);near(d.angle-beforeStop,.4*speed,1e-4); // 0.8 s stop ramp ≈ 0.4 s at full speed
const halted=nav.driftStep(d.angle,d.rate,60,true);
near(halted.angle,d.angle);near(halted.rate,0); // suppressed at rest cannot drift
const bounded=nav.driftStep(0,1,.05,false);
assert.ok(bounded.angle>0&&bounded.angle<=speed*.05+1e-12&&bounded.rate===1);
near(nav.driftStep(2,0,900,true).angle,2); // a long suppressed step cannot move the angle
// Suppression toggles mid-ramp are continuous: the rate moves at most one stop-step per frame.
let ramp={angle:0,rate:0};
for(const suppressed of [false,true,false]){
 for(let i=0;i<30;i++){const next=nav.driftStep(ramp.angle,ramp.rate,1/60,suppressed);assert.ok(Math.abs(next.rate-ramp.rate)<=1/60/dr.stopSeconds+1e-12);ramp=next;}
}

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
// Activity follows accepted input, not mouse-button events or the pointer-only cursor class.
assert.equal(input.active,false);
for(const button of [1,2]){surface.fire('pointerdown',{pointerId:9,button});surface.fire('pointerup',{pointerId:9,button});assert.equal(input.active,false);}
surface.fire('pointerdown',{pointerId:1,clientX:100});surface.fire('pointerdown',{pointerId:2,clientX:200});
assert.equal(input.active,true);
surface.fire('pointermove',{pointerId:2,clientX:300});near(state.zoom,2);near(state.yaw,0);
surface.fire('pointerup',{pointerId:2});assert.ok(!surface.hasPointerCapture(2));
assert.equal(input.active,true);
surface.fire('pointermove',{pointerId:1,clientX:110});near(state.yaw,.07);near(state.zoom,2);
surface.fire('pointercancel',{pointerId:1});assert.equal(surface.classes.size,0);assert.equal(surface.capture.size,0);
assert.equal(input.active,false);
const lastYaw=state.yaw;surface.fire('pointermove',{pointerId:1,clientX:900});near(state.yaw,lastYaw);

state.zoom=1;
const wheel=surface.fire('wheel',{ctrlKey:true,deltaY:-50});assert.ok(wheel.defaultPrevented);near(state.zoom,Math.exp(.5));
assert.equal(surface.listeners.get('wheel').options.passive,false);
state.zoom=1;
surface.fire('gesturestart',{scale:1});assert.equal(input.active,true);surface.fire('gesturechange',{scale:1.5});near(state.zoom,1.5);
surface.fire('gesturechange',{scale:1.5});near(state.zoom,1.5);
surface.fire('wheel',{ctrlKey:true,deltaY:-50});near(state.zoom,1.5); // Native gesture owns duplicate wheel.
surface.fire('gestureend');
assert.equal(input.active,false);
surface.fire('wheel',{ctrlKey:true,deltaY:-2000});assert.equal(state.zoom,12);
surface.fire('wheel',{ctrlKey:true,deltaY:2000});assert.equal(state.zoom,.65);
surface.fire('pointerdown',{pointerId:3});input.cancel();assert.equal(surface.capture.size,0);assert.equal(input.active,false);
input.dispose();const lastZoom=state.zoom;surface.fire('wheel',{ctrlKey:true,deltaY:-50});assert.equal(state.zoom,lastZoom);
assert.ok(ended>=3);
console.log('PASS: touch pinch/resumption/cancel, ctrl-wheel, Safari gesture deduplication, zoom limits/easing, horizon reversal and 1809 safe observer frames.');
