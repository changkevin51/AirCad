"""Wire-protocol serialization checks; no camera or browser involved."""

from __future__ import annotations

import json
import math
import unittest

from tracker import protocol


class ProtocolTests(unittest.TestCase):
    def test_status_and_thumb_messages(self) -> None:
        self.assertEqual(protocol.status_message("ready", "Camera ready"), {"type": "status", "camera": "ready", "message": "Camera ready"})
        thumb = protocol.thumb_message("abc=", 192, 144)
        self.assertEqual(thumb, {"type": "thumb", "jpeg": "abc=", "w": 192, "h": 144})

    def test_managed_metadata_is_optional_and_additive(self) -> None:
        managed = {"streamId": "s1", "sourceRunId": "r1", "config": {"source": "oak"}}
        status = protocol.status_message("ready", "Camera ready", managed=managed)
        self.assertEqual(status["camera"], "ready")
        self.assertEqual(status["managed"], managed)
        self.assertEqual(
            protocol.status_message("ready", "Camera ready"),
            {"type": "status", "camera": "ready", "message": "Camera ready"},
        )
        thumb = protocol.thumb_message("abc=", 192, 144, managed=managed)
        self.assertEqual(thumb["managed"], managed)
        target = protocol.keycap_message(None, 1, 640, 480, managed=managed)
        self.assertEqual(target["managed"], managed)
        self.assertNotIn("managed", protocol.keycap_message(None, 1, 640, 480))


def _sample(**overrides):
    values = {
        "t_ms": 1000.0,
        "sample_time_ms": 990.0,
        "age_ms": 10.0,
        "target": "keycap",
        "tracking_epoch": 3,
        "frame_w": 1280,
        "frame_h": 720,
        "pixel": (640.0, 360.0),
        "camera_mm": (10.0, 20.0, 500.0),
        "state": "tracked",
        "fresh": True,
        "reason": None,
        "valid_pixels": 120,
        "roi_count": 2,
        "spread_mm": 24.0,
        "pair_skew_ms": 4.0,
    }
    values.update(overrides)
    return type("Sample", (), values)()


class SpatialMessageTests(unittest.TestCase):
    def test_spatial_wire_shape(self) -> None:
        message = protocol.spatial_message(
            _sample(), stream_id="s1", source_run_id="r1", seq=7
        )
        self.assertEqual(
            message,
            {
                "type": "spatial",
                "v": 2,
                "streamId": "s1",
                "sourceRunId": "r1",
                "seq": 7,
                "t": 1000.0,
                "sampleTimeMs": 990.0,
                "ageMs": 10.0,
                "target": "keycap",
                "trackingEpoch": 3,
                "frame": {"w": 1280, "h": 720, "mirrored": True},
                "pixel": [640.0, 360.0],
                "cameraMm": [10.0, 20.0, 500.0],
                "state": "tracked",
                "fresh": True,
                "reason": None,
                "quality": {
                    "validPixels": 120,
                    "roiCount": 2,
                    "spreadMm": 24.0,
                    "pairSkewMs": 4.0,
                },
            },
        )
        json.dumps(message, allow_nan=False)

    def test_held_sample_keeps_old_xyz_without_fresh(self) -> None:
        message = protocol.spatial_message(
            _sample(state="held", fresh=False, reason="no_depth", pixel=None),
            stream_id="s1",
            source_run_id="r1",
            seq=8,
        )
        self.assertEqual(message["state"], "held")
        self.assertFalse(message["fresh"])
        self.assertEqual(message["cameraMm"], [10.0, 20.0, 500.0])
        self.assertIsNone(message["pixel"])

    def test_nonfinite_and_inconsistent_values_rejected(self) -> None:
        for overrides in (
            {"camera_mm": (math.nan, 0.0, 1.0)},
            {"t_ms": math.inf},
            {"t_ms": math.nan},
            {"t_ms": -5.0},
            {"t_ms": "1000"},
            {"t_ms": True},
            {"age_ms": -1.0},
            {"age_ms": "5"},
            {"sample_time_ms": -3.0},
            {"fresh": 1},
            {"fresh": "yes"},
            {"fresh": True, "state": "held"},
            {"state": "tracked", "fresh": False},
            {"state": "tracked", "camera_mm": None},
            {"state": "tracked", "sample_time_ms": None},
            {"state": "tracked", "age_ms": None},
            {"state": "held", "camera_mm": None},
            {"state": "held", "age_ms": None},
            {"state": "held", "sample_time_ms": None},
            {"state": "acquiring", "camera_mm": (1.0, 2.0, 3.0), "fresh": False, "sample_time_ms": None, "age_ms": None},
            {"state": "acquiring", "camera_mm": None, "fresh": False, "sample_time_ms": 10.0, "age_ms": None},
            {"state": "acquiring", "camera_mm": None, "fresh": False, "sample_time_ms": None, "age_ms": 3.0},
            {"state": "lost", "camera_mm": (1.0, 2.0, 3.0), "fresh": False, "sample_time_ms": None, "age_ms": None},
            {"state": "lost", "camera_mm": None, "fresh": True, "sample_time_ms": None, "age_ms": None},
            {"state": "bogus"},
            {"target": "bogus"},
            {"frame_w": 0},
            {"frame_w": 8193},
            {"frame_w": True},
            {"frame_w": 1.5},
            {"frame_h": -5},
            {"tracking_epoch": -1},
            {"tracking_epoch": 1.5},
            {"tracking_epoch": True},
            {"valid_pixels": -1},
            {"valid_pixels": True},
            {"roi_count": 1.5},
            {"spread_mm": -5.0},
            {"pair_skew_ms": -1.0},
            {"camera_mm": ("1", 2.0, 3.0)},
            {"camera_mm": (1.0, 2.0)},
            {"pixel": (-1.0, 360.0)},
            {"pixel": (1280.0, 360.0)},
            {"pixel": (640.0, 720.0)},
            {"pixel": (640.0,)},
            {"sample_time_ms": 1000.2},
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    protocol.spatial_message(
                        _sample(**overrides), stream_id="s", source_run_id="r", seq=1
                    )

    def test_ids_and_seq_validated(self) -> None:
        for kwargs in (
            {"stream_id": ""},
            {"stream_id": None},
            {"stream_id": 12},
            {"source_run_id": ""},
            {"source_run_id": None},
            {"seq": -1},
            {"seq": 1.5},
            {"seq": True},
            {"seq": "3"},
        ):
            with self.subTest(kwargs=kwargs):
                call = {"stream_id": "s", "source_run_id": "r", "seq": 1}
                call.update(kwargs)
                with self.assertRaises(ValueError):
                    protocol.spatial_message(_sample(), **call)

    def test_boundary_values_accepted(self) -> None:
        message = protocol.spatial_message(
            _sample(pixel=(1279.0, 719.0), sample_time_ms=1000.05, t_ms=1000.0),
            stream_id="s",
            source_run_id="r",
            seq=0,
        )
        self.assertEqual(message["pixel"], [1279.0, 719.0])
        self.assertEqual(message["seq"], 0)

    def test_lost_sample_nulls_point(self) -> None:
        message = protocol.spatial_message(
            _sample(
                state="lost",
                fresh=False,
                camera_mm=None,
                pixel=None,
                sample_time_ms=None,
                age_ms=None,
                reason="timeout",
            ),
            stream_id="s1",
            source_run_id="r1",
            seq=9,
        )
        self.assertIsNone(message["cameraMm"])
        self.assertIsNone(message["pixel"])
        self.assertIsNone(message["sampleTimeMs"])
        json.dumps(message, allow_nan=False)
