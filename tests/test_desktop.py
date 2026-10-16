"""Option B end to end: the desktop app's Playwright controller against the practice inbox."""
import time

import pytest

from bridge import Controller, Store
from conftest import INBOX_URL, MOCK_HTML, TINY_PNG


async def serve(ctx):
    async def handler(route):
        await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=MOCK_HTML)
    await ctx.route("https://business.facebook.com/**", handler)


@pytest.fixture
def app(tmp_path):
    events = []
    store = Store(tmp_path)
    store.settings.update({"template": "Hi {first_name}!\nPromo ends Friday.", "image_path": str(TINY_PNG),
                           "betweenChatsSec": 0, "stepDelayMs": 300, "dailyCap": 4})
    c = Controller(store, lambda kind, data: events.append((kind, data)))
    c.open_browser(url=INBOX_URL, channel=None, headless=True,
                   viewport={"width": 1400, "height": 900}, setup=serve).result(60)
    yield c, store, events
    c.close()


def wait_until_done(c, seconds=120):
    end = time.time() + seconds
    while time.time() < end:
        if c.state.get("state") in ("finished", "stopped", "paused"):
            return c.state
        time.sleep(0.3)
    raise AssertionError("run did not finish: %s" % c.state)


def page_eval(c, js):
    return c.submit(c.page.evaluate(js)).result(10)


def test_desktop_runs_with_real_input(app):
    c, store, events = app
    page_eval(c, "new Promise(r => { const t = setInterval(() => { if (document.querySelectorAll('.row').length) { clearInterval(t); r(); } }, 100); })")
    report = c.diagnose().result(10)
    assert report["inboxList"] and report["rows"] == 12

    c.start().result(10)
    st = wait_until_done(c)
    assert st["state"] == "finished" and "Daily limit" in st["reason"]
    sent = page_eval(c, "__mock.sent")
    assert len(sent) == 4 and len({s["id"] for s in sent}) == 4
    assert sent[0]["text"] == "Hi Gabriella!\nPromo ends Friday."
    assert all(s["images"] == ["promo.png"] for s in sent)
    # Every click and Enter press was real browser input (Option A's are not)
    trusted = page_eval(c, "__mock.trusted")
    assert trusted and all(trusted)
    # Progress was saved to disk
    assert store.stats()["sent"] == 4 and len(store.campaign["doneIds"]) >= 6
    assert [r["status"] for r in store.recent_log()].count("SENT") == 4
    assert any(k == "log" for k, _ in events)

    # Raise the limit and run again: nobody gets a second message
    store.settings["dailyCap"] = 7
    c.start().result(10)
    wait_until_done(c)
    again = page_eval(c, "__mock.sent")
    assert len(again) == 7 and len({s["id"] for s in again}) == 7


def test_desktop_stop_button(app):
    c, store, _ = app
    store.settings.update({"betweenChatsSec": 30, "dailyCap": 100})
    page_eval(c, "new Promise(r => setTimeout(r, 500))")
    c.start().result(10)
    end = time.time() + 60
    while not page_eval(c, "__mock.sent.length") and time.time() < end:
        time.sleep(0.3)
    c.stop().result(10)
    st = wait_until_done(c, 10)
    assert st["state"] == "stopped"
    assert page_eval(c, "__mock.sent.length") == 1


def test_desktop_scroll_inbox_pause_resume(app):
    c, store, events = app
    page_eval(c, "new Promise(r => setTimeout(r, 500))")
    c.load_inbox().result(10)
    end = time.time() + 20
    while page_eval(c, "__mock.loaded") <= 12 and time.time() < end:
        time.sleep(0.2)
    assert c.pause_scroll().result(10)
    time.sleep(0.8)
    held = page_eval(c, "__mock.loaded")
    time.sleep(2)
    assert page_eval(c, "__mock.loaded") == held
    with pytest.raises(RuntimeError):
        c.load_inbox().result(10)  # already scrolling (paused)
    assert c.resume_scroll().result(10)
    end = time.time() + 60
    while not any(k == "scroll" and d["state"] == "done" for k, d in events) and time.time() < end:
        time.sleep(0.2)
    states = [d["state"] for k, d in events if k == "scroll"]
    assert "paused" in states and states[-1] == "done"
    done = [d for k, d in events if k == "scroll"][-1]
    assert done["reachedEnd"] and done["rows"] == 22


def test_inbox_link_rules(app):
    from bridge import asset_id, check_inbox_url
    link = "https://business.facebook.com/latest/inbox/all/?nav_ref=manage_page_ap_plus_inbox_message_button&asset_id=101270579420124&business_id="
    assert check_inbox_url(link) == (link, "") and asset_id(link) == "101270579420124"
    assert check_inbox_url("  ") == ("", "")
    assert "isn't Business Suite" in check_inbox_url("https://example.com/inbox")[1]
    assert "isn't a web link" in check_inbox_url("my inbox")[1]
    # Start refuses when the open inbox is another Page than the saved link
    c, store, _ = app
    store.settings["inboxUrl"] = link
    with pytest.raises(RuntimeError, match="different Facebook Page"):
        c.start().result(10)
    assert page_eval(c, "__mock.sent.length") == 0


def test_desktop_tools_while_running(app):
    c, store, events = app
    store.settings.update({"betweenChatsSec": 20, "dailyCap": 100})
    page_eval(c, "new Promise(r => setTimeout(r, 500))")
    c.start().result(10)
    end = time.time() + 60
    while not page_eval(c, "__mock.sent.length") and time.time() < end:
        time.sleep(0.3)
    c.load_inbox().result(120)  # pauses the run first, then scrolls
    assert page_eval(c, "FollowUpEngine.status()") == "paused"
    with pytest.raises(RuntimeError, match="still scrolling"):
        c.resume().result(10)
    end = time.time() + 60
    while page_eval(c, "FollowUpEngine.tools.scrollState()") != "idle" and time.time() < end:
        time.sleep(0.3)
    c.resume().result(10)
    assert page_eval(c, "FollowUpEngine.status()") == "running"
    c.stop().result(10)
