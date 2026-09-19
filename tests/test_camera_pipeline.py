"""Headless, behavior-focused checks for the camera/runtime boundary.

The camera and HighGUI surfaces are fakes, but the runtime's observation
conversion, gesture engine, view transform, stroke lifecycle, and shape
fallback remain real.  These checks intentionally avoid opening a physical
camera or native window.
"""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

import hand_tracker
from gesture_engine import ViewTransform


FRAME_WIDTH = 640
FRAME_HEIGHT = 480


class _Landmark:
    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y


class _Category:
    def __init__(self, label: str) -> None:
        self.category_name = label
        self.display_name = label


class _Result:
    def __init__(self, hands: list[tuple[list[tuple[float, float]], str]]) -> None:
        self.hand_landmarks = [
            [_Landmark(x / FRAME_WIDTH, y / FRAME_HEIGHT) for x, y in points]
            for points, _label in hands
        ]
        self.handedness = [[_Category(label)] for _points, label in hands]


def _pinch_points(center: tuple[float, float], pinched: bool) -> list[tuple[float, float]]:
    """Return a compact 21-point fixture with a controllable pinch ratio."""

    x, y = center
    thumb_tip = (x + 3.0, y) if pinched else (x - 52.0, y + 38.0)
    return [
        (x, y + 80.0),
        (x - 10.0, y + 64.0),
        (x - 20.0, y + 52.0),
        (x - 10.0, y + 40.0),
        thumb_tip,
        (x - 10.0, y + 56.0),
        (x - 10.0, y + 40.0),
        (x - 5.0, y + 20.0),
        (x + 5.0, y),
        (x, y + 58.0),
        (x, y + 50.0),
        (x, y + 45.0),
        (x, y + 60.0),
        (x + 14.0, y + 60.0),
        (x + 14.0, y + 52.0),
        (x + 14.0, y + 48.0),
        (x + 14.0, y + 64.0),
        (x + 28.0, y + 65.0),
        (x + 28.0, y + 56.0),
        (x + 28.0, y + 52.0),
        (x + 28.0, y + 68.0),
    ]


def _display_click(
    x: float,
    y: float,
    width: int = FRAME_WIDTH,
    height: int = FRAME_HEIGHT,
) -> tuple[float, float]:
    content_x, content_y, content_width, content_height = hand_tracker.fit_frame_to_display(
        width, height
    )
    return (
        content_x + x * content_width / width,
        content_y + y * content_height / height,
    )


def _result(*hands: tuple[list[tuple[float, float]], str]) -> _Result:
    return _Result(list(hands))


class _Camera:
    def __init__(self, frames: list[np.ndarray]) -> None:
        self.frames = frames
        self.index = 0
        self.released = False
        self.open_args: tuple[object, ...] | None = None

    def isOpened(self) -> bool:
        return True

    def set(self, *_args: object) -> bool:
        return True

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.index >= len(self.frames):
            return False, None
        frame = self.frames[self.index].copy()
        self.index += 1
        return True, frame

    def release(self) -> None:
        self.released = True


class _Landmarker:
    results: list[_Result] = []
    options = None
    instances: list["_Landmarker"] = []

    @classmethod
    def create_from_options(cls, options):
        cls.options = options
        instance = cls()
        cls.instances.append(instance)
        return instance

    def __init__(self) -> None:
        self.index = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> None:
        self.closed = True

    def detect_for_video(self, _image, _timestamp: int) -> _Result:
        if self.index >= len(self.results):
            raise AssertionError("fixture detector ran beyond its finite results")
        result = self.results[self.index]
        self.index += 1
        return result


def _run_main(
    results: list[_Result],
    keys: list[int],
    *,
    frames: list[np.ndarray] | None = None,
    timestamps_ms: list[int] | None = None,
    window_visible: float = 1.0,
    mouse_clicks: list[tuple[int, int] | None] | None = None,
):
    if frames is None:
        frames = [np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 31, dtype=np.uint8) for _ in keys]
    if timestamps_ms is None:
        timestamps_ms = list(range(0, len(keys) * 100, 100))
    if len(frames) != len(keys) or len(timestamps_ms) != len(keys):
        raise ValueError("finite camera, key, and timestamp fixtures must align")
    if mouse_clicks is None:
        mouse_clicks = [None] * len(keys)
    if len(mouse_clicks) != len(keys):
        raise ValueError("finite mouse, key, and timestamp fixtures must align")

    camera = _Camera(frames)
    shown: list[np.ndarray] = []
    key_values = iter(keys)
    timestamp_values = iter(int(value * 1_000_000) for value in timestamps_ms)
    mouse_callback = None
    key_index = 0
    destroyed = False
    _Landmarker.results = results
    _Landmarker.options = None
    _Landmarker.instances = []

    def destroy_windows() -> None:
        nonlocal destroyed
        destroyed = True

    def set_mouse_callback(_name, callback) -> None:
        nonlocal mouse_callback
        mouse_callback = callback

    def wait_key(_delay: int) -> int:
        nonlocal key_index
        click = mouse_clicks[key_index]
        if click is not None:
            if mouse_callback is None:
                raise AssertionError("main loop did not register a HighGUI mouse callback")
            mouse_callback(
                hand_tracker.cv2.EVENT_LBUTTONUP,
                click[0],
                click[1],
                0,
                None,
            )
        key = next(key_values)
        key_index += 1
        return key

    patches = [
        mock.patch.object(hand_tracker, "ensure_model", lambda: None),
        mock.patch.object(hand_tracker.cv2, "VideoCapture", lambda *args: camera),
        mock.patch.object(hand_tracker.cv2, "namedWindow", lambda *_args: None),
        mock.patch.object(hand_tracker.cv2, "resizeWindow", lambda *_args: None),
        mock.patch.object(hand_tracker.cv2, "setMouseCallback", set_mouse_callback),
        mock.patch.object(
            hand_tracker.cv2,
            "imshow",
            lambda _name, frame: shown.append(frame.copy()),
        ),
        mock.patch.object(hand_tracker.cv2, "waitKey", wait_key),
        mock.patch.object(
            hand_tracker.cv2,
            "getWindowProperty",
            lambda *_args: window_visible,
        ),
        mock.patch.object(hand_tracker.cv2, "destroyAllWindows", destroy_windows),
        mock.patch.object(hand_tracker.mp.tasks.vision, "HandLandmarker", _Landmarker),
        mock.patch.object(hand_tracker.time, "monotonic_ns", lambda: next(timestamp_values)),
        mock.patch.object(sys, "argv", ["hand_tracker.py"]),
    ]
    for patch in patches:
        patch.start()
    try:
        hand_tracker.main()
    finally:
        for patch in reversed(patches):
            patch.stop()
    return camera, shown, destroyed, _Landmarker.options, _Landmarker.instances


class CameraPipelineTests(unittest.TestCase):
    def test_windows_camera_backends_prefer_directshow(self) -> None:
        with mock.patch.object(hand_tracker.sys, "platform", "win32"):
            self.assertEqual(
                hand_tracker.camera_capture_backends()[0],
                hand_tracker.cv2.CAP_DSHOW,
            )

    def test_macos_camera_backends_use_avfoundation(self) -> None:
        with mock.patch.object(hand_tracker.sys, "platform", "darwin"):
            self.assertEqual(
                hand_tracker.camera_capture_backends(),
                (hand_tracker.cv2.CAP_AVFOUNDATION,),
            )

    def test_windows_camera_help_mentions_settings(self) -> None:
        with mock.patch.object(hand_tracker.sys, "platform", "win32"):
            self.assertIn("Privacy & security", hand_tracker.camera_permission_help())

    def test_macos_camera_help_mentions_system_settings(self) -> None:
        with mock.patch.object(hand_tracker.sys, "platform", "darwin"):
            self.assertIn("System Settings", hand_tracker.camera_permission_help())

    def test_capture_size_is_vga_on_windows_and_macos(self) -> None:
        with mock.patch.object(hand_tracker.sys, "platform", "win32"):
            self.assertEqual(
                hand_tracker.preferred_capture_size(),
                (FRAME_WIDTH, FRAME_HEIGHT),
            )
        with mock.patch.object(hand_tracker.sys, "platform", "darwin"):
            self.assertEqual(
                hand_tracker.preferred_capture_size(),
                (FRAME_WIDTH, FRAME_HEIGHT),
            )

    def test_preview_window_is_resizable(self) -> None:
        flags = hand_tracker.preview_window_flags()
        autosize = int(getattr(hand_tracker.cv2, "WINDOW_AUTOSIZE", 1))
        self.assertEqual(flags & autosize, 0)

    def test_resized_window_letterboxes_instead_of_stretching(self) -> None:
        frame = np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 200, dtype=np.uint8)
        shown = hand_tracker.frame_for_display(frame, 1280, 720)
        _x, _y, content_width, content_height = hand_tracker.fit_frame_to_display(
            FRAME_WIDTH, FRAME_HEIGHT, 1280, 720
        )
        self.assertEqual(shown.shape[:2], (720, 1280))
        self.assertAlmostEqual(content_width / content_height, FRAME_WIDTH / FRAME_HEIGHT)
        self.assertTrue(np.all(shown[0, 0] == 0))

    def test_display_frame_matches_window_size(self) -> None:
        frame = np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 40, dtype=np.uint8)
        shown = hand_tracker.frame_for_display(frame)
        self.assertEqual(
            shown.shape[:2],
            (hand_tracker.DISPLAY_HEIGHT, hand_tracker.DISPLAY_WIDTH),
        )

    def test_window_clicks_map_back_to_working_frame(self) -> None:
        left, top, _right, _bottom = hand_tracker._send_button_bounds(
            FRAME_WIDTH, FRAME_HEIGHT
        )
        display_x, display_y = _display_click(left + 12, top + 12)
        work_x, work_y = hand_tracker.map_window_point_to_frame(
            display_x, display_y, FRAME_WIDTH, FRAME_HEIGHT
        )
        self.assertAlmostEqual(work_x, left + 12)
        self.assertAlmostEqual(work_y, top + 12)

    def test_display_letterboxes_widescreen_without_stretching(self) -> None:
        frame = np.full((720, 1280, 3), 200, dtype=np.uint8)
        shown = hand_tracker.frame_for_display(frame)
        content_x, content_y, content_width, content_height = (
            hand_tracker.fit_frame_to_display(1280, 720)
        )
        self.assertEqual(shown.shape[:2], (720, 960))
        self.assertEqual(content_width, 960)
        self.assertEqual(content_height, 540)
        self.assertTrue(np.all(shown[0, 0] == 0))
        self.assertTrue(
            np.all(
                shown[content_y + content_height // 2, content_x + content_width // 2]
                == 200
            )
        )
        self.assertAlmostEqual(content_width / content_height, 1280 / 720)

    def test_main_requests_two_hands_and_cleans_up_on_q(self) -> None:
        camera, shown, destroyed, options, instances = _run_main(
            [_result((_pinch_points((120.0, 180.0), False), "Left"))],
            [ord("q")],
        )

        self.assertEqual(options.num_hands, 2)
        self.assertEqual(options.running_mode, hand_tracker.mp.tasks.vision.RunningMode.VIDEO)
        self.assertEqual(len(instances), 1)
        self.assertEqual(len(shown), 1)
        self.assertTrue(instances[0].closed)
        self.assertTrue(camera.released)
        self.assertTrue(destroyed)

    def test_window_close_releases_camera_and_detector(self) -> None:
        camera, shown, destroyed, _options, instances = _run_main(
            [_result()],
            [-1],
            window_visible=0.0,
        )

        self.assertEqual(len(shown), 1)
        self.assertTrue(instances[0].closed)
        self.assertTrue(camera.released)
        self.assertTrue(destroyed)

    def test_two_hand_pinch_and_detector_loss_finish_independent_strokes(self) -> None:
        results = [
            _result(
                (_pinch_points((120.0, 180.0), True), "Left"),
                (_pinch_points((400.0, 180.0), True), "Right"),
            ),
            _result(
                (_pinch_points((135.0, 180.0), True), "Left"),
                (_pinch_points((385.0, 180.0), True), "Right"),
            ),
            _result(
                (_pinch_points((160.0, 180.0), True), "Left"),
                (_pinch_points((360.0, 180.0), True), "Right"),
            ),
            _result((_pinch_points((185.0, 180.0), True), "Left")),
            _result(),
        ]
        event_batches: list[tuple[tuple[str, int, str], ...]] = []
        lifecycle: list[tuple[int, int]] = []
        original_consume = hand_tracker.consume_stroke_events

        def spy_consume(events, active, strokes, view):
            event_batches.append(tuple((event.kind, event.hand_id, event.reason) for event in events))
            result = original_consume(events, active, strokes, view)
            lifecycle.append((len(active), len(strokes)))
            return result

        with mock.patch.object(hand_tracker, "consume_stroke_events", spy_consume):
            camera, _shown, destroyed, _options, _instances = _run_main(
                results,
                [-1, -1, -1, -1, ord("q")],
                timestamps_ms=[0, 60, 120, 180, 240],
            )

        self.assertTrue(camera.released)
        self.assertTrue(destroyed)
        self.assertTrue(any({kind for kind, _hand_id, _reason in batch} >= {"start"} for batch in event_batches))
        self.assertTrue(any(reason == "loss" for batch in event_batches for _kind, _hand_id, reason in batch))
        self.assertEqual(lifecycle[-1], (0, 2))

    def test_keyboard_transitions_update_main_loop_state(self) -> None:
        results = [
            _result((_pinch_points((120.0, 180.0), True), "Left")),
            _result((_pinch_points((140.0, 180.0), True), "Left")),
            _result((_pinch_points((160.0, 180.0), True), "Left")),
            _result((_pinch_points((160.0, 180.0), False), "Left")),
            _result((_pinch_points((160.0, 180.0), False), "Left")),
            _result(),
            _result(),
            _result(),
            _result(),
            _result(),
            _result(),
        ]
        keys = [-1, -1, -1, -1, ord("u"), ord("c"), ord("r"), ord("s"), ord(" "), ord(" "), ord("q")]
        hud_states: list[dict[str, object]] = []
        original_draw_hud = hand_tracker.draw_hud

        def spy_hud(frame, **kwargs):
            hud_states.append(
                {
                    "paused": kwargs["paused"],
                    "stroke_count": kwargs["stroke_count"],
                    "snapping": kwargs["snapping"],
                    "status": kwargs["status"],
                }
            )
            return original_draw_hud(frame, **kwargs)

        with mock.patch.object(hand_tracker, "draw_hud", spy_hud):
            camera, _shown, destroyed, _options, _instances = _run_main(
                results,
                keys,
                timestamps_ms=[0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600],
            )

        self.assertTrue(camera.released)
        self.assertTrue(destroyed)
        self.assertEqual(len(hud_states), len(keys))
        self.assertEqual(hud_states[4]["stroke_count"], 1)
        self.assertEqual(hud_states[5]["stroke_count"], 0)
        self.assertIn("Undid", hud_states[5]["status"])
        self.assertIn("Drawing cleared", hud_states[6]["status"])
        self.assertEqual(hud_states[7]["status"], "View reset")
        self.assertFalse(hud_states[8]["snapping"])
        self.assertTrue(hud_states[9]["paused"])
        self.assertFalse(hud_states[10]["paused"])

    def test_f_sends_only_completed_raw_strokes_and_does_not_repeat(self) -> None:
        results = [
            _result((_pinch_points((120.0, 180.0), True), "Left")),
            _result((_pinch_points((145.0, 180.0), True), "Left")),
            _result((_pinch_points((170.0, 180.0), True), "Left")),
            _result((_pinch_points((185.0, 180.0), False), "Left")),
            _result((_pinch_points((190.0, 180.0), False), "Left")),
            _result((_pinch_points((220.0, 180.0), True), "Left")),
            _result((_pinch_points((245.0, 180.0), True), "Left")),
            _result((_pinch_points((260.0, 180.0), True), "Left")),
            _result((_pinch_points((275.0, 180.0), False), "Left")),
            _result((_pinch_points((280.0, 180.0), False), "Left")),
            _result(),
        ]
        keys = [-1, -1, -1, -1, -1, -1, -1, ord("f"), -1, ord("q")]
        sender = mock.Mock(return_value=hand_tracker.Path(".runtime/freecad_drawing.json"))
        completed_records: list[hand_tracker.StrokeRecord] = []
        original_finish = hand_tracker._finish_active_stroke
        snapped_points = ((901.0, 902.0), (903.0, 904.0))
        shape_match = SimpleNamespace(kind="line", confidence=0.99, points=snapped_points)

        def spy_finish(active, strokes):
            before = len(strokes)
            status = original_finish(active, strokes)
            if len(strokes) > before:
                completed_records.append(strokes[-1])
            return status

        with mock.patch.object(hand_tracker, "send_to_freecad", sender), mock.patch.object(
            hand_tracker, "_finish_active_stroke", spy_finish
        ), mock.patch.object(hand_tracker, "_shape_match_for", return_value=shape_match):
            camera, _shown, destroyed, _options, _instances = _run_main(results, keys)

        self.assertTrue(camera.released)
        self.assertTrue(destroyed)
        sender.assert_called_once()
        exported = sender.call_args.args[0]
        self.assertEqual(len(exported), 1)
        self.assertGreaterEqual(len(completed_records), 2)
        self.assertEqual(exported[0], completed_records[0].raw_points)
        self.assertNotEqual(exported[0], completed_records[1].raw_points)
        self.assertNotEqual(exported[0], snapped_points)
        self.assertTrue(all(isinstance(point, tuple) and len(point) == 2 for point in exported[0]))

    def test_send_button_click_uses_same_bridge_action(self) -> None:
        results = [
            _result((_pinch_points((120.0, 180.0), True), "Left")),
            _result((_pinch_points((145.0, 180.0), True), "Left")),
            _result((_pinch_points((170.0, 180.0), True), "Left")),
            _result((_pinch_points((185.0, 180.0), False), "Left")),
            _result((_pinch_points((190.0, 180.0), False), "Left")),
            _result(),
        ]
        left, top, _right, _bottom = hand_tracker._send_button_bounds(FRAME_WIDTH, FRAME_HEIGHT)
        sender = mock.Mock(return_value=hand_tracker.Path(".runtime/freecad_drawing.json"))

        with mock.patch.object(hand_tracker, "send_to_freecad", sender):
            _camera, _shown, destroyed, _options, _instances = _run_main(
                results,
                [-1, -1, -1, -1, ord("q")],
                mouse_clicks=[None, None, None, None, _display_click(left + 12, top + 12)],
            )

        self.assertTrue(destroyed)
        sender.assert_called_once()

    def test_send_button_click_uses_actual_camera_frame_size(self) -> None:
        results = [
            _result((_pinch_points((120.0, 180.0), True), "Left")),
            _result((_pinch_points((145.0, 180.0), True), "Left")),
            _result((_pinch_points((170.0, 180.0), True), "Left")),
            _result((_pinch_points((185.0, 180.0), False), "Left")),
            _result((_pinch_points((190.0, 180.0), False), "Left")),
        ]
        width, height = 800, 360
        left, top, _right, _bottom = hand_tracker._send_button_bounds(width, height)
        frames = [np.full((height, width, 3), 31, dtype=np.uint8) for _ in results]
        sender = mock.Mock(return_value=hand_tracker.Path(".runtime/freecad_drawing.json"))

        with mock.patch.object(hand_tracker, "send_to_freecad", sender):
            _camera, _shown, destroyed, _options, _instances = _run_main(
                results,
                [-1, -1, -1, -1, ord("q")],
                frames=frames,
                mouse_clicks=[
                    None,
                    None,
                    None,
                    None,
                    _display_click(left + 12, top + 12, width, height),
                ],
            )

        self.assertTrue(destroyed)
        sender.assert_called_once()

    def test_empty_send_reports_status_and_keeps_camera_running(self) -> None:
        hud_statuses: list[str] = []
        original_draw_hud = hand_tracker.draw_hud

        def spy_hud(frame, **kwargs):
            hud_statuses.append(kwargs["status"])
            return original_draw_hud(frame, **kwargs)

        sender = mock.Mock()
        with mock.patch.object(hand_tracker, "send_to_freecad", sender), mock.patch.object(
            hand_tracker, "draw_hud", spy_hud
        ):
            camera, shown, destroyed, _options, _instances = _run_main(
                [_result(), _result()], [ord("f"), ord("q")]
            )

        self.assertTrue(camera.released)
        self.assertTrue(destroyed)
        self.assertEqual(len(shown), 2)
        sender.assert_not_called()
        self.assertIn("No completed strokes", " ".join(hud_statuses))

    def test_send_failure_is_reported_without_stopping_camera(self) -> None:
        results = [
            _result((_pinch_points((120.0, 180.0), True), "Left")),
            _result((_pinch_points((145.0, 180.0), True), "Left")),
            _result((_pinch_points((170.0, 180.0), True), "Left")),
            _result((_pinch_points((185.0, 180.0), False), "Left")),
            _result((_pinch_points((190.0, 180.0), False), "Left")),
            _result(),
        ]
        hud_statuses: list[str] = []
        original_draw_hud = hand_tracker.draw_hud

        def spy_hud(frame, **kwargs):
            hud_statuses.append(kwargs["status"])
            return original_draw_hud(frame, **kwargs)

        sender = mock.Mock(side_effect=RuntimeError("FreeCAD executable not found"))
        with mock.patch.object(hand_tracker, "send_to_freecad", sender), mock.patch.object(
            hand_tracker, "draw_hud", spy_hud
        ):
            camera, shown, destroyed, _options, _instances = _run_main(
                results, [-1, -1, -1, -1, ord("f"), ord("q")]
            )

        self.assertTrue(camera.released)
        self.assertTrue(destroyed)
        self.assertEqual(len(shown), 6)
        sender.assert_called_once()
        self.assertIn("FreeCAD send failed", " ".join(hud_statuses))

    def test_pause_does_not_leave_stale_hand_overlay_on_new_camera_frame(self) -> None:
        frames = [
            np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 17, dtype=np.uint8),
            np.full((FRAME_HEIGHT, FRAME_WIDTH, 3), 91, dtype=np.uint8),
        ]
        results = [_result((_pinch_points((100.0, 180.0), False), "Left"))]
        _camera, shown, _destroyed, _options, _instances = _run_main(
            results,
            [ord(" "), ord("q")],
            frames=frames,
            timestamps_ms=[0, 100],
        )
        self.assertEqual(len(shown), 2)
        self.assertEqual(
            shown[1].shape[:2],
            (hand_tracker.DISPLAY_HEIGHT, hand_tracker.DISPLAY_WIDTH),
        )
        scale_y = hand_tracker.DISPLAY_HEIGHT / FRAME_HEIGHT
        scale_x = hand_tracker.DISPLAY_WIDTH / FRAME_WIDTH
        center_region = shown[1][
            int(150 * scale_y) : int(280 * scale_y),
            int(60 * scale_x) : int(150 * scale_x),
        ]
        self.assertLess(
            int(np.count_nonzero(np.any(center_region != 91, axis=2))),
            100,
            "paused redraw should clear or materially fade stale hand markers",
        )

    def test_hud_mentions_all_implemented_keyboard_controls(self) -> None:
        frame = np.zeros((FRAME_HEIGHT, FRAME_WIDTH, 3), dtype=np.uint8)
        captured: list[str] = []
        view = ViewTransform(viewport_center=(FRAME_WIDTH / 2, FRAME_HEIGHT / 2))
        with mock.patch.object(hand_tracker, "_put_text", lambda _frame, text, *_args: captured.append(text)):
            hand_tracker.draw_hud(
                frame,
                paused=False,
                hands=(),
                active_count=0,
                stroke_count=0,
                snapping=True,
                view=view,
                status="ready",
            )
        rendered = " ".join(captured)
        for control in ("Pinch draw", "Open palm pan", "Space pause", "C clear", "U undo", "R reset view", "S snap", "Q/Esc quit"):
            self.assertIn(control, rendered)


if __name__ == "__main__":
    unittest.main()
