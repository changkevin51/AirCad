"""Tracker configuration and device lifecycle for the AirCAD server.

:class:`TrackerController` owns the single active camera worker (webcam or
OAK depth), serializes source/config transitions behind an async lock, fences
late worker callbacks by generation, and retains actionable error status when
a worker reports ``stopped`` after ``error``.  Workers and clocks are
injectable so the whole lifecycle is testable without hardware.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import importlib.util
import math
import sys
import time
import types
from typing import Any, Callable, Mapping, Optional
import uuid

from tracker import protocol
from tracker.depth_camera import DepthConfig


SOURCES = ("webcam", "oak", "none")
DEPTH_TARGETS = ("keycap",)
COLOR_PRESETS = ("green",)
CAMERA_INDEX_MIN, CAMERA_INDEX_MAX = 0, 32
COLOR_TOLERANCE_MIN, COLOR_TOLERANCE_MAX = 0.5, 2.0
STOP_JOIN_TIMEOUT_S = 3.0
STREAM_MESSAGE_TYPES = ("keycap", "spatial", "thumb")
_SPATIAL_SAMPLE_FIELDS = (
    "t_ms",
    "sample_time_ms",
    "age_ms",
    "target",
    "tracking_epoch",
    "frame_w",
    "frame_h",
    "pixel",
    "camera_mm",
    "state",
    "fresh",
    "reason",
    "valid_pixels",
    "roi_count",
    "spread_mm",
    "pair_skew_ms",
)


@dataclass(frozen=True)
class TrackerConfig:
    source: str = "webcam"
    camera_index: int = 0
    target: str = "keycap"
    color_preset: str = "green"
    color_tolerance: float = 1.0


CONFIG_FIELDS = ("source", "cameraIndex", "target", "colorPreset", "colorTolerance")


def config_to_json(config: TrackerConfig) -> dict[str, Any]:
    return {
        "source": config.source,
        "cameraIndex": config.camera_index,
        "target": config.target,
        "colorPreset": config.color_preset,
        "colorTolerance": config.color_tolerance,
    }


def config_from_json(value: Any) -> TrackerConfig:
    """Validate a complete HTTP config object; reject, never coerce."""

    if not isinstance(value, dict):
        raise ValueError("config must be a JSON object")
    unknown = sorted(set(value) - set(CONFIG_FIELDS))
    if unknown:
        raise ValueError("unknown config field(s): {}".format(", ".join(unknown)))
    missing = [field for field in CONFIG_FIELDS if field not in value]
    if missing:
        raise ValueError("missing config field(s): {}".format(", ".join(missing)))

    source = value["source"]
    if not isinstance(source, str) or source not in SOURCES:
        raise ValueError("source must be one of: {}".format(", ".join(SOURCES)))
    camera_index = value["cameraIndex"]
    if isinstance(camera_index, bool) or not isinstance(camera_index, int):
        raise ValueError("cameraIndex must be an integer")
    if not (CAMERA_INDEX_MIN <= camera_index <= CAMERA_INDEX_MAX):
        raise ValueError(
            "cameraIndex must be between {} and {}".format(CAMERA_INDEX_MIN, CAMERA_INDEX_MAX)
        )
    target = value["target"]
    if not isinstance(target, str) or target not in DEPTH_TARGETS:
        raise ValueError("target must be one of: {}".format(", ".join(DEPTH_TARGETS)))
    color_preset = value["colorPreset"]
    if not isinstance(color_preset, str) or color_preset not in COLOR_PRESETS:
        raise ValueError("colorPreset must be one of: {}".format(", ".join(COLOR_PRESETS)))
    color_tolerance = value["colorTolerance"]
    if isinstance(color_tolerance, bool) or not isinstance(color_tolerance, (int, float)):
        raise ValueError("colorTolerance must be a number")
    color_tolerance = float(color_tolerance)
    if not math.isfinite(color_tolerance) or not (
        COLOR_TOLERANCE_MIN <= color_tolerance <= COLOR_TOLERANCE_MAX
    ):
        raise ValueError(
            "colorTolerance must be finite and between {} and {}".format(
                COLOR_TOLERANCE_MIN, COLOR_TOLERANCE_MAX
            )
        )
    return TrackerConfig(
        source=source,
        camera_index=camera_index,
        target=target,
        color_preset=color_preset,
        color_tolerance=color_tolerance,
    )


class StaleStreamError(Exception):
    """The expected stream id no longer matches; another tab applied a change."""


class ControllerBusyError(Exception):
    """The previous camera worker is still stopping; nothing was reopened."""


@dataclass(frozen=True)
class WorkerCallbacks:
    """Callbacks handed to a worker for one run; all are generation-fenced."""

    on_frame: Callable
    on_spatial: Callable
    on_thumb: Callable
    on_status: Callable


class _Run:
    """One physical worker attempt; ``active=False`` fences all callbacks."""

    def __init__(self, worker: Any, source_run_id: str) -> None:
        self.worker = worker
        self.source_run_id = source_run_id
        self.error: Optional[str] = None
        self.active = True


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def depthai_installed() -> bool:
    return importlib.util.find_spec("depthai") is not None


def default_worker_factory(
    config: TrackerConfig,
    callbacks: WorkerCallbacks,
    logger=None,
):
    if config.source == "oak":
        from tracker.depth_camera import DepthCameraWorker

        depth = DepthConfig(
            target=config.target,
            color_preset=config.color_preset,
            color_tolerance=config.color_tolerance,
        )
        return DepthCameraWorker(
            depth,
            callbacks.on_spatial,
            callbacks.on_thumb,
            callbacks.on_status,
            logger=logger,
        )
    from tracker.camera import CameraWorker

    return CameraWorker(
        config.camera_index,
        callbacks.on_frame,
        callbacks.on_thumb,
        callbacks.on_status,
    )


class TrackerController:
    """Serialize source/config transitions and fence stale worker output."""

    def __init__(
        self,
        broadcaster,
        *,
        worker_factory: Optional[Callable] = None,
        clock: Callable[[], float] = time.monotonic,
        logger=None,
        join_timeout_s: float = STOP_JOIN_TIMEOUT_S,
    ) -> None:
        self._broadcaster = broadcaster
        self._worker_factory = worker_factory or default_worker_factory
        self._clock = clock
        self._logger = logger
        self._join_timeout_s = float(join_timeout_s)
        self._lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._config = TrackerConfig()
        self._stream_id = _new_id()
        self._source_run_id: Optional[str] = None
        self._run: Optional[_Run] = None
        self._depth_revision = 0
        self._seq = 0
        self._camera = "starting"
        self._message = "Starting"

    @property
    def current_config(self) -> TrackerConfig:
        return self._config

    @property
    def stream_id(self) -> str:
        return self._stream_id

    def snapshot(self) -> dict[str, Any]:
        """Canonical GET/POST response; serverTimeMs sampled last."""

        config = config_to_json(self._config)
        capabilities = self.capabilities()
        return {
            "ok": True,
            "config": config,
            "camera": self._camera,
            "message": self._message,
            "streamId": self._stream_id,
            "sourceRunId": self._source_run_id,
            "capabilities": capabilities,
            "serverTimeMs": int(round(self._clock() * 1000.0)),
        }

    @staticmethod
    def capabilities() -> dict[str, Any]:
        return {
            "sources": list(SOURCES),
            "depthTargets": list(DEPTH_TARGETS),
            "depthaiInstalled": depthai_installed(),
        }

    def _managed(self) -> dict[str, Any]:
        return {
            "streamId": self._stream_id,
            "sourceRunId": self._source_run_id,
            "config": config_to_json(self._config),
        }

    def _bind_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.get_running_loop()
        return self._loop

    def _publish(
        self,
        run: _Run,
        build_message: Callable[[Mapping[str, Any]], dict],
        *,
        depth_revision: Optional[int] = None,
    ) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return

        def deliver() -> None:
            if run is not self._run or not run.active:
                return
            if depth_revision is not None and depth_revision != self._depth_revision:
                return
            try:
                self._broadcaster.publish(build_message(self._managed()))
            except Exception as error:
                run.error = "Tracker serialization failed: {}".format(error)
                self._set_status("error", run.error)

        try:
            loop.call_soon_threadsafe(deliver)
        except RuntimeError:
            pass

    def _publish_status(
        self,
        run: _Run,
        state: str,
        message: str,
        *,
        depth_revision: Optional[int] = None,
    ) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return

        def deliver() -> None:
            if run is not self._run:
                return
            if (
                depth_revision is not None
                and depth_revision != self._depth_revision
                and state not in ("error", "stopped")
            ):
                return
            if state == "error":
                run.error = message
            elif state == "stopped":
                run.active = False
                if run.error:
                    self._set_status("error", run.error)
                    return
            elif state == "starting":
                run.error = None
            self._set_status(state, message)

        try:
            loop.call_soon_threadsafe(deliver)
        except RuntimeError:
            pass

    def _set_status(self, state: str, message: str) -> None:
        """Loop-thread status update published with managed metadata."""

        changed = state != self._camera or message != self._message
        self._camera = state
        self._message = message
        self._broadcaster.publish(
            protocol.status_message(state, message, managed=self._managed())
        )
        if changed:
            print("Camera: {}".format(message), file=sys.stderr, flush=True)

    def _make_callbacks(self, run: _Run) -> WorkerCallbacks:
        def on_frame(target, timestamp_ms, width, height) -> None:
            self._publish(
                run,
                lambda managed: protocol.keycap_message(
                    target, timestamp_ms, width, height, managed=managed
                ),
            )

        def on_spatial(sample) -> None:
            self._publish(
                run,
                lambda managed: self._spatial_message(sample),
                depth_revision=getattr(sample, "revision", None),
            )

        def on_thumb(jpeg, width, height, *, revision=None, keycap_frame=None) -> None:
            if not self._broadcaster.client_count:
                return
            self._publish(
                run,
                lambda managed: protocol.thumb_message(jpeg, width, height, managed=managed, keycap_frame=keycap_frame),
                depth_revision=revision,
            )

        def on_status(state, message, *, revision=None) -> None:
            self._publish_status(run, state, message, depth_revision=revision)

        return WorkerCallbacks(on_frame, on_spatial, on_thumb, on_status)

    def _spatial_message(self, sample) -> dict[str, Any]:
        age_ms = sample.age_ms
        if sample.sample_time_ms is not None:
            age_ms = max(0.0, self._clock() * 1000.0 - sample.sample_time_ms)
        wire = types.SimpleNamespace(
            **{
                name: getattr(sample, name)
                for name in _SPATIAL_SAMPLE_FIELDS
                if name != "age_ms"
            },
            age_ms=age_ms,
        )
        self._seq += 1
        return protocol.spatial_message(
            wire,
            stream_id=self._stream_id,
            source_run_id=self._source_run_id,
            seq=self._seq,
        )

    async def start(self, config: TrackerConfig) -> None:
        """Open the initially configured source; called from app startup."""

        async with self._lock:
            self._bind_loop()
            self._config = config
            self._broadcaster.clear_stream()
            await self._open_source_locked()

    async def apply(
        self,
        config: TrackerConfig,
        *,
        expected_stream_id: Optional[str] = None,
        retry: bool = False,
    ) -> dict[str, Any]:
        """Apply a new configuration; returns the canonical snapshot."""

        async with self._lock:
            self._bind_loop()
            if expected_stream_id is not None and expected_stream_id != self._stream_id:
                raise StaleStreamError("configuration changed; refresh and retry")
            if config == self._config and not retry:
                if not self._needs_reopen():
                    return self.snapshot()
            await self._transition_locked(config, retry=retry)
            return self.snapshot()

    async def shutdown(self) -> None:
        async with self._lock:
            if self._loop is None:
                return
            await self._stop_current_locked()

    def _needs_reopen(self) -> bool:
        if self._config.source == "none":
            return False
        return (
            self._run is None
            or not self._run.active
            or not self._run.worker.is_alive()
        )

    async def _transition_locked(self, config: TrackerConfig, *, retry: bool = False) -> None:
        same_device = (
            not retry
            and config.source == "oak"
            and self._config.source == "oak"
            and self._run is not None
            and self._run.active
            and self._run.worker is not None
            and self._run.worker.is_alive()
            and hasattr(self._run.worker, "update_config")
        )
        if same_device:
            self._depth_revision += 1
            self._config = config
            self._new_stream()
            self._broadcaster.clear_stream()
            self._run.worker.update_config(
                DepthConfig(
                    target=config.target,
                    color_preset=config.color_preset,
                    color_tolerance=config.color_tolerance,
                    revision=self._depth_revision,
                )
            )
            self._set_status(
                "starting", "Applying {} tracking".format(config.target)
            )
            if self._logger is not None:
                self._logger.log(
                    "reconfigure",
                    streamId=self._stream_id,
                    sourceRunId=self._source_run_id,
                    config=config_to_json(config),
                )
            return

        if not await self._stop_current_locked():
            self._set_status(
                "error",
                "The previous camera is still stopping; the change was not applied.",
            )
            raise ControllerBusyError("camera worker did not stop in time")

        changed = config != self._config
        self._config = config
        if changed or retry:
            self._new_stream()
        self._broadcaster.clear_stream()
        await self._open_source_locked()

    async def _open_source_locked(self) -> None:
        self._depth_revision = 0
        if self._config.source == "none":
            self._source_run_id = None
            self._set_status("disabled", "Camera disabled (source: none)")
            return
        run = _Run(None, _new_id())
        callbacks = self._make_callbacks(run)
        self._source_run_id = run.source_run_id
        try:
            run.worker = self._worker_factory(self._config, callbacks, logger=self._logger)
            self._run = run
            self._set_status("starting", "Starting {}".format(self._config.source))
            run.worker.start()
        except Exception as error:
            if self._run is run:
                self._run = None
            self._set_status(
                "error",
                "Could not start {}: {}".format(self._config.source, error),
            )
            return
        if self._logger is not None:
            self._logger.log(
                "open",
                streamId=self._stream_id,
                sourceRunId=self._source_run_id,
                config=config_to_json(self._config),
            )

    async def _stop_current_locked(self) -> bool:
        run = self._run
        if run is None:
            return True
        run.active = False
        worker = run.worker
        if worker is None:
            if self._run is run:
                self._run = None
            return True
        try:
            worker.stop()
        except Exception:
            pass
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, worker.join, self._join_timeout_s)
        except Exception:
            pass
        stopped = not worker.is_alive()
        if stopped and self._run is run:
            self._run = None
        return stopped

    def _new_stream(self) -> None:
        self._stream_id = _new_id()
        self._seq = 0


__all__ = [
    "COLOR_PRESETS",
    "CONFIG_FIELDS",
    "ControllerBusyError",
    "DEPTH_TARGETS",
    "SOURCES",
    "StaleStreamError",
    "TrackerConfig",
    "TrackerController",
    "WorkerCallbacks",
    "config_from_json",
    "config_to_json",
    "default_worker_factory",
    "depthai_installed",
]
