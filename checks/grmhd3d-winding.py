"""Check real native magnetic winding against an independent local shear law."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from grmhd3d_io import merge_vtk

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
folder = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="interstellar-winding-"))
folder.mkdir(parents=True, exist_ok=True)
if any(folder.iterdir()):
    raise SystemExit("Use an empty output directory; existing evidence is preserved")
binary = args.source.resolve() / "bin/athena"
command = [str(binary), "-i", str(root / "tools/grmhd3d/athinput.winding"), "-d", str(folder),
           "time/tlim=0.0001", "time/nlim=1", "output1/dt=0.0001", "output2/dt=0.0001",
           "output3/dt=0.0001", "mesh/num_threads=1"]
with (folder / "run.log").open("w") as log:
    subprocess.run(command, stdout=log, stderr=log, check=True)
first = merge_vtk(sorted(folder.glob("*.prim.00000.vtk")))
later = merge_vtk(sorted(folder.glob("*.prim.00001.vtk")))
user = merge_vtk(sorted(folder.glob("*.user.00000.vtk")))
data = {name: field["data"] for name, field in user["fields"].items()}
rho = first["fields"]["rho"]["data"]
nr, nt, np = first["shape"]
peak = max(range(len(rho)), key=lambda i: rho[i])
radial, polar = peak % nr, (peak // nr) % nt
checks = []
for azimuth in [0, np // 3]:
    at = (azimuth * nt + polar) * nr + radial
    omega = lambda index: data["uphi"][index] / data["ut"][index]
    dr = data["r_center"][at + 1] - data["r_center"][at - 1]
    field = first["fields"]["Bcc"]["data"]
    expected = field[at * 3] * (omega(at + 1) - omega(at - 1)) / dr
    # Adjacent polar cells can be outside this thin transport fixture's torus.
    # Use the smooth constant-l equilibrium derivative, not a difference across
    # its vacuum edge: l = u^t u_phi and Omega=(sqrt(1+4l²f/A)-1)/(2l).
    radius, theta = data["r_center"][at], data["theta_center"][at]
    area = radius * radius * math.sin(theta) ** 2
    l = data["ut"][at] * area * data["uphi"][at]
    f = 1 - 2 / radius
    polar_shear = -2 * l * f / math.tan(theta) / (area * math.sqrt(1 + 4 * l * l * f / area))
    expected += field[at * 3 + 1] * polar_shear
    actual = (later["fields"]["Bcc"]["data"][at * 3 + 2] - field[at * 3 + 2]) / (later["time"] - first["time"])
    error = abs(actual / expected - 1)
    checks.append({"azimuth": azimuth, "actual": actual, "expected": expected, "relativeError": error})
    if not abs(expected) > 1e-6 or error > .03:
        raise AssertionError(f"Native induction disagrees with differential rotation: {checks[-1]}")
report = {"passed": True, "timeStep": later["time"] - first["time"], "checks": checks,
          "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "command": command}
(folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
