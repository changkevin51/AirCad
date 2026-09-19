"""HTTP/WebSocket surface of server.py with an injected FreeCAD sender."""

from __future__ import annotations

import json
from pathlib import Path
import unittest
from unittest import mock

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
            self.assertEqual(latest["type"], "hands")
            self.assertEqual(latest["t"], 2)
        self.assertEqual(broadcaster.client_count, 0)

    async def test_index_without_build_explains_how_to_build(self) -> None:
        async with self.client.get("/") as response:
            self.assertEqual(response.status, 200)
            text = await response.text()
        self.assertTrue("<!doctype html>" in text.lower())


class FakeWorker:
    instances = []

    def __init__(self, config, callbacks, logger=None):
        self.config = config
        self.callbacks = callbacks
        self.alive = False
        FakeWorker.instances.append(self)

    def start(self):
        self.alive = True

    def stop(self):
        self.alive = False

    def join(self, timeout=None):
        pass

    def is_alive(self):
        return self.alive

    def update_config(self, config):
        pass


def _fake_factory(config, callbacks, logger=None):
    return FakeWorker(config, callbacks, logger=logger)


class TrackerApiTests(AioHTTPTestCase):
    async def get_application(self):
        from tracker.controller import TrackerConfig

        FakeWorker.instances = []
        return server.create_app(
            send_to_freecad=lambda entities: Path("/tmp/freecad_drawing.json"),
            worker_factory=_fake_factory,
            tracker_config=TrackerConfig(source="webcam"),
        )

    def _config(self, **overrides):
        config = {
            "source": "webcam",
            "cameraIndex": 0,
            "target": "finger",
            "colorPreset": "green",
            "colorTolerance": 1.0,
        }
        config.update(overrides)
        return config

    async def test_get_tracker_snapshot(self) -> None:
        with mock.patch("tracker.controller.depthai_installed", return_value=False):
            async with self.client.get("/api/tracker") as response:
                self.assertEqual(response.status, 200)
                payload = await response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["config"], self._config())
        self.assertEqual(payload["camera"], "starting")
        self.assertTrue(payload["streamId"])
        self.assertTrue(payload["sourceRunId"])
        self.assertIsInstance(payload["serverTimeMs"], (int, float))
        self.assertEqual(payload["capabilities"]["sources"], ["webcam", "oak", "none"])
        self.assertEqual(payload["capabilities"]["depthTargets"], ["finger", "color"])
        self.assertFalse(payload["capabilities"]["depthaiInstalled"])
        self.assertEqual(len(FakeWorker.instances), 1)

    async def test_post_applies_new_config(self) -> None:
        async with self.client.get("/api/tracker") as response:
            stream = (await response.json())["streamId"]
        body = {"expectedStreamId": stream, "config": self._config(source="oak", target="color", colorPreset="red", colorTolerance=1.5)}
        async with self.client.post("/api/tracker", json=body) as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        self.assertTrue(payload["ok"])
        self.assertNotEqual(payload["streamId"], stream)
        self.assertEqual(payload["config"]["source"], "oak")
        self.assertEqual(payload["config"]["colorPreset"], "red")
        self.assertEqual(len(FakeWorker.instances), 2)

    async def test_post_stale_stream_conflict(self) -> None:
        body = {"expectedStreamId": "outdated", "config": self._config(source="oak")}
        async with self.client.post("/api/tracker", json=body) as response:
            self.assertEqual(response.status, 409)
            self.assertFalse((await response.json())["ok"])
        self.assertEqual(len(FakeWorker.instances), 1)

    async def test_post_validation_rejects_bad_bodies(self) -> None:
        async with self.client.get("/api/tracker") as response:
            stream = (await response.json())["streamId"]
        cases = [
            {"config": self._config()},
            {"expectedStreamId": stream, "config": self._config(), "bogus": 1},
            {"expectedStreamId": stream, "config": self._config(source="bad")},
            {"expectedStreamId": stream, "config": self._config(cameraIndex=True)},
            {"expectedStreamId": stream, "config": self._config(cameraIndex=99)},
            {"expectedStreamId": stream, "config": self._config(target="x")},
            {"expectedStreamId": stream, "config": self._config(colorPreset="x")},
            {"expectedStreamId": stream, "config": self._config(colorTolerance=4.0)},
            {"expectedStreamId": stream, "config": {"source": "oak"}},
            {"expectedStreamId": stream, "config": self._config(source="oak", extra=1)},
            {"expectedStreamId": stream, "retry": "yes"},
            {"expectedStreamId": stream},
        ]
        for body in cases:
            with self.subTest(body=body):
                async with self.client.post("/api/tracker", json=body) as response:
                    self.assertEqual(response.status, 400)
        self.assertEqual(len(FakeWorker.instances), 1)

    async def test_post_requires_json_and_safe_origin(self) -> None:
        for content_type in ("text/plain", "application/jsonp", "application/jsonbad"):
            with self.subTest(content_type=content_type):
                async with self.client.post(
                    "/api/tracker", data="{}", headers={"Content-Type": content_type}
                ) as response:
                    self.assertEqual(response.status, 415)
        async with self.client.post(
            "/api/tracker",
            data="{}",
            headers={"Content-Type": "application/json; charset=utf-8"},
        ) as response:
            self.assertEqual(response.status, 400)
        async with self.client.get("/api/tracker") as response:
            stream = (await response.json())["streamId"]
        body = {"expectedStreamId": stream, "retry": True}
        for origin in (
            "https://evil.example",
            "http://[::1",
            "ftp://localhost:5173",
            "http://localhost.evil.example:5173",
        ):
            with self.subTest(origin=origin):
                async with self.client.post(
                    "/api/tracker", json=body, headers={"Origin": origin}
                ) as response:
                    self.assertEqual(response.status, 403)
        async with self.client.post("/api/tracker", json=body, headers={"Origin": "http://localhost:5173"}) as response:
            self.assertEqual(response.status, 200)

    async def test_retry_restarts_current_source(self) -> None:
        async with self.client.get("/api/tracker") as response:
            before = await response.json()
        async with self.client.post("/api/tracker", json={"expectedStreamId": before["streamId"], "retry": True}) as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        self.assertNotEqual(payload["streamId"], before["streamId"])
        self.assertNotEqual(payload["sourceRunId"], before["sourceRunId"])
        self.assertEqual(len(FakeWorker.instances), 2)


class TrackerAppSeamTests(AioHTTPTestCase):
    async def get_application(self):
        FakeWorker.instances = []
        return server.create_app(
            send_to_freecad=lambda entities: Path("/tmp/freecad_drawing.json"),
            worker_factory=_fake_factory,
        )

    async def test_no_camera_without_lifecycle_opt_in(self) -> None:
        self.assertEqual(len(FakeWorker.instances), 0)
        async with self.client.get("/api/tracker") as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        self.assertEqual(payload["camera"], "starting")
        self.assertEqual(payload["config"]["source"], "webcam")
        self.assertEqual(len(FakeWorker.instances), 0)

    async def test_post_started_worker_shut_down_at_app_cleanup(self) -> None:
        async with self.client.get("/api/tracker") as response:
            stream = (await response.json())["streamId"]
        body = {
            "expectedStreamId": stream,
            "config": {
                "source": "oak",
                "cameraIndex": 0,
                "target": "finger",
                "colorPreset": "green",
                "colorTolerance": 1.0,
            },
        }
        async with self.client.post("/api/tracker", json=body) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(len(FakeWorker.instances), 1)
        self.assertTrue(FakeWorker.instances[0].alive)
        await self.app.cleanup()
        self.assertFalse(FakeWorker.instances[0].alive)


if __name__ == "__main__":
    unittest.main()
