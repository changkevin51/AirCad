"""Behavioral tests for conservative completed-stroke recognition."""

from __future__ import annotations

import math
import unittest

import numpy as np

from shape_recognition import ShapeMatch, recognize_shape


def _closed_polygon(
    vertices: list[tuple[float, float]],
    samples_per_side: int | list[int] = 10,
    *,
    noise: float = 0.0,
    start: int = 0,
    reverse: bool = False,
) -> np.ndarray:
    corners = np.asarray(vertices, dtype=float)
    if isinstance(samples_per_side, int):
        counts = [samples_per_side] * len(corners)
    else:
        counts = samples_per_side
    ring: list[np.ndarray] = []
    for index, (start_corner, end_corner) in enumerate(
        zip(corners, np.roll(corners, -1, axis=0))
    ):
        for fraction in np.linspace(0.0, 1.0, counts[index], endpoint=False):
            ring.append(start_corner + fraction * (end_corner - start_corner))
    ring_array = np.asarray(ring)
    if noise:
        ring_array += np.random.default_rng(1234).normal(0.0, noise, ring_array.shape)
    ring_array = np.roll(ring_array, start, axis=0)
    closed = np.vstack((ring_array, ring_array[0]))
    return closed[::-1] if reverse else closed


def _circle(
    *,
    center: tuple[float, float] = (240.0, 180.0),
    radius: float = 85.0,
    sample_count: int = 80,
    start_angle: float = 0.0,
    noise: float = 0.0,
    reverse: bool = False,
) -> np.ndarray:
    angles = np.linspace(
        start_angle, start_angle + 2.0 * math.pi, sample_count, endpoint=False
    )
    points = np.column_stack(
        (center[0] + radius * np.cos(angles), center[1] + radius * np.sin(angles))
    )
    if noise:
        points += np.random.default_rng(5678).normal(0.0, noise, points.shape)
    closed = np.vstack((points, points[0]))
    return closed[::-1] if reverse else closed


def _rotated_rectangle(
    *, angle: float = math.radians(29.0), start: int = 0, reverse: bool = False
) -> np.ndarray:
    center = np.asarray((230.0, 165.0))
    width, height = 170.0, 92.0
    local = np.asarray(
        (
            (-width / 2.0, -height / 2.0),
            (width / 2.0, -height / 2.0),
            (width / 2.0, height / 2.0),
            (-width / 2.0, height / 2.0),
        )
    )
    rotation = np.asarray(
        ((math.cos(angle), -math.sin(angle)), (math.sin(angle), math.cos(angle)))
    )
    corners = local @ rotation.T + center
    return _closed_polygon(
        [tuple(point) for point in corners],
        samples_per_side=[3, 18, 5, 14],
        noise=1.25,
        start=start,
        reverse=reverse,
    )


def _assert_closed_match(match: ShapeMatch, kind: str) -> None:
    assert match.kind == kind
    assert 0.0 <= match.confidence <= 1.0
    assert len(match.points) >= 4
    assert match.points[0] == match.points[-1]
    assert all(
        math.isfinite(value)
        for point in match.points
        for value in point
    )


def test_line_has_two_endpoints_and_rejects_wavy_path() -> None:
    line = recognize_shape([(20.0, 40.0), (90.0, 68.0), (180.0, 104.0)])
    assert line is not None
    assert line.kind == "line"
    assert line.points == [(20.0, 40.0), (180.0, 104.0)]
    assert recognize_shape(
        [(x, 80.0 + 24.0 * math.sin(x / 11.0)) for x in np.linspace(20.0, 220.0, 70)]
    ) is None


def test_noisy_circle_is_smooth_closed_and_invariant_to_reversal() -> None:
    forward = recognize_shape(_circle(start_angle=0.37, noise=1.8))
    reversed_path = recognize_shape(_circle(start_angle=0.37, noise=1.8, reverse=True))
    sampled = _circle(start_angle=0.37, noise=1.8)
    with_duplicates = np.concatenate(
        (sampled[:18], sampled[17:18], sampled[18:46], sampled[45:46], sampled[46:])
    )
    duplicate_tolerant = recognize_shape(with_duplicates)

    assert forward is not None and reversed_path is not None and duplicate_tolerant is not None
    _assert_closed_match(forward, "circle")
    _assert_closed_match(reversed_path, "circle")
    _assert_closed_match(duplicate_tolerant, "circle")
    assert len(forward.points) >= 48
    assert len(reversed_path.points) >= 48


def test_triangle_accepts_noise_starting_corner_and_reversal() -> None:
    vertices = [(90.0, 46.0), (255.0, 72.0), (135.0, 205.0)]
    for start, reverse in ((0, False), (7, False), (0, True), (11, True)):
        match = recognize_shape(
            _closed_polygon(vertices, samples_per_side=11, noise=1.35, start=start, reverse=reverse)
        )
        assert match is not None
        _assert_closed_match(match, "triangle")
        assert len(match.points) == 4


def test_rotated_rectangle_accepts_uneven_sampling_and_all_directions() -> None:
    for start, reverse in ((0, False), (8, False), (0, True), (17, True)):
        match = recognize_shape(_rotated_rectangle(start=start, reverse=reverse))
        assert match is not None
        _assert_closed_match(match, "rectangle")
        assert len(match.points) == 5
        corners = np.asarray(match.points[:-1])
        edges = np.roll(corners, -1, axis=0) - corners
        unit_edges = edges / np.linalg.norm(edges, axis=1)[:, None]
        adjacent_dot = np.sum(unit_edges * np.roll(unit_edges, -1, axis=0), axis=1)
        opposite_dot = np.sum(unit_edges * np.roll(unit_edges, -2, axis=0), axis=1)
        assert np.max(np.abs(adjacent_dot)) < 1e-12
        assert np.min(np.abs(opposite_dot)) > 1.0 - 1e-12
        assert np.linalg.norm(np.mean(corners, axis=0) - np.asarray((230.0, 165.0))) < 5.0
        assert np.allclose(
            np.sort(np.linalg.norm(edges, axis=1)),
            np.sort(np.asarray((92.0, 92.0, 170.0, 170.0))),
            rtol=0.08,
        )


def test_near_open_loop_is_not_promoted_to_a_closed_shape() -> None:
    angles = np.linspace(0.25, 2.0 * math.pi - 0.35, 70)
    incomplete = np.column_stack((240.0 + 90.0 * np.cos(angles), 180.0 + 90.0 * np.sin(angles)))
    assert recognize_shape(incomplete) is None


def test_spiral_ellipse_and_scribble_remain_unknown() -> None:
    spiral_angles = np.linspace(0.0, 4.0 * math.pi, 150)
    spiral_radius = np.linspace(10.0, 92.0, len(spiral_angles))
    spiral = np.column_stack(
        (240.0 + spiral_radius * np.cos(spiral_angles), 180.0 + spiral_radius * np.sin(spiral_angles))
    )
    assert recognize_shape(spiral) is None

    ellipse_angles = np.linspace(0.0, 2.0 * math.pi, 80, endpoint=False)
    ellipse = np.column_stack((240.0 + 110.0 * np.cos(ellipse_angles), 180.0 + 62.0 * np.sin(ellipse_angles)))
    ellipse = np.vstack((ellipse, ellipse[0]))
    assert recognize_shape(ellipse) is None

    pentagon_angles = np.linspace(0.0, 2.0 * math.pi, 5, endpoint=False)
    pentagon = np.column_stack(
        (240.0 + 92.0 * np.cos(pentagon_angles), 180.0 + 92.0 * np.sin(pentagon_angles))
    )
    pentagon = _closed_polygon([tuple(point) for point in pentagon], samples_per_side=12)
    assert recognize_shape(pentagon) is None

    scribble = np.asarray(
        [(120.0, 100.0), (205.0, 180.0), (120.0, 180.0), (205.0, 100.0), (120.0, 100.0)]
    )
    assert recognize_shape(scribble) is None


def test_duplicate_degenerate_and_nonfinite_input_is_safe() -> None:
    assert recognize_shape([(3.0, 4.0)] * 20) is None
    assert recognize_shape([(0.0, 0.0), (math.nan, 1.0), (4.0, 4.0)]) is None
    assert recognize_shape([(0.0, 0.0), (math.inf, 1.0), (4.0, 4.0)]) is None
    assert recognize_shape([(0.0, 0.0), (1.0, 2.0, 3.0)]) is None


def test_minimum_samples_are_conservative_but_two_point_line_is_valid() -> None:
    assert recognize_shape([(0.0, 0.0)]) is None
    assert recognize_shape([(0.0, 0.0), (0.0, 0.0)]) is None
    assert recognize_shape([(0.0, 0.0), (60.0, 0.0), (30.0, 45.0), (0.0, 0.0)]) is None
    assert recognize_shape([(0.0, 0.0), (2.5, 0.0)]) is None
    line = recognize_shape([(8.0, 12.0), (108.0, 42.0)])
    assert line is not None and line.kind == "line"


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: str | None) -> unittest.TestSuite:
    """Keep the tests runnable with the project's stdlib-only environment."""

    suite = unittest.TestSuite()
    for name in sorted(globals()):
        if name.startswith("test_"):
            suite.addTest(unittest.FunctionTestCase(globals()[name]))
    return suite


if __name__ == "__main__":
    unittest.main()
