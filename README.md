# AirCAD

A spatial CAD sketching app: draw lines and closed outlines in millimetres on a 3D work plane, then extrude them into solids using a webcam-tracked fingertip (stand-in for a digital pen) or the mouse. The browser owns the CAD model; Python tracks the hand and can export the model to FreeCAD.

## Requirements

- **Python 3.10, 3.11, or 3.12** (MediaPipe 0.10.35 has no wheels for 3.13+)
- **Node.js 18+** (to install and build the web UI)
- A webcam is optional. Without one, run with `--no-camera` and draw with the mouse.

## Install

### Windows

Install Python from [python.org](https://www.python.org/downloads/) and tick **Add python.exe to PATH**. Install [Node.js 18+](https://nodejs.org/). Then double-click **install.bat**.

### macOS

Install Python 3.10–3.12 and Node 18+, then double-click **install.command** (allow it in System Settings if macOS blocks it the first time).

Alternatively from a terminal:

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cd web && npm install && npm run build && cd ..
```

```bat
REM Windows
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
cd web && npm install && npm run build && cd ..
```

A macOS `.venv` copied onto Windows will not work; `install.bat` replaces it. Keep separate checkouts if you need both at once.

## Run

Double-click **Start AirCAD.bat** (Windows) or **Start AirCAD.command** (macOS). The server opens http://127.0.0.1:8765/ in your browser.

```bash
# macOS / Linux
.venv/bin/python server.py
```

```bat
REM Windows
.venv\Scripts\python.exe -u server.py
```

Useful flags:

- `--no-camera` — skip the webcam; the mouse drives the cursor
- `--no-browser` — do not open a browser tab
- `--camera 1` — another webcam index
- `--port 8765` — HTTP port

If Windows or macOS asked for camera access on first launch, allow it and start the app again.

## Sketch a house

1. Press **1** for the top view and draw a closed rectangle: the floor (for example 4000 × 3000 mm).
2. Press **0** for the isometric view, then **Tab** until the plane chip says **XZ Front**.
3. Hover a floor corner until the cursor becomes a square (vertex snap), hold **Space** and draw a rectangle upwards. The work plane moves through that corner, so the wall stands on the floor.
4. **Tab** to **YZ Right**, hover another corner and draw the side wall the same way.
5. Roof: hover a wall top corner, hold **Space** and draw a straight line to the opposite wall top. Vertex snaps connect the ends.
6. Press **L** to type an exact size (`4000` or `4000x3000`) for the selected, hovered, or last entity, **E** to export to FreeCAD.

**H** opens the same walkthrough plus the full key list.

## Draw a closed outline

Hold **Space** or left-drag around any simple closed shape — triangles, concave outlines, and even round loops are kept as drawn (a closed round stroke becomes a polygon outline; circles are no longer fitted). You can also draw the sides as separate lines whose endpoints snap together: the closed loop is then recognised and selectable as one outline. An outline must lie flat on one work plane and must not cross itself; holes are not supported.

## Extrude with your hand

1. Draw a closed outline — one stroke, or separate endpoint-connected lines. New shapes are selected automatically. To select another shape, point inside it and pinch your thumb and index finger, click it, or press **S**. The selected outline stays highlighted.
2. Press **Q** to start extrusion. The face most facing the camera is highlighted — hover another face of the same shape (while not pinching) or press **Tab** to switch which side you push/pull. **E** remains the FreeCAD export shortcut.
3. Pinch thumb + index and move to pull the highlighted face **out**, or back to push it **in**. Pulling a cap face sets the depth; pulling a side face moves that boundary edge. Grid snapping applies to the pull distance. If tracking is lost, the preview freezes; show your hand, release, then pinch again to resume.
4. Release the pinch to pause. Reposition your hand and pinch again to continue. Hold **Shift** to orbit or **Ctrl** to pan even during a pull; the preview stays fixed while you move the view. Release the navigation key to continue pulling from the current position without a depth jump.
5. Press **Enter** or **Q** to apply, or **Esc** to cancel. **L** types an exact pull distance for the active face (`500`, `-250`, or `2 m`); **0** shows the result in isometric view. A zero-depth preview cannot be applied.

Without a webcam, use **Q**, then **left-drag** (or hold **Space** while moving) along the highlighted direction. Release to pause, then **Enter** to apply. Extrusion is one undoable edit; undo restores the outline. Select an existing solid and press **Q** to push/pull any of its faces. **L** on a solid edits depth with one value or, for rectangular bases, base size with `width x height`.

Extrusion supports any simple closed planar outline: triangles, concave shapes, and loops of endpoint-connected lines. Open paths, single lines, and saved circles cannot be extruded; circles remain loadable and renderable but are read-only.

## Controls

Keys stand in for pen buttons. Click the browser window first so it receives input.

### Pen buttons (hold)

| Key | Action |
| --- | --- |
| **Space** | Pen button 1 — hold to draw a line or any closed outline, release to commit |
| **Shift** | Pen button 2 — hold and move to orbit |
| **Ctrl** | Pen button 3 — hold and move to pan (Cmd is used for edit shortcuts on macOS) |
| **X / Y / Z** | Hold while drawing to lock to that world axis |

### Views and camera

| Key | Action |
| --- | --- |
| **1 / 2 / 3** | Top / Front / Right view (also sets the work plane to XY / XZ / YZ) |
| **0** | Isometric view |
| **5** | Orthographic / perspective |
| **F** | Fit the sketch in view |
| **= / -** | Zoom in / out around the cursor (or use the mouse wheel) |

### Work plane and snapping

| Key | Action |
| --- | --- |
| **Tab** | Cycle work plane XY → XZ → YZ without moving the camera (while extruding: switch the pushed face) |
| **G** | Grid snap on / off |
| **N** | Off-hand palm navigation on / off (one open palm orbits, two palms pan/zoom) |

Snapping priority while drawing: vertex → midpoint → axis-align to the stroke start (±8°) → edge → grid (1 / 10 / 100 / 1000 mm) → free. Starting on a vertex, midpoint, or edge moves the work plane through that point so the next wall connects to the last shape.

### Editing and tools

| Key | Action |
| --- | --- |
| **Ctrl+Z** / **Cmd+Z** | Undo |
| **Ctrl+Shift+Z** / **Ctrl+Y** | Redo |
| **Delete** / **Backspace** | Delete the selected, hovered, or last entity |
| **Ctrl+Backspace** / **Cmd+Backspace** | Clear the sketch |
| **Esc** | Cancel the current stroke / extrusion, deselect, or close overlays |
| **S** | Select the shape under the cursor (also pinch or click) |
| **Q** | Start push/pull on a selected closed outline or solid; press again to apply |
| **Enter** | Apply the extrusion preview |
| **L** | Type a line length, rectangle size (W x H), or extrusion depth; mm/cm/m accepted |
| **E** | Export to FreeCAD |
| **P** | Camera picture-in-picture |
| **H** | Help overlay |

### Mouse (no webcam)

Move the pointer to drive the cursor. Left click selects; left drag draws (or adjusts depth in extrusion mode), right drag orbits, middle drag pans, wheel zooms.

## Coordinate system

Everything is in millimetres. The origin is `(0, 0, 0)`, **Z is up**. The work plane is one of XY (top), XZ (front), or YZ (right) and always passes through an anchor point (the origin until you snap or commit).

## Development

Serve the tracker without a camera and run Vite for hot reload:

```bash
.venv/bin/python server.py --no-camera --no-browser
cd web && npm run dev
```

On Windows use `.venv\Scripts\python.exe -u server.py --no-camera --no-browser`. Vite proxies `/ws` and `/api` to `http://127.0.0.1:8765`. Open the URL Vite prints (usually http://127.0.0.1:5173/).

`window.aircad` in the browser is the same command surface (`commands.setDimension`, undo, export payload) that a later voice/AI layer can call.

## Send a sketch to FreeCAD

Finish at least one line, rectangle, or extrusion, then press **E**. The bridge writes millimetre entities to `.runtime/freecad_drawing.json`, starts FreeCAD as a separate GUI process, and opens an isometric view. Rectangles become faces; lines become wires; extrusions become closed solids. Apply or cancel an extrusion preview before exporting. Export is a one-time snapshot: drawing afterward does not change an already opened FreeCAD document.

The bridge looks for `FreeCAD` on `PATH`, the standard macOS app executable, and typical Windows install folders under Program Files. If FreeCAD is installed elsewhere:

```bash
# macOS / Linux
FREECAD_EXECUTABLE="/Applications/FreeCAD.app/Contents/MacOS/FreeCAD" \
  .venv/bin/python server.py
```

```powershell
# Windows
$env:FREECAD_EXECUTABLE = "C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe"
.\.venv\Scripts\python.exe -u server.py
```

Set `FREECAD_EXECUTABLE` to the executable (not the `.app` directory or a Windows install folder). An empty export means nothing has been committed yet.

## Tests

```bash
# macOS / Linux
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
cd web && npm test
```

```bat
REM Windows
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
cd web && npm test
```

Python tests use synthetic observations and never require a webcam. The TypeScript tests cover recognition, snapping, work planes, sketch history, measurements, face selection, and extrusion gestures including tracking loss. Python tests cover solid export validation and import as well.

## Troubleshooting

- **Camera does not open (macOS):** allow the app running Python (such as Terminal) under System Settings → Privacy & Security → Camera. Quit and reopen that app after changing permission.
- **Camera does not open (Windows):** allow camera access under Settings → Privacy & security → Camera, close other camera apps, or try `--camera 1`.
- **Browser shows “web UI is not built yet”:** run **install.bat** / **install.command**, or `npm install && npm run build` inside `web/`.
- **Keys do nothing:** click the 3D viewport so it has focus. If a measurement field is open, finish or cancel it first.
- **Plane is edge-on:** press **Tab** or **1 / 2 / 3**, or orbit with **Shift**.
- **Palm navigation moves unexpectedly:** press **N** to turn it off. Drawing (**Space**) disables automatic palm navigation; held **Shift** / **Ctrl** deliberately take priority to move the camera.
- **FreeCAD not found:** set `FREECAD_EXECUTABLE` as above and confirm `freecad_import.py` is beside `server.py`.
- **Missing Python packages:** run **install.bat** / **install.command**, or `pip install -r requirements.txt` in `.venv`.
- **Missing Node packages:** run `npm install` inside `web/`.

The `hand_landmarker.task` file next to the scripts is Google's hand-tracking model. If missing, the server downloads it automatically on first camera run (about 8 MB). Tracking then runs locally; camera frames are not uploaded or saved.

MediaPipe is pinned to 0.10.35 because the 1.0.1 release crashed during hand-landmarker initialization on Apple Silicon. See Google's [Hand Landmarker Python guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/python).
