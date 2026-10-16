"""Shared test setup: a practice copy of the Business Suite inbox served at the real URL."""
import os
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
MOCK_HTML = (ROOT / "tests" / "mock_inbox.html").read_text(encoding="utf-8")
ENGINE_JS = (ROOT / "extension" / "engine.js").read_text(encoding="utf-8")
INBOX_URL = "https://business.facebook.com/latest/inbox/all/?asset_id=1"
TINY_PNG = ROOT / "tests" / "promo.png"

sys.path.insert(0, str(ROOT / "desktop"))


def serve_mock(target):
    """Answer every business.facebook.com request with the practice inbox."""
    target.route("https://business.facebook.com/**", lambda route: route.fulfill(
        status=200, content_type="text/html; charset=utf-8", body=MOCK_HTML))


@pytest.fixture(scope="session")
def pw():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def browser(pw):
    b = pw.chromium.launch(headless=True)
    yield b
    b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    serve_mock(pg)
    pg.goto(INBOX_URL)
    pg.evaluate(ENGINE_JS)
    yield pg
    ctx.close()


@pytest.fixture(scope="session", autouse=True)
def promo_png():
    if not TINY_PNG.exists():
        import struct
        import zlib
        w, h = 32, 24
        raw = b"".join(b"\x00" + bytes([200, 80 + y * 5, 60]) * w for y in range(h))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
        TINY_PNG.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                             + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    yield TINY_PNG
