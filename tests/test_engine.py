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
    nameSent: (n) => (cfg.names || []).includes(n),
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
    assert all(e["confirmed"] for e in res["log"] if e["status"] == "SENT")  # seen on screen every time


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
    entry = next(e for e in res["log"] if e["name"] == "Gabriella B Iramo")
    assert entry["status"] == "REVIEW" and entry["code"] == "OPEN_TIMEOUT"
    assert "Wait after opening a chat" in entry["help"]["fix"]


def test_sent_but_not_seen_on_screen_counts_as_sent_without_pausing(page):
    # Your report: the messages went out, but the app couldn't see them in the chat and paused.
    page.evaluate("__mock.flags.swallowSend = true")
    res = run(page, dailyCap=4, maxWaitMs=120000)
    m = mock(page)
    ids = [s["id"] for s in m["sent"]]
    assert len(ids) == len(set(ids)) == 4
    sent = [e for e in res["log"] if e["status"] == "SENT"]
    assert len(sent) == 4 and not any(e["confirmed"] for e in sent)
    assert all("couldn't double-check" in e["reason"] for e in sent)
    assert res["state"] == "finished" and "Daily limit" in res["states"][-1]["reason"]
    assert not [e for e in res["log"] if e["status"] in ("FAILED", "REVIEW", "UNKNOWN")]


def test_meta_refusing_messages_pauses_with_a_clear_fix(page):
    page.evaluate("__mock.flags.sendFails = true")
    res = run(page, maxWaitMs=120000)
    problems = [e for e in res["log"] if e.get("code") == "META_NOT_SENT"]
    assert len(problems) == 3 and len({e["id"] for e in problems}) == 3  # never retried
    assert all(e["help"]["fix"].startswith("Raise “Seconds between chats”") for e in problems)
    assert res["state"] == "paused"
    reason = [s for s in res["states"] if s["state"] == "paused"][-1]["reason"]
    assert "3 problems in a row" in reason and "How to fix:" in reason and "Problems tab" in reason


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



def test_reply_sorting():
    import subprocess, json
    from conftest import ROOT
    js = """global.window = globalThis; require(%r); const E = globalThis.FollowUpEngine;
      console.log(JSON.stringify(%s.map(t => E.classifyReply(t))));""" % (str(ROOT / "extension" / "engine.js"), json.dumps([
        "Magkano po?", "hm", "Available pa po ba?", "Saan location nyo", "interested ako", "pa send po details",
        "ok po", "Not interested", "wag na po, salamat", "no", "salamat po"]))
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert out == ["hot", "hot", "hot", "hot", "warm", "warm", "warm", "cold", "cold", "cold", "replied"]


def test_check_replies_finds_buyers_and_labels_hot_leads(page):
    res = run(page, dailyCap=4)
    sent = [e for e in res["log"] if e["status"] == "SENT"]
    assert len(sent) == 4 and all(e["key"] for e in sent)
    ids = {e["name"]: e["id"] for e in sent}
    names = list(ids)
    page.evaluate("([a, b, c]) => { __mock.reply(a, 'Magkano po?'); __mock.reply(b, 'interested ako'); __mock.reply(c, 'Not interested'); }",
                  [ids[names[0]], ids[names[1]], ids[names[2]]])
    contacts = [{"key": e["key"], "name": e["name"]} for e in sent]
    r = page.evaluate("(c) => FollowUpEngine.tools.scanReplies({}, c, null, 200)", contacts)
    kinds = {x["name"]: x["kind"] for x in r["replies"]}
    assert kinds == {names[0]: "hot", names[1]: "warm", names[2]: "cold"}
    assert {x["name"]: x["reply"] for x in r["replies"]}[names[0]] == "Magkano po?"
    # Label the hot lead in Business Suite
    hot = [c for c in contacts if c["name"] == names[0]]
    out = page.evaluate("(c) => FollowUpEngine.tools.labelLeads({ stepDelayMs: 200 }, c, null)", hot)
    assert out["results"][0]["ok"], out
    assert page.evaluate("__mock.labeled") == [{"id": ids[names[0]], "label": "Hot lead"}]
    # A chat that can't be found explains why
    miss = page.evaluate("FollowUpEngine.tools.labelChat({ pageTimeoutMs: 1500 }, { key: 'x|y', name: 'Nobody Here' })")
    assert not miss["ok"] and miss["code"] == "CHAT_NOT_FOUND" and miss["help"]["fix"]



def test_screen_order_keeps_sending_on_a_long_inbox(page):
    # Your report: with "Lowest chat on screen", after about 12 messages it only scrolled up.
    page.goto("https://business.facebook.com/latest/inbox/all/?extra=40")
    page.evaluate(__import__("conftest").ENGINE_JS)
    page.evaluate("__mock.flags.virtual = true")
    page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 60)")
    page.evaluate("(l => { l.scrollTop = l.scrollHeight - l.clientHeight - 700; })(document.querySelector('#list'))")
    page.wait_for_timeout(400)
    on_screen = page.evaluate("""() => { const l = document.querySelector('#list').getBoundingClientRect();
      return [...document.querySelectorAll('#rows .row')].filter(r => { const b = r.getBoundingClientRect();
        return b.bottom > l.top && b.top + b.height / 2 <= l.bottom; }).map(r => r.querySelector('.name').textContent); }""")
    lowest = on_screen[-1]
    all_names = page.evaluate("__mock.convs.filter(c => !c.done).map(c => c.name)")
    below = set(all_names[all_names.index(lowest) + 1:])
    res = run(page, order="screen", onlyIfLastFromMe=False, maxWaitMs=400000)
    m = mock(page)
    sent = [s["name"] for s in m["sent"]]
    assert res["state"] == "finished" and res["states"][-1]["reason"] == "Reached the top of the inbox"
    assert len(sent) > 25  # well past the first screenful
    assert not set(sent) & below  # nothing below the starting chat
    assert sent[0] == lowest or all_names.index(sent[0]) < all_names.index(lowest)
    can_send = [n for n in all_names[: all_names.index(lowest) + 1] if n != "Facebook user"]
    blocked = {c[1] for c in m["names"] if c[2]}
    assert sorted(sent) == sorted(n for n in can_send if n not in blocked)


def test_scrolling_down_gets_unstuck_by_scrolling_up_a_little(page):
    page.evaluate("__mock.flags.sticky = true")
    r = page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 60)")
    assert r["reachedEnd"] and r["rows"] == 22


def test_scroll_to_bottom_finishes_on_a_long_inbox(page):
    # 1.5.0 bug: on inboxes that only keep on-screen rows, the "scroll up a little" nudge looked
    # like new chats loading, so scrolling to the bottom never finished.
    page.goto("https://business.facebook.com/latest/inbox/all/?extra=40")
    page.evaluate(__import__("conftest").ENGINE_JS)
    page.evaluate("__mock.flags.virtual = true; __mock.flags.sticky = true")
    import time
    t = time.time()
    r = page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 300)")
    assert r["reachedEnd"] and r["message"] == "Reached the bottom of the inbox"
    assert time.time() - t < 120
    assert page.evaluate("__mock.loaded") >= 62



def test_moves_to_the_next_chat_with_a_small_scroll(page):
    # Your report: the list jumped around because each chat was scrolled to the middle first.
    page.evaluate("FollowUpEngine.tools.loadWholeInbox({}, null, 30)")
    page.evaluate("document.querySelector('#list').scrollTop = 0")
    page.wait_for_timeout(300)
    target = page.evaluate("""() => { const l = document.querySelector('#list').getBoundingClientRect();
      const r = [...document.querySelectorAll('#rows .row')].find(r => r.getBoundingClientRect().bottom > l.bottom);
      return { name: r.querySelector('.name').textContent, key: '' }; }""")
    r = page.evaluate("(t) => FollowUpEngine.tools.openChat({}, t.key, t.name)", target)
    assert r["ok"]
    moved = page.evaluate("document.querySelector('#list').scrollTop")
    assert 0 < moved <= 64 + 12 + 2  # one row's height at most, not half a screen
    assert page.evaluate("__mock.selected.name") == target["name"]


def test_scroll_settings_count_chats_retries_and_button(page):
    tool = "(c) => FollowUpEngine.tools.loadWholeInbox(c, null, 60)"
    # S1 a number of scrolls: 1 scroll loads one more batch (12 → 18) and stops
    r = page.evaluate(tool, {"scrollHow": "count", "scrollCount": 1, "scrollWaitSec": 0})
    assert r["reachedGoal"] and r["scrolls"] == 1 and r["message"] == "Scrolled 1 times"
    assert page.evaluate("__mock.loaded") == 18
    page.reload(); page.evaluate(__import__("conftest").ENGINE_JS)
    # S1 about a number of chats
    r = page.evaluate(tool, {"scrollHow": "chats", "scrollChats": 15, "scrollWaitSec": 0})
    assert r["reachedGoal"] and r["chats"] >= 15 and page.evaluate("__mock.loaded") == 18
    page.reload(); page.evaluate(__import__("conftest").ENGINE_JS)
    # S5 off: the button ignores the scroll count and goes all the way
    r = page.evaluate(tool, {"scrollHow": "count", "scrollCount": 1, "scrollWaitSec": 0, "buttonUsesScrollSettings": False})
    assert r["reachedEnd"] and r["rows"] == 22
    page.reload(); page.evaluate(__import__("conftest").ENGINE_JS)
    # S3 with no unstick retries, a list that gets stuck looks like the bottom
    page.evaluate("__mock.flags.sticky = true")
    r = page.evaluate(tool, {"scrollHow": "all", "scrollWaitSec": 0, "unstickRetries": 0})
    assert r["reachedEnd"] and page.evaluate("__mock.loaded") < 22
    page.reload(); page.evaluate(__import__("conftest").ENGINE_JS)
    # S2 wait between scrolls slows each scroll down
    import time
    t = time.time()
    page.evaluate(tool, {"scrollHow": "count", "scrollCount": 2, "scrollWaitSec": 2})
    assert time.time() - t >= 3.8


def test_bottom_with_a_scroll_count_sends_from_the_lowest_loaded_chat_up(page):
    res = run(page, order="bottom", scrollHow="count", scrollCount=1, scrollWaitSec=0, dailyCap=2)
    m = mock(page)
    assert any("1 of 1 scrolls" in s.get("reason", "") for s in res["states"])
    assert any(s.get("reason", "").startswith("Scrolled 1 times") for s in res["states"])
    # 18 chats were loaded; it starts at the 18th and goes up (Deii Diesel wrote last, so skipped)
    assert [s["name"] for s in m["sent"]] == ["Carla JR Tauedea Vada", "Zner Naapmac"]


def already(log):
    return [e for e in log if e["status"] == "ALREADY"]


def test_stops_when_it_reaches_people_who_already_got_this_message(page):
    first = run(page, dailyCap=5)
    names = [e["name"] for e in first["log"] if e["status"] == "SENT"]
    assert len(names) == 5
    # A new campaign (memory cleared): the 5 chats with this message are at the top now.
    page.evaluate("window.__t = null")
    res = run(page, dupCheck=True, stopBy="message", stopAfter=3)
    assert res["state"] == "finished" and "3 chats in a row already had this message" in res["states"][-1]["reason"]
    assert [e["name"] for e in already(res["log"])] == names[::-1][:3] and all(e["counted"] for e in already(res["log"]))
    sent_ids = [s["id"] for s in mock(page)["sent"]]
    assert len(sent_ids) == len(set(sent_ids)) == 5  # nobody got it twice


def test_stop_by_name_decides_from_the_list_without_opening(page):
    first = run(page, dailyCap=4)
    names = [e["name"] for e in first["log"] if e["status"] == "SENT"]
    page.evaluate("window.__t = null")
    res = run(page, dupCheck=True, stopBy="name", stopAfter=3, names=names)
    hits = already(res["log"])
    assert res["state"] == "finished" and len(hits) == 3
    assert all(e["id"] is None for e in hits)  # chat never opened


def test_stop_by_name_and_message_needs_both(page):
    first = run(page, dailyCap=3)
    names = [e["name"] for e in first["log"] if e["status"] == "SENT"]
    page.evaluate("window.__t = null")
    # Only 2 of the 3 names are on FollowUp's list: the third has the words, but FollowUp didn't send it to
    # that name, so it isn't treated as already messaged.
    res = run(page, dupCheck=True, stopBy="both", stopAfter=3, names=names[:2], dailyCap=8)
    hits = already(res["log"])
    assert [(e["name"], e["counted"]) for e in hits] == [(names[1], True), (names[0], True)]
    assert res["states"][-1]["reason"].startswith("Daily limit")  # never 3 counted in a row, so it kept going


def test_off_still_never_sends_the_same_message_twice(page):
    first = run(page, dailyCap=4)
    names = [e["name"] for e in first["log"] if e["status"] == "SENT"]
    page.evaluate("window.__t = null")
    res = run(page, dupCheck=True, stopBy="off", dailyCap=3, names=names)
    assert len(already(res["log"])) == 4 and res["states"][-1]["reason"].startswith("Daily limit")
    sent_ids = [s["id"] for s in mock(page)["sent"]]
    assert len(sent_ids) == len(set(sent_ids)) == 7


def test_facebook_user_is_moved_to_done_even_after_a_failed_try(page):
    page.evaluate("__mock.flags.doneFailsOnce = true")
    first = run(page, maxWaitMs=180000)
    fails = [e for e in first["log"] if e.get("code") == "DONE_FAILED"]
    assert {e["name"] for e in fails} >= {"Facebook user"}
    # Next run (same campaign memory): they are tried again, not skipped as "already handled".
    res = run(page, maxWaitMs=120000)
    m = mock(page)
    by_id = {i: n for i, n, _ in m["names"]}
    assert sorted(by_id[i] for i in m["done"]).count("Facebook user") == 2
    assert not [e for e in res["log"] if e["name"] == "Facebook user" and e["status"] == "SKIPPED"]


def test_auto_reply_goes_only_to_people_who_wrote_last(page):
    first = run(page, dailyCap=2)
    sent = [e for e in first["log"] if e["status"] == "SENT"]
    page.evaluate("(id) => __mock.reply(id, 'Magkano po?')", sent[0]["id"])
    reply = {"text": "Hi {first_name}! Here's our price list po"}
    r1 = page.evaluate("([c, r]) => FollowUpEngine.tools.sendReply({ stepDelayMs: 150, pageTimeoutMs: 2500 }, c, r)",
                       [{"key": sent[0]["key"], "name": sent[0]["name"]}, reply])
    assert r1["status"] == "SENT", r1
    last = mock(page)["sent"][-1]
    assert last["id"] == sent[0]["id"] and last["text"].endswith("Here's our price list po")
    # Already answered (by the auto-reply, or by you): nothing more is sent.
    r2 = page.evaluate("([c, r]) => FollowUpEngine.tools.sendReply({ stepDelayMs: 150, pageTimeoutMs: 2500 }, c, r)",
                       [{"key": sent[0]["key"], "name": sent[0]["name"]}, reply])
    assert r2["status"] == "SKIPPED" and "already answered" in r2["reason"]
    # The second person didn't write back: no reply.
    r3 = page.evaluate("([c, r]) => FollowUpEngine.tools.sendReply({ stepDelayMs: 150, pageTimeoutMs: 2500 }, c, r)",
                       [{"key": sent[1]["key"], "name": sent[1]["name"]}, reply])
    assert r3["status"] == "SKIPPED"
    assert len(mock(page)["sent"]) == 3


def test_old_broadcast_with_the_same_words_still_gets_the_follow_up(page):
    # Every practice chat ends with an old "*GOOD NEWS!" broadcast that FollowUp never sent.
    res = run(page, dupCheck=True, template="*GOOD NEWS! There's more to explore with our new package", order="bottom", dailyCap=5)
    assert [e["status"] for e in res["log"]][:2] == ["SENT", "SENT"]  # starts at the bottom, no skipping up
    assert not already(res["log"]) and len(mock(page)["sent"]) == 5


def test_switched_off_works_like_before_1_7(page):
    first = run(page, dailyCap=3)
    names = [e["name"] for e in first["log"] if e["status"] == "SENT"]
    page.evaluate("window.__t = null")
    res = run(page, dupCheck=False, stopBy="name", names=names, dailyCap=3)
    assert not already(res["log"]) and res["states"][-1]["reason"].startswith("Daily limit")


def test_narrow_window_scrolls_the_inbox_not_the_chat(browser):
    """Business Suite in a half-screen window: the chat's messages must never be taken for the inbox list."""
    from conftest import ENGINE_JS, INBOX_URL, serve_mock
    ctx = browser.new_context(viewport={"width": 950, "height": 900})
    pg = ctx.new_page()
    serve_mock(pg)
    pg.goto(INBOX_URL)
    pg.wait_for_function("window.__mock && document.querySelectorAll('.row').length > 5")
    pg.evaluate("__mock.flags.fullRows = true")
    pg.evaluate(ENGINE_JS)
    pg.click(".row:nth-child(4)")
    pg.wait_for_selector("#msgs .mrow")
    d = pg.evaluate("FollowUpEngine.tools.diagnose({})")
    assert d["rows"] == 12 and d["firstRows"][0]["name"] == "Lista Maison"
    msgs_before = pg.evaluate("document.getElementById('msgs').scrollTop")
    r = pg.evaluate("FollowUpEngine.tools.loadWholeInbox({ scrollWaitSec: 0.2, unstickRetries: 0, buttonUsesScrollSettings: false })")
    assert r["reachedEnd"] and r["chats"] >= 21
    assert pg.evaluate("document.getElementById('list').scrollTop") > 0
    assert pg.evaluate("document.getElementById('msgs').scrollTop") == msgs_before
    ctx.close()


def test_ad_chat_uses_the_name_from_the_chat_header(page):
    page.evaluate("__mock.flags.adFor = 'Gabriella B Iramo'")
    res = run(page, dailyCap=1)
    sent = mock(page)["sent"]
    assert len(sent) == 1 and sent[0]["name"] == "Gabriella B Iramo"
    assert sent[0]["text"].startswith("Hi Gabriella!")
    e = [x for x in res["log"] if x["status"] == "SENT"][0]
    assert e["name"] == "Gabriella B Iramo" and e["listText"].startswith("I am very interested")


def test_end_reasons_and_waiting_while_hidden(page):
    res = run(page, dailyCap=2)
    assert res["states"][-1]["code"] == "daily"
    page.evaluate("window.__t = null")
    # A hidden window waits instead of guessing; it continues when visible again.
    page.evaluate("""() => { window.__hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden }); }""")
    page.evaluate("setTimeout(() => { window.__hidden = false; }, 2500)")
    res = run(page, dailyCap=3)
    assert any(s.get("code") == "hidden" for s in res["states"]) and any(s.get("code") == "visible" for s in res["states"])
    assert res["states"][-1]["code"] == "daily" and len(mock(page)["sent"]) == 5  # 2 + 3
