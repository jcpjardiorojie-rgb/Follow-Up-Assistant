// Runs inside the Business Suite tab. Connects the side panel to the engine and saves progress.
(() => {
  if (window.__fuContentLoaded) return;
  window.__fuContentLoaded = true;
  const E = window.FollowUpEngine;
  const LOG_MAX = 2000;

  const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const freshStats = () => ({ date: today(), sent: 0, excluded: 0, skipped: 0, failed: 0, unknown: 0, test: 0, replies: 0 });

  let data = null; // in-memory copy of storage while running
  let saveTimer = null;
  let lastState = { state: "idle", reason: "" };

  async function load() {
    const d = await chrome.storage.local.get(["settings", "template", "templates", "activeTemplate", "campaign", "stats", "log", "problems", "contacts", "history", "replies"]);
    const stats = d.stats && d.stats.date === today() ? d.stats : freshStats();
    return {
      settings: Object.assign({}, E.DEFAULTS, d.settings || {}),
      template: d.template || { text: E.DEFAULTS.template, imageDataUrl: "", imageName: "" },
      campaign: d.campaign || { id: Date.now(), doneIds: [] },
      stats,
      log: d.log || [],
      problems: d.problems || [],
      contacts: d.contacts || {},
      history: d.history || {}, // { messageId: { name: date sent } } kept per saved message, not erased by New campaign
      replies: Object.assign({}, E.DEFAULT_REPLIES, d.replies || {}),
      tpl: (d.templates || []).find((t) => t.id === d.activeTemplate) || (d.templates || [])[0] ||
        Object.assign({ id: "t1", name: "Message 1" }, d.template || { text: E.DEFAULTS.template }),
    };
  }
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      if (!data) return;
      if (data.log.length > LOG_MAX) data.log = data.log.slice(-LOG_MAX);
      if (data.problems.length > 300) data.problems = data.problems.slice(-300);
      chrome.storage.local.set({ campaign: data.campaign, stats: data.stats, log: data.log, problems: data.problems, contacts: data.contacts, history: data.history });
    };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  }
  function tell(msg) {
    chrome.runtime.sendMessage(Object.assign({ type: "fu-status" }, msg)).catch(() => {});
  }
  function rollDay() {
    if (data.stats.date !== today()) data.stats = freshStats();
  }

  const COUNTER = { SENT: "sent", EXCLUDED: "excluded", SKIPPED: "skipped", ALREADY: "skipped", FAILED: "failed", REVIEW: "failed", UNKNOWN: "unknown", TEST: "test", REPLY: "replies" };

  function hooks(doneSet) {
    return {
      log(e) {
        rollDay();
        const k = COUNTER[e.status];
        if (k && k !== "sent") data.stats[k] = (data.stats[k] || 0) + 1;
        data.log.push({ time: e.time, name: e.name, status: e.status, reason: e.reason });
        if (e.status === "SENT" && e.key) {
          // Remember who got which message, so replies can be matched to it later (Buyers tab).
          const old = data.contacts[e.key] || {};
          data.contacts[e.key] = Object.assign(old, { key: e.key, name: e.name, id: e.id, templateId: data.tpl.id,
            templateName: data.tpl.name, sentAt: e.time, reply: null, kind: null, replyAt: null, replyPending: false });
        }
        if (e.status === "SENT") {
          (data.history[data.tpl.id] = data.history[data.tpl.id] || {})[e.name] = e.time;
          if (++sinceBackup >= Math.max(1, +data.settings.backupEvery || 25)) backup();
        }
        if (e.help) data.problems.push({ time: e.time, name: e.name, status: e.status, reason: e.reason, code: e.code, help: e.help });
        save();
        tell({ entry: e, stats: data.stats });
      },
      state(s) {
        lastState = s;
        tell({ state: s, stats: data && data.stats });
        if (s.state !== "running") save(true);
        if (s.state === "finished" || s.state === "stopped") { backup(); runLine(s); }
        // "When finished" only after a normal finish, never after Stop or a problem pause.
        if (s.state === "finished") finished(s);
        if (s.state === "paused" && data.settings.notifyOnPause && /problems in a row|Meta shows|warning/i.test(s.reason || "")) {
          notify("FollowUp paused", s.reason, data.settings);
        }
      },
      nameSent: (name) => !!(data.history[data.tpl.id] || {})[name],
      alreadyDone: (id) => doneSet.has(id),
      markDone(id) { if (!doneSet.has(id)) { doneSet.add(id); data.campaign.doneIds.push(id); save(); } },
      sentToday() { rollDay(); return data.stats.sent; },
      onSent() { rollDay(); data.stats.sent++; save(); },
    };
  }

  async function start() {
    if (!location.pathname.includes("/inbox")) return { ok: false, message: "Open the Inbox in Business Suite first." };
    if (pageBusy) return { ok: false, message: "Answering replies right now. Press Start again in a moment." };
    data = await load();
    await prepareHistory();
    const t = data.tpl;
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
  let scrollStarting = false; // between "pause the run" and "start scrolling"
  const scrolling = () => scrollStarting || E.tools.scrollState() !== "idle";
  const RESUME_BLOCKED = { ok: false, message: "The inbox is still scrolling. Pause or stop the scrolling first, then Resume." };
  async function startScroll() {
    // Tools work while a run is paused. If it's running, pause it first and let it finish the chat it's on.
    if (scrolling()) return { ok: false, message: "Already scrolling." };
    if (E.status() === "running") {
      scrollStarting = true;
      tell({ scroll: { state: "running", message: "Pausing the run first (finishing the current chat)…" } });
      const halted = await E.pauseAndWait();
      if (!halted) { scrollStarting = false; tell({ scroll: { state: "done", rows: 0, message: "The run didn't pause in time." } }); return { ok: false, message: "The run didn't pause in time. Press Pause, then try again." }; }
    }
    const s = (await load()).settings;
    if (!E.tools.diagnose(s).inboxList) return { ok: false, message: "Can't find the inbox list. Open Business Suite → Inbox." };
    E.tools.loadWholeInbox(s, (p) => tell({ scroll: p }));
    scrollStarting = false; // the scroll job is now running and blocks Resume by itself
    return { ok: true, message: "Scrolling the inbox down…" };
  }
  async function toggleRun() {
    const st = E.status();
    if (st === "running") { E.pause(); return { ok: true, message: "Paused" }; }
    if (st === "paused") { if (scrolling()) return RESUME_BLOCKED; E.resume(); return { ok: true, message: "Resumed" }; }
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

  // ---------- Buyers: who replied, how interested they are, and the hot-lead label ----------
  const buyersTell = (state, message) => tell({ buyers: { state, message } });

  // Adds the "Hot lead" label in Business Suite to hot leads that don't have it yet.
  async function labelHot(s) {
    const todo = Object.values(data.contacts).filter((c) => c.kind === "hot" && !c.labeled);
    if (!todo.length) return "No new hot leads to label.";
    buyersTell("labeling", `Adding “${s.labelName}” to ${todo.length} hot lead(s)…`);
    const r = await E.tools.labelLeads(s, todo.map((c) => ({ key: c.key, name: c.name })),
      (p) => buyersTell("labeling", `Adding “${s.labelName}”… ${p.done} of ${p.total}`));
    let ok = 0, bad = 0;
    for (const x of r.results) {
      const c = data.contacts[x.key];
      if (!c) continue;
      if (x.ok) { c.labeled = true; c.labelError = ""; ok++; continue; }
      bad++;
      c.labelError = x.why || (x.help && x.help.what) || "Couldn't add the label";
      data.problems.push({ time: new Date().toISOString(), name: c.name, status: "FAILED", reason: "Label: " + c.labelError, code: x.code, help: x.help });
    }
    save(true);
    return `Labeled ${ok} hot lead(s)` + (bad ? `; ${bad} couldn't be labeled (see the Problems tab).` : ".");
  }
  async function labelHotCmd() {
    if (pageBusy) return { ok: false, message: "Already working on it." };
    withPage("Labeling hot leads…", async (s) => { buyersTell("done", await labelHot(s)); return { ok: true }; })
      .then((r) => { if (r && r.ok === false && r.message) buyersTell("done", r.message); });
    return { ok: true, message: "Labeling hot leads…" };
  }

  // ---------- "When the run is finished": countdown, then close the tab, close Chrome or shut down ----------
  const FINISH_TEXT = { closeTab: "close the Business Suite tab", closeChrome: "close Chrome", shutdown: "shut down the computer" };
  let finishTimer = null, finishEnd = 0, finishAction = null;
  function finishBox() {
    let el = document.getElementById("fu-finish");
    if (el) return el;
    el = document.createElement("div");
    el.id = "fu-finish";
    el.style.cssText = "position:fixed;left:50%;top:30%;transform:translateX(-50%);z-index:2147483647;background:#fff;color:#18211d;" +
      "border:3px solid #a83636;border-radius:12px;padding:18px 24px;font:15px/1.4 'Segoe UI',system-ui,sans-serif;text-align:center;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.35);min-width:300px";
    el.innerHTML = '<div id="fu-finish-title" style="font-weight:600"></div><div id="fu-finish-left" style="font:800 40px/1.2 \'Segoe UI\',sans-serif;color:#a83636;margin:6px 0"></div>' +
      '<div id="fu-finish-what"></div><div style="display:flex;gap:8px;justify-content:center;margin-top:12px">' +
      '<button id="fu-finish-cancel" style="font:600 15px \'Segoe UI\',sans-serif;padding:8px 18px;border-radius:8px;border:0;background:#0e6b58;color:#fff;cursor:pointer">Cancel</button>' +
      '<button id="fu-finish-now" style="font:15px \'Segoe UI\',sans-serif;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer">Do it now</button></div>';
    document.documentElement.appendChild(el);
    el.querySelector("#fu-finish-cancel").addEventListener("click", () => cancelFinish());
    el.querySelector("#fu-finish-now").addEventListener("click", () => doFinish());
    return el;
  }
  function startFinish(action, secs) {
    if (!FINISH_TEXT[action]) return;
    cancelFinish(true);
    finishAction = action;
    finishEnd = Date.now() + Math.max(5, +secs || 60) * 1000;
    const box = finishBox();
    const sent = data && data.stats ? data.stats.sent : 0;
    box.querySelector("#fu-finish-title").textContent = `FollowUp run finished · ${sent} sent today`;
    const tick = () => {
      if (!finishAction) return;
      const left = Math.max(0, Math.ceil((finishEnd - Date.now()) / 1000));
      box.querySelector("#fu-finish-left").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      box.querySelector("#fu-finish-what").textContent = `Then FollowUp Copilot will ${FINISH_TEXT[action]}.`;
      tell({ finish: { left, action, text: `In ${left} s: ${FINISH_TEXT[action]}` } });
      if (left <= 0) { doFinish(); return; }
      finishTimer = setTimeout(tick, 500);
    };
    tick();
  }
  function cancelFinish(silent) {
    clearTimeout(finishTimer);
    const el = document.getElementById("fu-finish");
    if (el) el.remove();
    if (!silent && finishAction) { tell({ finish: { cancelled: true } }); toast("Cancelled. Nothing will be closed or shut down."); }
    finishAction = null;
  }
  async function doFinish() {
    const action = finishAction;
    if (!action) return;
    cancelFinish(true);
    tell({ finish: { done: true, action } });
    save(true);
    await new Promise((r) => setTimeout(r, 400));
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "fu-finish-action", action }); } catch (e) { r = { ok: false, message: String(e && e.message || e) }; }
    if (r && r.ok === false) {
      const help = r.code === "SHUTDOWN_HELPER" ? E.HELP.SHUTDOWN_HELPER : E.HELP.ERROR;
      const { problems = [] } = await chrome.storage.local.get("problems");
      problems.push({ time: new Date().toISOString(), name: "When finished", status: "FAILED", reason: r.message || "", code: r.code || "ERROR", help });
      await chrome.storage.local.set({ problems: problems.slice(-300) });
      toast(help.what + " See the Problems tab.");
      tell({ finish: { failed: true, message: help.what } });
    }
  }


  // ---------- names that got each message (H1), saved to a folder on your PC (D1) ----------
  let sinceBackup = 0, backupWarned = false;
  const csvCell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const fileNameFor = (t) => (String(t.name || "Message").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Message") + ".csv";
  async function fileOp(msg) {
    try { return await chrome.runtime.sendMessage(Object.assign({ type: "fu-file" }, msg)); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function parseNames(csv) {
    const out = {};
    for (const line of String(csv || "").replace(/^﻿/, "").split(/\r?\n/).slice(1)) {
      const m = line.match(/^"((?:[^"]|"")*)"\s*,\s*"?([^"]*)"?/) || line.match(/^([^,]+),([^,]*)/);
      if (m && m[1].trim()) out[m[1].replace(/""/g, '"')] = m[2] || "";
    }
    return out;
  }
  // Before a run: the Chrome copy, plus names from earlier sends of this message, plus (if Chrome's copy is
  // empty, e.g. after a reinstall) the copy saved on your PC.
  async function prepareHistory() {
    const tid = data.tpl.id;
    const h = (data.history[tid] = data.history[tid] || {});
    for (const c of Object.values(data.contacts)) if (c.templateId === tid && c.name && !h[c.name]) h[c.name] = c.sentAt || "";
    if (!Object.keys(h).length && data.settings.backupOn && data.settings.backupFolder) {
      let text = "", offset = 0;
      for (let i = 0; i < 200; i++) {
        const r = await fileOp({ action: "readFile", folder: data.settings.backupFolder, name: fileNameFor(data.tpl), offset });
        if (!r || !r.ok) break;
        text += r.content || "";
        offset += (r.content || "").length;
        if (!r.more) break;
      }
      Object.assign(h, parseNames(text));
    }
    save(true);
  }
  async function setBackupStatus(st) { await chrome.storage.local.set({ backupStatus: st }); tell({ backup: st }); }
  async function backup(force) {
    if (!data || !data.settings.backupOn || !data.settings.backupFolder) return { ok: false, message: "Saving to your PC is turned off." };
    sinceBackup = 0;
    const h = data.history[data.tpl.id] || {};
    const names = Object.keys(h);
    const csv = "Name,Sent at\r\n" + names.map((n) => csvCell(n) + "," + csvCell(h[n])).join("\r\n") + "\r\n";
    const r = await fileOp({ action: "saveFile", folder: data.settings.backupFolder, name: fileNameFor(data.tpl), content: csv });
    const ok = !!(r && r.ok);
    await setBackupStatus({ ok, time: new Date().toISOString(), names: names.length, file: data.settings.backupFolder + "\\" + fileNameFor(data.tpl), error: ok ? "" : (r && r.error) || "" });
    if (!ok && (force || !backupWarned)) {
      backupWarned = true;
      data.problems.push({ time: new Date().toISOString(), name: "Save names to your PC", status: "FAILED", reason: (r && r.error) || "", code: "BACKUP_FAILED", help: E.HELP.BACKUP_FAILED });
      save(true);
    }
    return { ok, message: ok ? `Saved ${names.length} names to ${data.settings.backupFolder}` : E.HELP.BACKUP_FAILED.what };
  }
  function runLine(s) {
    if (!data || !data.settings.backupOn || !data.settings.backupFolder) return;
    const st = data.stats;
    const line = [new Date().toLocaleString(), data.tpl.name, st.sent, st.excluded, st.skipped, st.failed + st.unknown, s.reason || s.state].map(csvCell).join(",") + "\r\n";
    fileOp({ action: "appendFile", folder: data.settings.backupFolder, name: "runs.csv", content: line,
      header: "When,Message,Sent today,Moved to Done,Skipped,Problems,How it ended\r\n" });
  }

  // ---------- notifications (PC pop-up and phone) ----------
  async function notify(title, message, s) {
    s = s || (data && data.settings) || {};
    if (!s.notifyPC && !s.notifyPhone) return { ok: true };
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "fu-notify", title, message, pc: !!s.notifyPC, phone: !!s.notifyPhone,
        topic: s.ntfyTopic || "", server: s.ntfyServer || "https://ntfy.sh" });
    } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (r && r.phoneOk === false && data) {
      data.problems.push({ time: new Date().toISOString(), name: "Phone notification", status: "FAILED", reason: r.error || "", code: "NOTIFY_FAILED", help: E.HELP.NOTIFY_FAILED });
      save(true);
    }
    return r || { ok: false };
  }
  async function finished(s) {
    const st = data.stats, set = data.settings;
    // One last reply round before the PC is closed or shut down.
    if (set.autoCheckReplies && set.whenFinished !== "nothing") {
      try { await replyRound({ auto: true, final: true }); } catch (_) {}
    }
    let msg = `${st.sent} sent today · ${st.excluded} moved to Done. ${s.reason || ""}`;
    if (set.whenFinished !== "nothing") msg += ` Then: ${FINISH_TEXT[set.whenFinished]} in ${set.finishCountdownSec} s, unless you press Cancel.`;
    notify("FollowUp finished", msg, set);
    startFinish(set.whenFinished, set.finishCountdownSec);
  }

  // ---------- auto-replies to people who answered the follow-up (Buyers tab) ----------
  // Reply rounds can happen in the middle of a run: the run pauses after its current chat, the inbox
  // list is put back where it was afterwards, and the run continues by itself.
  let pageBusy = false, lastAutoCheck = Date.now();
  const me = Math.random().toString(36).slice(2);
  const KIND_NAME = { hot: "🔥 Hot", warm: "🙂 Warm", cold: "❄️ Not interested", replied: "💬 Other" };
  async function lock(on) {
    const { replyLock } = await chrome.storage.local.get("replyLock");
    if (on) {
      if (replyLock && replyLock.owner !== me && replyLock.until > Date.now()) return false; // another inbox tab is on it
      await chrome.storage.local.set({ replyLock: { owner: me, until: Date.now() + 15 * 60000 } });
      return true;
    }
    if (replyLock && replyLock.owner === me) await chrome.storage.local.remove("replyLock");
    return true;
  }
  // Runs fn with the page to itself (the run paused after its chat), then puts things back.
  async function withPage(note, fn, keepData) {
    if (pageBusy) return { ok: false, message: "Already working on replies." };
    if (scrolling()) return { ok: false, message: "The inbox is scrolling. Try again when it's done." };
    if (!(await lock(true))) return { ok: false, message: "Another Business Suite tab is answering replies." };
    pageBusy = true;
    let pausedByMe = false, pos = null;
    try {
      if (E.status() === "running") {
        tell({ state: { state: "paused", reason: note + " (finishing the current chat first)" } });
        if (!(await E.pauseAndWait())) return { ok: false, message: "The run didn't pause in time. Try again." };
        pausedByMe = true;
      } else if (E.status() === "paused") {
        await E.pauseAndWait();
      }
      if (!["running", "paused"].includes(E.status()) && !(keepData && data)) data = await load();
      if (pausedByMe) tell({ state: { state: "paused", reason: note + " The run continues by itself after." } });
      pos = E.tools.listPosition(data.settings);
      return await fn(data.settings);
    } finally {
      if (pos != null) await E.tools.restoreListPosition(data.settings, pos);
      save(true);
      pageBusy = false;
      await lock(false);
      if (pausedByMe && E.status() === "paused") E.resume();
    }
  }
  function pendingReplies() {
    return Object.values(data.contacts).filter((c) => c.replyPending && c.reply && c.autoReplyFor !== c.reply);
  }
  async function sendOne(c, s) {
    const rep = data.replies[c.kind];
    if (!rep || !rep.text || !rep.text.trim()) return null;
    const image = rep.imageDataUrl ? { dataUrl: rep.imageDataUrl, name: rep.imageName || "image.jpg" } : null;
    const hooksR = { alreadyDone: () => false, markDone: () => {}, onSent: () => {} };
    let res;
    try { res = await E.tools.sendReply(Object.assign({}, s, { testMode: s.testMode }), { key: c.key, name: c.name }, { text: rep.text, image }, hooksR); }
    catch (e) { res = { time: new Date().toISOString(), name: c.name, status: "FAILED", reason: "Error: " + (e && e.message || e), code: "ERROR", help: E.HELP.ERROR }; }
    const now = new Date().toISOString();
    const entry = Object.assign({}, res, { name: c.name });
    if (res.status === "SENT") {
      Object.assign(c, { autoReplyFor: c.reply, autoReplyAt: now, autoReplyKind: c.kind, replyPending: false, replyError: "" });
      entry.status = "REPLY";
      entry.reason = `Auto-reply (${KIND_NAME[c.kind]}) · ${res.reason}`;
    } else if (res.status === "SKIPPED" || res.status === "TEST") {
      if (res.status === "SKIPPED") Object.assign(c, { autoReplyFor: c.reply, replyPending: false });
      entry.reason = "Auto-reply: " + res.reason;
    } else {
      Object.assign(c, { replyError: (res.help && res.help.what) || res.reason });
      entry.reason = "Auto-reply not sent: " + res.reason;
    }
    hooks(new Set()).log(entry);
    return res;
  }
  async function sendReplies(list, s) {
    let sent = 0, other = 0;
    for (const c of list) {
      if (stopReplies) break;
      buyersTell("checking", `Sending replies… ${sent + other + 1} of ${list.length} (${c.name})`);
      const r = await sendOne(c, s);
      if (r && r.status === "SENT") sent++; else other++;
      await new Promise((ok) => setTimeout(ok, Math.min(5, Math.max(1, +s.betweenChatsSec || 3)) * 1000));
    }
    return { sent, other };
  }
  let stopReplies = false;
  async function replyRound({ auto, final }) {
    stopReplies = false;
    return withPage("Checking replies…", async (s) => {
      const all = Object.values(data.contacts);
      if (!all.length) { buyersTell("done", "Nobody has been messaged from this browser yet, so there are no replies to check."); return { ok: false, message: "No one to check yet." }; }
      buyersTell("checking", "Checking replies… reading your inbox list");
      const r = await E.tools.scanReplies(s, all.map((c) => ({ key: c.key, name: c.name })),
        (p) => buyersTell("checking", `Checking replies… ${p.rows} chats read, ${p.replies} replies found`),
        auto ? Math.max(20, +s.autoCheckRows || 150) : (s.replyScanMax || 600));
      if (!r.ok) { buyersTell("done", r.message); return r; }
      const now = new Date().toISOString();
      let fresh = 0;
      for (const x of r.replies) {
        const c = data.contacts[x.key];
        if (!c || c.reply === x.reply) continue;
        Object.assign(c, { reply: x.reply, kind: x.kind, replyAt: now, replyError: "" });
        fresh++;
      }
      // Who should get an auto-reply: their category is on, and they haven't had one for this message of theirs.
      const want = Object.values(data.contacts).filter((c) => c.reply && c.kind && data.replies[c.kind] && data.replies[c.kind].on &&
        c.autoReplyFor !== c.reply && c.replySkipFor !== c.reply);
      let msg = `Read ${r.rows} chats: ${r.replies.length} replies (${fresh} new).`;
      if (want.length && s.replyMode === "auto") {
        const t = await sendReplies(want, s);
        msg += ` Auto-replied to ${t.sent}` + (t.other ? `; ${t.other} not sent (see Activity).` : ".");
      } else if (want.length) {
        const newOnes = want.filter((c) => !c.replyPending);
        want.forEach((c) => { c.replyPending = true; });
        msg += ` ${want.length} auto-replies ready: check them in the Buyers tab, then press Send all.`;
        if (auto && newOnes.length && !final) notify("FollowUp: replies ready", `${newOnes.length} people answered your follow-up. Open the Buyers tab to send the replies.`, Object.assign({}, s, { notifyPhone: false }));
      }
      save(true);
      if (s.autoLabel) msg += " " + (await labelHot(s));
      buyersTell("done", msg);
      if (!auto) toast("Replies checked");
      return { ok: true, message: msg };
    }, final);
  }
  async function sendPending(keys) {
    stopReplies = false;
    return withPage("Sending replies…", async (s) => {
      let list = pendingReplies();
      if (keys && keys.length) list = list.filter((c) => keys.includes(c.key));
      if (!list.length) { buyersTell("done", "No replies waiting."); return { ok: true, message: "No replies waiting." }; }
      const t = await sendReplies(list, s);
      const msg = `Sent ${t.sent} replies` + (t.other ? `; ${t.other} not sent (see Activity).` : ".");
      buyersTell("done", msg);
      return { ok: true, message: msg };
    });
  }
  // T2: every few minutes while this inbox tab is open.
  if (window.top === window) setInterval(async () => {
    try {
      if (!location.pathname.includes("/inbox") || finishAction) return;
      const { settings } = await chrome.storage.local.get("settings");
      const s = Object.assign({}, E.DEFAULTS, settings || {});
      if (!s.autoCheckReplies) { lastAutoCheck = Date.now(); return; }
      if (Date.now() - lastAutoCheck < Math.max(1, +s.autoCheckMinutes || 10) * 60000) return;
      if (pageBusy || scrolling()) return;
      lastAutoCheck = Date.now();
      replyRound({ auto: true });
    } catch (_) {}
  }, 20000);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.to !== "content") return;
    (async () => {
      switch (msg.cmd) {
        case "ping": return { ok: true, state: E.status(), last: lastState };
        case "start": return start();
        case "pause": E.pause(); return { ok: true };
        case "resume": if (scrolling()) return RESUME_BLOCKED; E.resume(); return { ok: true };
        case "stop": E.stop(); return { ok: true };
        case "loadInbox": return startScroll();
        case "pauseScroll": return { ok: E.tools.pauseScroll() };
        case "resumeScroll": return { ok: E.tools.resumeScroll() };
        case "stopScroll": return { ok: E.tools.stopScroll() };
        case "scrollState": return { ok: true, state: E.tools.scrollState() };
        case "checkReplies": {
          if (pageBusy) return { ok: false, message: "Already working on it." };
          replyRound({ auto: false }).then((r) => { if (r && r.ok === false && r.message) buyersTell("done", r.message); });
          return { ok: true, message: "Checking replies…" };
        }
        case "sendReplies": {
          if (pageBusy) return { ok: false, message: "Already working on it." };
          sendPending(msg.keys).then((r) => { if (r && r.ok === false && r.message) buyersTell("done", r.message); });
          return { ok: true, message: "Sending replies…" };
        }
        case "skipReply": {
          const d = ["running", "paused"].includes(E.status()) ? data : (data = await load());
          const c = d.contacts[msg.key];
          if (c) { Object.assign(c, { replyPending: false, replySkipFor: c.reply }); save(true); }
          return { ok: true };
        }
        case "backupNow": {
          if (!["running", "paused"].includes(E.status())) { data = await load(); await prepareHistory(); }
          return backup(true);
        }
        case "testNotify": return notify("FollowUp test", "Notifications work. You'll get one like this when a run finishes.", Object.assign({}, E.DEFAULTS, msg.settings || {}));
        case "labelHot": return labelHotCmd();
        case "stopBuyers": stopReplies = true; E.tools.stopScan(); return { ok: true };
        case "cancelFinish": cancelFinish(); return { ok: true };
        case "finishNow": doFinish(); return { ok: true };
        case "finishState": return { ok: true, action: finishAction, left: finishAction ? Math.max(0, Math.ceil((finishEnd - Date.now()) / 1000)) : 0 };
        case "buyersState": return { ok: true, busy: pageBusy };
        case "openChat": {
          const r = await E.tools.openChat((await load()).settings, msg.key, msg.name);
          return { ok: r.ok, message: r.ok ? "Opened" : r.help.what + " " + r.help.fix };
        }
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
