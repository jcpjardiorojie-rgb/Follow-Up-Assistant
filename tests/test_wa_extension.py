"""FollowUp for WhatsApp, end to end: the real extension on a practice copy of WhatsApp Web."""
import base64
import pathlib
import tempfile

import pytest

from conftest import TINY_PNG
from test_wa_engine import WA_URL, serve_wa

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = str(ROOT / "whatsapp-extension")
SHOTS = ROOT / "docs" / "screenshots"


@pytest.fixture
def wa_ext(pw):
    with tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1400, "height": 900},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        serve_wa(ctx)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        wa = ctx.pages[0] if ctx.pages else ctx.new_page()
        wa.goto(WA_URL)
        wa.wait_for_function("window.__mock && document.querySelectorAll('[role=listitem]').length > 5")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 380, "height": 1100})
        panel.on("dialog", lambda d: d.accept())
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
        panel.wait_for_selector("#where:has-text('Connected')")
        # quick tests: no long waits between chats
        panel.evaluate("""async () => { const { settings = {} } = await chrome.storage.local.get('settings');
          await chrome.storage.local.set({ settings: Object.assign({}, WAEngine.DEFAULTS, settings, { gapMinSec: 0, gapMaxSec: 0, stepDelayMs: 300, bottomWaitSec: 0, scrollWaitSec: 0.6 }) }); }""")
        panel.reload()
        panel.wait_for_selector("#where:has-text('Connected')")
        panel._fu = {"profile": profile, "ext_id": ext_id, "sw": sw}
        yield wa, panel
        ctx.close()


def tab(panel, name):
    panel.click(f".tabs button[data-tab={name}]")
    if name == "settings":
        panel.evaluate("() => document.querySelectorAll('details.sec').forEach((d) => { d.open = true; })")


def set_val(panel, sel, value):
    panel.fill(sel, str(value))
    panel.dispatch_event(sel, "change")


def sent(wa):
    return wa.evaluate("__mock.sent")


def test_defaults_preview_and_names(wa_ext):
    wa, panel = wa_ext
    panel.fill("#text", "Hi {first_name}! May promo po kami.")
    panel.dispatch_event("#text", "input")
    assert panel.text_content("#pv1") == "Hi Joy! May promo po kami."
    assert panel.text_content("#pv2") == "Hi po! May promo po kami."
    tab(panel, "settings")
    set_val(panel, "#sWord", "Ma'am/Sir")
    assert panel.text_content("#pv2") == "Hi Ma'am/Sir! May promo po kami."
    panel.check("#sTilde"); panel.dispatch_event("#sTilde", "change")
    assert panel.text_content("#pv2") == "Hi Mark! May promo po kami."
    # defaults: warm-up plan, day 1 → 50
    assert panel.is_checked("input[name=limitMode][value=ramp]")
    assert "day 1 → 50 today" in panel.text_content("#planNow")
    assert panel.text_content("#todayText") == "Today: 0 of 50 sent"
    assert panel.text_content("#ver").startswith("v2.")


def test_run_with_image_daily_plan_and_today_only(wa_ext):
    wa, panel = wa_ext
    panel.fill("#text", "Hi {first_name}! New promo po 😊")
    panel.dispatch_event("#text", "input")
    panel.set_input_files("#imgFile", str(TINY_PNG))
    panel.wait_for_selector("#imgRemove:visible")
    tab(panel, "settings")
    set_val(panel, "#r0", 3)
    panel.click("#start")
    panel.wait_for_selector("#pill:has-text('Finished')", timeout=60000)
    assert "Today's limit reached" in panel.text_content("#reason")
    s = sent(wa)
    assert len(s) == 3 and all(x["image"] for x in s) and s[0]["text"] == "Hi Joy! New promo po 😊"
    assert s[1]["text"].startswith("Hi po!")
    assert panel.text_content("#todayText") == "Today: 3 of 3 sent"
    # Start again: today's limit is reached
    panel.click("#start")
    panel.wait_for_selector("#reason:has-text('limit (3) is reached')")
    # Today only: 5 → two more, and not the same people again
    set_val(panel, "#sToday", 5)
    panel.wait_for_selector("#todayText:has-text('3 of 5')")
    panel.click("#start")
    panel.wait_for_selector("#pill:has-text('Finished')", timeout=60000)
    names = [x["name"] for x in sent(wa)]
    assert len(names) == len(set(names)) == 5
    assert panel.text_content("#todayText") == "Today: 5 of 5 sent"
    tab(panel, "activity")
    panel.wait_for_selector("#log li .st.SENT")
    assert "image with the message" in panel.text_content("#log")
    tab(panel, "settings")
    assert "5 people already got it" in panel.text_content("#campaignInfo")
    panel.click("#newCampaign")
    panel.wait_for_selector("#campaignInfo:has-text('0 people')")


def test_test_mode_check_page_and_problems(wa_ext):
    wa, panel = wa_ext
    panel.click("#check")
    panel.wait_for_selector("#checkOut:has-text('Chat list:')")
    out = panel.text_content("#checkOut")
    assert "✓ found" in out and "Joy Santos" in out and '"Hi Joy!"' in out and '"Hi po!"' in out
    tab(panel, "settings")
    panel.check("#sTest"); panel.dispatch_event("#sTest", "change")
    set_val(panel, "#r0", 2)
    panel.click("#start")
    panel.wait_for_function("() => document.querySelectorAll('#log li').length >= 0", timeout=1000)
    wa.wait_for_timeout(6000)
    panel.click("#stop")
    panel.wait_for_selector("#pill:has-text('Stopped')", timeout=20000)
    assert sent(wa) == []
    tab(panel, "activity")
    panel.wait_for_selector("#log li .st.TEST")
    # A problem shows in the Problems tab with what/why/fix
    tab(panel, "settings")
    panel.uncheck("#sTest"); panel.dispatch_event("#sTest", "change")
    wa.evaluate("__mock.flags.stuckAll = true")
    panel.click("#start")
    panel.wait_for_selector("#pill:has-text('Paused')", timeout=60000)
    assert "3 problems in a row" in panel.text_content("#reason")
    tab(panel, "problems")
    panel.wait_for_selector("#problems li.prob")
    t = panel.text_content("#problems")
    assert "What happened" in t and "How to fix" in t
    panel.click("#stop")


FAKE_HIDDEN = """async (on) => {
  const [t] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  await chrome.scripting.executeScript({ target: { tabId: t.id }, args: [on], func: (on) => {
    if (!window.__fakeHiddenSet) { Object.defineProperty(document, "hidden", { configurable: true, get: () => !!window.__fakeHidden }); window.__fakeHiddenSet = true; }
    window.__fakeHidden = on; document.dispatchEvent(new Event("visibilitychange"));
  } });
}"""
WA_ACTIVE = """async () => (await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }))[0].active"""


def test_waits_while_hidden_and_shows_why(wa_ext):
    wa, panel = wa_ext
    tab(panel, "settings")
    panel.uncheck("#sFront"); panel.dispatch_event("#sFront", "change")
    panel.evaluate(FAKE_HIDDEN, True)
    panel.click("#start")
    panel.wait_for_selector("#hiddenBox:visible", timeout=15000)
    assert "isn't the tab showing" in panel.text_content("#hiddenWhy")
    panel.click("#hShow")
    assert panel.evaluate(WA_ACTIVE)
    panel.evaluate(FAKE_HIDDEN, False)
    panel.wait_for_selector("#hiddenBox", state="hidden", timeout=5000)
    wa.wait_for_function("__mock.sent.length >= 1", timeout=30000)
    panel.click("#stop")


def test_bring_to_front_on_start(wa_ext):
    wa, panel = wa_ext
    panel.bring_to_front()
    assert not panel.evaluate(WA_ACTIVE)
    panel.click("#start")
    panel.wait_for_function(WA_ACTIVE, timeout=5000)
    panel.click("#stop")


def test_scroll_button_how_far_pause_resume_stop(wa_ext):
    wa, panel = wa_ext
    wa.goto(WA_URL + "?extra=60")
    wa.wait_for_function("window.__mock && document.querySelectorAll('[role=listitem]').length > 5")
    wa.evaluate("__mock.flags.lazy = true")
    panel.reload(); panel.wait_for_selector("#where:has-text('Connected')")
    # How far: 3 scrolls
    tab(panel, "settings")
    panel.check("input[name=scrollHow][value=count]"); panel.dispatch_event("input[name=scrollHow][value=count]", "change")
    set_val(panel, "#scCount", 3)
    panel.click("#scroll")
    panel.wait_for_selector("#checkOut:has-text('Scrolled 3 times')", timeout=30000)
    assert panel.text_content("#scroll") == "Scroll chat list to the bottom"
    # All the way, with Pause / Resume / Stop
    panel.check("input[name=scrollHow][value=all]"); panel.dispatch_event("input[name=scrollHow][value=all]", "change")
    set_val(panel, "#scWait", 1.5)
    panel.click("#scroll")
    panel.wait_for_selector("#scroll:has-text('Pause scrolling')")
    assert panel.is_disabled("#start")
    panel.click("#scroll")
    panel.wait_for_selector("#scroll:has-text('Resume scrolling')")
    panel.click("#scroll")
    panel.wait_for_selector("#scroll:has-text('Pause scrolling')")
    panel.click("#scrollStop")
    panel.wait_for_selector("#checkOut:has-text('Scrolling stopped')", timeout=15000)
    assert panel.is_hidden("#scrollBar") and panel.is_enabled("#start")
    # All the way to the end
    panel.click("#scroll")
    panel.wait_for_selector("#checkOut:has-text('Reached the bottom of your chats')", timeout=60000)
    assert wa.evaluate("__mock.loaded") >= 78



# ---------- 2.0 ----------
from test_extension import install_fake_host  # noqa: E402


def quick_run(panel, n, text="Hi {first_name}! New promo po 😊"):
    tab(panel, "main")
    panel.fill("#text", text); panel.dispatch_event("#text", "input")
    tab(panel, "settings")
    set_val(panel, "#r0", n)
    panel.click("#start")
    panel.wait_for_selector("#pill:has-text('Finished')", timeout=60000)


def test_buyers_ask_first_then_send(wa_ext):
    wa, panel = wa_ext
    quick_run(panel, 2)
    names = [x["name"] for x in sent(wa)]
    wa.evaluate("(n) => __mock.reply(n, 'Magkano po?')", names[0])
    wa.evaluate("(n) => __mock.reply(n, 'Not interested po')", names[1])
    tab(panel, "buyers")
    panel.click("#bCheck")
    panel.wait_for_selector("#bMsg:has-text('2 replies')", timeout=60000)
    panel.wait_for_selector("#pendingBox:visible")
    assert len(sent(wa)) == 2  # ask first: nothing sent yet
    assert "🔥 Hot" in panel.text_content("#buyers") and "❄️ Not interested" in panel.text_content("#buyers")
    panel.click("#pending .primary")
    panel.wait_for_selector("#bMsg:has-text('1 replies sent')", timeout=60000)
    last = sent(wa)[-1]
    assert last["name"] == names[0] and last["text"].startswith("Hi Joy! 😊 Thank you for your message po!")
    panel.wait_for_selector("#pendingBox", state="hidden")
    assert "answered ✓" in panel.text_content("#buyers")
    assert panel.text_content("#cReplies") == "1"
    assert panel.text_content("#hotCount") == "1"


def test_buyers_automatic_with_label(wa_ext):
    wa, panel = wa_ext
    tab(panel, "settings")
    panel.check("input[name=replyMode][value=auto]"); panel.dispatch_event("input[name=replyMode][value=auto]", "change")
    panel.check("#bLabelOn"); panel.dispatch_event("#bLabelOn", "change")
    quick_run(panel, 1)
    wa.evaluate("__mock.reply('Joy Santos', 'how much po')")
    tab(panel, "buyers")
    panel.click("#bCheck")
    panel.wait_for_selector("#bMsg:has-text('1 answered')", timeout=60000)
    assert sent(wa)[-1]["text"].startswith("Hi Joy! 😊 Thank you")
    assert wa.evaluate("__mock.labeled") == [{"name": "Joy Santos", "label": "Hot lead"}]
    assert "🏷" in panel.text_content("#buyers")


def test_log_tab_counters_and_export(wa_ext):
    wa, panel = wa_ext
    quick_run(panel, 2)
    assert panel.text_content("#cSent") == "2"
    tab(panel, "log")
    panel.wait_for_selector("#runs li .st:has-text('ENDED')")
    runs = panel.text_content("#runs")
    assert "2 sent" in runs and "Today's limit reached" in runs
    d = panel.text_content("#diary")
    assert "RUN" in d and "FINISH" in d and "account “WhatsApp”" in d
    panel.select_option("#dFilter", "runs")
    panel.wait_for_timeout(500)
    assert "AWAKE" not in panel.text_content("#diary")
    tab(panel, "activity")
    with panel.expect_download() as dl:
        panel.click("#logExport")
    csv = pathlib.Path(dl.value.path()).read_text(encoding="utf-8-sig")
    assert csv.startswith("Time,Name,Status,Details") and "Joy Santos" in csv and "SENT" in csv


def test_settings_fold_with_summaries_and_reset(wa_ext):
    wa, panel = wa_ext
    panel.click(".tabs button[data-tab=settings]")
    assert panel.evaluate("[...document.querySelectorAll('details.sec')].filter((d) => d.open).map((d) => d.dataset.sec)") == ["order"]
    assert "0–0 s between chats" in panel.text_content("#sum_send")  # the tests use no waiting
    assert panel.is_hidden("#dOptions")
    tab(panel, "settings")
    panel.check("#dCheck"); panel.dispatch_event("#dCheck", "change")
    assert panel.is_visible("#dOptions") and "stop after 3" in panel.text_content("#sum_order")
    set_val(panel, "#sGapMin", 45); set_val(panel, "#sGapMax", 120)
    assert "45–120 s" in panel.text_content("#sum_send")
    panel.click("button.reset[data-reset=send]")
    assert "30–90 s" in panel.text_content("#sum_send") and panel.input_value("#sGapMin") == "30"


def test_saves_names_and_log_to_a_folder_and_brings_them_back(wa_ext):
    import json
    wa, panel = wa_ext
    with tempfile.TemporaryDirectory() as tools:
        log = install_fake_host(panel._fu["profile"], panel._fu["ext_id"], tools)
        tab(panel, "settings")
        set_val(panel, "#bkFolder", str(pathlib.Path(tools) / "FollowUp-History"))
        set_val(panel, "#sAccount", "WA Business")
        assert "WhatsApp - WA Business" in panel.text_content("#bkWhere")
        assert panel.text_content("#account") == "WA Business"
        panel.click("#helperCheck")
        panel.wait_for_selector("#bkStatus:has-text('installed')", timeout=15000)
        quick_run(panel, 2)
        folder = pathlib.Path(tools) / "FollowUp-History" / "WhatsApp - WA Business"
        csv = folder / "Message 1.csv"
        panel.wait_for_function("() => true")
        for _ in range(50):
            if csv.exists():
                break
            wa.wait_for_timeout(200)
        names = [x["name"] for x in sent(wa)]
        text = csv.read_text(encoding="utf-8-sig")
        assert text.startswith("Name,Date sent") and all(n in text for n in names)
        tab(panel, "log")  # flushes the Log, also to the daily file
        for _ in range(50):
            if list(folder.glob("log-*.txt")):
                break
            wa.wait_for_timeout(200)
        day = list(folder.glob("log-*.txt"))[0].read_text(encoding="utf-8")
        assert "RUN" in day and "FINISH" in day
        # Chrome forgot the names: they come back from the file, and "Already messaged" (by name) uses them.
        panel.evaluate("async () => { await chrome.storage.local.set({ history: {}, campaign: { id: 1, doneKeys: [] } }); }")
        tab(panel, "settings")
        panel.check("#dCheck"); panel.dispatch_event("#dCheck", "change")
        panel.select_option("#sStopBy", "name"); panel.dispatch_event("#sStopBy", "change")
        set_val(panel, "#sStopAfter", 2)
        set_val(panel, "#sToday", 10)
        panel.click("#start")
        panel.wait_for_selector("#pill:has-text('Finished')", timeout=60000)
        assert "already had this message" in panel.text_content("#reason")
        assert len(sent(wa)) == 2
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        assert any(c["action"] == "readFile" for c in calls)


def test_keyboard_shortcuts(wa_ext):
    wa, panel = wa_ext
    sw = panel._fu["sw"]
    tab(panel, "settings")
    assert "Ctrl+Shift+5" in panel.text_content("#keys") or "(not set)" in panel.text_content("#keys")
    r = sw.evaluate("handleCommand('toggle-run')")
    assert r["ok"] and r["message"] == "Started"
    panel.wait_for_selector("#pill:has-text('Running')", timeout=10000)
    r = sw.evaluate("handleCommand('stop')")
    assert r["message"] == "Stopped"
    panel.wait_for_selector("#pill:has-text('Stopped')", timeout=20000)
    r = sw.evaluate("handleCommand('toggle-scroll')")
    assert r["message"].startswith("Scrolling")
    sw.evaluate("handleCommand('stop')")
