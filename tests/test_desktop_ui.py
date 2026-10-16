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
