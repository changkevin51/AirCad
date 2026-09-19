# Webcam finger drawing

This is a camera drawing app with an optional FreeCAD proof-of-concept bridge.
It uses MediaPipe Hand Landmarker Tasks and OpenCV to draw directly over a
mirrored webcam preview. Only completed stroke points can be sent to FreeCAD;
camera frames are never saved or sent over the network.

## Run on macOS

The dependencies are already installed in this project's `.venv`. In Finder,
open the project folder and double-click **Start Drawing.command**.
Allow Terminal (or the app running Python) to use the camera when macOS asks.
If the first attempt exits during the permission prompt, launch it again.

Alternatively:

```bash
cd "/path/to/Codex AirCad"
.venv/bin/python hand_tracker.py
```

Use `.venv/bin/python hand_tracker.py --camera 1` for another camera index.

## Run on Windows

Install **Python 3.10, 3.11, or 3.12** from [python.org](https://www.python.org/downloads/)
and tick **Add python.exe to PATH**. MediaPipe 0.10.35 does not support Python 3.13+.

Then double-click **install.bat** once, allow camera access if Windows asks, and
double-click **Start Drawing.bat**. If the first attempt exits during the
permission prompt, launch it again.

Alternatively from PowerShell or Command Prompt:

```bat
cd "C:\path\to\Codex AirCad"
install.bat
.venv\Scripts\python.exe -u hand_tracker.py
```

Use `.venv\Scripts\python.exe -u hand_tracker.py --camera 1` for another camera
index. A macOS `.venv` copied onto Windows will not work; `install.bat` replaces
it with a Windows environment. Keep separate checkouts if you need both at once.

## Gesture workflow

1. Put one or both whole hands in view. Each hand gets its own color, cursor,
   palm marker, and stable on-screen hand label.
2. Touch thumb tip to index fingertip to pinch. After a brief debounce, the
   index tip starts a stroke; move while pinched and release to finish. Both
   hands can draw independent strokes at the same time.
3. A single fully open palm held briefly arms one-hand pan. Move it deliberately
   to pan every saved trail. Merely showing a hand does not pan.
4. Two fully open palms held apart form navigation handles. Their midpoint
   pans, their separation zooms, and the angle of the connecting line rotates
   the saved drawing around the handle midpoint. Pinch always wins and blocks
   navigation.
5. Each completed stroke is checked by `shape_recognition.py`. Confident lines,
   circles, triangles, and rectangles are shown as canonical shapes when
   snapping is on. Uncertain strokes remain freehand. The original points stay
   intact, so **S** can switch between snapped and raw display at any time.

The camera image stays fixed. Trails are stored in canvas coordinates and the
pan/zoom/rotation view is applied when they are rendered; new fingertip points
are inverse-projected into that same canvas, so drawing continues under the
finger after navigation.

## Controls

Click the camera window first so it receives the keys.

- **Space** — pause/resume gesture input. A held pinch must be released and
  pinched again after resuming.
- **C** — clear all trails and active strokes.
- **U** — undo the most recent completed stroke.
- **R** — reset pan, zoom, and rotation without clearing trails.
- **S** — toggle automatic shape snapping.
- **F** — send the completed raw strokes to FreeCAD. The same action is
  available from the **SEND TO FREECAD** button in the camera window.
- **Q**, **Esc**, or close the window — quit.

The in-window HUD repeats these controls and the current hand/trail/snap/view
status. Tracking uses the camera frame; the preview starts at 960×720 and can
be resized. Widescreen cameras and non-matching window sizes are letterboxed
instead of stretched. The HUD also changes to `PAN ARMED` or `2-HAND VIEW`
after the open-palm dwell, and marks the participating cursors.

## Send a drawing to FreeCAD

Draw and release the pinch to finish one or more strokes, then click **SEND TO
FREECAD** or press **F**. The bridge snapshots the completed raw canvas points
in `.runtime/freecad_drawing.json`, starts FreeCAD as a separate GUI process,
and opens a top view containing one visible polyline per stroke. Export is a
one-time snapshot: drawing afterward does not change an already opened
FreeCAD document. Shape snapping affects the camera display only; the bridge
always receives the original points. Inspect the JSON file when checking the
transfer.

The bridge looks for `FreeCAD` on `PATH`, the standard macOS app executable,
and typical Windows install folders under Program Files. If FreeCAD is
installed elsewhere, run the camera with its executable path:

```bash
# macOS / Linux
FREECAD_EXECUTABLE="/Applications/FreeCAD.app/Contents/MacOS/FreeCAD" \
  .venv/bin/python hand_tracker.py
```

```powershell
# Windows
$env:FREECAD_EXECUTABLE = "C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe"
.\.venv\Scripts\python.exe -u hand_tracker.py
```

If sending reports that FreeCAD cannot be found or started, set
`FREECAD_EXECUTABLE` to the executable (not the `.app` directory or a Windows
install folder), confirm that `freecad_import.py` is beside `hand_tracker.py`,
and read the terminal error detail. An empty send means no pinch has been
completed yet; release the pinch and try **F** again. The camera remains
usable after an empty send or a bridge launch failure.

## Hand labels and practical limits

There is no dominant-hand requirement. MediaPipe's Left/Right label is useful
for the HUD but is only a hint for identity; geometry and recent motion keep a
hand stable when detector order changes, labels are missing/duplicated, or a
hand briefly disappears. A temporary loss ends that hand's stroke so no unseen
gap is connected. Reappearing while still pinched does not restart until the
hand visibly releases. Crossings and heavy occlusion can still be ambiguous;
keep the two hands reasonably separated for the most reliable two-hand
navigation.

Use good, even lighting and keep the whole hand inside the frame. Pinch needs
the thumb and index tips to be visible. Open-palm navigation requires the
fingers to be intentionally extended and held for roughly a quarter second;
slow motion below the per-frame deadband accumulates rather than being ignored.
Fast motion, extreme foreshortening, glare, motion blur, and hands leaving the
camera image can temporarily pause tracking. Trails remain visible while
tracking is lost or input is paused, but drawings are held in memory and are
discarded when the app quits.

## Install on a fresh setup

macOS / Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python hand_tracker.py
```

Windows: double-click **install.bat**, or:

```bat
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -u hand_tracker.py
```

The `hand_landmarker.task` file next to the script is Google's hand-tracking
model. If missing, the script downloads it automatically on first run (about
8 MB). Tracking then runs locally; camera frames are not uploaded or saved.

MediaPipe is pinned to 0.10.35 because the installed 1.0.1 release crashed
during hand-landmarker initialization on this Apple Silicon Mac. This uses the
Hand Landmarker Tasks API with two hands. See Google's
[Python guide](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/python)
and [model download](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task).

## Troubleshooting

- **Camera does not open (macOS):** allow the app running Python (such as
  Terminal) under System Settings → Privacy & Security → Camera. Quit and
  reopen that app after changing permission. Close other apps using the camera.
- **Camera does not open (Windows):** allow camera access under Settings →
  Privacy & security → Camera, then run **Start Drawing.bat** again. Close
  other apps using the camera, or try `--camera 1`.
- **Space/C/U/R/S do nothing:** click the camera window, not the terminal.
- **No pinch cursor or trail:** show the whole hand, make the thumb/index
  relationship clear, and check that the HUD is not paused.
- **Navigation moves unexpectedly:** hold an open palm still until it arms;
  pinch takes priority. Use **R** to rebaseline the view.
- **Missing Python packages (macOS / Linux):** run
  `.venv/bin/python -m pip install -r requirements.txt`.
- **Missing Python packages (Windows):** run **install.bat**, or
  `.venv\Scripts\python.exe -m pip install -r requirements.txt`.

Unit tests use synthetic pixel-space observations and never require webcam
access:

```bash
# macOS / Linux
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

```bat
REM Windows
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
```
