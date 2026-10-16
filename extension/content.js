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
    const d = await chrome.storage.local.get(["settings", "template", "templates", "activeTemplate", "campaign", "stats", "log", "problems", "contacts"]);
    const stats = d.stats && d.stats.date === today() ? d.stats : freshStats();
    return {
      settings: Object.assign({}, E.DEFAULTS, d.settings || {}),
      template: d.template || { text: E.DEFAULTS.template, imageDataUrl: "", imageName: "" },
      campaign: d.campaign || { id: Date.now(), doneIds: [] },
      stats,
      log: d.log || [],
      problems: d.problems || [],
      contacts: d.contacts || {},
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
      chrome.storage.local.set({ campaign: data.campaign, stats: data.stats, log: data.log, problems: data.problems, contacts: data.contacts });
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
        if (e.status === "SENT" && e.key) {
          // Remember who got which message, so replies can be matched to it later (Buyers tab).
          const old = data.contacts[e.key] || {};
          data.contacts[e.key] = Object.assign(old, { key: e.key, name: e.name, id: e.id, templateId: data.tpl.id,
            templateName: data.tpl.name, sentAt: e.time, reply: null, kind: null, replyAt: null });
        }
        if (e.help) data.problems.push({ time: e.time, name: e.name, status: e.status, reason: e.reason, code: e.code, help: e.help });
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
  let buyersBusy = false;
  const busyNow = () => ["running", "paused"].includes(E.status()) || E.tools.scrollState() !== "idle";
  const getContacts = async () => {
    const d = await chrome.storage.local.get(["contacts", "problems"]);
    return { contacts: d.contacts || {}, problems: d.problems || [] };
  };
  const buyersTell = (state, message) => tell({ buyers: { state, message } });

  async function labelHot(s) {
    let { contacts, problems } = await getContacts();
    const todo = Object.values(contacts).filter((c) => c.kind === "hot" && !c.labeled);
    if (!todo.length) return "No new hot leads to label.";
    buyersTell("labeling", `Adding “${s.labelName}” to ${todo.length} hot lead(s)…`);
    const r = await E.tools.labelLeads(s, todo.map((c) => ({ key: c.key, name: c.name })),
      (p) => buyersTell("labeling", `Adding “${s.labelName}”… ${p.done} of ${p.total}`));
    ({ contacts, problems } = await getContacts());
    let ok = 0, bad = 0;
    for (const x of r.results) {
      const c = contacts[x.key];
      if (!c) continue;
      if (x.ok) { c.labeled = true; c.labelError = ""; ok++; continue; }
      bad++;
      c.labelError = x.why || (x.help && x.help.what) || "Couldn't add the label";
      problems.push({ time: new Date().toISOString(), name: c.name, status: "FAILED", reason: "Label: " + c.labelError, code: x.code, help: x.help });
    }
    await chrome.storage.local.set({ contacts, problems: problems.slice(-300) });
    return `Labeled ${ok} hot lead(s)` + (bad ? `; ${bad} couldn't be labeled (see the Problems tab).` : ".");
  }

  async function checkReplies() {
    if (busyNow()) return { ok: false, message: "Stop the sending run (or the inbox scrolling) first." };
    if (buyersBusy) return { ok: false, message: "Already working on it." };
    const s = (await load()).settings;
    const all = Object.values((await getContacts()).contacts);
    if (!all.length) return { ok: false, message: "Nobody has been messaged from this browser yet, so there are no replies to check." };
    buyersBusy = true;
    (async () => {
      try {
        buyersTell("checking", "Checking replies… reading your inbox list");
        const r = await E.tools.scanReplies(s, all.map((c) => ({ key: c.key, name: c.name })),
          (p) => buyersTell("checking", `Checking replies… ${p.rows} chats read, ${p.replies} replies found`), s.replyScanMax || 600);
        if (!r.ok) { buyersTell("done", r.message); return; }
        const { contacts } = await getContacts();
        const now = new Date().toISOString();
        let fresh = 0;
        for (const x of r.replies) {
          const c = contacts[x.key];
          if (!c || c.reply === x.reply) continue;
          Object.assign(c, { reply: x.reply, kind: x.kind, replyAt: now });
          fresh++;
        }
        await chrome.storage.local.set({ contacts });
        let msg = `Read ${r.rows} chats: ${r.replies.length} replies (${fresh} new).`;
        if (s.autoLabel) msg += " " + (await labelHot(s));
        buyersTell("done", msg);
        toast("Replies checked");
      } catch (e) {
        buyersTell("done", "Error: " + (e && e.message || e));
      } finally {
        buyersBusy = false;
      }
    })();
    return { ok: true, message: "Checking replies…" };
  }

  async function labelHotCmd() {
    if (busyNow()) return { ok: false, message: "Stop the sending run (or the inbox scrolling) first." };
    if (buyersBusy) return { ok: false, message: "Already working on it." };
    const s = (await load()).settings;
    buyersBusy = true;
    (async () => {
      try { buyersTell("done", await labelHot(s)); }
      catch (e) { buyersTell("done", "Error: " + (e && e.message || e)); }
      finally { buyersBusy = false; }
    })();
    return { ok: true, message: "Labeling hot leads…" };
  }

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
        case "checkReplies": return checkReplies();
        case "labelHot": return labelHotCmd();
        case "stopBuyers": E.stop(); return { ok: true };
        case "buyersState": return { ok: true, busy: buyersBusy };
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
