"""Option B engine room.

Opens Chrome through Playwright and runs the shared engine (extension/engine.js)
inside the Business Suite page. Clicks, typing and image uploads are real browser
input sent by Playwright, instead of the in-page events Option A uses.

Everything here runs on one background thread with its own asyncio loop, so the
window (followup_desk.py) never freezes. The UI calls the public methods, which
return concurrent.futures.Future objects, and receives updates through `on_event`.
"""
import asyncio
import base64
import csv
import datetime as dt
import json
import mimetypes
import os
import pathlib
import sys
import threading

INBOX_URL = "https://business.facebook.com/latest/inbox/all/"

ENGINE_KEYS = [
    "fallbackName", "blockedTexts", "excludeNames", "stopTexts", "order", "onlyIfLastFromMe",
    "moveSentToDone", "testMode", "stepDelayMs", "betweenChatsSec", "dailyCap", "imageRequired",
]
def asset_id(url):
    """The Facebook Page id in a Business Suite link (asset_id=…), or None."""
    from urllib.parse import parse_qs, urlparse
    try:
        return (parse_qs(urlparse(url).query).get("asset_id") or [None])[0]
    except ValueError:
        return None


def check_inbox_url(text):
    """A pasted inbox link -> (cleaned link or "", error message or "")."""
    from urllib.parse import urlparse
    t = (text or "").strip()
    if not t:
        return "", ""
    u = urlparse(t)
    if u.scheme not in ("http", "https") or not u.netloc:
        return "", "That isn't a web link. Copy it from Chrome's address bar while your inbox is open."
    host = u.netloc.lower()
    if not (host == "business.facebook.com" or (host == "www.facebook.com" and u.path.startswith("/latest"))):
        return "", "That link isn't Business Suite. It should start with https://business.facebook.com/latest/inbox"
    return t, ""


DEFAULT_SETTINGS = {
    "inboxUrl": "",
    "template": "Hi {first_name}! Just following up po 😊",
    "image_path": "",
    "fallbackName": "there",
    "blockedTexts": ["You are no longer able to send messages to this person"],
    "excludeNames": ["Facebook user"],
    "stopTexts": [
        "temporarily blocked", "temporarily restricted", "You can't use this feature right now",
        "We limit how often", "Your account has been restricted", "account is restricted",
        "Confirm your identity", "Security check", "Action blocked",
    ],
    "order": "top",
    "onlyIfLastFromMe": True,
    "moveSentToDone": False,
    "testMode": False,
    "imageRequired": True,
    "stepDelayMs": 1200,
    "betweenChatsSec": 8,
    "dailyCap": 300,
    "hotkeys": {"toggle_run": "Ctrl+Shift+1", "stop": "Ctrl+Shift+2", "toggle_scroll": "Ctrl+Shift+3", "scroll_latest": "Ctrl+Shift+4"},
}
COUNTER = {"SENT": "sent", "EXCLUDED": "excluded", "SKIPPED": "skipped", "FAILED": "failed",
           "REVIEW": "failed", "UNKNOWN": "unknown", "TEST": "test"}


def app_dir():
    base = os.environ.get("LOCALAPPDATA") or str(pathlib.Path.home() / ".local" / "share")
    path = pathlib.Path(base) / "FollowUpDesk"
    path.mkdir(parents=True, exist_ok=True)
    return path


def engine_source():
    here = pathlib.Path(__file__).resolve().parent
    candidates = [pathlib.Path(getattr(sys, "_MEIPASS", here)) / "engine.js",
                  here.parent / "extension" / "engine.js", here / "engine.js"]
    for c in candidates:
        if c.exists():
            return c.read_text(encoding="utf-8")
    raise FileNotFoundError("engine.js not found (expected in ../extension/)")


def today():
    return dt.date.today().isoformat()


class Store:
    """Settings, campaign memory, today's counts and the activity log, as plain files."""

    def __init__(self, folder=None):
        self.dir = pathlib.Path(folder) if folder else app_dir()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.settings = {**DEFAULT_SETTINGS, **self._read("settings.json", {})}
        self.campaign = self._read("campaign.json", None) or {"id": dt.datetime.now().isoformat(), "doneIds": []}
        self._stats = self._read("stats.json", {})
        self.log_path = self.dir / "activity-log.csv"

    def _read(self, name, default):
        try:
            return json.loads((self.dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _write(self, name, value):
        tmp = self.dir / (name + ".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.dir / name)

    def save_settings(self):
        self._write("settings.json", self.settings)

    def save_campaign(self):
        self._write("campaign.json", self.campaign)

    def new_campaign(self):
        self.campaign = {"id": dt.datetime.now().isoformat(), "doneIds": []}
        self.save_campaign()

    def stats(self):
        if self._stats.get("date") != today():
            self._stats = {"date": today(), "sent": 0, "excluded": 0, "skipped": 0, "failed": 0, "unknown": 0, "test": 0}
        return self._stats

    def bump(self, key):
        self.stats()[key] = self.stats().get(key, 0) + 1
        self._write("stats.json", self._stats)

    def add_log(self, entry):
        new = not self.log_path.exists()
        with self.log_path.open("a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "name", "status", "reason"])
            w.writerow([entry.get("time", ""), entry.get("name", ""), entry.get("status", ""), entry.get("reason", "")])

    def recent_log(self, n=300):
        try:
            with self.log_path.open(newline="", encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            return rows[-n:]
        except OSError:
            return []


class Controller:
    def __init__(self, store, on_event=None):
        self.store = store
        self.on_event = on_event or (lambda kind, data: None)
        self.state = {"state": "idle", "reason": ""}
        self.pw = self.ctx = self.page = None
        self.done_ids = set()
        self._watch = None
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="playwright", daemon=True).start()
        self.engine_js = engine_source()

    # ---------- public, callable from any thread ----------
    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def open_browser(self, **kw):
        return self.submit(self._open(**kw))

    def start(self):
        return self.submit(self._start())

    def pause(self):
        return self.submit(self._eval("FollowUpEngine.pause()"))

    def resume(self):
        return self.submit(self._eval("FollowUpEngine.resume()"))

    def stop(self):
        return self.submit(self._eval("FollowUpEngine.stop()"))

    def diagnose(self):
        return self.submit(self._tool("cfg => FollowUpEngine.tools.diagnose(cfg)"))

    def load_inbox(self):
        """Starts scrolling the inbox down in the background; progress arrives as "scroll" events."""
        return self.submit(self._start_scroll())

    def pause_scroll(self):
        return self.submit(self._eval("FollowUpEngine.tools.pauseScroll()"))

    def resume_scroll(self):
        return self.submit(self._eval("FollowUpEngine.tools.resumeScroll()"))

    def stop_scroll(self):
        return self.submit(self._eval("FollowUpEngine.tools.stopScroll()"))

    def scroll_latest(self):
        return self.submit(self._tool("cfg => FollowUpEngine.tools.scrollChatToLatest(cfg)"))

    def close(self):
        fut = self.submit(self._close())
        try:
            fut.result(timeout=10)
        except Exception:
            pass

    # ---------- internals (run on the Playwright thread) ----------
    def _emit(self, kind, data=None):
        try:
            self.on_event(kind, data)
        except Exception:
            pass

    async def _open(self, url=INBOX_URL, channel="chrome", headless=False, viewport=None, setup=None):
        from playwright.async_api import async_playwright
        if self.ctx:
            page = self.page or (self.ctx.pages[0] if self.ctx.pages else await self.ctx.new_page())
            if url and asset_id(url) and asset_id(page.url) != asset_id(url):
                await page.goto(url)
            await page.bring_to_front()
            self._emit("browser", "open")
            return "already open"
        self.pw = await async_playwright().start()
        profile = self.store.dir / "chrome-profile"
        kw = {"headless": headless, "args": ["--start-maximized"]}
        if viewport:
            kw["viewport"] = viewport
        else:
            kw["no_viewport"] = True
        try:
            self.ctx = await self.pw.chromium.launch_persistent_context(str(profile), channel=channel, **kw)
        except Exception as first:
            if not channel:
                raise
            try:  # Chrome not found: fall back to Playwright's own Chromium if it is installed
                self.ctx = await self.pw.chromium.launch_persistent_context(str(profile), **kw)
            except Exception:
                raise RuntimeError("Google Chrome was not found. Install Chrome, then try again.") from first
        self.ctx.on("close", lambda _: self._on_closed())
        await self.ctx.expose_function("fuHook", self._hook)
        await self.ctx.add_init_script(script=self.engine_js)
        if setup:
            await setup(self.ctx)
        self.page = self.ctx.pages[0] if self.ctx.pages else await self.ctx.new_page()
        await self.page.goto(url)
        self._emit("browser", "open")
        return "opened"

    def _on_closed(self):
        self.ctx = self.page = None
        self.state = {"state": "idle", "reason": "Chrome was closed"}
        self._emit("browser", "closed")
        self._emit("state", self.state)

    async def _close(self):
        if self.ctx:
            await self.ctx.close()
        if self.pw:
            await self.pw.stop()
        self.ctx = self.page = self.pw = None

    async def _inbox_page(self):
        if not self.ctx:
            raise RuntimeError("Open Chrome first (button 1).")
        pages = [p for p in self.ctx.pages if "business.facebook.com" in p.url]
        page = next((p for p in pages if "/inbox" in p.url), None) or (pages[0] if pages else self.page)
        self.page = page
        if not await page.evaluate("!!window.FollowUpEngine"):
            await page.evaluate(self.engine_js)
        return page

    async def _eval(self, js):
        page = await self._inbox_page()
        return await page.evaluate(js)

    def engine_config(self):
        s = self.store.settings
        cfg = {k: s[k] for k in ENGINE_KEYS}
        cfg["template"] = s["template"]
        cfg["image"] = None
        path = s.get("image_path") or ""
        if path:
            p = pathlib.Path(path)
            if not p.exists():
                raise RuntimeError(f"The image file is missing: {path}")
            mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
            cfg["image"] = {"native": True, "name": p.name,
                            "dataUrl": f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()}
        return cfg

    async def _tool(self, js):
        page = await self._inbox_page()
        return await page.evaluate(js, self.engine_config())

    async def _start_scroll(self):
        page = await self._inbox_page()
        if await page.evaluate("FollowUpEngine.tools.scrollState()") != "idle":
            raise RuntimeError("Already scrolling.")
        if self.state.get("state") in ("running", "paused"):
            raise RuntimeError("Stop the sending run first.")
        cfg = {k: self.store.settings[k] for k in ENGINE_KEYS}
        if not (await page.evaluate("cfg => FollowUpEngine.tools.diagnose(cfg)", cfg))["inboxList"]:
            raise RuntimeError("Can't find the inbox list. Open Business Suite → Inbox.")
        await page.evaluate("cfg => { FollowUpEngine.tools.loadWholeInbox(cfg, (p) => window.fuHook('scroll', p)); return true; }", cfg)
        return "scrolling"

    async def _start(self):
        page = await self._inbox_page()
        if "/inbox" not in page.url:
            raise RuntimeError("Open the Inbox in Business Suite first.")
        saved, here = asset_id(self.store.settings.get("inboxUrl", "")), asset_id(page.url)
        if saved and here and saved != here:
            raise RuntimeError(f"The open inbox is a different Facebook Page (id {here}) than your saved link (id {saved}). "
                               "Press “Open Chrome” to go to your saved inbox.")
        if not self.store.settings.get("template", "").strip():
            raise RuntimeError("Write your follow-up message first.")
        self.done_ids = set(self.store.campaign["doneIds"])
        await page.evaluate("cfg => FollowUpEngine.startWithBridge(cfg)", self.engine_config())
        self.state = {"state": "running", "reason": ""}
        self._emit("state", self.state)
        if not self._watch or self._watch.done():
            self._watch = asyncio.ensure_future(self._watchdog(page))
        return "started"

    async def _watchdog(self, page):
        """Notices when the page reloads or closes mid-run (the engine then stops existing)."""
        while self.state.get("state") in ("running", "paused"):
            await asyncio.sleep(2)
            try:
                st = await page.evaluate("window.FollowUpEngine ? FollowUpEngine.status() : 'gone'")
            except Exception:
                st = "gone"
            if st in ("gone", "idle") and self.state.get("state") in ("running", "paused"):
                self.state = {"state": "stopped", "reason": "The page reloaded or closed, so the run stopped. Press Start to continue."}
                self._emit("state", self.state)

    async def _hook(self, name, payload=None):
        if name == "log":
            self.store.add_log(payload)
            key = COUNTER.get(payload.get("status"))
            if key and key != "sent":
                self.store.bump(key)
            self._emit("log", payload)
            self._emit("stats", self.store.stats())
            return None
        if name == "scroll":
            self._emit("scroll", payload)
            return None
        if name == "state":
            self.state = payload
            self._emit("state", payload)
            return None
        if name == "alreadyDone":
            return payload in self.done_ids
        if name == "markDone":
            if payload not in self.done_ids:
                self.done_ids.add(payload)
                self.store.campaign["doneIds"].append(payload)
                self.store.save_campaign()
            return None
        if name == "sentToday":
            return self.store.stats()["sent"]
        if name == "onSent":
            self.store.bump("sent")
            self._emit("stats", self.store.stats())
            return None

        page = self.page
        if name == "native.click":
            await page.mouse.click(payload["x"], payload["y"])
            return True
        if name == "native.hover":
            await page.mouse.move(payload["x"], payload["y"])
            return True
        if name == "native.typeText":
            for i, line in enumerate(str(payload).split("\n")):
                if i:
                    await page.keyboard.press("Shift+Enter")
                if line:
                    await page.keyboard.insert_text(line)
            return True
        if name == "native.key":
            await page.keyboard.press(payload)
            return True
        if name == "native.attach":
            path = self.store.settings.get("image_path")
            if not path or not os.path.exists(path):
                return False
            file_input = page.locator("[data-fu-file]")
            if await file_input.count():
                await file_input.first.set_input_files(path)
                return True
            button = page.locator("[data-fu-attach]")
            if await button.count():
                async with page.expect_file_chooser(timeout=5000) as chooser:
                    await button.first.click()
                await (await chooser.value).set_files(path)
                return True
            return False
        raise ValueError("unknown hook " + name)
