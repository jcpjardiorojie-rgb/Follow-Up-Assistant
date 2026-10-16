"""Tests for the shared engine, run the way Option A runs it (in-page events, no Playwright input)."""
import base64

from conftest import TINY_PNG

TEMPLATE = "Hi {first_name}! Just following up po 😊\nPromo ends Friday."

# Minimal in-page hooks, like the extension's, kept in window.__t for assertions.
START = """async (cfg) => {
  const t = window.__t = window.__t || { log: [], done: new Set(cfg.preDone || []), sent: 0, states: [] };
  const hooks = {
    log: (e) => { t.log.push(e); },
    state: (s) => { t.states.push(s); },
    alreadyDone: (id) => t.done.has(id),
    markDone: (id) => { t.done.add(id); },
    sentToday: () => t.sent,
    onSent: () => { t.sent++; },
  };
  const r = FollowUpEngine.start(cfg, hooks);
  await Promise.race([r.done, new Promise((res) => setTimeout(res, cfg.maxWaitMs || 60000))]);
  const state = r.state;
  if (state !== "finished" && state !== "stopped") { r.stop(); await r.done; }
  return { state, states: t.states, log: t.log, sent: t.sent };
}"""

FAST = {"stepDelayMs": 150, "betweenChatsSec": 0, "pageTimeoutMs": 2500}


def run(page, **cfg):
    return page.evaluate(START, {"template": TEMPLATE, **FAST, **cfg})


def image_cfg():
    return {"image": {"dataUrl": "data:image/png;base64," + base64.b64encode(TINY_PNG.read_bytes()).decode(), "name": "promo.png"}}


def mock(page):
    return page.evaluate("({sent: __mock.sent, done: __mock.done, names: __mock.convs.map(c => [c.id, c.name, !!c.blocked])})")


def test_first_name_rules(page):
    names = page.evaluate("""() => ["Lista Maison", "ROBIN PIATS", "🌸 Joy Santos", "Facebook user", "Nguyễn Văn Phước", "J", ""]
        .map(n => FollowUpEngine.firstName(n))""")
    assert names == ["Lista", "Robin", "Joy", "there", "Nguyễn", "there", "there"]


def test_full_campaign_text_and_image(page):
    res = run(page, maxWaitMs=180000, **image_cfg())
    m = mock(page)
    assert res["state"] == "finished", res["states"][-1]
    by_id = {i: (n, b) for i, n, b in m["names"]}
    sent_ids = [s["id"] for s in m["sent"]]
    # Nobody gets two messages
    assert len(sent_ids) == len(set(sent_ids))
    # Never sent to blocked chats or "Facebook user"
    for s in m["sent"]:
        name, blocked = by_id[s["id"]]
        assert not blocked and name != "Facebook user"
        assert s["images"] == ["promo.png"]
        assert s["text"].startswith("Hi "), s
    first = {s["name"]: s["text"].split("!")[0] for s in m["sent"]}
    assert first["ROBIN PIATS"] == "Hi Robin"
    assert first["🌸 Joy Santos"] == "Hi Joy"
    assert first["Nguyễn Văn Phước"] == "Hi Nguyễn"
    assert "Promo ends Friday." in m["sent"][0]["text"]
    # Customers who wrote last are skipped
    assert not ({"Born Twi Struggle", "Abby Gene", "Deii Diesel"} & {s["name"] for s in m["sent"]})
    # Both kinds of excluded chats were moved to Done (3 blocked + 2 "Facebook user")
    done_names = sorted(by_id[i][0] for i in m["done"])
    assert done_names == sorted(["Lista Maison", "Janet Koae", "Julie Lucas", "Facebook user", "Facebook user"])
    assert len(m["sent"]) == 14
    statuses = [e["status"] for e in res["log"]]
    assert statuses.count("SENT") == 14 and "FAILED" not in statuses and "UNKNOWN" not in statuses


def test_text_only_when_editor_ignores_paste(page):
    page.evaluate("__mock.flags.ignorePaste = true")
    res = run(page, dailyCap=3)
    m = mock(page)
    assert len(m["sent"]) == 3 and all(s["images"] == [] for s in m["sent"])
    assert res["state"] == "finished" and "Daily limit" in res["states"][-1]["reason"]


def test_test_mode_sends_nothing(page):
    res = run(page, testMode=True, dailyCap=5, **image_cfg())
    m = mock(page)
    assert m["sent"] == [] and m["done"] == []
    assert any(e["status"] == "TEST" for e in res["log"])
    assert page.evaluate("document.querySelectorAll('#previews .pv').length") == 0


def test_resume_after_restart_never_double_sends(page):
    run(page, dailyCap=4)
    first = [s["id"] for s in mock(page)["sent"]]
    done = page.evaluate("[...window.__t.done]")
    page.reload()
    page.evaluate(__import__("conftest").ENGINE_JS)
    page.evaluate("delete window.__t")
    run(page, dailyCap=4, preDone=done)
    second = [s["id"] for s in mock(page)["sent"]]
    assert len(second) == 4 and not set(first) & set(second)


def test_unclear_identity_is_never_sent(page):
    page.evaluate("__mock.flags.wrongHeaderFor = 'Gabriella B Iramo'")
    res = run(page, dailyCap=2)
    m = mock(page)
    assert "Gabriella B Iramo" not in [s["name"] for s in m["sent"]]
    assert any(e["name"] == "Gabriella B Iramo" and e["status"] == "REVIEW" for e in res["log"])


def test_unknown_outcome_is_not_retried(page):
    page.evaluate("__mock.flags.swallowSend = true")
    res = run(page, maxConsecutiveFailures=2, maxWaitMs=45000)
    m = mock(page)
    ids = [s["id"] for s in m["sent"]]
    assert len(ids) == len(set(ids)) == 2
    assert [e["status"] for e in res["log"] if e["status"] in ("SENT", "UNKNOWN")] == ["UNKNOWN", "UNKNOWN"]
    assert res["state"] == "paused"


def test_meta_warning_pauses_the_run(page):
    page.evaluate("__mock.flags.blockAfter = 2")
    res = run(page, maxWaitMs=9000)
    assert res["state"] == "paused"
    assert "temporarily blocked" in [s for s in res["states"] if s["state"] == "paused"][-1]["reason"]
    assert len(mock(page)["sent"]) == 2


def test_tools_scroll_and_diagnose(page):
    d = page.evaluate("FollowUpEngine.tools.diagnose()")
    assert d["inboxList"] and d["rows"] == 12 and d["firstRows"][0]["name"] == "Lista Maison"
    r = page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 20)")
    assert r["reachedEnd"] and r["rows"] == 22
    page.click("text=Gabriella B Iramo")
    page.wait_for_selector("#composer")
    d = page.evaluate("FollowUpEngine.tools.diagnose()")
    assert d["messageBox"] and d["doneButton"] and d["sendButton"] and d["fileInput"]
    assert page.evaluate("document.querySelector('#msgs').scrollTop") == 0
    s = page.evaluate("FollowUpEngine.tools.scrollChatToLatest()")
    assert s["ok"] and page.evaluate("(m => m.scrollTop + m.clientHeight >= m.scrollHeight - 8)(document.querySelector('#msgs'))")


def test_bottom_order_scrolls_down_first_then_goes_up(page):
    res = run(page, order="bottom", dailyCap=3)
    m = mock(page)
    # Only 12 of 22 chats were loaded at the start; it scrolled to the very bottom first.
    reasons = [s.get("reason", "") for s in res["states"]]
    assert any("Scrolling to the bottom" in r for r in reasons)
    assert "Reached the bottom of the inbox. Sending from the bottom up." in reasons
    # Then it worked upward: the last chat first; "Julie Lucas" (can't message) moved to Done on the way.
    assert [s["name"] for s in m["sent"]] == ["Evah August Iamu", "Joshua Gerua", "Alois Mabep"]
    names = {i: n for i, n, _ in m["names"]}
    assert [names[i] for i in m["done"]] == ["Julie Lucas"]


def test_bottom_order_on_a_long_inbox_that_only_draws_visible_rows(page):
    page.goto("https://business.facebook.com/latest/inbox/all/?extra=40")
    page.evaluate(__import__("conftest").ENGINE_JS)
    page.evaluate("__mock.flags.virtual = true")
    res = run(page, order="bottom", onlyIfLastFromMe=False, dailyCap=1000, maxWaitMs=400000)
    m = mock(page)
    assert res["state"] == "finished" and res["states"][-1]["reason"] == "Reached the top of the inbox"
    sent = [s["name"] for s in m["sent"]]
    assert sent[:2] == ["Lead Number 40", "Lead Number 39"]
    assert len(sent) == len(set(s["id"] for s in m["sent"]))
    # Everyone who can be messaged got exactly one message (62 chats - 3 can't message - 2 Facebook user)
    assert len(sent) == 57 and sent[-1] == "Born Twi Struggle"  # top-most chat that can be messaged


def test_scroll_inbox_button_can_pause_resume_and_stop(page):
    page.evaluate("""() => { window.__p = []; FollowUpEngine.tools.loadWholeInbox({}, (p) => __p.push(p)).then((r) => { window.__scrollDone = r; }); }""")
    page.wait_for_function("__mock.loaded > 12")  # it scrolled once
    assert page.evaluate("FollowUpEngine.tools.pauseScroll()")
    page.wait_for_function("FollowUpEngine.tools.scrollState() === 'paused'")
    held = page.evaluate("__mock.loaded")
    page.wait_for_timeout(2500)
    assert page.evaluate("__mock.loaded") == held  # nothing loads while paused
    # a sending run can't start while scrolling is active
    assert "Scrolling the inbox is still going" in page.evaluate(
        "() => { try { FollowUpEngine.start({}, {}); return ''; } catch (e) { return e.message; } }")
    assert page.evaluate("FollowUpEngine.tools.resumeScroll()")
    page.wait_for_function("window.__scrollDone", timeout=60000)
    r = page.evaluate("__scrollDone")
    assert r["reachedEnd"] and r["rows"] == 22
    states = page.evaluate("__p.map(p => p.state)")
    assert "paused" in states and states[-1] == "done"

    page.evaluate("() => { __mock.loaded = 12; delete window.__scrollDone; }")
    page.reload()
    page.evaluate(__import__("conftest").ENGINE_JS)
    page.evaluate("() => { FollowUpEngine.tools.loadWholeInbox({}, null).then((r) => { window.__scrollDone = r; }); }")
    page.wait_for_timeout(300)
    assert page.evaluate("FollowUpEngine.tools.stopScroll()")
    page.wait_for_function("window.__scrollDone", timeout=10000)
    assert page.evaluate("__scrollDone.message") == "Scrolling stopped"
    assert page.evaluate("FollowUpEngine.tools.scrollState()") == "idle"


def test_screen_order_starts_at_lowest_visible_chat_and_leaves_lower_ones_alone(page):
    page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 30)")  # 22 chats loaded
    page.evaluate("document.querySelector('#list').scrollTop = 500")  # middle of the list on screen
    page.wait_for_timeout(300)
    order = page.evaluate("""() => {
      const l = document.querySelector('#list').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#rows .row')];
      let start = -1;
      rows.forEach((r, i) => { const b = r.getBoundingClientRect(); if (b.bottom > l.top && b.top + b.height / 2 <= l.bottom) start = i; });
      return { start, ids: rows.map(r => r.dataset.id) };
    }""")
    start = order["start"]
    assert 0 < start < len(order["ids"]) - 3  # some chats really are below the screen
    below = set(order["ids"][start + 1:])
    res = run(page, order="screen", maxWaitMs=300000)
    m = mock(page)
    assert res["state"] == "finished"
    assert any("the lowest chat on screen" in s.get("reason", "") for s in res["states"])
    touched = [s["id"] for s in m["sent"]] + m["done"]
    assert touched and not set(touched) & below  # nothing below the screen was sent or moved
    # It worked upward from the lowest visible chat: the first chat handled is the lowest eligible one on screen
    above = order["ids"][: start + 1]
    first = res["log"][0]
    names = {i: n for i, n, _ in m["names"]}
    assert first["name"] == names[above[-1]]
    # and it reached the top: every eligible chat above was handled
    assert len([s for s in m["sent"]]) + len(m["done"]) >= len(above) - 3  # 3 skipped (customer wrote last) at most
