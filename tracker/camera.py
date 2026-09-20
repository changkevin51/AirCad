"""Webcam capture and green keycap detection for the AirCAD tracker.

Detection is shared with the depth-camera worker. Camera imports are lazy.
"""

from __future__ import annotations

import base64
import sys
import threading
import time
from typing import Callable, Optional

from tracker.keycap import KeycapTracker
from tracker.protocol import keycap_message


CAMERA_INDEX = 0
FRAME_WIDTH = 1280
FRAME_HEIGHT = 720
THUMB_WIDTH = 384
THUMB_INTERVAL_S = 1.0 / 30.0
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
    """Request native 720p keycap measurements on every OS."""

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


FrameCallback = Callable[[object, int, int, int], None]
ThumbCallback = Callable[..., None]  # JPEG, width, height, plus same-frame keycap metadata.
StatusCallback = Callable[[str, str], None]


class CameraWorker(threading.Thread):
    """Run the webcam + green keycap loop on a background thread.

    Results are sent to plain callbacks; the server marshals them onto its
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

        camera = None
        try:
            self.on_status("starting", "Opening green keycap camera {}".format(self.camera_index))
            camera = open_camera(self.camera_index)
            if camera is None or not camera.isOpened():
                raise RuntimeError(camera_permission_help())
            width, height = preferred_capture_size()
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            camera.set(cv2.CAP_PROP_FPS, 60)
            self.on_status("ready", "Green keycap camera ready")
            tracker = KeycapTracker()
            last_thumb = 0.0
            while not self._stop_event.is_set():
                success, frame = camera.read()
                if not success:
                    raise RuntimeError("The camera stopped returning frames. Close other camera apps and restart.")
                frame = cv2.flip(frame, 1)
                frame_height, frame_width = frame.shape[:2]
                now = time.monotonic()
                point = tracker.update(frame, now)
                self.on_frame(point, int(now * 1000), frame_width, frame_height)
                if self.on_thumb is not None and now - last_thumb >= self.thumb_interval_s:
                    last_thumb = now
                    # The preview carries its own measurement, not whichever
                    # higher-rate cursor packet happens to arrive most recently.
                    self.on_thumb(*encode_thumbnail(frame), keycap_frame=keycap_message(
                        point, int(now * 1000), frame_width, frame_height,
                    ))
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
