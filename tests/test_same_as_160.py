"""With "Already messaged" Off, the run must message the same people in the same order as version 1.6.0."""
import pathlib

import pytest
from conftest import ROOT, serve_mock
from test_engine import FAST, START

OLD = (ROOT / "tests" / "reference" / "engine-1.6.0.js").read_text(encoding="utf-8")
NEW = (ROOT / "extension" / "engine.js").read_text(encoding="utf-8")
SCENARIOS = {
    "top": ("?asset_id=1", "", {"dailyCap": 30}),
    "bottom": ("?extra=40", "__mock.flags.virtual = true", {"order": "bottom", "scrollCount": 4, "dailyCap": 12}),
}


def _run(browser, engine, query, flags, cfg):
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    serve_mock(pg)
    pg.goto("https://business.facebook.com/latest/inbox/all/" + query)
    pg.wait_for_function("window.__mock && document.querySelectorAll('.row').length > 5")
    if flags:
        pg.evaluate(flags)
    pg.evaluate(engine)
    pg.evaluate(START, {"template": "Hi {first_name}! Promo po", **FAST, **cfg, "maxWaitMs": 150000})
    m = pg.evaluate("({sent: __mock.sent.map(s => s.name), done: __mock.done.map(id => __mock.convs.find(c => c.id === id).name)})")
    ctx.close()
    return m


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_off_sends_exactly_like_1_6_0(browser, name):
    query, flags, cfg = SCENARIOS[name]
    old = _run(browser, OLD, query, flags, cfg)
    new = _run(browser, NEW, query, flags, {**cfg, "dupCheck": False})
    assert new["sent"] == old["sent"]
    if name == "top":
        assert new["done"].count("Facebook user") == 2  # both "Facebook user" chats moved to Done
