"""Deterministic gesture state and canvas-view math for the webcam app.

The webcam-facing code converts MediaPipe landmarks into :class:`HandObservation`
objects.  Everything below is deliberately independent of MediaPipe and OpenCV
so pinch hysteresis, hand matching, navigation and view math can be tested with
small synthetic inputs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import itertools
import math
import time
from typing import Any, Iterable, Mapping, Optional, Sequence


Point = tuple[float, float]


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _add(a: Point, b: Point) -> Point:
    return (a[0] + b[0], a[1] + b[1])


def _subtract(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1])


def _scale(point: Point, amount: float) -> Point:
    return (point[0] * amount, point[1] * amount)


def _midpoint(a: Point, b: Point) -> Point:
    return ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)


def _finite_point(value: Sequence[float]) -> Point:
    if len(value) != 2:
        raise ValueError("a point must contain exactly two values")
    point = (float(value[0]), float(value[1]))
    if not all(math.isfinite(component) for component in point):
        raise ValueError("point coordinates must be finite")
    return point


def _normalise_label(value: Any) -> Optional[str]:
    if value is None:
        return None
    label = str(value).strip().lower()
    if not label:
        return None
    if label in {"left", "l"}:
        return "left"
    if label in {"right", "r"}:
        return "right"
    return label


def _angle_delta(current: float, previous: float) -> float:
    """Return the shortest signed angle from ``previous`` to ``current``."""

    return (current - previous + math.pi) % (2.0 * math.pi) - math.pi


@dataclass(frozen=True)
class HandObservation:
    """One frame's geometric hand input.

    Coordinates are in the mirrored camera-frame pixel space.  ``palm_size``
    must use the same unit as the points.  ``open_palm`` should only be true
    when the caller has verified intentional extension of the fingers; the
    engine does not infer an open hand from mere detection.
    """

    index_tip: Point
    thumb_tip: Point
    palm_center: Point
    palm_size: float = 1.0
    handedness: Optional[str] = None
    open_palm: bool = False
    open_finger_count: int = 0
    landmarks: tuple[Point, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "index_tip", _finite_point(self.index_tip))
        object.__setattr__(self, "thumb_tip", _finite_point(self.thumb_tip))
        object.__setattr__(self, "palm_center", _finite_point(self.palm_center))
        size = float(self.palm_size)
        if not math.isfinite(size) or size <= 0.0:
            raise ValueError("palm_size must be a finite positive number")
        object.__setattr__(self, "palm_size", size)
        object.__setattr__(self, "handedness", _normalise_label(self.handedness))
        object.__setattr__(self, "open_palm", bool(self.open_palm))
        object.__setattr__(self, "open_finger_count", int(self.open_finger_count))
        object.__setattr__(
            self,
            "landmarks",
            tuple(_finite_point(point) for point in self.landmarks),
        )

    @property
    def fully_open(self) -> bool:
        return self.open_palm or self.open_finger_count >= 4


@dataclass(frozen=True)
class StrokeEvent:
    """A pinch-driven stroke lifecycle event."""

    kind: str  # ``start``, ``point`` or ``end``
    hand_id: int
    point: Optional[Point] = None
    reason: str = ""


@dataclass(frozen=True)
class NavigationDelta:
    """A frame-to-frame camera-space navigation update.

    For two-hand navigation, ``anchor`` is the previous handle midpoint and
    ``target_anchor`` is its current position.  Keeping both lets the view
    transform apply pan, zoom and rotation in one anchored, non-drifting step.
    """

    mode: str  # ``one`` or ``two``
    pan_delta: Point = (0.0, 0.0)
    zoom_factor: float = 1.0
    rotation_delta: float = 0.0
    anchor: Optional[Point] = None
    target_anchor: Optional[Point] = None

    @property
    def pan(self) -> Point:
        return self.pan_delta

    @property
    def zoom(self) -> float:
        return self.zoom_factor

    @property
    def rotation(self) -> float:
        return self.rotation_delta


@dataclass(frozen=True)
class TrackedHand:
    """The stable, smoothed state exposed for drawing overlays."""

    hand_id: int
    handedness: Optional[str]
    index_tip: Point
    thumb_tip: Point
    palm_center: Point
    palm_size: float
    pinch_ratio: float
    pinching: bool
    open_palm: bool
    open_armed: bool
    visible: bool = True

    @property
    def id(self) -> int:
        return self.hand_id

    @property
    def is_drawing(self) -> bool:
        return self.pinching


@dataclass(frozen=True)
class GestureFrame:
    """Output of one :meth:`GestureEngine.update` call."""

    timestamp_ms: float
    hands: tuple[TrackedHand, ...] = ()
    stroke_events: tuple[StrokeEvent, ...] = ()
    navigation: Optional[NavigationDelta] = None
    any_drawing: bool = False
    lost_hand_ids: tuple[int, ...] = ()
    navigation_mode: Optional[str] = None

    @property
    def drawing(self) -> bool:
        return self.any_drawing


@dataclass
class _Track:
    hand_id: int
    handedness: Optional[str]
    index_tip: Point
    thumb_tip: Point
    palm_center: Point
    palm_size: float
    pinch_ratio: float
    visible: bool = True
    pinching: bool = False
    pinch_candidate_since: Optional[float] = None
    release_candidate_since: Optional[float] = None
    open_palm: bool = False
    open_candidate_since: Optional[float] = None
    open_armed: bool = False
    last_seen_ms: float = 0.0
    missing_since_ms: Optional[float] = None
    velocity: Point = (0.0, 0.0)


class GestureEngine:
    """Match hands and turn pinch/open gestures into stable events.

    ``timestamp_ms`` is explicit so tests can advance time without sleeping.
    Hand ids are retained briefly across detector loss, while active pinches
    are always ended on loss and must be re-established after a discontinuity.
    """

    def __init__(
        self,
        *,
        pinch_on_ratio: float = 0.48,
        pinch_off_ratio: float = 0.64,
        pinch_debounce_ms: float = 60.0,
        open_hold_ms: float = 250.0,
        min_two_hand_separation: float = 80.0,
        nav_move_deadband: float = 3.0,
        nav_scale_deadband: float = 0.015,
        nav_rotation_deadband: float = math.radians(2.0),
        max_zoom_step: float = 0.08,
        max_rotation_step: float = math.radians(12.0),
        track_timeout_ms: float = 450.0,
        match_distance_multiplier: float = 2.75,
        smoothing_alpha: float = 0.50,
    ) -> None:
        if not 0.0 < pinch_on_ratio < pinch_off_ratio:
            raise ValueError("pinch thresholds must satisfy 0 < on < off")
        if pinch_debounce_ms < 0.0 or open_hold_ms < 0.0:
            raise ValueError("gesture durations cannot be negative")
        if min_two_hand_separation <= 0.0:
            raise ValueError("two-hand separation must be positive")
        if not 0.0 < smoothing_alpha <= 1.0:
            raise ValueError("smoothing_alpha must be in (0, 1]")

        self.pinch_on_ratio = float(pinch_on_ratio)
        self.pinch_off_ratio = float(pinch_off_ratio)
        self.pinch_debounce_ms = float(pinch_debounce_ms)
        self.open_hold_ms = float(open_hold_ms)
        self.min_two_hand_separation = float(min_two_hand_separation)
        self.nav_move_deadband = float(nav_move_deadband)
        self.nav_scale_deadband = float(nav_scale_deadband)
        self.nav_rotation_deadband = float(nav_rotation_deadband)
        self.max_zoom_step = float(max_zoom_step)
        self.max_rotation_step = float(max_rotation_step)
        self.track_timeout_ms = float(track_timeout_ms)
        self.match_distance_multiplier = float(match_distance_multiplier)
        self.smoothing_alpha = float(smoothing_alpha)

        self._tracks: dict[int, _Track] = {}
        self._next_hand_id = 1
        self._nav_mode: Optional[str] = None
        self._nav_ids: tuple[int, ...] = ()
        self._nav_previous: Optional[tuple[Point, float, float]] = None
        self._nav_pending_pan: Point = (0.0, 0.0)
        self._nav_pending_zoom_log = 0.0
        self._nav_pending_rotation = 0.0
        self._nav_applied_midpoint: Optional[Point] = None
        # A reset/loss cannot turn a held pinch into a fresh stroke.
        self._must_release = False
        # Unlike deliberate reset, tracking loss only gates the affected hand.
        self._release_gates: set[int] = set()
        # Keep a small tombstone for a hand that disappears beyond the tracking
        # timeout.  A reappearing held pinch must still release, even if it has
        # received a fresh id; a released hand clears the tombstone immediately.
        self._orphan_release_labels: list[Optional[str]] = []

    @property
    def tracks(self) -> tuple[TrackedHand, ...]:
        """Current visible tracks, useful for diagnostics and tests."""

        return tuple(self._as_public(track) for track in self._visible_tracks())

    def reset_input(self, reason: str = "reset") -> tuple[StrokeEvent, ...]:
        """End active pinches and require a release before accepting a new one."""

        events: list[StrokeEvent] = []
        for track in self._tracks.values():
            if track.pinching:
                events.append(StrokeEvent("end", track.hand_id, reason=reason))
            track.pinching = False
            track.pinch_candidate_since = None
            track.release_candidate_since = None
            track.open_candidate_since = None
            track.open_armed = False
        self._reset_navigation()
        self._release_gates.clear()
        self._orphan_release_labels.clear()
        self._must_release = True
        return tuple(events)

    def reset_navigation(self) -> None:
        """Drop navigation baselines without affecting pinch state."""

        self._reset_navigation()

    def update(
        self,
        observations: Iterable[HandObservation | Mapping[str, Any]],
        timestamp_ms: Optional[float] = None,
    ) -> GestureFrame:
        """Consume one detector frame and return stable gesture events."""

        if timestamp_ms is None:
            timestamp_ms = time.monotonic_ns() / 1_000_000.0
        timestamp = float(timestamp_ms)
        if not math.isfinite(timestamp):
            raise ValueError("timestamp_ms must be finite")

        normalised: list[HandObservation] = []
        for value in observations:
            try:
                normalised.append(self._coerce_observation(value))
            except (TypeError, ValueError):
                # A malformed detector item should not connect the remaining
                # hands or bring down the camera loop.
                continue

        matches = self._match(normalised, timestamp)
        events: list[StrokeEvent] = []
        touched: set[int] = set()

        for track_id, observation in matches:
            track = self._tracks[track_id]
            touched.add(track_id)
            was_visible = track.visible
            if not was_visible:
                # The path was closed on loss.  Reappearing with a held pinch
                # is intentionally ignored until the user releases it.
                track.pinching = False
                track.pinch_candidate_since = None
                track.release_candidate_since = None
                track.open_candidate_since = None
                track.open_armed = False
            self._update_track(track, observation, timestamp, was_visible)
            event = self._update_pinch(track, timestamp)
            if event is not None:
                events.append(event)
            self._update_open_state(track, timestamp)

        lost_ids: list[int] = []
        for track_id, track in list(self._tracks.items()):
            if track_id in touched:
                continue
            if not track.visible:
                if (
                    track.missing_since_ms is not None
                    and timestamp - track.missing_since_ms > self.track_timeout_ms
                ):
                    self._release_gates.discard(track_id)
                    del self._tracks[track_id]
                continue
            track.visible = False
            track.missing_since_ms = timestamp
            lost_ids.append(track_id)
            if track.pinching:
                events.append(StrokeEvent("end", track_id, reason="loss"))
            track.pinching = False
            track.pinch_candidate_since = None
            track.release_candidate_since = None
            track.open_candidate_since = None
            track.open_armed = False
            track.open_palm = False
            # Tracking loss is a discontinuity just like pause/clear.  A hand
            # that reappears still pinching must release before it can start a
            # new stroke, so it cannot bridge an unseen gap or resume by itself.
            self._release_gates.add(track_id)
            self._orphan_release_labels.append(track.handedness)

        # A release is observed only through geometry, not through a reset or
        # an empty detector frame.  This prevents a held pinch from auto-start.
        if self._must_release:
            visible = self._visible_tracks()
            if visible and all(track.pinch_ratio >= self.pinch_off_ratio for track in visible):
                self._must_release = False

        visible_tracks = self._visible_tracks()
        any_drawing = any(track.pinching for track in visible_tracks)
        navigation = self._compute_navigation(visible_tracks, any_drawing)

        return GestureFrame(
            timestamp_ms=timestamp,
            hands=tuple(self._as_public(track) for track in visible_tracks),
            stroke_events=tuple(events),
            navigation=navigation,
            navigation_mode=self._nav_mode,
            any_drawing=any_drawing,
            lost_hand_ids=tuple(lost_ids),
        )

    def _coerce_observation(
        self,
        value: HandObservation | Mapping[str, Any],
    ) -> HandObservation:
        if isinstance(value, HandObservation):
            return value
        if not isinstance(value, Mapping):
            raise TypeError("observation must be HandObservation or mapping")
        open_count = value.get("open_finger_count", value.get("finger_count", 0))
        return HandObservation(
            index_tip=value["index_tip"],
            thumb_tip=value["thumb_tip"],
            palm_center=value["palm_center"],
            palm_size=value.get("palm_size", 1.0),
            handedness=value.get("handedness", value.get("label")),
            open_palm=value.get("open_palm", value.get("fully_open", False)),
            open_finger_count=open_count,
            landmarks=tuple(value.get("landmarks", ())),
        )

    def _visible_tracks(self) -> list[_Track]:
        return sorted(
            (track for track in self._tracks.values() if track.visible),
            key=lambda track: track.hand_id,
        )

    def _match(
        self,
        observations: Sequence[HandObservation],
        timestamp: float,
    ) -> list[tuple[int, HandObservation]]:
        candidates = [
            track
            for track in self._tracks.values()
            if track.visible
            or (
                track.missing_since_ms is not None
                and timestamp - track.missing_since_ms <= self.track_timeout_ms
            )
        ]
        costs: dict[tuple[int, int], Optional[float]] = {}
        for track_index, track in enumerate(candidates):
            for observation_index, observation in enumerate(observations):
                costs[(track_index, observation_index)] = self._match_cost(
                    track,
                    observation,
                    timestamp,
                )

        # At most two hands are requested from MediaPipe.  Enumerate the small
        # set of pairings so detector-list order cannot steal a track, and so
        # duplicate/missing handedness labels do not become identity.
        best_pairs: list[tuple[int, int]] = []
        best_score: tuple[int, float] = (0, 0.0)
        max_pairs = min(len(candidates), len(observations))
        for pair_count in range(1, max_pairs + 1):
            for track_indices in itertools.combinations(range(len(candidates)), pair_count):
                for observation_indices in itertools.permutations(range(len(observations)), pair_count):
                    pair_list = list(zip(track_indices, observation_indices))
                    pair_costs = [costs[pair] for pair in pair_list]
                    if any(cost is None for cost in pair_costs):
                        continue
                    total_cost = sum(float(cost) for cost in pair_costs)
                    score = (pair_count, -total_cost)
                    if score > (best_score[0], -best_score[1]):
                        best_score = (pair_count, total_cost)
                        best_pairs = pair_list

        matched_observations: set[int] = set()
        matches: list[tuple[int, HandObservation]] = []
        for track_index, observation_index in best_pairs:
            track = candidates[track_index]
            matched_observations.add(observation_index)
            matches.append((track.hand_id, observations[observation_index]))

        for observation_index, observation in enumerate(observations):
            if observation_index in matched_observations:
                continue
            hand_id = self._next_hand_id
            self._next_hand_id += 1
            self._tracks[hand_id] = _Track(
                hand_id=hand_id,
                handedness=observation.handedness,
                index_tip=observation.index_tip,
                thumb_tip=observation.thumb_tip,
                palm_center=observation.palm_center,
                palm_size=observation.palm_size,
                pinch_ratio=self._pinch_ratio(observation),
                last_seen_ms=timestamp,
            )
            orphan_index = self._orphan_label_index(observation.handedness)
            if orphan_index is not None:
                self._release_gates.add(hand_id)
                self._orphan_release_labels.pop(orphan_index)
            matches.append((hand_id, observation))

        return matches

    def _match_cost(
        self,
        track: _Track,
        observation: HandObservation,
        timestamp: float,
    ) -> Optional[float]:
        elapsed = max(0.0, timestamp - track.last_seen_ms)
        predicted = _add(track.palm_center, _scale(track.velocity, min(elapsed, 250.0)))
        distance = _distance(predicted, observation.palm_center)
        size = max(track.palm_size, observation.palm_size, 1.0)
        gate = max(55.0, self.match_distance_multiplier * size)
        if distance > gate:
            return None
        cost = distance / size
        if track.handedness and observation.handedness == track.handedness:
            cost -= 0.5
        elif track.handedness and observation.handedness:
            # Handedness is a useful hint but MediaPipe can flicker or report
            # duplicate labels near a crossing.  Distance remains authoritative.
            cost += 0.5
        if not track.visible:
            cost += 0.15
        return cost

    def _orphan_label_index(self, label: Optional[str]) -> Optional[int]:
        if label in self._orphan_release_labels:
            return self._orphan_release_labels.index(label)
        if None in self._orphan_release_labels:
            return self._orphan_release_labels.index(None)
        if label is None and self._orphan_release_labels:
            return 0
        return None

    def _update_track(
        self,
        track: _Track,
        observation: HandObservation,
        timestamp: float,
        was_visible: bool,
    ) -> None:
        old_center = track.palm_center
        alpha = self.smoothing_alpha if was_visible else 1.0
        track.index_tip = self._smooth(track.index_tip, observation.index_tip, alpha)
        track.thumb_tip = self._smooth(track.thumb_tip, observation.thumb_tip, alpha)
        track.palm_center = self._smooth(track.palm_center, observation.palm_center, alpha)
        track.palm_size = track.palm_size + alpha * (observation.palm_size - track.palm_size)
        elapsed = max(1.0, timestamp - track.last_seen_ms)
        raw_velocity = _scale(_subtract(track.palm_center, old_center), 1.0 / elapsed)
        track.velocity = self._smooth(track.velocity, raw_velocity, alpha)
        track.pinch_ratio = self._pinch_ratio(observation)
        if observation.handedness is not None:
            track.handedness = observation.handedness
        track.open_palm = observation.fully_open
        track.visible = True
        track.missing_since_ms = None
        track.last_seen_ms = timestamp

    def _smooth(self, previous: Point, current: Point, alpha: float) -> Point:
        return (
            previous[0] + alpha * (current[0] - previous[0]),
            previous[1] + alpha * (current[1] - previous[1]),
        )

    def _pinch_ratio(self, observation: HandObservation) -> float:
        return _distance(observation.index_tip, observation.thumb_tip) / max(
            observation.palm_size, 1e-6
        )

    def _update_pinch(self, track: _Track, timestamp: float) -> Optional[StrokeEvent]:
        ratio = track.pinch_ratio
        if self._must_release:
            track.pinch_candidate_since = None
            track.release_candidate_since = None
            return None
        if track.hand_id in self._release_gates:
            if ratio >= self.pinch_off_ratio:
                self._release_gates.discard(track.hand_id)
                self._discard_orphan_label(track.handedness)
            return None

        if track.pinching:
            if ratio >= self.pinch_off_ratio:
                if track.release_candidate_since is None:
                    track.release_candidate_since = timestamp
                elif timestamp - track.release_candidate_since >= self.pinch_debounce_ms:
                    track.pinching = False
                    track.release_candidate_since = None
                    return StrokeEvent("end", track.hand_id, reason="release")
            else:
                track.release_candidate_since = None
            return StrokeEvent("point", track.hand_id, track.index_tip)

        if ratio <= self.pinch_on_ratio:
            if track.pinch_candidate_since is None:
                track.pinch_candidate_since = timestamp
            elif timestamp - track.pinch_candidate_since >= self.pinch_debounce_ms:
                track.pinching = True
                track.pinch_candidate_since = None
                track.release_candidate_since = None
                return StrokeEvent("start", track.hand_id, track.index_tip)
        else:
            track.pinch_candidate_since = None
        return None

    def _update_open_state(self, track: _Track, timestamp: float) -> None:
        if not track.open_palm or track.pinching:
            track.open_candidate_since = None
            track.open_armed = False
            return
        if track.open_candidate_since is None:
            track.open_candidate_since = timestamp
            track.open_armed = False
        elif timestamp - track.open_candidate_since >= self.open_hold_ms:
            track.open_armed = True

    def _compute_navigation(
        self,
        tracks: Sequence[_Track],
        any_drawing: bool,
    ) -> Optional[NavigationDelta]:
        # Pinch intent wins as soon as it enters the onset debounce window, not
        # only after the stroke has officially started.
        if any_drawing or any(track.pinch_candidate_since is not None for track in tracks):
            self._reset_navigation()
            return None

        open_tracks = [track for track in tracks if track.open_palm and track.open_armed]
        if len(open_tracks) >= 2:
            first, second = open_tracks[:2]
            separation = _distance(first.palm_center, second.palm_center)
            if separation < self.min_two_hand_separation:
                self._reset_navigation()
                return None
            midpoint = _midpoint(first.palm_center, second.palm_center)
            angle = math.atan2(
                second.palm_center[1] - first.palm_center[1],
                second.palm_center[0] - first.palm_center[0],
            )
            ids = tuple(sorted((first.hand_id, second.hand_id)))
            if self._nav_mode != "two" or self._nav_ids != ids or self._nav_previous is None:
                self._nav_mode = "two"
                self._nav_ids = ids
                self._nav_previous = (midpoint, separation, angle)
                self._nav_pending_pan = (0.0, 0.0)
                self._nav_pending_zoom_log = 0.0
                self._nav_pending_rotation = 0.0
                self._nav_applied_midpoint = midpoint
                return None
            previous_midpoint, previous_separation, previous_angle = self._nav_previous
            self._nav_previous = (midpoint, separation, angle)
            # Keep the latest detector sample separate from the last emitted
            # navigation update.  Sub-deadband movement therefore accumulates
            # instead of being thrown away every frame.
            self._nav_pending_pan = _add(
                self._nav_pending_pan,
                _subtract(midpoint, previous_midpoint),
            )
            frame_zoom_log = math.log(separation / max(previous_separation, 1e-6))
            frame_rotation = _angle_delta(angle, previous_angle)
            self._nav_pending_zoom_log += frame_zoom_log
            self._nav_pending_rotation += frame_rotation

            pan_ready = _distance(self._nav_pending_pan, (0.0, 0.0)) >= self.nav_move_deadband
            zoom_ready = abs(self._nav_pending_zoom_log) >= math.log1p(self.nav_scale_deadband)
            rotation_ready = abs(self._nav_pending_rotation) >= self.nav_rotation_deadband
            if not pan_ready and not zoom_ready and not rotation_ready:
                return None

            pan_delta = self._nav_pending_pan if pan_ready else (0.0, 0.0)
            if pan_ready:
                self._nav_pending_pan = (0.0, 0.0)

            zoom_factor = 1.0
            if zoom_ready and abs(frame_zoom_log) > 1e-9:
                requested_zoom = math.exp(self._nav_pending_zoom_log)
                zoom_factor = min(
                    1.0 + self.max_zoom_step,
                    max(1.0 - self.max_zoom_step, requested_zoom),
                )
                # Preserve a clamped remainder for a later real hand movement
                # instead of silently dropping it.
                self._nav_pending_zoom_log -= math.log(zoom_factor)

            rotation_delta = 0.0
            if rotation_ready and abs(frame_rotation) > 1e-9:
                rotation_delta = min(
                    self.max_rotation_step,
                    max(-self.max_rotation_step, self._nav_pending_rotation),
                )
                self._nav_pending_rotation -= rotation_delta

            if pan_delta == (0.0, 0.0) and zoom_factor == 1.0 and rotation_delta == 0.0:
                return None
            anchor = self._nav_applied_midpoint or midpoint
            target_anchor = _add(anchor, pan_delta)
            self._nav_applied_midpoint = target_anchor
            return NavigationDelta(
                mode="two",
                pan_delta=pan_delta,
                zoom_factor=zoom_factor,
                rotation_delta=rotation_delta,
                anchor=anchor,
                target_anchor=target_anchor,
            )

        if len(open_tracks) == 1:
            track = open_tracks[0]
            ids = (track.hand_id,)
            if self._nav_mode != "one" or self._nav_ids != ids or self._nav_previous is None:
                self._nav_mode = "one"
                self._nav_ids = ids
                self._nav_previous = (track.palm_center, 1.0, 0.0)
                self._nav_pending_pan = (0.0, 0.0)
                self._nav_applied_midpoint = track.palm_center
                return None
            previous_center, _unused_separation, _unused_angle = self._nav_previous
            self._nav_previous = (track.palm_center, 1.0, 0.0)
            self._nav_pending_pan = _add(
                self._nav_pending_pan,
                _subtract(track.palm_center, previous_center),
            )
            if _distance(self._nav_pending_pan, (0.0, 0.0)) < self.nav_move_deadband:
                return None
            delta = self._nav_pending_pan
            self._nav_pending_pan = (0.0, 0.0)
            self._nav_applied_midpoint = _add(self._nav_applied_midpoint or previous_center, delta)
            return NavigationDelta(mode="one", pan_delta=delta)

        self._reset_navigation()
        return None

    def _reset_navigation(self) -> None:
        self._nav_mode = None
        self._nav_ids = ()
        self._nav_previous = None
        self._nav_pending_pan = (0.0, 0.0)
        self._nav_pending_zoom_log = 0.0
        self._nav_pending_rotation = 0.0
        self._nav_applied_midpoint = None

    def _discard_orphan_label(self, label: Optional[str]) -> None:
        try:
            self._orphan_release_labels.remove(label)
        except ValueError:
            pass

    def _as_public(self, track: _Track) -> TrackedHand:
        return TrackedHand(
            hand_id=track.hand_id,
            handedness=track.handedness,
            index_tip=track.index_tip,
            thumb_tip=track.thumb_tip,
            palm_center=track.palm_center,
            palm_size=track.palm_size,
            pinch_ratio=track.pinch_ratio,
            pinching=track.pinching,
            open_palm=track.open_palm,
            open_armed=track.open_armed,
            visible=track.visible,
        )


@dataclass
class ViewTransform:
    """An invertible, non-destructive transform for saved canvas paths."""

    viewport_center: Point = (0.0, 0.0)
    pan: Point = (0.0, 0.0)
    scale: float = 1.0
    rotation: float = 0.0
    min_scale: float = 0.35
    max_scale: float = 4.0

    def __post_init__(self) -> None:
        self.viewport_center = _finite_point(self.viewport_center)
        self.pan = _finite_point(self.pan)
        self.scale = float(self.scale)
        self.rotation = float(self.rotation)
        if self.min_scale <= 0.0 or self.max_scale < self.min_scale:
            raise ValueError("invalid view scale bounds")
        self.scale = min(self.max_scale, max(self.min_scale, self.scale))

    @property
    def zoom(self) -> float:
        return self.scale

    def canvas_to_screen(self, point: Sequence[float]) -> Point:
        relative = _subtract(_finite_point(point), self.viewport_center)
        rotated = self._rotate(relative, self.rotation)
        return _add(
            _add(self.viewport_center, self.pan),
            _scale(rotated, self.scale),
        )

    def screen_to_canvas(self, point: Sequence[float]) -> Point:
        relative = _subtract(_finite_point(point), _add(self.viewport_center, self.pan))
        unscaled = _scale(relative, 1.0 / self.scale)
        return _add(self.viewport_center, self._rotate(unscaled, -self.rotation))

    def apply_pan(self, delta: Sequence[float]) -> None:
        self.pan = _add(self.pan, _finite_point(delta))

    def apply_navigation(
        self,
        navigation: Optional[NavigationDelta] = None,
        *,
        pan_delta: Sequence[float] = (0.0, 0.0),
        zoom_factor: float = 1.0,
        rotation_delta: float = 0.0,
        anchor: Optional[Sequence[float]] = None,
    ) -> None:
        """Apply one navigation update while preserving an optional anchor."""

        if navigation is not None:
            pan = navigation.pan_delta
            zoom = navigation.zoom_factor
            rotation = navigation.rotation_delta
            old_anchor = navigation.anchor
            target_anchor = navigation.target_anchor
            mode = navigation.mode
        else:
            pan = _finite_point(pan_delta)
            zoom = float(zoom_factor)
            rotation = float(rotation_delta)
            old_anchor = _finite_point(anchor) if anchor is not None else None
            target_anchor = _add(old_anchor, pan) if old_anchor is not None else None
            mode = "two" if old_anchor is not None else "one"

        if not math.isfinite(zoom) or zoom <= 0.0:
            raise ValueError("zoom_factor must be finite and positive")
        if not math.isfinite(rotation):
            raise ValueError("rotation_delta must be finite")

        if mode == "two" and old_anchor is not None:
            target = target_anchor if target_anchor is not None else _add(old_anchor, pan)
            anchor_canvas = self.screen_to_canvas(old_anchor)
            self.scale = min(self.max_scale, max(self.min_scale, self.scale * zoom))
            self.rotation = _wrapped_angle(self.rotation + rotation)
            transformed = _scale(
                self._rotate(_subtract(anchor_canvas, self.viewport_center), self.rotation),
                self.scale,
            )
            self.pan = _subtract(_subtract(target, self.viewport_center), transformed)
            return

        if zoom != 1.0 or rotation != 0.0:
            anchor_point = old_anchor or self.viewport_center
            target = target_anchor if target_anchor is not None else _add(anchor_point, pan)
            anchor_canvas = self.screen_to_canvas(anchor_point)
            self.scale = min(self.max_scale, max(self.min_scale, self.scale * zoom))
            self.rotation = _wrapped_angle(self.rotation + rotation)
            transformed = _scale(
                self._rotate(_subtract(anchor_canvas, self.viewport_center), self.rotation),
                self.scale,
            )
            self.pan = _subtract(_subtract(target, self.viewport_center), transformed)
        else:
            self.apply_pan(pan)

    def reset(self) -> None:
        self.pan = (0.0, 0.0)
        self.scale = 1.0
        self.rotation = 0.0

    @staticmethod
    def _rotate(point: Point, angle: float) -> Point:
        cosine = math.cos(angle)
        sine = math.sin(angle)
        return (
            cosine * point[0] - sine * point[1],
            sine * point[0] + cosine * point[1],
        )


def _wrapped_angle(angle: float) -> float:
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


__all__ = [
    "GestureEngine",
    "GestureFrame",
    "HandObservation",
    "NavigationDelta",
    "Point",
    "StrokeEvent",
    "TrackedHand",
    "ViewTransform",
]
