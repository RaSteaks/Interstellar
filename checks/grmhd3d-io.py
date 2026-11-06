"""Focused tests for native binary VTK boundaries and multi-block assembly."""

import math
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from grmhd3d_io import merge_vtk, read_vtk


def fixture(path, first_radius, time=0):
    # A deterministic transport fixture, not a simulated GRMHD state.
    result = bytearray(f"# vtk DataFile Version 2.0\n# Athena++ data at time={time} cycle=0\nBINARY\nDATASET RECTILINEAR_GRID\nDIMENSIONS 3 3 3\n".encode())
    for axis, values in zip("XYZ", [[first_radius, first_radius + 1, first_radius + 2], [.3, .6, .9], [0, math.pi, 2 * math.pi]]):
        result.extend(f"{axis}_COORDINATES 3 float\n".encode())
        result.extend(struct.pack(">3f", *values))
        result.extend(b"\n")
    values = [100 * k + 10 * j + first_radius + i for k in range(2) for j in range(2) for i in range(2)]
    result.extend(b"CELL_DATA 8\nSCALARS signal float\nLOOKUP_TABLE default\n")
    result.extend(struct.pack(">8f", *values))
    result.extend(b"\nVECTORS vector float\n")
    result.extend(struct.pack(">24f", *[component for value in values for component in [value, value + 1000, -value]]))
    result.extend(b"\n")
    path.write_bytes(result)


class NativeIO(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="interstellar-vtk-")
        self.root = Path(self.directory.name)
        self.left = self.root / "left.vtk"
        self.right = self.root / "right.vtk"
        fixture(self.left, 1)
        fixture(self.right, 3)

    def tearDown(self):
        self.directory.cleanup()

    def test_big_endian_scalar_and_vector(self):
        data = read_vtk(self.left)
        self.assertEqual(data["shape"], [2, 2, 2])
        self.assertEqual(list(data["fields"]["signal"]["data"]), [1, 2, 11, 12, 101, 102, 111, 112])
        self.assertEqual(list(data["fields"]["vector"]["data"][:6]), [1, 1001, -1, 2, 1002, -2])

    def test_merge_preserves_all_three_axes(self):
        data = merge_vtk([self.right, self.left])
        self.assertEqual(data["shape"], [4, 2, 2])
        self.assertEqual(list(data["fields"]["signal"]["data"]), [1, 2, 3, 4, 11, 12, 13, 14, 101, 102, 103, 104, 111, 112, 113, 114])
        self.assertEqual(data["fields"]["vector"]["data"][3 * 8 + 1], 1101)

    def test_missing_block_rejected(self):
        fixture(self.right, 4)
        with self.assertRaisesRegex(ValueError, "Missing"):
            merge_vtk([self.left, self.right])

    def test_overlap_rejected(self):
        with self.assertRaisesRegex(ValueError, "Overlapping"):
            merge_vtk([self.left, self.left])

    def test_mismatched_time_rejected(self):
        fixture(self.right, 3, time=2)
        with self.assertRaisesRegex(ValueError, "different times"):
            merge_vtk([self.left, self.right])

    def test_truncated_field_rejected(self):
        self.left.write_bytes(self.left.read_bytes()[:-8])
        with self.assertRaisesRegex(ValueError, "Truncated"):
            read_vtk(self.left)


if __name__ == "__main__":
    unittest.main()
