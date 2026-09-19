"""Webcam capture and MediaPipe hand detection for the AirCAD tracker.

Everything OpenCV/MediaPipe specific lives here.  The landmark conversion
helpers are pure Python so they can be unit-tested without a camera, and the
heavy imports are deferred so importing this module never needs a webcam.
"""

from __future__ import annotations

import base64
import math
from pathlib import Path
import sys
import threading
import time
from typing import Callable, Optional
from urllib.error import URLError
from urllib.request import urlopen

from gesture_engine import GestureEngine, GestureFrame, HandObservation, Point


CAMERA_INDEX = 0
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
MODEL_PATH = Path(__file__).resolve().parent.parent / "hand_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
)
THUMB_WIDTH = 192
THUMB_INTERVAL_S = 1.0 / 12.0
THUMB_JPEG_QUALITY = 60


def camera_capture_backends() -> tuple[int, ...]:
    """Prefer the backend that reliably opens a webcam on this OS."""

    import cv2

    if sys.platform == "darwin":
        return (cv2.CAP_AVFOUNDATION,)
    if sys.platform == "win32":
        # DirectShow is more reliable than the default Media Foundation backend.
        return (cv2.CAP_DSHOW, cv2.CAP_MSMF)
    return (cv2.CAP_ANY,)


def open_camera(index: int):
    """Open a webcam, trying platform-specific backends before a generic fallback."""

    import cv2

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
    """Use the same 4:3 VGA working size on every OS."""

    return (FRAME_WIDTH, FRAME_HEIGHT)


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


def ensure_model() -> None:
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


FrameCallback = Callable[[GestureFrame, list[HandObservation], int, int], None]
ThumbCallback = Callable[[str, int, int], None]
StatusCallback = Callable[[str, str], None]


class CameraWorker(threading.Thread):
    """Run the webcam + MediaPipe + GestureEngine loop on a background thread.

    Results are handed to plain callbacks; the server marshals them onto its
    event loop.  Any failure is reported through ``on_status('error', ...)``
    instead of killing the process, so the browser UI keeps working with the
    mouse when no camera is available.
    """

    def __init__(
        self,
        camera_index: int,
        on_frame: FrameCallback,
        on_thumb: Optional[ThumbCallback] = None,
        on_status: Optional[StatusCallback] = None,
        *,
        thumb_interval_s: float = THUMB_INTERVAL_S,
    ) -> None:
        super().__init__(name="aircad-camera", daemon=True)
        self.camera_index = int(camera_index)
        self.on_frame = on_frame
        self.on_thumb = on_thumb
        self.on_status = on_status or (lambda _state, _message: None)
        self.thumb_interval_s = float(thumb_interval_s)
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:  # pragma: no cover - needs a physical camera
        try:
            self._run()
        except Exception as error:  # report, never crash the server
            self.on_status("error", "{}: {}".format(type(error).__name__, error))
        finally:
            self.on_status("stopped", "Camera stopped")

    def _run(self) -> None:  # pragma: no cover - needs a physical camera
        import cv2
        import mediapipe as mp

        self.on_status("starting", "Loading the hand-tracking model")
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
            with mp.tasks.vision.HandLandmarker.create_from_options(options) as landmarker:
                self.on_status("starting", "Opening camera {}".format(self.camera_index))
                camera = open_camera(self.camera_index)
                if camera is None or not camera.isOpened():
                    raise RuntimeError(camera_permission_help())
                width, height = preferred_capture_size()
                camera.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                camera.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
                camera.set(cv2.CAP_PROP_FPS, 30)
                self.on_status("ready", "Camera ready")

                engine = GestureEngine()
                timestamp_ms = -1
                last_thumb = 0.0
                while not self._stop_event.is_set():
                    success, frame = camera.read()
                    if not success:
                        raise RuntimeError(
                            "The camera stopped returning frames. Close other camera apps and restart."
                        )
                    # Mirror once so every coordinate downstream is in the
                    # natural "looking into a mirror" space.
                    frame = cv2.flip(frame, 1)
                    frame_height, frame_width = frame.shape[:2]
                    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
                    timestamp_ms = max(timestamp_ms + 1, time.monotonic_ns() // 1_000_000)
                    result = landmarker.detect_for_video(image, timestamp_ms)
                    observations = observations_from_result(result, frame_width, frame_height)
                    gesture_frame = engine.update(observations, timestamp_ms)
                    self.on_frame(gesture_frame, observations, frame_width, frame_height)

                    now = time.monotonic()
                    if self.on_thumb is not None and now - last_thumb >= self.thumb_interval_s:
                        last_thumb = now
                        self.on_thumb(*encode_thumbnail(frame))
        finally:
            if camera is not None:
                camera.release()


def encode_thumbnail(frame, width: int = THUMB_WIDTH) -> tuple[str, int, int]:
    """Return a small base64 JPEG of ``frame`` plus its pixel size."""

    import cv2

    frame_height, frame_width = frame.shape[:2]
    height = max(1, int(round(frame_height * width / max(1, frame_width))))
    small = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, THUMB_JPEG_QUALITY])
    if not ok:
        raise RuntimeError("could not encode camera thumbnail")
    return base64.b64encode(encoded.tobytes()).decode("ascii"), width, height


__all__ = [
    "CAMERA_INDEX",
    "CameraWorker",
    "FRAME_HEIGHT",
    "FRAME_WIDTH",
    "MODEL_PATH",
    "camera_permission_help",
    "count_extended_fingers",
    "encode_thumbnail",
    "ensure_model",
    "is_fully_open_palm",
    "landmarks_to_observation",
    "observations_from_result",
    "open_camera",
    "preferred_capture_size",
]
