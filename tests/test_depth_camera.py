"""Depth camera worker tests with fake frames, clocks and queues; no SDK."""

from __future__ import annotations

from datetime import timedelta
import queue
import sys
import time
import types
import unittest

import numpy as np

from tracker import depth_camera as dc
from tracker.depth_camera import DepthCameraWorker, DepthConfig, FramePair
from tracker.depth_tracking import (
    MAX_PAIR_SKEW_MS,
    MAX_SAMPLE_AGE_MS,
    RELOCK_FRAMES,
    pixel_to_xyz,
)


INTRINSICS = (100.0, 100.0, 50.0, 40.0)
HOST_OFFSET_MS = 500_000.0


class ManualClock:
    def __init__(self, start_s=500.0):
        self.value = float(start_s)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class FakeSession:
    frame_size = (100, 80)

    def __init__(self, intrinsics=INTRINSICS, clock=None):
        self.intrinsics = intrinsics
        self._clock = clock
        self._pairs = queue.Queue()
        self.closed = False

    def push(self, pair):
        self._pairs.put(pair)

    def poll(self):
        try:
            pair = self._pairs.get_nowait()
        except queue.Empty:
            return None
        if self._clock is not None:
            synced = (pair.now_ms + HOST_OFFSET_MS) / 1000.0
            self._clock.value = max(self._clock.value, synced)
        return pair

    def close(self):
        self.closed = True


def _rgb_with_blob(center=(60, 40), bgr=(40, 220, 40), size=(80, 100)):
    import cv2

    frame = np.zeros((size[0], size[1], 3), dtype=np.uint8)
    if center is not None:
        cv2.circle(frame, center, 5, bgr, -1)
    return frame


def _depth(size=(80, 100), z=500.0):
    return np.full(size, z, dtype=np.float64)


def _pair(seq, sdk_ts, skew_ms=0.0, age_ms=7.0, rgb=None, depth=None):
    return FramePair(
        rgb=_rgb_with_blob() if rgb is None else rgb,
        depth=_depth() if depth is None else depth,
        rgb_ts_ms=float(sdk_ts),
        depth_ts_ms=float(sdk_ts + skew_ms),
        now_ms=float(sdk_ts + age_ms),
        seq=int(seq),
    )


class WorkerHarness:
    def __init__(self, session=None, clock=None, config=None, detector_factory=None):
        self.samples = []
        self.statuses = []
        self.thumbs = []
        self.clock = clock or ManualClock()
        self.session = session or FakeSession(clock=self.clock)
        self.worker = DepthCameraWorker(
            config or DepthConfig(target="keycap", color_preset="green", color_tolerance=1.0),
            self.samples.append,
            lambda jpeg, w, h, revision=0: self.thumbs.append((jpeg, w, h, revision)),
            lambda state, message, revision=0: self.statuses.append((state, message, revision)),
            session=self.session,
            detector_factory=detector_factory,
            clock=self.clock,
        )
        self.worker.start()

    def wait_for(self, predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False

    def consumed(self, count, timeout=3.0):
        return self.wait_for(lambda: len(self.samples) >= count, timeout)

    def stop(self):
        self.worker.stop()
        self.worker.join(3.0)


def _push_tracked(session, count=RELOCK_FRAMES + 2, seq0=1, sdk0=1000.0):
    for index in range(count):
        session.push(_pair(seq0 + index, sdk0 + index * 33.0))


class DepthCameraWorkerTests(unittest.TestCase):
    def test_color_target_tracks_and_mirrors_pixel(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        harness.stop()
        tracked = [s for s in harness.samples if s.state == "tracked"]
        self.assertTrue(tracked)
        last = tracked[-1]
        expected = pixel_to_xyz(60.0, 40.0, 500.0, *INTRINSICS)
        np.testing.assert_allclose(last.camera_mm, expected, atol=5.0)
        self.assertAlmostEqual(last.pixel[0], 99.0 - 60.5, places=3)
        self.assertAlmostEqual(last.pixel[1], 40.5, places=3)
        self.assertEqual(last.target, "keycap")
        self.assertEqual(last.revision, 0)
        self.assertEqual((last.frame_w, last.frame_h), (100, 80))
        self.assertTrue(last.fresh)
        self.assertEqual(harness.statuses[0][0], "starting")
        self.assertIn(("ready", "Depth camera ready", 0), harness.statuses)
        self.assertEqual(harness.statuses[-1][0], "stopped")
        self.assertTrue(harness.session.closed)

    def test_no_sdk_or_mediapipe_import_in_color_mode(self) -> None:
        harness = WorkerHarness()
        saved = {name: sys.modules.get(name) for name in ("depthai", "mediapipe")}
        sys.modules["depthai"] = None
        sys.modules["mediapipe"] = None
        try:
            _push_tracked(harness.session)
            self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
            harness.stop()
        errors = [s for s in harness.statuses if s[0] == "error"]
        self.assertEqual(errors, [])

    def test_age_and_skew_rejected(self) -> None:
        harness = WorkerHarness()
        harness.session.push(_pair(1, 1000.0, age_ms=MAX_SAMPLE_AGE_MS + 1.0))
        harness.session.push(_pair(2, 2000.0, skew_ms=MAX_PAIR_SKEW_MS + 1.0))
        self.assertTrue(harness.consumed(2))
        harness.stop()
        self.assertEqual(harness.samples[0].reason, "stale")
        self.assertEqual(harness.samples[1].reason, "pair_skew")
        self.assertFalse(harness.samples[0].fresh)
        self.assertIsNone(harness.samples[0].camera_mm)
        self.assertEqual(harness.samples[1].pair_skew_ms, MAX_PAIR_SKEW_MS + 1.0)

    def test_duplicate_and_backward_captures_emit_misses(self) -> None:
        harness = WorkerHarness()
        for index, seq in enumerate((1, 2, 2, 3, 2, 4)):
            harness.session.push(_pair(seq, 1000.0 + index * 33.0))
        self.assertTrue(harness.consumed(6))
        harness.stop()
        self.assertEqual(len(harness.samples), 6)
        self.assertEqual(harness.samples[2].reason, "duplicate")
        self.assertEqual(harness.samples[4].reason, "duplicate")
        self.assertFalse(any(s.state == "tracked" for s in harness.samples))

    def test_bad_frame_shapes_rejected(self) -> None:
        harness = WorkerHarness()
        harness.session.push(_pair(1, 1000.0, depth=np.zeros((40, 50))))
        harness.session.push(_pair(2, 1033.0, rgb=np.zeros((80, 100))))
        harness.session.push(_pair(3, 1066.0, rgb=np.zeros((80, 100, 4), dtype=np.uint8)))
        self.assertTrue(harness.consumed(3))
        harness.stop()
        self.assertEqual([s.reason for s in harness.samples], ["bad_shape"] * 3)

    def test_capture_intervals_and_trusted_age_preserved(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        harness.stop()
        tracked = [s for s in harness.samples if s.state == "tracked"]
        times = [s.sample_time_ms for s in tracked]
        for first, second in zip(times, times[1:]):
            self.assertAlmostEqual(second - first, 33.0, places=6)
        self.assertAlmostEqual(tracked[-1].age_ms, 7.0, places=3)
        wire_times = [s.t_ms for s in harness.samples]
        self.assertEqual(wire_times, sorted(wire_times))

    def test_held_age_measures_trusted_sample_age(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        tracked = harness.samples[-1]
        self.assertEqual(tracked.state, "tracked")
        harness.session.push(
            _pair(50, 1300.0, rgb=_rgb_with_blob(center=(30, 40)), depth=np.zeros((80, 100)))
        )
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 3))
        harness.stop()
        held = harness.samples[-1]
        self.assertEqual(held.state, "held")
        self.assertFalse(held.fresh)
        np.testing.assert_allclose(held.camera_mm, tracked.camera_mm)
        self.assertEqual(held.sample_time_ms, tracked.sample_time_ms)
        expected_now = 1300.0 + 7.0 + HOST_OFFSET_MS
        self.assertAlmostEqual(held.age_ms, expected_now - tracked.sample_time_ms, places=3)
        self.assertNotAlmostEqual(held.age_ms, 7.0, places=3)

    def test_repeated_duplicate_captures_expire_trusted_point(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        harness.session.push(
            FramePair(
                rgb=_rgb_with_blob(),
                depth=_depth(),
                rgb_ts_ms=1198.0,
                depth_ts_ms=1198.0,
                now_ms=1198.0 + 7.0 + 310.0,
                seq=99,
            )
        )
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 3))
        harness.stop()
        lost = harness.samples[-1]
        self.assertEqual(lost.state, "lost")
        self.assertEqual(lost.reason, "duplicate")
        self.assertIsNone(lost.camera_mm)

    def test_detector_latency_rejects_stale_after_inference(self) -> None:
        clock = ManualClock()

        class SlowDetector:
            def update(self, rgb, ts, tolerance):
                clock.advance(0.25)
                return None

            def close(self):
                pass

        harness = WorkerHarness(
            clock=clock,
            config=DepthConfig(target="keycap"),
            detector_factory=SlowDetector,
        )
        harness.session.push(_pair(1, 1000.0))
        self.assertTrue(harness.consumed(1))
        harness.stop()
        self.assertEqual(harness.samples[0].reason, "stale")
        self.assertFalse(harness.samples[0].fresh)

    def test_watchdog_t_then_earlier_capture_stays_monotonic(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        harness.clock.advance(0.35)
        self.assertTrue(
            harness.wait_for(lambda: any(s.reason == "stall" for s in harness.samples), timeout=2.0)
        )
        stall_t = harness.samples[-1].t_ms
        harness.clock.advance(0.05)
        for index in range(RELOCK_FRAMES + 1):
            harness.session.push(_pair(60 + index, 1450.0 + index * 33.0, age_ms=10.0))
        self.assertTrue(
            harness.wait_for(
                lambda: any(
                    s.reason != "stall" and s.t_ms >= stall_t and s.state == "tracked"
                    for s in harness.samples
                ),
                timeout=2.0,
            )
        )
        harness.stop()
        post = [s for s in harness.samples if s.reason != "stall" and s.t_ms >= stall_t]
        self.assertTrue(all(s.t_ms >= stall_t for s in post))
        wire_times = [s.t_ms for s in harness.samples]
        self.assertEqual(wire_times, sorted(wire_times))
        tracked = next(s for s in post if s.state == "tracked")
        # The RGB identity survives this 252 ms capture gap, but depth still
        # requires its full cluster of fresh samples before relocking.
        self.assertEqual(tracked.sample_time_ms, 1450.0 + (RELOCK_FRAMES - 1) * 33.0 + HOST_OFFSET_MS)
        self.assertNotEqual(tracked.sample_time_ms, tracked.t_ms)

    def test_stall_after_tracked_ends_lost_and_stoppable(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        harness.clock.advance(0.35)
        self.assertTrue(
            harness.wait_for(lambda: any(s.reason == "stall" for s in harness.samples), timeout=2.0)
        )
        self.assertTrue(
            harness.wait_for(lambda: any(s.state == "lost" for s in harness.samples), timeout=2.0)
        )
        harness.stop()
        self.assertFalse(harness.worker.is_alive())
        self.assertEqual(harness.statuses[-1][0], "stopped")

    def test_empty_stream_nonfresh_then_bounded_error(self) -> None:
        harness = WorkerHarness()
        harness.clock.advance(0.35)
        self.assertTrue(
            harness.wait_for(lambda: any(s.reason == "stall" for s in harness.samples), timeout=2.0)
        )
        self.assertFalse(harness.samples[-1].fresh)
        harness.clock.advance(3.0)
        self.assertTrue(harness.wait_for(lambda: any(s[0] == "error" for s in harness.statuses)))
        harness.stop()
        errors = [s for s in harness.statuses if s[0] == "error"]
        self.assertIn("synchronized", errors[0][1])
        self.assertEqual(harness.statuses[-1][0], "stopped")
        self.assertTrue(harness.session.closed)

    def test_held_xyz_survives_pixel_motion(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        tracked = harness.samples[-1]
        self.assertEqual(tracked.state, "tracked")
        harness.session.push(
            _pair(50, 1300.0, rgb=_rgb_with_blob(center=(30, 40)), depth=np.zeros((80, 100)))
        )
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 3))
        harness.stop()
        held = harness.samples[-1]
        self.assertEqual(held.state, "held")
        self.assertFalse(held.fresh)
        np.testing.assert_allclose(held.camera_mm, tracked.camera_mm)
        self.assertAlmostEqual(held.pixel[0], 99.0 - 30.5, places=3)
        self.assertEqual(held.sample_time_ms, tracked.sample_time_ms)

    def test_invalid_intrinsics_report_error_and_close_session(self) -> None:
        clock = ManualClock()
        session = FakeSession(intrinsics=(0.0, 0.0, 0.0, 0.0), clock=clock)
        harness = WorkerHarness(session=session, clock=clock)
        self.assertTrue(harness.wait_for(lambda: any(s[0] == "error" for s in harness.statuses)))
        harness.stop()
        self.assertIn("intrinsics", harness.statuses[-2][1])
        self.assertTrue(session.closed)

    def test_stop_with_empty_queue(self) -> None:
        harness = WorkerHarness()
        time.sleep(0.05)
        harness.stop()
        self.assertFalse(harness.worker.is_alive())
        self.assertEqual(harness.statuses[-1][0], "stopped")

    def test_revision_switch_resets_tracking_and_tags(self) -> None:
        harness = WorkerHarness()
        _push_tracked(harness.session)
        self.assertTrue(harness.consumed(RELOCK_FRAMES + 2))
        pre_count = len(harness.samples)
        tracked = harness.samples[-1]
        harness.worker.update_config(
            DepthConfig(target="keycap", color_preset="green", color_tolerance=1.0, revision=1)
        )
        for index in range(RELOCK_FRAMES + 2):
            harness.session.push(_pair(50 + index, 3000.0 + index * 33.0))
        self.assertTrue(
            harness.wait_for(
                lambda: any(s.state == "tracked" for s in harness.samples[pre_count:])
            )
        )
        harness.stop()
        self.assertTrue(all(s.revision == 0 for s in harness.samples[:pre_count]))
        fresh = harness.samples[pre_count:]
        self.assertTrue(all(s.revision == 1 for s in fresh))
        self.assertIn(("ready", "Depth camera ready", 1), harness.statuses)
        self.assertEqual(fresh[0].state, "acquiring")
        self.assertEqual(fresh[0].tracking_epoch, 0)
        later = [s for s in fresh if s.state == "tracked"]
        self.assertTrue(later)
        self.assertEqual(later[-1].tracking_epoch, tracked.tracking_epoch)





class _FakePort:
    def __init__(self, node, name):
        self.node = node
        self.name = name

    def link(self, other):
        self.node.pipeline.links.append(
            (self.node.name, self.name, other.node.name, other.name)
        )

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self.node.calls.append((self.name + "." + name, args, kwargs))

        return method


class _FakeInputs:
    def __init__(self, node):
        self._node = node
        self._ports = {}

    def __getitem__(self, name):
        if name not in self._ports:
            self._ports[name] = _FakePort(self._node, name)
        return self._ports[name]


class _FakeNode:
    def __init__(self, pipeline, name, ports=()):
        self.pipeline = pipeline
        self.name = name
        self.calls = []
        for port in ports:
            setattr(self, port, _FakePort(self, port))
        self.initialControl = _FakePort(self, "initialControl")
        self.initialConfig = _FakePort(self, "initialConfig")
        self.inputs = _FakeInputs(self)

    def __getattr__(self, name):
        def method(*args, **kwargs):
            self.calls.append((name, args, kwargs))

        return method


class _FakeColorCamera(_FakeNode):
    def __init__(self, pipeline, name):
        super().__init__(pipeline, name, ports=("isp", "out"))


class _FakeMonoCamera(_FakeNode):
    def __init__(self, pipeline, name):
        super().__init__(pipeline, name, ports=("out",))


class _FakeStereoDepth(_FakeNode):
    PresetMode = types.SimpleNamespace(HIGH_DENSITY="HIGH_DENSITY")

    def __init__(self, pipeline, name):
        super().__init__(pipeline, name, ports=("left", "right", "depth"))


class _FakeSync(_FakeNode):
    def __init__(self, pipeline, name):
        super().__init__(pipeline, name, ports=("out",))


class _FakeXLinkOut(_FakeNode):
    def __init__(self, pipeline, name):
        super().__init__(pipeline, name, ports=("input",))


class _FakePipeline:
    def __init__(self):
        self.nodes = []
        self.links = []
        self._counts = {}

    def create(self, node_cls):
        base = node_cls.__name__
        index = self._counts.get(base, 0)
        self._counts[base] = index + 1
        name = base if index == 0 else "{}{}".format(base, index)
        node = node_cls(self, name)
        self.nodes.append(node)
        return node


class _FakeCalib:
    def __init__(self, bad=False):
        self.bad = bad

    def getLensPosition(self, socket):
        return 120

    def getCameraIntrinsics(self, socket, width, height):
        if self.bad:
            return [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]]
        return [[100.0, 0.0, 50.0], [0.0, 100.0, 40.0], [0.0, 0.0, 1.0]]


class _FakeQueue:
    def __init__(self, packets=()):
        self._packets = list(packets)

    def tryGet(self):
        return self._packets.pop(0) if self._packets else None


class _FakeDevice:
    def __init__(self, calib=None, out_queue=None, fail=None):
        self.calib = calib if calib is not None else _FakeCalib()
        self.out_queue = out_queue if out_queue is not None else _FakeQueue()
        self.fail = fail
        self.closed = False
        self.started = False

    def readCalibration2(self):
        return self.calib

    def startPipeline(self, pipeline):
        self.started = True
        if self.fail == "pipeline":
            raise RuntimeError("pipeline start failed")

    def getOutputQueue(self, *args, **kwargs):
        if self.fail == "queue":
            raise RuntimeError("queue open failed")
        return self.out_queue

    def close(self):
        self.closed = True


class _FakeImgMsg:
    def __init__(self, frame, ts_ms, seq):
        self._frame = frame
        self._ts = ts_ms
        self._seq = seq

    def getCvFrame(self):
        return self._frame

    def getTimestamp(self):
        return self._ts

    def getSequenceNum(self):
        return self._seq


class _FakeDepthMsg:
    def __init__(self, frame, ts_ms):
        self._frame = frame
        self._ts = ts_ms

    def getFrame(self):
        return self._frame

    def getTimestamp(self):
        return self._ts


def _fake_dai(device=None):
    dai = types.SimpleNamespace()
    dai.Pipeline = _FakePipeline
    dai.node = types.SimpleNamespace(
        ColorCamera=_FakeColorCamera,
        MonoCamera=_FakeMonoCamera,
        StereoDepth=_FakeStereoDepth,
        Sync=_FakeSync,
        XLinkOut=_FakeXLinkOut,
    )
    dai.CameraBoardSocket = types.SimpleNamespace(CAM_A="A", CAM_B="B", CAM_C="C")
    dai.ColorCameraProperties = types.SimpleNamespace(
        SensorResolution=types.SimpleNamespace(THE_1080_P="1080p"),
        ColorOrder=types.SimpleNamespace(BGR="BGR"),
    )
    dai.MonoCameraProperties = types.SimpleNamespace(
        SensorResolution=types.SimpleNamespace(THE_400_P="400p")
    )
    dai.MedianFilter = types.SimpleNamespace(KERNEL_7x7="7x7")
    dai.Clock = types.SimpleNamespace(now=lambda: timedelta(seconds=1.0))
    if device is not None:
        dai.Device = lambda: device
    return dai


class PipelineAndSessionTests(unittest.TestCase):
    def test_pipeline_links_all_required_nodes(self) -> None:
        dai = _fake_dai()
        pipeline = dc.build_pipeline(dai, dai.CameraBoardSocket.CAM_A, 120)
        self.assertEqual(
            set(pipeline.links),
            {
                ("_FakeMonoCamera", "out", "_FakeStereoDepth", "left"),
                ("_FakeMonoCamera1", "out", "_FakeStereoDepth", "right"),
                ("_FakeColorCamera", "isp", "_FakeSync", "rgb"),
                ("_FakeStereoDepth", "depth", "_FakeSync", "depth"),
                ("_FakeSync", "out", "_FakeXLinkOut", "input"),
            },
        )

    def test_oak_session_open_success_and_close(self) -> None:
        device = _FakeDevice()
        session = dc.OakSession.open(_fake_dai(device=device))
        self.assertEqual(session.intrinsics, INTRINSICS)
        self.assertTrue(device.started)
        self.assertFalse(device.closed)
        session.close()
        self.assertTrue(device.closed)

    def test_oak_session_open_closes_device_on_failures(self) -> None:
        for fail in ("pipeline", "queue"):
            with self.subTest(fail=fail):
                device = _FakeDevice(fail=fail)
                with self.assertRaises(Exception):
                    dc.OakSession.open(_fake_dai(device=device))
                self.assertTrue(device.closed)
        bad = _FakeDevice(calib=_FakeCalib(bad=True))
        with self.assertRaises(RuntimeError):
            dc.OakSession.open(_fake_dai(device=bad))
        self.assertTrue(bad.closed)

    def test_oak_session_poll_drains_to_newest_complete_pair(self) -> None:
        dai = _fake_dai()
        rgb = np.zeros((80, 100, 3), dtype=np.uint8)
        depth = np.zeros((80, 100), dtype=np.float64)
        groups = [
            {"rgb": _FakeImgMsg(rgb, 1000.0, 1), "depth": _FakeDepthMsg(depth, 1000.0)},
            {"rgb": _FakeImgMsg(rgb, 1033.0, 2)},
            {"rgb": _FakeImgMsg(rgb, 1066.0, 3), "depth": _FakeDepthMsg(depth, 1066.0)},
        ]
        session = dc.OakSession(dai, _FakeDevice(), _FakeQueue(groups), INTRINSICS)
        pair = session.poll()
        self.assertIsNotNone(pair)
        self.assertEqual(pair.seq, 3)
        self.assertAlmostEqual(pair.rgb_ts_ms, 1066.0)
        self.assertIsNone(session.poll())


if __name__ == "__main__":
    unittest.main()
