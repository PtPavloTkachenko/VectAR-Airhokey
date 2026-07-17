"""Web API tests against a stub Bridge (no robot, no lens)."""
import asyncio

import pytest

from game_bridge import config
from game_bridge.web.server import WebUI


class _StubWS:
    client = None


class _StubTransform:
    bound = False

    def robot_to_field(self, x, y, deg):
        return x, y, deg


class _StubBridge:
    def __init__(self):
        self.link = None
        self.pump = None
        self.commander = None
        self.ws = _StubWS()
        self.transform = _StubTransform()
        self.rally_active = False
        self.mock_pose = False
        self.use_robot = True
        self.connect_calls = 0

    async def connect_robot(self):
        self.connect_calls += 1
        return False


@pytest.fixture
def client_factory(monkeypatch):
    # never leak the developer machine's real pairing into test output
    monkeypatch.setattr(config, "read_robot_identity", lambda: ("", "", ""))
    from aiohttp.test_utils import TestClient, TestServer

    def make():
        bridge = _StubBridge()
        ui = WebUI(bridge)
        return bridge, TestClient(TestServer(ui.app))
    return make


def test_status_unpaired(client_factory):
    async def go():
        bridge, client = client_factory()
        await client.start_server()
        try:
            r = await client.get("/api/status")
            assert r.status == 200
            data = await r.json()
            assert data["robot"]["paired"] is False
            assert data["robot"]["connected"] is False
            assert data["lens"]["connected"] is False
            assert data["game"]["rally_active"] is False
            assert data["server"]["ws_port"] == config.WS_PORT
        finally:
            await client.close()
    asyncio.run(go())


def test_pair_validation_error(client_factory):
    async def go():
        bridge, client = client_factory()
        await client.start_server()
        try:
            r = await client.post("/api/pair", json={
                "pod": "localhost:1", "serial": "", "name": "x", "ip": ""})
            data = await r.json()
            assert data["ok"] is False
            assert data["step"] == "cert"
            assert "serial" in data["error"].lower()
        finally:
            await client.close()
    asyncio.run(go())


def test_connect_endpoint_calls_bridge(client_factory):
    async def go():
        bridge, client = client_factory()
        await client.start_server()
        try:
            r = await client.post("/api/connect")
            data = await r.json()
            assert data["ok"] is False       # stub returns False
            assert bridge.connect_calls == 1
        finally:
            await client.close()
    asyncio.run(go())


def test_index_served(client_factory):
    async def go():
        bridge, client = client_factory()
        await client.start_server()
        try:
            r = await client.get("/")
            assert r.status == 200
            body = await r.text()
            assert "PAIR ROBOT" in body
        finally:
            await client.close()
    asyncio.run(go())
