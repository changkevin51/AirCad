"""FreeCAD-side importer for an AirCAD drawing snapshot.

This module intentionally imports FreeCAD only inside ``import_drawing``.  It
can therefore be inspected and unit-tested with the camera Python runtime,
while the FreeCAD GUI loads it from the generated snapshot macro.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Iterable


SCALE = 0.25
SNAPSHOT_ENV = "AIRCAD_FREECAD_SNAPSHOT"
DEFAULT_SNAPSHOT = Path(__file__).resolve().parent / ".runtime" / "freecad_drawing.json"


def _point(point: Iterable[object]) -> tuple[float, float, float]:
    try:
        coordinates = list(point)
    except TypeError as error:
        raise ValueError("each drawing point must contain two coordinates") from error
    if len(coordinates) != 2:
        raise ValueError("each drawing point must contain exactly two coordinates")
    if any(isinstance(value, bool) for value in coordinates):
        raise ValueError("drawing coordinates must be numeric")
    try:
        x, y = (float(coordinates[0]), float(coordinates[1]))
    except (TypeError, ValueError) as error:
        raise ValueError("drawing coordinates must be numeric") from error
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("drawing coordinates must be finite")
    return (x * SCALE, -y * SCALE, 0.0)


def converted_stroke(stroke: Iterable[Iterable[object]]) -> tuple[tuple[float, float, float], ...]:
    """Convert a camera stroke and remove only consecutive duplicate points."""

    converted: list[tuple[float, float, float]] = []
    for raw_point in stroke:
        candidate = _point(raw_point)
        if not converted or candidate != converted[-1]:
            converted.append(candidate)
    return tuple(converted)


def read_snapshot(path: Path) -> list[list[list[float]]]:
    """Read and minimally validate the bridge's JSON snapshot."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read FreeCAD drawing snapshot: {path}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("strokes"), list):
        raise ValueError("FreeCAD drawing snapshot must contain a strokes list")

    strokes: list[list[list[float]]] = []
    for stroke in payload["strokes"]:
        if not isinstance(stroke, list):
            raise ValueError("each snapshot stroke must be a list")
        points: list[list[float]] = []
        for point in stroke:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("each snapshot point must contain two coordinates")
            # Validate here so malformed input fails before opening a document.
            converted_stroke((point,))
            points.append([float(point[0]), float(point[1])])
        strokes.append(points)
    return strokes


def _make_shape(part, app, points):
    vectors = [app.Vector(x, y, z) for x, y, z in points]
    if len(vectors) == 1:
        return part.Vertex(vectors[0])
    return part.makePolygon(vectors)


def import_drawing(snapshot_path: Path):
    """Create and display a new FreeCAD document from ``snapshot_path``."""

    # These imports run only inside FreeCAD's own Python interpreter.
    import FreeCAD as app
    import FreeCADGui as gui
    import Part as part

    strokes = read_snapshot(snapshot_path)
    document = app.newDocument("AirCADDrawing")
    for index, stroke in enumerate(strokes, start=1):
        points = converted_stroke(stroke)
        if not points:
            continue
        object_name = f"Stroke{index}"
        feature = document.addObject("Part::Feature", object_name)
        feature.Label = f"Stroke {index}"
        feature.Shape = _make_shape(part, app, points)
        # New Part::Feature objects are visible by default; set explicitly for
        # importers running with a custom FreeCAD visibility preference.
        view_object = getattr(feature, "ViewObject", None)
        if view_object is not None:
            view_object.Visibility = True
            if hasattr(view_object, "LineColor"):
                view_object.LineColor = (1.0, 0.8, 0.1)
            if hasattr(view_object, "LineWidth"):
                view_object.LineWidth = 4.0
            if len(points) == 1 and hasattr(view_object, "PointColor"):
                view_object.PointColor = (1.0, 0.8, 0.1)
            if len(points) == 1 and hasattr(view_object, "PointSize"):
                view_object.PointSize = 6.0

    document.recompute()
    show_main_window = getattr(gui, "showMainWindow", None)
    if callable(show_main_window):
        show_main_window()
    active_document = gui.activeDocument()
    view = active_document.activeView()
    view.viewTop()
    view.fitAll()
    return document


def _snapshot_from_process() -> Path:
    configured = os.environ.get(SNAPSHOT_ENV)
    return Path(configured) if configured else DEFAULT_SNAPSHOT


def main(snapshot_path: Path | None = None):
    return import_drawing(snapshot_path or _snapshot_from_process())


if __name__ == "__main__":
    main()


__all__ = ["SCALE", "converted_stroke", "import_drawing", "main", "read_snapshot"]
