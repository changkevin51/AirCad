"""Wire-protocol serialization checks; no camera or browser involved."""

from __future__ import annotations

import json
import math
import unittest

from gesture_engine import GestureEngine, HandObservation
from tracker import protocol
from tracker.camera import count_extended_fingers, landmarks_to_observation


def _observation(center, *, pinched=False, label="right", open_fingers=0):
    x, y = center
    thumb = (x + 3.0, y) if pinched else (x - 52.0, y + 38.0)
    return HandObservation(
        index_tip=(x, y),
        thumb_tip=thumb,
        palm_center=(x, y + 60.0),
        palm_size=60.0,
        handedness=label,
        open_palm=open_fingers >= 4,
        open_finger_count=open_fingers,
        landmarks=tuple((x + i, y + i) for i in range(21)),
    )


class ProtocolTests(unittest.TestCase):
    def test_hands_message_is_json_serialisable_and_mirrors_engine_state(self) -> None:
        engine = GestureEngine()
        observation = _observation((320.0, 240.0))
        frame = engine.update([observation], timestamp_ms=1000.0)
        message = protocol.hands_message(frame, 640, 480, [observation])

        encoded = json.dumps(message)
        decoded = json.loads(encoded)
        self.assertEqual(decoded["type"], "hands")
        self.assertEqual(decoded["frame"], {"w": 640, "h": 480})
        self.assertEqual(len(decoded["hands"]), 1)
        hand = decoded["hands"][0]
        self.assertEqual(hand["id"], 1)
        self.assertEqual(hand["handedness"], "right")
        self.assertEqual(hand["tip"], [320.0, 240.0])
        self.assertEqual(hand["palm"], [320.0, 300.0])
        self.assertFalse(hand["pinching"])
        self.assertFalse(hand["open"])
        self.assertFalse(hand["openArmed"])
        self.assertEqual(len(hand["landmarks"]), 21)
        self.assertIsNone(decoded["nav"])
        self.assertFalse(decoded["drawing"])

    def test_pinch_flag_follows_debounced_engine_state(self) -> None:
        engine = GestureEngine()
        pinched = _observation((100.0, 100.0), pinched=True)
        engine.update([pinched], timestamp_ms=0.0)
        frame = engine.update([pinched], timestamp_ms=100.0)
        message = protocol.hands_message(frame, 640, 480, [pinched])
        self.assertTrue(message["hands"][0]["pinching"])
        self.assertTrue(message["drawing"])

    def test_landmarks_are_omitted_when_no_observation_matches(self) -> None:
        engine = GestureEngine()
        observation = _observation((200.0, 200.0))
        frame = engine.update([observation], timestamp_ms=0.0)
        far_away = _observation((600.0, 400.0))
        message = protocol.hands_message(frame, 640, 480, [far_away])
        self.assertEqual(message["hands"][0]["landmarks"], [])

    def test_navigation_payload_rounds_values(self) -> None:
        from gesture_engine import NavigationDelta

        payload = protocol.navigation_payload(NavigationDelta(mode="two", pan_delta=(1.23456, -2.0), zoom_factor=1.05, rotation_delta=0.1))
        self.assertEqual(payload, {"mode": "two", "pan": [1.23, -2.0], "zoom": 1.05, "rotation": 0.1})
        self.assertIsNone(protocol.navigation_payload(None))

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
        engine = GestureEngine()
        frame = engine.update([_observation((320.0, 240.0))], timestamp_ms=1.0)
        hands = protocol.hands_message(frame, 640, 480, managed=managed)
        self.assertEqual(hands["managed"], managed)
        self.assertNotIn(
            "managed",
            protocol.hands_message(frame, 640, 480),
        )


def _sample(**overrides):
    values = {
        "t_ms": 1000.0,
        "sample_time_ms": 990.0,
        "age_ms": 10.0,
        "target": "finger",
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
                "target": "finger",
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


class LandmarkConversionTests(unittest.TestCase):
    def test_landmarks_to_observation_uses_pixel_space(self) -> None:
        class Landmark:
            def __init__(self, x, y):
                self.x = x
                self.y = y

        points = [(0.5 + 0.01 * i, 0.5 + 0.005 * i) for i in range(21)]
        observation = landmarks_to_observation([Landmark(x, y) for x, y in points], "Left", 640, 480)
        self.assertEqual(observation.handedness, "left")
        self.assertAlmostEqual(observation.index_tip[0], (0.5 + 0.08) * 640, places=6)
        self.assertAlmostEqual(observation.index_tip[1], (0.5 + 0.04) * 480, places=6)
        self.assertGreater(observation.palm_size, 1.0)
        self.assertEqual(len(observation.landmarks), 21)
        with self.assertRaises(ValueError):
            landmarks_to_observation([Landmark(math.nan, 0.5)] * 21, None, 640, 480)

    def test_extended_finger_count_requires_full_hand(self) -> None:
        self.assertEqual(count_extended_fingers(tuple((0.0, 0.0) for _ in range(5)), 50.0), 0)


if __name__ == "__main__":
    unittest.main()
