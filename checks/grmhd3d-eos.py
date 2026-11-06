#!/usr/bin/env python3
"""Run isolated GRMHD EOS failure/ceiling contracts against real solver code.

Supply a configured production source with the EOS repair applied. This script
copies it, applies two test-only patches, builds, and executes only nlim=0 unit
fixtures. The original-bug option reverts the repair only in that private copy.
No shared solver or production source is changed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--input',type=Path,required=True)
parser.add_argument('--output',type=Path)
parser.add_argument('--jobs',type=int,default=4)
parser.add_argument('--original-bug',action='store_true')
args=parser.parse_args()
folder=args.output.resolve() if args.output else Path(tempfile.mkdtemp(dir='/private/tmp',prefix='interstellar-eos-audit-'))
folder.mkdir(parents=True,exist_ok=True)
source=folder/'source'
if source.exists():raise SystemExit('Use an empty audit output directory')
shutil.copytree(args.source.resolve(),source,ignore=shutil.ignore_patterns('.git'))
patches=Path(__file__).resolve().parents[1]/'tools/grmhd3d'
if args.original_bug:subprocess.run(['git','apply','--reverse',str(patches/'eos-failure.patch')],cwd=source,check=True)
production_sha=hashlib.sha256((source/'src/eos/adiabatic_mhd_gr.cpp').read_bytes()).hexdigest()
for name in ['eos-test-only.patch','eos-pgen-test.patch']:
 subprocess.run(['git','apply',str(patches/name)],cwd=source,check=True)
with (folder/'build.log').open('w') as log:subprocess.run(['make',f'-j{args.jobs}'],cwd=source,stdout=log,stderr=log,check=True)
run=folder/'run';run.mkdir()
command=[str(source/'bin/athena'),'-i',str(args.input.resolve()),'-d',str(run),'time/tlim=0','time/nlim=0','coord/a=0','coord/m=1','problem/tilt_angle=0','hydro/gamma_max=2','hydro/sigma_max=100','hydro/beta_min=0.001','mesh/nx1=16','mesh/nx2=8','mesh/nx3=8','meshblock/nx1=16','meshblock/nx2=8','meshblock/nx3=8','mesh/num_threads=1']
with (folder/'run.log').open('w') as log:result=subprocess.run(command,stdout=log,stderr=log)
pattern=r'EOS_AUDIT case=(\S+) rho=(\S+) expected_rho=(\S+) pressure=(\S+) expected_pressure=(\S+) gamma=(\S+) expected_gamma=(\S+) calls=(\d+) error=(\S+) pass=(\d+)'
rows=[]
for m in re.finditer(pattern,(folder/'run.log').read_text()):
 rows.append({'case':m[1],'rho':float(m[2]),'expectedRho':float(m[3]),'pressure':float(m[4]),'expectedPressure':float(m[5]),'gamma':float(m[6]),'expectedGamma':float(m[7]),'inversionCalls':int(m[8]),'error':float(m[9]),'passed':bool(int(m[10]))})
cases={r['case'] for r in rows}
expected={'first_failure','retry_failure','velocity_ceiling'}
passed=cases==expected and ((result.returncode==42 and all(not r['passed'] for r in rows)) if args.original_bug else (result.returncode==0 and all(r['passed'] for r in rows)))
report={'passed':passed,'originalBug':args.original_bug,'exitCode':result.returncode,'rows':rows,'productionEosSha256':production_sha,'binarySha256':hashlib.sha256((source/'bin/athena').read_bytes()).hexdigest(),'command':command,'note':'Controlled failure-path and ceiling proof only; not a causal claim about the separate t283 HLLD runaway.'}
(folder/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'directory':str(folder),**report},indent=2))
raise SystemExit(0 if passed else 1)
