"""Boundary checks for the camera-to-FreeCAD bridge."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import freecad_bridge


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

    def test_send_writes_project_relative_json_and_returns_latest_path(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            Path(temporary_directory.name, "freecad_import.py").write_text("", encoding="utf-8")
            launched: list[tuple[list[str], dict[str, str]]] = []

            def fake_launch(snapshot: Path) -> None:
                launched.append(([], {freecad_bridge.SNAPSHOT_ENV: str(snapshot)}))

            with patches, mock.patch.object(freecad_bridge, "_launch_freecad", fake_launch):
                returned = freecad_bridge.send_to_freecad(
                    (iter(((100, 100), (110.5, 105.0))),)
                )

            expected = Path(temporary_directory.name, ".runtime", "freecad_drawing.json")
            self.assertEqual(returned, expected)
            self.assertEqual(
                json.loads(returned.read_text(encoding="utf-8")),
                {"strokes": [[[100, 100], [110.5, 105.0]]]},
            )
            self.assertEqual(len(launched), 1)
            child_snapshot = Path(launched[0][1][freecad_bridge.SNAPSHOT_ENV])
            self.assertNotEqual(child_snapshot, returned)
            self.assertEqual(
                json.loads(child_snapshot.read_text()),
                json.loads(returned.read_text()),
            )
        finally:
            temporary_directory.cleanup()

    def test_rapid_sends_keep_distinct_child_snapshots(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            Path(temporary_directory.name, "freecad_import.py").write_text("", encoding="utf-8")
            child_snapshots: list[Path] = []
            with patches, mock.patch.object(
                freecad_bridge,
                "_launch_freecad",
                lambda snapshot: child_snapshots.append(snapshot),
            ):
                freecad_bridge.send_to_freecad([[(1, 2)]])
                freecad_bridge.send_to_freecad([[(9, 8)]])

            self.assertEqual(len(child_snapshots), 2)
            self.assertNotEqual(child_snapshots[0], child_snapshots[1])
            self.assertEqual(
                json.loads(child_snapshots[0].read_text(encoding="utf-8")),
                {"strokes": [[[1, 2]]]},
            )
            self.assertEqual(
                json.loads(child_snapshots[1].read_text(encoding="utf-8")),
                {"strokes": [[[9, 8]]]},
            )
            self.assertEqual(
                json.loads(
                    Path(temporary_directory.name, ".runtime", "freecad_drawing.json")
                    .read_text(encoding="utf-8")
                ),
                {"strokes": [[[9, 8]]]},
            )
        finally:
            temporary_directory.cleanup()

    def test_bad_points_raise_value_error_before_launch(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad") as launch:
                with self.assertRaises(ValueError):
                    freecad_bridge.send_to_freecad([[(float("nan"), 1)]])
            launch.assert_not_called()
        finally:
            temporary_directory.cleanup()

    def test_empty_strokes_raise_value_error_before_launch(self) -> None:
        temporary_directory, patches = self._isolated_paths()
        try:
            with patches, mock.patch.object(freecad_bridge, "_launch_freecad") as launch:
                with self.assertRaises(ValueError):
                    freecad_bridge.send_to_freecad([])
            launch.assert_not_called()
        finally:
            temporary_directory.cleanup()

    def test_windows_candidates_include_program_files_install(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        try:
            exe = (
                Path(temporary_directory.name)
                / "FreeCAD 1.0"
                / "bin"
                / "FreeCAD.exe"
            )
            exe.parent.mkdir(parents=True)
            exe.write_bytes(b"")
            with (
                mock.patch.object(freecad_bridge.os, "name", "nt"),
                mock.patch.object(
                    freecad_bridge, "sys_platform_is_macos", return_value=False
                ),
                mock.patch.object(
                    freecad_bridge,
                    "_windows_search_roots",
                    return_value=(Path(temporary_directory.name),),
                ),
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
            snapshot.write_text('{"strokes": [[[1, 2]]]}', encoding="utf-8")
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
            self.assertIn("spec_from_file_location('_aircad_freecad_import', _importer)", macro_source)
            self.assertEqual(kwargs["env"][freecad_bridge.SNAPSHOT_ENV], str(snapshot))
            self.assertTrue(kwargs["start_new_session"])
            self.assertIs(kwargs["stdin"], freecad_bridge.subprocess.DEVNULL)
        finally:
            temporary_directory.cleanup()


if __name__ == "__main__":
    unittest.main()
