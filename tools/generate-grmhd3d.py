#!/usr/bin/env python3
"""Build/run pinned Athena++ global 3D GRMHD and package its actual fluid history.

The upstream checkout and full-precision restart files stay outside dist. Only
validated float32 rendering records, coordinates and provenance are published.
No procedural disk pattern participates in these snapshots.
"""

import argparse
import array
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from grmhd3d_io import merge_vtk, read_parameters

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "https://github.com/PrincetonUniversity/athena.git"
COMMIT = "053bc738d5c85dac717326b4338b34c7db4e715d"
CONFIG = ROOT / "tools/grmhd3d/athinput.torus"
PATCH = ROOT / "tools/grmhd3d/athena.patch"
EOS_PATCH = ROOT / "tools/grmhd3d/eos-failure.patch"
COMPONENTS = ["log_rho", "log_internal_energy", "b_squared", "reserved",
              "u_t_con", "u_r_con", "u_theta_con", "u_phi_con",
              "b_t_con", "b_r_con", "b_theta_con", "b_phi_con"]
CONFIGURE = ["-g", "-b", "-t", "--prob=gr_torus", "--coord=kerr-schild",
             "--flux=hlle", "--nghost=4", "--cxx=clang++"]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify_source(source, include_eos=True):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if head != COMMIT:
        raise ValueError(f"Athena++ must be checked out at {COMMIT}, got {head}")
    paths = ["src/pgen/gr_torus.cpp", "src/outputs/vtk.cpp", "src/coordinates/kerr-schild.cpp"]
    diff = subprocess.check_output(["git", "-c", "color.ui=false", "diff", "--no-ext-diff", "--", *paths], cwd=source)
    if not diff:
        subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(PATCH)], cwd=source, check=True)
    elif diff != PATCH.read_bytes():
        raise ValueError("Athena++ source has a different problem/output patch")
    eos_path = "src/eos/adiabatic_mhd_gr.cpp"
    eos_diff = subprocess.check_output(["git", "diff", "--no-ext-diff", "--", eos_path], cwd=source)
    if include_eos:
        if not eos_diff:
            subprocess.run(["git", "apply", "--check", str(EOS_PATCH)], cwd=source, check=True)
            subprocess.run(["git", "apply", str(EOS_PATCH)], cwd=source, check=True)
        elif eos_diff != EOS_PATCH.read_bytes():
            raise ValueError("Unexpected GRMHD EOS changes")
    elif eos_diff:
        raise ValueError("Use the archived data-source checkout matching the run's actual EOS revision")
    changed = subprocess.check_output(["git", "diff", "--name-only"], cwd=source, text=True).splitlines()
    if set(changed) - set(paths + ([eos_path] if include_eos else [])):
        raise ValueError("Unexpected changes to the upstream GRMHD solver")


def provenance(source, run, command, configure=None, threads=1):
    result = {
        "repository": REPOSITORY, "commit": COMMIT,
        "patchSha256": sha256(PATCH.read_bytes()),
        "inputSha256": sha256((run / "athinput.torus").read_bytes()),
        "binarySha256": sha256((source / "bin/athena").read_bytes()),
        "compiler": subprocess.check_output(["clang++", "--version"], text=True).splitlines()[0],
        "configure": [sys.executable, "configure.py", *(configure or CONFIGURE)],
        "threads": threads,
        "command": command,
    }
    eos_diff = subprocess.check_output(["git", "diff", "--name-only", "--", "src/eos/adiabatic_mhd_gr.cpp"], cwd=source)
    if eos_diff:
        result["supplementalPatches"] = [{"name": "eos-failure", "sha256": sha256(EOS_PATCH.read_bytes())}]
    return result


def history(run):
    path = run / "grmhd3d.hst"
    names = None
    rows = []
    for line in path.read_text().splitlines():
        if line.startswith("#"):
            columns = re.findall(r"\[\d+\]=([^\s]+)", line)
            if columns:
                names = columns
            continue
        if line.strip():
            values = [float(value) for value in line.split()]
            if names is None or len(values) != len(names) or not all(map(math.isfinite, values)):
                raise ValueError("Invalid native GRMHD history record")
            rows.append(dict(zip(names, values)))
    if not rows:
        raise ValueError("Missing native GRMHD history diagnostics")
    return rows


def initial_quality(prim, user, gamma):
    """Report the actual seed's vertical MRI sampling and atmosphere state.

    Qtheta uses the poloidal field component, not total Alfven speed. It is a
    mesh-quality diagnostic, not evidence that turbulence has saturated.
    """
    rho = prim["fields"]["rho"]["data"]
    pressure = prim["fields"]["press"]["data"]
    data = {name: field["data"] for name, field in user["fields"].items()}
    nr, nt, np = prim["shape"]
    peak = max(rho)
    mass = weighted_q = mass6 = mass10 = max_sigma = 0.0
    for k in range(np):
        for j in range(nt):
            dtheta = prim["faces"][1][j + 1] - prim["faces"][1][j]
            solid = (math.cos(prim["faces"][1][j]) - math.cos(prim["faces"][1][j + 1])) * 2 * math.pi / np
            for i in range(nr):
                at = (k * nt + j) * nr + i
                bsq = 2 * data["pmag"][at]
                max_sigma = max(max_sigma, bsq / rho[at])
                if rho[at] <= .1 * peak:
                    continue
                omega = abs(data["uphi"][at] / data["ut"][at])
                enthalpy = rho[at] + gamma / (gamma - 1) * pressure[at] + bsq
                q = 2 * math.pi * abs(data["btheta"][at]) / (omega * dtheta * math.sqrt(enthalpy)) if omega else 0
                volume = (prim["faces"][0][i + 1] ** 3 - prim["faces"][0][i] ** 3) / 3 * solid
                weight = rho[at] * data["ut"][at] * volume
                mass += weight
                weighted_q += weight * q
                mass6 += weight if q >= 6 else 0
                mass10 += weight if q >= 10 else 0
    return {"time": prim["time"], "denseMask": "rho > 0.1 max(rho)",
            "definition": "2pi |b^theta| / (|u^phi/u^t| dtheta sqrt(rho+gamma/(gamma-1)p+b^2))",
            "massWeightedQtheta": weighted_q / mass, "massFractionQthetaAtLeast6": mass6 / mass,
            "massFractionQthetaAtLeast10": mass10 / mass,
            "maxPressureOverMaxMagneticPressure": max(pressure) / max(data["pmag"]),
            "maxComovingSigma": max_sigma}


def pack(run, output, source_info, minimum_time=400, max_frames=32):
    groups = {}
    for path in sorted(run.glob("grmhd3d.block*.prim.*.vtk")):
        groups.setdefault(path.stem.rsplit(".", 1)[1], []).append(path)
    if len(groups) < 2:
        raise ValueError("Expected a complete three-dimensional history")
    initial_files = groups[next(iter(groups))]
    native_initial = merge_vtk(initial_files)
    native_start = native_initial["time"]
    groups = dict(list(groups.items())[-max_frames:])
    records = array.array("f")
    frames = []
    summaries = []
    grid = None
    maxima = {name: 0.0 for name in ["divB", "relative_divB", "velocity_norm_error", "magnetic_orthogonality_error"]}
    parameters = read_parameters(run / "athinput.torus")
    gamma = float(parameters["hydro"]["gamma"])
    if not 1 < gamma <= 2 or float(parameters["coord"]["a"]) != 0 or float(parameters["coord"]["m"]) != 1:
        raise ValueError("This dataset requires a unit-mass Schwarzschild metric and an adiabatic EOS")
    native_initial_user = merge_vtk([file.with_name(file.name.replace(".prim.", ".user.")) for file in initial_files])
    quality = initial_quality(native_initial, native_initial_user, gamma)
    for files in groups.values():
        path = files[0]
        prim = merge_vtk(files)
        user = merge_vtk([file.with_name(file.name.replace(".prim.", ".user.")) for file in files])
        if prim["shape"] != user["shape"] or prim["time"] != user["time"] or prim["faces"] != user["faces"]:
            raise ValueError(f"Mismatched native primitive/diagnostic snapshot: {path}")
        if frames and prim["time"] <= frames[-1]:
            if prim["time"] == frames[-1]:
                continue
            raise ValueError("Nonmonotone GRMHD snapshot history")
        fields = {name: field["data"] for name, field in prim["fields"].items()}
        diagnostics = {name: field["data"] for name, field in user["fields"].items()}
        nr, nt, np = prim["shape"]
        if grid is None:
            if np < 4 or not math.isclose(prim["faces"][2][-1] - prim["faces"][2][0], 2 * math.pi, rel_tol=1e-6):
                raise ValueError("The dataset must span the full periodic azimuth")
            radial_centers = diagnostics["r_center"][:nr]
            radial_step = math.log(radial_centers[-1] / radial_centers[0]) / (nr - 1)
            if any(abs(math.log(radial_centers[i] / radial_centers[0]) - i * radial_step) > 2e-6 for i in range(nr)):
                raise ValueError("The renderer requires a logarithmically uniform radial mesh")
            grid = {
                "resolution": [nr, nt, np],
                "radialStart": math.log(radial_centers[0]) - .5 * radial_step,
                "radialStep": radial_step,
                "innerRadius": float(prim["faces"][0][0]), "outerRadius": float(prim["faces"][0][-1]),
                "polarMinimum": float(prim["faces"][1][0]), "polarMaximum": float(prim["faces"][1][-1]),
                "phiMinimum": float(prim["faces"][2][0]), "thetaSlope": 0,
            }
        elif prim["shape"] != grid["resolution"]:
            raise ValueError("Changing mesh shapes cannot be silently concatenated")
        if any(not math.isfinite(value) for data in fields.values() for value in data):
            raise ValueError(f"Nonfinite native primitive: {path}")
        if any(value <= 0 for name in ["rho", "press"] for value in fields[name]):
            raise ValueError(f"Nonpositive native density or pressure: {path}")
        if any(not math.isfinite(value) for data in diagnostics.values() for value in data):
            raise ValueError(f"Nonfinite native diagnostic: {path}")
        for name in maxima:
            maxima[name] = max(maxima[name], max(abs(value) for value in diagnostics[name]))
        energy = dense_energy = mass = kinetic = 0.0
        dense_threshold = .1 * max(fields["rho"])
        phi_variance = phi_norm = 0.0
        for j in range(nt):
            solid = (math.cos(prim["faces"][1][j]) - math.cos(prim["faces"][1][j + 1])) * 2 * math.pi / np
            for i in range(nr):
                volume = (prim["faces"][0][i + 1] ** 3 - prim["faces"][0][i] ** 3) / 3 * solid
                values = [fields["rho"][(k * nt + j) * nr + i] for k in range(np)]
                squared = sum(value * value for value in values)
                phi_variance += max(0, squared - sum(values) ** 2 / np) * volume
                phi_norm += squared * volume
                for k, density in enumerate(values):
                    at = (k * nt + j) * nr + i
                    mass += density * diagnostics["ut"][at] * volume
                    energy += diagnostics["pmag"][at] * volume
                    if density > dense_threshold:
                        dense_energy += diagnostics["pmag"][at] * volume
                    kinetic += density * (diagnostics["gamma"][at] - 1) * volume
        # Texture layers are [time][phi], with theta along texture X and radius
        # along Y. Preserve every azimuthal cell, never revolve a 2D average.
        for k in range(np):
            for i in range(nr):
                for j in range(nt):
                    at = (k * nt + j) * nr + i
                    records.extend([math.log(fields["rho"][at]), math.log(fields["press"][at] / (gamma - 1)),
                                    2 * diagnostics["pmag"][at], 0,
                                    *[diagnostics[name][at] for name in ["ut", "ur", "utheta", "uphi", "bt", "br", "btheta", "bphi"]]])
        frames.append(prim["time"])
        summaries.append({"time": prim["time"], "restMass": mass, "comovingMagneticEnergy": energy,
                          "denseMagneticEnergy": dense_energy, "eulerianKineticProxy": kinetic, "densityAzimuthalVariation": math.sqrt(phi_variance / phi_norm)})
    if frames[-1] < minimum_time - 1e-6:
        raise ValueError(f"Incomplete native evolution: t={frames[-1]}, required {minimum_time}")
    if maxima["divB"] > 1e-8 or maxima["velocity_norm_error"] > 1e-8 or maxima["magnetic_orthogonality_error"] > 1e-8:
        raise ValueError(f"Native CT/four-vector diagnostics failed: {maxima}")
    rows = history(run)
    initial_energy = abs(rows[0]["tot-E"])
    amplification = max(abs(row["tot-E"]) for row in rows) / initial_energy
    # This isolated nonspinning torus has outflow boundaries and no external
    # heating source. Pointwise timelike/divergence constraints alone can pass
    # after primitive-recovery runaway, so reject gross Killing-energy growth.
    if not math.isfinite(amplification) or amplification > 2:
        raise ValueError(f"Native Killing-energy runaway: amplification {amplification}")
    late = [row for row in rows if row["time"] >= frames[-1] * .5]
    accretion = sum(row["mdot_1"] for row in late) / len(late)
    if accretion <= 0:
        raise ValueError("A positive measured accretion normalization is required")
    if sys.byteorder != "little":
        records.byteswap()
    raw = records.tobytes()
    public_source = {key: source_info[key] for key in ["repository", "commit", "patchSha256", "inputSha256", "binarySha256", "compiler"]}
    metadata = {
        "version": 1, "solver": "Athena++", "equations": "ideal global 3D GRMHD", **public_source, **grid,
        "configure": ["python3", *source_info["configure"][1:]], "nativeThreads": source_info.get("threads", 1),
        "axisymmetric": False, "spin": 0, "charge": 0, "adiabaticIndex": gamma,
        "coordinates": "spherical ingoing Kerr-Schild", "timeUnit": "GM/c^3",
        "timeRange": [frames[0], frames[-1]], "times": frames, "components": COMPONENTS,
        "nativeTimeRange": [native_start, frames[-1]], "observationStart": min(frames[0] + 160, frames[-1]),
        "packing": "time,phi,radius,theta,component", "precision": "float32",
        "sha256": sha256(raw), "bytes": len(raw), "accretionRateCode": accretion,
        "maxDivB": maxima["divB"], "maxRelativeDivB": maxima["relative_divB"],
        "maxVelocityNormError": maxima["velocity_norm_error"],
        "maxMagneticOrthogonalityError": maxima["magnetic_orthogonality_error"],
        "frameDiagnostics": summaries, "nativeHistory": rows,
        "maxKillingEnergyAmplification": amplification,
        "initialMRIQuality": quality,
        "initialConditions": {key: parameters["problem"][key] for key in ["r_edge", "r_peak", "field_config", "pot_amp", "pert_amp", "pert_kr", "pert_kz"]},
        "magneticDivergenceControl": "staggered-mesh constrained transport",
        "densityFloor": {"constant": float(parameters["hydro"]["dfloor"]), "coefficient": float(parameters["hydro"]["rho_min"]), "power": float(parameters["hydro"]["rho_pow"])},
        "reconstruction": {"2": "PLM", "3": "PPM"}[parameters["time"]["xorder"]], "riemannSolver": next(flag.split("=", 1)[1].upper() for flag in source_info["configure"] if flag.startswith("--flux=")), "integrator": "VL2",
        "limitations": "coarse global 3D mesh; polar cutouts with outflow; finite history; no radiation feedback; turbulent statistics and resolution convergence not established",
    }
    restart = run / "grmhd3d.final.rst"
    if restart.exists():
        metadata["restart"] = {"format": "Athena++ native float64", "file": restart.name,
                               "sha256": sha256(restart.read_bytes()), "bytes": restart.stat().st_size}
    if source_info.get("stages"):
        metadata["numericalStages"] = source_info["stages"]
    if source_info.get("supplementalPatches"):
        metadata["supplementalPatches"] = source_info["supplementalPatches"]
    output.mkdir(parents=True, exist_ok=True)
    # Content-addressed bounded chunks avoid a >100 MB repository object and
    # let the decoder verify/decompress one block at a time. Old manifests keep
    # referring to immutable data while the next manifest is prepared.
    # Static hosts cap single files (Cloudflare Workers assets: 25 MiB). With
    # 16 MiB of raw bytes per chunk the gzip output stays below that cap even
    # for incompressible data, whatever the compression ratio.
    chunk_bytes = 16 * 1024 * 1024
    chunks = []
    for number, offset in enumerate(range(0, len(raw), chunk_bytes)):
        block = raw[offset:offset + chunk_bytes]
        digest = sha256(block)
        name = f"grmhd3d-{number:03d}-{digest[:12]}.f32.gz"
        temporary = output / (name + ".tmp")
        compressed = gzip.compress(block, compresslevel=6, mtime=0)
        temporary.write_bytes(compressed)
        temporary.replace(output / name)
        chunks.append({"file": name, "offset": offset, "bytes": len(block), "compressedBytes": len(compressed), "sha256": digest})
    metadata["chunks"] = chunks
    temporary_meta = output / "grmhd3d.json.tmp"
    temporary_meta.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    temporary_meta.replace(output / "grmhd3d.json")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="reuse this pinned Athena++ checkout")
    parser.add_argument("--input", type=Path, default=CONFIG, help="native physical/numerical parameter file")
    parser.add_argument("--run-directory", type=Path, default=ROOT / "verification/grmhd3d/run")
    parser.add_argument("--from-run", action="store_true", help="only package an existing native run")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/data")
    parser.add_argument("--time", type=float, default=400)
    parser.add_argument("--restart", type=Path, help="continue this full-precision native Athena++ restart")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--threads", type=int, default=1, help="OpenMP solver threads; uses multiple MeshBlocks")
    parser.add_argument("--openmp-prefix", type=Path, help="existing libomp prefix for Apple Clang")
    parser.add_argument("--max-frames", type=int, default=32, help="export the newest consecutive frames within the GPU layer budget")
    parser.add_argument("--flux", choices=["hlle", "hlld"], default="hlle")
    args = parser.parse_args()
    if not math.isfinite(args.time) or args.time <= 0 or args.jobs < 1 or args.threads < 1 or args.max_frames < 2:
        parser.error("time and job count must be positive")
    if args.from_run and args.source is None:
        parser.error("--from-run requires the source checkout for provenance validation")
    run = args.run_directory.resolve()
    run.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="interstellar-athena-") as temporary:
        source = args.source.resolve() if args.source else Path(temporary) / "athena"
        if args.source is None:
            subprocess.run(["git", "clone", "--no-checkout", REPOSITORY, str(source)], check=True)
            subprocess.run(["git", "checkout", "--detach", COMMIT], cwd=source, check=True)
        previous = run / "provenance.json"
        if args.from_run and not previous.exists():
            raise ValueError("An existing native run provenance manifest is required")
        recorded_source = json.loads(previous.read_text()) if args.from_run else None
        verify_source(source, include_eos=not args.from_run or bool(recorded_source.get("supplementalPatches")))
        configure = list(CONFIGURE)
        configure[configure.index("--flux=hlle")] = f"--flux={args.flux}"
        if args.threads > 1:
            configure.append("-omp")
            if sys.platform == "darwin":
                prefix = args.openmp_prefix or Path("/opt/homebrew/opt/libomp")
                if not (prefix / "include/omp.h").exists() or not (prefix / "lib/libomp.dylib").exists():
                    raise ValueError("An existing libomp prefix is required; use --openmp-prefix or --threads 1")
                configure[configure.index("--cxx=clang++")] = "--cxx=clang++-apple"
                configure.extend([f"--include={prefix / 'include'}", f"--lib_path={prefix / 'lib'}"])
        if not args.from_run:
            if any(run.glob("*.vtk")) and args.restart is None:
                raise ValueError("Run directory already has data; use --from-run or an explicit --restart")
            subprocess.run([sys.executable, "configure.py", *configure], cwd=source, check=True)
            # Athena's Makefile does not rebuild every object after a changed
            # Riemann-solver configuration. Mixing HLLE/HLLD objects leaves
            # solver-specific scratch arrays unallocated.
            subprocess.run(["make", "clean"], cwd=source, check=True)
            subprocess.run(["make", f"-j{args.jobs}"], cwd=source, check=True)
            shutil.copyfile(args.input, run / "athinput.torus")
        command = [str(source / "bin/athena"), "-i", str(run / "athinput.torus"), "-d", str(run), f"time/tlim={args.time}", f"mesh/num_threads={args.threads}"]
        if args.restart:
            command.extend(["-r", str(args.restart.resolve())])
        info = provenance(source, run, command if not args.from_run else None, configure, args.threads)
        stages_file = run / "prior-stages.json"
        if stages_file.exists():
            info["stages"] = json.loads(stages_file.read_text())
            info["stages"].append({"fromTime": info["stages"][-1]["toTime"], "toTime": args.time,
                                   "flux": args.flux.upper(), "reconstruction": read_parameters(run / "athinput.torus")["time"]["xorder"],
                                   "inputSha256": info["inputSha256"], "binarySha256": info["binarySha256"]})
        provenance_file = run / "provenance.json"
        if args.from_run and provenance_file.exists():
            recorded = json.loads(provenance_file.read_text())
            for key in ["commit", "patchSha256", "inputSha256", "binarySha256"]:
                if recorded[key] != info[key]:
                    raise ValueError(f"Native run provenance changed: {key}")
            if recorded.get("supplementalPatches", []) != info.get("supplementalPatches", []):
                raise ValueError("Native run supplemental patches changed")
            info = recorded
        else:
            provenance_file.write_text(json.dumps(info, indent=2) + "\n")
        if not args.from_run:
            with (run / ("restart.log" if args.restart else "run.log")).open("w") as log:
                subprocess.run(command, cwd=source, stdout=log, stderr=log, env={**os.environ, "OMP_NUM_THREADS": str(args.threads)}, check=True)
        metadata = pack(run, args.output.resolve(), info, minimum_time=args.time, max_frames=args.max_frames)
        print(json.dumps({key: metadata[key] for key in ["resolution", "timeRange", "bytes", "sha256", "maxDivB", "maxVelocityNormError"]}, indent=2))


if __name__ == "__main__":
    main()
