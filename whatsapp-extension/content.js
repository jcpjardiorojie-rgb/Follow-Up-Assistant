// Runs inside the WhatsApp Web tab. Connects the side panel to the engine, saves progress,
// keeps the run diary (Log), saves names to your PC, and answers replies (Buyers tab).
(() => {
  if (window.__waContentLoaded) return;
  window.__waContentLoaded = true;
  const E = window.WAEngine;
  const LOG_MAX = 3000;
  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const freshStats = () => ({ date: today(), sent: 0, skipped: 0, already: 0, failed: 0, test: 0, replies: 0 });

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
    const t = today();
    const day = (d.days || []).filter((x) => x < t).length + 1;
    const plan = planLimit(d.settings, d.days);
    const own = d.todayOverride && d.todayOverride.date === t && +d.todayOverride.n > 0 ? Math.round(+d.todayOverride.n) : 0;
    return { day, plan, own, limit: own || plan, sent: d.stats.date === t ? d.stats.sent : 0 };
  }

  async function load() {
    const d = await chrome.storage.local.get(["settings", "templates", "activeTemplate", "campaign", "stats", "log", "problems", "days",
      "todayOverride", "contacts", "history", "replies"]);
    const templates = d.templates && d.templates.length ? d.templates : [{ id: "t1", name: "Message 1", text: E.DEFAULTS.template, imageDataUrl: "", imageName: "" }];
    return {
      settings: Object.assign({}, E.DEFAULTS, d.settings || {}),
      tpl: templates.find((t) => t.id === d.activeTemplate) || templates[0],
      campaign: d.campaign || { id: Date.now(), doneKeys: [] },
      stats: Object.assign(freshStats(), d.stats && d.stats.date === today() ? d.stats : {}),
      log: d.log || [],
      problems: d.problems || [],
      days: d.days || [],
      todayOverride: d.todayOverride || null,
      contacts: d.contacts || {}, // { name: { name, sentAt, message, text, reply, kind, replyAt, replyPending, answeredFor, labeled } }
      history: d.history || {}, // { messageId: { name: date sent } }, kept per saved message
      replies: Object.assign({}, E.DEFAULT_REPLIES, d.replies || {}),
    };
  }
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      if (!data) return;
      if (data.log.length > LOG_MAX) data.log = data.log.slice(-LOG_MAX);
      if (data.problems.length > 300) data.problems = data.problems.slice(-300);
      chrome.storage.local.set({ campaign: data.campaign, stats: data.stats, log: data.log, problems: data.problems, days: data.days,
        contacts: data.contacts, history: data.history });
    };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  }
  function tell(msg) { chrome.runtime.sendMessage(Object.assign({ type: "wa-status" }, msg)).catch(() => {}); }
  function addProblem(name, code, reason) {
    if (!data) return;
    data.problems.push({ time: new Date().toISOString(), name, status: "FAILED", reason: reason || "", code, help: E.HELP[code] || E.HELP.ERROR });
    save(true);
    tell({ problem: true });
  }

  // ---------- Log (W2): what happened and when, kept 30 days, also after a restart ----------
  const DIARY_DAYS = 30, DIARY_MAX = 20000;
  let diaryBuf = [], fileBuf = [], diaryTimer = null, run = null, lastBeat = Date.now();
  function diary(k, m) {
    const e = { t: new Date().toISOString(), k, m: String(m == null ? "" : m), run: run ? run.id : null };
    diaryBuf.push(e); fileBuf.push(e);
    tell({ diary: e });
    clearTimeout(diaryTimer);
    diaryTimer = setTimeout(flushDiary, 1200);
  }
  async function flushDiary() {
    if (!diaryBuf.length) return;
    const add = diaryBuf; diaryBuf = [];
    const { diary: old = [] } = await chrome.storage.local.get("diary");
    const cut = new Date(Date.now() - DIARY_DAYS * 86400000).toISOString();
    const all = old.concat(add).filter((e) => e.t >= cut);
    await chrome.storage.local.set({ diary: all.slice(-DIARY_MAX) });
  }
  const folder = (s) => {
    const base = String(s.backupFolder || "D:\\FollowUp-History").replace(/[\\/]+$/, "");
    const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
    return base + sep + "WhatsApp - " + (String(s.accountName || "WhatsApp").replace(/[\\/:*?"<>|]+/g, " ").trim() || "WhatsApp");
  };
  async function fileOp(msg) {
    try { return await chrome.runtime.sendMessage(Object.assign({ type: "wa-file" }, msg)); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  // The day's Log also goes to a file on your PC: log-YYYY-MM-DD.txt (needs the Windows helper).
  async function flushDiaryFile() {
    if (!fileBuf.length) return;
    const s = (data && data.settings) || Object.assign({}, E.DEFAULTS, (await chrome.storage.local.get("settings")).settings || {});
    const lines = fileBuf; fileBuf = [];
    if (!s.backupOn || s.diaryToFile === false) return;
    const day = new Date().toLocaleDateString("en-CA");
    const text = lines.map((e) => `${new Date(e.t).toLocaleString()}  ${e.k.padEnd(8)} ${e.m}`).join("\r\n") + "\r\n";
    await fileOp({ action: "appendFile", folder: folder(s), name: `log-${day}.txt`, content: text });
  }
  setInterval(flushDiaryFile, 60000);
  const busy = () => ["running", "paused"].includes(E.status()) || E.tools.scrollState() !== "idle" || pageBusy || !!finishAction;
  // Gaps: if nothing ran for a few minutes, the PC was probably asleep or Chrome was frozen.
  setInterval(() => {
    const now = Date.now();
    if (busy() && now - lastBeat > 3 * 60000) diary("SLEEP?", `No activity for ${Math.round((now - lastBeat) / 60000)} min (PC asleep, screen locked, or Chrome frozen)`);
    lastBeat = now;
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (busy()) diary("SCREEN", document.hidden ? "WhatsApp Web hidden (minimized, another tab, behind another window, or screen locked)" : "WhatsApp Web visible again");
  });
  async function saveRun(patch) {
    if (!run) return;
    Object.assign(run, patch);
    const { runs = [] } = await chrome.storage.local.get("runs");
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = Object.assign({}, run); else runs.push(Object.assign({}, run));
    await chrome.storage.local.set({ runs: runs.slice(-50) });
  }

  let awake = false;
  function keepAwake(on) {
    on = !!on && !(data && data.settings && data.settings.keepAwake === false);
    if (on === awake) return;
    awake = on;
    chrome.runtime.sendMessage({ type: "wa-awake", on }).catch(() => {});
    diary("AWAKE", on ? "Keeping the PC awake while FollowUp works" : "PC may sleep again (FollowUp is done)");
  }

  // ---------- names that got each message (W3), saved to a folder on your PC ----------
  let sinceBackup = 0, backupWarned = false;
  const csvCell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const fileNameFor = (t) => (String(t.name || "Message").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Message") + ".csv";
  function parseNames(csv) {
    const out = {};
    for (const line of String(csv || "").split(/\r?\n/).slice(1)) {
      const m = line.match(/^"((?:[^"]|"")*)","?([^",]*)"?/);
      if (m) out[m[1].replace(/""/g, '"')] = m[2];
    }
    return out;
  }
  // If Chrome forgot the names for this message (e.g. reinstalled), bring them back from the file.
  async function prepareHistory() {
    const t = data.tpl, s = data.settings;
    data.history[t.id] = data.history[t.id] || {};
    if (!s.backupOn || Object.keys(data.history[t.id]).length) return;
    let content = "", offset = 0;
    for (let i = 0; i < 40; i++) {
      const r = await fileOp({ action: "readFile", folder: folder(s), name: fileNameFor(t), offset });
      if (!r || !r.ok) return;
      content += r.content || ""; offset += (r.content || "").length;
      if (!r.more) break;
    }
    const names = parseNames(content);
    if (Object.keys(names).length) { data.history[t.id] = names; save(true); diary("INFO", `Names for “${t.name}” brought back from your PC (${Object.keys(names).length})`); }
  }
  async function setBackupStatus(st) { await chrome.storage.local.set({ backupStatus: st }); tell({ backup: st }); }
  async function backup(force) {
    if (!data) return { ok: false };
    const s = data.settings, t = data.tpl;
    if (!s.backupOn && !force) return { ok: true, skipped: true };
    const names = data.history[t.id] || {};
    const content = "Name,Date sent\r\n" + Object.entries(names).map(([n, d]) => csvCell(n) + "," + csvCell(d)).join("\r\n") + "\r\n";
    const r = await fileOp({ action: "saveFile", folder: folder(s), name: fileNameFor(t), content });
    sinceBackup = 0;
    if (r && r.ok) { await setBackupStatus({ ok: true, at: new Date().toISOString(), path: r.path, count: Object.keys(names).length }); return { ok: true, path: r.path }; }
    await setBackupStatus({ ok: false, at: new Date().toISOString(), error: (r && r.error) || "No answer" });
    if (!backupWarned) { backupWarned = true; addProblem("Save names", "BACKUP_FAILED", (r && r.error) || ""); }
    return { ok: false, message: E.HELP.BACKUP_FAILED.what + " " + E.HELP.BACKUP_FAILED.fix };
  }

  const COUNTER = { SKIPPED: "skipped", ALREADY: "already", FAILED: "failed", REVIEW: "failed", UNKNOWN: "failed", TEST: "test", REPLY: "replies" };
  const BAD = new Set(["FAILED", "REVIEW", "UNKNOWN"]);
  function rollDay() { if (data.stats.date !== today()) data.stats = freshStats(); }
  function logEntry(e) {
    rollDay();
    const k = COUNTER[e.status];
    if (k) data.stats[k] = (data.stats[k] || 0) + 1;
    const entry = { time: e.time, name: e.name, status: e.status, reason: e.reason };
    data.log.push(entry);
    if (BAD.has(e.status)) {
      data.problems.push({ time: e.time, name: e.name, status: e.status, reason: e.reason, code: e.code || "ERROR", help: e.help || E.HELP.ERROR });
      diary("PROBLEM", `${e.name}: ${e.reason}`);
    }
    if (run) {
      const c = { SENT: "sent", SKIPPED: "skipped", ALREADY: "already", FAILED: "problems", REVIEW: "problems", UNKNOWN: "problems", TEST: "test" }[e.status];
      if (c) run[c] = (run[c] || 0) + 1;
      if (run.sent && run.sent % 50 === 0 && e.status === "SENT") diary("PROGRESS", `${run.sent} sent so far in this run`);
    }
    save();
    tell({ entry, stats: data.stats, limit: limitInfo(data) });
  }

  function hooks(doneSet) {
    return {
      log: logEntry,
      state(s) {
        const was = lastState;
        lastState = s;
        lastBeat = Date.now();
        tell({ state: s, stats: data && data.stats, limit: data && limitInfo(data) });
        if (s.code === "scroll" || s.code === "visible") return;
        if (s.state === "paused") {
          diary("PAUSE", s.reason);
          if (data.settings.notifyOnPause && was.state === "running" && /problems in a row|WhatsApp shows|chat list/.test(s.reason || "")) notify("FollowUp paused", s.reason);
        } else if (s.state === "running" && s.code === "hidden") diary("WAIT", s.reason);
        else if (s.state === "running" && was.state === "paused" && s.reason === "Resumed") diary("RESUME", "Resumed");
        else if (s.state === "running" && s.reason && !s.current && was.reason !== s.reason && s.reason !== "Starting…") diary("INFO", s.reason);
        if ((s.state === "finished" || s.state === "stopped") && was.state !== s.state) {
          diary(s.state === "finished" ? "FINISH" : "STOP", `${s.reason} · this run: ${run ? run.sent || 0 : 0} sent, ${run ? run.skipped || 0 : 0} skipped, ${run ? run.problems || 0 : 0} problems · today: ${data.stats.sent} sent`);
          saveRun({ end: new Date().toISOString(), ended: s.reason || s.state, code: s.code || (s.state === "stopped" ? "stopped" : "") });
          save(true);
          backup();
          keepAwake(false);
          flushDiary();
          if (s.state === "finished" || s.code === "warning") finished(s);
        }
      },
      alreadyDone: (key) => doneSet.has(key),
      markDone(key) { if (!doneSet.has(key)) { doneSet.add(key); data.campaign.doneKeys.push(key); save(); } },
      nameSent: (name) => !!(data.history[data.tpl.id] || {})[name],
      onSent(row, text, replying) {
        rollDay();
        if (replying) return;
        data.stats.sent++;
        if (!data.days.includes(today())) data.days.push(today());
        // Remember who got which message: for the Buyers tab and the "Already messaged" check.
        const now = new Date().toISOString();
        const old = data.contacts[row.key] || {};
        data.contacts[row.key] = Object.assign(old, { name: row.name, sentAt: now, message: data.tpl.name, text, replyPending: false });
        (data.history[data.tpl.id] = data.history[data.tpl.id] || {})[row.name] = today();
        if (++sinceBackup >= Math.max(1, +data.settings.backupEvery || 25)) backup();
        save();
      },
    };
  }

  async function start() {
    if (E.tools.scrollState() !== "idle") return { ok: false, message: "The chat list is still scrolling. Stop the scrolling first, then press Start." };
    if (pageBusy) return { ok: false, message: "Answering replies right now. Press Start again in a moment." };
    data = await load();
    await prepareHistory();
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
      run = { id: Date.now(), start: new Date().toISOString(), message: t.name, sent: 0 };
      const order = { top: "newest first", bottom: "oldest first (all the way)", bottomFar: `oldest first (${s.scrollHow === "count" ? s.scrollCount + " scrolls" : "all the way"})`, screen: "lowest chat on screen" }[s.order] || s.order;
      diary("RUN", `Started · “${t.name}” · ${order} · today ${lim.sent}/${lim.limit} (day ${lim.day}${lim.own ? ", your own number today" : ""}) · gap ${s.gapMinSec}–${s.gapMaxSec} s · image ${t.imageDataUrl ? (s.imageStyle === "one" ? "one bubble" : "two bubbles") : "none"} · unsaved: “${s.unsavedWord}”${s.useTildeName ? " (~name on)" : ""} · Already messaged ${s.dupCheck ? "On" : "Off"} · When finished: ${s.whenFinished}${s.testMode ? " · TEST MODE" : ""} · account “${s.accountName}” · version ${chrome.runtime.getManifest().version}`);
      saveRun({});
      keepAwake(true);
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  }

  // ---------- notifications ----------
  async function notify(title, message, s) {
    s = s || (data && data.settings) || E.DEFAULTS;
    if (!s.notifyPC && !s.notifyPhone) return { ok: true };
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "wa-notify", title, message, pc: !!s.notifyPC, phone: !!s.notifyPhone, topic: s.ntfyTopic || "", server: s.ntfyServer || "https://ntfy.sh" }); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (r && r.phoneOk === false) addProblem("Phone notification", "NOTIFY_FAILED", r.error || "");
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
      '<button id="wa-finish-cancel" style="font:600 15px \'Segoe UI\',sans-serif;padding:8px 18px;border-radius:8px;border:0;background:#128c5e;color:#fff;cursor:pointer">Cancel</button>' +
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
    diary("AFTER", `Countdown ${Math.max(5, +secs || 60)} s, then ${FINISH_TEXT[action]}`);
    keepAwake(true);
    const box = finishBox();
    box.querySelector("#wa-finish-title").textContent = `WhatsApp FollowUp finished · ${data.stats.sent} sent today`;
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
    if (!silent && finishAction) { tell({ finish: { cancelled: true } }); diary("AFTER", "Countdown cancelled by you"); saveRun({ after: "Cancelled by you" }); keepAwake(false); }
    finishAction = null;
  }
  async function doFinish() {
    const action = finishAction;
    if (!action) return;
    cancelFinish(true);
    tell({ finish: { done: true, action } });
    save(true);
    diary("AFTER", `Doing it now: ${FINISH_TEXT[action]}`);
    await saveRun({ after: FINISH_TEXT[action] });
    await flushDiary();
    await flushDiaryFile();
    await new Promise((r) => setTimeout(r, 400));
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "wa-finish-action", action }); } catch (e) { r = { ok: false, message: String(e && e.message || e) }; }
    if (r && r.ok === false) {
      const code = r.code === "SHUTDOWN_HELPER" ? "SHUTDOWN_HELPER" : "ERROR";
      addProblem("When finished", code, r.message || "");
      diary("PROBLEM", `When finished: couldn't ${FINISH_TEXT[action]} (${r.message || r.code || "error"})`);
      saveRun({ after: `${FINISH_TEXT[action]} failed` });
      keepAwake(false);
      tell({ finish: { failed: true, message: E.HELP[code].what } });
    }
  }
  async function finished(s) {
    const set = data.settings;
    // One last reply round before the PC is closed or shut down.
    if (set.autoCheckReplies && set.whenFinished !== "nothing") { try { await replyRound({ auto: true, final: true }); } catch (_) {} }
    const code = s.code || "end";
    let action = set.whenFinished;
    const allowed = code === "daily" ? !!set.finishOnDaily : code === "already" ? set.finishOnAlready !== false : code === "warning" ? true : set.finishOnEnd !== false;
    if (action !== "nothing" && !allowed) {
      diary("AFTER", `Not doing it: this run ended by ${code === "daily" ? "today's limit" : code === "already" ? "reaching people who already got the message" : "running out of chats"}, which is switched off in Settings → When finished.`);
      saveRun({ after: "Nothing (not allowed for this ending)" });
      action = "nothing";
    }
    let msg = `${data.stats.sent} sent today. ${s.reason || ""}`;
    if (action !== "nothing") msg += ` Then: ${FINISH_TEXT[action]} in ${set.finishCountdownSec} s, unless you press Cancel.`;
    notify(code === "warning" ? "FollowUp stopped: WhatsApp warning" : "FollowUp finished", msg).then((r) => {
      if (set.notifyPC || set.notifyPhone) diary("NOTIFY", `Finished notification: ${[set.notifyPC && (r && r.pcOk !== false ? "PC ✓" : "PC ✗"), set.notifyPhone && (r && r.phoneOk ? "phone ✓" : "phone ✗")].filter(Boolean).join(" · ")}`);
    });
    if (action === "nothing") { saveRun({ after: "Nothing" }); return; }
    startFinish(action, set.finishCountdownSec);
  }

  // ---------- Buyers (W1): replies to your follow-up, sorted, with ready auto-replies ----------
  // Reply rounds can happen in the middle of a run: the run pauses after its current chat, the chat
  // list is put back where it was afterwards, and the run continues by itself.
  let pageBusy = false, stopReplies = false, lastAutoCheck = Date.now();
  const KIND_NAME = { hot: "🔥 Hot", warm: "🙂 Warm", cold: "❄️ Not interested", replied: "💬 Other" };
  function buyersTell(state, message) { tell({ buyers: { state, message } }); }
  async function withPage(note, fn) {
    if (pageBusy) return { ok: false, message: "Already working on it." };
    pageBusy = true;
    const wasRunning = E.status() === "running";
    let pausedByMe = false;
    try {
      if (wasRunning) {
        pausedByMe = await E.pauseAndWait(note + " (finishing the current chat first)");
        if (!pausedByMe) return { ok: false, message: "The run didn't pause in time. Try again in a moment." };
        tell({ state: { state: "paused", reason: note + " The run continues by itself after." } });
      }
      if (!data || !["running", "paused"].includes(E.status())) data = await load();
      else { const fresh = await load(); data.replies = fresh.replies; data.settings = Object.assign({}, data.settings, fresh.settings); }
      const pos = E.tools.listPosition();
      try { return await fn(); }
      finally { await E.tools.restoreListPosition(pos); }
    } finally {
      pageBusy = false;
      if (pausedByMe) E.resume();
    }
  }
  function pendingList() {
    return Object.entries(data.contacts).filter(([, c]) => c.replyPending).map(([key, c]) => ({ key, name: c.name, reply: c.reply, kind: c.kind }));
  }
  async function sendOne(c) {
    const r = data.replies[c.kind];
    if (!r || !r.text) return { status: "SKIPPED" };
    const res = await E.tools.sendReply(Object.assign({}, data.settings), { key: c.key, name: c.name }, r, { onSent() {} });
    const contact = data.contacts[c.key];
    if (res.status === "REPLY") {
      Object.assign(contact, { replyPending: false, answeredFor: contact.reply, repliedAt: new Date().toISOString() });
      res.reason = `Auto-reply (${KIND_NAME[c.kind]}) · ${res.reason}`;
    } else if (res.status === "SKIPPED") Object.assign(contact, { replyPending: false, answeredFor: contact.reply });
    logEntry(res);
    if (res.status === "REPLY" && c.kind === "hot" && data.settings.labelHot && !contact.labeled) await labelOne(c);
    return res;
  }
  async function labelOne(c) {
    const r = await E.tools.labelChat(data.settings, { key: c.key, name: c.name });
    if (r.ok) { data.contacts[c.key].labeled = true; diary("LABEL", `“${data.settings.labelName}” added to ${c.name}`); }
    else logEntry({ time: new Date().toISOString(), name: c.name, status: "FAILED", reason: "Label: " + (r.why || "failed"), code: r.code || "LABEL_FAILED", help: r.help || E.HELP.LABEL_FAILED });
    save();
    return r;
  }
  async function replyRound({ auto, final }) {
    stopReplies = false;
    const r = await withPage(auto ? "Checking replies…" : "Checking replies (you asked)…", async () => {
      buyersTell("busy", "Checking replies…");
      const keys = Object.keys(data.contacts).filter((k) => data.contacts[k].sentAt);
      if (!keys.length) return { ok: true, found: 0, sent: 0, message: "Nobody has your follow-up yet, so there are no replies to check." };
      const scan = await E.tools.scanReplies(data.settings, keys, (p) => buyersTell("busy", `Checking replies… ${p.checked} chats looked at, ${p.found} replies`), data.settings.autoCheckRows);
      if (!scan.ok) return scan;
      let sent = 0, fresh = 0;
      for (const f of scan.found) {
        const c = data.contacts[f.key];
        if (!c || c.answeredFor === f.reply || c.replySkipFor === f.reply) continue;
        if (c.reply !== f.reply) { fresh++; Object.assign(c, { reply: f.reply, kind: f.kind, replyAt: new Date().toISOString() }); }
        const tplR = data.replies[f.kind];
        if (!tplR || !tplR.on) { c.replyPending = false; continue; }
        if (data.settings.replyMode === "auto" && !stopReplies) {
          const res = await sendOne({ key: f.key, name: c.name, kind: f.kind });
          if (res.status === "REPLY") sent++;
        } else c.replyPending = true;
      }
      save(true);
      const pending = pendingList().length;
      const message = `${scan.found.length} replies (${fresh} new) · ${sent} answered${pending ? ` · ${pending} waiting for you to press Send` : ""}`;
      diary("REPLIES", (final ? "Last check before finishing: " : "") + message);
      return { ok: true, found: scan.found.length, sent, pending, message };
    });
    lastAutoCheck = Date.now();
    buyersTell("done", r.message || "");
    if (r.pending && data.settings.notifyPC) notify("Replies waiting", `${r.pending} people replied. Open the Buyers tab to send your replies.`);
    return r;
  }
  async function sendPending(keys) {
    stopReplies = false;
    const r = await withPage("Sending your replies…", async () => {
      const list = pendingList().filter((c) => !keys || keys.includes(c.key));
      let sent = 0;
      for (const c of list) {
        if (stopReplies) break;
        buyersTell("busy", `Replying to ${c.name}…`);
        const res = await sendOne(c);
        if (res.status === "REPLY") sent++;
      }
      save(true);
      return { ok: true, message: `${sent} replies sent` };
    });
    buyersTell("done", r.message || "");
    return r;
  }
  async function labelHotCmd() {
    const r = await withPage("Adding labels…", async () => {
      const hot = Object.entries(data.contacts).filter(([, c]) => c.kind === "hot" && !c.labeled);
      let ok = 0;
      for (const [key, c] of hot) { if (stopReplies) break; buyersTell("busy", `Labeling ${c.name}…`); if ((await labelOne({ key, name: c.name })).ok) ok++; }
      return { ok: true, message: `“${data.settings.labelName}” added to ${ok} of ${hot.length} hot leads` };
    });
    buyersTell("done", r.message || "");
    return r;
  }
  // Every few minutes (if ticked): check for replies, also in the middle of a run.
  setInterval(async () => {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      const s = Object.assign({}, E.DEFAULTS, settings || {});
      if (!s.autoCheckReplies) { lastAutoCheck = Date.now(); return; }
      if (Date.now() - lastAutoCheck < Math.max(1, +s.autoCheckMinutes || 10) * 60000) return;
      if (pageBusy || E.tools.scrollState() !== "idle" || E.status() === "paused") return;
      lastAutoCheck = Date.now();
      replyRound({ auto: true });
    } catch (_) {}
  }, 20000);

  // ---------- keyboard shortcuts (W6): a small note on the page shows they worked ----------
  function toast(text) {
    let el = document.getElementById("wa-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "wa-toast";
      el.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#128c5e;color:#fff;font:600 14px/1.3 'Segoe UI',system-ui,sans-serif;" +
        "padding:10px 16px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;transition:opacity .3s";
      document.documentElement.appendChild(el);
    }
    el.textContent = "FollowUp: " + text;
    el.style.opacity = "1";
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.style.opacity = "0"; }, 2500);
  }
  const withToast = (fn) => async () => { const r = await fn(); toast(r.message || (r.ok ? "Done" : "Didn't work")); return r; };
  async function startScroll() {
    if (["running", "paused"].includes(E.status())) return { ok: false, message: "A run is going. Stop it first, then scroll." };
    if (E.tools.scrollState() !== "idle") return { ok: false, message: "Already scrolling." };
    const s = (await load()).settings;
    data = data || (await load());
    diary("SCROLL", "Scroll chat list to the bottom: started");
    keepAwake(true);
    E.tools.scrollButton(s, (p) => {
      tell({ scroll: p });
      if (p.state === "done") { diary("SCROLL", `${p.message} · ${p.scrolls || 0} scrolls`); keepAwake(false); }
    });
    return { ok: true, message: "Scrolling the chat list down…" };
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
    E.stop(); E.tools.stopScroll();
    return { ok: true, message: scrolling ? "Scrolling stopped" : ["running", "paused"].includes(was) ? "Stopped" : "Nothing to stop" };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.to !== "wa-content") return;
    (async () => {
      switch (msg.cmd) {
        case "ping": {
          const d = data && busy() ? data : await load();
          return { ok: true, state: E.status(), last: lastState, stats: d.stats, limit: limitInfo(d), scroll: E.tools.scrollState(), buyersBusy: pageBusy };
        }
        case "start": return start();
        case "pause": E.pause(); return { ok: true };
        case "resume": E.resume(); return { ok: true };
        case "stop": E.stop(); return { ok: true };
        case "scrollList": return startScroll();
        case "pauseScroll": return { ok: E.tools.pauseScroll() };
        case "resumeScroll": return { ok: E.tools.resumeScroll() };
        case "stopScroll": return { ok: E.tools.stopScroll() };
        case "diagnose": return { ok: true, report: E.tools.diagnose((await load()).settings) };
        case "limit": return { ok: true, limit: limitInfo(await load()) };
        case "testNotify": return notify("FollowUp test", "Notifications work. You'll get one like this when a run finishes.", Object.assign({}, E.DEFAULTS, msg.settings || {}));
        case "cancelFinish": cancelFinish(); return { ok: true };
        case "finishNow": doFinish(); return { ok: true };
        case "finishState": return { ok: true, action: finishAction, left: finishAction ? Math.max(0, Math.ceil((finishEnd - Date.now()) / 1000)) : 0 };
        // Buyers
        case "checkReplies": if (pageBusy) return { ok: false, message: "Already working on it." }; replyRound({ auto: false }); return { ok: true, message: "Checking replies…" };
        case "sendReplies": if (pageBusy) return { ok: false, message: "Already working on it." }; sendPending(msg.keys); return { ok: true, message: "Sending replies…" };
        case "skipReply": {
          const d = busy() && data ? data : (data = await load());
          const c = d.contacts[msg.key];
          if (c) { Object.assign(c, { replyPending: false, replySkipFor: c.reply }); save(true); }
          return { ok: true };
        }
        case "labelHot": if (pageBusy) return { ok: false, message: "Already working on it." }; labelHotCmd(); return { ok: true, message: "Adding labels…" };
        case "stopBuyers": stopReplies = true; E.tools.stopScan(); return { ok: true };
        // Saving names
        case "backupNow": { if (!busy()) { data = await load(); await prepareHistory(); } return backup(true); }
        case "flushDiary": await flushDiary(); await flushDiaryFile(); return { ok: true };
        // keyboard shortcuts
        case "toggleRun": return withToast(toggleRun)();
        case "toggleScroll": return withToast(toggleScroll)();
        case "stopAll": return withToast(async () => stopAll())();
        default: return { ok: false, message: "Unknown command" };
      }
    })().then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
    return true;
  });
})();
