"""Firmware install, both directions.

The same endpoint installs the escape-pod image (setup) and installs stock
firmware over it (undo). They share a transport and differ in every judgement
around it, so these tests pin the differences: which image, which guard, and
what a refusal is taken to mean.
"""
import asyncio

import pytest

from game_bridge import config
from game_bridge.web import pairing, server as srv
from game_bridge.web.server import WebUI


class _StubBle:
    """Stands in for the live BLE session the flash runs over."""

    def __init__(self, raises: Exception | None = None):
        self.esn = "00e20145"
        self.name = "Vector-T3ST"
        self.ble = None
        self.raises = raises
        self.urls = []

    async def ota_flash(self, url, progress_cb=None, **kw):
        self.urls.append(url)
        if self.raises:
            raise self.raises
        return True


class _StubBridge:
    link = None
    pump = None
    commander = None
    robot_alive = False


@pytest.fixture
def ui_factory(monkeypatch):
    monkeypatch.setattr(config, "read_robot_identity", lambda: ("", "", ""))
    from aiohttp.test_utils import TestClient, TestServer

    def make(ble=None, wirepod_ready=True):
        monkeypatch.setattr(
            pairing, "wirepod_status",
            lambda pod="": {"ready": wirepod_ready,
                            "detail": "not in escape-pod mode"})
        ui = WebUI(_StubBridge())
        ui._ble = ble if ble is not None else _StubBle()
        return ui, TestClient(TestServer(ui.app))
    return make


async def _settle():
    """The handler answers before the flash task has run — let it."""
    for _ in range(20):
        await asyncio.sleep(0)


# ---- which image, and which guard ----------------------------------------

def test_setup_flash_installs_the_escape_pod_image(ui_factory):
    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            r = await client.post("/api/ble/flash_ep", json={})
            assert (await r.json())["ok"] is True
            await _settle()
            assert config.EP_OTA_NAME in ui._ble.urls[0]
            assert ui._flash["mode"] == "ep"
        finally:
            await client.close()
    asyncio.run(go())


def test_setup_flash_refuses_when_the_engine_is_not_in_escape_pod_mode(ui_factory):
    # The robot would finish a 180 MB install pointed at a name nobody answers.
    async def go():
        ui, client = ui_factory(wirepod_ready=False)
        await client.start_server()
        try:
            r = await client.post("/api/ble/flash_ep", json={})
            assert r.status == 409
            body = await r.json()
            assert body["ok"] is False and body["step"] == "wirepod"
            await _settle()
            assert ui._ble.urls == []
        finally:
            await client.close()
    asyncio.run(go())


def test_revert_installs_stock_and_ignores_that_guard(ui_factory):
    # Reverting is walking away from the pairing engine, so requiring it to be
    # healthy first is backwards — an unhealthy engine must not block the undo.
    async def go():
        ui, client = ui_factory(wirepod_ready=False)
        await client.start_server()
        try:
            r = await client.post("/api/ble/flash_ep", json={"mode": "revert"})
            assert (await r.json())["ok"] is True
            await _settle()
            assert config.STOCK_OTA_NAME in ui._ble.urls[0]
            assert config.EP_OTA_NAME not in ui._ble.urls[0]
            assert ui._flash["mode"] == "revert"
        finally:
            await client.close()
    asyncio.run(go())


def test_an_explicit_image_name_still_wins(ui_factory):
    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            await client.post("/api/ble/flash_ep",
                              json={"mode": "revert",
                                    "ota": "vicos-2.0.1.6080.ota"})
            await _settle()
            assert "vicos-2.0.1.6080.ota" in ui._ble.urls[0]
        finally:
            await client.close()
    asyncio.run(go())


# ---- what a refusal is taken to mean -------------------------------------

def test_a_refused_setup_flash_records_a_dev_robot(ui_factory, monkeypatch):
    # 214 during setup is the robot saying "I am a dev build" — the one thing
    # his recovery version string cannot tell us. Recording it is the point.
    seen = []
    monkeypatch.setattr(config, "remember_build_type",
                        lambda kind, *ids: seen.append(kind))

    async def go():
        ui, client = ui_factory(_StubBle(raises=RuntimeError("OTA error 214")))
        await client.start_server()
        try:
            await client.post("/api/ble/flash_ep", json={})
            await _settle()
            assert seen == ["dev"]
            assert ui._flash["needs_dev_path"] is True
        finally:
            await client.close()
    asyncio.run(go())


def test_a_refused_revert_does_not_rewrite_the_robots_build_type(ui_factory,
                                                                 monkeypatch):
    # Same rejection, opposite meaning: he is a stock robot we set up
    # ourselves, so 214 here is about the image. Recording him as a dev robot
    # would silently poison every later decision about him.
    seen = []
    monkeypatch.setattr(config, "remember_build_type",
                        lambda kind, *ids: seen.append(kind))

    async def go():
        ui, client = ui_factory(_StubBle(raises=RuntimeError("OTA error 214")))
        await client.start_server()
        try:
            await client.post("/api/ble/flash_ep", json={"mode": "revert"})
            await _settle()
            assert seen == []
            assert ui._flash["needs_dev_path"] is False
            assert "still on the escape-pod firmware" in ui._flash["error"]
        finally:
            await client.close()
    asyncio.run(go())


# ---- serving the image ---------------------------------------------------

def test_both_mirrors_are_configured():
    # Neither host carries every image: archive.org has the escape-pod build
    # and 404s on plain production ones, the DDL mirror is the other way
    # round. Losing the second entry breaks the undo and nothing else, which
    # is exactly the kind of removal that goes unnoticed.
    hosts = " ".join(config.OTA_MIRRORS)
    assert "archive.org" in hosts
    assert "vectorfirmware.ddlbot.ai" in hosts
    assert all("{name}" in m for m in config.OTA_MIRRORS)


def test_get_ota_rejects_a_path_traversing_name(ui_factory):
    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            r = await client.get("/api/get_ota/..%2Fsecret.ota")
            assert r.status in (400, 404)
        finally:
            await client.close()
    asyncio.run(go())


def test_get_ota_prefers_a_cached_file_over_the_network(ui_factory, tmp_path,
                                                       monkeypatch):
    img = tmp_path / "vicos-test.ota"
    img.write_bytes(b"x" * 1_000_001)          # over the "looks real" floor
    monkeypatch.setattr(config, "OTA_CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "OTA_MIRRORS", ())   # network would fail

    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            r = await client.get("/api/get_ota/vicos-test.ota")
            assert r.status == 200
            assert len(await r.read()) == 1_000_001
        finally:
            await client.close()
    asyncio.run(go())


def test_get_ota_tries_the_next_mirror_when_the_first_has_no_such_image(
        ui_factory, tmp_path, monkeypatch):
    # The whole reason for a mirror list: the first one answers 404 for stock
    # images, and before this the request simply failed there.
    asked = []

    class _Resp:
        def __init__(self, status):
            self.status = status
            self.content_length = 3 if status == 200 else 0
            self.content = self

        async def iter_chunked(self, n):
            yield b"ota"

        def __aiter__(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class _Sess:
        async def get(self, url):
            asked.append(url)
            return _Resp(200 if "second" in url else 404)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(config, "OTA_CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "OTA_REPO_DIR", tmp_path)
    monkeypatch.setattr(config, "OTA_MIRRORS",
                        ("https://first/{name}", "https://second/{name}"))
    import aiohttp
    monkeypatch.setattr(aiohttp, "ClientSession", lambda *a, **k: _Sess())

    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            r = await client.get("/api/get_ota/vicos-stock.ota")
            assert r.status == 200
            assert await r.read() == b"ota"
            assert len(asked) == 2            # fell through, did not give up
            assert asked[1].startswith("https://second/")
        finally:
            await client.close()
    asyncio.run(go())


def test_get_ota_reports_when_no_mirror_has_it(ui_factory, tmp_path,
                                               monkeypatch):
    class _Resp:
        status = 404

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class _Sess:
        async def get(self, url):
            return _Resp()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(config, "OTA_CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "OTA_REPO_DIR", tmp_path)
    monkeypatch.setattr(config, "OTA_MIRRORS", ("https://nowhere/{name}",))
    import aiohttp
    monkeypatch.setattr(aiohttp, "ClientSession", lambda *a, **k: _Sess())

    async def go():
        ui, client = ui_factory()
        await client.start_server()
        try:
            r = await client.get("/api/get_ota/vicos-missing.ota")
            assert r.status == 502
            assert "no mirror has" in await r.text()
        finally:
            await client.close()
    asyncio.run(go())
