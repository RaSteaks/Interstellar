"use strict";

(() => {
  const limits=Object.freeze({min:.65,max:12,orbitStart:1.4});
  const clampZoom=value=>Math.max(limits.min,Math.min(limits.max,value));
  const smooth=value=>value*value*(3-2*value);
  function view(zoom,reducedMotion=false) {
    const progress=Math.max(0,Math.min(1,Math.log(Math.max(zoom,limits.orbitStart)/limits.orbitStart)/Math.log(limits.max/limits.orbitStart)));
    // This legacy projection path stays at r>=3. Actual horizon crossing belongs
    // to the timelike astrophysics camera; no cinematic opacity is added here.
    const travel=smooth(progress);
    return {zoom,progress,distance:80*Math.exp(Math.log(3/80)*travel),orbit:reducedMotion?0:travel*Math.PI*2.5,fade:0,stage:progress>=.55?"approach":progress>0?"orbit":"observe"};
  }
  function smoothZoom(current,target,seconds,reducedMotion=false) {
    if(reducedMotion||Math.abs(Math.log(target/current))<.001)return target;
    const amount=1-Math.exp(-Math.max(0,Math.min(.05,seconds))*18);
    return Math.exp(Math.log(current)+(Math.log(target)-Math.log(current))*amount);
  }
  function wheelZoom(current,event,pageHeight=800) {
    const unit=event.deltaMode===1?16:event.deltaMode===2?pageHeight:1;
    const delta=Math.max(-2000,Math.min(2000,event.deltaY*unit));
    return clampZoom(current*Math.exp(-delta*(event.ctrlKey||event.metaKey ? .01 : .0015)));
  }
  // Idle camera drift: a slow continuous orbit that reuses the axial-symmetry sky and
  // disk azimuth rotation, so it never retraces. The rate eases linearly to rest while
  // the user interacts and back after a quiet period; the angle itself never jumps.
  const drift=Object.freeze({degreesPerSecond:.02,waitSeconds:6,resumeSeconds:3,stopSeconds:.8});
  function driftStep(angle,rate,elapsed,suppressed) {
    const target=suppressed?0:1;
    const span=target>rate?drift.resumeSeconds:drift.stopSeconds;
    const step=Math.max(0,elapsed)/span;
    const next=Math.abs(target-rate)<=step?target:rate+(target>rate?step:-step);
    return {angle:angle+next*drift.degreesPerSecond*Math.PI/180*Math.max(0,elapsed),rate:next};
  }
  function bind(surface,{read,change,finish}) {
    const points=new Map(),lifecycle=new AbortController();
    let drag=null,pinch=null,gesture=null,wheelTimer=0;
    const listen=(type,handler,options={})=>surface.addEventListener(type,handler,{...options,signal:lifecycle.signal});
    const distance=ids=>Math.hypot(points.get(ids[0]).x-points.get(ids[1]).x,points.get(ids[0]).y-points.get(ids[1]).y);
    function rebase() {
      drag=null;pinch=null;
      const ids=[...points.keys()];
      if(ids.length>=2)pinch={ids:ids.slice(0,2),distance:Math.max(1,distance(ids)),zoom:read().zoom};
      else if(ids.length===1){const point=points.get(ids[0]),state=read();drag={...point,yaw:state.yaw,tilt:state.tilt};}
      surface.classList.toggle("dragging",points.size>0);
    }
    listen("pointerdown",event=>{
      if(event.button!==0)return;
      points.set(event.pointerId,{x:event.clientX,y:event.clientY});
      surface.setPointerCapture(event.pointerId);rebase();
    });
    listen("pointermove",event=>{
      if(!points.has(event.pointerId))return;
      points.set(event.pointerId,{x:event.clientX,y:event.clientY});
      // WebKit can send native gesture and pointer events for the same fingers.
      // One path owns zoom; cached points let single-finger dragging resume cleanly.
      if(gesture)return;
      if(pinch)change({zoom:clampZoom(pinch.zoom*distance(pinch.ids)/pinch.distance)});
      // Match the native angle slider, including edge-on and underside views.
      else if(drag)change({yaw:drag.yaw+(event.clientX-drag.x)*.007,tilt:Math.round(Math.max(-89,Math.min(89,drag.tilt+(event.clientY-drag.y)*.18)))});
    });
    function release(event){
      if(!points.delete(event.pointerId))return;
      if(surface.hasPointerCapture(event.pointerId))surface.releasePointerCapture(event.pointerId);
      rebase();finish();
    }
    for(const type of ["pointerup","pointercancel","lostpointercapture"])listen(type,release);
    listen("wheel",event=>{
      if(!Number.isFinite(event.deltaY))return;
      event.preventDefault();if(gesture||pinch)return;
      // Trackpad pinch is a ctrl-wheel sequence, so it drives scene zoom too.
      change({zoom:wheelZoom(read().zoom,event,surface.clientHeight)});
      clearTimeout(wheelTimer);wheelTimer=setTimeout(finish,140);
    },{passive:false});
    listen("gesturestart",event=>{event.preventDefault();gesture={zoom:read().zoom,scale:Number(event.scale)||1};},{passive:false});
    listen("gesturechange",event=>{
      if(!gesture||!Number.isFinite(event.scale)||event.scale<=0)return;
      event.preventDefault();change({zoom:clampZoom(gesture.zoom*event.scale/gesture.scale)});
    },{passive:false});
    listen("gestureend",event=>{if(!gesture)return;event.preventDefault();gesture=null;rebase();finish();},{passive:false});
    function cancel(){
      const ids=[...points.keys()],active=ids.length>0||gesture!==null;
      points.clear();gesture=null;rebase();clearTimeout(wheelTimer);
      for(const id of ids)if(surface.hasPointerCapture(id))surface.releasePointerCapture(id);
      if(active)finish();
    }
    // Report actual input ownership, including native gestures without pointer events.
    // Releases and cancellation update the same state, so unrelated buttons cannot latch it.
    return {get active(){return points.size>0||gesture!==null;},cancel,dispose(){cancel();lifecycle.abort();}};
  }
  globalThis.BlackHoleNavigation=Object.freeze({limits,clampZoom,view,smoothZoom,wheelZoom,drift,driftStep,bind});
})();
