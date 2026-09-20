"""OAK-D capture worker: synchronized RGB-D, detection, filtered XYZ samples.

The DepthAI SDK is imported lazily so importing this module
never needs the optional hardware dependencies.  Device access goes through a
small session object (``poll`` -> newest complete paired RGB+depth frame), so
tests can drive the whole loop with fake frames, clocks and queues.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
import math
import threading
import time
from typing import Callable, Optional

import numpy as np

from tracker.camera import encode_thumbnail
from tracker.keycap import KeycapTracker
from tracker.depth_tracking import (
    HOLD_TIMEOUT_S,
    MAX_PAIR_SKEW_MS,
    MAX_SAMPLE_AGE_MS,
    RGB_HEIGHT,
    RGB_WIDTH,
    FPS,
    SpatialFilter,
    TargetAssociator,
    TargetCandidate,
    estimate_depth,
    led_sample_points,
    pixel_to_xyz,
    validate_intrinsics,
)


THUMB_INTERVAL_S = 1.0 / 12.0
POLL_IDLE_S = 0.002
STALL_EMIT_MS = 100.0
STALL_FATAL_MS = 3000.0


@dataclass(frozen=True)
class DepthConfig:
    """Immutable detection settings consumed between frames by the worker."""

    target: str = "keycap"
    color_preset: str = "green"
    color_tolerance: float = 1.0
    revision: int = 0


@dataclass(frozen=True)
class FramePair:
    """One synchronized RGB + aligned-depth capture on the device clock."""

    rgb: object
    depth: object
    rgb_ts_ms: float
    depth_ts_ms: float
    now_ms: float
    seq: int


@dataclass(frozen=True)
class SpatialSample:
    """One filtered observation; the controller adds stream tags and seq."""

    t_ms: float
    sample_time_ms: Optional[float]
    age_ms: Optional[float]
    target: str
    tracking_epoch: int
    frame_w: int
    frame_h: int
    pixel: Optional[tuple[float, float]]
    camera_mm: Optional[tuple[float, float, float]]
    state: str
    fresh: bool
    reason: Optional[str]
    valid_pixels: int
    roi_count: int
    spread_mm: Optional[float]
    pair_skew_ms: Optional[float]
    revision: int = 0


def import_depthai():
    """Lazy SDK import with an actionable error for missing/wrong versions."""

    try:
        import depthai as dai
    except ImportError as error:
        raise RuntimeError(
            "The DepthAI SDK is not installed, so the depth camera cannot "
            "start. Install the optional dependency with: "
            "pip install -r requirements-depth.txt"
        ) from error
    version = str(getattr(dai, "__version__", "0"))
    try:
        major = int(version.split(".")[0])
    except ValueError:
        major = 0
    if major != 2:
        raise RuntimeError(
            "Unsupported DepthAI SDK version {}. AirCAD needs the v2 API "
            "(depthai==2.30.0.0); install it with: "
            "pip install -r requirements-depth.txt".format(version)
        )
    return dai


def _board_socket(dai, new_name: str, old_name: str):
    socket = getattr(dai.CameraBoardSocket, new_name, None)
    return socket if socket is not None else getattr(dai.CameraBoardSocket, old_name)


def _clock_ms(value) -> float:
    if hasattr(value, "total_seconds"):
        return float(value.total_seconds()) * 1000.0
    return float(value)


def _group_message(group, name: str):
    try:
        getter = getattr(group, "getMessage", None)
        if getter is not None:
            return getter(name)
        return group[name]
    except Exception:
        return None


def build_pipeline(dai, rgb_socket, lens_position: int):
    """1080p RGB scaled to 720p + 400p stereo depth, paired by a Sync node."""

    pipeline = dai.Pipeline()

    cam_rgb = pipeline.create(dai.node.ColorCamera)
    left = pipeline.create(dai.node.MonoCamera)
    right = pipeline.create(dai.node.MonoCamera)
    stereo = pipeline.create(dai.node.StereoDepth)
    sync = pipeline.create(dai.node.Sync)
    xout = pipeline.create(dai.node.XLinkOut)
    xout.setStreamName("rgbd")

    cam_rgb.setBoardSocket(rgb_socket)
    cam_rgb.setResolution(dai.ColorCameraProperties.SensorResolution.THE_1080_P)
    cam_rgb.setIspScale(2, 3)
    cam_rgb.setFps(FPS)
    cam_rgb.setInterleaved(False)
    cam_rgb.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    if lens_position:
        cam_rgb.initialControl.setManualFocus(lens_position)

    left.setBoardSocket(_board_socket(dai, "CAM_B", "LEFT"))
    right.setBoardSocket(_board_socket(dai, "CAM_C", "RIGHT"))
    left.setResolution(dai.MonoCameraProperties.SensorResolution.THE_400_P)
    right.setResolution(dai.MonoCameraProperties.SensorResolution.THE_400_P)
    left.setFps(FPS)
    right.setFps(FPS)

    stereo.setDefaultProfilePreset(dai.node.StereoDepth.PresetMode.HIGH_DENSITY)
    stereo.setLeftRightCheck(True)
    stereo.setSubpixel(True)
    stereo.setDepthAlign(rgb_socket)
    stereo.setOutputSize(RGB_WIDTH, RGB_HEIGHT)
    if hasattr(stereo, "initialConfig") and hasattr(dai, "MedianFilter"):
        try:
            stereo.initialConfig.setMedianFilter(dai.MedianFilter.KERNEL_7x7)
        except Exception as error:
            print("Warning: could not enable the 7x7 median depth filter: {}".format(error))

    left.out.link(stereo.left)
    right.out.link(stereo.right)
    sync.setSyncThreshold(timedelta(milliseconds=MAX_PAIR_SKEW_MS))
    sync.setSyncAttempts(-1)
    cam_rgb.isp.link(sync.inputs["rgb"])
    stereo.depth.link(sync.inputs["depth"])
    sync.out.link(xout.input)
    return pipeline


class OakSession:
    """Real device session: drains the 'rgbd' queue to the newest full pair."""

    frame_size = (RGB_WIDTH, RGB_HEIGHT)

    def __init__(self, dai, device, queue, intrinsics) -> None:
        self._dai = dai
        self._device = device
        self._queue = queue
        self.intrinsics = intrinsics

    @classmethod
    def open(cls, dai, logger=None) -> "OakSession":
        rgb_socket = _board_socket(dai, "CAM_A", "RGB")
        device = dai.Device()
        try:
            calib = device.readCalibration2()
            lens_position = calib.getLensPosition(rgb_socket) or 0
            matrix = calib.getCameraIntrinsics(rgb_socket, RGB_WIDTH, RGB_HEIGHT)
            intrinsics = validate_intrinsics(
                (matrix[0][0], matrix[1][1], matrix[0][2], matrix[1][2])
            )
        except Exception as error:
            device.close()
            raise RuntimeError(
                "Could not read valid OAK camera calibration; metric tracking "
                "needs real intrinsics. Details: {}".format(error)
            ) from error
        try:
            device.startPipeline(build_pipeline(dai, rgb_socket, lens_position))
            queue = device.getOutputQueue("rgbd", maxSize=2, blocking=False)
        except Exception:
            device.close()
            raise
        return cls(dai, device, queue, intrinsics)

    def poll(self) -> Optional[FramePair]:
        drained = []
        while True:
            packet = self._queue.tryGet()
            if packet is None:
                break
            drained.append(packet)
        for group in reversed(drained):
            rgb_in = _group_message(group, "rgb")
            depth_in = _group_message(group, "depth")
            if rgb_in is None or depth_in is None:
                continue
            return FramePair(
                rgb=rgb_in.getCvFrame(),
                depth=depth_in.getFrame(),
                rgb_ts_ms=_clock_ms(rgb_in.getTimestamp()),
                depth_ts_ms=_clock_ms(depth_in.getTimestamp()),
                now_ms=_clock_ms(self._dai.Clock.now()),
                seq=int(rgb_in.getSequenceNum()),
            )
        return None

    def close(self) -> None:
        self._device.close()


SpatialCallback = Callable[[SpatialSample], None]
ThumbCallback = Callable[[str, int, int], None]
StatusCallback = Callable[[str, str], None]


class DepthCameraWorker(threading.Thread):
    """Background RGB-D loop emitting validated spatial samples.

    ``session`` and ``detector_factory`` are injectable so tests can run the
    whole pipeline without DepthAI or a camera.  ``update_config``
    swaps the immutable detection revision, which the loop picks up between
    frames (resetting detector/filter state) without reopening the device.
    """

    def __init__(
        self,
        config: DepthConfig,
        on_spatial: SpatialCallback,
        on_thumb: Optional[ThumbCallback] = None,
        on_status: Optional[StatusCallback] = None,
        *,
        session=None,
        detector_factory: Optional[Callable[[], object]] = None,
        logger=None,
        clock: Callable[[], float] = time.monotonic,
        thumb_interval_s: float = THUMB_INTERVAL_S,
    ) -> None:
        super().__init__(name="aircad-depth-camera", daemon=True)
        self.on_spatial = on_spatial
        self.on_thumb = on_thumb
        self.on_status = on_status or (lambda _state, _message, revision=0: None)
        self.thumb_interval_s = float(thumb_interval_s)
        self._session = session
        self._detector_factory = detector_factory or KeycapTracker
        self._logger = logger
        self._clock = clock
        self._stop_event = threading.Event()
        self._config_lock = threading.Lock()
        self._config = config
        self._applied_revision = int(config.revision)
        self._last_wire_ms: Optional[float] = None

    def stop(self) -> None:
        self._stop_event.set()

    def update_config(self, config: DepthConfig) -> None:
        with self._config_lock:
            self._config = config

    def _revision(self) -> DepthConfig:
        with self._config_lock:
            return self._config

    def run(self) -> None:
        try:
            self._run()
        except Exception as error:
            self.on_status(
                "error",
                "{}: {}".format(type(error).__name__, error),
                revision=self._applied_revision,
            )
        finally:
            self.on_status("stopped", "Camera stopped", revision=self._applied_revision)

    def _clock_ms(self) -> float:
        return float(self._clock()) * 1000.0

    def _run(self) -> None:
        self.on_status(
            "starting", "Opening depth camera", revision=self._applied_revision
        )
        session = self._session
        try:
            if session is None:
                session = OakSession.open(import_depthai(), logger=self._logger)
            intrinsics = validate_intrinsics(session.intrinsics)
            frame_w, frame_h = getattr(session, "frame_size", (RGB_WIDTH, RGB_HEIGHT))
            frame_w, frame_h = int(frame_w), int(frame_h)
            filt = SpatialFilter()
            associator = TargetAssociator()
            applied: Optional[DepthConfig] = None
            last_seq = -1
            last_rgb_ts: Optional[float] = None
            sdk_offset_ms: Optional[float] = None
            session_open_ms = self._clock_ms()
            last_group_ms: Optional[float] = None
            stall_emit_ms: Optional[float] = None
            last_thumb_ms = 0.0
            while not self._stop_event.is_set():
                revision = self._revision()
                if revision != applied:
                    filt = SpatialFilter()
                    associator.reset()
                    applied = revision
                    self._applied_revision = revision.revision
                    detector = self._detector_factory()
                    self.on_status(
                        "ready", "Depth camera ready", revision=revision.revision
                    )

                pair = session.poll()
                now_ms = self._clock_ms()
                if pair is None:
                    anchor = last_group_ms if last_group_ms is not None else session_open_ms
                    if (
                        last_group_ms is None
                        and now_ms - session_open_ms >= STALL_FATAL_MS
                    ):
                        raise RuntimeError(
                            "No synchronized RGB-D frames arrived within "
                            "{:.0f} ms of opening the camera; check the OAK "
                            "device connection and pipeline.".format(STALL_FATAL_MS)
                        )
                    if (
                        now_ms - anchor >= HOLD_TIMEOUT_S * 1000.0
                        and (stall_emit_ms is None or now_ms - stall_emit_ms >= STALL_EMIT_MS)
                    ):
                        stall_emit_ms = now_ms
                        out = filt.miss(now_ms, "stall")
                        self._emit(
                            out, now_ms, None, None, None, revision, frame_w, frame_h
                        )
                    self._stop_event.wait(POLL_IDLE_S)
                    continue

                stall_emit_ms = None
                last_group_ms = now_ms
                if not all(
                    math.isfinite(value)
                    for value in (pair.rgb_ts_ms, pair.depth_ts_ms, pair.now_ms)
                ):
                    out = filt.miss(now_ms, "bad_time")
                    self._emit(out, now_ms, None, None, None, revision, frame_w, frame_h)
                    continue
                if sdk_offset_ms is None:
                    sdk_offset_ms = now_ms - pair.now_ms
                if pair.seq <= last_seq or (
                    last_rgb_ts is not None and pair.rgb_ts_ms <= last_rgb_ts
                ):
                    out = filt.miss(now_ms, "duplicate")
                    self._emit(out, now_ms, None, None, None, revision, frame_w, frame_h)
                    continue
                last_seq = pair.seq
                last_rgb_ts = pair.rgb_ts_ms

                skew_ms = abs(pair.rgb_ts_ms - pair.depth_ts_ms)
                sdk_age_ms = pair.now_ms - pair.rgb_ts_ms
                host_capture_ms = pair.rgb_ts_ms + sdk_offset_ms
                if skew_ms > MAX_PAIR_SKEW_MS:
                    out = filt.miss(now_ms, "pair_skew")
                    self._emit(
                        out, now_ms, skew_ms, None, None, revision, frame_w, frame_h
                    )
                    continue
                if not (0.0 <= sdk_age_ms <= MAX_SAMPLE_AGE_MS):
                    out = filt.miss(now_ms, "stale")
                    self._emit(
                        out, now_ms, skew_ms, None, None, revision, frame_w, frame_h
                    )
                    continue

                rgb, depth = pair.rgb, pair.depth
                if getattr(rgb, "shape", None) != (frame_h, frame_w, 3) or getattr(
                    depth, "shape", None
                ) != (frame_h, frame_w):
                    out = filt.miss(now_ms, "bad_shape")
                    self._emit(
                        out, now_ms, skew_ms, None, None, revision, frame_w, frame_h
                    )
                    continue

                pixel = None
                estimate = None
                raw = None
                miss_reason = None

                target = detector.update(rgb, host_capture_ms / 1000, revision.color_tolerance)
                candidates = [] if target is None else [TargetCandidate(
                    centroid=(target.x, target.y), size=math.sqrt(target.area),
                )]

                association = associator.update(candidates, host_capture_ms)
                if association.acquired:
                    filt.invalidate()
                chosen = association.candidate
                if chosen is None:
                    miss_reason = "ambiguous" if association.ambiguous else "no_target"
                else:
                    tip = chosen.centroid
                    samples = led_sample_points(tip[0], tip[1])
                    estimate = estimate_depth(depth, samples, filt.last_z)
                    pixel = (frame_w - 1.0 - tip[0], tip[1])
                    if estimate.z is not None:
                        raw = pixel_to_xyz(tip[0], tip[1], estimate.z, *intrinsics)
                    else:
                        miss_reason = estimate.reason

                processing_now_ms = self._clock_ms()
                if not 0.0 <= processing_now_ms - host_capture_ms <= MAX_SAMPLE_AGE_MS:
                    out = filt.miss(processing_now_ms, "stale")
                else:
                    out = filt.update(
                        host_capture_ms, raw, miss_reason, now_ms=processing_now_ms
                    )
                self._emit(
                    out,
                    host_capture_ms,
                    skew_ms,
                    pixel,
                    estimate,
                    revision,
                    frame_w,
                    frame_h,
                    raw,
                )

                if (
                    self.on_thumb is not None
                    and processing_now_ms - last_thumb_ms
                    >= self.thumb_interval_s * 1000.0
                ):
                    last_thumb_ms = processing_now_ms
                    self._emit_thumb(rgb, pixel, revision)
        finally:
            close = getattr(session, "close", None)
            if close is not None:
                try:
                    close()
                except Exception:
                    pass

    def _emit(
        self,
        out,
        t_ms: float,
        skew_ms: Optional[float],
        pixel: Optional[tuple[float, float]],
        estimate,
        revision: DepthConfig,
        frame_w: int,
        frame_h: int,
        raw=None,
    ) -> None:
        camera_mm = None
        if out.xyz is not None:
            camera_mm = (float(out.xyz[0]), float(out.xyz[1]), float(out.xyz[2]))
        emit_ms = self._clock_ms()
        wire_ms = emit_ms
        if self._last_wire_ms is not None and wire_ms <= self._last_wire_ms:
            wire_ms = self._last_wire_ms + 0.1
        self._last_wire_ms = wire_ms
        age_ms = (
            None
            if out.sample_time_ms is None
            else max(0.0, emit_ms - out.sample_time_ms)
        )
        sample = SpatialSample(
            t_ms=wire_ms,
            sample_time_ms=out.sample_time_ms,
            age_ms=age_ms,
            target=revision.target,
            tracking_epoch=out.epoch,
            frame_w=frame_w,
            frame_h=frame_h,
            pixel=pixel,
            camera_mm=camera_mm,
            state=out.state,
            fresh=out.fresh,
            reason=out.reason,
            valid_pixels=estimate.valid_pixels if estimate is not None else 0,
            roi_count=estimate.roi_count if estimate is not None else 0,
            spread_mm=estimate.spread_mm if estimate is not None else None,
            pair_skew_ms=skew_ms,
            revision=revision.revision,
        )
        self.on_spatial(sample)
        if self._logger is not None:
            self._logger.log(
                "sample",
                revision=revision.revision,
                state=sample.state,
                fresh=sample.fresh,
                reason=sample.reason,
                t=wire_ms,
                captureTimeMs=t_ms,
                sampleTimeMs=sample.sample_time_ms,
                ageMs=age_ms,
                pairSkewMs=skew_ms,
                rawMm=None if raw is None else [float(raw[0]), float(raw[1]), float(raw[2])],
                cameraMm=camera_mm,
                epoch=sample.tracking_epoch,
                validPixels=sample.valid_pixels,
                roiCount=sample.roi_count,
                spreadMm=sample.spread_mm,
            )

    def _emit_thumb(
        self,
        rgb,
        pixel: Optional[tuple[float, float]],
        revision: DepthConfig,
    ) -> None:
        import cv2

        view = cv2.flip(rgb, 1)
        if pixel is not None:
            cv2.circle(
                view,
                (int(round(pixel[0])), int(round(pixel[1]))),
                8,
                (80, 220, 255),
                2,
                cv2.LINE_AA,
            )
        jpeg, width, height = encode_thumbnail(view)
        self.on_thumb(jpeg, width, height, revision=revision.revision)


__all__ = [
    "DepthCameraWorker",
    "DepthConfig",
    "FramePair",
    "OakSession",
    "SpatialSample",
    "build_pipeline",
    "import_depthai",
]
