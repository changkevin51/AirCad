"""Camera-only two-hand pinch drawing with palm-based navigation."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import math
from pathlib import Path
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


def enable_high_dpi_awareness() -> None:
    """Ask Windows not to bitmap-stretch the OpenCV window on scaled displays."""

    if sys.platform != "win32":
        return
    try:
        import ctypes

        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Must run before HighGUI.
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except (AttributeError, OSError, ValueError):
        pass
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except (AttributeError, OSError, ValueError):
        pass
    try:
        import ctypes

        ctypes.windll.user32.SetProcessDPIAware()
    except (AttributeError, OSError, ValueError):
        pass


enable_high_dpi_awareness()

import cv2
import mediapipe as mp
import numpy as np

from gesture_engine import (
    GestureEngine,
    GestureFrame,
    HandObservation,
    Point,
    StrokeEvent,
    TrackedHand,
    ViewTransform,
)
from shape_recognition import recognize_shape


CAMERA_INDEX = 0
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
DISPLAY_WIDTH = 960
DISPLAY_HEIGHT = 720
MIN_POINT_DISTANCE = 3.0
WINDOW_NAME = "Finger Drawing - pinch to draw"
MODEL_PATH = Path(__file__).resolve().with_name("hand_landmarker.task")
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
)

# The button lives in the working frame.  Keep it in the upper right so the
# headline and status line remain readable after the preview is scaled.
SEND_BUTTON_MARGIN = 10
SEND_BUTTON_WIDTH = 192
SEND_BUTTON_TOP = 4
SEND_BUTTON_HEIGHT = 30

# BGR colors. Every hand gets a stable, high-contrast trail/cursor color.
HAND_COLORS = (
    (0, 220, 255),    # yellow
    (255, 170, 0),    # blue-orange
    (255, 90, 220),   # pink
    (80, 235, 100),   # green
)
OUTLINE_COLOR = (18, 18, 18)


# ``freecad_bridge`` is optional while the camera app is being used on its
# own.  Resolve it lazily as well so a bridge added beside this file after
# import is still picked up.  Tests can replace this module-level symbol with
# a fake sender without importing FreeCAD.
try:
    from freecad_bridge import send_to_freecad
except ImportError:
    send_to_freecad = None


def camera_capture_backends() -> tuple[int, ...]:
    """Prefer the backend that reliably opens a webcam on this OS."""

    if sys.platform == "darwin":
        return (cv2.CAP_AVFOUNDATION,)
    if sys.platform == "win32":
        # DirectShow is more reliable than the default Media Foundation backend.
        return (cv2.CAP_DSHOW, cv2.CAP_MSMF)
    return (cv2.CAP_ANY,)


def open_camera(index: int):
    """Open a webcam, trying platform-specific backends before a generic fallback."""

    tried: list[object] = []
    for backend in camera_capture_backends():
        camera = cv2.VideoCapture(index, backend)
        if camera.isOpened():
            return camera
        camera.release()
        tried.append(camera)
    camera = cv2.VideoCapture(index)
    if camera.isOpened():
        return camera
    camera.release()
    return tried[-1] if tried else camera


def preferred_capture_size() -> tuple[int, int]:
    """Use the same 4:3 VGA working size on every OS so the preview is not stretched."""

    return (FRAME_WIDTH, FRAME_HEIGHT)


def preview_window_flags() -> int:
    """Allow the user to resize the preview while asking HighGUI to keep aspect."""

    flags = int(getattr(cv2, "WINDOW_NORMAL", 0))
    keep_ratio = getattr(cv2, "WINDOW_KEEPRATIO", 0)
    if keep_ratio:
        flags |= int(keep_ratio)
    return flags


def preview_window_image_size() -> tuple[int, int]:
    """Return the current HighGUI client size, or the default 960x720 window."""

    getter = getattr(cv2, "getWindowImageRect", None)
    if getter is None:
        return DISPLAY_WIDTH, DISPLAY_HEIGHT
    try:
        rect = getter(WINDOW_NAME)
    except (cv2.error, TypeError, ValueError):
        return DISPLAY_WIDTH, DISPLAY_HEIGHT
    try:
        width, height = int(rect[2]), int(rect[3])
    except (IndexError, TypeError, ValueError):
        return DISPLAY_WIDTH, DISPLAY_HEIGHT
    if width <= 1 or height <= 1:
        return DISPLAY_WIDTH, DISPLAY_HEIGHT
    return width, height


def fit_frame_to_display(
    frame_width: int,
    frame_height: int,
    display_width: int = DISPLAY_WIDTH,
    display_height: int = DISPLAY_HEIGHT,
) -> tuple[int, int, int, int]:
    """Return the letterboxed content rectangle inside the preview window."""

    if frame_width <= 0 or frame_height <= 0 or display_width <= 0 or display_height <= 0:
        return 0, 0, max(1, display_width), max(1, display_height)
    scale = min(display_width / frame_width, display_height / frame_height)
    content_width = min(display_width, max(1, int(round(frame_width * scale))))
    content_height = min(display_height, max(1, int(round(frame_height * scale))))
    content_x = (display_width - content_width) // 2
    content_y = (display_height - content_height) // 2
    return content_x, content_y, content_width, content_height


def frame_for_display(
    frame,
    display_width: int = DISPLAY_WIDTH,
    display_height: int = DISPLAY_HEIGHT,
):
    """Letterbox the composed preview into the window without stretching.

    The window starts at 960x720 and can be resized.  Fitting the camera into
    the current client area keeps laptop 16:9 frames and dragged windows from
    looking squished.
    """

    height, width = frame.shape[:2]
    if width == display_width and height == display_height:
        return frame
    channels = 1 if frame.ndim < 3 else frame.shape[2]
    canvas_shape: tuple[int, ...]
    if frame.ndim < 3:
        canvas_shape = (display_height, display_width)
    else:
        canvas_shape = (display_height, display_width, channels)
    canvas = np.zeros(canvas_shape, dtype=frame.dtype)
    if width <= 0 or height <= 0 or display_width <= 0 or display_height <= 0:
        return canvas
    content_x, content_y, content_width, content_height = fit_frame_to_display(
        width, height, display_width, display_height
    )
    interpolation = (
        cv2.INTER_AREA
        if content_width < width or content_height < height
        else cv2.INTER_LINEAR
    )
    resized = cv2.resize(
        frame, (content_width, content_height), interpolation=interpolation
    )
    canvas[
        content_y : content_y + content_height,
        content_x : content_x + content_width,
    ] = resized
    return canvas


def map_window_point_to_frame(
    x: float,
    y: float,
    frame_width: int,
    frame_height: int,
    window_width: int = DISPLAY_WIDTH,
    window_height: int = DISPLAY_HEIGHT,
) -> tuple[float, float]:
    """Convert HighGUI click coordinates back into working-frame pixels."""

    if window_width <= 0 or window_height <= 0:
        return float(x), float(y)
    content_x, content_y, content_width, content_height = fit_frame_to_display(
        frame_width, frame_height, window_width, window_height
    )
    if content_width <= 0 or content_height <= 0:
        return float(x), float(y)
    return (
        (x - content_x) * frame_width / content_width,
        (y - content_y) * frame_height / content_height,
    )


def camera_permission_help() -> str:
    """Tell the user how to grant camera access on this operating system."""

    if sys.platform == "darwin":
        return (
            "Could not open the webcam. Allow camera access in macOS "
            "System Settings > Privacy & Security > Camera for the app "
            "running Python, then restart it. You can also try --camera 1."
        )
    if sys.platform == "win32":
        return (
            "Could not open the webcam. Allow camera access in Windows "
            "Settings > Privacy & security > Camera, close other programs "
            "using the camera, then try again. You can also try --camera 1."
        )
    return (
        "Could not open the webcam. Close other programs using the camera "
        "and try --camera 1."
    )


def ensure_model():
    """Download Google's hand-tracking model once; no camera images are sent."""
    if MODEL_PATH.is_file():
        return
    print("Downloading the hand-tracking model (about 8 MB, once only)...", flush=True)
    try:
        with urlopen(MODEL_URL, timeout=30) as response:
            model_data = response.read()
        # Read the complete response before creating the local file.
        MODEL_PATH.write_bytes(model_data)
    except (OSError, URLError) as error:
        raise RuntimeError(
            "Could not download the hand-tracking model. Check your internet "
            "connection and run again. Details: {}".format(error)
        ) from error


def _distance(first: Point, second: Point) -> float:
    return math.hypot(first[0] - second[0], first[1] - second[1])


def _pixel_point(landmark, width: int, height: int) -> Point:
    """Convert normalized MediaPipe coordinates using the actual frame aspect."""

    x = float(getattr(landmark, "x")) * width
    y = float(getattr(landmark, "y")) * height
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("MediaPipe returned a non-finite landmark")
    return (
        max(0.0, min(float(width - 1), x)),
        max(0.0, min(float(height - 1), y)),
    )


def count_extended_fingers(points: tuple[Point, ...], palm_size: float) -> int:
    """Count deliberately extended fingers from the full 21-point hand pose."""

    if len(points) < 21:
        return 0
    wrist = points[0]
    count = 0
    # Distance checks are orientation-tolerant and avoid relying on image y.
    for tip_index, pip_index in ((8, 6), (12, 10), (16, 14), (20, 18)):
        tip_distance = _distance(points[tip_index], wrist)
        pip_distance = _distance(points[pip_index], wrist)
        if tip_distance > pip_distance * 1.08 and tip_distance > palm_size * 1.25:
            count += 1
    thumb_tip_distance = _distance(points[4], wrist)
    thumb_ip_distance = _distance(points[3], wrist)
    if (
        thumb_tip_distance > thumb_ip_distance * 1.05
        and thumb_tip_distance > palm_size * 1.05
    ):
        count += 1
    return count


def is_fully_open_palm(points: tuple[Point, ...], palm_size: float) -> bool:
    """Return true only for an intentional, mostly/all-finger-open pose."""

    return count_extended_fingers(points, palm_size) >= 4


def landmarks_to_observation(
    landmarks,
    handedness: str | None,
    width: int,
    height: int,
) -> HandObservation:
    """Build a pixel-space observation from one MediaPipe landmark list."""

    points = tuple(_pixel_point(landmark, width, height) for landmark in landmarks)
    if len(points) < 21:
        raise ValueError("a hand must contain 21 landmarks")
    palm_indices = (0, 5, 9, 13, 17)
    palm_center = (
        sum(points[index][0] for index in palm_indices) / len(palm_indices),
        sum(points[index][1] for index in palm_indices) / len(palm_indices),
    )
    # Both terms are pixel-space distances. This matters on a 640x480 frame:
    # normalized x/y distances would otherwise distort the pinch ratio.
    palm_size = max(
        1.0,
        0.5 * (_distance(points[0], points[9]) + _distance(points[5], points[17])),
    )
    open_count = count_extended_fingers(points, palm_size)
    return HandObservation(
        index_tip=points[8],
        thumb_tip=points[4],
        palm_center=palm_center,
        palm_size=palm_size,
        handedness=handedness,
        open_palm=open_count >= 4,
        open_finger_count=open_count,
        landmarks=points,
    )


def _handedness_label(result, hand_index: int) -> str | None:
    """Read MediaPipe's label defensively; duplicate labels are engine-safe."""

    try:
        entries = result.handedness[hand_index]
        category = entries[0] if entries else None
        if category is None:
            return None
        return (
            getattr(category, "category_name", None)
            or getattr(category, "display_name", None)
            or None
        )
    except (AttributeError, IndexError, TypeError):
        return None


def observations_from_result(result, width: int, height: int) -> list[HandObservation]:
    """Convert all detected hands without using detector-list order as identity."""

    observations: list[HandObservation] = []
    for index, landmarks in enumerate(getattr(result, "hand_landmarks", ())):
        try:
            observations.append(
                landmarks_to_observation(
                    landmarks,
                    _handedness_label(result, index),
                    width,
                    height,
                )
            )
        except (TypeError, ValueError):
            continue
    return observations


def append_if_moved(
    points: list[Point],
    point: Point,
    minimum_distance: float = MIN_POINT_DISTANCE,
) -> bool:
    """Append a finite point unless it is too close to the prior point."""

    if not all(math.isfinite(value) for value in point):
        return False
    if points and _distance(points[-1], point) < minimum_distance:
        return False
    points.append(point)
    return True


@dataclass
class ActiveStroke:
    hand_id: int
    color: tuple[int, int, int]
    points: list[Point]


@dataclass(frozen=True)
class StrokeRecord:
    """Completed stroke; raw canvas points never change with the view."""

    raw_points: tuple[Point, ...]
    color: tuple[int, int, int]
    shape_match: object = None

    def display_points(self, snapping: bool) -> tuple[Point, ...]:
        if snapping and self.shape_match is not None:
            points = _validated_match_points(self.shape_match)
            if points:
                return points
        return self.raw_points


def _validated_match_points(match: object) -> tuple[Point, ...]:
    try:
        values = getattr(match, "points")
        result = tuple((float(point[0]), float(point[1])) for point in values)
    except (AttributeError, IndexError, TypeError, ValueError):
        return ()
    if not result or not all(math.isfinite(value) for point in result for value in point):
        return ()
    return result


def _shape_match_for(points: tuple[Point, ...]) -> object:
    try:
        match = recognize_shape(list(points))
    except (AttributeError, TypeError, ValueError, ArithmeticError):
        return None
    if match is None:
        return None
    kind = str(getattr(match, "kind", "")).lower()
    try:
        confidence = float(getattr(match, "confidence"))
    except (AttributeError, TypeError, ValueError):
        return None
    if kind not in {"line", "circle", "triangle", "rectangle"}:
        return None
    if not 0.0 <= confidence <= 1.0 or not _validated_match_points(match):
        return None
    return match


def _shape_status(match: object) -> str:
    if match is None:
        return "Freehand stroke saved"
    kind = str(getattr(match, "kind", "shape")).lower()
    try:
        confidence = float(getattr(match, "confidence"))
    except (AttributeError, TypeError, ValueError):
        return "Shape: {}".format(kind)
    return "Shape: {} ({:.0f}%)".format(kind, confidence * 100.0)


def _hand_color(hand_id: int) -> tuple[int, int, int]:
    return HAND_COLORS[(hand_id - 1) % len(HAND_COLORS)]


def visible_hands_for_display(
    paused: bool,
    hands: tuple[TrackedHand, ...],
) -> tuple[TrackedHand, ...]:
    """Never paint stale detector positions over a live paused camera image."""

    return () if paused else hands


def _screen_points(
    points: tuple[Point, ...] | list[Point],
    view: ViewTransform | None,
) -> list[Point]:
    if view is None:
        return list(points)
    return [view.canvas_to_screen(point) for point in points]


def _draw_polyline(frame, points: list[Point], color: tuple[int, int, int]) -> None:
    if not points:
        return
    integer_points = np.rint(np.asarray(points, dtype=np.float32)).astype(np.int32)
    if len(integer_points) == 1:
        center = tuple(int(value) for value in integer_points[0])
        cv2.circle(frame, center, 7, OUTLINE_COLOR, -1, cv2.LINE_AA)
        cv2.circle(frame, center, 4, color, -1, cv2.LINE_AA)
        return
    cv2.polylines(frame, [integer_points], False, OUTLINE_COLOR, 8, cv2.LINE_AA)
    cv2.polylines(frame, [integer_points], False, color, 4, cv2.LINE_AA)


def draw_strokes(
    frame,
    strokes: list[StrokeRecord],
    view: ViewTransform | None = None,
    snapping: bool = True,
) -> None:
    """Draw all saved records from immutable canvas geometry."""

    for stroke in strokes:
        points = stroke.display_points(snapping)
        _draw_polyline(frame, _screen_points(points, view), stroke.color)


def _draw_active_strokes(frame, active: dict[int, ActiveStroke], view: ViewTransform) -> None:
    for stroke in active.values():
        _draw_polyline(frame, _screen_points(stroke.points, view), stroke.color)


def _put_text(frame, text: str, position: tuple[int, int], scale: float, color) -> None:
    cv2.putText(
        frame,
        text,
        position,
        cv2.FONT_HERSHEY_SIMPLEX,
        scale,
        color,
        1,
        cv2.LINE_AA,
    )


def _send_button_bounds(width: int, height: int) -> tuple[int, int, int, int]:
    """Return the clickable SEND TO FREECAD rectangle for a frame."""

    right = max(0, width - SEND_BUTTON_MARGIN)
    left = max(0, right - SEND_BUTTON_WIDTH)
    top = max(0, SEND_BUTTON_TOP)
    bottom = min(max(0, height - 1), top + SEND_BUTTON_HEIGHT)
    return left, top, right, bottom


def _point_in_send_button(x: int, y: int, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT) -> bool:
    left, top, right, bottom = _send_button_bounds(width, height)
    return left <= int(x) <= right and top <= int(y) <= bottom


def _draw_send_button(frame) -> None:
    height, width = frame.shape[:2]
    left, top, right, bottom = _send_button_bounds(width, height)
    cv2.rectangle(frame, (left, top), (right, bottom), (24, 126, 194), -1)
    cv2.rectangle(frame, (left, top), (right, bottom), (245, 245, 245), 1)
    _put_text(frame, "SEND TO FREECAD", (left + 9, bottom - 9), 0.35, (255, 255, 255))


def _send_completed_strokes(strokes: list[StrokeRecord]) -> str:
    """Send an immutable snapshot of completed raw strokes to the bridge."""

    if not strokes:
        message = "No completed strokes to send"
        print("FreeCAD send skipped: no completed strokes", file=sys.stderr, flush=True)
        return message

    # A fresh list is important: drawing can continue immediately after this
    # call, while the bridge owns the one-time snapshot it receives.
    raw_strokes = [stroke.raw_points for stroke in strokes]
    try:
        sender = send_to_freecad
        if sender is None:
            from freecad_bridge import send_to_freecad as sender

        snapshot_path = sender(raw_strokes)
    except Exception as error:  # the camera must remain usable if FreeCAD fails
        print(
            "FreeCAD send failed ({}): {}".format(type(error).__name__, error),
            file=sys.stderr,
            flush=True,
        )
        return "FreeCAD send failed; see terminal"

    print(
        "Sent {} completed stroke(s) to FreeCAD; snapshot: {}".format(
            len(raw_strokes), snapshot_path
        ),
        flush=True,
    )
    return "Sent {} stroke(s) to FreeCAD".format(len(raw_strokes))


def draw_hand_overlays(
    frame,
    hands: tuple[TrackedHand, ...],
    navigation_mode: str | None = None,
) -> None:
    for hand in hands:
        color = _hand_color(hand.hand_id)
        index = tuple(int(round(value)) for value in hand.index_tip)
        thumb = tuple(int(round(value)) for value in hand.thumb_tip)
        palm = tuple(int(round(value)) for value in hand.palm_center)
        cv2.circle(frame, palm, 10, OUTLINE_COLOR, 2, cv2.LINE_AA)
        cv2.drawMarker(frame, palm, color, cv2.MARKER_CROSS, 18, 2, cv2.LINE_AA)
        cv2.circle(frame, thumb, 5, color, -1, cv2.LINE_AA)
        cv2.circle(frame, index, 11, OUTLINE_COLOR, -1, cv2.LINE_AA)
        cv2.circle(
            frame,
            index,
            7,
            color if hand.pinching else (245, 245, 245),
            -1,
            cv2.LINE_AA,
        )
        label = hand.handedness.title() if hand.handedness in {"left", "right"} else "Hand"
        if hand.pinching:
            role = "PINCH"
        elif navigation_mode == "two" and hand.open_armed:
            role = "VIEW"
        elif navigation_mode == "one" and hand.open_armed:
            role = "PAN"
        else:
            role = ""
        suffix = " {}".format(role) if role else ""
        label = "{} H{}{}".format(label, hand.hand_id, suffix)
        _put_text(frame, label, (palm[0] + 13, palm[1] - 12), 0.42, color)


def draw_hud(
    frame,
    *,
    paused: bool,
    hands: tuple[TrackedHand, ...],
    active_count: int,
    stroke_count: int,
    snapping: bool,
    view: ViewTransform,
    status: str,
    navigation_mode: str | None = None,
) -> None:
    height, width = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (width, 69), (24, 24, 24), -1)
    cv2.rectangle(frame, (0, height - 48), (width, height), (24, 24, 24), -1)
    if paused:
        headline = "PAUSED"
        headline_color = (180, 180, 180)
    elif active_count:
        headline = "DRAWING ({})".format(active_count)
        headline_color = (0, 235, 255)
    elif navigation_mode == "two":
        headline = "2-HAND VIEW - pan / zoom / rotate"
        headline_color = (120, 220, 255)
    elif navigation_mode == "one":
        headline = "PAN ARMED - move open palm"
        headline_color = (120, 220, 255)
    else:
        headline = "READY - pinch thumb + index to draw"
        headline_color = (245, 245, 245)
    _put_text(frame, headline, (12, 25), 0.56, headline_color)
    info = "Hands {}   Trails {}   Snap {}   View {:.2f}x   {}".format(
        len(hands),
        stroke_count,
        "ON" if snapping else "OFF",
        view.scale,
        status[:34],
    )
    _put_text(frame, info, (12, 52), 0.38, (220, 220, 220))
    _put_text(
        frame,
        "Pinch draw   Open palm pan   2 palms pan / zoom / rotate",
        (10, height - 29),
        0.36,
        (235, 235, 235),
    )
    _put_text(
        frame,
        "Space pause   C clear   U undo   R reset view   S snap   Q/Esc quit   F = Send to FreeCAD",
        (10, height - 10),
        0.36,
        (235, 235, 235),
    )
    _draw_send_button(frame)


def _append_canvas_point(active: ActiveStroke, point: Point, view: ViewTransform) -> None:
    minimum_distance = max(0.8, MIN_POINT_DISTANCE / max(view.scale, 0.05))
    append_if_moved(active.points, view.screen_to_canvas(point), minimum_distance)


def _finish_active_stroke(active: ActiveStroke, strokes: list[StrokeRecord]) -> str:
    raw_points = tuple(active.points)
    if not raw_points:
        return ""
    match = _shape_match_for(raw_points)
    strokes.append(StrokeRecord(raw_points, active.color, match))
    return _shape_status(match)


def consume_stroke_events(
    events: tuple[StrokeEvent, ...] | list[StrokeEvent],
    active: dict[int, ActiveStroke],
    strokes: list[StrokeRecord],
    view: ViewTransform,
) -> str | None:
    """Convert screen-space engine events to immutable canvas stroke records."""

    latest_status: str | None = None
    for event in events:
        if event.kind == "start" and event.point is not None:
            active[event.hand_id] = ActiveStroke(
                hand_id=event.hand_id,
                color=_hand_color(event.hand_id),
                points=[view.screen_to_canvas(event.point)],
            )
        elif event.kind == "point" and event.point is not None:
            current = active.get(event.hand_id)
            if current is not None:
                _append_canvas_point(current, event.point, view)
        elif event.kind == "end":
            current = active.pop(event.hand_id, None)
            if current is not None:
                latest_status = _finish_active_stroke(current, strokes)
    return latest_status


def _reset_input_and_finish(
    engine: GestureEngine,
    active: dict[int, ActiveStroke],
    strokes: list[StrokeRecord],
) -> str | None:
    events = engine.reset_input("discontinuity")
    latest_status = None
    for event in events:
        current = active.pop(event.hand_id, None)
        if current is not None:
            latest_status = _finish_active_stroke(current, strokes)
    active.clear()
    return latest_status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=CAMERA_INDEX, help="webcam index (default: 0)")
    args = parser.parse_args()
    ensure_model()
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(MODEL_PATH),
            delegate=mp.tasks.BaseOptions.Delegate.CPU,
        ),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    camera = None
    try:
        with mp.tasks.vision.HandLandmarker.create_from_options(options) as hands:
            print("Opening camera {}...".format(args.camera), flush=True)
            camera = open_camera(args.camera)
            if camera is None or not camera.isOpened():
                raise RuntimeError(camera_permission_help())
            capture_width, capture_height = preferred_capture_size()
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, capture_width)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, capture_height)
            camera.set(cv2.CAP_PROP_FPS, 30)
            cv2.namedWindow(WINDOW_NAME, preview_window_flags())
            cv2.resizeWindow(WINDOW_NAME, DISPLAY_WIDTH, DISPLAY_HEIGHT)

            engine = GestureEngine()
            view: ViewTransform | None = None
            strokes: list[StrokeRecord] = []
            active: dict[int, ActiveStroke] = {}
            paused = False
            snapping = True
            status = "Show a hand; pinch to draw"
            last_frame = GestureFrame(timestamp_ms=0.0)
            timestamp_ms = -1
            frame_size = [FRAME_WIDTH, FRAME_HEIGHT]

            def send_current_drawing() -> None:
                nonlocal status
                status = _send_completed_strokes(strokes)

            def handle_mouse(event, x, y, _flags, _param) -> None:
                window_width, window_height = preview_window_image_size()
                work_x, work_y = map_window_point_to_frame(
                    x,
                    y,
                    frame_size[0],
                    frame_size[1],
                    window_width,
                    window_height,
                )
                if event == cv2.EVENT_LBUTTONUP and _point_in_send_button(
                    work_x, work_y, frame_size[0], frame_size[1]
                ):
                    send_current_drawing()

            cv2.setMouseCallback(WINDOW_NAME, handle_mouse)
            print("Camera ready. Pinch thumb + index to draw; click the window for keys.", flush=True)

            while True:
                success, frame = camera.read()
                if not success:
                    raise RuntimeError("The camera stopped returning frames. Close other camera apps and restart.")

                # All coordinates below are in this mirrored display space. The
                # camera image itself remains fixed while only saved paths move.
                frame = cv2.flip(frame, 1)
                height, width = frame.shape[:2]
                frame_size[0] = width
                frame_size[1] = height
                if view is None:
                    view = ViewTransform((width * 0.5, height * 0.5))

                if not paused:
                    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
                    timestamp_ms = max(timestamp_ms + 1, time.monotonic_ns() // 1_000_000)
                    result = hands.detect_for_video(image, timestamp_ms)
                    observations = observations_from_result(result, width, height)
                    last_frame = engine.update(observations, timestamp_ms)
                    latest_status = consume_stroke_events(
                        last_frame.stroke_events,
                        active,
                        strokes,
                        view,
                    )
                    if latest_status:
                        status = latest_status
                    if last_frame.navigation is not None and not last_frame.any_drawing:
                        view.apply_navigation(last_frame.navigation)

                display_hands = visible_hands_for_display(paused, last_frame.hands)
                display_navigation_mode = None if paused else last_frame.navigation_mode
                draw_strokes(frame, strokes, view, snapping)
                _draw_active_strokes(frame, active, view)
                draw_hand_overlays(frame, display_hands, display_navigation_mode)
                draw_hud(
                    frame,
                    paused=paused,
                    hands=display_hands,
                    active_count=len(active),
                    stroke_count=len(strokes),
                    snapping=snapping,
                    view=view,
                    status=status,
                    navigation_mode=display_navigation_mode,
                )
                display_width, display_height = preview_window_image_size()
                cv2.imshow(
                    WINDOW_NAME,
                    frame_for_display(frame, display_width, display_height),
                )
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q"), 27):
                    break
                if cv2.getWindowProperty(WINDOW_NAME, cv2.WND_PROP_VISIBLE) < 1:
                    break

                if key in (ord("c"), ord("C")):
                    engine.reset_input("clear")
                    active.clear()
                    strokes.clear()
                    status = "Drawing cleared; release and pinch to start"
                elif key in (ord("u"), ord("U")):
                    if strokes:
                        strokes.pop()
                        status = "Undid the most recent completed stroke"
                elif key in (ord("r"), ord("R")):
                    latest_status = _reset_input_and_finish(engine, active, strokes)
                    view.reset()
                    status = latest_status or "View reset"
                elif key in (ord("s"), ord("S")):
                    snapping = not snapping
                    status = "Automatic snapping {}".format("ON" if snapping else "OFF")
                elif key in (ord("f"), ord("F")):
                    send_current_drawing()
                elif key == ord(" "):
                    latest_status = _reset_input_and_finish(engine, active, strokes)
                    paused = not paused
                    status = "Paused" if paused else "Resumed; release and pinch to draw"
                    if latest_status and not paused:
                        status = latest_status
    finally:
        if camera is not None:
            camera.release()
        cv2.destroyAllWindows()
        print("Camera stopped", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (RuntimeError, OSError, ValueError, cv2.error) as error:
        print("Error: {}".format(error), file=sys.stderr)
        sys.exit(1)
