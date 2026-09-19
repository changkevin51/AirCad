"""JSON wire protocol between the Python tracker and the browser UI.

Messages (server -> browser, all JSON text frames):

``{"type": "hands", "t": ms, "frame": {"w", "h"}, "hands": [...], "nav": {...}|null}``
    Sent for every camera frame (about 30 fps).  Each hand carries
    ``id, handedness, tip [x, y, z?], palm [x, y], pinching, open, openArmed,
    landmarks [[x, y] * 21]`` in mirrored camera-frame pixels.  ``tip`` may
    grow a third ``z`` component for depth cameras without a protocol change.

``{"type": "thumb", "jpeg": base64, "w", "h"}``
    Small camera preview for the picture-in-picture, about 12 fps.

``{"type": "status", "camera": state, "message": text}``
    Camera lifecycle: ``starting``, ``ready``, ``error``, ``stopped`` or
    ``disabled`` (``--no-camera``).
"""

from __future__ import annotations

import math
from typing import Any, Optional, Sequence

from gesture_engine import GestureFrame, HandObservation, NavigationDelta, TrackedHand


PROTOCOL_VERSION = 1


def _round_point(point: Sequence[float], digits: int = 1) -> list[float]:
    return [round(float(point[0]), digits), round(float(point[1]), digits)]


def _nearest_observation(
    hand: TrackedHand,
    observations: Sequence[HandObservation],
) -> Optional[HandObservation]:
    """Pair a smoothed track with the raw observation it most likely came from."""

    best: Optional[HandObservation] = None
    best_distance = math.inf
    for observation in observations:
        distance = math.hypot(
            observation.palm_center[0] - hand.palm_center[0],
            observation.palm_center[1] - hand.palm_center[1],
        )
        if distance < best_distance:
            best = observation
            best_distance = distance
    if best is None or best_distance > max(60.0, 2.0 * hand.palm_size):
        return None
    return best


def hand_payload(
    hand: TrackedHand,
    observation: Optional[HandObservation] = None,
) -> dict[str, Any]:
    return {
        "id": int(hand.hand_id),
        "handedness": hand.handedness,
        "tip": _round_point(hand.index_tip),
        "thumb": _round_point(hand.thumb_tip),
        "palm": _round_point(hand.palm_center),
        "palmSize": round(float(hand.palm_size), 1),
        "pinching": bool(hand.pinching),
        "open": bool(hand.open_palm),
        "openArmed": bool(hand.open_armed),
        "landmarks": (
            [_round_point(point) for point in observation.landmarks]
            if observation is not None
            else []
        ),
    }


def navigation_payload(navigation: Optional[NavigationDelta]) -> Optional[dict[str, Any]]:
    if navigation is None:
        return None
    return {
        "mode": navigation.mode,
        "pan": [round(navigation.pan_delta[0], 2), round(navigation.pan_delta[1], 2)],
        "zoom": round(float(navigation.zoom_factor), 4),
        "rotation": round(float(navigation.rotation_delta), 4),
    }


def hands_message(
    frame: GestureFrame,
    width: int,
    height: int,
    observations: Sequence[HandObservation] = (),
) -> dict[str, Any]:
    """Build the per-frame ``hands`` message from an engine frame."""

    return {
        "type": "hands",
        "v": PROTOCOL_VERSION,
        "t": round(float(frame.timestamp_ms), 1),
        "frame": {"w": int(width), "h": int(height)},
        "hands": [
            hand_payload(hand, _nearest_observation(hand, observations))
            for hand in frame.hands
        ],
        "nav": navigation_payload(frame.navigation),
        "drawing": bool(frame.any_drawing),
    }


def thumb_message(jpeg_base64: str, width: int, height: int) -> dict[str, Any]:
    return {"type": "thumb", "jpeg": jpeg_base64, "w": int(width), "h": int(height)}


def status_message(camera_state: str, message: str = "") -> dict[str, Any]:
    return {"type": "status", "camera": str(camera_state), "message": str(message)}


__all__ = [
    "PROTOCOL_VERSION",
    "hand_payload",
    "hands_message",
    "navigation_payload",
    "status_message",
    "thumb_message",
]
