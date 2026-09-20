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
            ShapeColor=None,
            Transparency=None,
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
        self.iso_calls = 0
        self.fit_calls = 0

    def viewIsometric(self) -> None:
        self.iso_calls += 1

    def fitAll(self) -> None:
        self.fit_calls += 1


class FreeCADImportTests(unittest.TestCase):
    def test_points_are_millimetres_with_consecutive_deduplication(self) -> None:
        self.assertEqual(
            freecad_import.converted_points([(100, 80, 0), (100, 80, 0), (120, 60, 2500)]),
            ((100.0, 80.0, 0.0), (120.0, 60.0, 2500.0)),
        )
        self.assertEqual(freecad_import.converted_points([(5, 5)]), ((5.0, 5.0, 0.0),))

    def test_import_creates_wires_for_lines_and_faces_for_rectangles(self) -> None:
        document = _FakeDocument()
        view = _FakeView()
        polygons: list[list[tuple[float, float, float]]] = []
        faces: list[object] = []

        fake_app = types.SimpleNamespace(Vector=lambda x, y, z: (x, y, z), newDocument=lambda _name: document)
        fake_gui = types.SimpleNamespace(
            showMainWindow=lambda: None,
            activeDocument=lambda: types.SimpleNamespace(activeView=lambda: view),
        )

        def make_polygon(items):
            values = list(items)
            polygons.append(values)
            return ("polygon", values)

        def make_face(wire):
            faces.append(wire)
            return ("face", wire)

        fake_part = types.SimpleNamespace(makePolygon=make_polygon, Face=make_face)

        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "drawing.json"
            snapshot.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "units": "mm",
                        "entities": [
                            {"type": "line", "points": [[0, 0, 0], [4000, 0, 0]]},
                            {"type": "rect", "points": [[0, 0, 0], [4000, 0, 0], [4000, 0, 2500], [0, 0, 2500]]},
                            {"type": "polyline", "points": [[0, 0, 0], [0, 0, 0], [1, 1, 1], [2, 2, 2]]},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.dict(sys.modules, {"FreeCAD": fake_app, "FreeCADGui": fake_gui, "Part": fake_part}):
                result = freecad_import.import_drawing(snapshot)

        self.assertIs(result, document)
        self.assertEqual([feature.Name for feature in document.objects], ["Line1", "Rectangle1", "Polyline1"])
        self.assertEqual([feature.Label for feature in document.objects], ["Line 1", "Rectangle 1", "Polyline 1"])
        self.assertEqual(polygons[0], [(0.0, 0.0, 0.0), (4000.0, 0.0, 0.0)])
        # The rectangle wire is closed and turned into a face.
        self.assertEqual(polygons[1][0], polygons[1][-1])
        self.assertEqual(len(polygons[1]), 5)
        self.assertEqual(faces, [("polygon", polygons[1])])
        self.assertEqual(document.objects[1].Shape, ("face", ("polygon", polygons[1])))
        self.assertEqual(polygons[2], [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0), (2.0, 2.0, 2.0)])
        self.assertTrue(all(feature.ViewObject.Visibility for feature in document.objects))
        self.assertEqual(document.objects[0].ViewObject.LineColor, freecad_import.LINE_COLOR)
        self.assertEqual(document.objects[1].ViewObject.ShapeColor, freecad_import.FACE_COLOR)
        self.assertEqual(document.objects[1].ViewObject.Transparency, 40)
        self.assertIsNone(document.objects[0].ViewObject.ShapeColor)
        self.assertEqual(document.recompute_count, 1)
        self.assertEqual(view.iso_calls, 1)
        self.assertEqual(view.fit_calls, 1)

    def test_malformed_snapshots_fail_before_document_creation(self) -> None:
        bad_payloads = [
            '{"strokes": [[[1, 2]]]}',
            '{"entities": [{"type": "line", "points": [[1, 2, 3]]}]}',
            '{"entities": [{"type": "rect", "points": [[0, 0, 0], [1, 0, 0], [1, 1, 0]]}]}',
            '{"entities": [{"type": "sphere", "points": [[0, 0, 0], [1, 0, 0]]}]}',
            '{"entities": [{"type": "line", "points": [[0, 0, 0], [0, 0, 0]]}]}',
            '{"entities": [{"type": "line", "points": [[0, 0, 0], ["x", 0, 0]]}]}',
            '{"entities": [{"type": "triangle", "points": [[0, 0, 0], [1, 0, 0]]}]}',
            '{"entities": [{"type": "triangle", "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]]}]}',
            '{"entities": [{"type": "prism", "points": [[0, 0, 0], [100, 0, 0], [0, 80, 0]]}]}',
            '{"entities": [{"type": "prism", "points": [[0, 0, 0], [100, 0, 0], [0, 80, 0]], "vector": [0, 0]}]}',
            '{"entities": [{"type": "prism", "points": [[0, 0, 0], [100, 0, 0], [0, 80, 0]], "vector": [0, 0, 0]}]}',
            '{"entities": [{"type": "prism", "points": [[0, 0, 0], [100, 0, 0], [0, 80, 0]], "vector": [1, 0, 0]}]}',
        ]
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "drawing.json"
            for payload in bad_payloads:
                with self.subTest(payload=payload):
                    snapshot.write_text(payload, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        freecad_import.read_snapshot(snapshot)

    def test_extrusion_import_builds_a_solid_with_the_exported_vector(self) -> None:
        document = _FakeDocument()
        view = _FakeView()
        face = mock.Mock()
        face.extrude.return_value = "extruded solid"
        fake_app = types.SimpleNamespace(Vector=lambda *values: tuple(values), newDocument=lambda _name: document)
        fake_gui = types.SimpleNamespace(activeDocument=lambda: types.SimpleNamespace(activeView=lambda: view))
        fake_part = types.SimpleNamespace(makePolygon=lambda values: values, Face=mock.Mock(return_value=face))
        solid = {"type": "extrusion", "points": [[0, 0, 0], [100, 0, 0], [100, 80, 0], [0, 80, 0]], "vector": [0, 0, -250]}
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "solid.json"
            snapshot.write_text(json.dumps({"entities": [solid]}), encoding="utf-8")
            with mock.patch.dict(sys.modules, {"FreeCAD": fake_app, "FreeCADGui": fake_gui, "Part": fake_part}):
                freecad_import.import_drawing(snapshot)
        face.extrude.assert_called_once_with((0.0, 0.0, -250.0))
        self.assertEqual(len(fake_part.Face.call_args.args[0]), 5)
        self.assertEqual(document.objects[0].Shape, "extruded solid")
        self.assertEqual(document.objects[0].Label, "Extrusion 1")
        self.assertEqual(document.objects[0].ViewObject.Transparency, 15)

    def test_invalid_extrusions_fail_before_creating_a_document(self) -> None:
        solid = {"type": "extrusion", "points": [[0, 0, 0], [100, 0, 0], [100, 80, 0], [0, 80, 0]], "vector": [0, 0, 250]}
        malformed = [{**solid, "vector": value} for value in (None, [0, 0], [0, 0, 0], [100, 0, 0], [0, 0, float("nan")])]
        malformed.append({**solid, "points": [[0, 0, 0]] * 4})
        new_document = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "invalid.json"
            with mock.patch.dict(sys.modules, {"FreeCAD": types.SimpleNamespace(newDocument=new_document), "FreeCADGui": types.SimpleNamespace(), "Part": types.SimpleNamespace()}):
                for entity in malformed:
                    snapshot.write_text(json.dumps({"entities": [entity]}), encoding="utf-8")
                    with self.subTest(entity=entity), self.assertRaises(ValueError):
                        freecad_import.import_drawing(snapshot)
        new_document.assert_not_called()

    def test_triangle_face_and_prism_solids_preserve_tilted_geometry(self) -> None:
        tri = [[10, 20, 30], [110, 20, 30], [40, 100, 90]]
        for vector in (None, [0, -30, 40], [0, 30, -40]):
            with self.subTest(vector=vector):
                document = _FakeDocument()
                view = _FakeView()
                face = mock.Mock()
                face.extrude.return_value = "prism solid"
                fake_app = types.SimpleNamespace(Vector=lambda *values: tuple(values), newDocument=lambda _name: document)
                fake_gui = types.SimpleNamespace(activeDocument=lambda: types.SimpleNamespace(activeView=lambda: view))
                fake_part = types.SimpleNamespace(makePolygon=lambda values: list(values), Face=mock.Mock(return_value=face))
                entity = {"type": "triangle", "points": tri} if vector is None else {"type": "prism", "points": tri, "vector": vector}
                with tempfile.TemporaryDirectory() as directory:
                    snapshot = Path(directory) / "drawing.json"
                    snapshot.write_text(json.dumps({"entities": [entity]}), encoding="utf-8")
                    with mock.patch.dict(sys.modules, {"FreeCAD": fake_app, "FreeCADGui": fake_gui, "Part": fake_part}):
                        freecad_import.import_drawing(snapshot)
                wire = fake_part.Face.call_args.args[0]
                self.assertEqual(len(wire), 4)
                self.assertEqual(wire[0], wire[-1])
                self.assertEqual(wire[:3], [(10.0, 20.0, 30.0), (110.0, 20.0, 30.0), (40.0, 100.0, 90.0)])
                feature = document.objects[0]
                self.assertTrue(feature.ViewObject.Visibility)
                self.assertEqual(feature.ViewObject.ShapeColor, freecad_import.FACE_COLOR)
                if vector is None:
                    face.extrude.assert_not_called()
                    self.assertIs(feature.Shape, face)
                    self.assertEqual(feature.Label, "Triangle 1")
                    self.assertEqual(feature.ViewObject.Transparency, 40)
                else:
                    face.extrude.assert_called_once_with(tuple(float(value) for value in vector))
                    self.assertEqual(feature.Shape, "prism solid")
                    self.assertEqual(feature.Label, "Prism 1")
                    self.assertEqual(feature.ViewObject.Transparency, 15)
                self.assertEqual(document.recompute_count, 1)
                self.assertEqual(view.iso_calls, 1)
                self.assertEqual(view.fit_calls, 1)

    def test_each_import_creates_a_new_document_and_raises_the_window(self) -> None:
        documents = [_FakeDocument(), _FakeDocument()]
        views = [_FakeView(), _FakeView()]
        new_document = mock.Mock(side_effect=documents)
        main_window = mock.Mock()
        main_window.isMinimized.side_effect = [True, False]
        fake_app = types.SimpleNamespace(Vector=lambda *values: tuple(values), newDocument=new_document)
        fake_gui = types.SimpleNamespace(
            activeDocument=mock.Mock(side_effect=[
                types.SimpleNamespace(activeView=lambda: views[0]),
                types.SimpleNamespace(activeView=lambda: views[1]),
            ]),
            getMainWindow=lambda: main_window,
        )
        face = mock.Mock()
        face.extrude.return_value = "prism solid"
        fake_part = types.SimpleNamespace(makePolygon=lambda values: list(values), Face=mock.Mock(return_value=face))
        payloads = [
            {"entities": [{"type": "line", "points": [[0, 0, 0], [10, 0, 0]]}]},
            {"entities": [{"type": "prism", "points": [[10, 20, 30], [110, 20, 30], [10, 100, 30]], "vector": [0, 0, -50]}]},
        ]
        results = []
        with tempfile.TemporaryDirectory() as directory:
            for index, payload in enumerate(payloads):
                snapshot = Path(directory) / f"drawing_{index}.json"
                snapshot.write_text(json.dumps(payload), encoding="utf-8")
                with mock.patch.dict(sys.modules, {"FreeCAD": fake_app, "FreeCADGui": fake_gui, "Part": fake_part}):
                    results.append(freecad_import.import_drawing(snapshot))
        self.assertEqual(new_document.call_count, 2)
        self.assertIs(results[0], documents[0])
        self.assertIs(results[1], documents[1])
        self.assertEqual([feature.Label for feature in documents[0].objects], ["Line 1"])
        self.assertEqual(documents[0].objects[0].Shape, [(0.0, 0.0, 0.0), (10.0, 0.0, 0.0)])
        self.assertEqual([feature.Label for feature in documents[1].objects], ["Prism 1"])
        self.assertEqual(documents[1].objects[0].Shape, "prism solid")
        self.assertEqual(documents[0].recompute_count, 1)
        self.assertEqual(documents[1].recompute_count, 1)
        self.assertEqual(views[0].iso_calls, 1)
        self.assertEqual(views[0].fit_calls, 1)
        self.assertEqual(views[1].iso_calls, 1)
        self.assertEqual(views[1].fit_calls, 1)
        main_window.showNormal.assert_called_once()
        self.assertEqual(main_window.raise_.call_count, 2)
        self.assertEqual(main_window.activateWindow.call_count, 2)

    def test_invalid_triangles_and_prisms_fail_before_creating_a_document(self) -> None:
        triangle = {"type": "triangle", "points": [[0, 0, 0], [100, 0, 0], [0, 80, 0]]}
        prism = {"type": "prism", "points": triangle["points"], "vector": [0, 0, 50]}
        malformed = [
            {**triangle, "points": [[0, 0, 0], [1, 0, 0]]},
            {**triangle, "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]},
            {**triangle, "points": [[0, 0, 0]] * 3},
            {**triangle, "points": [[0, 0, 0], [10, 10, 10], [20, 20, 20]]},
            {**triangle, "points": [[0, 0, 0], [True, 0, 0], [0, 10, 0]]},
            {**prism, "points": [[0, 0, 0], [1, 0, 0]]},
            {**prism, "vector": None},
            {**prism, "vector": [0, 0]},
            {**prism, "vector": [0, 0, 0]},
            {**prism, "vector": [1, 0, 0]},
            {**prism, "vector": [0, 0, float("nan")]},
        ]
        new_document = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "invalid.json"
            with mock.patch.dict(sys.modules, {"FreeCAD": types.SimpleNamespace(newDocument=new_document), "FreeCADGui": types.SimpleNamespace(), "Part": types.SimpleNamespace()}):
                for entity in malformed:
                    snapshot.write_text(json.dumps({"entities": [entity]}), encoding="utf-8")
                    with self.subTest(entity=entity), self.assertRaises(ValueError):
                        freecad_import.import_drawing(snapshot)
        new_document.assert_not_called()


if __name__ == "__main__":
    unittest.main()
