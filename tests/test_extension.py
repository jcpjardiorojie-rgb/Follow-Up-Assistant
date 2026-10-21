"""Option A end to end: install the real extension, open the practice inbox, drive the side panel."""
import pathlib
import tempfile

import pytest
from conftest import INBOX_URL, ROOT, TINY_PNG, serve_mock

EXT = str(ROOT / "extension")
SHOTS = ROOT / "docs" / "screenshots"


def _open_settings(panel):
    """Open Settings and all its sections (they fold since version 1.7.3)."""
    panel.evaluate("""() => { const b = document.getElementById('settingsBox'); b.open = true;
      b.querySelectorAll('details.sec').forEach((d) => { d.open = true; }); }""")



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
        panel._fu = {"profile": profile, "ext_id": ext_id}
        # quick tests: don't wait a minute at the bottom of the inbox
        panel.evaluate("() => { const el = document.getElementById('scPatience'); el.value = '0'; el.dispatchEvent(new Event('change')); }")
        yield inbox, panel, sw
        ctx.close()


def test_extension_runs_a_campaign(ext):
    inbox, panel, _ = ext
    panel.fill("#tplText", "Hi {first_name}! Just following up po 😊")
    panel.set_input_files("#imgFile", str(TINY_PNG))
    panel.wait_for_selector("#imgRemove:not([hidden])")
    _open_settings(panel)
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
    panel.locator("section.card").filter(has=panel.locator("#tLoad")).screenshot(path=str(SHOTS / "option-a-scroll-paused.png"))
    panel.locator("section.card").filter(has=panel.locator("#keys")).screenshot(path=str(SHOTS / "option-a-shortcuts.png"))
    held = inbox.evaluate("__mock.loaded")
    inbox.wait_for_timeout(2000)
    assert inbox.evaluate("__mock.loaded") == held
    panel.click("#tLoad")
    panel.wait_for_selector("#tLoad:has-text('Scroll inbox to the bottom')", timeout=60_000)
    assert "Reached the bottom" in panel.inner_text("#toolOut") and "(22 chats" in panel.inner_text("#toolOut")

    # Keyboard shortcuts (sent the same way Chrome sends them)
    panel.fill("#tplText", "Hi {first_name}!")
    _open_settings(panel)
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
    _open_settings(panel)
    panel.fill("#sCap", "1")
    panel.dispatch_event("#sCap", "change")
    panel.fill("#sStep", "0.3")
    panel.dispatch_event("#sStep", "change")
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=60_000)
    assert mine_tab.evaluate("__mock.sent.length") == 1 and inbox.evaluate("__mock.sent.length") == 0


def test_problems_tab_explains_what_happened_and_how_to_fix(ext):
    inbox, panel, _ = ext
    assert "by Rojie Jardio" in panel.inner_text("h1")
    assert panel.inner_text("#probCount") == "" or panel.is_hidden("#probCount")
    inbox.evaluate("__mock.flags.sendFails = true")
    panel.fill("#tplText", "Hi {first_name}!")
    _open_settings(panel)
    panel.fill("#sBetween", "0")
    panel.dispatch_event("#sBetween", "change")
    panel.fill("#sStep", "0.3")
    panel.dispatch_event("#sStep", "change")
    panel.click("#start")
    panel.wait_for_selector("#pill.paused", timeout=120_000)
    assert "How to fix:" in panel.inner_text("#reason")
    assert panel.is_visible("#seeProblems") and panel.inner_text("#probCount") == "3"
    panel.click("#seeProblems")
    panel.wait_for_selector("#problemsView:not([hidden])")
    items = panel.locator("#problems li")
    assert items.count() == 3
    text = items.first.inner_text().lower()
    assert "what happened:" in text and "why:" in text and "how to fix:" in text and "seconds between chats" in text
    panel.screenshot(path=str(SHOTS / "option-a-problems-tab.png"), clip={"x": 0, "y": 0, "width": 380, "height": 560})
    panel.click("#tabMain")
    panel.wait_for_selector("#mainView:not([hidden])")
    panel.click("#stop")


def test_saved_messages_buyers_and_hot_lead_label(ext):
    inbox, panel, _ = ext
    # Two saved messages; send with the second one
    panel.fill("#tplText", "Hi {first_name}! First message")
    panel.click("#tplNew")
    panel.fill("#tplName", "Promo Oct")
    panel.fill("#tplText", "Hi {first_name}! Promo ends Friday")
    assert panel.locator("#tplSelect option").all_inner_texts() == ["Message 1", "Promo Oct"]
    _open_settings(panel)
    for sel, val in (("#sBetween", "0"), ("#sStep", "0.3"), ("#sCap", "3")):
        panel.fill(sel, val)
        panel.dispatch_event(sel, "change")
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    sent = inbox.evaluate("__mock.sent")
    assert [s["text"].split("!")[1].strip() for s in sent] == ["Promo ends Friday"] * 3
    assert "Sent 3" in panel.inner_text("#tplStats")

    # Three people write back
    inbox.evaluate("""(ids) => { __mock.reply(ids[0], 'Magkano po?'); __mock.reply(ids[1], 'pa send po details');
                                 __mock.reply(ids[2], 'Not interested'); }""", [s["id"] for s in sent])
    panel.click("#tabBuyers")
    assert panel.is_checked("#bAuto") and panel.input_value("#bLabelName") == "Hot lead"
    panel.click("#bCheck")
    panel.wait_for_selector("#bStatus:has-text('replies')", timeout=60_000)
    panel.wait_for_selector("#bCheck:not([disabled])", timeout=90_000)
    assert "Labeled 1 hot lead" in panel.inner_text("#bStatus"), panel.inner_text("#bStatus")
    assert [panel.inner_text(s) for s in ("#bHot", "#bWarm", "#bReplied", "#bCold")] == ["1", "1", "0", "1"]
    assert panel.inner_text("#hotCount") == "1"
    leads = panel.locator("#leads li")
    assert leads.count() == 3
    first = leads.first.inner_text()
    assert sent[0]["name"] in first and "HOT" in first and "Magkano po?" in first and "Promo Oct" in first
    assert "Labeled “Hot lead”" in first
    assert inbox.evaluate("__mock.labeled") == [{"id": sent[0]["id"], "label": "Hot lead"}]
    panel.screenshot(path=str(SHOTS / "option-a-buyers-tab.png"), clip={"x": 0, "y": 0, "width": 380, "height": 900})

    # Open chat jumps to that person in Business Suite
    leads.nth(1).locator("button").click()
    panel.wait_for_selector("#bStatus:has-text('Opened')", timeout=30_000)
    assert inbox.evaluate("__mock.selected.name") == sent[1]["name"]

    # Per-message numbers on the Main tab
    panel.click("#tabMain")
    assert "Replied 3 (100%)" in panel.inner_text("#tplStats") and "Hot 1" in panel.inner_text("#tplStats")
    panel.locator("section.card").filter(has=panel.locator("#tplSelect")).screenshot(path=str(SHOTS / "option-a-saved-messages.png"))


def test_tools_work_while_running_or_paused(ext):
    inbox, panel, _ = ext
    panel.fill("#tplText", "Hi {first_name}!")
    _open_settings(panel)
    for sel, val in (("#sBetween", "20"), ("#sStep", "0.3")):
        panel.fill(sel, val)
        panel.dispatch_event(sel, "change")
    panel.click("#start")
    inbox.wait_for_function("__mock.sent.length >= 1", timeout=60_000)
    # All tools are clickable while running
    assert not panel.is_disabled("#tLoad") and not panel.is_disabled("#tLatest") and not panel.is_disabled("#tCheck")
    panel.click("#tCheck")
    panel.wait_for_selector("#toolOut:has-text('Inbox list')")
    # Scrolling the inbox pauses the run first, then scrolls
    inbox.evaluate("__mock.flags.sticky = true")  # slow, stop-and-go loading like the real inbox
    panel.click("#tLoad")
    panel.wait_for_selector("#pill.paused", timeout=30_000)
    panel.wait_for_selector("#tLoad:has-text('Pause scrolling')", timeout=30_000)
    # Resume waits until scrolling is paused or stopped
    panel.click("#pause")
    panel.wait_for_selector("#reason:has-text('still scrolling')")
    assert panel.inner_text("#pill") == "Paused"
    panel.wait_for_selector("#tLoad:has-text('Scroll inbox to the bottom')", timeout=60_000)  # scrolling finished
    panel.click("#pause")  # Resume
    panel.wait_for_selector("#pill.running", timeout=10_000)
    panel.click("#stop")
    panel.wait_for_selector("#pill.stopped", timeout=60_000)


def _quick_run_settings(panel, cap):
    panel.fill("#tplText", "Hi {first_name}!")
    _open_settings(panel)
    for sel, val in (("#sBetween", "0"), ("#sStep", "0.3"), ("#sCap", str(cap)), ("#fiSecs", "10")):
        panel.fill(sel, val)
        panel.dispatch_event(sel, "change")


def test_scroll_settings_and_when_finished_countdown(ext):
    inbox, panel, sw = ext
    _open_settings(panel)
    panel.check("input[name=whenFinished][value=shutdown]")
    assert panel.input_value("#fiSecs") == "60"
    panel.locator("#finishBox").screenshot(path=str(SHOTS / "option-a-when-finished.png"))
    _quick_run_settings(panel, 2)
    # Scrolling settings: only the box that fits the choice is shown
    assert panel.input_value("#scHow") == "count" and panel.input_value("#scCount") == "25"
    assert panel.is_visible("#scCount") and not panel.is_visible("#scChats")
    panel.select_option("#scHow", "chats")
    assert panel.is_visible("#scChats") and not panel.is_visible("#scCount")
    panel.select_option("#scHow", "count")
    panel.locator("#scrollBox").screenshot(path=str(SHOTS / "option-a-scroll-settings.png"))

    # Countdown after a normal finish; Cancel stops it (these runs end by the Daily limit, so allow that ending)
    panel.check("#foDaily")
    panel.check("input[name=whenFinished][value=closeTab]")
    panel.click("#start")
    inbox.wait_for_selector("#fu-finish", timeout=120_000)
    panel.wait_for_selector("#finishBar:not([hidden])")
    assert "close the Business Suite tab" in inbox.inner_text("#fu-finish")
    inbox.screenshot(path=str(SHOTS / "option-a-finish-countdown.png"))
    panel.click("#finishCancel")
    inbox.wait_for_selector("#fu-finish", state="detached")
    panel.wait_for_selector("#finishBar[hidden]", state="attached")
    assert "Cancelled" in panel.inner_text("#reason")

    # Shut down without the Windows helper: nothing breaks, the Problems tab explains the fix
    panel.check("input[name=whenFinished][value=shutdown]")
    panel.fill("#sCap", "3")
    panel.dispatch_event("#sCap", "change")
    panel.click("#start")
    inbox.wait_for_selector("#fu-finish", timeout=120_000)
    inbox.click("#fu-finish-now")
    panel.wait_for_selector("#reason:has-text('couldn')", timeout=10_000)
    panel.click("#tabProblems")
    assert "Setup-FollowUp.bat" in panel.inner_text("#problems")
    panel.click("#tabMain")
    panel.click("#fiCheck")
    panel.wait_for_selector("#fiStatus:has-text('Not installed')")

    # Close the tab: "Do it now" closes the Business Suite tab
    panel.check("input[name=whenFinished][value=closeTab]")
    panel.fill("#sCap", "4")
    panel.dispatch_event("#sCap", "change")
    panel.click("#start")
    inbox.wait_for_selector("#fu-finish", timeout=120_000)
    with inbox.expect_event("close", timeout=10_000):
        inbox.click("#fu-finish-now")


FAKE_HOST = r'''#!/usr/bin/env python3
import json, os, struct, sys
n = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
msg = json.loads(sys.stdin.buffer.read(n))
with open(LOG, "a") as f:
    f.write(json.dumps({k: v for k, v in msg.items() if k != "content"}) + "\n")
a = msg.get("action")
out = {"ok": True}
if a == "ping":
    out["version"] = "1.2"
elif a in ("saveFile", "appendFile", "readFile"):
    os.makedirs(msg["folder"], exist_ok=True)
    path = os.path.join(msg["folder"], msg["name"])
    if a == "saveFile":
        open(path, "w", encoding="utf-8-sig", newline="").write(msg["content"])
    elif a == "appendFile":
        if not os.path.exists(path) and msg.get("header"):
            open(path, "w", encoding="utf-8-sig", newline="").write(msg["header"])
        open(path, "a", encoding="utf-8", newline="").write(msg["content"])
    else:
        text = open(path, encoding="utf-8-sig").read() if os.path.exists(path) else ""
        off = int(msg.get("offset") or 0)
        out.update(content=text[off:off + 300000], more=off + 300000 < len(text))
data = json.dumps(out).encode()
sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
sys.stdout.buffer.flush()
'''


def install_fake_host(profile, ext_id, tools):
    import json
    import sys
    log = pathlib.Path(tools) / "calls.log"
    host = pathlib.Path(tools) / "host.py"
    host.write_text(f"#!{sys.executable}\nLOG = {str(log)!r}\n" + FAKE_HOST.split("\n", 1)[1])
    host.chmod(0o755)
    hosts = pathlib.Path(profile) / "NativeMessagingHosts"
    hosts.mkdir(exist_ok=True)
    (hosts / "com.rojie.followup_copilot.json").write_text(json.dumps({
        "name": "com.rojie.followup_copilot", "description": "test", "path": str(host),
        "type": "stdio", "allowed_origins": [f"chrome-extension://{ext_id}/"]}))
    return log


def test_shutdown_helper_is_called_when_installed(pw):
    import json
    with tempfile.TemporaryDirectory() as profile, tempfile.TemporaryDirectory() as tools:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        log = install_fake_host(profile, ext_id, tools)
        panel = ctx.new_page()
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
        _open_settings(panel)
        panel.click("#fiCheck")
        panel.wait_for_selector("#fiStatus:has-text('installed')", timeout=15_000)
        assert "✓" in panel.inner_text("#fiStatus")
        r = sw.evaluate("finishAction('shutdown')")
        assert r == {"ok": True}
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        assert calls[0] == {"action": "ping"}
        assert calls[1] == {"action": "shutdown", "delaySec": 10}
        try:
            ctx.close()
        except Exception:
            pass  # the extension closes Chrome itself after asking for the shutdown


def _set(panel, sel, val):
    panel.fill(sel, str(val))
    panel.dispatch_event(sel, "change")


def test_already_messaged_stop_notifies_and_saves_names_to_a_folder(ext):
    inbox, panel, sw = ext
    with tempfile.TemporaryDirectory() as tools:
        install_fake_host(panel._fu["profile"], panel._fu["ext_id"], tools)
        folder = str(pathlib.Path(tools) / "FollowUp-History")
        sw.evaluate("() => { self.__notes = []; chrome.notifications.create = async (id, o) => { self.__notes.push(o); return id; }; }")
        _quick_run_settings(panel, 3)
        # Defaults the user chose
        # Off by default: works exactly like 1.6.0, and the stop options are hidden
        assert not panel.is_checked("#dCheck") and panel.is_visible("#dOffNote") and not panel.is_visible("#dAfter")
        panel.check("#dCheck")
        assert panel.is_checked("input[name=stopBy][value=both]")
        assert panel.input_value("#dAfter") == "3" and panel.input_value("#bkFolder") == "D:\\FollowUp-History"
        assert panel.is_checked("#nPC") and not panel.is_checked("#nPhone")
        panel.locator("#dupBox").screenshot(path=str(SHOTS / "option-a-already-messaged.png"))
        panel.locator("#notifyBox").screenshot(path=str(SHOTS / "option-a-notify.png"))
        panel.check("input[name=stopBy][value=message]")
        _set(panel, "#bkFolder", folder)

        panel.click("#start")
        panel.wait_for_selector("#pill.finished", timeout=120_000)
        sent = [s["name"] for s in inbox.evaluate("__mock.sent")]
        assert len(sent) == 3
        # Names were saved to the folder, and the run was written to runs.csv
        panel.wait_for_selector("#bkStatus:has-text('3 names')", timeout=15_000)
        csv = (pathlib.Path(folder) / "Message 1.csv").read_text(encoding="utf-8-sig")
        assert csv.startswith("Name,Sent at") and all(n in csv for n in sent)
        runs = pathlib.Path(folder) / "runs.csv"
        panel.wait_for_timeout(1500)
        assert "Daily limit" in runs.read_text(encoding="utf-8-sig")
        # PC notification when finished
        notes = sw.evaluate("self.__notes")
        assert notes and notes[-1]["title"] == "FollowUp finished" and "3 sent today" in notes[-1]["message"]

        # New campaign + higher limit: it reaches the 3 chats that already have the message and stops.
        panel.click("#newCampaign")
        panel.click("#confirmYes")
        _set(panel, "#sCap", 20)
        panel.click("#start")
        panel.wait_for_selector("#reason:has-text('3 chats in a row already had this message')", timeout=120_000)
        assert panel.inner_text("#pill") == "Finished"
        assert len(inbox.evaluate("__mock.sent")) == 3  # nothing sent twice
        assert panel.locator("#log .st.ALREADY").count() == 3
        assert "already had this message" in sw.evaluate("self.__notes")[-1]["message"]
        panel.locator("section.card.run").screenshot(path=str(SHOTS / "option-a-stopped-already.png"))

        # Phone notification goes to the ntfy topic
        calls = sw.evaluate("""async () => {
          const calls = [];
          self.fetch = async (u, o) => { calls.push([u, o.body, o.headers.Title]); return new Response("{}"); };
          await notifyAll({ title: "FollowUp finished", message: "12 sent", phone: true, topic: "rojie-test", server: "https://ntfy.sh" });
          return calls;
        }""")
        assert calls == [["https://ntfy.sh/rojie-test", "12 sent", "FollowUp finished"]]


def test_names_come_back_from_the_folder_after_chrome_forgets_them(ext):
    inbox, panel, sw = ext
    with tempfile.TemporaryDirectory() as tools:
        install_fake_host(panel._fu["profile"], panel._fu["ext_id"], tools)
        folder = pathlib.Path(tools) / "FollowUp-History"
        folder.mkdir()
        names = [inbox.evaluate("(i) => __mock.convs[i].name", i) for i in (2, 4, 5)]  # Gabriella, Beroro, ROBIN: the first 3 that can be messaged
        (folder / "Message 1.csv").write_text("Name,Sent at\r\n" + "".join(f'"{n}","2026-10-01"\r\n' for n in names), encoding="utf-8-sig")
        _quick_run_settings(panel, 20)
        panel.check("#dCheck")
        panel.check("input[name=stopBy][value=name]")
        _set(panel, "#bkFolder", str(folder))
        panel.click("#start")
        panel.wait_for_selector("#pill.finished", timeout=120_000)
        assert "3 chats in a row" in panel.inner_text("#reason")
        assert inbox.evaluate("__mock.sent") == []


def test_auto_replies_ask_first_then_automatic(ext):
    inbox, panel, sw = ext
    _quick_run_settings(panel, 3)
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    sent = inbox.evaluate("__mock.sent")
    inbox.evaluate("([a, b]) => { __mock.reply(a, 'Magkano po?'); __mock.reply(b, 'pa send details'); }", [sent[0]["id"], sent[1]["id"]])

    panel.click("#tabBuyers")
    assert panel.is_checked("input[name=replyMode][value=ask]")
    assert panel.is_checked("#rOn_hot") and panel.is_checked("#rOn_warm") and not panel.is_checked("#rOn_cold")
    panel.click("#bCheck")
    panel.wait_for_selector("#pendingBox:not([hidden])", timeout=60_000)
    assert panel.inner_text("#pCount") == "2"
    assert "Here's our price list" in panel.inner_text("#pending")
    panel.wait_for_selector("#bStatus:has-text('ready')", timeout=30_000)
    panel.wait_for_selector("#rSendAll:enabled")
    panel.locator("#replyCard").screenshot(path=str(SHOTS / "option-a-auto-replies.png"))
    assert len(inbox.evaluate("__mock.sent")) == 3  # nothing sent before you press Send all

    # Skip the warm one, send the hot one
    panel.locator("#pending li.warm button:has-text('Skip')").click()
    panel.wait_for_selector("#pCount:text-is('1')")
    panel.click("#rSendAll")
    inbox.wait_for_function("__mock.sent.length === 4", timeout=60_000)
    last = inbox.evaluate("__mock.sent[3]")
    assert last["id"] == sent[0]["id"] and "price list" in last["text"]
    panel.wait_for_selector("#pendingBox[hidden]", state="attached", timeout=30_000)

    # Automatic: a new reply gets its answer right after Check replies
    panel.check("input[name=replyMode][value=auto]")
    inbox.evaluate("(a) => __mock.reply(a, 'how much po')", sent[2]["id"])
    panel.click("#bCheck")
    inbox.wait_for_function("__mock.sent.length === 5", timeout=60_000)
    assert inbox.evaluate("__mock.sent[4].id") == sent[2]["id"]
    panel.click("#tabMain")
    panel.wait_for_selector("#log .st.REPLY")
    # Checking again sends nothing more (nobody gets a reply twice)
    panel.click("#tabBuyers")
    panel.click("#bCheck")
    panel.wait_for_selector("#bStatus:has-text('Read')", timeout=60_000)
    assert len(inbox.evaluate("__mock.sent")) == 5


def test_replies_in_the_middle_of_a_run(ext):
    inbox, panel, _ = ext
    _quick_run_settings(panel, 2)
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    first = inbox.evaluate("__mock.sent[0].id")
    inbox.evaluate("(a) => __mock.reply(a, 'magkano')", first)
    _set(panel, "#sCap", 6)
    _set(panel, "#sBetween", 6)
    panel.click("#tabBuyers")
    panel.check("input[name=replyMode][value=auto]")
    panel.click("#tabMain")
    panel.click("#start")
    inbox.wait_for_function("__mock.sent.length >= 3", timeout=60_000)
    panel.click("#tabBuyers")
    panel.click("#bCheck")  # the run pauses after its chat, the reply goes out, then the run continues
    inbox.wait_for_function(f"__mock.sent.some((s, i) => i >= 2 && s.id === '{first}')", timeout=90_000)
    panel.click("#tabMain")
    panel.wait_for_selector("#pill.running, #pill.finished", timeout=30_000)
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    ids = [s["id"] for s in inbox.evaluate("__mock.sent")]
    assert ids.count(first) == 2 and len(ids) == 7  # 6 follow-ups (2 + 4 more) + 1 reply


def test_settings_fold_into_sections_with_summaries_and_reset(ext):
    _, panel, _ = ext
    panel.click("#settingsBox > summary")
    secs = panel.locator("details.sec")
    assert secs.count() == 7
    # First time: only "Start & limits" is open; every section shows its values on one line
    assert panel.evaluate("[...document.querySelectorAll('details.sec')].map(d => d.open)") == [True] + [False] * 6
    assert panel.inner_text("#sum_start") == "Top · 300/day · 8 s"
    assert panel.inner_text("#sum_scroll") == "25 scrolls · 1.5 s · 2 retries · waits 0 s at the bottom"
    assert panel.inner_text("#sum_who") == "Last message mine · Already messaged: Off"
    assert panel.inner_text("#sum_helper") == "D:\\FollowUp-History"
    panel.locator("#settingsBox").screenshot(path=str(SHOTS / "option-a-settings-sections.png"))
    # Changing a setting updates its summary
    panel.click("details.sec[data-sec=scroll] > summary")
    panel.fill("#scCount", "40")
    panel.dispatch_event("#scCount", "change")
    assert panel.inner_text("#sum_scroll").startswith("40 scrolls")
    panel.locator("details.sec[data-sec=scroll]").screenshot(path=str(SHOTS / "option-a-settings-open-section.png"))
    # Reset this section puts the defaults back (after you confirm)
    panel.click("details.sec[data-sec=scroll] button.reset")
    panel.click("#confirmYes")
    assert panel.input_value("#scCount") == "25" and panel.inner_text("#sum_scroll").startswith("25 scrolls")
    # Open sections are remembered next time the panel opens
    panel.wait_for_timeout(300)
    panel.reload()
    panel.wait_for_function("document.querySelector('details.sec[data-sec=scroll]').open === true")
    assert panel.evaluate("document.querySelector('details.sec[data-sec=start]').open")


def test_log_tab_last_runs_keep_awake_and_which_endings_shut_down(ext):
    inbox, panel, sw = ext
    sw.evaluate("""() => { self.__awake = [];
      chrome.power.requestKeepAwake = (l) => self.__awake.push('on:' + l);
      chrome.power.releaseKeepAwake = () => self.__awake.push('off'); }""")
    _quick_run_settings(panel, 3)
    # Defaults: keep awake on; "When finished" only for already-messaged and no-more-chats endings
    assert panel.is_checked("#sAwake") and panel.is_checked("#foAlready") and panel.is_checked("#foEnd") and not panel.is_checked("#foDaily")
    panel.check("input[name=whenFinished][value=closeTab]")
    panel.locator("#finishOnBox").screenshot(path=str(SHOTS / "option-a-finish-only-when.png"))
    panel.click("#start")
    panel.wait_for_selector("#pill.finished", timeout=120_000)
    # Ended by the Daily limit, which isn't allowed to close the tab: no countdown
    inbox.wait_for_timeout(1500)
    assert inbox.locator("#fu-finish").count() == 0
    assert sw.evaluate("self.__awake")[0] == "on:display" and sw.evaluate("self.__awake")[-1] == "off"
    panel.click("#tabLog")
    panel.wait_for_selector("#diary li .k.FINISH", timeout=10_000)
    log = panel.inner_text("#diary")
    assert "Started · Message" in log and "Daily limit 3" in log
    assert "Ended: Daily limit of 3 reached · 3 sent" in log
    assert "Not doing “Close the tab”" in log and "Keeping the PC awake" in log
    runs = panel.inner_text("#runs")
    assert "3 sent" in runs and "Ended: Daily limit of 3 reached" in runs and "Then: Nothing" in runs
    panel.locator("#logView").screenshot(path=str(SHOTS / "option-a-log-tab.png"))
    # Copy for Claude puts the last run on the clipboard
    panel.context.grant_permissions(["clipboard-read", "clipboard-write"])
    panel.click("#dCopy")
    panel.wait_for_selector("#dStatus:has-text('Copied')")
    assert "Ended: Daily limit of 3 reached" in panel.evaluate("navigator.clipboard.readText()")


def test_version_shows_above_the_status(ext):
    _, panel, _ = ext
    import json, pathlib
    want = json.loads((pathlib.Path(__file__).parent.parent / "extension" / "manifest.json").read_text())["version"]
    assert panel.text_content("#ver") == "v" + want
    ver, pill = panel.locator("#ver").bounding_box(), panel.locator("#pill").bounding_box()
    assert ver["y"] + ver["height"] <= pill["y"] + 1
