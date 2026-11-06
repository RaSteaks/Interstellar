// Exercise the production 4D sampler against known periodic space/time values.
// A transport fixture isolates array indexing from expensive GRMHD evolution.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.SIMULATION_BROWSER||'webkit';
assert.ok(['firefox','webkit'].includes(engine),'Use headless Firefox or WebKit');
const source=fs.readFileSync(path.join(__dirname,'../dist/physical-renderer.js'),'utf8');
const functions=['fluidLayer','fluidSpatial','fluidSample'].map(name=>source.match(new RegExp('      vec4 '+name+'\\([\\s\\S]+?\\n      \\}'))[0]).join('\n');
const output=path.join(__dirname,'../verification/grmhd3d/sampling',engine);fs.mkdirSync(output,{recursive:true});

(async()=>{
 const browser=await playwright[engine].launch({headless:true});
 const page=await browser.newPage();
 const report={browser:engine,version:browser.version(),cases:[],errors:[]};
 page.on('pageerror',error=>report.errors.push(error.message));
 try{
  await page.setContent('<canvas id="probe" width="1" height="1"></canvas>');
  const result=await page.evaluate(functions=>{
   const gl=document.getElementById('probe').getContext('webgl2');
   if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw Error('WebGL2 float targets required');
   const linear=!!gl.getExtension('OES_texture_float_linear');
   const shader=(kind,source)=>{const value=gl.createShader(kind);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(value));return value;};
   const input=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,input);
   const data=new Float32Array(4*3*10*4);
   for(let frame=0;frame<2;frame++)for(let phi=0;phi<5;phi++)for(let r=0;r<3;r++)for(let theta=0;theta<4;theta++){
    const at=(((frame*5+phi)*3+r)*4+theta)*4;data[at]=theta+10*r+100*phi+1000*frame;data[at+3]=1;
   }
   gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA32F,4,3,10,0,gl.RGBA,gl.FLOAT,data);
   gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   const image=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,image);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1,1,0,gl.RGBA,gl.FLOAT,null);
   const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,image,0);gl.drawBuffers([gl.COLOR_ATTACHMENT0]);gl.readBuffer(gl.COLOR_ATTACHMENT0);
   const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.viewport(0,0,1,1);
   const tests=[{name:'phi center',phi:.6*Math.PI,time:.25,x:.375,expected:361},{name:'periodic seam',phi:0,time:.25,x:.375,expected:461},{name:'2pi seam',phi:2*Math.PI,time:.25,x:.375,expected:461},{name:'negative phi',phi:-.2*Math.PI,time:.25,x:.375,expected:661},{name:'phi above 2pi',phi:2.2*Math.PI,time:.25,x:.375,expected:261},{name:'temporal end',phi:1.4*Math.PI,time:1,x:.375,expected:1311},{name:'bilinear cell edge',phi:.6*Math.PI,time:.25,x:.5,expected:361.5},{name:'before history',phi:0,time:-.01,x:.375,expected:0},{name:'after history',phi:0,time:1.01,x:.375,expected:0}];
   const cases=[];
   for(const manual of linear?[false,true]:[true]){
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,input);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,manual?gl.NEAREST:gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,manual?gl.NEAREST:gl.LINEAR);
    const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nlayout(location=0) in vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
    const fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\n'+(manual?'#define DISK_MANUAL_INTERPOLATION\n':'')+'precision highp float;precision highp sampler2DArray;const float PI=3.141592653589793;uniform sampler2DArray volume;uniform int uFrameCount,uAzimuthalCount;uniform float uPhiMinimum,uTimes[169],phi,time,x;uniform int uLayers[169];out vec4 color;'+functions+'\nvoid main(){color=fluidSample(volume,vec2(x,.5),time,phi);}');
    const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const uniform=name=>gl.getUniformLocation(program,name);
    gl.uniform1i(uniform('volume'),0);gl.uniform1i(uniform('uFrameCount'),2);gl.uniform1i(uniform('uAzimuthalCount'),5);gl.uniform1f(uniform('uPhiMinimum'),0);gl.uniform1fv(uniform('uTimes'),new Float32Array([0,1]));gl.uniform1iv(uniform('uLayers'),new Int32Array([0,1]));
    for(const test of tests){
     gl.uniform1f(uniform('phi'),test.phi);gl.uniform1f(uniform('time'),test.time);gl.uniform1f(uniform('x'),test.x);gl.drawArrays(gl.TRIANGLES,0,3);
     const pixel=new Float32Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,pixel);cases.push({mode:manual?'manual':'hardware',name:test.name,actual:pixel[0],expected:test.expected});
    }
    gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
   }
   const capabilities={maxArrayLayers:gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),floatLinear:linear};
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);gl.deleteTexture(input);gl.deleteTexture(image);gl.deleteBuffer(buffer);return {cases,capabilities};
  },functions);
  report.cases=result.cases;report.capabilities=result.capabilities;
  for(const test of result.cases)assert.ok(Math.abs(test.actual-test.expected)<.001,JSON.stringify(test));
  assert.equal(report.errors.length,0);report.passed=true;console.log('PASS: production 3D phi/time sampler, periodic seams, array-frame isolation, bilinear fallback and no history extrapolation.');
 }catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
