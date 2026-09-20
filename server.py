"""AirCAD server: webcam tracker over WebSocket, static web UI, FreeCAD export.

Run ``python server.py`` and the browser opens on http://127.0.0.1:8765.
``--no-camera`` skips the webcam entirely so the UI can be driven by mouse.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import threading
from typing import Any, Optional
import webbrowser

from aiohttp import WSMsgType, web

from tracker import protocol
from tracker.controller import (
    ControllerBusyError,
    StaleStreamError,
    TrackerConfig,
    TrackerController,
    config_from_json,
)
from voice_api import handle_voice


PROJECT_ROOT = Path(__file__).resolve().parent
WEB_DIST = PROJECT_ROOT / "web" / "dist"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_EXPORT_BYTES = 8 * 1024 * 1024
TRACKER_BODY_FIELDS = ("expectedStreamId", "config", "retry")
LOCAL_ORIGIN_HOSTS = ("localhost", "127.0.0.1", "::1")

MISSING_BUILD_HTML = """<!doctype html>
<meta charset="utf-8"><title>AirCAD</title>
<body style="font: 16px/1.5 system-ui; margin: 3rem; color: #ddd; background: #14161a">
<h1>AirCAD web UI is not built yet</h1>
<p>Run <code>install.bat</code> (Windows) or <code>install.command</code> (macOS),
or build it by hand:</p>
<pre>cd web
npm install
npm run build</pre>
<p>Then reload this page. During development use <code>npm run dev</code> inside
<code>web/</code>; it proxies <code>/ws</code> and <code>/api</code> to this server.</p>
</body>"""


class Broadcaster:
    """Fan the latest tracker messages out to every connected WebSocket.

    Producers run on the camera thread and call :meth:`publish_threadsafe`.
    Messages are coalesced per type, so a slow browser receives the newest
    frame instead of an ever-growing backlog.
    """

    def __init__(self) -> None:
        self._clients: set[web.WebSocketResponse] = set()
        self._latest: dict[str, dict[str, Any]] = {}
        self._event: Optional[asyncio.Event] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.last_status: dict[str, Any] = protocol.status_message("starting", "Starting")

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._event = asyncio.Event()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def publish_threadsafe(self, message: dict[str, Any]) -> None:
        if self._loop is None or self._loop.is_closed():
            return
        try:
            self._loop.call_soon_threadsafe(self.publish, message)
        except RuntimeError:
            # The loop is shutting down; dropping a frame is fine.
            pass

    def publish(self, message: dict[str, Any]) -> None:
        if message.get("type") == "status":
            self.last_status = message
        self._latest[str(message.get("type"))] = message
        if self._event is not None:
            self._event.set()

    def clear_stream(self) -> None:
        """Drop queued per-stream messages at a source/config transition."""

        for message_type in ("keycap", "spatial", "thumb"):
            self._latest.pop(message_type, None)

    async def register(self, socket: web.WebSocketResponse) -> None:
        self._clients.add(socket)
        await self._send(socket, json.dumps(self.last_status, separators=(",", ":")))

    def unregister(self, socket: web.WebSocketResponse) -> None:
        self._clients.discard(socket)

    async def pump(self) -> None:
        assert self._event is not None
        while True:
            await self._event.wait()
            self._event.clear()
            pending = list(self._latest.values())
            self._latest.clear()
            if not self._clients:
                continue
            for message in pending:
                text = json.dumps(message, separators=(",", ":"))
                await asyncio.gather(*(self._send(socket, text) for socket in list(self._clients)))

    async def _send(self, socket: web.WebSocketResponse, text: str) -> None:
        try:
            await socket.send_str(text)
        except (ConnectionResetError, RuntimeError):
            self.unregister(socket)


def validate_export_payload(payload: Any) -> list[dict[str, Any]]:
    """Return the validated ``entities`` list of an export request or raise."""

    if not isinstance(payload, dict):
        raise ValueError("export payload must be a JSON object")
    entities = payload.get("entities")
    if not isinstance(entities, list) or not entities:
        raise ValueError("export payload needs a non-empty 'entities' list")
    units = payload.get("units", "mm")
    if units != "mm":
        raise ValueError("only millimetre exports are supported")
    return entities


async def handle_export(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        entities = validate_export_payload(payload)
    except (ValueError, json.JSONDecodeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)

    sender = request.app["send_to_freecad"]
    loop = asyncio.get_running_loop()
    try:
        snapshot = await loop.run_in_executor(None, sender, entities)
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except OSError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=502)
    return web.json_response({"ok": True, "snapshot": str(snapshot), "count": len(entities)})


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(heartbeat=20.0)
    await socket.prepare(request)
    broadcaster: Broadcaster = request.app["broadcaster"]
    await broadcaster.register(socket)
    try:
        async for message in socket:
            if message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
            # The browser currently sends nothing the server must act on;
            # accept pings/keepalives silently.
    finally:
        broadcaster.unregister(socket)
    return socket


async def handle_index(request: web.Request) -> web.StreamResponse:
    index = WEB_DIST / "index.html"
    if index.is_file():
        return web.FileResponse(index)
    return web.Response(text=MISSING_BUILD_HTML, content_type="text/html")


async def handle_health(request: web.Request) -> web.Response:
    broadcaster: Broadcaster = request.app["broadcaster"]
    return web.json_response(
        {"ok": True, "camera": broadcaster.last_status.get("camera"), "clients": broadcaster.client_count}
    )


def tracker_origin_allowed(request: web.Request) -> bool:
    """Allow same-origin and local dev-proxy calls; reject foreign origins."""

    origin = request.headers.get("Origin")
    if not origin:
        return True
    from urllib.parse import urlparse

    try:
        parsed = urlparse(origin)
        hostname = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    if hostname in LOCAL_ORIGIN_HOSTS:
        return True
    return parsed.scheme == request.scheme and parsed.netloc == request.host


async def handle_tracker_get(request: web.Request) -> web.Response:
    if not tracker_origin_allowed(request):
        return web.json_response({"ok": False, "error": "origin not allowed"}, status=403)
    controller: TrackerController = request.app["tracker"]
    return web.json_response(controller.snapshot())


async def handle_tracker_post(request: web.Request) -> web.Response:
    if not tracker_origin_allowed(request):
        return web.json_response({"ok": False, "error": "origin not allowed"}, status=403)
    if request.content_type != "application/json":
        return web.json_response({"ok": False, "error": "expected a JSON body"}, status=415)
    controller: TrackerController = request.app["tracker"]
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body must be a JSON object"}, status=400)
    unknown = sorted(set(body) - set(TRACKER_BODY_FIELDS))
    if unknown:
        return web.json_response(
            {"ok": False, "error": "unknown field(s): {}".format(", ".join(unknown))}, status=400
        )
    expected = body.get("expectedStreamId")
    if not isinstance(expected, str) or not expected:
        return web.json_response(
            {"ok": False, "error": "expectedStreamId is required"}, status=400
        )
    retry = body.get("retry", False)
    if not isinstance(retry, bool):
        return web.json_response({"ok": False, "error": "retry must be a boolean"}, status=400)
    try:
        if "config" in body:
            config = config_from_json(body["config"])
        elif retry:
            config = None
        else:
            raise ValueError("config is required")
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if expected != controller.snapshot()["streamId"]:
        return web.json_response(
            {"ok": False, "error": "configuration changed elsewhere; refresh and retry"},
            status=409,
        )
    try:
        snapshot = await controller.apply(
            config if config is not None else controller.current_config,
            expected_stream_id=expected,
            retry=retry,
        )
    except StaleStreamError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=409)
    except ControllerBusyError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=503)
    return web.json_response(snapshot)


def create_app(
    *,
    send_to_freecad=None,
    controller: Optional[TrackerController] = None,
    worker_factory=None,
    tracker_config: Optional[TrackerConfig] = None,
    diagnostics=None,
) -> web.Application:
    """Build the aiohttp application; bridges/workers are injectable for tests.

    Passing ``tracker_config`` opts into the tracker lifecycle: the configured
    source starts with the app and stops on cleanup.  Without it, no camera
    worker is started (tests stay hardware-independent).
    """

    if send_to_freecad is None:
        from freecad_bridge import send_to_freecad as default_sender

        send_to_freecad = default_sender

    app = web.Application(client_max_size=MAX_EXPORT_BYTES)
    app["broadcaster"] = Broadcaster()
    app["send_to_freecad"] = send_to_freecad
    if controller is None:
        controller = TrackerController(
            app["broadcaster"], worker_factory=worker_factory, logger=diagnostics
        )
    app["tracker"] = controller
    app.router.add_get("/", handle_index)
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/api/health", handle_health)
    app.router.add_get("/api/tracker", handle_tracker_get)
    app.router.add_post("/api/tracker", handle_tracker_post)
    app.router.add_post("/api/export/freecad", handle_export)
    app.router.add_post("/api/voice/command", handle_voice)
    if WEB_DIST.is_dir():
        app.router.add_static("/", WEB_DIST, show_index=False)

    async def start_pump(application: web.Application) -> None:
        broadcaster: Broadcaster = application["broadcaster"]
        broadcaster.bind(asyncio.get_running_loop())
        application["pump_task"] = asyncio.create_task(broadcaster.pump())

    async def stop_pump(application: web.Application) -> None:
        task = application.get("pump_task")
        if task is not None:
            task.cancel()

    async def stop_tracker(application: web.Application) -> None:
        await application["tracker"].shutdown()

    async def stop_diagnostics(application: web.Application) -> None:
        if diagnostics is not None:
            diagnostics.close()

    app.on_startup.append(start_pump)
    app.on_cleanup.append(stop_tracker)
    app.on_cleanup.append(stop_diagnostics)
    app.on_cleanup.append(stop_pump)

    if tracker_config is not None:

        async def start_tracker(application: web.Application) -> None:
            await application["tracker"].start(tracker_config)

        app.on_startup.append(start_tracker)
    return app


def open_browser_later(url: str, delay_s: float = 0.8) -> None:
    timer = threading.Timer(delay_s, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="webcam index (default: 0)")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP port (default: 8765)")
    parser.add_argument("--no-camera", action="store_true", help="skip the webcam; drive the cursor with the mouse")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    parser.add_argument("--source", choices=("webcam", "oak", "none"), default=None, help="input source (default: webcam)")
    parser.add_argument("--target", choices=("keycap",), default="keycap", help="green keycap tracking target")
    parser.add_argument("--color", choices=("green",), default="green", help="colour target preset (default: green)")
    parser.add_argument("--tracking-debug", action="store_true", help="write bounded tracking diagnostics to .runtime/depth-tracking.jsonl")
    args = parser.parse_args(argv)

    if args.no_camera:
        source = "none"
    else:
        source = args.source or "webcam"
    tracker_config = TrackerConfig(
        source=source,
        camera_index=args.camera,
        target=args.target,
        color_preset=args.color,
    )
    diagnostics = None
    if args.tracking_debug:
        from tracker.diagnostics import TrackingDiagnostics

        diagnostics = TrackingDiagnostics()

    app = create_app(tracker_config=tracker_config, diagnostics=diagnostics)
    if args.no_camera:
        app["broadcaster"].publish(protocol.status_message("disabled", "Camera disabled (--no-camera)"))

    url = "http://{}:{}/".format(args.host, args.port)
    print("AirCAD server listening on {}".format(url), flush=True)
    if not WEB_DIST.is_dir():
        print(
            "Note: web/dist is missing. Run install.bat / install.command or 'npm run build' in web/.",
            file=sys.stderr,
            flush=True,
        )
    if not args.no_browser:
        open_browser_later(url)
    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
