"""Option B window: press Start in the real window and watch the activity list fill in. Needs a display (xvfb-run on Linux)."""
import os
import time

import pytest

from conftest import INBOX_URL, TINY_PNG
from test_desktop import serve

tk = pytest.importorskip("tkinter")
pytestmark = pytest.mark.skipif(os.name != "nt" and not os.environ.get("DISPLAY"), reason="needs a display")


def test_window_start_button_runs_campaign(tmp_path):
    import followup_desk as fd
    from bridge import Store

    store = Store(tmp_path)
    store.settings.update({"image_path": str(TINY_PNG), "stepDelayMs": 300})
    root = tk.Tk()
    app = fd.App(root, store)
    app.ctl.open_browser(url=INBOX_URL, channel=None, headless=True,
                         viewport={"width": 1400, "height": 900}, setup=serve).result(60)
    app.t_text.delete("1.0", "end")
    app.t_text.insert("1.0", "Hi {first_name}! Following up po")
    app._on_text()
    app.v_between.set(0)
    app.v_cap.set(3)
    time.sleep(1)
    app._start()
    end = time.time() + 90
    while time.time() < end and app.state != "finished":
        root.update()
        time.sleep(0.05)
    try:
        assert app.state == "finished"
        assert app.count_lbls["sent"][0].cget("text") == "3"
        rows = [app.tree.item(i)["values"] for i in app.tree.get_children()]
        assert [r[2] for r in rows].count("SENT") == 3
        sent = app.ctl.submit(app.ctl.page.evaluate("__mock.sent")).result(10)
        assert [s["text"] for s in sent][0] == "Hi Gabriella! Following up po"
        assert store.settings["dailyCap"] == 3  # settings saved from the window
    finally:
        app.ctl.close()
        root.destroy()


def test_window_shortcuts_toggle_run_and_scroll(tmp_path):
    import followup_desk as fd
    from bridge import Store

    store = Store(tmp_path)
    store.settings.update({"stepDelayMs": 300, "betweenChatsSec": 2, "template": "Hi {first_name}!"})
    root = tk.Tk()
    app = fd.App(root, store)

    def pump(until, seconds=60):
        end = time.time() + seconds
        while time.time() < end:
            root.update()
            if until():
                return True
            time.sleep(0.05)
        return False

    def press(action):
        app.events.put(("hotkey", action))  # what a shortcut (or a mouse button set to it) sends

    try:
        # The shortcut boxes show the defaults, and a bad one is reported instead of used
        assert app.v_keys["toggle_run"].get() == "Ctrl+Shift+1"
        app.v_keys["scroll_latest"].set("q")
        app._apply_hotkeys(quiet=True)
        assert "Not used" in app.keys_msg.cget("text") or "unavailable" in app.keys_msg.cget("text")
        app.v_keys["scroll_latest"].set("ctrl+shift+4")
        app._apply_hotkeys(quiet=True)
        assert store.settings["hotkeys"]["scroll_latest"] == "Ctrl+Shift+4"

        app.ctl.open_browser(url=INBOX_URL, channel=None, headless=True,
                             viewport={"width": 1400, "height": 900}, setup=serve).result(60)
        time.sleep(1)
        # Scroll: start → pause → resume → finishes
        press("toggle_scroll")
        assert pump(lambda: app.scroll == "running")
        assert app.b_load.cget("text") == "Pause scrolling"
        press("toggle_scroll")
        assert pump(lambda: app.scroll == "paused")
        assert app.b_load.cget("text") == "Resume scrolling"
        press("toggle_scroll")
        assert pump(lambda: app.scroll == "idle", 60)
        assert "Reached the bottom" in app.reason.cget("text")
        # Sending: start → pause → resume → stop, all from shortcuts
        press("toggle_run")
        assert pump(lambda: app.state == "running")
        sent = lambda: app.ctl.submit(app.ctl.page.evaluate("__mock.sent.length")).result(10)
        assert pump(lambda: sent() >= 1)
        press("toggle_run")
        assert pump(lambda: app.state == "paused")
        press("toggle_run")
        assert pump(lambda: app.state == "running")
        press("stop")
        assert pump(lambda: app.state == "stopped", 30)
    finally:
        app.hk.stop()
        app.ctl.close()
        root.destroy()


def test_window_problems_tab(tmp_path):
    import followup_desk as fd
    from bridge import Store

    store = Store(tmp_path)
    root = tk.Tk()
    app = fd.App(root, store)
    try:
        assert "No problems" in app.prob_text.get("1.0", "end")
        entry = {"time": "2026-10-16T10:00:00", "name": "Odilin Gibson", "status": "FAILED", "reason": "Image didn't attach",
                 "code": "IMAGE_FAILED", "help": {"what": "The image didn't attach.", "why": "Too big.", "fix": "Use a JPG under 5 MB."}}
        store.add_problem(entry)
        app.events.put(("problem", entry))
        app.events.put(("state", {"state": "paused", "reason": "Paused after 3 problems in a row. See the Problems tab for details."}))
        end = time.time() + 5
        while time.time() < end and "Odilin" not in app.prob_text.get("1.0", "end"):
            root.update()
            time.sleep(0.05)
        root.update()
        text = app.prob_text.get("1.0", "end")
        assert "Odilin Gibson" in text and "HOW TO FIX  Use a JPG under 5 MB." in text
        assert app.tabs.tab(app.tabs.select(), "text").strip().startswith("Problems (1)")
    finally:
        app.hk.stop()
        app.ctl.close()
        root.destroy()
