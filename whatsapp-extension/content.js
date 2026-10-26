// Runs inside the WhatsApp Web tab. Connects the side panel to the engine and saves progress.
(() => {
  if (window.__waContentLoaded) return;
  window.__waContentLoaded = true;
  const E = window.WAEngine;
  const LOG_MAX = 3000;
  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const freshStats = () => ({ date: today(), sent: 0, skipped: 0, failed: 0, test: 0 });

  let data = null;
  let saveTimer = null;
  let lastState = { state: "idle", reason: "" };

  // ---------- daily limit: a warm-up plan that grows by itself, or the same number every day ----------
  // Day number = days you already sent on (before today) + 1.
  function planLimit(s, days) {
    if (s.limitMode === "fixed") return Math.max(1, Math.round(+s.dailyCap || 1));
    const t = today();
    const d = (days || []).filter((x) => x < t).length + 1;
    const r = (s.ramp || E.DEFAULTS.ramp).map((x) => Math.max(1, Math.round(+x || 1)));
    return d <= 3 ? r[0] : d <= 6 ? r[1] : d <= 13 ? r[2] : d <= 20 ? r[3] : r[4];
  }
  function limitInfo(d) {
    const s = d.settings;
    const t = today();
    const day = (d.days || []).filter((x) => x < t).length + 1;
    const plan = planLimit(s, d.days);
    const own = d.todayOverride && d.todayOverride.date === t && +d.todayOverride.n > 0 ? Math.round(+d.todayOverride.n) : 0;
    return { day, plan, own, limit: own || plan, sent: d.stats.date === t ? d.stats.sent : 0 };
  }

  async function load() {
    const d = await chrome.storage.local.get(["settings", "templates", "activeTemplate", "campaign", "stats", "log", "problems", "days", "todayOverride", "events"]);
    const templates = d.templates && d.templates.length ? d.templates : [{ id: "t1", name: "Message 1", text: E.DEFAULTS.template, imageDataUrl: "", imageName: "" }];
    return {
      settings: Object.assign({}, E.DEFAULTS, d.settings || {}),
      tpl: templates.find((t) => t.id === d.activeTemplate) || templates[0],
      campaign: d.campaign || { id: Date.now(), doneKeys: [] },
      stats: d.stats && d.stats.date === today() ? d.stats : freshStats(),
      log: d.log || [],
      problems: d.problems || [],
      days: d.days || [],
      todayOverride: d.todayOverride || null,
      events: d.events || [],
    };
  }
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      if (!data) return;
      if (data.log.length > LOG_MAX) data.log = data.log.slice(-LOG_MAX);
      if (data.problems.length > 300) data.problems = data.problems.slice(-300);
      if (data.events.length > 1000) data.events = data.events.slice(-1000);
      chrome.storage.local.set({ campaign: data.campaign, stats: data.stats, log: data.log, problems: data.problems, days: data.days, events: data.events });
    };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  }
  function tell(msg) { chrome.runtime.sendMessage(Object.assign({ type: "wa-status" }, msg)).catch(() => {}); }
  // A short diary of what happened (for "Copy for Claude").
  function event(k, m) {
    if (!data) return;
    data.events.push({ t: new Date().toISOString(), k, m: String(m || "") });
    save();
  }

  let awake = false;
  function keepAwake(on) {
    on = !!on && !(data && data.settings && data.settings.keepAwake === false);
    if (on === awake) return;
    awake = on;
    chrome.runtime.sendMessage({ type: "wa-awake", on }).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (["running", "paused"].includes(E.status())) event("SCREEN", document.hidden ? "WhatsApp Web hidden" : "WhatsApp Web visible again");
  });

  const COUNTER = { SKIPPED: "skipped", FAILED: "failed", REVIEW: "failed", UNKNOWN: "failed", TEST: "test" };
  const BAD = new Set(["FAILED", "REVIEW", "UNKNOWN"]);
  function rollDay() { if (data.stats.date !== today()) data.stats = freshStats(); }

  function hooks(doneSet) {
    return {
      log(e) {
        rollDay();
        const k = COUNTER[e.status];
        if (k) data.stats[k] = (data.stats[k] || 0) + 1;
        const entry = { time: e.time, name: e.name, status: e.status, reason: e.reason };
        data.log.push(entry);
        if (BAD.has(e.status)) data.problems.push({ time: e.time, name: e.name, status: e.status, reason: e.reason, code: e.code || "ERROR", help: e.help || E.HELP.ERROR });
        save();
        tell({ entry, stats: data.stats, limit: limitInfo(data) });
      },
      state(s) {
        const was = lastState;
        lastState = s;
        tell({ state: s, stats: data && data.stats, limit: data && limitInfo(data) });
        if (s.state === "paused") {
          event("PAUSE", s.reason);
          if (data.settings.notifyOnPause && was.state === "running" && /problems in a row|WhatsApp shows|chat list/.test(s.reason || "")) notify("FollowUp paused", s.reason);
        } else if (s.state === "running" && s.code === "hidden") event("WAIT", s.reason);
        if ((s.state === "finished" || s.state === "stopped") && was.state !== s.state) {
          event(s.state === "finished" ? "FINISH" : "STOP", `${s.reason} · ${data.stats.sent} sent today`);
          save(true);
          keepAwake(false);
          if (s.state === "finished" || s.code === "warning") finished(s);
        }
      },
      alreadyDone: (key) => doneSet.has(key),
      markDone(key) { if (!doneSet.has(key)) { doneSet.add(key); data.campaign.doneKeys.push(key); save(); } },
      onSent() {
        rollDay();
        data.stats.sent++;
        if (!data.days.includes(today())) data.days.push(today());
        save();
      },
    };
  }

  async function start() {
    data = await load();
    const t = data.tpl;
    if (!t.text || !t.text.trim()) return { ok: false, message: "Write your follow-up message first." };
    const lim = limitInfo(data);
    const left = lim.limit - lim.sent;
    if (left <= 0 && !data.settings.testMode) return { ok: false, message: `Today's limit (${lim.limit}) is reached: ${lim.sent} sent today. To send more today, change “Today only” in Settings → 3.` };
    const cfg = Object.assign({}, data.settings, {
      template: t.text,
      image: t.imageDataUrl ? { dataUrl: t.imageDataUrl, name: t.imageName || "image.jpg" } : null,
      capLeft: data.settings.testMode ? Infinity : left,
      todayLimit: lim.limit,
    });
    try {
      E.start(cfg, hooks(new Set(data.campaign.doneKeys)));
      const s = data.settings;
      event("RUN", `Started · “${t.name}” · ${s.order === "bottom" ? "oldest first" : "newest first"} · today ${lim.sent}/${lim.limit} (day ${lim.day}${lim.own ? ", your own number today" : ""}) · gap ${s.gapMinSec}–${s.gapMaxSec} s · image ${t.imageDataUrl ? (s.imageStyle === "one" ? "one bubble" : "two bubbles") : "none"} · unsaved: “${s.unsavedWord}”${s.useTildeName ? " (~name on)" : ""}${s.testMode ? " · TEST MODE" : ""} · version ${chrome.runtime.getManifest().version}`);
      keepAwake(true);
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  }

  // ---------- notifications ----------
  async function notify(title, message) {
    const s = (data && data.settings) || E.DEFAULTS;
    if (!s.notifyPC && !s.notifyPhone) return { ok: true };
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "wa-notify", title, message, pc: !!s.notifyPC, phone: !!s.notifyPhone, topic: s.ntfyTopic || "", server: s.ntfyServer || "https://ntfy.sh" }); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (r && r.phoneOk === false && data) {
      data.problems.push({ time: new Date().toISOString(), name: "Phone notification", status: "FAILED", reason: r.error || "", code: "NOTIFY_FAILED", help: E.HELP.NOTIFY_FAILED });
      save(true);
    }
    return r || { ok: false };
  }

  // ---------- "When the run is finished": countdown, then close the tab, close Chrome or shut down ----------
  const FINISH_TEXT = { closeTab: "close the WhatsApp Web tab", closeChrome: "close Chrome", shutdown: "shut down the computer" };
  let finishTimer = null, finishEnd = 0, finishAction = null;
  function finishBox() {
    let el = document.getElementById("wa-finish");
    if (el) return el;
    el = document.createElement("div");
    el.id = "wa-finish";
    el.style.cssText = "position:fixed;left:50%;top:30%;transform:translateX(-50%);z-index:2147483647;background:#fff;color:#18211d;" +
      "border:3px solid #a83636;border-radius:12px;padding:18px 24px;font:15px/1.4 'Segoe UI',system-ui,sans-serif;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35);min-width:300px";
    el.innerHTML = '<div id="wa-finish-title" style="font-weight:600"></div><div id="wa-finish-left" style="font:800 40px/1.2 \'Segoe UI\',sans-serif;color:#a83636;margin:6px 0"></div>' +
      '<div id="wa-finish-what"></div><div style="display:flex;gap:8px;justify-content:center;margin-top:12px">' +
      '<button id="wa-finish-cancel" style="font:600 15px \'Segoe UI\',sans-serif;padding:8px 18px;border-radius:8px;border:0;background:#0e6b58;color:#fff;cursor:pointer">Cancel</button>' +
      '<button id="wa-finish-now" style="font:15px \'Segoe UI\',sans-serif;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer">Do it now</button></div>';
    document.documentElement.appendChild(el);
    el.querySelector("#wa-finish-cancel").addEventListener("click", () => cancelFinish());
    el.querySelector("#wa-finish-now").addEventListener("click", () => doFinish());
    return el;
  }
  function startFinish(action, secs) {
    if (!FINISH_TEXT[action]) return;
    cancelFinish(true);
    finishAction = action;
    finishEnd = Date.now() + Math.max(5, +secs || 60) * 1000;
    event("AFTER", `Countdown ${Math.max(5, +secs || 60)} s, then ${FINISH_TEXT[action]}`);
    keepAwake(true);
    const box = finishBox();
    box.querySelector("#wa-finish-title").textContent = `FollowUp for WhatsApp finished · ${data.stats.sent} sent today`;
    const tick = () => {
      if (!finishAction) return;
      const left = Math.max(0, Math.ceil((finishEnd - Date.now()) / 1000));
      box.querySelector("#wa-finish-left").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      box.querySelector("#wa-finish-what").textContent = `Then FollowUp will ${FINISH_TEXT[action]}.`;
      tell({ finish: { left, action, text: `In ${left} s: ${FINISH_TEXT[action]}` } });
      if (left <= 0) { doFinish(); return; }
      finishTimer = setTimeout(tick, 500);
    };
    tick();
  }
  function cancelFinish(silent) {
    clearTimeout(finishTimer);
    const el = document.getElementById("wa-finish");
    if (el) el.remove();
    if (!silent && finishAction) { tell({ finish: { cancelled: true } }); event("AFTER", "Countdown cancelled by you"); keepAwake(false); }
    finishAction = null;
  }
  async function doFinish() {
    const action = finishAction;
    if (!action) return;
    cancelFinish(true);
    tell({ finish: { done: true, action } });
    save(true);
    event("AFTER", `Doing it now: ${FINISH_TEXT[action]}`);
    await new Promise((r) => setTimeout(r, 400));
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "wa-finish-action", action }); } catch (e) { r = { ok: false, message: String(e && e.message || e) }; }
    if (r && r.ok === false) {
      const help = r.code === "SHUTDOWN_HELPER" ? E.HELP.SHUTDOWN_HELPER : E.HELP.ERROR;
      data.problems.push({ time: new Date().toISOString(), name: "When finished", status: "FAILED", reason: r.message || "", code: r.code || "ERROR", help });
      event("PROBLEM", `When finished: couldn't ${FINISH_TEXT[action]} (${r.message || r.code || "error"})`);
      save(true);
      keepAwake(false);
      tell({ finish: { failed: true, message: help.what } });
    }
  }
  function finished(s) {
    const set = data.settings;
    const code = s.code || "end";
    let action = set.whenFinished;
    const allowed = code === "daily" ? !!set.finishOnDaily : code === "warning" ? true : set.finishOnEnd !== false;
    if (action !== "nothing" && !allowed) { event("AFTER", `Not doing it: this run ended by ${code === "daily" ? "today's limit" : "running out of chats"}, which is switched off in Settings → 5.`); action = "nothing"; }
    let msg = `${data.stats.sent} sent today. ${s.reason || ""}`;
    if (action !== "nothing") msg += ` Then: ${FINISH_TEXT[action]} in ${set.finishCountdownSec} s, unless you press Cancel.`;
    notify(code === "warning" ? "FollowUp stopped: WhatsApp warning" : "FollowUp finished", msg);
    if (action === "nothing") return;
    startFinish(action, set.finishCountdownSec);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.to !== "wa-content") return;
    (async () => {
      switch (msg.cmd) {
        case "ping": {
          const d = data && ["running", "paused"].includes(E.status()) ? data : await load();
          return { ok: true, state: E.status(), last: lastState, stats: d.stats, limit: limitInfo(d) };
        }
        case "start": return start();
        case "pause": E.pause(); return { ok: true };
        case "resume": E.resume(); return { ok: true };
        case "stop": E.stop(); return { ok: true };
        case "diagnose": return { ok: true, report: E.tools.diagnose((await load()).settings) };
        case "limit": return { ok: true, limit: limitInfo(await load()) };
        case "testNotify": data = data || (await load()); data.settings = Object.assign({}, E.DEFAULTS, msg.settings || data.settings); return notify("FollowUp test", "Notifications work. You'll get one like this when a run finishes.");
        case "cancelFinish": cancelFinish(); return { ok: true };
        case "finishNow": doFinish(); return { ok: true };
        case "finishState": return { ok: true, action: finishAction, left: finishAction ? Math.max(0, Math.ceil((finishEnd - Date.now()) / 1000)) : 0 };
        default: return { ok: false, message: "Unknown command" };
      }
    })().then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
    return true;
  });
})();
