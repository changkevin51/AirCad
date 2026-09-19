"""Conservative geometric recognition for completed fingertip strokes.

The runtime owns gesture state and calls :func:`recognize_shape` once a stroke
is complete.  This module deliberately has no camera, MediaPipe, or UI
dependencies.  It only turns a finite sequence of canvas coordinates into a
small canonical polyline when the evidence for a simple shape is strong.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable

import numpy as np


Point = tuple[float, float]


@dataclass
class ShapeMatch:
    """A recognized shape and the polyline that should be rendered for it."""

    kind: str
    points: list[Point]
    confidence: float


# Closed polygon strokes need a few samples on their sides.  Circles need more
# samples so that a sparse polygon is not mistaken for a smooth circle.
_MIN_POLYGON_SAMPLES = 6
_MIN_CIRCLE_SAMPLES = 12
_MIN_LINE_LENGTH = 3.0
_MIN_POLYGON_CONFIDENCE = 0.62
_MIN_CIRCLE_CONFIDENCE = 0.72
_CIRCLE_RENDER_SAMPLES = 64


def recognize_shape(points: Iterable[Iterable[float]]) -> ShapeMatch | None:
    """Recognize a completed line, circle, triangle, or rectangle.

    ``points`` are canvas coordinates in the order they were drawn.  Open,
    nearly straight strokes can become a line.  Other shapes must be nearly
    closed; their returned polylines explicitly repeat the first point.  A
    malformed or non-finite stroke is rejected rather than partially repaired.
    """

    stroke = _clean_points(points)
    if stroke is None or len(stroke) < 2:
        return None

    scale = _bbox_diagonal(stroke)
    endpoint_gap = float(np.linalg.norm(stroke[-1] - stroke[0]))
    perimeter = _closed_length(stroke)
    close_limit = max(2.0, 0.06 * scale)
    is_closed = (
        endpoint_gap <= close_limit
        and endpoint_gap <= 0.08 * max(perimeter, scale)
    )

    if not is_closed:
        return _recognize_line(stroke)

    ring = stroke[:-1] if endpoint_gap <= 1e-9 else stroke
    if len(ring) < _MIN_POLYGON_SAMPLES:
        return None

    sampled = _resample_closed(ring, 64)
    if sampled is None:
        return None

    candidates: list[ShapeMatch] = []
    if len(ring) >= _MIN_CIRCLE_SAMPLES:
        circle = _recognize_circle(sampled, ring)
        if circle is not None and circle.confidence >= _MIN_CIRCLE_CONFIDENCE:
            candidates.append(circle)

    triangle = _recognize_polygon(sampled, expected_vertices=3)
    if triangle is not None:
        candidates.append(triangle)
    rectangle = _recognize_polygon(sampled, expected_vertices=4)
    if rectangle is not None:
        candidates.append(rectangle)

    if not candidates:
        return None
    return max(candidates, key=lambda match: match.confidence)


def _clean_points(points: Iterable[Iterable[float]]) -> np.ndarray | None:
    """Convert a point sequence to finite float coordinates and remove repeats."""

    try:
        raw_points = list(points)
    except (TypeError, ValueError):
        return None

    cleaned: list[Point] = []
    for raw_point in raw_points:
        try:
            if len(raw_point) != 2:
                return None
            point = (float(raw_point[0]), float(raw_point[1]))
        except (TypeError, ValueError, IndexError):
            return None
        if not all(math.isfinite(value) for value in point):
            return None
        if not cleaned or math.hypot(
            point[0] - cleaned[-1][0], point[1] - cleaned[-1][1]
        ) > 1e-9:
            cleaned.append(point)

    if len(cleaned) < 2:
        return None
    return np.asarray(cleaned, dtype=np.float64)


def _bbox_diagonal(points: np.ndarray) -> float:
    return float(np.linalg.norm(np.max(points, axis=0) - np.min(points, axis=0)))


def _open_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())


def _closed_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    return _open_length(np.vstack((points, points[0])))


def _recognize_line(points: np.ndarray) -> ShapeMatch | None:
    """Fit a straight open path, rejecting long or visibly wavy strokes."""

    chord_vector = points[-1] - points[0]
    chord = float(np.linalg.norm(chord_vector))
    if chord < _MIN_LINE_LENGTH:
        return None

    path_length = _open_length(points)
    if path_length <= 1e-9 or path_length / chord > 1.12:
        return None

    centered = points - np.mean(points, axis=0)
    try:
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError:
        return None
    direction = vh[0]
    distances = np.abs(centered[:, 0] * direction[1] - centered[:, 1] * direction[0])
    residual_scale = max(chord, _bbox_diagonal(points), 1e-9)
    rms_error = float(np.sqrt(np.mean(distances * distances)) / residual_scale)
    p95_error = float(np.percentile(distances, 95) / residual_scale)
    max_error = float(np.max(distances) / residual_scale)
    if rms_error > 0.045 or p95_error > 0.085 or max_error > 0.18:
        return None

    # A line should advance in one direction.  A short local reversal is
    # tolerated for hand jitter, but a wavy path accumulates too much reversal.
    projection = np.dot(points - points[0], chord_vector) / (chord * chord)
    backward = float(np.maximum(0.0, -np.diff(projection)).sum())
    if backward > 0.08:
        return None

    straightness = max(0.0, 1.0 - (path_length / chord - 1.0) / 0.12)
    residual_score = max(0.0, 1.0 - p95_error / 0.085)
    confidence = _clamp(0.50 * straightness + 0.35 * residual_score + 0.15 * (1.0 - backward / 0.08))
    return ShapeMatch(
        kind="line",
        points=[_point_tuple(points[0]), _point_tuple(points[-1])],
        confidence=confidence,
    )


def _resample_closed(ring: np.ndarray, sample_count: int) -> np.ndarray | None:
    """Uniformly sample a closed ring by arc length, not by input point count."""

    if len(ring) < 3:
        return None
    closed = np.vstack((ring, ring[0]))
    segment_lengths = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    perimeter = float(segment_lengths.sum())
    if perimeter <= 1e-9:
        return None

    cumulative = np.concatenate(([0.0], np.cumsum(segment_lengths)))
    targets = np.linspace(0.0, perimeter, sample_count, endpoint=False)
    indices = np.searchsorted(cumulative, targets, side="right") - 1
    indices = np.clip(indices, 0, len(closed) - 2)
    local_lengths = segment_lengths[indices]
    fractions = np.divide(
        targets - cumulative[indices],
        local_lengths,
        out=np.zeros_like(targets),
        where=local_lengths > 1e-12,
    )
    return closed[indices] + fractions[:, None] * (closed[indices + 1] - closed[indices])


def _fit_circle(points: np.ndarray) -> tuple[np.ndarray, float] | None:
    """Least-squares circle fit; return center and positive radius."""

    matrix = np.column_stack((2.0 * points, np.ones(len(points))))
    rhs = np.sum(points * points, axis=1)
    try:
        solution, _, rank, _ = np.linalg.lstsq(matrix, rhs, rcond=None)
    except np.linalg.LinAlgError:
        return None
    if rank < 3:
        return None
    center = solution[:2]
    radius_squared = float(solution[2] + np.dot(center, center))
    if not math.isfinite(radius_squared) or radius_squared <= 1e-9:
        return None
    radius = math.sqrt(radius_squared)
    if not math.isfinite(radius):
        return None
    return center, radius


def _signed_turn(points: np.ndarray, center: np.ndarray) -> float:
    vectors = points - center
    next_vectors = np.roll(vectors, -1, axis=0)
    cross = vectors[:, 0] * next_vectors[:, 1] - vectors[:, 1] * next_vectors[:, 0]
    dot = np.sum(vectors * next_vectors, axis=1)
    return float(np.arctan2(cross, dot).sum())


def _recognize_circle(sampled: np.ndarray, ring: np.ndarray) -> ShapeMatch | None:
    fit = _fit_circle(sampled)
    if fit is None:
        return None
    center, radius = fit
    distances = np.linalg.norm(sampled - center, axis=1)
    radial_error = distances - radius
    normalized_rmse = float(np.sqrt(np.mean(radial_error * radial_error)) / radius)
    normalized_p95 = float(np.percentile(np.abs(radial_error), 95) / radius)
    normalized_max = float(np.max(np.abs(radial_error)) / radius)
    if normalized_rmse > 0.075 or normalized_p95 > 0.14 or normalized_max > 0.22:
        return None

    turn = _signed_turn(sampled, center)
    abs_turn = abs(turn)
    if not 1.70 * math.pi <= abs_turn <= 2.30 * math.pi:
        return None

    vectors = sampled - center
    next_vectors = np.roll(vectors, -1, axis=0)
    local_cross = vectors[:, 0] * next_vectors[:, 1] - vectors[:, 1] * next_vectors[:, 0]
    orientation = np.sign(turn)
    same_direction = float(np.mean(np.sign(local_cross) == orientation))
    if same_direction < 0.88:
        return None

    angles = math.atan2(ring[0, 1] - center[1], ring[0, 0] - center[0])
    direction = 1.0 if turn >= 0.0 else -1.0
    render_angles = angles + direction * np.linspace(
        0.0, 2.0 * math.pi, _CIRCLE_RENDER_SAMPLES, endpoint=True
    )
    rendered = np.column_stack(
        (center[0] + radius * np.cos(render_angles), center[1] + radius * np.sin(render_angles))
    )
    rendered[-1] = rendered[0]

    radial_score = max(0.0, 1.0 - normalized_p95 / 0.14)
    turn_score = max(0.0, 1.0 - abs(abs_turn - 2.0 * math.pi) / (0.30 * math.pi))
    confidence = _clamp(
        0.58 * radial_score + 0.25 * turn_score + 0.17 * same_direction
    )
    return ShapeMatch(
        kind="circle",
        points=[_point_tuple(point) for point in rendered],
        confidence=confidence,
    )


def _corner_start(ring: np.ndarray) -> int:
    """Choose a likely corner before closed RDP simplification."""

    window = max(1, min(4, len(ring) // 16))
    scores = np.zeros(len(ring), dtype=np.float64)
    for index in range(len(ring)):
        before = ring[(index - window) % len(ring)] - ring[index]
        after = ring[(index + window) % len(ring)] - ring[index]
        before_norm = float(np.linalg.norm(before))
        after_norm = float(np.linalg.norm(after))
        if before_norm > 1e-9 and after_norm > 1e-9:
            cosine = np.dot(before, after) / (before_norm * after_norm)
            # On a straight segment the vectors point in opposite
            # directions (angle ~= pi).  A corner has a smaller angle, so
            # score the amount of turn rather than the raw included angle.
            scores[index] = math.pi - math.acos(float(np.clip(cosine, -1.0, 1.0)))
    return int(np.argmax(scores))


def _rdp(points: np.ndarray, epsilon: float) -> np.ndarray:
    if len(points) <= 2:
        return points
    distances = _point_segment_distances(points[1:-1], points[0], points[-1])
    split = int(np.argmax(distances)) + 1
    if float(distances[split - 1]) <= epsilon:
        return np.vstack((points[0], points[-1]))
    left = _rdp(points[: split + 1], epsilon)
    right = _rdp(points[split:], epsilon)
    return np.vstack((left[:-1], right))


def _point_segment_distances(points: np.ndarray, start: np.ndarray, end: np.ndarray) -> np.ndarray:
    edge = end - start
    edge_squared = float(np.dot(edge, edge))
    if edge_squared <= 1e-12:
        return np.linalg.norm(points - start, axis=1)
    fractions = np.clip(np.dot(points - start, edge) / edge_squared, 0.0, 1.0)
    projections = start + fractions[:, None] * edge
    return np.linalg.norm(points - projections, axis=1)


def _simplify_closed(ring: np.ndarray, epsilon: float) -> np.ndarray:
    start = _corner_start(ring)
    rotated = np.roll(ring, -start, axis=0)
    simplified = _rdp(np.vstack((rotated, rotated[0])), epsilon)
    if len(simplified) > 1 and np.linalg.norm(simplified[-1] - simplified[0]) <= 1e-8:
        simplified = simplified[:-1]
    return simplified


def _polygon_metrics(path: np.ndarray, polygon: np.ndarray) -> dict[str, float] | None:
    if len(polygon) < 3:
        return None
    edges = np.roll(polygon, -1, axis=0) - polygon
    side_lengths = np.linalg.norm(edges, axis=1)
    if float(np.min(side_lengths)) <= 1e-9:
        return None

    distance_to_edges = np.column_stack(
        [
            _point_segment_distances(path, polygon[index], polygon[(index + 1) % len(polygon)])
            for index in range(len(polygon))
        ]
    )
    distances = np.min(distance_to_edges, axis=1)
    diagonal = max(_bbox_diagonal(path), 1e-9)
    polygon_area = abs(_shoelace_area(polygon))
    path_area = abs(_shoelace_area(path))
    if polygon_area <= 1e-9 or path_area <= 1e-9:
        return None

    edge_unit = edges / side_lengths[:, None]
    adjacent_cosines = np.sum(edge_unit * np.roll(edge_unit, -1, axis=0), axis=1)
    next_edges = np.roll(edges, -1, axis=0)
    cross_turns = edges[:, 0] * next_edges[:, 1] - edges[:, 1] * next_edges[:, 0]
    dominant_sign = 1.0 if np.sum(cross_turns) >= 0.0 else -1.0
    convex = float(np.mean(np.sign(cross_turns) == dominant_sign))

    # Use a wider chord for turn signs so points on a straight side are not
    # counted as meaningful turns.  Both signs indicate a scribble or crossing.
    window = max(1, len(path) // 32)
    local_cross = []
    for index in range(len(path)):
        before = path[(index - window) % len(path)] - path[index]
        after = path[(index + window) % len(path)] - path[index]
        local_cross.append(before[0] * after[1] - before[1] * after[0])
    local_cross_array = np.asarray(local_cross)
    significance = 0.002 * diagonal * diagonal
    meaningful = np.abs(local_cross_array) > significance
    if np.any(meaningful):
        sign_matches = np.sign(local_cross_array[meaningful]) == (-dominant_sign)
        turn_consistency = float(np.mean(sign_matches))
    else:
        turn_consistency = 1.0

    polygon_perimeter = float(side_lengths.sum())
    path_perimeter = _closed_length(path)
    return {
        "rms_error": float(np.sqrt(np.mean(distances * distances)) / diagonal),
        "p95_error": float(np.percentile(distances, 95) / diagonal),
        "max_error": float(np.max(distances) / diagonal),
        "area_ratio": path_area / polygon_area,
        "perimeter_ratio": path_perimeter / polygon_perimeter,
        "convex": convex,
        "turn_consistency": turn_consistency,
        "adjacent_cosine": float(np.max(np.abs(adjacent_cosines))),
        "opposite_parallel": float(
            min(abs(float(np.dot(edge_unit[0], edge_unit[2]))), abs(float(np.dot(edge_unit[1], edge_unit[3]))) )
            if len(polygon) == 4
            else 0.0
        ),
        "opposite_length_error": float(
            max(
                abs(side_lengths[0] - side_lengths[2]) / max(side_lengths[0], side_lengths[2]),
                abs(side_lengths[1] - side_lengths[3]) / max(side_lengths[1], side_lengths[3]),
            )
            if len(polygon) == 4
            else 0.0
        ),
    }


def _recognize_polygon(
    sampled: np.ndarray,
    *,
    expected_vertices: int,
) -> ShapeMatch | None:
    diagonal = max(_bbox_diagonal(sampled), 1e-9)
    best: tuple[float, np.ndarray] | None = None
    # A small sweep makes the result tolerant of both sharp and gently rounded
    # hand-drawn corners without making every arbitrary loop a polygon.
    for fraction in (0.012, 0.020, 0.030, 0.045, 0.065, 0.090, 0.120):
        polygon = _simplify_closed(sampled, fraction * diagonal)
        if len(polygon) != expected_vertices:
            continue
        metrics = _polygon_metrics(sampled, polygon)
        if metrics is None:
            continue

        area_ratio = metrics["area_ratio"]
        perimeter_ratio = metrics["perimeter_ratio"]
        if not 0.72 <= area_ratio <= 1.35 or not 0.82 <= perimeter_ratio <= 1.25:
            continue
        if metrics["rms_error"] > 0.045 or metrics["p95_error"] > 0.075 or metrics["max_error"] > 0.16:
            continue
        if metrics["convex"] < 0.90 or metrics["turn_consistency"] < 0.82:
            continue

        if expected_vertices == 3:
            if not _valid_triangle_angles(polygon):
                continue
            geometry_score = _triangle_geometry_score(polygon)
        else:
            if metrics["adjacent_cosine"] > 0.23:
                continue
            if metrics["opposite_parallel"] < 0.93 or metrics["opposite_length_error"] > 0.25:
                continue
            geometry_score = _rectangle_geometry_score(metrics)

        residual_score = max(0.0, 1.0 - metrics["p95_error"] / 0.075)
        max_score = max(0.0, 1.0 - metrics["max_error"] / 0.16)
        area_score = max(0.0, 1.0 - abs(math.log(area_ratio)) / math.log(1.35))
        length_score = max(0.0, 1.0 - abs(math.log(perimeter_ratio)) / math.log(1.25))
        score = _clamp(
            0.28 * residual_score
            + 0.12 * max_score
            + 0.18 * area_score
            + 0.15 * length_score
            + 0.15 * metrics["turn_consistency"]
            + 0.12 * geometry_score
        )
        if score >= _MIN_POLYGON_CONFIDENCE and (best is None or score > best[0]):
            best = (score, polygon)

    if best is None:
        return None
    score, polygon = best
    if expected_vertices == 4:
        polygon = _regularize_rectangle(polygon)
    output = [_point_tuple(point) for point in polygon]
    output.append(output[0])
    return ShapeMatch(
        kind="triangle" if expected_vertices == 3 else "rectangle",
        points=output,
        confidence=score,
    )


def _regularize_rectangle(polygon: np.ndarray) -> np.ndarray:
    """Fit an exact rectangle to an already-accepted four-corner polygon."""

    edges = np.roll(polygon, -1, axis=0) - polygon
    first_axis = edges[0] - edges[2]
    if np.linalg.norm(first_axis) <= 1e-9:
        first_axis = edges[0]
    first_axis = first_axis / np.linalg.norm(first_axis)

    # Keep the direction of the second axis aligned with the drawn traversal,
    # while constructing it as an exact perpendicular to the first axis.
    second_axis = np.asarray((-first_axis[1], first_axis[0]))
    if np.dot(second_axis, edges[1]) < 0.0:
        second_axis = -second_axis

    width = 0.5 * (float(np.linalg.norm(edges[0])) + float(np.linalg.norm(edges[2])))
    height = 0.5 * (float(np.linalg.norm(edges[1])) + float(np.linalg.norm(edges[3])))
    center = np.mean(polygon, axis=0)
    half_width = 0.5 * width
    half_height = 0.5 * height
    return np.asarray(
        (
            center - half_width * first_axis - half_height * second_axis,
            center + half_width * first_axis - half_height * second_axis,
            center + half_width * first_axis + half_height * second_axis,
            center - half_width * first_axis + half_height * second_axis,
        )
    )


def _valid_triangle_angles(polygon: np.ndarray) -> bool:
    edges = np.roll(polygon, -1, axis=0) - polygon
    lengths = np.linalg.norm(edges, axis=1)
    interior_cosines = []
    for index in range(3):
        incoming = -edges[index - 1]
        outgoing = edges[index]
        interior_cosines.append(
            np.dot(incoming, outgoing) / (lengths[index - 1] * lengths[index])
        )
    angles = np.arccos(np.clip(interior_cosines, -1.0, 1.0))
    return bool(np.min(angles) >= math.radians(12.0) and np.max(angles) <= math.radians(156.0))


def _triangle_geometry_score(polygon: np.ndarray) -> float:
    angles = _polygon_angles(polygon)
    lower_margin = (float(np.min(angles)) - math.radians(12.0)) / math.radians(36.0)
    upper_margin = (math.radians(156.0) - float(np.max(angles))) / math.radians(36.0)
    return _clamp(min(lower_margin, upper_margin))


def _polygon_angles(polygon: np.ndarray) -> np.ndarray:
    edges = np.roll(polygon, -1, axis=0) - polygon
    lengths = np.linalg.norm(edges, axis=1)
    cosines = []
    for index in range(len(polygon)):
        incoming = -edges[index - 1]
        outgoing = edges[index]
        cosines.append(np.dot(incoming, outgoing) / (lengths[index - 1] * lengths[index]))
    return np.arccos(np.clip(cosines, -1.0, 1.0))


def _rectangle_geometry_score(metrics: dict[str, float]) -> float:
    angle_score = max(0.0, 1.0 - metrics["adjacent_cosine"] / 0.23)
    parallel_score = max(0.0, (metrics["opposite_parallel"] - 0.93) / 0.07)
    length_score = max(0.0, 1.0 - metrics["opposite_length_error"] / 0.25)
    return (angle_score + parallel_score + length_score) / 3.0


def _shoelace_area(points: np.ndarray) -> float:
    next_points = np.roll(points, -1, axis=0)
    return float(0.5 * np.sum(points[:, 0] * next_points[:, 1] - points[:, 1] * next_points[:, 0]))


def _point_tuple(point: np.ndarray) -> Point:
    return (float(point[0]), float(point[1]))


def _clamp(value: float) -> float:
    return float(np.clip(value, 0.0, 1.0))


__all__ = ["ShapeMatch", "recognize_shape"]
