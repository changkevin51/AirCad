"""Pure spatial tracking for the depth camera: targets, ROI depth and filters.

Everything here is hardware-independent: no DepthAI or MediaPipe imports, and
all times are injected host-monotonic milliseconds so tests are deterministic.
The camera worker feeds detected target candidates, aligned depth frames and
timestamps; this module owns target association, ROI quality, calibrated
unprojection and the validated filter/state machine.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from itertools import combinations
import math
from typing import Any, Optional, Sequence

import numpy as np


FPS = 30
RGB_WIDTH, RGB_HEIGHT = 1280, 720
ROI_HALF_PX = 8
LED_OFFSET_PX = 6.0
MIN_Z_MM, MAX_Z_MM = 100.0, 2000.0
MIN_DEPTH_PIXELS = 6
MAX_DEPTH_SPREAD_MM = 80.0
CONSENSUS_Z_MM = 45.0
MAX_PAIR_SKEW_MS = 20.0
MAX_SAMPLE_AGE_MS = 200.0
RELOCK_FRAMES = 5
RELOCK_CLUSTER_MM = 35.0
HOLD_TIMEOUT_S = 0.3
RESUME_FRAMES = 3
RESUME_DISTANCE_MM = 30.0
ONEURO_MINCUTOFF, ONEURO_BETA, ONEURO_DCUTOFF = 1.0, 0.007, 1.0
Z_MEDIAN_LEN = 3
LED_MIN_AREA = 12.0
LED_BGR_MIN, LED_BGR_MARGIN = 160, 40

ASSOC_GATE_PX = 70.0
ASSOC_AMBIGUITY_PX = 10.0
ASSOC_FORGET_MS = 300.0
ASSOC_MIN_SIZE_RATIO, ASSOC_MAX_SIZE_RATIO = 0.25, 4.0
COLOR_SV_FLOOR = 80
COLOR_PRESET_HUE = {"green": (65, 25), "red": (0, 10), "blue": (115, 15)}
HOLD_TIMEOUT_MS = HOLD_TIMEOUT_S * 1000.0
JUMP_BASE_MM = 20.0
JUMP_RATE_MM_S = 1500.0
JUMP_DT_CAP_S = 0.1


def pixel_to_xyz(
    u: float,
    v: float,
    z: float,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> np.ndarray:
    """Calibrated pinhole unprojection: X right, Y up, Z forward (mm)."""

    return np.array(
        [(u - cx) * z / fx, -(v - cy) * z / fy, z], dtype=np.float64
    )


def validate_intrinsics(intrinsics: Sequence[float]) -> tuple[float, float, float, float]:
    """Return (fx, fy, cx, cy) or raise; metric tracking has no fallback."""

    if len(intrinsics) != 4:
        raise ValueError("intrinsics must contain fx, fy, cx, cy")
    fx, fy, cx, cy = (float(value) for value in intrinsics)
    if not (math.isfinite(fx) and math.isfinite(fy) and fx > 0.0 and fy > 0.0):
        raise ValueError("camera intrinsics fx/fy must be finite and positive")
    if not (math.isfinite(cx) and math.isfinite(cy)):
        raise ValueError("camera intrinsics cx/cy must be finite")
    return fx, fy, cx, cy


def led_sample_points(u: float, v: float) -> list[tuple[float, float]]:
    return [(u, v), (u - LED_OFFSET_PX, v), (u + LED_OFFSET_PX, v)]


def roi_bounds(
    u: float,
    v: float,
    width: int,
    height: int,
    half: float = ROI_HALF_PX,
) -> Optional[tuple[int, int, int, int]]:
    """Integer ROI bounds clipped to the image, or None when off-frame."""

    if not (math.isfinite(u) and math.isfinite(v)):
        return None
    if not (0.0 <= u < width and 0.0 <= v < height):
        return None
    x0 = max(0, int(math.floor(u - half)))
    y0 = max(0, int(math.floor(v - half)))
    x1 = min(int(width), int(math.ceil(u + half)))
    y1 = min(int(height), int(math.ceil(v + half)))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


@dataclass(frozen=True)
class RoiStat:
    """Robust statistics of one depth ROI; ``ok`` marks a usable estimate."""

    index: int
    center: tuple[float, float]
    bounds: Optional[tuple[int, int, int, int]]
    count: int
    median: Optional[float]
    spread: Optional[float]
    ok: bool
    values: tuple[float, ...] = ()


def roi_depth_stats(
    depth: np.ndarray,
    index: int,
    u: float,
    v: float,
    *,
    half: float = ROI_HALF_PX,
) -> RoiStat:
    height, width = depth.shape[:2]
    bounds = roi_bounds(u, v, width, height, half)
    if bounds is None:
        return RoiStat(index, (u, v), None, 0, None, None, False)
    x0, y0, x1, y1 = bounds
    region = np.asarray(depth[y0:y1, x0:x1], dtype=np.float64).ravel()
    values = region[
        np.isfinite(region) & (region >= MIN_Z_MM) & (region <= MAX_Z_MM)
    ]
    if values.size == 0:
        return RoiStat(index, (u, v), bounds, 0, None, None, False)
    spread = float(np.percentile(values, 90) - np.percentile(values, 10))
    ok = values.size >= MIN_DEPTH_PIXELS and spread <= MAX_DEPTH_SPREAD_MM
    return RoiStat(
        index,
        (u, v),
        bounds,
        int(values.size),
        float(np.median(values)),
        spread,
        ok,
        tuple(float(value) for value in values) if ok else (),
    )


@dataclass(frozen=True)
class DepthEstimate:
    """Result of the multi-ROI consensus depth estimate."""

    z: Optional[float]
    reason: Optional[str]
    roi_count: int
    valid_pixels: int
    spread_mm: Optional[float]


def estimate_depth(
    depth: np.ndarray,
    centers: Sequence[Sequence[float]],
    last_z: Optional[float] = None,
) -> DepthEstimate:
    """Estimate target depth from per-ROI medians agreeing within consensus.

    At least two ROIs must agree; the agreeing subset with the most members
    wins, preferring the primary ROI, then proximity to ``last_z``, then
    deterministic ROI order.  The estimate is the median of the pooled
    accepted depth pixels, never a minimum or unmatched-ROI fallback.
    """

    stats = [
        roi_depth_stats(depth, index, float(center[0]), float(center[1]))
        for index, center in enumerate(centers)
    ]
    valid = [stat for stat in stats if stat.ok]
    counted = sum(stat.count for stat in stats)
    spreads = [stat.spread for stat in valid if stat.spread is not None]
    spread = max(spreads) if spreads else None
    if not valid:
        reason = "off_frame" if all(stat.bounds is None for stat in stats) else "no_depth"
        return DepthEstimate(None, reason, 0, counted, spread)
    if len(valid) < 2:
        return DepthEstimate(None, "weak_support", len(valid), counted, spread)

    best: Optional[tuple[RoiStat, ...]] = None
    for size in range(len(valid), 1, -1):
        agreeing = [
            combo
            for combo in combinations(valid, size)
            if max(stat.median for stat in combo) - min(stat.median for stat in combo)
            <= CONSENSUS_Z_MM
        ]
        if not agreeing:
            continue
        with_primary = [combo for combo in agreeing if any(stat.index == 0 for stat in combo)]
        pool = with_primary if with_primary else agreeing

        def sort_key(combo: tuple[RoiStat, ...]) -> tuple[float, tuple[int, ...]]:
            medians = sorted(stat.median for stat in combo)
            middle = medians[len(medians) // 2]
            distance = abs(middle - last_z) if last_z is not None else 0.0
            return distance, tuple(stat.index for stat in combo)

        best = min(pool, key=sort_key)
        break
    if best is None:
        return DepthEstimate(None, "no_consensus", len(valid), counted, spread)

    pooled = np.array(
        [value for stat in best for value in stat.values], dtype=np.float64
    )
    z = float(np.median(pooled)) if pooled.size else None
    if z is None or not math.isfinite(z):
        return DepthEstimate(None, "no_consensus", len(valid), counted, spread)
    chosen_spreads = [stat.spread for stat in best if stat.spread is not None]
    return DepthEstimate(
        z,
        None,
        len(best),
        int(pooled.size),
        max(chosen_spreads) if chosen_spreads else None,
    )


@dataclass(frozen=True)
class ColorCandidate:
    centroid: tuple[float, float]
    area: float


def color_hue_ranges(preset: str, tolerance: float) -> list[tuple[int, int]]:
    """OpenCV hue intervals for a preset, half-width scaled by tolerance."""

    if preset not in COLOR_PRESET_HUE:
        raise ValueError("unknown colour preset {!r}".format(preset))
    tolerance = float(tolerance)
    if not (math.isfinite(tolerance) and tolerance > 0.0):
        raise ValueError("colour tolerance must be a positive finite number")
    center, half = COLOR_PRESET_HUE[preset]
    half = half * tolerance
    if preset == "red":
        hi = int(round(half))
        return [(0, min(179, hi)), (max(0, 180 - hi), 179)]
    lo = int(round(center - half))
    hi = int(round(center + half))
    return [(max(0, lo), min(179, hi))]


def _mask_centroids(mask: np.ndarray, min_area: float) -> list[ColorCandidate]:
    import cv2

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[ColorCandidate] = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area:
            continue
        moments = cv2.moments(contour)
        if moments["m00"] <= 1e-6:
            continue
        candidates.append(
            ColorCandidate(
                (moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]),
                area,
            )
        )
    candidates.sort(key=lambda item: (-item.area, item.centroid[0], item.centroid[1]))
    return candidates


def find_color_candidates(
    frame_bgr: np.ndarray,
    preset: str = "green",
    tolerance: float = 1.0,
    *,
    min_area: float = LED_MIN_AREA,
) -> list[ColorCandidate]:
    """All plausible colour blobs, largest first; identity is the caller's job."""

    import cv2

    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = np.zeros(hsv.shape[:2], dtype=np.uint8)
    for lo, hi in color_hue_ranges(preset, tolerance):
        mask |= cv2.inRange(
            hsv,
            np.array([lo, COLOR_SV_FLOOR, COLOR_SV_FLOOR], dtype=np.uint8),
            np.array([hi, 255, 255], dtype=np.uint8),
        )
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    candidates = _mask_centroids(mask, min_area)
    if candidates:
        return candidates

    channels = {"blue": 0, "green": 1, "red": 2}
    dominant = channels[preset]
    others = [index for index in range(3) if index != dominant]
    split = cv2.split(frame_bgr)
    main16 = split[dominant].astype(np.int16)
    bright = (split[dominant] >= LED_BGR_MIN) & (
        main16 > split[others[0]].astype(np.int16) + LED_BGR_MARGIN
    ) & (main16 > split[others[1]].astype(np.int16) + LED_BGR_MARGIN)
    fallback = cv2.morphologyEx(bright.astype(np.uint8) * 255, cv2.MORPH_OPEN, kernel)
    return _mask_centroids(fallback, min_area)


@dataclass(frozen=True)
class TargetCandidate:
    """One detectable target; ``payload`` carries detector-specific data."""

    centroid: tuple[float, float]
    size: float
    payload: Any = None


@dataclass(frozen=True)
class Association:
    candidate: Optional[TargetCandidate]
    ambiguous: bool = False
    acquired: bool = False


class TargetAssociator:
    """Keep one drawing target across frames using position/size continuity."""

    def __init__(
        self,
        *,
        gate_px: float = ASSOC_GATE_PX,
        ambiguity_px: float = ASSOC_AMBIGUITY_PX,
        forget_ms: float = ASSOC_FORGET_MS,
        min_size_ratio: float = ASSOC_MIN_SIZE_RATIO,
        max_size_ratio: float = ASSOC_MAX_SIZE_RATIO,
    ) -> None:
        self.gate_px = float(gate_px)
        self.ambiguity_px = float(ambiguity_px)
        self.forget_ms = float(forget_ms)
        self.min_size_ratio = float(min_size_ratio)
        self.max_size_ratio = float(max_size_ratio)
        self._previous: Optional[TargetCandidate] = None
        self._last_seen_ms: Optional[float] = None

    @property
    def current(self) -> Optional[TargetCandidate]:
        return self._previous

    def reset(self) -> None:
        self._previous = None
        self._last_seen_ms = None

    def update(
        self,
        candidates: Sequence[TargetCandidate],
        t_ms: float,
    ) -> Association:
        previous = self._previous
        forgotten = (
            previous is None
            or self._last_seen_ms is None
            or t_ms - self._last_seen_ms > self.forget_ms
        )
        if forgotten:
            chosen = self._acquire(candidates)
            if chosen is None:
                return Association(None)
            self._previous = chosen
            self._last_seen_ms = t_ms
            return Association(chosen, acquired=True)

        dt_s = max(0.0, (t_ms - self._last_seen_ms) / 1000.0)
        gate = self.gate_px * max(1.0, dt_s * FPS)
        scored: list[tuple[float, TargetCandidate]] = []
        for candidate in candidates:
            if candidate.size <= 0.0 or previous.size <= 0.0:
                continue
            ratio = (candidate.size / previous.size) ** 2
            if not (self.min_size_ratio <= ratio <= self.max_size_ratio):
                continue
            distance = math.hypot(
                candidate.centroid[0] - previous.centroid[0],
                candidate.centroid[1] - previous.centroid[1],
            )
            if distance <= gate:
                scored.append((distance, candidate))
        if not scored:
            return Association(None)
        scored.sort(key=lambda item: (item[0], item[1].centroid[0], item[1].centroid[1]))
        if len(scored) >= 2 and scored[1][0] - scored[0][0] < self.ambiguity_px:
            return Association(None, ambiguous=True)
        else:
            chosen = scored[0][1]
        self._previous = chosen
        self._last_seen_ms = t_ms
        return Association(chosen)

    @staticmethod
    def _acquire(
        candidates: Sequence[TargetCandidate],
    ) -> Optional[TargetCandidate]:
        pool = [candidate for candidate in candidates if candidate.size > 0.0]
        if not pool:
            return None
        return min(
            pool,
            key=lambda item: (-item.size, item.centroid[0], item.centroid[1]),
        )


class OneEuro:
    """Reference One-Euro filter with explicit ``None`` previous-time check."""

    def __init__(
        self,
        mincutoff: float = ONEURO_MINCUTOFF,
        beta: float = ONEURO_BETA,
        dcutoff: float = ONEURO_DCUTOFF,
    ) -> None:
        self.mincutoff = mincutoff
        self.beta = beta
        self.dcutoff = dcutoff
        self._x: Optional[float] = None
        self._dx: float = 0.0
        self._t: Optional[float] = None

    def reset(self) -> None:
        self._x = None
        self._dx = 0.0
        self._t = None

    @staticmethod
    def _alpha(te: float, cutoff: float) -> float:
        tau = 1.0 / (2.0 * math.pi * max(cutoff, 1e-6))
        return 1.0 / (1.0 + tau / te)

    def apply(self, x: float, t: float) -> float:
        if self._x is None:
            self._x = x
            self._dx = 0.0
            self._t = t
            return x
        te = max(t - (self._t if self._t is not None else t), 1e-3)
        dx = (x - self._x) / te
        a_d = self._alpha(te, self.dcutoff)
        dx_hat = a_d * dx + (1.0 - a_d) * self._dx
        cutoff = self.mincutoff + self.beta * abs(dx_hat)
        a = self._alpha(te, cutoff)
        x_hat = a * x + (1.0 - a) * self._x
        self._x = x_hat
        self._dx = dx_hat
        self._t = t
        return x_hat


@dataclass(frozen=True)
class FilterOutput:
    state: str
    fresh: bool
    xyz: Optional[np.ndarray]
    sample_time_ms: Optional[float]
    reason: Optional[str]
    epoch: int


class SpatialFilter:
    """Validated XYZ filtering and the explicit fault state machine.

    Samples are physical camera millimetres with injected host-monotonic
    timestamps.  Rejected samples never enter the median or the smoother; a
    held output repeats the last trusted point unchanged, and a distant
    re-lock or hard timeout advances ``epoch`` exactly once.
    """

    def __init__(
        self,
        *,
        relock_frames: int = RELOCK_FRAMES,
        relock_cluster_mm: float = RELOCK_CLUSTER_MM,
        hold_timeout_ms: float = HOLD_TIMEOUT_MS,
        resume_frames: int = RESUME_FRAMES,
        resume_distance_mm: float = RESUME_DISTANCE_MM,
    ) -> None:
        self.relock_frames = int(relock_frames)
        self.relock_cluster_mm = float(relock_cluster_mm)
        self.hold_timeout_ms = float(hold_timeout_ms)
        self.resume_frames = int(resume_frames)
        self.resume_distance_mm = float(resume_distance_mm)
        self._euro = [OneEuro() for _ in range(3)]
        self._accepted: deque[np.ndarray] = deque(maxlen=Z_MEDIAN_LEN)
        self._last_raw: Optional[np.ndarray] = None
        self._last_raw_t: Optional[float] = None
        self._output: Optional[np.ndarray] = None
        self._sample_t: Optional[float] = None
        self._pending: list[np.ndarray] = []
        self._pending_t: Optional[float] = None
        self._resume: list[tuple[np.ndarray, float]] = []
        self._gapping = False
        self._epoch = 0
        self._ever_locked = False
        self._invalidated = False
        self._lost = False
        self._last_seen_t: Optional[float] = None

    @property
    def epoch(self) -> int:
        return self._epoch

    @property
    def last_z(self) -> Optional[float]:
        """Current-Z ranking hint for depth estimation; never a hard clip."""

        if self._last_raw is not None:
            return float(self._last_raw[2])
        if self._pending:
            return float(np.median(np.array([sample[2] for sample in self._pending])))
        return None

    def reset(self) -> None:
        for euro in self._euro:
            euro.reset()
        self._accepted.clear()
        self._last_raw = None
        self._last_raw_t = None
        self._output = None
        self._sample_t = None
        self._pending = []
        self._pending_t = None
        self._resume = []
        self._gapping = False
        self._epoch = 0
        self._ever_locked = False
        self._invalidated = False
        self._lost = False
        self._last_seen_t = None

    def invalidate(self) -> None:
        """External identity replacement: drop the trusted point once."""

        if not self._invalidated and self._ever_locked:
            self._epoch += 1
        self._invalidated = True
        self._clear_trusted()
        self._pending = []
        self._pending_t = None
        self._resume = []
        self._gapping = False

    def update(
        self,
        t_ms: float,
        raw_xyz: Optional[Sequence[float]],
        reason: Optional[str] = None,
        *,
        now_ms: Optional[float] = None,
    ) -> FilterOutput:
        """Process one real capture; ``now_ms`` is the processing clock.

        ``t_ms`` is the translated capture timestamp and must increase
        strictly across real observations.  ``now_ms`` is the host
        monotonic processing time used for expiry, so watchdog misses can
        age out a trusted point without poisoning the capture watermark.
        """

        now_ms = t_ms if now_ms is None else now_ms
        if not math.isfinite(now_ms):
            now_ms = t_ms
        valid_t = math.isfinite(t_ms)
        if valid_t and self._last_seen_t is not None and t_ms <= self._last_seen_t:
            valid_t = False
            reason = reason or "backward_time"
        elif not valid_t:
            reason = reason or "bad_time"
        if valid_t:
            self._last_seen_t = t_ms

        raw = self._coerce_xyz(raw_xyz) if valid_t else None
        if valid_t and raw_xyz is not None and raw is None:
            reason = reason or "non_finite"

        trusted = self._output is not None
        if trusted and now_ms - self._sample_t >= self.hold_timeout_ms:
            self._timeout()
            trusted = False
            if raw is None:
                return self._result("lost", reason or "timeout")
            timed_out = True
        else:
            timed_out = False

        if raw is None:
            self._pending = []
            self._pending_t = None
            self._resume = []
            if trusted:
                self._gapping = True
                return self._result("held", reason or "missing")
            return self._result("lost" if self._lost else "acquiring", reason)

        if trusted:
            return self._update_trusted(raw, t_ms, reason)
        return self._update_relock(raw, t_ms, timed_out=timed_out)

    def miss(self, now_ms: float, reason: Optional[str] = None) -> FilterOutput:
        """A processing-clock tick with no usable capture observation.

        Expires the trusted point against ``now_ms`` without advancing the
        capture-order watermark, so a slightly earlier genuine capture is
        still accepted afterwards.  Pending acquisition/resume resets.
        """

        if not math.isfinite(now_ms):
            now_ms = self._sample_t if self._sample_t is not None else 0.0
        self._pending = []
        self._pending_t = None
        self._resume = []
        if self._output is not None:
            if now_ms - self._sample_t >= self.hold_timeout_ms:
                self._timeout()
                return self._result("lost", reason or "timeout")
            self._gapping = True
            return self._result("held", reason or "missing")
        return self._result("lost" if self._lost else "acquiring", reason)

    @staticmethod
    def _coerce_xyz(raw_xyz: Optional[Sequence[float]]) -> Optional[np.ndarray]:
        if raw_xyz is None:
            return None
        try:
            raw = np.asarray(raw_xyz, dtype=np.float64)
        except (TypeError, ValueError):
            return None
        if raw.shape != (3,) or not np.all(np.isfinite(raw)):
            return None
        return raw

    def _result(
        self,
        state: str,
        reason: Optional[str],
        xyz: Optional[np.ndarray] = None,
        sample_t: Optional[float] = None,
        fresh: bool = False,
    ) -> FilterOutput:
        if state == "held":
            xyz = self._output
            sample_t = self._sample_t
        elif state == "tracked":
            xyz = self._output
            sample_t = self._sample_t
            fresh = True
        return FilterOutput(state, fresh, xyz, sample_t, reason, self._epoch)

    def _clear_trusted(self) -> None:
        self._output = None
        self._sample_t = None
        self._last_raw = None
        self._last_raw_t = None
        self._accepted.clear()
        for euro in self._euro:
            euro.reset()

    def _timeout(self) -> None:
        self._clear_trusted()
        self._pending = []
        self._pending_t = None
        self._resume = []
        self._gapping = False
        if not self._invalidated:
            self._epoch += 1
        self._invalidated = True
        self._lost = True

    def _accept(self, raw: np.ndarray, t_ms: float) -> FilterOutput:
        self._last_raw = raw
        self._last_raw_t = t_ms
        self._accepted.append(raw)
        median = np.median(np.array(self._accepted), axis=0)
        t_s = t_ms / 1000.0
        self._output = np.array(
            [euro.apply(float(median[axis]), t_s) for axis, euro in enumerate(self._euro)]
        )
        self._sample_t = t_ms
        self._gapping = False
        self._resume = []
        self._pending = []
        self._pending_t = None
        self._ever_locked = True
        self._invalidated = False
        self._lost = False
        return self._result("tracked", None)

    def _update_trusted(
        self,
        raw: np.ndarray,
        t_ms: float,
        reason: Optional[str],
    ) -> FilterOutput:
        dt_s = max(
            0.0,
            (t_ms - (self._last_raw_t if self._last_raw_t is not None else t_ms)) / 1000.0,
        )
        max_step = JUMP_BASE_MM + JUMP_RATE_MM_S * min(dt_s, JUMP_DT_CAP_S)
        distance = float(np.linalg.norm(raw - self._last_raw))
        if not self._gapping:
            if distance <= max_step:
                return self._accept(raw, t_ms)
            self._gapping = True
            self._resume = []
            self._pending = [raw]
            self._pending_t = t_ms
            return self._result("held", reason or "jump")

        if distance <= self.resume_distance_mm:
            self._resume.append((raw, t_ms))
            if len(self._resume) >= self.resume_frames:
                output = None
                for sample, sample_t in self._resume:
                    output = self._accept(sample, sample_t)
                return output
            return self._result("held", reason or "resuming")
        self._resume = []
        self._pending = self._cluster(self._pending, raw, t_ms)
        if len(self._pending) >= self.relock_frames:
            return self._distant_relock(t_ms)
        return self._result("held", reason or "reacquiring")

    def _cluster(
        self,
        pending: list[np.ndarray],
        raw: np.ndarray,
        t_ms: float,
    ) -> list[np.ndarray]:
        if pending and self._pending_t is not None and t_ms - self._pending_t >= self.hold_timeout_ms:
            pending = []
        trial = pending + [raw]
        center = np.median(np.array(trial), axis=0)
        if any(
            float(np.linalg.norm(sample - center)) > self.relock_cluster_mm
            for sample in trial
        ):
            self._pending_t = t_ms
            return [raw]
        self._pending_t = t_ms
        return trial

    def _update_relock(
        self,
        raw: np.ndarray,
        t_ms: float,
        *,
        timed_out: bool,
    ) -> FilterOutput:
        self._pending = self._cluster(self._pending, raw, t_ms)
        if len(self._pending) < self.relock_frames:
            return self._result(
                "lost" if (self._lost or timed_out) else "acquiring",
                "reacquiring",
            )
        median = np.median(np.array(self._pending), axis=0)
        self._pending = []
        self._clear_trusted()
        return self._accept(median, t_ms)

    def _distant_relock(self, t_ms: float) -> FilterOutput:
        median = np.median(np.array(self._pending), axis=0)
        self._pending = []
        if not self._invalidated:
            self._epoch += 1
        self._clear_trusted()
        self._invalidated = False
        return self._accept(median, t_ms)


__all__ = [
    "ASSOC_AMBIGUITY_PX",
    "ASSOC_FORGET_MS",
    "ASSOC_GATE_PX",
    "Association",
    "COLOR_PRESET_HUE",
    "ColorCandidate",
    "DepthEstimate",
    "FilterOutput",
    "FPS",
    "HOLD_TIMEOUT_S",
    "LED_BGR_MARGIN",
    "LED_BGR_MIN",
    "LED_MIN_AREA",
    "LED_OFFSET_PX",
    "MAX_DEPTH_SPREAD_MM",
    "MAX_PAIR_SKEW_MS",
    "MAX_SAMPLE_AGE_MS",
    "MAX_Z_MM",
    "MIN_DEPTH_PIXELS",
    "MIN_Z_MM",
    "OneEuro",
    "RGB_HEIGHT",
    "RGB_WIDTH",
    "ROI_HALF_PX",
    "RELOCK_CLUSTER_MM",
    "RELOCK_FRAMES",
    "RESUME_DISTANCE_MM",
    "RESUME_FRAMES",
    "RoiStat",
    "SpatialFilter",
    "TargetAssociator",
    "TargetCandidate",
    "color_hue_ranges",
    "estimate_depth",
    "find_color_candidates",
    "led_sample_points",
    "pixel_to_xyz",
    "roi_bounds",
    "roi_depth_stats",
    "validate_intrinsics",
]
