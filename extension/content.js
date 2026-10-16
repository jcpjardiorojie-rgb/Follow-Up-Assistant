// Runs inside the Business Suite tab. Connects the side panel to the engine and saves progress.
(() => {
  if (window.__fuContentLoaded) return;
  window.__fuContentLoaded = true;
  const E = window.FollowUpEngine;
  const LOG_MAX = 2000;

  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const freshStats = () => ({ date: today(), sent: 0, excluded: 0, skipped: 0, failed: 0, unknown: 0, test: 0 });

  let data = null; // in-memory copy of storage while running
  let saveTimer = null;
  let lastState = { state: "idle", reason: "" };

  async function load() {
    const d = await chrome.storage.local.get(["settings", "template", "campaign", "stats", "log"]);
    const stats = d.stats && d.stats.date === today() ? d.stats : freshStats();
    return {
      settings: Object.assign({}, E.DEFAULTS, d.settings || {}),
      template: d.template || { text: E.DEFAULTS.template, imageDataUrl: "", imageName: "" },
      campaign: d.campaign || { id: Date.now(), doneIds: [] },
      stats,
      log: d.log || [],
    };
  }
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      if (!data) return;
      if (data.log.length > LOG_MAX) data.log = data.log.slice(-LOG_MAX);
      chrome.storage.local.set({ campaign: data.campaign, stats: data.stats, log: data.log });
    };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  }
  function tell(msg) {
    chrome.runtime.sendMessage(Object.assign({ type: "fu-status" }, msg)).catch(() => {});
  }
  function rollDay() {
    if (data.stats.date !== today()) data.stats = freshStats();
  }

  const COUNTER = { SENT: "sent", EXCLUDED: "excluded", SKIPPED: "skipped", FAILED: "failed", REVIEW: "failed", UNKNOWN: "unknown", TEST: "test" };

  function hooks(doneSet) {
    return {
      log(e) {
        rollDay();
        const k = COUNTER[e.status];
        if (k && k !== "sent") data.stats[k]++;
        data.log.push({ time: e.time, name: e.name, status: e.status, reason: e.reason });
        save();
        tell({ entry: e, stats: data.stats });
      },
      state(s) {
        lastState = s;
        tell({ state: s, stats: data && data.stats });
        if (s.state !== "running") save(true);
      },
      alreadyDone: (id) => doneSet.has(id),
      markDone(id) { if (!doneSet.has(id)) { doneSet.add(id); data.campaign.doneIds.push(id); save(); } },
      sentToday() { rollDay(); return data.stats.sent; },
      onSent() { rollDay(); data.stats.sent++; save(); },
    };
  }

  async function start() {
    if (!location.pathname.includes("/inbox")) return { ok: false, message: "Open the Inbox in Business Suite first." };
    data = await load();
    const t = data.template;
    if (!t.text || !t.text.trim()) return { ok: false, message: "Write your follow-up message first." };
    const cfg = Object.assign({}, data.settings, {
      template: t.text,
      image: t.imageDataUrl ? { dataUrl: t.imageDataUrl, name: t.imageName || "image.jpg" } : null,
    });
    try {
      E.start(cfg, hooks(new Set(data.campaign.doneIds)));
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // Small note at the bottom of the page, so a keyboard shortcut shows it worked.
  function toast(text) {
    let el = document.getElementById("fu-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "fu-toast";
      el.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#0e6b58;color:#fff;" +
        "font:600 14px/1.3 'Segoe UI',system-ui,sans-serif;padding:10px 16px;border-radius:8px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;transition:opacity .3s";
      document.documentElement.appendChild(el);
    }
    el.textContent = "FollowUp: " + text;
    el.style.opacity = "1";
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.style.opacity = "0"; }, 2500);
  }

  // "Scroll inbox to the bottom": runs in the background; progress goes to the side panel.
  async function startScroll() {
    if (["running", "paused"].includes(E.status())) return { ok: false, message: "Stop the sending run first." };
    const s = (await load()).settings;
    if (!E.tools.diagnose(s).inboxList) return { ok: false, message: "Can't find the inbox list. Open Business Suite → Inbox." };
    E.tools.loadWholeInbox(s, (p) => tell({ scroll: p }));
    return { ok: true, message: "Scrolling the inbox down…" };
  }
  async function toggleRun() {
    const st = E.status();
    if (st === "running") { E.pause(); return { ok: true, message: "Paused" }; }
    if (st === "paused") { E.resume(); return { ok: true, message: "Resumed" }; }
    const r = await start();
    return r.ok ? { ok: true, message: "Started" } : r;
  }
  async function toggleScroll() {
    const st = E.tools.scrollState();
    if (st === "running") { E.tools.pauseScroll(); return { ok: true, message: "Scrolling paused" }; }
    if (st === "paused") { E.tools.resumeScroll(); return { ok: true, message: "Scrolling resumed" }; }
    return startScroll();
  }
  function stopAll() {
    const was = E.status(), scrolling = E.tools.scrollState() !== "idle";
    E.stop();
    return { ok: true, message: scrolling ? "Scrolling stopped" : ["running", "paused"].includes(was) ? "Stopped" : "Nothing to stop" };
  }
  const withToast = (fn) => async () => { const r = await fn(); toast(r.message || (r.ok ? "Done" : "Didn't work")); return r; };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.to !== "content") return;
    (async () => {
      switch (msg.cmd) {
        case "ping": return { ok: true, state: E.status(), last: lastState };
        case "start": return start();
        case "pause": E.pause(); return { ok: true };
        case "resume": E.resume(); return { ok: true };
        case "stop": E.stop(); return { ok: true };
        case "loadInbox": return startScroll();
        case "pauseScroll": return { ok: E.tools.pauseScroll() };
        case "resumeScroll": return { ok: E.tools.resumeScroll() };
        case "stopScroll": return { ok: E.tools.stopScroll() };
        case "scrollState": return { ok: true, state: E.tools.scrollState() };
        // keyboard shortcuts
        case "toggleRun": return withToast(toggleRun)();
        case "toggleScroll": return withToast(toggleScroll)();
        case "stopAll": return withToast(async () => stopAll())();
        case "scrollLatestShortcut": return withToast(async () => E.tools.scrollChatToLatest((await load()).settings))();
        case "scrollLatest": return E.tools.scrollChatToLatest((await load()).settings);
        case "diagnose": return { ok: true, report: E.tools.diagnose((await load()).settings) };
        default: return { ok: false, message: "Unknown command" };
      }
    })().then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
    return true; // reply asynchronously
  });
})();
