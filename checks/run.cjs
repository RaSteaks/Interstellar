// Small, explicit suites keep ordinary checks independent of browsers, Rust
// and native solver checkouts. Each script runs in its own process because
// the production modules publish globals; failures retain their own logs.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const suites={
 core:['physical-core.cjs','render-physics.cjs','navigation.cjs','idle-drift.cjs','grmhd3d-io.py'],
 data:['grmhd3d-data.cjs'],
 solver:['continuous-solver.cjs','grmhd-worker.cjs']
};
const selected=process.argv.slice(2);
if(!selected.length)selected.push('core');
if(selected.some(name=>!Object.hasOwn(suites,name))){
 console.error('Usage: node checks/run.cjs [core] [data] [solver]');process.exit(1);
}
const root=path.join(__dirname,'..'),output=path.join(root,'verification/checks');
fs.mkdirSync(output,{recursive:true});
const results=[];
for(const file of new Set(selected.flatMap(name=>suites[name]))){
 const start=performance.now();
 const command=file.endsWith('.py')?'python3':process.execPath;
 const result=spawnSync(command,[path.join(__dirname,file)],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 const log=(result.stdout||'')+(result.stderr||'')+(result.error?result.error.stack+'\n':'');
 fs.writeFileSync(path.join(output,file+'.log'),log);
 const passed=result.status===0;
 results.push({file,passed,exitCode:result.status,signal:result.signal,seconds:(performance.now()-start)/1000});
 console.log(`${passed?'PASS':'FAIL'} ${file} (${results.at(-1).seconds.toFixed(2)}s)`);
 if(!passed){process.stderr.write(log);process.exitCode=1;}
}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({suites:selected,passed:results.every(result=>result.passed),results},null,2)+'\n');
