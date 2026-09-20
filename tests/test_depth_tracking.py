"""Hardware-independent checks for the depth tracking/filter pipeline."""

from __future__ import annotations

import math
import unittest

import numpy as np

from tracker import depth_tracking as dt


def _depth_frame(values_by_center, width=120, height=90):
    """Depth image with a filled square under each requested ROI center."""

    depth = np.zeros((height, width), dtype=np.float64)
    for (u, v), value in values_by_center.items():
        bounds = dt.roi_bounds(u, v, width, height)
        if bounds is not None:
            x0, y0, x1, y1 = bounds
            depth[y0:y1, x0:x1] = value
    return depth


def _lock(filt, z=500.0, t0=1000.0, step_ms=33.0, xyz=(0.0, 0.0)):
    """Feed enough consistent samples to reach the tracked state."""

    out = None
    for index in range(dt.RELOCK_FRAMES):
        out = filt.update(
            t0 + index * step_ms, (xyz[0], xyz[1], z + index * 0.5), None
        )
    return out


class DeprojectionTests(unittest.TestCase):
    def test_known_intrinsics_unproject_off_centre(self) -> None:
        xyz = dt.pixel_to_xyz(60.0, 30.0, 500.0, 100.0, 100.0, 50.0, 40.0)
        np.testing.assert_allclose(xyz, [50.0, 50.0, 500.0])

    def test_intrinsics_must_be_finite_and_positive(self) -> None:
        self.assertEqual(dt.validate_intrinsics((100.0, 100.0, 50.0, 40.0)), (100.0, 100.0, 50.0, 40.0))
        for bad in ((0.0, 100.0, 50.0, 40.0), (100.0, -5.0, 50.0, 40.0), (math.nan, 1, 2, 3), (1, 2, 3)):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    dt.validate_intrinsics(bad)

    def test_roi_rejects_target_outside_image(self) -> None:
        self.assertIsNone(dt.roi_bounds(-1.0, 40.0, 120, 90))
        self.assertIsNone(dt.roi_bounds(120.0, 40.0, 120, 90))
        self.assertIsNone(dt.roi_bounds(60.0, 90.0, 120, 90))
        self.assertIsNotNone(dt.roi_bounds(60.0, 45.0, 120, 90))
        depth = _depth_frame({(150.0, 45.0): 500.0})
        estimate = dt.estimate_depth(depth, [(150.0, 45.0), (200.0, 45.0), (-5.0, 45.0)])
        self.assertEqual(estimate.reason, "off_frame")


class DepthEstimateTests(unittest.TestCase):
    def test_near_consensus_ignores_far_third_roi(self) -> None:
        depth = _depth_frame(
            {(60.0, 20.0): 500.0, (60.0, 45.0): 510.0, (60.0, 70.0): 1500.0}
        )
        estimate = dt.estimate_depth(depth, [(60.0, 20.0), (60.0, 45.0), (60.0, 70.0)])
        self.assertIsNone(estimate.reason)
        self.assertEqual(estimate.roi_count, 2)
        self.assertAlmostEqual(estimate.z, 505.0, places=6)

    def test_near_outlier_cannot_win_over_coherent_far_pair(self) -> None:
        depth = _depth_frame(
            {(60.0, 20.0): 500.0, (60.0, 45.0): 1200.0, (60.0, 70.0): 1210.0}
        )
        estimate = dt.estimate_depth(depth, [(60.0, 20.0), (60.0, 45.0), (60.0, 70.0)])
        self.assertIsNone(estimate.reason)
        self.assertEqual(estimate.roi_count, 2)
        self.assertGreater(estimate.z, 1000.0)

    def test_all_zero_depth_is_no_depth(self) -> None:
        depth = np.zeros((90, 120), dtype=np.float64)
        estimate = dt.estimate_depth(depth, dt.led_sample_points(60.0, 45.0))
        self.assertEqual(estimate.reason, "no_depth")
        self.assertIsNone(estimate.z)

    def test_too_few_valid_pixels_rejects(self) -> None:
        depth = np.zeros((90, 120), dtype=np.float64)
        depth[40:42, 56:58] = 500.0
        estimate = dt.estimate_depth(depth, dt.led_sample_points(58.0, 42.0))
        self.assertIsNone(estimate.z)

    def test_mixed_depth_roi_rejects_on_spread(self) -> None:
        depth = np.zeros((90, 120), dtype=np.float64)
        bounds = dt.roi_bounds(60.0, 45.0, 120, 90)
        x0, y0, x1, y1 = bounds
        region = depth[y0:y1, x0:x1]
        region[:, : region.shape[1] // 2] = 300.0
        region[:, region.shape[1] // 2 :] = 1500.0
        estimate = dt.estimate_depth(depth, [(60.0, 45.0), (60.0, 45.0), (60.0, 45.0)])
        self.assertIsNone(estimate.z)

    def test_single_valid_roi_is_weak_support(self) -> None:
        depth = _depth_frame({(60.0, 20.0): 500.0})
        estimate = dt.estimate_depth(depth, [(60.0, 20.0), (60.0, 45.0), (60.0, 70.0)])
        self.assertEqual(estimate.reason, "weak_support")

    def test_no_consensus_between_two_far_rois(self) -> None:
        depth = _depth_frame({(60.0, 20.0): 500.0, (60.0, 45.0): 900.0})
        estimate = dt.estimate_depth(depth, [(60.0, 20.0), (60.0, 45.0), (60.0, 70.0)])
        self.assertEqual(estimate.reason, "no_consensus")


class ColorDetectionTests(unittest.TestCase):
    def _blob(self, bgr, center=(60, 45), radius=6, size=(90, 120)):
        frame = np.zeros((size[0], size[1], 3), dtype=np.uint8)
        import cv2

        cv2.circle(frame, center, radius, bgr, -1)
        return frame

    def test_green_blob_detected(self) -> None:
        candidates = dt.find_color_candidates(self._blob((40, 200, 40)), "green", 1.0)
        self.assertTrue(candidates)
        self.assertAlmostEqual(candidates[0].centroid[0], 60.0, delta=1.0)
        self.assertAlmostEqual(candidates[0].centroid[1], 45.0, delta=1.0)

    def test_red_and_blue_presets(self) -> None:
        red = dt.find_color_candidates(self._blob((40, 40, 200)), "red", 1.0)
        blue = dt.find_color_candidates(self._blob((200, 60, 40)), "blue", 1.0)
        self.assertTrue(red)
        self.assertTrue(blue)

    def test_red_hue_wrap_includes_179(self) -> None:
        self.assertEqual(dt.color_hue_ranges("red", 1.0), [(0, 10), (170, 179)])

    def test_tolerance_widens_detection(self) -> None:
        frame = self._blob((160, 170, 30))
        self.assertFalse(dt.find_color_candidates(frame, "green", 0.5))
        self.assertTrue(dt.find_color_candidates(frame, "green", 2.0))

    def test_bright_fallback_catches_dominant_channel(self) -> None:
        frame = self._blob((255, 140, 200))
        candidates = dt.find_color_candidates(frame, "blue", 1.0)
        self.assertTrue(candidates)

    def test_multiple_blobs_all_returned(self) -> None:
        import cv2

        frame = np.zeros((90, 120, 3), dtype=np.uint8)
        cv2.circle(frame, (30, 45), 6, (40, 200, 40), -1)
        cv2.circle(frame, (90, 45), 10, (40, 200, 40), -1)
        candidates = dt.find_color_candidates(frame, "green", 1.0)
        self.assertEqual(len(candidates), 2)
        self.assertGreater(candidates[0].area, candidates[1].area)


class AssociationTests(unittest.TestCase):
    def _candidate(self, x, y, size=50.0):
        return dt.TargetCandidate(centroid=(x, y), size=size)

    def test_initial_acquisition_prefers_largest(self) -> None:
        assoc = dt.TargetAssociator()
        result = assoc.update([self._candidate(10, 10, 20), self._candidate(80, 80, 60)], 0.0)
        self.assertTrue(result.acquired)
        self.assertEqual(result.candidate.centroid, (80, 80))

    def test_tracked_identity_survives_bigger_distractor(self) -> None:
        assoc = dt.TargetAssociator()
        assoc.update([self._candidate(50, 50, 50)], 0.0)
        result = assoc.update([self._candidate(55, 50, 52), self._candidate(400, 400, 90)], 33.0)
        self.assertEqual(result.candidate.centroid, (55, 50))

    def test_ambiguous_close_candidates_hold(self) -> None:
        assoc = dt.TargetAssociator()
        assoc.update([self._candidate(50, 50, 50)], 0.0)
        result = assoc.update([self._candidate(60, 50, 50), self._candidate(65, 50, 50)], 33.0)
        self.assertTrue(result.ambiguous)
        self.assertIsNone(result.candidate)


    def test_forget_after_loss_reacquires_as_new(self) -> None:
        assoc = dt.TargetAssociator()
        assoc.update([self._candidate(50, 50, 50)], 0.0)
        assoc.update([], 100.0)
        result = assoc.update([self._candidate(200, 200, 50)], 400.0)
        self.assertTrue(result.acquired)


    def test_size_ratio_compares_squared_area(self) -> None:
        assoc = dt.TargetAssociator()
        assoc.update([self._candidate(50, 50, 50)], 0.0)
        result = assoc.update([self._candidate(50, 50, 105)], 50.0)
        self.assertIsNone(result.candidate)
        result = assoc.update([self._candidate(50, 50, 100)], 100.0)
        self.assertIsNotNone(result.candidate)


class OneEuroTests(unittest.TestCase):
    def test_zero_timestamp_uses_real_elapsed_time(self) -> None:
        euro = dt.OneEuro()
        self.assertEqual(euro.apply(5.0, 0.0), 5.0)
        out = euro.apply(10.0, 0.033)
        te = 0.033
        dx = (10.0 - 5.0) / te
        a_d = dt.OneEuro._alpha(te, 1.0)
        dx_hat = a_d * dx
        cutoff = 1.0 + 0.007 * abs(dx_hat)
        a = dt.OneEuro._alpha(te, cutoff)
        expected = a * 10.0 + (1.0 - a) * 5.0
        self.assertAlmostEqual(out, expected, places=6)
        self.assertLess(out, 8.0)


class SpatialFilterTests(unittest.TestCase):
    def test_acquisition_needs_consistent_cluster(self) -> None:
        filt = dt.SpatialFilter()
        out = filt.update(0.0, (0.0, 0.0, 500.0), None)
        self.assertEqual(out.state, "acquiring")
        filt.update(33.0, (0.0, 0.0, 900.0), None)
        out = filt.update(66.0, (0.0, 0.0, 500.0), None)
        self.assertEqual(out.state, "acquiring")
        out = _lock(filt, z=500.0, t0=100.0)
        self.assertEqual(out.state, "tracked")
        self.assertTrue(out.fresh)
        self.assertAlmostEqual(out.xyz[2], 502.0, delta=5.0)

    def test_z_ramp_stays_continuous_same_epoch(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        t = dt.RELOCK_FRAMES * 33.0
        for index in range(30):
            out = filt.update(t + index * 33.0, (0.0, 0.0, 500.0 + (index + 1) * 10.0), None)
            self.assertEqual(out.state, "tracked")
            self.assertTrue(out.fresh)
            self.assertEqual(out.epoch, epoch)
        self.assertAlmostEqual(out.xyz[2], 800.0, delta=20.0)

    def test_single_far_spike_never_enters_output(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        held_xyz = out.xyz.copy()
        out = filt.update(200.0, (0.0, 0.0, 1500.0), None)
        self.assertEqual(out.state, "held")
        self.assertFalse(out.fresh)
        np.testing.assert_allclose(out.xyz, held_xyz)
        for index in range(dt.RESUME_FRAMES):
            out = filt.update(233.0 + index * 33.0, (0.0, 0.0, 505.0), None)
        self.assertEqual(out.state, "tracked")
        self.assertAlmostEqual(out.xyz[2], held_xyz[2], delta=15.0)

    def test_held_xyz_unchanged_while_only_uv_changes(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        held_xyz = out.xyz.copy()
        held_t = out.sample_time_ms
        out = filt.update(200.0, None, "no_target")
        self.assertEqual(out.state, "held")
        np.testing.assert_allclose(out.xyz, held_xyz)
        self.assertEqual(out.sample_time_ms, held_t)
        self.assertFalse(out.fresh)

    def test_distant_relock_increments_epoch_once(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        filt.update(200.0, None, "no_target")
        out = None
        for index in range(dt.RELOCK_FRAMES):
            out = filt.update(233.0 + index * 33.0, (0.0, 0.0, 560.0 + index * 0.2), None)
        self.assertEqual(out.state, "tracked")
        self.assertEqual(out.epoch, epoch + 1)

    def test_hard_timeout_loses_point_and_bumps_epoch_once(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        out = filt.update(200.0, None, "no_target")
        self.assertEqual(out.state, "held")
        out = filt.update(200.0 + dt.HOLD_TIMEOUT_S * 1000.0 + 10.0, None, "no_target")
        self.assertEqual(out.state, "lost")
        self.assertIsNone(out.xyz)
        self.assertFalse(out.fresh)
        self.assertEqual(out.epoch, epoch + 1)
        out = filt.update(900.0, None, "no_target")
        self.assertEqual(out.state, "lost")
        self.assertEqual(out.epoch, epoch + 1)

    def test_repeated_bad_samples_still_time_out(self) -> None:
        filt = dt.SpatialFilter()
        _lock(filt, z=500.0, t0=0.0)
        out = None
        for index in range(12):
            out = filt.update(200.0 + index * 33.0, (math.nan,) * 3, None)
        self.assertEqual(out.state, "lost")
        self.assertIsNone(out.xyz)

    def test_nearby_resume_keeps_epoch_and_timestamp(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        sample_t = out.sample_time_ms
        filt.update(200.0, None, "no_depth")
        out = filt.update(233.0, (0.0, 0.0, 505.0), None)
        self.assertEqual(out.state, "held")
        self.assertEqual(out.sample_time_ms, sample_t)
        filt.update(266.0, (0.0, 0.0, 505.0), None)
        out = filt.update(299.0, (0.0, 0.0, 505.0), None)
        self.assertEqual(out.state, "tracked")
        self.assertEqual(out.epoch, epoch)
        self.assertEqual(out.sample_time_ms, 299.0)

    def test_backward_and_nonfinite_samples_rejected(self) -> None:
        filt = dt.SpatialFilter()
        _lock(filt, z=500.0, t0=1000.0)
        out = filt.update(900.0, (0.0, 0.0, 505.0), None)
        self.assertEqual(out.state, "held")
        self.assertEqual(out.reason, "backward_time")
        out = filt.update(1200.0, (0.0, math.inf, 505.0), None)
        self.assertEqual(out.state, "held")
        self.assertEqual(out.reason, "non_finite")

    def test_duplicate_capture_timestamp_rejected(self) -> None:
        filt = dt.SpatialFilter()
        _lock(filt, z=500.0, t0=0.0)
        out = filt.update(200.0, (0.0, 0.0, 505.0), None)
        self.assertEqual(out.state, "tracked")
        out = filt.update(200.0, (0.0, 0.0, 510.0), None)
        self.assertEqual(out.state, "held")
        self.assertEqual(out.reason, "backward_time")

    def test_miss_expires_without_advancing_watermark(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        out = filt.miss(200.0, "stall")
        self.assertEqual(out.state, "held")
        out = filt.miss(200.0 + dt.HOLD_TIMEOUT_S * 1000.0, "stall")
        self.assertEqual(out.state, "lost")
        self.assertEqual(out.epoch, epoch + 1)
        out = filt.update(250.0, (0.0, 0.0, 505.0), None)
        self.assertNotEqual(out.reason, "backward_time")

    def test_miss_clears_pending_acquisition(self) -> None:
        filt = dt.SpatialFilter()
        for index in range(dt.RELOCK_FRAMES - 1):
            filt.update(index * 33.0, (0.0, 0.0, 500.0 + index * 0.2), None)
        filt.miss(500.0, "stall")
        out = filt.update(533.0, (0.0, 0.0, 500.0), None)
        self.assertEqual(out.state, "acquiring")

    def test_invalid_sample_clears_pending_acquisition(self) -> None:
        filt = dt.SpatialFilter()
        for index in range(dt.RELOCK_FRAMES - 1):
            filt.update(index * 33.0, (0.0, 0.0, 500.0 + index * 0.2), None)
        filt.update(200.0, (math.nan, math.nan, math.nan), None)
        out = filt.update(233.0, (0.0, 0.0, 500.0), None)
        self.assertEqual(out.state, "acquiring")

    def test_acquisition_gap_resets_pending(self) -> None:
        filt = dt.SpatialFilter()
        for index in range(dt.RELOCK_FRAMES - 1):
            filt.update(index * 33.0, (0.0, 0.0, 500.0 + index * 0.2), None)
        filt.update(500.0, (0.0, 0.0, 500.0), None)
        for index in range(dt.RELOCK_FRAMES - 2):
            out = filt.update(533.0 + index * 33.0, (0.0, 0.0, 500.0), None)
            self.assertEqual(out.state, "acquiring")
        out = filt.update(533.0 + (dt.RELOCK_FRAMES - 1) * 33.0, (0.0, 0.0, 500.0), None)
        self.assertEqual(out.state, "tracked")

    def test_gradual_drift_cannot_form_cluster(self) -> None:
        filt = dt.SpatialFilter()
        out = None
        for index, z in enumerate((0.0, 30.0, 45.0, 55.0, 65.0)):
            out = filt.update(index * 33.0, (0.0, 0.0, z + 500.0), None)
        self.assertEqual(out.state, "acquiring")
        self.assertFalse(out.fresh)

    def test_resume_samples_use_own_capture_times(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        filt.update(200.0, None, "no_target")
        filt.update(233.0, (0.0, 0.0, 505.0), None)
        filt.update(266.0, (0.0, 0.0, 506.0), None)
        out = filt.update(299.0, (0.0, 0.0, 507.0), None)
        self.assertEqual(out.state, "tracked")
        self.assertEqual(out.sample_time_ms, 299.0)
        euro = dt.OneEuro()
        euro.apply(501.0, 0.132)
        euro.apply(503.0, 0.233)
        euro.apply(505.0, 0.266)
        expected_z = euro.apply(506.0, 0.299)
        self.assertAlmostEqual(out.xyz[2], expected_z, places=6)

    def test_persistent_far_relocation_relocks_new_epoch(self) -> None:
        filt = dt.SpatialFilter()
        out = _lock(filt, z=500.0, t0=0.0)
        epoch = out.epoch
        filt.update(200.0, None, "no_target")
        for index in range(dt.RELOCK_FRAMES):
            out = filt.update(233.0 + index * 33.0, (0.0, 0.0, 1000.0 + index * 0.5), None)
        self.assertEqual(out.state, "tracked")
        self.assertEqual(out.epoch, epoch + 1)
        self.assertAlmostEqual(out.xyz[2], 1001.0, delta=15.0)


if __name__ == "__main__":
    unittest.main()
