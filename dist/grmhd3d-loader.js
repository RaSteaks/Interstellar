"use strict";

// Transfer actual native-solver snapshots and their interpolation-safe velocity
// representation. No procedural field or simulated progress is synthesized.
self.onmessage=async event=>{
  try{
    importScripts(event.data.moduleUrl);
    const data=await BlackHolePlasma.loadSimulation("grmhd3d");
    const velocities=BlackHolePlasma.velocityTexture(data.records,data.metadata);
    self.postMessage({...data,velocities},[data.records.buffer,velocities.buffer]);
  }catch(error){
    self.postMessage({error:error instanceof Error?error.message:String(error)});
  }
};
