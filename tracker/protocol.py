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

``{"type": "spatial", "v": 2, ...}``
    One complete depth-tracking state per camera sample (about 30 fps).
    ``cameraMm`` is calibrated unmirrored camera X-right/Y-up/Z-forward
    millimetres; ``pixel`` and thumbnails are mirrored for display.  See
    ``spatial_message`` for the full field list.

Managed hands/thumb/status messages may carry an optional ``managed``
metadata object (``streamId``, ``sourceRunId``, ``config``); helpers emit
the legacy shape unchanged when no metadata is supplied.
"""

from __future__ import annotations

import math
import numbers
from typing import Any, Mapping, Optional, Sequence

from gesture_engine import GestureFrame, HandObservation, NavigationDelta, TrackedHand


PROTOCOL_VERSION = 1
SPATIAL_VERSION = 2
SPATIAL_TARGETS = ("finger", "color")
SPATIAL_STATES = ("acquiring", "tracked", "held", "lost")


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
    managed: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Build the per-frame ``hands`` message from an engine frame."""

    message = {
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
    if managed is not None:
        message["managed"] = dict(managed)
    return message


def thumb_message(
    jpeg_base64: str,
    width: int,
    height: int,
    managed: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    message = {"type": "thumb", "jpeg": jpeg_base64, "w": int(width), "h": int(height)}
    if managed is not None:
        message["managed"] = dict(managed)
    return message


def status_message(
    camera_state: str,
    message: str = "",
    managed: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    payload = {"type": "status", "camera": str(camera_state), "message": str(message)}
    if managed is not None:
        payload["managed"] = dict(managed)
    return payload


def _finite_number(value: Any, field: str) -> float:
    """Accept only real numbers; reject bools, strings, NaN and Infinity."""

    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise ValueError("{} must be a finite number".format(field))
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("{} must be finite".format(field))
    return number


def _integer(value: Any, field: str, *, minimum: int = 0, maximum: Optional[int] = None) -> int:
    if isinstance(value, bool) or not isinstance(value, numbers.Integral):
        raise ValueError("{} must be an integer".format(field))
    number = int(value)
    if number < minimum or (maximum is not None and number > maximum):
        raise ValueError("{} is out of range".format(field))
    return number


def _nonempty_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("{} must be a non-empty string".format(field))
    return value


def _optional_ms(value: Any, field: str, *, minimum: Optional[float] = None) -> Optional[float]:
    if value is None:
        return None
    number = _finite_number(value, field)
    if minimum is not None and number < minimum:
        raise ValueError("{} must be at least {}".format(field, minimum))
    return round(number, 1)


def spatial_message(
    sample: Any,
    *,
    stream_id: str,
    source_run_id: Optional[str],
    seq: int,
) -> dict[str, Any]:
    """Serialize one :class:`SpatialSample`-shaped observation.

    ``sample`` is duck-typed: it needs ``t_ms``, ``sample_time_ms``,
    ``age_ms``, ``target``, ``tracking_epoch``, ``frame_w``, ``frame_h``,
    ``pixel``, ``camera_mm``, ``state``, ``fresh``, ``reason``,
    ``valid_pixels``, ``roi_count``, ``spread_mm`` and ``pair_skew_ms``.
    Non-finite or state-inconsistent values raise instead of reaching the
    wire.  ``ageMs`` is not freshness-checked here: a trusted point keeps
    ageing between emit and receipt, which downstream consumers handle.
    """

    stream_id = _nonempty_id(stream_id, "streamId")
    source_run_id = _nonempty_id(source_run_id, "sourceRunId")
    seq = _integer(seq, "seq", minimum=0)
    target = sample.target
    if not isinstance(target, str) or target not in SPATIAL_TARGETS:
        raise ValueError("unknown spatial target {!r}".format(sample.target))
    state = sample.state
    if not isinstance(state, str) or state not in SPATIAL_STATES:
        raise ValueError("unknown spatial state {!r}".format(sample.state))
    if not isinstance(sample.fresh, bool):
        raise ValueError("fresh must be a boolean")
    fresh = sample.fresh

    t_ms = _finite_number(sample.t_ms, "t")
    if t_ms < 0.0:
        raise ValueError("t must be nonnegative")
    sample_time = _optional_ms(sample.sample_time_ms, "sampleTimeMs", minimum=0.0)
    if sample_time is not None and sample_time - t_ms > 0.1:
        raise ValueError("sampleTimeMs must not exceed t")
    age = _optional_ms(sample.age_ms, "ageMs", minimum=0.0)
    frame_w = _integer(sample.frame_w, "frame.w", minimum=1, maximum=8192)
    frame_h = _integer(sample.frame_h, "frame.h", minimum=1, maximum=8192)

    camera_mm = None
    if sample.camera_mm is not None:
        if len(sample.camera_mm) != 3:
            raise ValueError("cameraMm must contain three values")
        camera_mm = [
            round(_finite_number(sample.camera_mm[0], "cameraMm.x"), 1),
            round(_finite_number(sample.camera_mm[1], "cameraMm.y"), 1),
            round(_finite_number(sample.camera_mm[2], "cameraMm.z"), 1),
        ]

    if state == "tracked":
        if not fresh or camera_mm is None or sample_time is None or age is None:
            raise ValueError("tracked samples require a fresh point, time and age")
    elif state == "held":
        if fresh or camera_mm is None or sample_time is None or age is None:
            raise ValueError("held samples require the last trusted point, time and age")
    else:
        if fresh or camera_mm is not None or sample_time is not None or age is not None:
            raise ValueError("{} samples must not carry a point".format(state))

    pixel = None
    if sample.pixel is not None:
        if len(sample.pixel) != 2:
            raise ValueError("pixel must contain two values")
        pixel_x = _finite_number(sample.pixel[0], "pixel.x")
        pixel_y = _finite_number(sample.pixel[1], "pixel.y")
        if not (0.0 <= pixel_x <= frame_w - 1 and 0.0 <= pixel_y <= frame_h - 1):
            raise ValueError("pixel must lie inside the frame")
        pixel = [round(pixel_x, 1), round(pixel_y, 1)]

    reason = sample.reason
    if reason is not None:
        reason = str(reason)

    return {
        "type": "spatial",
        "v": SPATIAL_VERSION,
        "streamId": stream_id,
        "sourceRunId": source_run_id,
        "seq": seq,
        "t": round(t_ms, 1),
        "sampleTimeMs": sample_time,
        "ageMs": age,
        "target": target,
        "trackingEpoch": _integer(sample.tracking_epoch, "trackingEpoch", minimum=0),
        "frame": {
            "w": frame_w,
            "h": frame_h,
            "mirrored": True,
        },
        "pixel": pixel,
        "cameraMm": camera_mm,
        "state": state,
        "fresh": fresh,
        "reason": reason,
        "quality": {
            "validPixels": _integer(sample.valid_pixels, "validPixels", minimum=0),
            "roiCount": _integer(sample.roi_count, "roiCount", minimum=0),
            "spreadMm": _optional_ms(sample.spread_mm, "spreadMm", minimum=0.0),
            "pairSkewMs": _optional_ms(sample.pair_skew_ms, "pairSkewMs", minimum=0.0),
        },
    }


__all__ = [
    "PROTOCOL_VERSION",
    "SPATIAL_STATES",
    "SPATIAL_TARGETS",
    "SPATIAL_VERSION",
    "hand_payload",
    "hands_message",
    "navigation_payload",
    "spatial_message",
    "status_message",
    "thumb_message",
]
