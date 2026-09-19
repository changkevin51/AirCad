"""FreeCAD importer checks using a tiny fake GUI/kernel boundary."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

import freecad_import


class _FakeFeature:
    def __init__(self, name: str) -> None:
        self.Name = name
        self.Label = ""
        self.Shape = None
        self.ViewObject = types.SimpleNamespace(
            Visibility=False,
            LineColor=None,
            LineWidth=None,
            PointColor=None,
            PointSize=None,
        )


class _FakeDocument:
    def __init__(self) -> None:
        self.objects: list[_FakeFeature] = []
        self.recompute_count = 0

    def addObject(self, _kind: str, name: str) -> _FakeFeature:
        feature = _FakeFeature(name)
        self.objects.append(feature)
        return feature

    def recompute(self) -> None:
        self.recompute_count += 1


class _FakeView:
    def __init__(self) -> None:
        self.top_calls = 0
        self.fit_calls = 0

    def viewTop(self) -> None:
        self.top_calls += 1

    def fitAll(self) -> None:
        self.fit_calls += 1


class FreeCADImportTests(unittest.TestCase):
    def test_coordinate_conversion_and_consecutive_deduplication(self) -> None:
        self.assertEqual(
            freecad_import.converted_stroke([(100, 80), (100, 80), (120, 60)]),
            ((25.0, -20.0, 0.0), (30.0, -15.0, 0.0)),
        )
        self.assertEqual(
            freecad_import.converted_stroke([(5, 5), (6, 6), (5, 5)]),
            ((1.25, -1.25, 0.0), (1.5, -1.5, 0.0), (1.25, -1.25, 0.0)),
        )

    def test_import_creates_polylines_and_vertex_for_single_point(self) -> None:
        document = _FakeDocument()
        view = _FakeView()
        vectors: list[tuple[float, float, float]] = []
        polygons: list[list[tuple[float, float, float]]] = []
        vertices: list[tuple[float, float, float]] = []

        fake_app = types.SimpleNamespace(
            Vector=lambda x, y, z: (x, y, z),
            newDocument=lambda _name: document,
        )
        fake_gui = types.SimpleNamespace(
            showMainWindow=lambda: None,
            activeDocument=lambda: types.SimpleNamespace(activeView=lambda: view),
        )

        def make_polygon(items):
            values = list(items)
            polygons.append(values)
            return ("polygon", values)

        def make_vertex(item):
            vertices.append(item)
            return ("vertex", item)

        fake_part = types.SimpleNamespace(makePolygon=make_polygon, Vertex=make_vertex)

        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "drawing.json"
            snapshot.write_text(
                json.dumps(
                    {
                        "strokes": [
                            [[100, 80], [100, 80], [120, 60]],
                            [[4, 8], [4, 8]],
                            [],
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(
                sys.modules,
                {"FreeCAD": fake_app, "FreeCADGui": fake_gui, "Part": fake_part},
            ):
                result = freecad_import.import_drawing(snapshot)

        self.assertIs(result, document)
        self.assertEqual([feature.Name for feature in document.objects], ["Stroke1", "Stroke2"])
        self.assertEqual(polygons, [[(25.0, -20.0, 0.0), (30.0, -15.0, 0.0)]])
        self.assertEqual(vertices, [(1.0, -2.0, 0.0)])
        self.assertTrue(all(feature.ViewObject.Visibility for feature in document.objects))
        self.assertEqual(document.objects[0].ViewObject.LineColor, (1.0, 0.8, 0.1))
        self.assertEqual(document.objects[0].ViewObject.LineWidth, 4.0)
        self.assertEqual(document.objects[1].ViewObject.PointColor, (1.0, 0.8, 0.1))
        self.assertEqual(document.objects[1].ViewObject.PointSize, 6.0)
        self.assertEqual(document.recompute_count, 1)
        self.assertEqual(view.top_calls, 1)
        self.assertEqual(view.fit_calls, 1)

    def test_malformed_snapshot_fails_before_document_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "drawing.json"
            snapshot.write_text('{"strokes": [[[1]]]}', encoding="utf-8")
            with self.assertRaises(ValueError):
                freecad_import.read_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
