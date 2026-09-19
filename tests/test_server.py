"""HTTP/WebSocket surface of server.py with an injected FreeCAD sender."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from aiohttp import WSMsgType
from aiohttp.test_utils import AioHTTPTestCase

import server
from tracker import protocol


class ServerTests(AioHTTPTestCase):
    async def get_application(self):
        self.sent: list[list[dict]] = []

        def fake_sender(entities):
            self.sent.append(entities)
            if entities and entities[0].get("type") == "boom":
                raise OSError("FreeCAD GUI executable was not found")
            return Path("/tmp/freecad_drawing.json")

        return server.create_app(send_to_freecad=fake_sender)

    async def test_health_reports_camera_state(self) -> None:
        self.app["broadcaster"].publish(protocol.status_message("disabled", "no camera"))
        async with self.client.get("/api/health") as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["camera"], "disabled")

    async def test_export_forwards_entities_to_the_bridge(self) -> None:
        body = {"units": "mm", "entities": [{"type": "line", "points": [[0, 0, 0], [1, 0, 0]]}]}
        async with self.client.post("/api/export/freecad", json=body) as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(self.sent, [body["entities"]])

    async def test_export_rejects_bad_payloads(self) -> None:
        for body in ({}, {"entities": []}, {"entities": "nope"}, {"units": "inch", "entities": [{"type": "line"}]}):
            with self.subTest(body=body):
                async with self.client.post("/api/export/freecad", json=body) as response:
                    self.assertEqual(response.status, 400)
                    self.assertFalse((await response.json())["ok"])
        async with self.client.post("/api/export/freecad", data="not json", headers={"Content-Type": "application/json"}) as response:
            self.assertEqual(response.status, 400)
        self.assertEqual(self.sent, [])

    async def test_export_reports_missing_freecad_as_bad_gateway(self) -> None:
        async with self.client.post("/api/export/freecad", json={"entities": [{"type": "boom", "points": []}]}) as response:
            self.assertEqual(response.status, 502)
            payload = await response.json()
        self.assertIn("FreeCAD", payload["error"])

    async def test_websocket_receives_status_then_broadcast_frames(self) -> None:
        broadcaster = self.app["broadcaster"]
        broadcaster.publish(protocol.status_message("ready", "Camera ready"))
        async with self.client.ws_connect("/ws") as socket:
            first = json.loads((await socket.receive_str()))
            self.assertEqual(first, {"type": "status", "camera": "ready", "message": "Camera ready"})

            broadcaster.publish_threadsafe({"type": "hands", "hands": [], "frame": {"w": 640, "h": 480}, "nav": None, "t": 1})
            broadcaster.publish_threadsafe({"type": "hands", "hands": [{"id": 1}], "frame": {"w": 640, "h": 480}, "nav": None, "t": 2})
            message = await socket.receive(timeout=2.0)
            self.assertEqual(message.type, WSMsgType.TEXT)
            latest = json.loads(message.data)
            # Frames are coalesced: a slow client gets the newest one.
            self.assertEqual(latest["type"], "hands")
            self.assertEqual(latest["t"], 2)
        self.assertEqual(broadcaster.client_count, 0)

    async def test_index_without_build_explains_how_to_build(self) -> None:
        async with self.client.get("/") as response:
            self.assertEqual(response.status, 200)
            text = await response.text()
        self.assertTrue("<!doctype html>" in text.lower())


if __name__ == "__main__":
    unittest.main()
