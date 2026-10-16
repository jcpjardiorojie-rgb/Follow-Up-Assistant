"""Option A end to end: install the real extension, open the practice inbox, drive the side panel."""
import pathlib
import tempfile

import pytest
from conftest import INBOX_URL, ROOT, TINY_PNG, serve_mock

EXT = str(ROOT / "extension")
SHOTS = ROOT / "docs" / "screenshots"


@pytest.fixture
def ext(pw):
    with tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1400, "height": 900},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        serve_mock(ctx)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        inbox = ctx.pages[0] if ctx.pages else ctx.new_page()
        inbox.goto(INBOX_URL)
        inbox.wait_for_function("window.__mock && document.querySelectorAll('.row').length > 5")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 380, "height": 1100})
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
        panel.wait_for_selector("#where:has-text('Connected')")
        yield inbox, panel, sw
        ctx.close()


def test_extension_runs_a_campaign(ext):
    inbox, panel, _ = ext
    panel.fill("#tplText", "Hi {first_name}! Just following up po 😊")
    panel.set_input_files("#imgFile", str(TINY_PNG))
    panel.wait_for_selector("#imgRemove:not([hidden])")
    panel.click("#settingsBox summary")
    panel.fill("#sBetween", "0")
    panel.fill("#sStep", "0.3")
    panel.fill("#sCap", "5")
    panel.dispatch_event("#sCap", "change")

    panel.click("#tCheck")
    panel.wait_for_selector("#toolOut:has-text('Inbox list')")
    assert "✓ found (12 chats visible)" in panel.inner_text("#toolOut")

    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    sent = inbox.evaluate("__mock.sent")
    assert len(sent) == 5 and len({s["id"] for s in sent}) == 5
    assert all(s["images"] == ["promo.png"] and s["text"].startswith("Hi ") for s in sent)
    assert sent[0]["text"] == "Hi Gabriella! Just following up po 😊"
    assert panel.inner_text("#cSent") == "5"
    assert int(panel.inner_text("#cDone")) >= 2  # Lista Maison (can't message) + Facebook user
    assert "Daily limit" in panel.inner_text("#reason")
    SHOTS.mkdir(parents=True, exist_ok=True)
    panel.screenshot(path=str(SHOTS / "option-a-side-panel.png"), full_page=True)
    inbox.screenshot(path=str(SHOTS / "practice-inbox-after-run.png"))

    # Start again with the same campaign: the 5 already messaged are never repeated.
    panel.fill("#sCap", "8")
    panel.dispatch_event("#sCap", "change")
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    again = inbox.evaluate("__mock.sent")
    assert len(again) == 8 and len({s["id"] for s in again}) == 8


def test_scroll_button_pauses_and_shortcuts_work(ext):
    inbox, panel, sw = ext
    keys = panel.inner_text("#keys")
    assert "Start / Pause / Resume" in keys and "Scroll inbox" in keys

    # Scroll inbox to the bottom → Pause scrolling → Resume scrolling → done
    panel.click("#tLoad")
    panel.wait_for_selector("#tLoad:has-text('Pause scrolling')")
    inbox.wait_for_function("__mock.loaded > 12")
    panel.click("#tLoad")
    panel.wait_for_selector("#tLoad:has-text('Resume scrolling')")
    assert panel.is_disabled("#start")
    SHOTS.mkdir(parents=True, exist_ok=True)
    panel.locator("section.card").nth(2).screenshot(path=str(SHOTS / "option-a-scroll-paused.png"))
    panel.locator("section.card").nth(3).screenshot(path=str(SHOTS / "option-a-shortcuts.png"))
    held = inbox.evaluate("__mock.loaded")
    inbox.wait_for_timeout(2000)
    assert inbox.evaluate("__mock.loaded") == held
    panel.click("#tLoad")
    panel.wait_for_selector("#tLoad:has-text('Scroll inbox to the bottom')", timeout=60_000)
    assert "Reached the bottom" in panel.inner_text("#toolOut") and "(22 chats" in panel.inner_text("#toolOut")

    # Keyboard shortcuts (sent the same way Chrome sends them)
    panel.fill("#tplText", "Hi {first_name}!")
    panel.click("#settingsBox summary")
    panel.fill("#sBetween", "2")
    panel.dispatch_event("#sBetween", "change")
    panel.fill("#sStep", "0.3")
    panel.dispatch_event("#sStep", "change")
    shortcut = lambda name: sw.evaluate(f"handleCommand('{name}')")
    assert shortcut("toggle-run")["message"] == "Started"
    inbox.wait_for_function("__mock.sent.length >= 1", timeout=30_000)
    assert shortcut("toggle-run")["message"] == "Paused"
    panel.wait_for_selector("#pill.paused")
    assert "FollowUp: Paused" in inbox.inner_text("#fu-toast")
    n = inbox.evaluate("__mock.sent.length")
    inbox.wait_for_timeout(4000)
    assert inbox.evaluate("__mock.sent.length") <= n + 1  # at most the chat already in progress
    assert shortcut("toggle-run")["message"] == "Resumed"
    panel.wait_for_selector("#pill.running")
    assert shortcut("stop")["message"] == "Stopped"
    panel.wait_for_selector("#pill.stopped", timeout=30_000)
    assert shortcut("scroll-latest")["ok"] in (True, False)  # answers even with no chat open
    assert shortcut("toggle-scroll")["ok"]
    panel.wait_for_selector("#tLoad:has-text('Pause scrolling'), #tLoad:has-text('Scroll inbox to the bottom')")
    assert shortcut("stop")["message"] in ("Scrolling stopped", "Nothing to stop")
