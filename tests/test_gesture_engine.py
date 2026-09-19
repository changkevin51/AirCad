import math
import unittest

from gesture_engine import (
    GestureEngine,
    HandObservation,
    NavigationDelta,
    ViewTransform,
)


def hand(
    center,
    *,
    ratio=0.8,
    label=None,
    open_palm=False,
    palm_size=100.0,
):
    distance = ratio * palm_size
    return HandObservation(
        index_tip=(center[0] + distance * 0.5, center[1]),
        thumb_tip=(center[0] - distance * 0.5, center[1]),
        palm_center=center,
        palm_size=palm_size,
        handedness=label,
        open_palm=open_palm,
    )


class GestureEngineTests(unittest.TestCase):
    def test_pinch_hysteresis_debounce_and_release(self):
        engine = GestureEngine(pinch_debounce_ms=20, smoothing_alpha=1.0)
        self.assertEqual(engine.update([hand((100, 100), ratio=0.4)], 0).stroke_events, ())
        self.assertEqual(engine.update([hand((100, 100), ratio=0.5)], 10).stroke_events, ())
        frame = engine.update([hand((100, 100), ratio=0.4)], 25)
        self.assertEqual(frame.stroke_events, ())
        frame = engine.update([hand((100, 100), ratio=0.4)], 45)
        self.assertEqual([event.kind for event in frame.stroke_events], ["start"])
        # The hysteresis band does not flicker the active pinch.
        frame = engine.update([hand((105, 100), ratio=0.55)], 30)
        self.assertEqual([event.kind for event in frame.stroke_events], ["point"])
        frame = engine.update([hand((105, 100), ratio=0.7)], 40)
        self.assertEqual([event.kind for event in frame.stroke_events], ["point"])
        frame = engine.update([hand((105, 100), ratio=0.7)], 61)
        self.assertEqual([event.kind for event in frame.stroke_events], ["end"])

    def test_two_hands_draw_independently(self):
        engine = GestureEngine(pinch_debounce_ms=10, smoothing_alpha=1.0)
        left = hand((100, 160), ratio=0.3, label="left")
        right = hand((400, 160), ratio=0.3, label="right")
        self.assertEqual(engine.update([left, right], 0).stroke_events, ())
        frame = engine.update([left, right], 12)
        self.assertEqual({event.hand_id for event in frame.stroke_events}, {1, 2})
        self.assertEqual({event.kind for event in frame.stroke_events}, {"start"})
        frame = engine.update(
            [hand((110, 165), ratio=0.3, label="left"), hand((390, 155), ratio=0.3, label="right")],
            25,
        )
        self.assertEqual({event.kind for event in frame.stroke_events}, {"point"})
        frame = engine.update(
            [hand((110, 165), ratio=0.8, label="left"), hand((390, 155), ratio=0.8, label="right")],
            50,
        )
        self.assertEqual({event.kind for event in frame.stroke_events}, {"point"})
        frame = engine.update(
            [hand((110, 165), ratio=0.8, label="left"), hand((390, 155), ratio=0.8, label="right")],
            65,
        )
        self.assertEqual([event.kind for event in frame.stroke_events].count("end"), 2)

    def test_identity_survives_order_swap_duplicate_and_flickering_labels(self):
        engine = GestureEngine(smoothing_alpha=1.0)
        first = engine.update(
            [hand((100, 100), label="left"), hand((300, 100), label="right")],
            0,
        )
        ids = {round(item.palm_center[0]): item.hand_id for item in first.hands}
        swapped = engine.update(
            [hand((295, 100), label="left"), hand((105, 100), label="right")],
            30,
        )
        self.assertEqual(
            {round(item.palm_center[0]): item.hand_id for item in swapped.hands},
            {105: ids[100], 295: ids[300]},
        )

        # Duplicate labels are only hints; nearest geometry still wins.
        duplicate = engine.update(
            [hand((110, 100), label="left"), hand((290, 100), label="left")],
            60,
        )
        self.assertEqual(
            {round(item.palm_center[0]): item.hand_id for item in duplicate.hands},
            {110: ids[100], 290: ids[300]},
        )

        # A label flip at the same positions must not create new tracks.
        flicker = engine.update(
            [hand((110, 100), label="right"), hand((290, 100), label="left")],
            90,
        )
        self.assertEqual(
            {round(item.palm_center[0]): item.hand_id for item in flicker.hands},
            {110: ids[100], 290: ids[300]},
        )

    def test_lost_hand_closes_only_its_stroke_and_other_hand_continues(self):
        engine = GestureEngine(pinch_debounce_ms=10, smoothing_alpha=1.0)
        left = hand((100, 120), ratio=0.3, label="left")
        right = hand((400, 120), ratio=0.3, label="right")
        engine.update([left, right], 0)
        started = engine.update([left, right], 12)
        ids = {event.hand_id for event in started.stroke_events}
        left_id = next(event.hand_id for event in started.stroke_events if event.hand_id == 1)
        right_id = next(event.hand_id for event in started.stroke_events if event.hand_id != left_id)

        frame = engine.update([hand((105, 125), ratio=0.3, label="left")], 25)
        self.assertIn(right_id, frame.lost_hand_ids)
        self.assertIn(("end", right_id), {(event.kind, event.hand_id) for event in frame.stroke_events})
        self.assertIn(("point", left_id), {(event.kind, event.hand_id) for event in frame.stroke_events})

        # The remaining hand can release normally; its point stream is not frozen.
        engine.update([hand((105, 125), ratio=0.8, label="left")], 40)
        released = engine.update([hand((105, 125), ratio=0.8, label="left")], 55)
        self.assertIn(("end", left_id), {(event.kind, event.hand_id) for event in released.stroke_events})

        # Reappearance of the lost hand while still pinching is gated.
        held = engine.update(
            [hand((105, 125), ratio=0.8, label="left"), hand((400, 120), ratio=0.3, label="right")],
            70,
        )
        self.assertNotIn(("start", right_id), {(event.kind, event.hand_id) for event in held.stroke_events})
        engine.update(
            [hand((105, 125), ratio=0.8, label="left"), hand((400, 120), ratio=0.8, label="right")],
            90,
        )
        engine.update(
            [hand((105, 125), ratio=0.8, label="left"), hand((400, 120), ratio=0.3, label="right")],
            100,
        )
        repin = engine.update(
            [hand((105, 125), ratio=0.8, label="left"), hand((400, 120), ratio=0.3, label="right")],
            115,
        )
        self.assertIn(("start", right_id), {(event.kind, event.hand_id) for event in repin.stroke_events})

    def test_long_loss_and_pending_pinch_require_a_visible_release(self):
        engine = GestureEngine(
            pinch_debounce_ms=15,
            track_timeout_ms=25,
            smoothing_alpha=1.0,
        )
        pending = hand((180, 120), ratio=0.3)
        engine.update([pending], 0)  # onset candidate only
        engine.update([], 10)       # loss cancels the candidate
        engine.update([], 40)       # track expires; a tombstone remains
        held = engine.update([pending], 50)
        self.assertNotIn("start", [event.kind for event in held.stroke_events])
        engine.update([hand((180, 120), ratio=0.8)], 60)  # visible release clears it
        engine.update([pending], 70)
        started = engine.update([pending], 90)
        self.assertIn("start", [event.kind for event in started.stroke_events])

    def test_open_palm_requires_dwell_and_gradual_pan_accumulates(self):
        engine = GestureEngine(open_hold_ms=40, smoothing_alpha=1.0, nav_move_deadband=3.0)
        self.assertIsNone(engine.update([hand((100, 100), open_palm=True)], 0).navigation)
        self.assertIsNone(engine.update([hand((100, 100), open_palm=True)], 40).navigation)
        deltas = []
        for index in range(1, 13):
            frame = engine.update([hand((100 + index, 100), open_palm=True)], 40 + index * 10)
            if frame.navigation:
                deltas.append(frame.navigation.pan_delta[0])
        self.assertGreaterEqual(len(deltas), 2)
        self.assertAlmostEqual(sum(deltas), 12.0, places=5)

    def test_two_hand_gradual_zoom_and_rotation_accumulate(self):
        engine = GestureEngine(
            open_hold_ms=40,
            smoothing_alpha=1.0,
            min_two_hand_separation=50,
            nav_scale_deadband=0.015,
        )
        base = [hand((100, 200), open_palm=True, label="left"), hand((300, 200), open_palm=True, label="right")]
        engine.update(base, 0)
        engine.update(base, 40)  # arms both palms and establishes the baseline
        zooms = []
        rotations = []
        for index in range(1, 13):
            angle = index * 0.01
            midpoint = (200.0, 200.0)
            half_separation = 100.0 + index * 1.0
            left = (midpoint[0] - half_separation * math.cos(angle), midpoint[1] - half_separation * math.sin(angle))
            right = (midpoint[0] + half_separation * math.cos(angle), midpoint[1] + half_separation * math.sin(angle))
            frame = engine.update(
                [hand(left, open_palm=True, label="left"), hand(right, open_palm=True, label="right")],
                40 + index * 10,
            )
            if frame.navigation:
                zooms.append(frame.navigation.zoom_factor)
                rotations.append(frame.navigation.rotation_delta)
        self.assertGreater(len(zooms), 0)
        self.assertNotAlmostEqual(math.prod(zooms), 1.0, places=5)
        self.assertGreater(sum(abs(value) for value in rotations), 0.0)

    def test_drawing_blocks_navigation_and_reset_requires_repinch(self):
        engine = GestureEngine(open_hold_ms=0, pinch_debounce_ms=10, smoothing_alpha=1.0)
        open_hand = hand((100, 100), ratio=0.8, open_palm=True)
        engine.update([open_hand], 0)
        engine.update([open_hand], 1)
        pinched = hand((105, 100), ratio=0.3, open_palm=True)
        engine.update([pinched], 20)
        frame = engine.update([pinched], 31)
        self.assertEqual([event.kind for event in frame.stroke_events], ["start"])
        frame = engine.update([hand((200, 150), ratio=0.3, open_palm=True)], 40)
        self.assertTrue(frame.any_drawing)
        self.assertIsNone(frame.navigation)
        for event in engine.reset_input("pause"):
            self.assertEqual(event.kind, "end")
        held = engine.update([hand((200, 150), ratio=0.3, open_palm=True)], 60)
        self.assertNotIn("start", [event.kind for event in held.stroke_events])

    def test_view_transform_is_invertible_and_anchor_preserving(self):
        view = ViewTransform((320.0, 240.0))
        source = (410.0, 175.0)
        navigation = NavigationDelta(
            mode="two",
            pan_delta=(20.0, 15.0),
            zoom_factor=1.2,
            rotation_delta=0.15,
            anchor=(250.0, 210.0),
            target_anchor=(270.0, 225.0),
        )
        anchor_canvas = view.screen_to_canvas(navigation.anchor)
        view.apply_navigation(navigation)
        self.assertAlmostEqual(view.canvas_to_screen(anchor_canvas)[0], 270.0, places=5)
        self.assertAlmostEqual(view.canvas_to_screen(anchor_canvas)[1], 225.0, places=5)
        projected = view.canvas_to_screen(source)
        recovered = view.screen_to_canvas(projected)
        self.assertAlmostEqual(recovered[0], source[0], places=5)
        self.assertAlmostEqual(recovered[1], source[1], places=5)

    def test_transition_rebaselines_without_jump(self):
        engine = GestureEngine(open_hold_ms=0, smoothing_alpha=1.0, nav_move_deadband=3.0)
        one = hand((100, 100), open_palm=True, label="left")
        engine.update([one], 0)
        engine.update([one], 1)
        moved = engine.update([hand((110, 100), open_palm=True, label="left")], 20)
        self.assertEqual(moved.navigation.pan_delta, (10.0, 0.0))
        two = [hand((110, 100), open_palm=True, label="left"), hand((310, 100), open_palm=True, label="right")]
        self.assertIsNone(engine.update(two, 30).navigation)
        engine.update(
            [hand((120, 100), open_palm=True, label="left"), hand((320, 100), open_palm=True, label="right")],
            40,
        )
        after = engine.update(
            [hand((130, 100), open_palm=True, label="left"), hand((330, 100), open_palm=True, label="right")],
            50,
        )
        self.assertIsNotNone(after.navigation)
        self.assertEqual(after.navigation.pan_delta, (10.0, 0.0))


if __name__ == "__main__":
    unittest.main()
