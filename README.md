# AirCAD

A spatial CAD sketching app: draw lines and closed outlines in millimetres on a 3D work plane, then extrude them into solids using a webcam-tracked fingertip (stand-in for a digital pen) or the mouse. The browser owns the CAD model; Python tracks the hand and can export the model to FreeCAD.

## Requirements

- **Python 3.10, 3.11, or 3.12** (MediaPipe 0.10.35 has no wheels for 3.13+)
- **Node.js 18+** (to install and build the web UI)
- A webcam is optional. Without one, run with `--no-camera` and draw with the mouse.
- An **OAK-D S2** is optional. Depth tracking needs the extra package in `requirements-depth.txt` (`depthai==2.30.0.0`). The default install does not install DepthAI.

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

Optional OAK-D support (does not replace the base install):

```bash
.venv/bin/python -m pip install -r requirements-depth.txt
```

```bat
.venv\Scripts\python.exe -m pip install -r requirements-depth.txt
```

`install.bat` / `install.command` accept `--depth` to do that in one step. Do not install DepthAI 3.x; this project uses the v2 API.

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
- `--source oak` — start with the OAK-D depth camera (`--target finger|color`, `--color green|red|blue`)
- `--tracking-debug` — write bounded JSONL diagnostics to `.runtime/depth-tracking.jsonl`
- `--port 8765` — HTTP port

If Windows or macOS asked for camera access on first launch, allow it and start the app again.

## Sketch a house

1. Press **1** for the top view and draw a closed rectangle: the floor (for example 4000 × 3000 mm).
2. Press **0** for the isometric view, then **Tab** until the plane preview shows **XZ Front**.
3. Hold **Space** starting on a floor border and draw the other three sides of the wall upwards: one continuous stroke completes against the shared border. You can also draw the three sides as three separately committed straight strokes — the third one assembles the wall.
4. **Tab** until **YZ Right** and repeat the same border-start stroke on a side border; do the same on the remaining borders (Tab back to **XZ** or **YZ** so the plane stands on that border) to raise the other walls.
5. Roof: hover a wall top corner, hold **Space** and draw a straight line to the opposite wall top. Vertex snaps connect the ends.
6. **A** switches to optional **Auto** mode, where the work plane follows the view and what you hover — a face interior, an edge, or a vertex. Check the plane preview before drawing and press **Tab** or **1 / 2 / 3** to pick a plane when the choice is ambiguous. The plane locks while you draw and never moves mid-stroke.
7. Press **L** to type an exact size (`4000` or `4000x3000`) for the selected, hovered, or last entity. **Ctrl+S** saves a local JSON download; **Ctrl+O** opens one (replacing the scene and clearing undo). **E** still exports to FreeCAD.

**H** opens the same walkthrough plus the full key list.

## Draw a closed outline

Hold **Space** or left-drag around any simple closed shape. A closed loop that is even loosely rectangular — including round loops, rounded corners, and wobbly sides — squares up to a rectangle. Circles are not fitted. Fitted triangles stay as a dedicated triangle entity. Distinct concave outlines stay polygons. You can also draw the sides as separate lines whose endpoints snap together: the closed loop is then recognised and selectable as one outline. An outline must lie flat on one work plane and must not cross itself; holes are not supported.

Select any shape and press **M** to move it on the work plane, or **R** to scale it by dragging a corner while the opposite corner stays fixed. **Enter** (or **M** / **R**) applies the preview as one undoable edit. **Esc** cancels.

## Extrude with your hand

1. Draw a closed outline — one stroke, or separate endpoint-connected lines. New shapes are selected automatically. To select another shape, point inside it and pinch your thumb and index finger, click it, or press **S**. The selected outline stays highlighted.
2. Press **Q** to start push/pull. The face most facing the camera is highlighted — hover another face of the same shape (while not pinching) or press **Tab** to switch which side you push/pull. **E** remains the FreeCAD export shortcut.
3. Pinch thumb + index and move to pull the highlighted face **out**, or back to push it **in**. Pulling a cap face sets the depth; pulling a side face moves that boundary edge. Grid snapping applies to the pull distance. If tracking is lost, the preview freezes; show your hand, release, then pinch again to resume.
4. Release the pinch to pause. Reposition your hand and pinch again to continue. Hold **Shift** to orbit or **Ctrl** to pan even during a pull; the preview stays fixed while you move the view. Release the navigation key to continue pulling from the current position without a depth jump.
5. Press **Enter** or **Q** to apply, or **Esc** to cancel. **L** types an exact pull distance for the active face (`500`, `-250`, or `2 m`); **0** shows the result in isometric view. A zero-depth preview cannot be applied.

Without a webcam, use **Q**, then **left-drag** (or hold **Space** while moving) along the highlighted direction. Release to pause, then **Enter** to apply. Extrusion is one undoable edit; undo restores the outline. Select an existing solid and press **Q** to push/pull any of its faces. **L** on a solid edits depth with one value or, for rectangular bases, base size with `width x height`.

Extrusion supports any simple closed planar outline: triangles (as triangular prisms), concave shapes, and loops of endpoint-connected lines. Open paths, single lines, and saved circles cannot be extruded; circles remain loadable and renderable but are read-only.

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
| **1 / 2 / 3** | Top / Front / Right view (also pins the work plane to XY / XZ / YZ) |
| **0** | Isometric view |
| **5** | Orthographic / perspective |
| **Display** | X-ray (see-through) or Shaded (opaque faces) in the view header |
| **D** | Reveal the finished model / return to editing |
| **F** | Fit the sketch in view |
| **= / -** | Zoom in / out around the cursor (or use the mouse wheel) |

Views glide smoothly into place, and releasing an orbit within about 6° of a view settles onto it.

### Work plane and snapping

| Key | Action |
| --- | --- |
| **A** | Automatic / manual work plane (auto picks XY / XZ / YZ from the view and what you hover) |
| **Tab** | Cycle work plane XY → XZ → YZ and pin it (A returns to auto; while extruding: switch the pushed face) |
| **G** | Grid snap on / off |
| **N** | Off-hand palm navigation on / off (one open palm orbits, two palms pan/zoom) |

Nearby vertices, midpoints, and edges attract the cursor before the grid. A soft axis alignment (±16°) uses an exact edge intersection when possible, but will not keep a stroke floating beside a nearby line. A stroke drawn nearly parallel to an existing edge can adopt that edge's direction and length. X / Y / Z remain hard axis locks. Starting on an object snap moves the work plane through that point.

Roughly matching adjacent rectangles align along the entire shared border, with matching dimensions when the new size is close. Closed outlines can be messy — bowed sides, rounded corners, extra wiggles, and a sizable closing gap still snap to a clean rectangle. This works for closed outlines and continuous three-sided strokes; the preview shows the exact result before release. Clearly smaller attachments keep their partial border, and existing rectangles are never resized. Use L afterward for exact dimensions.

### Editing and tools

| Key | Action |
| --- | --- |
| **Ctrl+Z** / **Cmd+Z** | Undo |
| **Ctrl+Shift+Z** / **Ctrl+Y** | Redo |
| **Delete** / **Backspace** | Delete the selected, hovered, or last entity |
| **Ctrl+Backspace** / **Cmd+Backspace** | Clear the sketch |
| **Esc** | Cancel the current stroke / move / scale / extrusion, deselect, or close overlays |
| **S** | Select the shape under the cursor (also pinch or click) |
| **Q** | Start push/pull on a selected closed outline or solid; press again to apply |
| **M** | Move the selected shape on the work plane; press again to apply |
| **R** | Scale the selected shape from a corner; press again to apply |
| **Enter** | Apply the move, scale, or extrusion preview |
| **L** | Type a line length, rectangle size (W x H), or extrusion depth; mm/cm/m accepted |
| **V** | Speak a distance for the active line or face pull (recognizer picked in the voice panel) |
| **Ctrl+S** / **Cmd+S** | Save the sketch as a local JSON download (no autosave) |
| **Ctrl+O** / **Cmd+O** | Open a local AirCAD JSON sketch (replaces the scene and clears undo) |
| **E** | Export to FreeCAD |
| **P** | Camera picture-in-picture |
| **H** | Help overlay |

### Depth camera (OAK-D S2)

Keep the camera **fixed, upright, and approximately level**. The browser maps camera millimetres after you set an origin; rotating the 3D view does not change that mapping.

| Control | Action |
| --- | --- |
| Input panel | Webcam / Depth camera / Mouse, Finger or LED/Colour, scale |
| **O** | Set origin from a 400 ms stable capture (maps that pose to world 0,0,0) |
| **Shift+R** | Recenter mapping on the last committed endpoint |
| **F** | Fit a local workspace cube (about 400 mm physical × scale) |
| **Space** | Draw a line, rectangle, or triangle on the current work plane (assembled / shared-border still apply) |
| **G** | Optional XYZ grid (off by default in depth mode) |
| **X / Y / Z** | Hard axis lock in millimetres |

Depth drawing is always planar. In Auto mode the last-used plane is only a provisional reference (HUD: *decided by stroke*); the plane is chosen from the stroke direction after pen-down and then locked. Tab / 1 / 2 / 3 still pin a plane in Manual mode and force every sample onto it. Nearby vertices, midpoints, and edges attract the cursor before pen-down, with a 1.5× magnet at pen-down and pen-up. In-plane distance is used so stereo depth noise is less likely to miss a point on the plane. Straight strokes snap to an axis if the in-plane angle is under 30° or over 60°; between 30° and 60° the line is committed and you are prompted to type the exact angle (any finite angle is allowed). A stroke drawn near an existing line adopts that line's direction (parallel, or collinear if close enough); starting on an edge can snap perpendicular to it. Snapping uses the larger of 40 mm × scale and ~40 screen pixels. Default scale is 10 (1 physical mm = 10 model mm) and is remembered. Colour tracking prefers a textured/opaque tip — a bare LED often has no measurable stereo surface.

If you move or unplug the camera, press **Retry** and set the origin again. Calibration is not saved.

### Mouse (no webcam)

Move the pointer to drive the cursor. Left click selects; left drag draws (or adjusts depth in extrusion mode), right drag orbits, middle drag pans, wheel zooms toward the cursor (faster spin zooms faster).

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

Finish at least one shape, then press **E** in the AirCAD viewport. Every press exports a fresh millimetre snapshot to a new document in the running FreeCAD window, brings that window forward, and fits an isometric view. Lines become wires; rectangles and triangles become faces; rectangular extrusions and triangular prisms become closed solids. The current move, scale, or extrusion preview is included without committing it or changing undo history; a zero-depth extrusion preview is exported as a face. Close a measurement field before using the shortcut. Earlier FreeCAD documents remain unchanged when you draw more or export again.

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
- **Plane is edge-on:** press **A** for auto, **Tab** or **1 / 2 / 3**, or orbit with **Shift**.
- **Palm navigation moves unexpectedly:** press **N** to turn it off. Drawing (**Space**) always wins over palm nav; held **Shift** / **Ctrl** deliberately take priority to move the camera.
- **FreeCAD not found:** set `FREECAD_EXECUTABLE` as above and confirm `freecad_import.py` is beside `server.py`.
- **Depth camera will not start:** install `pip install -r requirements-depth.txt` (DepthAI 2.30.0.0), use USB3, and close `track-finger.py` if it still has the device.
- **Origin needed:** press **O** and hold still for about half a second. Unplugging the OAK invalidates calibration.
- **Missing Python packages:** run **install.bat** / **install.command**, or `pip install -r requirements.txt` in `.venv`.
- **Missing Node packages:** run `npm install` inside `web/`.

The `hand_landmarker.task` file next to the scripts is Google's hand-tracking model. If missing, the server downloads it automatically on first camera run (about 8 MB). Tracking then runs locally; camera frames are not uploaded or saved.

MediaPipe is pinned to 0.10.35 because the 1.0.1 release crashed during hand-landmarker initialization on Apple Silicon. See Google's [Hand Landmarker Python guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/python).
