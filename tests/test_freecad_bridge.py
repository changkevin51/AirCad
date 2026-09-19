"""Boundary checks for the sketch-to-FreeCAD bridge."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import freecad_bridge


LINE = {"type": "line", "points": [[0, 0, 0], [4000, 0, 0]]}
RECT = {"type": "rect", "points": [[0, 0, 0], [4000, 0, 0], [4000, 0, 2500], [0, 0, 2500]]}


class FreeCADBridgeTests(unittest.TestCase):
    def _isolated_paths(self):
        temporary_directory = tempfile.TemporaryDirectory()
        root = Path(temporary_directory.name)
        patches = mock.patch.multiple(
            freecad_bridge,
            PROJECT_ROOT=root,
            RUNTIME_DIR=root / ".runtime",
            SNAPSHOT_PATH=root / ".runtime" / "freecad_drawing.json",
            FREECAD_IMPORT_SCRIPT=root / "freecad_import.py",
        )
        return temporary_directory, patches

    def test_send_writes_versioned_mm_snapshot_and_returns_latest_path(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            Path(temporary_directory.name, "freecad_import.py").write_text("", encoding="utf-8")
            launched: list[Path] = []
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad", launched.append):
                returned = freecad_bridge.send_to_freecad([LINE, {"type": "rect", "points": [(0, 0), (1.5, 0), (1.5, 2), (0, 2)], "id": "e7"}])

            expected = Path(temporary_directory.name, ".runtime", "freecad_drawing.json")
            self.assertEqual(returned, expected)
            self.assertEqual(
                json.loads(returned.read_text(encoding="utf-8")),
                {
                    "version": 2,
                    "units": "mm",
                    "entities": [
                        {"type": "line", "points": [[0, 0, 0], [4000, 0, 0]]},
                        {"type": "rect", "points": [[0, 0, 0], [1.5, 0, 0], [1.5, 2, 0], [0, 2, 0]], "id": "e7"},
                    ],
                },
            )
            self.assertEqual(len(launched), 1)
            self.assertNotEqual(launched[0], returned)
            self.assertEqual(json.loads(launched[0].read_text()), json.loads(returned.read_text()))
        finally:
            temporary_directory.cleanup()

    def test_rapid_sends_keep_distinct_child_snapshots(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            Path(temporary_directory.name, "freecad_import.py").write_text("", encoding="utf-8")
            child_snapshots: list[Path] = []
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad", child_snapshots.append):
                freecad_bridge.send_to_freecad([LINE])
                freecad_bridge.send_to_freecad([RECT])

            self.assertEqual(len(child_snapshots), 2)
            self.assertNotEqual(child_snapshots[0], child_snapshots[1])
            self.assertEqual(json.loads(child_snapshots[0].read_text())["entities"][0]["type"], "line")
            self.assertEqual(json.loads(child_snapshots[1].read_text())["entities"][0]["type"], "rect")
            latest = Path(temporary_directory.name, ".runtime", "freecad_drawing.json")
            self.assertEqual(json.loads(latest.read_text())["entities"][0]["type"], "rect")
        finally:
            temporary_directory.cleanup()

    def test_invalid_entities_raise_value_error_before_launch(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            bad_inputs = [
                [],
                [{"type": "line", "points": [[float("nan"), 1, 0], [0, 0, 0]]}],
                [{"type": "line", "points": [[0, 0, 0]]}],
                [{"type": "rect", "points": [[0, 0, 0], [1, 0, 0], [1, 1, 0]]}],
                [{"type": "circle", "points": [[0, 0, 0], [1, 0, 0]]}],
                [{"type": "line", "points": [[0, 0, 0, 0], [1, 0, 0]]}],
                [{"type": "line", "points": [[True, 0, 0], [1, 0, 0]]}],
                ["not a mapping"],
            ]
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad") as launch:
                for bad in bad_inputs:
                    with self.subTest(bad=bad):
                        with self.assertRaises(ValueError):
                            freecad_bridge.send_to_freecad(bad)
            launch.assert_not_called()
        finally:
            temporary_directory.cleanup()

    def test_normalize_entity_pads_2d_points_and_keeps_floats(self) -> None:
        self.assertEqual(
            freecad_bridge.normalize_entity({"type": "POLYLINE", "points": [(1, 2), (3.25, 4, 5)]}),
            {"type": "polyline", "points": [[1, 2, 0], [3.25, 4, 5]]},
        )

    def test_windows_candidates_include_program_files_install(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        try:
            exe = Path(temporary_directory.name) / "FreeCAD 1.0" / "bin" / "FreeCAD.exe"
            exe.parent.mkdir(parents=True)
            exe.write_bytes(b"")
            with (
                mock.patch.object(freecad_bridge.os, "name", "nt"),
                mock.patch.object(freecad_bridge, "sys_platform_is_macos", return_value=False),
                mock.patch.object(freecad_bridge, "_windows_search_roots", return_value=(Path(temporary_directory.name),)),
            ):
                candidates = freecad_bridge._freecad_candidates()
            self.assertIn(exe, candidates)
            self.assertIn("FreeCAD.exe", candidates)
        finally:
            temporary_directory.cleanup()

    def test_windows_path_override_does_not_require_unix_execute_bit(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        try:
            exe = Path(temporary_directory.name) / "FreeCAD.exe"
            exe.write_bytes(b"")
            with mock.patch.object(freecad_bridge.os, "name", "nt"):
                resolved = freecad_bridge._resolve_executable(str(exe))
            self.assertEqual(resolved, exe)
        finally:
            temporary_directory.cleanup()

    def test_missing_freecad_is_reported_as_os_error(self) -> None:
        with mock.patch.dict(
            freecad_bridge.os.environ,
            {freecad_bridge.FREECAD_EXECUTABLE_ENV: "/path/that/does/not/exist"},
            clear=False,
        ):
            with self.assertRaises(OSError):
                freecad_bridge._find_freecad()

    def test_launch_is_async_and_passes_snapshot_to_child_environment(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            importer = Path(temporary_directory.name, "freecad_import.py")
            importer.write_text("", encoding="utf-8")
            snapshot = Path(temporary_directory.name, "snapshot.json")
            snapshot.write_text('{"version": 2, "units": "mm", "entities": []}', encoding="utf-8")
            with (
                patches,
                mock.patch.object(freecad_bridge, "_find_freecad", return_value="FreeCAD"),
                mock.patch.object(freecad_bridge.subprocess, "Popen") as popen,
            ):
                freecad_bridge._launch_freecad(snapshot)

            args, kwargs = popen.call_args
            command = args[0]
            self.assertEqual(command[:2], ["FreeCAD", "--single-instance"])
            macro = Path(command[2])
            self.assertEqual(macro.suffix, ".FCMacro")
            macro_source = macro.read_text(encoding="utf-8")
            self.assertIn(repr(str(importer)), macro_source)
            self.assertIn(repr(str(snapshot)), macro_source)
            self.assertIn("_module.main(_snapshot)", macro_source)
            self.assertEqual(kwargs["env"][freecad_bridge.SNAPSHOT_ENV], str(snapshot))
            self.assertTrue(kwargs["start_new_session"])
            self.assertIs(kwargs["stdin"], freecad_bridge.subprocess.DEVNULL)
        finally:
            temporary_directory.cleanup()


    def test_spatial_xyz_endpoints_are_preserved_exactly(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            Path(temporary_directory.name, "freecad_import.py").write_text("", encoding="utf-8")
            spatial = {"type": "line", "points": [[12, 34, 56], [78, 90, 123]]}
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad"):
                returned = freecad_bridge.send_to_freecad([spatial])
            payload = json.loads(returned.read_text(encoding="utf-8"))
            self.assertEqual(payload["entities"][0]["points"], [[12, 34, 56], [78, 90, 123]])
        finally:
            temporary_directory.cleanup()


if __name__ == "__main__":
    unittest.main()
