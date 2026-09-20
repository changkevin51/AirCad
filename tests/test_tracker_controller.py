"""Controller lifecycle tests with fake workers; no cameras involved."""

from __future__ import annotations

import asyncio
import dataclasses
import sys
import unittest
from unittest import mock

from tracker.controller import (
    ControllerBusyError,
    StaleStreamError,
    TrackerConfig,
    TrackerController,
)


class FakeBroadcaster:
    def __init__(self):
        self.messages = []
        self.last_status = None
        self.client_count = 1
        self.cleared = 0

    def publish(self, message):
        self.messages.append(message)
        if message.get("type") == "status":
            self.last_status = message

    def clear_stream(self):
        self.cleared += 1


class FakeWorker:
    instances = []

    def __init__(self, config, callbacks, logger=None, die_on_stop=True):
        self.config = config
        self.callbacks = callbacks
        self.logger = logger
        self.die_on_stop = die_on_stop
        self.alive = False
        self.stop_calls = 0
        self.updates = []
        FakeWorker.instances.append(self)

    def start(self):
        self.alive = True

    def stop(self):
        self.stop_calls += 1
        if self.die_on_stop:
            self.alive = False

    def join(self, timeout=None):
        self.joined = timeout

    def is_alive(self):
        return self.alive

    def update_config(self, config):
        self.updates.append(config)

    def status(self, state, message, revision=None):
        self.callbacks.on_status(state, message, revision=revision)


class FakeSpatialWorker(FakeWorker):
    def spatial(self, sample):
        self.callbacks.on_spatial(sample)

    def thumb(self, jpeg, width, height, revision=None):
        self.callbacks.on_thumb(jpeg, width, height, revision=revision)


def _factory(config, callbacks, logger=None, worker_cls=FakeWorker):
    return worker_cls(config, callbacks, logger=logger)


def _spatial_factory(config, callbacks, logger=None):
    return FakeSpatialWorker(config, callbacks, logger=logger)


def _spatial_sample(state="tracked", epoch=0, target="keycap", revision=0):
    from tracker.depth_camera import SpatialSample

    has_point = state in ("tracked", "held")
    return SpatialSample(
        t_ms=1000.0,
        sample_time_ms=990.0 if has_point else None,
        age_ms=10.0 if has_point else None,
        target=target,
        tracking_epoch=epoch,
        frame_w=1280,
        frame_h=720,
        pixel=(640.0, 360.0) if has_point else None,
        camera_mm=(10.0, 20.0, 500.0) if has_point else None,
        state=state,
        fresh=state == "tracked",
        reason=None if state == "tracked" else "no_target",
        valid_pixels=100,
        roi_count=2,
        spread_mm=12.0,
        pair_skew_ms=3.0,
        revision=revision,
    )


async def _flush():
    for _ in range(3):
        await asyncio.sleep(0)


class TrackerControllerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeWorker.instances = []
        self.broadcaster = FakeBroadcaster()
        self.controller = TrackerController(
            self.broadcaster, worker_factory=_factory, join_timeout_s=0.05
        )

    async def test_start_opens_configured_source(self):
        await self.controller.start(TrackerConfig(source="webcam", camera_index=1))
        self.assertEqual(len(FakeWorker.instances), 1)
        worker = FakeWorker.instances[0]
        self.assertTrue(worker.alive)
        self.assertEqual(worker.config.camera_index, 1)
        with mock.patch("tracker.controller.depthai_installed", return_value=False):
            snapshot = self.controller.snapshot()
        self.assertEqual(snapshot["camera"], "starting")
        self.assertTrue(snapshot["streamId"])
        self.assertTrue(snapshot["sourceRunId"])
        self.assertIsInstance(snapshot["serverTimeMs"], (int, float))
        self.assertEqual(
            snapshot["capabilities"]["sources"], ["webcam", "oak", "none"]
        )
        self.assertFalse(snapshot["capabilities"]["depthaiInstalled"])
        self.assertEqual(
            snapshot["config"],
            {
                "source": "webcam",
                "cameraIndex": 1,
                "target": "keycap",
                "colorPreset": "green",
                "colorTolerance": 1.0,
            },
        )

    def test_depthai_capability_probe_is_mockable(self):
        with mock.patch("tracker.controller.depthai_installed", return_value=True):
            self.assertTrue(self.controller.capabilities()["depthaiInstalled"])
        with mock.patch("tracker.controller.depthai_installed", return_value=False):
            self.assertFalse(self.controller.capabilities()["depthaiInstalled"])

    async def test_identical_apply_is_noop(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        stream = self.controller.stream_id
        await self.controller.apply(TrackerConfig(source="webcam"))
        self.assertEqual(len(FakeWorker.instances), 1)
        self.assertEqual(self.controller.stream_id, stream)

    async def test_source_switch_stops_old_worker(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        old = FakeWorker.instances[0]
        stream = self.controller.stream_id
        run = self.controller.snapshot()["sourceRunId"]
        await self.controller.apply(TrackerConfig(source="oak"), expected_stream_id=stream)
        self.assertFalse(old.alive)
        self.assertEqual(old.stop_calls, 1)
        self.assertEqual(len(FakeWorker.instances), 2)
        snapshot = self.controller.snapshot()
        self.assertNotEqual(snapshot["streamId"], stream)
        self.assertNotEqual(snapshot["sourceRunId"], run)

    async def test_target_change_on_same_oak_keeps_device_and_run(self):
        await self.controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        run = self.controller.snapshot()["sourceRunId"]
        stream = self.controller.stream_id
        await self.controller.apply(
            TrackerConfig(source="oak", target="keycap", color_tolerance=1.5),
            expected_stream_id=stream,
        )
        self.assertEqual(len(FakeWorker.instances), 1)
        self.assertTrue(worker.alive)
        self.assertEqual(len(worker.updates), 1)
        self.assertEqual(worker.updates[0].target, "keycap")
        self.assertEqual(worker.updates[0].color_tolerance, 1.5)
        self.assertEqual(worker.updates[0].revision, 1)
        snapshot = self.controller.snapshot()
        self.assertNotEqual(snapshot["streamId"], stream)
        self.assertEqual(snapshot["sourceRunId"], run)

    async def test_retry_restarts_source_and_rotates_stream(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        old = FakeWorker.instances[0]
        stream = self.controller.stream_id
        run = self.controller.snapshot()["sourceRunId"]
        await self.controller.apply(
            TrackerConfig(source="webcam"), expected_stream_id=stream, retry=True
        )
        self.assertFalse(old.alive)
        self.assertEqual(len(FakeWorker.instances), 2)
        snapshot = self.controller.snapshot()
        self.assertNotEqual(snapshot["streamId"], stream)
        self.assertNotEqual(snapshot["sourceRunId"], run)

    async def test_none_source_disables(self):
        await self.controller.start(TrackerConfig(source="none"))
        self.assertEqual(len(FakeWorker.instances), 0)
        snapshot = self.controller.snapshot()
        self.assertEqual(snapshot["camera"], "disabled")
        self.assertIsNone(snapshot["sourceRunId"])

    async def test_late_callbacks_after_switch_to_none_are_fenced(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        old = FakeWorker.instances[0]
        stream = self.controller.stream_id
        await self.controller.apply(TrackerConfig(source="none"), expected_stream_id=stream)
        self.assertEqual(self.broadcaster.last_status["camera"], "disabled")
        before = len(self.broadcaster.messages)
        old.status("ready", "late ready")
        old.status("stopped", "late stopped")
        await _flush()
        self.assertEqual(len(self.broadcaster.messages), before)
        self.assertEqual(self.broadcaster.last_status["camera"], "disabled")

    async def test_stale_expected_stream_rejected(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        with self.assertRaises(StaleStreamError):
            await self.controller.apply(
                TrackerConfig(source="oak"), expected_stream_id="bogus"
            )

    async def test_late_callbacks_from_old_worker_are_fenced(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        old = FakeWorker.instances[0]
        stream = self.controller.stream_id
        await self.controller.apply(TrackerConfig(source="oak"), expected_stream_id=stream)
        before = len(self.broadcaster.messages)
        old.status("ready", "late ready")
        await _flush()
        self.assertEqual(len(self.broadcaster.messages), before)
        self.assertNotEqual(self.broadcaster.last_status.get("camera"), "ready")

    async def test_error_survives_worker_stopped(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        worker = FakeWorker.instances[0]
        worker.status("error", "Device unplugged")
        await _flush()
        worker.status("stopped", "Camera stopped")
        await _flush()
        snapshot = self.controller.snapshot()
        self.assertEqual(snapshot["camera"], "error")
        self.assertEqual(snapshot["message"], "Device unplugged")

    async def test_busy_when_worker_wont_stop(self):
        def stuck_factory(config, callbacks, logger=None):
            return FakeWorker(config, callbacks, logger=logger, die_on_stop=False)

        controller = TrackerController(
            self.broadcaster, worker_factory=stuck_factory, join_timeout_s=0.01
        )
        await controller.start(TrackerConfig(source="webcam"))
        stream = controller.stream_id
        with self.assertRaises(ControllerBusyError):
            await controller.apply(
                TrackerConfig(source="oak"), expected_stream_id=stream
            )
        self.assertEqual(len(FakeWorker.instances), 1)
        self.assertEqual(controller.snapshot()["camera"], "error")

    async def test_inactive_worker_is_not_same_device_updated(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.01
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        worker.die_on_stop = False
        worker.status("stopped", "Camera stopped")
        await _flush()
        with self.assertRaises(ControllerBusyError):
            await controller.apply(
                TrackerConfig(source="oak", target="keycap"),
                expected_stream_id=controller.stream_id,
            )
        self.assertEqual(worker.updates, [])

    async def test_same_device_revision_fencing(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        worker.spatial(_spatial_sample(revision=0))
        worker.thumb("jpeg0", 10, 10, revision=0)
        worker.status("ready", "old ready", revision=0)
        await controller.apply(
            TrackerConfig(source="oak", target="keycap", color_tolerance=1.5),
            expected_stream_id=controller.stream_id,
        )
        await _flush()
        self.assertFalse(
            any(m.get("type") == "spatial" for m in self.broadcaster.messages)
        )
        self.assertFalse(
            any(m.get("type") == "thumb" for m in self.broadcaster.messages)
        )
        self.assertEqual(self.broadcaster.last_status["camera"], "starting")
        worker.spatial(_spatial_sample(revision=1, target="keycap"))
        await _flush()
        spatial = [m for m in self.broadcaster.messages if m.get("type") == "spatial"]
        self.assertEqual(len(spatial), 1)
        self.assertEqual(spatial[0]["streamId"], controller.stream_id)
        self.assertEqual(spatial[0]["target"], "keycap")
        worker.status("ready", "Depth camera ready", revision=1)
        await _flush()
        self.assertEqual(self.broadcaster.last_status["camera"], "ready")

    async def test_rapid_revision_changes_fence_intermediate(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        worker.spatial(_spatial_sample(revision=1, target="keycap"))
        await controller.apply(
            TrackerConfig(source="oak", target="keycap", color_tolerance=1.5),
            expected_stream_id=controller.stream_id,
        )
        await controller.apply(
            TrackerConfig(source="oak", target="keycap", color_tolerance=1.8),
            expected_stream_id=controller.stream_id,
        )
        await _flush()
        self.assertFalse(
            any(m.get("type") == "spatial" for m in self.broadcaster.messages)
        )
        self.assertEqual(controller._depth_revision, 2)
        worker.spatial(_spatial_sample(revision=1, target="keycap"))
        await _flush()
        self.assertFalse(
            any(m.get("type") == "spatial" for m in self.broadcaster.messages)
        )
        worker.spatial(_spatial_sample(revision=2, target="keycap"))
        await _flush()
        spatial = [m for m in self.broadcaster.messages if m.get("type") == "spatial"]
        self.assertEqual(len(spatial), 1)
        self.assertEqual(spatial[0]["target"], "keycap")
        self.assertEqual(spatial[0]["streamId"], controller.stream_id)

    async def test_old_revision_error_still_reaches_status(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        await controller.apply(
            TrackerConfig(source="oak", target="keycap"),
            expected_stream_id=controller.stream_id,
        )
        self.assertEqual(self.broadcaster.last_status["camera"], "starting")
        worker.status("error", "Device unplugged", revision=0)
        worker.status("stopped", "Camera stopped", revision=0)
        await _flush()
        self.assertEqual(self.broadcaster.last_status["camera"], "error")
        self.assertIn("Device unplugged", self.broadcaster.last_status["message"])
        run = controller._run
        self.assertIsNotNone(run)
        self.assertFalse(run.active)
        await controller.apply(
            TrackerConfig(source="oak"),
            expected_stream_id=controller.stream_id,
            retry=True,
        )
        self.assertEqual(len(FakeWorker.instances), 2)
        self.assertTrue(FakeWorker.instances[1].alive)

    async def test_factory_failure_keeps_error_and_new_run_id(self):
        def boom_factory(config, callbacks, logger=None):
            raise RuntimeError("no device")

        controller = TrackerController(
            self.broadcaster, worker_factory=boom_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["camera"], "error")
        self.assertIn("no device", snapshot["message"])
        self.assertIsNotNone(snapshot["sourceRunId"])

    async def test_bad_spatial_sample_reports_error_not_wire(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        broken = dataclasses.replace(_spatial_sample(), camera_mm=None)
        worker.spatial(broken)
        await _flush()
        self.assertFalse(
            any(m.get("type") == "spatial" for m in self.broadcaster.messages)
        )
        self.assertEqual(self.broadcaster.last_status["camera"], "error")
        self.assertIn("serialization", self.broadcaster.last_status["message"])

    async def test_spatial_publish_carries_stream_tags_and_seq(self):
        controller = TrackerController(
            self.broadcaster, worker_factory=_spatial_factory, join_timeout_s=0.05
        )
        await controller.start(TrackerConfig(source="oak"))
        worker = FakeWorker.instances[0]
        worker.spatial(_spatial_sample())
        worker.spatial(_spatial_sample(state="held"))
        await _flush()
        spatial = [m for m in self.broadcaster.messages if m.get("type") == "spatial"]
        self.assertEqual(len(spatial), 2)
        self.assertEqual(spatial[0]["v"], 2)
        self.assertEqual(spatial[0]["streamId"], controller.stream_id)
        self.assertEqual(spatial[0]["sourceRunId"], controller.snapshot()["sourceRunId"])
        self.assertEqual([m["seq"] for m in spatial], [1, 2])
        self.assertEqual(spatial[0]["frame"], {"w": 1280, "h": 720, "mirrored": True})
        self.assertEqual(spatial[0]["cameraMm"], [10.0, 20.0, 500.0])

    async def test_concurrent_applies_serialized(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        stream = self.controller.stream_id
        first = asyncio.create_task(
            self.controller.apply(TrackerConfig(source="oak"), expected_stream_id=stream)
        )
        second = asyncio.create_task(
            self.controller.apply(
                TrackerConfig(source="none"), expected_stream_id=stream
            )
        )
        result = await asyncio.gather(first, second, return_exceptions=True)
        errors = [r for r in result if isinstance(r, StaleStreamError)]
        oks = [r for r in result if isinstance(r, dict) and r.get("ok")]
        self.assertEqual(len(errors), 1)
        self.assertEqual(len(oks), 1)

    async def test_concurrent_retries_reject_stale_token(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        stream = self.controller.stream_id
        first = asyncio.create_task(
            self.controller.apply(
                TrackerConfig(source="webcam"), expected_stream_id=stream, retry=True
            )
        )
        second = asyncio.create_task(
            self.controller.apply(
                TrackerConfig(source="webcam"), expected_stream_id=stream, retry=True
            )
        )
        result = await asyncio.gather(first, second, return_exceptions=True)
        errors = [r for r in result if isinstance(r, StaleStreamError)]
        oks = [r for r in result if isinstance(r, dict) and r.get("ok")]
        self.assertEqual(len(errors), 1)
        self.assertEqual(len(oks), 1)
        self.assertNotEqual(self.controller.stream_id, stream)

    async def test_shutdown_stops_worker_idempotent(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        worker = FakeWorker.instances[0]
        await self.controller.shutdown()
        self.assertFalse(worker.alive)
        await self.controller.shutdown()

    async def test_managed_status_metadata(self):
        await self.controller.start(TrackerConfig(source="webcam"))
        status = self.broadcaster.last_status
        self.assertEqual(status["type"], "status")
        managed = status["managed"]
        self.assertEqual(managed["streamId"], self.controller.stream_id)
        self.assertIn("sourceRunId", managed)
        self.assertEqual(managed["config"]["source"], "webcam")


class DepthaiImportGuardTests(unittest.TestCase):
    def test_controller_does_not_import_depthai(self) -> None:
        self.assertIsNone(sys.modules.get("depthai"))
        from tracker.controller import depthai_installed

        depthai_installed()
        self.assertIsNone(sys.modules.get("depthai"))


class ConfigValidationTests(unittest.TestCase):
    def test_valid_config_round_trips(self):
        from tracker.controller import config_from_json, config_to_json

        payload = {
            "source": "oak",
            "cameraIndex": 2,
            "target": "keycap",
            "colorPreset": "green",
            "colorTolerance": 1.5,
        }
        config = config_from_json(payload)
        self.assertEqual(config_to_json(config), payload)

    def test_invalid_configs_rejected(self):
        from tracker.controller import config_from_json

        cases = [
            "nope",
            {},
            {"source": "oak"},
            {"source": "bad", "cameraIndex": 0, "target": "keycap", "colorPreset": "green", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": True, "target": "keycap", "colorPreset": "green", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": 33, "target": "keycap", "colorPreset": "green", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": -1, "target": "keycap", "colorPreset": "green", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": 0, "target": "x", "colorPreset": "green", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": 0, "target": "keycap", "colorPreset": "x", "colorTolerance": 1.0},
            {"source": "oak", "cameraIndex": 0, "target": "keycap", "colorPreset": "green", "colorTolerance": 0.4},
            {"source": "oak", "cameraIndex": 0, "target": "keycap", "colorPreset": "green", "colorTolerance": 2.1},
            {"source": "oak", "cameraIndex": 0, "target": "keycap", "colorPreset": "green", "colorTolerance": float("nan")},
            {"source": "oak", "cameraIndex": 0, "target": "keycap", "colorPreset": "green", "colorTolerance": 1.0, "extra": 1},
        ]
        for body in cases:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    config_from_json(body)


if __name__ == "__main__":
    unittest.main()
