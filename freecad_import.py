"""FreeCAD-side importer for an AirCAD sketch snapshot.

This module intentionally imports FreeCAD only inside ``import_drawing``.  It
can therefore be inspected and unit-tested with the AirCAD Python runtime,
while the FreeCAD GUI loads it from the generated snapshot macro.

Snapshot format (version 2, produced by :mod:`freecad_bridge`)::

    {"version": 2, "units": "mm",
     "entities": [{"type": "line", "points": [[x, y, z], [x, y, z]]},
                  {"type": "rect", "points": [[x, y, z] * 4]},
                  {"type": "polyline", "points": [[x, y, z], ...]}]}
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Iterable


# Sketch coordinates are already millimetres, FreeCAD's internal unit.
SCALE = 1.0
SNAPSHOT_ENV = "AIRCAD_FREECAD_SNAPSHOT"
DEFAULT_SNAPSHOT = Path(__file__).resolve().parent / ".runtime" / "freecad_drawing.json"
SUPPORTED_TYPES = {"line", "rect", "polyline"}
LINE_COLOR = (1.0, 0.8, 0.1)
FACE_COLOR = (0.55, 0.7, 0.95)


def _point(point: Iterable[object]) -> tuple[float, float, float]:
    try:
        coordinates = list(point)
    except TypeError as error:
        raise ValueError("each point must contain two or three coordinates") from error
    if len(coordinates) == 2:
        coordinates.append(0.0)
    if len(coordinates) != 3:
        raise ValueError("each point must contain two or three coordinates")
    if any(isinstance(value, bool) for value in coordinates):
        raise ValueError("coordinates must be numeric")
    try:
        x, y, z = (float(coordinates[0]), float(coordinates[1]), float(coordinates[2]))
    except (TypeError, ValueError) as error:
        raise ValueError("coordinates must be numeric") from error
    if not all(math.isfinite(value) for value in (x, y, z)):
        raise ValueError("coordinates must be finite")
    return (x * SCALE, y * SCALE, z * SCALE)


def converted_points(points: Iterable[Iterable[object]]) -> tuple[tuple[float, float, float], ...]:
    """Convert entity points and remove only consecutive duplicate points."""

    converted: list[tuple[float, float, float]] = []
    for raw_point in points:
        candidate = _point(raw_point)
        if not converted or candidate != converted[-1]:
            converted.append(candidate)
    return tuple(converted)


def read_snapshot(path: Path) -> list[dict[str, Any]]:
    """Read and validate the bridge's JSON snapshot into entity dicts."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read FreeCAD drawing snapshot: {path}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("entities"), list):
        raise ValueError("FreeCAD drawing snapshot must contain an entities list")

    entities: list[dict[str, Any]] = []
    for entity in payload["entities"]:
        if not isinstance(entity, dict):
            raise ValueError("each snapshot entity must be an object")
        kind = str(entity.get("type", "")).lower()
        if kind not in SUPPORTED_TYPES:
            raise ValueError(f"unsupported snapshot entity type: {entity.get('type')!r}")
        points = entity.get("points")
        if not isinstance(points, list):
            raise ValueError("each snapshot entity needs a points list")
        # Validate here so malformed input fails before opening a document.
        converted = converted_points(points)
        if kind == "line" and len(points) != 2:
            raise ValueError("a line needs exactly two points")
        if kind == "rect" and len(points) != 4:
            raise ValueError("a rect needs exactly four points")
        if len(converted) < 2:
            raise ValueError("an entity needs at least two distinct points")
        entities.append({"type": kind, "points": [list(point) for point in points]})
    return entities


def _make_shape(part, app, kind: str, points):
    vectors = [app.Vector(x, y, z) for x, y, z in points]
    if kind == "rect" and len(vectors) == 4:
        wire = part.makePolygon(vectors + [vectors[0]])
        return part.Face(wire)
    return part.makePolygon(vectors)


def import_drawing(snapshot_path: Path):
    """Create and display a new FreeCAD document from ``snapshot_path``."""

    # These imports run only inside FreeCAD's own Python interpreter.
    import FreeCAD as app
    import FreeCADGui as gui
    import Part as part

    entities = read_snapshot(snapshot_path)
    document = app.newDocument("AirCADSketch")
    counters = {"line": 0, "rect": 0, "polyline": 0}
    labels = {"line": "Line", "rect": "Rectangle", "polyline": "Polyline"}
    for entity in entities:
        kind = entity["type"]
        points = converted_points(entity["points"])
        if len(points) < 2:
            continue
        counters[kind] += 1
        feature = document.addObject("Part::Feature", f"{labels[kind]}{counters[kind]}")
        feature.Label = f"{labels[kind]} {counters[kind]}"
        feature.Shape = _make_shape(part, app, kind, points)
        view_object = getattr(feature, "ViewObject", None)
        if view_object is not None:
            view_object.Visibility = True
            if hasattr(view_object, "LineColor"):
                view_object.LineColor = LINE_COLOR
            if hasattr(view_object, "LineWidth"):
                view_object.LineWidth = 3.0
            if kind == "rect":
                if hasattr(view_object, "ShapeColor"):
                    view_object.ShapeColor = FACE_COLOR
                if hasattr(view_object, "Transparency"):
                    view_object.Transparency = 40

    document.recompute()
    show_main_window = getattr(gui, "showMainWindow", None)
    if callable(show_main_window):
        show_main_window()
    active_document = gui.activeDocument()
    view = active_document.activeView()
    view_isometric = getattr(view, "viewIsometric", None)
    if callable(view_isometric):
        view_isometric()
    else:
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


__all__ = ["SCALE", "converted_points", "import_drawing", "main", "read_snapshot"]
