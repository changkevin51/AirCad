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


PROJECT_ROOT = Path(__file__).resolve().parent
WEB_DIST = PROJECT_ROOT / "web" / "dist"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_EXPORT_BYTES = 8 * 1024 * 1024

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


def create_app(*, send_to_freecad=None) -> web.Application:
    """Build the aiohttp application; the bridge is injectable for tests."""

    if send_to_freecad is None:
        from freecad_bridge import send_to_freecad as default_sender

        send_to_freecad = default_sender

    app = web.Application(client_max_size=MAX_EXPORT_BYTES)
    app["broadcaster"] = Broadcaster()
    app["send_to_freecad"] = send_to_freecad
    app.router.add_get("/", handle_index)
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/api/health", handle_health)
    app.router.add_post("/api/export/freecad", handle_export)
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

    app.on_startup.append(start_pump)
    app.on_cleanup.append(stop_pump)
    return app


def start_camera(app: web.Application, camera_index: int):
    """Attach the camera worker to the app lifecycle; returns the worker."""

    from tracker.camera import CameraWorker

    broadcaster: Broadcaster = app["broadcaster"]

    def on_frame(frame, observations, width, height) -> None:
        broadcaster.publish_threadsafe(protocol.hands_message(frame, width, height, observations))

    def on_thumb(jpeg, width, height) -> None:
        if broadcaster.client_count:
            broadcaster.publish_threadsafe(protocol.thumb_message(jpeg, width, height))

    def on_status(state, message) -> None:
        print("Camera: {}".format(message), file=sys.stderr, flush=True)
        broadcaster.publish_threadsafe(protocol.status_message(state, message))

    worker = CameraWorker(camera_index, on_frame, on_thumb, on_status)

    async def start_worker(_app: web.Application) -> None:
        worker.start()

    async def stop_worker(_app: web.Application) -> None:
        worker.stop()
        await asyncio.get_running_loop().run_in_executor(None, worker.join, 3.0)

    app.on_startup.append(start_worker)
    app.on_cleanup.append(stop_worker)
    return worker


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
    args = parser.parse_args(argv)

    app = create_app()
    if args.no_camera:
        app["broadcaster"].publish(protocol.status_message("disabled", "Camera disabled (--no-camera)"))
    else:
        start_camera(app, args.camera)

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
