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
FAST = {"stepDelayMs": 150, "gapMinSec": 0, "gapMaxSec": 0, "pageTimeoutMs": 3000}


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
