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
