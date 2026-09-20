"""Detection, identity and webcam integration with synthetic frames and the supplied photo."""
from dataclasses import replace
from pathlib import Path
import json
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from tracker.keycap import Keycap, KeycapTracker, calibrate_model, detect_keycap, find_keycap
from tracker import protocol
from tracker.camera import CameraWorker


def frame(x=100, y=80, lettering=False):
    image = np.zeros((240, 320, 3), np.uint8)
    image[y:y+36, x:x+40] = (65, 180, 115)
    if lettering:
        image[y+8:y+22, x+8:x+12] = 255
    return image


class KeycapTests(unittest.TestCase):
    def test_reference_photo_detects_actual_keycap(self):
        image = cv2.imread(str(Path(__file__).parent / 'fixtures/green-keycap.png'))
        scene = cv2.imread(str(Path(__file__).parent / 'fixtures/green-keycap-scene.png'))
        target = detect_keycap(scene)
        self.assertIsNotNone(target)
        self.assertFalse(target.clipped)
        self.assertGreater(target.confidence, .5)
        self.assertTrue(100 < target.x < 220 and 100 < target.y < 220)
        refined = find_keycap(scene)
        self.assertIsNotNone(refined)
        self.assertAlmostEqual(refined.x, target.x, delta=1)
        self.assertAlmostEqual(refined.y, target.y, delta=1)
        model = calibrate_model(image)
        self.assertAlmostEqual(model['hue'], 0.27156, places=4)

    def test_outline_center_ignores_white_lettering(self):
        plain = detect_keycap(frame())
        lettered = detect_keycap(frame(lettering=True))
        self.assertEqual((plain.x, plain.y), (120, 98))
        self.assertEqual((plain.x, plain.y), (lettered.x, lettered.y))

    def test_skin_red_blue_and_blank_do_not_track(self):
        for color in [(80, 140, 200), (20, 20, 240), (240, 40, 20), (0, 0, 0)]:
            image = frame()
            image[80:116, 100:140] = color
            self.assertIsNone(detect_keycap(image))

    def test_two_frame_acquisition_loss_and_new_identity(self):
        tracker = KeycapTracker()
        self.assertIsNone(tracker.update(frame(), 1))
        initial = tracker.update(frame(), 1.033)
        self.assertIsNotNone(initial)
        self.assertIsNone(tracker.update(np.zeros_like(frame()), 1.066))
        returned = tracker.update(frame(), 1.099)
        self.assertEqual(returned.identity, initial.identity)
        self.assertIsNone(tracker.update(frame(240), 2))
        reacquired = tracker.update(frame(240), 2.033)
        self.assertGreater(reacquired.identity, returned.identity)
        self.assertEqual(reacquired.x, 260)

    def test_distractor_jump_clipping_and_weak_targets_hide_immediately(self):
        tracker = KeycapTracker()
        candidate = Keycap(100, 100, 100, (95, 95, 10, 10), .9)
        tracker.accept(candidate, 1)
        self.assertIsNotNone(tracker.accept(candidate, 1.033))
        for time, bad in [(1.06, replace(candidate, x=280)), (1.09, replace(candidate, clipped=True)), (1.12, replace(candidate, confidence=.4))]:
            self.assertIsNone(tracker.accept(bad, time))
        clipped = KeycapTracker()
        self.assertIsNone(clipped.update(frame(0), 2))
        self.assertIsNone(clipped.update(frame(0), 2.03))

    def test_nearby_target_wins_over_larger_distractor(self):
        previous = detect_keycap(frame())
        image = frame(104)
        image[150:205, 230:290] = (65, 180, 115)
        chosen = detect_keycap(image, previous)
        self.assertEqual(chosen.x, 124)

    def test_clipped_green_background_cannot_hide_intact_keycap(self):
        image = frame(lettering=True)
        image[0:70, 0:70] = (65, 180, 115)
        chosen = detect_keycap(image)
        self.assertIsNotNone(chosen)
        self.assertEqual((chosen.x, chosen.y), (120, 98))

    def test_slow_startup_frames_can_acquire_and_keep_tracking(self):
        tracker = KeycapTracker()
        self.assertIsNone(tracker.update(frame(), 1))
        initial = tracker.update(frame(), 1.2)
        self.assertIsNotNone(initial)
        self.assertEqual(tracker.update(frame(110), 1.4).identity, initial.identity)
        # A genuinely stale lock still requires two fresh detections.
        self.assertIsNone(tracker.update(frame(110), 2))
        self.assertGreater(tracker.update(frame(110), 2.2).identity, initial.identity)

    def test_motion_gate_accounts_for_frame_interval_but_rejects_far_jump(self):
        tracker = KeycapTracker()
        candidate = Keycap(100, 100, 100, (95, 95, 10, 10), .9)
        tracker.accept(candidate, 1)
        initial = tracker.accept(candidate, 1.033)
        moved = tracker.accept(replace(candidate, x=165, box=(160, 95, 10, 10)), 1.1)
        self.assertIsNotNone(moved)
        self.assertEqual(moved.identity, initial.identity)
        self.assertIsNone(tracker.accept(replace(candidate, x=345), 1.166))

    def test_reference_coarse_then_native_crop_pipeline_at_720p(self):
        tracker = KeycapTracker()
        for index in range(45):
            image = np.zeros((720, 1280, 3), np.uint8)
            x = 150 + index * 6
            image[300:336, x:x+40] = (65, 180, 115)
            image[310:324, x+8:x+12] = 255
            # Background distractor stays outside the local tracking region.
            image[450:510, 1000:1060] = (70, 160, 140)
            with patch('tracker.keycap.detect_keycap', wraps=detect_keycap) as detector:
                point = tracker.update(image, 1 + index / 60)
            if index == 0:
                self.assertEqual(detector.call_args_list[0].args[0].shape[:2], (360, 640))
                self.assertIsNone(point)
            else:
                self.assertIsNotNone(point)
                self.assertAlmostEqual(point.x, x + 20, delta=.5)
                self.assertAlmostEqual(point.y, 318, delta=.5)
                if index > 1:
                    self.assertEqual(detector.call_count, 1)
                    self.assertLess(detector.call_args.args[0].shape[1], 200)

    def test_distant_replacement_during_gap_does_not_reuse_identity(self):
        tracker = KeycapTracker()
        tracker.update(frame(), 1)
        initial = tracker.update(frame(), 1.033)
        self.assertIsNone(tracker.update(np.zeros_like(frame()), 1.066))
        self.assertIsNone(tracker.update(frame(240), 1.1))
        self.assertIsNone(tracker.update(frame(240), 1.4))
        self.assertGreater(tracker.update(frame(240), 1.433).identity, initial.identity)

    def test_wire_has_only_keycap_measurements_and_loss(self):
        target = Keycap(120, 98, 1440, (100, 80, 40, 36), .9, identity=4)
        result = json.loads(json.dumps(protocol.keycap_message(target, 10, 320, 240)))
        self.assertEqual(result['type'], 'keycap')
        self.assertEqual(result['keycaps'], [dict(id=4, center=[120, 98], confidence=.9)])
        self.assertEqual(protocol.keycap_message(None, 11, 320, 240)['keycaps'], [])
        self.assertNotIn('nav', result)

    def test_webcam_pipeline_mirrors_and_emits_loss_without_anatomy_model(self):
        frames, statuses, thumbs = [], [], []
        worker = CameraWorker(0, lambda *args: frames.append(args),
                              on_thumb=lambda *args, **kwargs: thumbs.append(kwargs['keycap_frame']),
                              on_status=lambda *args: statuses.append(args), thumb_interval_s=0)

        class Camera:
            index = 0
            released = False
            def isOpened(self): return True
            def set(self, *args): pass
            def release(self): self.released = True
            def read(self):
                self.index += 1
                if self.index == 3:
                    worker.stop()
                    return True, np.zeros_like(frame())
                return True, frame()

        camera = Camera()
        with patch('tracker.camera.open_camera', return_value=camera), patch('tracker.camera.time.monotonic', side_effect=[1, 1.033, 1.066]):
            worker._run()
        self.assertIsNone(frames[0][0])
        self.assertAlmostEqual(frames[1][0].x, 200)
        self.assertIsNone(frames[2][0])
        self.assertEqual(frames[1][2:], (320, 240))
        self.assertTrue(camera.released)
        self.assertEqual(len(thumbs), len(frames))
        for thumb, (point, timestamp, width, height) in zip(thumbs, frames):
            self.assertEqual(thumb, protocol.keycap_message(point, timestamp, width, height))


if __name__ == '__main__':
    unittest.main()
