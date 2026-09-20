# Project direction

New CAD functionality should be native to AirCAD. FreeCAD is no longer part of the intended project workflow; do not add FreeCAD integration or make new features depend on it. Existing legacy integration files should not be removed without an explicit request.

## Voice prototype

- Voice in `web/src/voice/` is a separate measurement input for active native line and face-pull sessions. It supplies a positive distance only; sessions own target/direction. No idle selected-object fallback or FreeCAD routing.
- `voice_api.py` follows the organizer's `yibuapi_examples_20260918_v01` HTTP contract: `https://yibuapi.com/v1/chat/completions`, model `qwen3.5-omni-flash`, Bearer `YIBU_API_KEY`, and WAV data-URL `input_audio`. Credentials come only from the Python server environment; `.env` files are not loaded automatically and keys must never use `VITE_*` variables.
- Lines use a continuously refined free-angle voice guide from the last 12 movement-filtered drag samples after 32 screen pixels, within the active XY/XZ/YZ work plane at its actual 3D offset. Automatic grid/near-axis snaps do not quantize this guide; explicit X/Y/Z locks and on-plane object constraints are honored. V freezes the displayed direction; normal non-voice shape recognition stays unchanged. Face pulls use the current grab's baseline and the selected face's normal/sign, preserving the opposite face/orientation/extrusion sign for solids.
- V during a draw/pull captures and freezes the draft before opening the mic; V again sends. The user may release while waiting. Valid results replace the rough distance and immediately commit one undoable edit. Esc cancels the draft/request; a failed/cancelled request can be retried on the frozen draft. Normal non-voice release-to-commit is unchanged.
- `yibu_audit.py` is the unchanged organizer helper. Each upstream attempt records purpose `aircad_voice_resize_axis` and actual usage in `artifacts/yibu_api_calls.jsonl` (override with `YIBU_AUDIT_LOG`). Missing usage remains null. Do not log keys, prompts, or audio to this ledger, and do not silently bypass audit failures.
- The browser/server command is `{distance_mm: number}`; context is `{operation: 'line'|'face_pull', units: 'mm'}`. Validate positive finite limits, exact geometry (no grid rounding/clamping), and stale operation identity/revision. API transcripts write spoken numbers as digits and must full-match a bare distance or 'by' distance; legacy axis instructions are rejected. Audit purpose stays `aircad_voice_resize_axis` for compatibility.
- The voice HTTPS request explicitly uses the certifi CA bundle with certificate and hostname verification enabled. Some macOS Python installations have no default CA bundle; do not work around that by disabling TLS verification.
- Focused checks: `.venv/bin/python -m unittest discover -s tests -p 'test_voice*.py' -v`; from `web`, `npm test -- src/voice/commands.test.ts src/voice/microphone.test.ts src/voice/control.test.ts src/main.test.ts src/model/commands.test.ts src/model/stroke.test.ts src/model/extrusion.test.ts src/model/faces.test.ts src/input/input.test.ts` and `npm run build`.

## Closed-outline extrusion

- Native profiles are any simple closed planar outline: polygons (`PolygonEntity`), rectangles, and virtual `LineLoopProfile`s detected from endpoint-connected lines. Virtual loops are never serialized; extruding one consumes only its unshared source lines as a single undoable edit.
- Shared polygon geometry lives in `web/src/model/polygon.ts` (planarity, simple-ring validation, `ShapeUtils.triangulateShape` triangulation) and loop detection in `web/src/model/loops.ts`; keep them free of runtime import cycles.
- Circle fitting/drawing was removed: round closed strokes become polygons. Legacy saved circles still load, render, and serialize, but are read-only (no extrude/diameter edit) — do not reintroduce a circle command without an explicit request.
- Out of scope: holes, non-planar or self-crossing outlines. Do not silently clamp or grid-round typed/voice measurements.
