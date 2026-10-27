"""FollowUp for WhatsApp: the engine on a practice copy of WhatsApp Web."""
import base64
import pathlib

import pytest

from conftest import TINY_PNG

ROOT = pathlib.Path(__file__).resolve().parent.parent
WA_HTML = (ROOT / "tests" / "mock_whatsapp.html").read_text(encoding="utf-8")
WA_JS = (ROOT / "whatsapp-extension" / "wa-engine.js").read_text(encoding="utf-8")
WA_URL = "https://web.whatsapp.com/"
TEMPLATE = "Hi {first_name}! Just following up po 😊\nPromo ends Friday."

START = """async (cfg) => {
  const t = window.__t = window.__t || { log: [], done: new Set(cfg.preDone || []), sent: 0, states: [] };
  const hooks = {
    log: (e) => { t.log.push(e); },
    state: (s) => { t.states.push(s); },
    alreadyDone: (k) => t.done.has(k),
    markDone: (k) => { t.done.add(k); },
    onSent: () => { t.sent++; },
  };
  const r = WAEngine.start(cfg, hooks);
  await Promise.race([r.done, new Promise((res) => setTimeout(res, cfg.maxWaitMs || 90000))]);
  const state = r.state;
  if (state !== "finished" && state !== "stopped") { r.stop(); await r.done; }
  return { state, states: t.states, log: t.log, sent: t.sent };
}"""
FAST = {"stepDelayMs": 150, "gapMinSec": 0, "gapMaxSec": 0, "pageTimeoutMs": 3000, "bottomWaitSec": 0, "scrollWaitSec": 0.6}


def serve_wa(target):
    target.route("https://web.whatsapp.com/**", lambda route: route.fulfill(
        status=200, content_type="text/html; charset=utf-8", body=WA_HTML))


@pytest.fixture
def wa(browser):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    serve_wa(pg)
    pg.goto(WA_URL)
    pg.evaluate(WA_JS)
    yield pg
    ctx.close()


def run(page, **cfg):
    return page.evaluate(START, {"template": TEMPLATE, **FAST, **cfg})


def image():
    return {"image": {"dataUrl": "data:image/png;base64," + base64.b64encode(TINY_PNG.read_bytes()).decode(), "name": "promo.png"}}


def sent(page):
    return page.evaluate("__mock.sent")


def test_names_saved_unsaved_and_tilde(wa):
    r = wa.evaluate("""() => { const g = WAEngine.tools.greetName, d = WAEngine.DEFAULTS;
      return [g("Joy Santos", d), g("ROBIN PIATS", d), g("🌸 Liza Cruz", d), g("+63 917 123 4567", d),
              g("+63 917 123 4567", Object.assign({}, d, { unsavedWord: "Ma'am/Sir" })),
              g("+63 917 123 4567", Object.assign({}, d, { useTildeName: true }), "Mark D"),
              g("+63 917 123 4567", d, "Mark D")]; }""")
    assert r == ["Joy", "Robin", "Liza", "po", "Ma'am/Sir", "Mark", "po"]


def test_sends_text_to_everyone_it_should_and_nobody_else(wa):
    res = run(wa, maxWaitMs=120000)
    assert res["state"] == "finished", res["states"][-1]
    s = sent(wa)
    names = [x["name"] for x in s]
    # Never: groups, customer wrote last, blocked
    for n in ["Family GC", "Barkada", "Moses Jacob", "Bea Lim", "Old Number"]:
        assert n not in names
    assert len(names) == len(set(names)) == 13
    by = {x["name"]: x["text"] for x in s}
    assert by["Joy Santos"].startswith("Hi Joy! Just following up po")
    assert "Promo ends Friday." in by["Joy Santos"]
    assert by["+63 917 123 4567"].startswith("Hi po!")
    assert by["ROBIN PIATS"].startswith("Hi Robin!")
    reasons = {e["name"]: e["reason"] for e in res["log"] if e["status"] == "SKIPPED"}
    assert reasons["Family GC"] == "Group chat" and reasons["Barkada"] == "Group chat"
    assert reasons["Moses Jacob"].startswith("Customer wrote last")
    assert reasons["Old Number"].startswith("Can't message")
    # Decided from the list: never opened
    assert not {"Family GC", "Moses Jacob", "Bea Lim"} & set(wa.evaluate("__mock.opened"))


def test_custom_word_and_tilde_name(wa):
    run(wa, unsavedWord="Ma'am/Sir", useTildeName=True, capLeft=3, maxWaitMs=60000)
    by = {x["name"]: x["text"] for x in sent(wa)}
    assert by["+63 917 123 4567"].startswith("Hi Mark!")
    wa.evaluate("window.__t = null")
    run(wa, unsavedWord="Ma'am/Sir", useTildeName=True, order="top", capLeft=20, maxWaitMs=90000)
    by = {x["name"]: x["text"] for x in sent(wa)}
    assert by["+63 998 765 4321"].startswith("Hi Ma'am/Sir!")


def test_image_one_bubble_with_the_message(wa):
    res = run(wa, capLeft=2, **image())
    assert res["states"][-1]["code"] == "daily"
    s = sent(wa)
    assert len(s) == 2 and all(x["image"] for x in s)
    assert s[0]["text"].startswith("Hi Joy!")
    assert "image with the message" in [e for e in res["log"] if e["status"] == "SENT"][0]["reason"]


def test_image_two_bubbles(wa):
    run(wa, capLeft=1, imageStyle="two", **image())
    s = sent(wa)
    assert [x["image"] for x in s] == [False, True]
    assert s[0]["text"].startswith("Hi Joy!") and s[1]["text"] == ""


def test_image_falls_back_to_the_attach_button(wa):
    wa.evaluate("__mock.flags.noPasteImage = true")
    run(wa, capLeft=1, **image())
    s = sent(wa)
    assert len(s) == 1 and s[0]["image"] and s[0]["text"].startswith("Hi Joy!")


def test_bottom_first_goes_from_the_oldest_up(wa):
    wa.goto(WA_URL + "?extra=30")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.virtual = true")
    res = run(wa, order="bottom", capLeft=5, maxWaitMs=60000)
    names = [x["name"] for x in sent(wa)]
    assert names == ["Lead Number 30", "Lead Number 29", "Lead Number 28", "Lead Number 27", "Lead Number 26"]
    assert res["states"][-1]["code"] == "daily"


def test_whole_long_list_bottom_up_on_a_virtual_list(wa):
    wa.goto(WA_URL + "?extra=30")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.virtual = true")
    res = run(wa, order="bottom", maxWaitMs=300000)
    assert res["state"] == "finished" and res["states"][-1]["reason"] == "Reached the top of your chats"
    names = [x["name"] for x in sent(wa)]
    assert len(names) == len(set(names)) == 43  # 13 + 30 leads
    assert names[-1] == "Joy Santos"


def test_daily_limit_and_campaign_memory(wa):
    res = run(wa, capLeft=4, todayLimit=50)
    assert res["state"] == "finished" and res["states"][-1]["code"] == "daily"
    assert len(sent(wa)) == 4
    # Next run, same memory: the first four are skipped without opening.
    wa.evaluate("__mock.opened = []")
    res = run(wa, capLeft=2)
    names = [x["name"] for x in sent(wa)]
    assert len(names) == len(set(names)) == 6
    skipped = [e["name"] for e in res["log"] if e["reason"].startswith("Already got this message")]
    assert set(skipped) == set(names[:4])
    assert not set(names[:4]) & set(wa.evaluate("__mock.opened"))


def test_test_mode_sends_nothing(wa):
    res = run(wa, testMode=True, capLeft=3, maxWaitMs=60000, **image())
    assert sent(wa) == []
    tests = [e for e in res["log"] if e["status"] == "TEST"]
    assert tests and "image with the text under it" in tests[0]["reason"]
    assert wa.evaluate("!document.querySelector('.media-editor') && !document.querySelector('.box').innerText.trim()")


def test_stops_when_whatsapp_shows_a_warning(wa):
    wa.evaluate("__mock.flags.warnAfter = 2")
    res = run(wa, maxWaitMs=60000)
    assert len(sent(wa)) == 2
    assert res["state"] in ("stopped", "paused")
    assert any("WhatsApp shows" in (s.get("reason") or "") for s in res["states"])


def test_red_mark_and_stuck_send_are_problems_and_three_in_a_row_pause(wa):
    wa.evaluate("__mock.flags.failFor = 'Joy Santos'")
    res = run(wa, capLeft=2, maxWaitMs=60000)
    joy = [e for e in res["log"] if e["name"] == "Joy Santos"][0]
    assert joy["code"] == "WA_NOT_SENT"
    top = wa.evaluate("WAEngine.tools.getRows()[0].name")
    wa.evaluate("(n) => { window.__t = null; __mock.flags.stuckFor = n; }", top)
    res = run(wa, capLeft=1, maxWaitMs=60000)
    stuck = [e for e in res["log"] if e["name"] == top][0]
    assert stuck["code"] == "SEND_STUCK"
    assert wa.evaluate("!document.querySelector('.box') || !document.querySelector('.box').innerText.trim()")
    # Three problems in a row: it pauses and says why.
    wa.evaluate("window.__t = null; __mock.flags.stuckAll = true")
    res = run(wa, maxWaitMs=30000)
    assert any(s.get("state") == "paused" and "3 problems in a row" in s.get("reason", "") for s in res["states"])


def test_check_page(wa):
    d = wa.evaluate("WAEngine.tools.diagnose({})")
    assert d["chatList"] and d["rows"] >= 10 and not d["messageBox"]
    assert d["firstRows"][0] == {"name": "Joy Santos", "firstName": "Joy", "lastFromMe": True, "group": False, "unsaved": False}
    assert d["firstRows"][1]["unsaved"] and d["firstRows"][1]["firstName"] == "po"
    wa.click("text=Joy Santos")
    wa.wait_for_selector("#main footer .box")
    d = wa.evaluate("WAEngine.tools.diagnose({})")
    assert d["openChat"] == "Joy Santos" and d["messageBox"] and d["attach"]


SCROLL = """async (cfg) => {
  const p = [];
  const r = await WAEngine.tools.scrollButton(cfg, (x) => p.push(x));
  return Object.assign(r, { progress: p, loaded: __mock.loaded });
}"""


def test_scroll_button_all_the_way_on_a_lazy_list(wa):
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true")
    r = wa.evaluate(SCROLL, {"bottomWaitSec": 0, "scrollWaitSec": 0.6})
    assert r["reachedEnd"] and r["loaded"] >= 78
    assert r["progress"][-1]["state"] == "done"


def test_scroll_button_how_far_count(wa):
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true")
    r = wa.evaluate(SCROLL, {"scrollHow": "count", "scrollCount": 3, "bottomWaitSec": 0, "scrollWaitSec": 0.6})
    assert not r["reachedEnd"] and r["scrolls"] == 3 and r["message"] == "Scrolled 3 times"
    assert 20 < r["loaded"] < 78


def test_keeps_trying_through_a_pause_in_loading(wa):
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true; __mock.flags.pauseAfter = 36; __mock.flags.pauseMs = 12000")
    quick = wa.evaluate(SCROLL, {"bottomWaitSec": 0, "scrollWaitSec": 0.6})
    assert quick["reachedEnd"] and quick["loaded"] < 78  # without the wait it stops at the pause
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true; __mock.flags.pauseAfter = 36; __mock.flags.pauseMs = 12000")
    patient = wa.evaluate(SCROLL, {"bottomWaitSec": 30, "scrollWaitSec": 0.6})
    assert patient["reachedEnd"] and patient["loaded"] >= 78
    assert any("Making sure it's the bottom" in p["message"] for p in patient["progress"])


def test_scroll_button_pause_resume_stop(wa):
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true")
    wa.evaluate("() => { window.__sp = []; window.__sr = WAEngine.tools.scrollButton({ bottomWaitSec: 0, scrollWaitSec: 1 }, (x) => __sp.push(x)); }")
    wa.wait_for_function("__sp.length >= 2")
    assert wa.evaluate("WAEngine.tools.pauseScroll()")
    wa.wait_for_function("WAEngine.tools.scrollState() === 'paused'")
    n = wa.evaluate("__mock.loaded"); wa.wait_for_timeout(2500)
    assert wa.evaluate("__mock.loaded") == n
    assert wa.evaluate("WAEngine.tools.resumeScroll()")
    wa.wait_for_function("WAEngine.tools.scrollState() === 'running'")
    assert wa.evaluate("WAEngine.tools.stopScroll()")
    r = wa.evaluate("__sr")
    assert r["message"] == "Scrolling stopped" and not r["reachedEnd"]


def test_start_from_bottom_far_uses_how_far(wa):
    wa.goto(WA_URL + "?extra=60")
    wa.evaluate(WA_JS)
    wa.evaluate("__mock.flags.lazy = true")
    res = run(wa, order="bottomFar", scrollHow="count", scrollCount=1, capLeft=2, maxWaitMs=60000)
    names = [x["name"] for x in sent(wa)]
    assert any("as far as" in (s.get("reason") or "") for s in res["states"])
    # one scroll loaded 8 more (28 chats): the 28th is "Lead Number 10", so it starts there
    assert names[0] == "Lead Number 10" and len(names) == 2


# ---------- 2.0: Buyers (W1), Already messaged (W7), lowest chat on screen (W8) ----------
def test_reply_sorting(wa):
    r = wa.evaluate("""() => ["Magkano po?", "Interested po", "Not interested", "hello", "pa order 2 po", "no"].map((t) => WAEngine.tools.classifyReply(t, {}))""")
    assert r == ["hot", "warm", "cold", "replied", "hot", "cold"]


def test_finds_replies_and_sends_the_prepared_reply(wa):
    run(wa, capLeft=3)
    names = [x["name"] for x in sent(wa)]
    wa.evaluate("(n) => __mock.reply(n, 'Magkano po?')", names[0])
    wa.evaluate("(n) => __mock.reply(n, 'Not interested')", names[1])
    r = wa.evaluate("(keys) => WAEngine.tools.scanReplies({}, keys)", names)
    found = {x["name"]: x["kind"] for x in r["found"]}
    assert found == {names[0]: "hot", names[1]: "cold"}
    hot = [x for x in r["found"] if x["kind"] == "hot"][0]
    res = wa.evaluate("""(c) => WAEngine.tools.sendReply({ stepDelayMs: 150, pageTimeoutMs: 3000 }, c, { text: "Hi {first_name}! Here's our price list po." })""", hot)
    assert res["status"] == "REPLY"
    last = sent(wa)[-1]
    assert last["name"] == names[0] and last["text"].startswith("Hi Joy! Here's our price list po.")
    # Already answered: not sent twice
    res = wa.evaluate("""(c) => WAEngine.tools.sendReply({ stepDelayMs: 150 }, c, { text: "again" })""", hot)
    assert res["status"] == "SKIPPED" and res["reason"] == "You already answered them"


def test_label_hot_lead_in_whatsapp_business(wa):
    r = wa.evaluate("""() => WAEngine.tools.labelChat({ labelName: "Hot lead" }, { key: "Ana Reyes", name: "Ana Reyes" })""")
    assert r["ok"], r
    assert wa.evaluate("__mock.labeled") == [{"name": "Ana Reyes", "label": "Hot lead"}]
    wa.evaluate("__mock.flags.noLabels = true")
    r = wa.evaluate("""() => WAEngine.tools.labelChat({ labelName: "Hot lead" }, { key: "Ana Reyes", name: "Ana Reyes" })""")
    assert not r["ok"] and r["code"] == "LABEL_FAILED"


ALREADY = """async (cfg) => {
  const t = window.__t = { log: [], done: new Set(), sent: 0, states: [] };
  const names = new Set(cfg.names || []);
  const hooks = { log: (e) => t.log.push(e), state: (s) => t.states.push(s), alreadyDone: () => false, markDone() {}, onSent() {},
    nameSent: (n) => names.has(n) };
  const r = WAEngine.start(cfg, hooks);
  await Promise.race([r.done, new Promise((res) => setTimeout(res, 90000))]);
  if (r.state === "running" || r.state === "paused") { r.stop(); await r.done; }
  return { state: r.state, states: t.states, log: t.log };
}"""


def test_already_messaged_stops_the_run(wa):
    # First run: 4 people get the message. Then 2 new chats come in on top, and the run starts again.
    run(wa, capLeft=4)
    first = [x["name"] for x in sent(wa)]
    res = wa.evaluate(ALREADY, {"template": TEMPLATE, **FAST, "dupCheck": True, "stopBy": "both", "stopAfter": 3, "names": first, "order": "bottom",
                                "maxWaitMs": 90000})
    # bottom-up: everyone below gets it, then it reaches the 4 from the first run (now at the top) and stops after 3
    assert res["state"] == "finished" and res["states"][-1]["code"] == "already"
    already = [e for e in res["log"] if e["status"] == "ALREADY"]
    assert len(already) == 3 and all(e["name"] in first for e in already)
    assert all(x["name"] not in first for x in sent(wa)[4:])


def test_already_messaged_off_by_default_changes_nothing(wa):
    res = run(wa, capLeft=2)
    assert not [e for e in res["log"] if e["status"] == "ALREADY"]


def test_lowest_chat_on_screen_goes_up_and_leaves_lower_ones(wa):
    wa.goto(WA_URL + "?extra=30")
    wa.evaluate(WA_JS)
    wa.evaluate("document.getElementById('pane-side').scrollTop = 400")
    lowest = wa.evaluate("""() => { const l = document.getElementById('pane-side'), b = l.getBoundingClientRect().bottom;
      return WAEngine.tools.getRows().filter((r) => r.el.getBoundingClientRect().top < b - 10).pop().name; }""")
    res = run(wa, order="screen", maxWaitMs=120000)
    names = [x["name"] for x in sent(wa)]
    assert names[0] == lowest
    below = wa.evaluate("""(low) => { const all = __mock.convs.map(c => c.name); return all.slice(all.indexOf(low) + 1); }""", lowest)
    assert not set(names) & set(below)
    assert res["states"][-1]["reason"] == "Reached the top of your chats"


def test_pause_and_wait_stops_between_chats(wa):
    wa.evaluate("""() => { window.__t = { log: [], states: [] };
      window.__r = WAEngine.start(Object.assign({ template: 'Hi {first_name}!', stepDelayMs: 150, gapMinSec: 1, gapMaxSec: 1, pageTimeoutMs: 3000 }), {
        log: (e) => __t.log.push(e), state: (s) => __t.states.push(s), alreadyDone: () => false, markDone() {}, onSent() {} }); }""")
    wa.wait_for_function("__mock.sent.length >= 1")
    ok = wa.evaluate("WAEngine.pauseAndWait('Checking replies…', 20000)")
    assert ok and wa.evaluate("__r.state") == "paused"
    n = wa.evaluate("__mock.sent.length"); wa.wait_for_timeout(2500)
    assert wa.evaluate("__mock.sent.length") == n
    wa.evaluate("WAEngine.resume()")
    wa.wait_for_function(f"__mock.sent.length > {n}")
    wa.evaluate("WAEngine.stop()")
