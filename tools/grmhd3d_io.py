"""Read the native Athena++ binary VTK snapshots without a third-party runtime."""

import array
import io
import math
import re
import sys
from pathlib import Path


def read_parameters(path):
    """Read the native input actually used for a run, not assumed defaults."""
    result = {}
    section = None
    for raw in Path(path).read_text().splitlines():
        text = raw.split("#", 1)[0].strip()
        if text.startswith("<") and text.endswith(">"):
            section = text[1:-1]
            result.setdefault(section, {})
        elif section and "=" in text:
            key, value = text.split("=", 1)
            result[section][key.strip()] = value.strip()
    return result


def read_vtk(path):
    """Return cell fields and their actual coordinate faces in native array order.

    Athena VTK is big endian and stores cells as [phi][theta][radius]. Vector
    components are interleaved. Keep these conventions explicit at this boundary;
    the website's texture packing uses a different order.
    """
    stream = io.BytesIO(Path(path).read_bytes())

    def line():
        raw = stream.readline()
        while raw in (b"\n", b"\r\n"):
            raw = stream.readline()
        return raw.decode("ascii").strip()

    def floats(count):
        raw = stream.read(count * 4)
        if len(raw) != count * 4:
            raise ValueError(f"Truncated VTK field: {path}")
        result = array.array("f")
        result.frombytes(raw)
        if sys.byteorder == "little":
            result.byteswap()
        return result

    if not line().startswith("# vtk DataFile Version"):
        raise ValueError(f"Not an Athena VTK snapshot: {path}")
    header = line()
    match = re.search(r"time=([^\s]+)", header)
    if match is None or not math.isfinite(float(match[1])):
        raise ValueError(f"Missing finite VTK time: {path}")
    time = float(match[1])
    if line() != "BINARY" or line() != "DATASET RECTILINEAR_GRID":
        raise ValueError(f"Unsupported VTK encoding: {path}")
    dimensions = line().split()
    if len(dimensions) != 4 or dimensions[0] != "DIMENSIONS":
        raise ValueError(f"Missing VTK dimensions: {path}")
    sizes = [int(value) for value in dimensions[1:]]
    if any(size < 2 for size in sizes):
        raise ValueError("GRMHD3D requires more than one cell in every direction")
    faces = []
    for axis, size in zip("XYZ", sizes):
        if line().split() != [f"{axis}_COORDINATES", str(size), "float"]:
            raise ValueError(f"Invalid VTK coordinate array: {path}")
        coordinates = floats(size)
        if not all(math.isfinite(value) for value in coordinates) or any(
            right <= left for left, right in zip(coordinates, coordinates[1:])
        ):
            raise ValueError(f"Nonmonotone VTK coordinates: {path}")
        faces.append(coordinates)
    shape = [size - 1 for size in sizes]
    cells = math.prod(shape)
    if line().split() != ["CELL_DATA", str(cells)]:
        raise ValueError(f"VTK cell count does not match dimensions: {path}")
    fields = {}
    while declaration := line():
        words = declaration.split()
        if len(words) < 3 or words[2] != "float" or words[0] not in ("SCALARS", "VECTORS"):
            raise ValueError(f"Unsupported VTK field: {declaration}")
        components = 3 if words[0] == "VECTORS" else int(words[3]) if len(words) == 4 else 1
        if words[0] == "SCALARS" and line() != "LOOKUP_TABLE default":
            raise ValueError(f"Invalid VTK scalar lookup table: {path}")
        if words[1] in fields:
            raise ValueError(f"Duplicate VTK field: {words[1]}")
        fields[words[1]] = {"components": components, "data": floats(cells * components)}
    return {"time": time, "shape": shape, "faces": faces, "fields": fields}


def merge_vtk(paths):
    """Assemble non-overlapping native MeshBlocks without averaging any axis."""
    blocks = [read_vtk(path) for path in paths]
    if not blocks:
        raise ValueError("No native MeshBlocks were supplied")
    first = blocks[0]
    if len(blocks) == 1:
        return first
    axes = [sorted({value for block in blocks for value in block["faces"][axis]}) for axis in range(3)]
    indices = [{value: i for i, value in enumerate(axis)} for axis in axes]
    shape = [len(axis) - 1 for axis in axes]
    nr, nt, np = shape
    cells = nr * nt * np
    fields = {name: {"components": field["components"], "data": array.array("f", [0]) * (cells * field["components"])} for name, field in first["fields"].items()}
    covered = bytearray(cells)
    for block in blocks:
        if block["time"] != first["time"] or block["fields"].keys() != fields.keys():
            raise ValueError("Native blocks have different times or field layouts")
        offsets = [indices[axis][block["faces"][axis][0]] for axis in range(3)]
        for axis in range(3):
            if any(value != axes[axis][offsets[axis] + i] for i, value in enumerate(block["faces"][axis])):
                raise ValueError("Overlapping/refined blocks require a different export policy")
        nx, ny, nz = block["shape"]
        for k in range(nz):
            for j in range(ny):
                start = ((offsets[2] + k) * nt + offsets[1] + j) * nr + offsets[0]
                if any(covered[start:start + nx]):
                    raise ValueError("Overlapping native cells")
                covered[start:start + nx] = b"\1" * nx
                original = (k * ny + j) * nx
                for name, field in fields.items():
                    count = field["components"]
                    if block["fields"][name]["components"] != count:
                        raise ValueError("Inconsistent native vector layout")
                    field["data"][start * count:(start + nx) * count] = block["fields"][name]["data"][original * count:(original + nx) * count]
    if not all(covered):
        raise ValueError("Missing native MeshBlocks")
    return {"time": first["time"], "shape": shape, "faces": [array.array("f", axis) for axis in axes], "fields": fields}
