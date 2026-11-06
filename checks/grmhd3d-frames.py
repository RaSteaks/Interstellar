#!/usr/bin/env python3
"""Build a disposable native 3-axis normal-field contract test.

The provided source checkout must already be configured/built. It is copied,
never modified. The optional original-bug case reverts only the six corrected
Kerr-Schild face-field reads in that copy. No production debug branch is added.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--input', type=Path, required=True)
parser.add_argument('--output', type=Path)
parser.add_argument('--jobs', type=int, default=4)
parser.add_argument('--original-bug', action='store_true')
args = parser.parse_args()
folder = args.output.resolve() if args.output else Path(tempfile.mkdtemp(dir='/private/tmp', prefix='interstellar-induction-audit-sentinel-'))
folder.mkdir(parents=True, exist_ok=True)
source = folder/'source'
if source.exists():
    raise SystemExit('Use an empty output directory; existing source copies are preserved')
shutil.copytree(args.source.resolve(), source, ignore=shutil.ignore_patterns('.git'))
patch = Path(__file__).resolve().parents[1]/'tools/grmhd3d/frame-probe.patch'
subprocess.run(['git', 'apply', str(patch)], cwd=source, check=True)
if args.original_bug:
    path=source/'src/coordinates/kerr-schild.cpp'
    text=path.read_text()
    for axis in (1,2,3):
        old=f'= bb{axis}(k,j,i);'
        if text.count(old)!=2:
            raise SystemExit('Expected exactly two corrected normal-field reads per axis')
        text=text.replace(old,f'= bb{axis}(i);')
    path.write_text(text)
with (folder/'build.log').open('w') as log:
    subprocess.run(['make', f'-j{args.jobs}'], cwd=source, stdout=log, stderr=log, check=True)
run=folder/'run'
run.mkdir()
command=[str(source/'bin/athena'),'-i',str(args.input.resolve()),'-d',str(run),'time/tlim=0','time/nlim=0','coord/a=0']
with (folder/'run.log').open('w') as log:
    result=subprocess.run(command, stdout=log, stderr=log)
text=(folder/'run.log').read_text()
rows=[]
for match in re.finditer(r'INDUCTION_SENTINEL axis=(\d+) k=(\d+) j=(\d+) i=(\d+) actual=([^\s]+) expected=([^\s]+) relative_error=([^\s]+)',text):
    rows.append(dict(axis=int(match[1]),k=int(match[2]),j=int(match[3]),i=int(match[4]),actual=float(match[5]),expected=float(match[6]),relativeError=float(match[7])))
if args.original_bug:
    passed=result.returncode==42 and len(rows)==1 and rows[0]['relativeError']>1e-2
else:
    passed=result.returncode==0 and {r['axis'] for r in rows}=={1,2,3} and all(r['relativeError']<2e-12 and r['k']>0 and r['j']>0 for r in rows)
report={'passed':passed,'originalBug':args.original_bug,'exitCode':result.returncode,'rows':rows,'binarySha256':hashlib.sha256((source/'bin/athena').read_bytes()).hexdigest(),'command':command,'testPatchSha256':hashlib.sha256(patch.read_bytes()).hexdigest()}
(folder/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'directory':str(folder),**report},indent=2))
raise SystemExit(0 if passed else 1)
