"""Bounded diagnostics logger tests; no hardware involved."""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

from tracker.diagnostics import TrackingDiagnostics


class TrackingDiagnosticsTests(unittest.TestCase):
    def test_disabled_is_noop_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "log.jsonl"
            logger = TrackingDiagnostics(path, enabled=False)
            logger.log("sample", state="tracked")
            logger.close()
            self.assertFalse(path.exists())
            self.assertEqual(logger.events, 0)

    def test_writes_sanitized_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "log.jsonl"
            logger = TrackingDiagnostics(path, max_bytes=10_000)
            logger.log(
                "sample",
                state="tracked",
                fresh=True,
                cameraMm=(1.0, math.nan, 500.0),
                ageMs=12.5,
                raw=None,
            )
            logger.log("transition", streamId="abc", nested={"x": math.inf})
            logger.close()
            lines = path.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 2)
            first = json.loads(lines[0])
            self.assertEqual(first["event"], "sample")
            self.assertEqual(first["cameraMm"], [1.0, None, 500.0])
            second = json.loads(lines[1])
            self.assertEqual(second["nested"], {"x": None})
            self.assertEqual(logger.events, 2)
            self.assertEqual(logger.io_errors, 0)

    def test_rotation_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "log.jsonl"
            logger = TrackingDiagnostics(path, max_bytes=400, backups=2)
            for index in range(200):
                logger.log("sample", index=index, blob="x" * 40)
            logger.close()
            rotated = sorted(Path(tmp).glob("log.jsonl*"))
            self.assertLessEqual(len(rotated), 3)
            for entry in rotated:
                self.assertLessEqual(entry.stat().st_size, 400 + 200)

    def test_io_failure_is_contained(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "blocker"
            blocker.write_text("not a directory")
            logger = TrackingDiagnostics(blocker / "sub" / "log.jsonl")
            self.assertGreaterEqual(logger.io_errors, 1)
            logger.log("sample", state="tracked")
            logger.close()

    def test_failed_emit_increments_io_errors(self) -> None:
        class BrokenStream:
            def __getattr__(self, name):
                def method(*args, **kwargs):
                    raise OSError("disk full")

                return method

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "log.jsonl"
            logger = TrackingDiagnostics(path)
            handler = logger._logger.handlers[0]
            handler.stream.close()
            handler.stream = BrokenStream()
            logger.log("sample", state="tracked")
            self.assertGreaterEqual(logger.io_errors, 1)
            before = logger.io_errors
            logger.log("sample", state="tracked")
            self.assertGreater(logger.io_errors, before)
            logger.close()

    def test_close_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logger = TrackingDiagnostics(Path(tmp) / "log.jsonl")
            logger.log("sample")
            logger.close()
            logger.close()
            logger.log("sample")


if __name__ == "__main__":
    unittest.main()
