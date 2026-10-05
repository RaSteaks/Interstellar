#!/usr/bin/env python3
"""Generate a reproducible, compact axisymmetric GRMHD movie for the renderer.

The upstream solver is executed in a disposable checkout, never vendored into
the website. Only numerical fluid records and their provenance are shipped.
"""
import argparse
import array
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile

REPOSITORY = "https://github.com/AFD-Illinois/iharm2d_v3.git"
COMMIT = "bfa06d2cbabf2c8cd94c1711d04fd468397e9aee"
ROOT = Path(__file__).resolve().parents[1]
# The solver stretches the polar coordinate as theta = pi*(x + s*sin(2*pi*x)/(2*pi)),
# whose Jacobian dtheta/dx = pi*(1 + s*cos(2*pi*x)) is what rescales u^theta below.
# Readers invert the same map (dist/plasma.js velocityTexture, the shader's theta
# table), so the slope recorded in the metadata must stay equal to this constant.
THETA_SLOPE = 0.7
CHECKPOINT_MAGIC = b"GRMHDCP1"
CHECKPOINT_HEADER = "<8sIIII d II"
CELLS = 64 * 64
COMPONENTS = 12


def checkpoint_bytes(last_frame, time):
    """Serialize a complete double-precision restart state and both edges.

    The renderer history remains float32 for compact GPU upload.  Restarting
    the solver needs every primitive at t=800 plus explicit radial boundary
    rows, so the checkpoint is a separate lossless float64 resource.
    """
    boundary = []
    for radial in (0, 63):
        start = radial * 64 * COMPONENTS
        boundary.extend(last_frame[start:start + 64 * COMPONENTS])
    header = struct.pack(CHECKPOINT_HEADER, CHECKPOINT_MAGIC, 1, CELLS, COMPONENTS, 2, time, 64, 0)
    return header + struct.pack("<" + "d" * len(last_frame), *last_frame) + struct.pack("<" + "d" * len(boundary), *boundary)


def run_solver(destination):
    subprocess.run(["git", "clone", REPOSITORY, str(destination)], check=True)
    subprocess.run(["git", "checkout", COMMIT], cwd=destination, check=True)
    problem = destination / "prob:kerr_torus"
    header = problem / "decs.h"
    header.write_text(header.read_text().replace("#define N1       (128)", "#define N1       (64)").replace("#define N2       (128)", "#define N2       (64)"))
    init = problem / "init.c"
    init.write_text(init.read_text().replace("tf = 2000.0;", "tf = 800.0;").replace("DTd = 50.;", "DTd = 10.;").replace("DTi = 5.0;", "DTi = 1000.;"))
    # OpenMP is only a parallelism/timer dependency. The serial build follows
    # exactly the same finite-volume update and constrained-transport equations.
    (problem / "omp.h").write_text("#include <time.h>\nstatic inline double omp_get_wtime(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + 1e-9*t.tv_nsec; }\n")
    sources = list((destination / "core_src").glob("*.c")) + [p for p in problem.glob("*.c") if p.name != "synchrotron.c"]
    subprocess.run(["clang", "-O3", "-fcommon", "-Wno-unknown-pragmas", "-I" + str(problem), *map(str, sources), "-lm", "-o", str(problem / "harm")], check=True)
    with (problem / "run.log").open("w") as log:
        subprocess.run([str(problem / "harm")], cwd=problem, stdout=log, stderr=log, check=True)
    return problem


def pack(problem):
    frames = []
    max_divergence = 0.0
    max_velocity_error = 0.0
    max_magnetic_error = 0.0
    accretion = []
    output = array.array("f")
    header = None
    last_frame = None
    # Keep the full causal history, including startup, so lookback does not
    # wrap from the end of the movie into its beginning.
    for file in sorted((problem / "dumps").glob("dump[0-9][0-9][0-9]")):
        number = int(file.name[4:])
        if number % 2 and number != 81:
            continue
        with file.open() as handle:
            h = [float(x) for x in next(handle).split()]
            if frames and h[0] <= frames[-1] + 1e-5:
                continue
            header = h
            rows = [[float(x) for x in line.split()] for line in handle]
        frame_records = []
        if len(rows) != 64 * 64:
            raise ValueError(f"Unexpected grid size: {file}")
        mdot = 0.0
        for i, row in enumerate(rows):
            r = math.exp(row[0])
            stretch = math.pi * (1 + THETA_SLOPE * math.cos(2 * math.pi * row[1]))
            rho, internal = row[2:4]
            u, b = row[11:15], row[19:23]
            bsq = sum(x * y for x, y in zip(b, row[23:27]))
            if rho <= 0 or internal <= 0 or not all(math.isfinite(x) for x in row):
                raise ValueError("Nonphysical primitive in GRMHD snapshot")
            max_divergence = max(max_divergence, row[10])
            max_velocity_error = max(max_velocity_error, abs(sum(x * y for x, y in zip(u, row[15:19])) + 1))
            max_magnetic_error = max(max_magnetic_error, abs(sum(x * y for x, y in zip(b, row[15:19]))))
            if i < 64:
                mdot -= 2 * math.pi / 64 * rho * u[1] * row[31]
            # Modified KS -> spherical KS. Preserve the evolved four-velocity
            # and comoving magnetic four-vector, not the primitive 3-velocity.
            record = [math.log(rho), math.log(internal), max(0, bsq), 0,
                      u[0], r * u[1], stretch * u[2], u[3],
                      b[0], r * b[1], stretch * b[2], b[3]]
            output.extend(record)
            frame_records.extend(record)
        last_frame = frame_records
        frames.append(h[0])
        if h[0] >= 400:
            accretion.append(mdot)
    if len(frames) < 30 or max_velocity_error > 1e-5:
        raise ValueError("Incomplete simulation or invalid emitter normalization")
    import sys
    if sys.byteorder != "little":
        output.byteswap()
    binary = output.tobytes()
    folder = ROOT / "dist" / "data"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "grmhd-torus.f32.gz").write_bytes(gzip.compress(binary, compresslevel=9, mtime=0))
    if last_frame is None or len(last_frame) != CELLS * COMPONENTS:
        # The sorted dump list above is intentionally conservative; the final
        # accepted frame is always the last frame collected, even if a source
        # directory contains unrelated files.
        last_frame = list(output[-CELLS * COMPONENTS:])
    checkpoint = checkpoint_bytes(last_frame, frames[-1])
    checkpoint_path = folder / "grmhd-torus.checkpoint.bin.gz"
    checkpoint_path.write_bytes(gzip.compress(checkpoint, compresslevel=9, mtime=0))
    meta = dict(version=2,repository=REPOSITORY,commit=COMMIT,spin=.9375,charge=0,
                resolution=[64,64],axisymmetric=True,adiabaticIndex=5/3,
                timeUnit="GM/c^3",timeRange=[frames[0],frames[-1]],times=frames,
                coordinates="spherical ingoing Kerr-Schild",radialStart=header[3],radialStep=header[5],thetaSlope=THETA_SLOPE,
                components=["log_rho","log_internal_energy","b_squared","reserved","u_t_con","u_r_con","u_theta_con","u_phi_con","b_t_con","b_r_con","b_theta_con","b_phi_con"],
                accretionRateCode=sum(accretion)/len(accretion),maxDivB=max_divergence,
                maxVelocityNormError=max_velocity_error,maxMagneticOrthogonalityError=max_magnetic_error,
                sha256=hashlib.sha256(binary).hexdigest(),bytes=len(binary),
                checkpoint=dict(path=checkpoint_path.name,format="GRMHDCP1",time=frames[-1],precision="float64",
                                bytes=len(checkpoint),sha256=hashlib.sha256(checkpoint).hexdigest(),stateCount=CELLS * COMPONENTS,
                                boundaryRows=2,boundaryWidth=64),
                reconstruction="WENO5",magneticDivergenceControl="flux constrained transport",cooling=False,windSource=True,
                limitations="2D axisymmetric, 64x64, finite movie; no sustained 3D dynamo, no radiation feedback")
    (folder / "grmhd-torus.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k:meta[k] for k in ["resolution","timeRange","bytes","accretionRateCode","maxDivB","maxVelocityNormError","sha256"]},indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Reuse an already completed pinned solver checkout")
    args = parser.parse_args()
    if args.source:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.source, text=True).strip()
        if commit != COMMIT:
            raise ValueError("Upstream commit does not match provenance")
        pack(args.source / "prob:kerr_torus")
    else:
        with tempfile.TemporaryDirectory(prefix="interstellar-grmhd-") as directory:
            pack(run_solver(Path(directory) / "solver"))
