# AirCAD

A spatial CAD sketching app: draw lines and rectangles in millimetres on a 3D work plane using a webcam-tracked fingertip (stand-in for a digital pen) or the mouse. The browser owns the CAD model; Python only tracks the hand and can export the sketch to FreeCAD.

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
2. Press **0** for the isometric view, then **Tab** until the plane preview shows **XZ Front**.
3. Hold **Space** starting on a floor border and draw the other three sides of the wall upwards: one continuous stroke completes against the shared border. You can also draw the three sides as three separately committed straight strokes — the third one assembles the wall.
4. **Tab** until **YZ Right** and repeat the same border-start stroke on a side border; do the same on the remaining borders (Tab back to **XZ** or **YZ** so the plane stands on that border) to raise the other walls.
5. Roof: hover a wall top corner, hold **Space** and draw a straight line to the opposite wall top. Vertex snaps connect the ends.
6. **A** switches to optional **Auto** mode, where the work plane follows the view and what you hover — a face interior, an edge, or a vertex. Check the plane preview before drawing and press **Tab** or **1 / 2 / 3** to pick a plane when the choice is ambiguous. The plane locks while you draw and never moves mid-stroke.
7. Press **L** to type an exact size (`4000` or `4000x3000`) for the hovered or last entity, **E** to export to FreeCAD.

**H** opens the same walkthrough plus the full key list.

## Controls

Keys stand in for pen buttons. Click the browser window first so it receives input.

### Pen buttons (hold)

| Key | Action |
| --- | --- |
| **Space** | Pen button 1 — hold to draw a line or closed rectangle, release to commit |
| **Shift** | Pen button 2 — hold and move to orbit |
| **Ctrl** | Pen button 3 — hold and move to pan (Cmd is used for edit shortcuts on macOS) |
| **X / Y / Z** | Hold while drawing to lock to that world axis |

### Views and camera

| Key | Action |
| --- | --- |
| **1 / 2 / 3** | Top / Front / Right view (also pins the work plane to XY / XZ / YZ) |
| **0** | Isometric view |
| **5** | Orthographic / perspective |
| **F** | Fit the sketch in view |
| **= / -** | Zoom in / out around the cursor (or use the mouse wheel) |

Views glide smoothly into place, and releasing an orbit within about 6° of a view settles onto it.

### Work plane and snapping

| Key | Action |
| --- | --- |
| **A** | Automatic / manual work plane (auto picks XY / XZ / YZ from the view and what you hover) |
| **Tab** | Cycle work plane XY → XZ → YZ and pin it (A returns to auto) |
| **G** | Grid snap on / off |
| **N** | Off-hand palm navigation on / off (one open palm orbits, two palms pan/zoom) |

Snapping priority while drawing: vertex → midpoint → axis-align to the stroke start (±8°) → edge → grid (1 / 10 / 100 / 1000 mm) → free. Starting on a vertex, midpoint, or edge moves the work plane through that point so the next wall connects to the last shape.

### Editing and tools

| Key | Action |
| --- | --- |
| **Ctrl+Z** / **Cmd+Z** | Undo |
| **Ctrl+Shift+Z** / **Ctrl+Y** | Redo |
| **Delete** / **Backspace** | Delete the hovered (or last) entity |
| **Ctrl+Backspace** / **Cmd+Backspace** | Clear the sketch |
| **Esc** | Cancel the current stroke / close overlays |
| **L** | Type a length (`4000`) or size (`4000x3000`) |
| **E** | Export to FreeCAD |
| **P** | Camera picture-in-picture |
| **H** | Help overlay |

### Mouse (no webcam)

Move the pointer to drive the cursor. Left drag draws, right drag orbits, middle drag pans, wheel zooms toward the cursor (faster spin zooms faster).

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

Finish at least one line or rectangle, then press **E**. The bridge writes millimetre entities to `.runtime/freecad_drawing.json`, starts FreeCAD as a separate GUI process, and opens an isometric view. Rectangles become faces; lines become wires. Export is a one-time snapshot: drawing afterward does not change an already opened FreeCAD document.

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

Python tests use synthetic observations and never require a webcam. The TypeScript tests cover recognition, snapping, work planes, sketch history, and measurements.

## Troubleshooting

- **Camera does not open (macOS):** allow the app running Python (such as Terminal) under System Settings → Privacy & Security → Camera. Quit and reopen that app after changing permission.
- **Camera does not open (Windows):** allow camera access under Settings → Privacy & security → Camera, close other camera apps, or try `--camera 1`.
- **Browser shows “web UI is not built yet”:** run **install.bat** / **install.command**, or `npm install && npm run build` inside `web/`.
- **Keys do nothing:** click the 3D viewport so it has focus. If a measurement field is open, finish or cancel it first.
- **Plane is edge-on:** press **A** for auto, **Tab** or **1 / 2 / 3**, or orbit with **Shift**.
- **Palm navigation moves unexpectedly:** press **N** to turn it off. Drawing (**Space**) always wins over palm nav.
- **FreeCAD not found:** set `FREECAD_EXECUTABLE` as above and confirm `freecad_import.py` is beside `server.py`.
- **Missing Python packages:** run **install.bat** / **install.command**, or `pip install -r requirements.txt` in `.venv`.
- **Missing Node packages:** run `npm install` inside `web/`.

The `hand_landmarker.task` file next to the scripts is Google's hand-tracking model. If missing, the server downloads it automatically on first camera run (about 8 MB). Tracking then runs locally; camera frames are not uploaded or saved.

MediaPipe is pinned to 0.10.35 because the 1.0.1 release crashed during hand-landmarker initialization on Apple Silicon. See Google's [Hand Landmarker Python guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/python).
