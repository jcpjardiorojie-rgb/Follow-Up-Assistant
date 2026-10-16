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


def test_connects_by_itself_without_reloading_the_tab(pw):
    """The 'Not connected' case: the panel was opened first, and the inbox tab never got the
    extension loaded into it (www.facebook.com/latest has no automatic loading)."""
    with tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1400, "height": 900},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        try:
            from conftest import MOCK_HTML
            ctx.route("https://www.facebook.com/latest/**", lambda r: r.fulfill(
                status=200, content_type="text/html; charset=utf-8", body=MOCK_HTML))
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
            ext_id = sw.url.split("/")[2]
            panel = ctx.pages[0] if ctx.pages else ctx.new_page()
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            panel.wait_for_selector("#pill.offline")
            assert "Open Business Suite" in panel.inner_text("#where")

            inbox = ctx.new_page()
            inbox.goto("https://www.facebook.com/latest/inbox/all/?asset_id=1")
            inbox.wait_for_function("document.querySelectorAll('.row').length > 5")
            panel.wait_for_selector("#pill.idle", timeout=15_000)  # reconnected by itself
            assert "Connected" in panel.inner_text("#where")

            panel.click("#tCheck")
            panel.wait_for_selector("#toolOut:has-text('Inbox list')")
            assert "✓ found (12 chats visible)" in panel.inner_text("#toolOut")
            assert sw.evaluate("handleCommand('toggle-scroll')")["ok"]
        finally:
            ctx.close()


def test_inbox_link_opens_my_page_and_blocks_other_pages(ext):
    inbox, panel, sw = ext
    assert panel.inner_text("#pill") == "Ready"
    panel.fill("#tplText", "Hi {first_name}!")
    panel.fill("#inboxUrl", "facebook dot com")
    panel.dispatch_event("#inboxUrl", "change")
    assert "isn't a web link" in panel.inner_text("#inboxMsg")
    mine = "https://business.facebook.com/latest/inbox/all/?nav_ref=manage_page_ap_plus_inbox_message_button&asset_id=999&business_id="
    panel.fill("#inboxUrl", mine)
    panel.dispatch_event("#inboxUrl", "change")
    assert "id 999" in panel.inner_text("#inboxMsg")
    panel.screenshot(path=str(SHOTS / "option-a-inbox-link.png"), clip={"x": 0, "y": 0, "width": 380, "height": 300})

    # The open tab is Page 1, the saved link is Page 999: Start refuses
    panel.click("#start")
    panel.wait_for_selector("#reason:has-text('different Facebook Page')")
    assert inbox.evaluate("__mock.sent.length") == 0

    # "Open my inbox" opens the saved Page; then Start works there
    with panel.context.expect_page() as new_tab:
        panel.click("#openInbox")
    mine_tab = new_tab.value
    opened = sw.evaluate("chrome.tabs.query({}).then((ts) => ts.map((t) => t.pendingUrl || t.url))")
    assert mine in opened  # Chrome opened exactly the saved link
    # The test browser can't serve the practice inbox to a tab the extension opened itself,
    # so load it again (a real browser just shows your inbox).
    mine_tab.goto(mine)
    mine_tab.wait_for_function("window.__mock && document.querySelectorAll('.row').length > 5")
    panel.wait_for_selector("#pill.idle", timeout=15_000)
    panel.click("#settingsBox summary")
    panel.fill("#sCap", "1")
    panel.dispatch_event("#sCap", "change")
    panel.fill("#sStep", "0.3")
    panel.dispatch_event("#sStep", "change")
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=60_000)
    assert mine_tab.evaluate("__mock.sent.length") == 1 and inbox.evaluate("__mock.sent.length") == 0
