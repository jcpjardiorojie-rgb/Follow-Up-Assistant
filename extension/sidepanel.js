// Side panel: edits the message and settings, and drives the engine in the Business Suite tab.
const $ = (id) => document.getElementById(id);
const DEF = {
  template: "Hi {first_name}! Just following up po 😊",
  fallbackName: "there",
  blockedTexts: ["You are no longer able to send messages to this person"],
  excludeNames: ["Facebook user"],
  stopTexts: ["temporarily blocked", "temporarily restricted", "You can't use this feature right now", "We limit how often",
    "Your account has been restricted", "account is restricted", "Confirm your identity", "Security check", "Action blocked"],
  order: "top", onlyIfLastFromMe: true, moveSentToDone: false, testMode: false, imageRequired: true,
  stepDelayMs: 1200, betweenChatsSec: 8, dailyCap: 300, inboxUrl: "",
  hotWords: FollowUpEngine.DEFAULTS.hotWords, warmWords: FollowUpEngine.DEFAULTS.warmWords,
  coldWords: FollowUpEngine.DEFAULTS.coldWords, labelName: "Hot lead", autoLabel: true,
};
const BAD = new Set(["FAILED", "REVIEW", "UNKNOWN"]);
let settings = {}, template = {}, templates = [], contacts = {}, tabId = null, state = "idle", scrollState = "idle";

// ---------- storage ----------
async function loadAll() {
  const d = await chrome.storage.local.get(["settings", "template", "templates", "activeTemplate", "stats", "log", "campaign", "problems", "contacts"]);
  showProblems(d.problems || []);
  settings = Object.assign({}, DEF, d.settings || {});
  // Saved messages. The single message from older versions becomes "Message 1".
  templates = d.templates && d.templates.length ? d.templates
    : [Object.assign({ id: "t" + Date.now(), name: "Message 1", text: DEF.template, imageDataUrl: "", imageName: "" }, d.template || {})];
  template = templates.find((t) => t.id === d.activeTemplate) || templates[0];
  contacts = d.contacts || {};
  if (!d.templates) saveTemplate();
  fillForm();
  showStats(d.stats);
  showLog(d.log || []);
  $("remembered").textContent = `${(d.campaign && d.campaign.doneIds.length) || 0} chats remembered in this campaign`;
}
const saveSettings = () => chrome.storage.local.set({ settings });
const saveTemplate = () => chrome.storage.local.set({ templates, activeTemplate: template.id, template });

// ---------- form ----------
const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
function fillForm() {
  showTemplates();
  $("tplText").value = template.text || "";
  $("inboxUrl").value = settings.inboxUrl || "";
  showInboxMsg();
  $("sBetween").value = settings.betweenChatsSec;
  $("sStep").value = settings.stepDelayMs / 1000;
  $("sCap").value = settings.dailyCap;
  $("sOrder").value = settings.order;
  $("sLastMine").checked = settings.onlyIfLastFromMe;
  $("sSentDone").checked = settings.moveSentToDone;
  $("sImgReq").checked = settings.imageRequired;
  $("sTest").checked = settings.testMode;
  $("aBlocked").value = settings.blockedTexts.join("\n");
  $("aNames").value = settings.excludeNames.join("\n");
  $("aStop").value = settings.stopTexts.join("\n");
  $("aHot").value = settings.hotWords.join("\n");
  $("aWarm").value = settings.warmWords.join("\n");
  $("aCold").value = settings.coldWords.join("\n");
  $("bAuto").checked = settings.autoLabel;
  $("bLabelName").value = settings.labelName;
  $("cCap").textContent = "of " + settings.dailyCap;
  $("fbName").textContent = settings.fallbackName;
  showImage();
  showPreview();
}
function readSettings() {
  settings.betweenChatsSec = Math.max(0, +$("sBetween").value || 0);
  settings.stepDelayMs = Math.round(Math.max(0.3, +$("sStep").value || 1.2) * 1000);
  settings.dailyCap = Math.max(1, Math.round(+$("sCap").value || 1));
  settings.order = $("sOrder").value;
  settings.onlyIfLastFromMe = $("sLastMine").checked;
  settings.moveSentToDone = $("sSentDone").checked;
  settings.imageRequired = $("sImgReq").checked;
  settings.testMode = $("sTest").checked;
  settings.blockedTexts = lines($("aBlocked").value);
  settings.excludeNames = lines($("aNames").value);
  settings.stopTexts = lines($("aStop").value);
  settings.hotWords = lines($("aHot").value);
  settings.warmWords = lines($("aWarm").value);
  settings.coldWords = lines($("aCold").value);
  settings.autoLabel = $("bAuto").checked;
  settings.labelName = $("bLabelName").value.trim() || DEF.labelName;
  $("cCap").textContent = "of " + settings.dailyCap;
  saveSettings();
}
function firstName(name) {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n || settings.excludeNames.some((x) => x.toLowerCase() === n.toLowerCase())) return settings.fallbackName;
  for (const tok of n.split(" ")) {
    let w = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (w.length < 2) continue;
    if (w === w.toUpperCase() || w === w.toLowerCase()) w = w[0].toUpperCase() + w.slice(1).toLowerCase();
    return w;
  }
  return settings.fallbackName;
}
function showPreview() {
  $("tplPreview").textContent = ($("tplText").value || "").replace(/\{\s*first[_ ]?name\s*\}/gi, firstName("Lista Maison")).replace(/\{\s*(full[_ ]?)?name\s*\}/gi, "Lista Maison") || "—";
}
function showImage() {
  const has = !!template.imageDataUrl;
  $("imgThumb").style.backgroundImage = has ? `url("${template.imageDataUrl}")` : "";
  $("imgThumb").textContent = has ? "" : "No image";
  $("imgThumb").classList.toggle("empty", !has);
  $("imgRemove").hidden = !has;
  $("imgName").textContent = has ? template.imageName : "Text only. Add an image to send it with every message.";
}

$("tplText").addEventListener("input", () => { template.text = $("tplText").value; showPreview(); saveTemplate(); });
$("insName").addEventListener("click", () => {
  const ta = $("tplText"), s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + "{first_name}" + ta.value.slice(e);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + 12;
  ta.dispatchEvent(new Event("input"));
});
$("imgFile").addEventListener("change", () => {
  const f = $("imgFile").files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { $("imgName").textContent = "That image is over 8 MB. Choose a smaller one."; return; }
  const r = new FileReader();
  r.onload = () => { template.imageDataUrl = r.result; template.imageName = f.name; saveTemplate(); showImage(); };
  r.readAsDataURL(f);
  $("imgFile").value = "";
});
$("imgRemove").addEventListener("click", () => { template.imageDataUrl = ""; template.imageName = ""; saveTemplate(); showImage(); });
for (const id of ["sBetween", "sStep", "sCap", "sOrder", "sLastMine", "sSentDone", "sImgReq", "sTest", "aBlocked", "aNames", "aStop",
  "aHot", "aWarm", "aCold", "bAuto", "bLabelName"]) {
  $(id).addEventListener("change", readSettings);
}
$("aReset").addEventListener("click", () => {
  Object.assign(settings, { blockedTexts: DEF.blockedTexts, excludeNames: DEF.excludeNames, stopTexts: DEF.stopTexts,
    hotWords: DEF.hotWords, warmWords: DEF.warmWords, coldWords: DEF.coldWords });
  saveSettings(); fillForm();
});

// ---------- talking to the Business Suite tab ----------
async function send(cmd, extra) {
  const r = await sendToInbox(cmd, extra);
  tabId = r.tab ? r.tab.id : null;
  $("where").textContent = r.tab && r.ok !== false ? "Connected to your Business Suite tab" : r.message;
  return r;
}

// While not connected, keep checking every few seconds, so opening the inbox is all it takes.
let reconnectTimer = null;
function watchConnection() {
  clearInterval(reconnectTimer);
  reconnectTimer = setInterval(async () => {
    if (state !== "offline") { clearInterval(reconnectTimer); return; }
    const r = await send("ping");
    if (r.ok) { clearInterval(reconnectTimer); setState(r.state !== "idle" ? r.state : "idle", r.state !== "idle" && r.last ? r.last.reason : "Connected. Write your message, then press Start."); }
  }, 3000);
}

function setState(s, reason, current) {
  state = s;
  const label = { idle: "Ready", running: "Running", paused: "Paused", stopped: "Stopped", finished: "Finished", offline: "Not connected" }[s] || s;
  $("pill").textContent = label;
  $("pill").className = "pill " + s;
  if (reason !== undefined) $("reason").textContent = reason || (s === "running" ? "Working through your inbox…" : "");
  if (current !== undefined) $("current").textContent = current ? "Now: " + current : "";
  $("start").disabled = s === "running" || s === "paused" || scrollState === "running" || scrollState === "paused";
  $("pause").disabled = !(s === "running" || s === "paused");
  $("pause").textContent = s === "paused" ? "Resume" : "Pause";
  $("stop").disabled = !(s === "running" || s === "paused");
  for (const id of ["tLoad", "tLatest", "tCheck"]) $(id).disabled = s === "running" || s === "paused";
}

function showStats(st) {
  st = st && st.date === new Date().toLocaleDateString("en-CA") ? st : { sent: 0, excluded: 0, skipped: 0, failed: 0, unknown: 0 };
  $("cSent").textContent = st.sent;
  $("cDone").textContent = st.excluded;
  $("cSkip").textContent = st.skipped;
  $("cProb").textContent = st.failed + st.unknown;
}
function logItem(e) {
  const li = document.createElement("li");
  const st = document.createElement("span");
  st.className = "st " + e.status; st.textContent = e.status === "EXCLUDED" ? "DONE" : e.status;
  const who = document.createElement("span");
  who.className = "who"; who.textContent = e.name;
  const why = document.createElement("span");
  why.className = "why"; why.textContent = new Date(e.time).toLocaleTimeString() + " · " + e.reason;
  li.append(st, who, why);
  return li;
}
function showLog(entries) {
  const ol = $("log");
  ol.replaceChildren(...entries.slice(-200).reverse().map(logItem));
  if (!entries.length) ol.innerHTML = '<li class="why" style="display:block">Nothing yet. Activity appears here while it runs.</li>';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "fu-status") return;
  if (msg.state) {
    setState(msg.state.state, msg.state.reason, msg.state.current);
    $("seeProblems").hidden = !(msg.state.state === "paused" && /Problems tab/.test(msg.state.reason || ""));
  }
  if (msg.stats) showStats(msg.stats);
  if (msg.entry) {
    const ol = $("log");
    if (ol.firstElementChild && !ol.firstElementChild.querySelector(".st")) ol.innerHTML = "";
    ol.prepend(logItem(msg.entry));
    while (ol.children.length > 200) ol.lastElementChild.remove();
  }
  if (msg.progress) { $("toolOut").hidden = false; $("toolOut").textContent = msg.progress; }
  if (msg.scroll) showScroll(msg.scroll);
  if (msg.buyers) buyersBusy(msg.buyers.state !== "done", msg.buyers.message);
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.campaign) $("remembered").textContent = `${(ch.campaign.newValue && ch.campaign.newValue.doneIds.length) || 0} chats remembered in this campaign`;
});

// ---------- tabs and the Problems list ----------
function showTab(which) {
  for (const [tab, view, name] of [["tabMain", "mainView", "main"], ["tabBuyers", "buyersView", "buyers"], ["tabProblems", "problemsView", "problems"]]) {
    $(view).hidden = which !== name;
    $(tab).classList.toggle("on", which === name);
    $(tab).setAttribute("aria-selected", String(which === name));
  }
}
$("tabMain").addEventListener("click", () => showTab("main"));
$("tabBuyers").addEventListener("click", () => showTab("buyers"));
$("tabProblems").addEventListener("click", () => showTab("problems"));
$("seeProblems").addEventListener("click", () => showTab("problems"));

function problemItem(p) {
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.className = "ph";
  const who = document.createElement("div");
  who.textContent = p.name;
  const when = document.createElement("span");
  when.textContent = new Date(p.time).toLocaleString();
  head.append(who, when);
  const part = (label, text, cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    const b = document.createElement("b");
    b.textContent = label + " ";
    d.append(b, document.createTextNode(text));
    return d;
  };
  li.append(head, part("What happened:", p.help.what), part("Why:", p.help.why), part("How to fix:", p.help.fix, "fix"));
  return li;
}
function showProblems(list) {
  const today = new Date().toLocaleDateString("en-CA");
  const n = list.filter((p) => new Date(p.time).toLocaleDateString("en-CA") === today).length;
  $("probCount").textContent = n;
  $("probCount").hidden = !n;
  const ol = $("problems");
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No problems. When something goes wrong, it shows up here with how to fix it.";
    ol.replaceChildren(li);
    return;
  }
  ol.replaceChildren(...list.slice(-100).reverse().map(problemItem));
}
$("pClear").addEventListener("click", () => ask("Clear the Problems list?", async () => {
  await chrome.storage.local.set({ problems: [] }); showProblems([]);
}));
chrome.storage.onChanged.addListener((ch) => { if (ch.problems) showProblems(ch.problems.newValue || []); });

// ---------- saved messages ----------
function statsFor(tid) {
  const list = Object.values(contacts).filter((c) => !tid || c.templateId === tid);
  const replied = list.filter((c) => c.kind);
  return { sent: list.length, replied: replied.length, hot: replied.filter((c) => c.kind === "hot").length,
    warm: replied.filter((c) => c.kind === "warm").length, cold: replied.filter((c) => c.kind === "cold").length,
    other: replied.filter((c) => c.kind === "replied").length };
}
function showTemplates() {
  $("tplSelect").replaceChildren(...templates.map((t) => new Option(t.name, t.id, false, t.id === template.id)));
  $("tplName").value = template.name;
  $("tplDel").disabled = templates.length < 2;
  const st = statsFor(template.id);
  const pct = st.sent ? Math.round((st.replied / st.sent) * 100) : 0;
  const chip = (label, n) => { const s = document.createElement("span"); s.append(label + " "); const b = document.createElement("b"); b.textContent = n; s.append(b); return s; };
  $("tplStats").replaceChildren(chip("Sent", st.sent), chip("Replied", `${st.replied} (${pct}%)`), chip("🔥 Hot", st.hot));
  const f = $("bFilter").value;
  $("bFilter").replaceChildren(new Option("All messages", ""), ...templates.map((t) => new Option(t.name, t.id, false, t.id === f)));
}
function selectTemplate(id) {
  template = templates.find((t) => t.id === id) || templates[0];
  saveTemplate();
  fillForm();
}
$("tplSelect").addEventListener("change", () => selectTemplate($("tplSelect").value));
$("tplName").addEventListener("input", () => {
  template.name = $("tplName").value.trim() || "Untitled message";
  saveTemplate();
  $("tplSelect").selectedOptions[0].textContent = template.name;
});
$("tplNew").addEventListener("click", () => {
  const t = { id: "t" + Date.now(), name: "Message " + (templates.length + 1), text: "Hi {first_name}! ", imageDataUrl: "", imageName: "" };
  templates.push(t);
  selectTemplate(t.id);
  $("tplText").focus();
});
$("tplDel").addEventListener("click", () => {
  if (templates.length < 2) return;
  ask(`Delete the message “${template.name}”? Its reply numbers stay in the Buyers tab.`, () => {
    templates = templates.filter((t) => t.id !== template.id);
    selectTemplate(templates[0].id);
  });
});

// ---------- Buyers ----------
const KIND = { hot: ["HOT", 0], warm: ["WARM", 1], replied: ["REPLIED", 2], cold: ["NOT INTERESTED", 3] };
function leadItem(c) {
  const li = document.createElement("li");
  li.className = c.kind;
  const head = document.createElement("div");
  head.className = "lh";
  const who = document.createElement("span");
  who.className = "who"; who.textContent = c.name;
  const pill = document.createElement("span");
  pill.className = "kind " + c.kind; pill.textContent = KIND[c.kind][0];
  head.append(who, pill);
  const said = document.createElement("div");
  said.className = "said"; said.textContent = "“" + (c.reply || "") + "”";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `Message: ${c.templateName || "—"} · sent ${new Date(c.sentAt).toLocaleDateString()}`;
  const foot = document.createElement("div");
  foot.className = "lh";
  const lab = document.createElement("span");
  if (c.kind === "hot") {
    lab.className = "lab" + (c.labelError && !c.labeled ? " bad" : "");
    lab.textContent = c.labeled ? `✓ Labeled “${settings.labelName}”` : c.labelError ? "Label not added (see Problems)" : "Not labeled yet";
  }
  const open = document.createElement("button");
  open.className = "small"; open.textContent = "Open chat";
  open.addEventListener("click", async () => {
    $("bStatus").textContent = `Opening ${c.name}…`;
    const r = await send("openChat", { key: c.key, name: c.name });
    $("bStatus").textContent = r.ok ? `Opened ${c.name} in Business Suite.` : r.message;
  });
  foot.append(lab, open);
  li.append(head, said, meta, foot);
  return li;
}
function showBuyers() {
  const f = $("bFilter").value;
  const st = statsFor(f);
  $("bHot").textContent = st.hot; $("bWarm").textContent = st.warm; $("bReplied").textContent = st.other; $("bCold").textContent = st.cold;
  const pct = st.sent ? Math.round((st.replied / st.sent) * 100) : 0;
  $("bSummary").textContent = st.sent ? `${st.sent} people followed up · ${st.replied} replied (${pct}%)` : "Nobody followed up yet. Send a run first, then press Check replies.";
  const hotAll = statsFor("").hot;
  $("hotCount").textContent = hotAll; $("hotCount").hidden = !hotAll;
  const people = Object.values(contacts).filter((c) => c.kind && (!f || c.templateId === f))
    .sort((a, b) => KIND[a.kind][1] - KIND[b.kind][1] || String(b.replyAt).localeCompare(String(a.replyAt)));
  if (!people.length) {
    const li = document.createElement("li");
    li.className = "meta"; li.textContent = "No replies yet. Press Check replies after people have had time to answer.";
    $("leads").replaceChildren(li);
  } else $("leads").replaceChildren(...people.slice(0, 300).map(leadItem));
  showTemplates();
}
$("bFilter").addEventListener("change", showBuyers);
function buyersBusy(busy, message) {
  $("bCheck").disabled = busy; $("bLabel").disabled = busy; $("bStop").hidden = !busy;
  if (message !== undefined) $("bStatus").textContent = message;
}
$("bCheck").addEventListener("click", async () => {
  readSettings();
  const r = await send("checkReplies");
  buyersBusy(r.ok, r.message);
});
$("bLabel").addEventListener("click", async () => {
  readSettings();
  const r = await send("labelHot");
  buyersBusy(r.ok, r.message);
});
$("bStop").addEventListener("click", () => send("stopBuyers"));
chrome.storage.onChanged.addListener((ch) => { if (ch.contacts) { contacts = ch.contacts.newValue || {}; showBuyers(); } });

// ---------- your inbox link ----------
function showInboxMsg(text, kind) {
  const el = $("inboxMsg");
  const id = settings.inboxUrl ? assetIdOf(settings.inboxUrl) : null;
  el.textContent = text || (settings.inboxUrl ? (id ? `Saved. Only runs on this Page (id ${id}).` : "Saved.") : "");
  el.className = "hint " + (kind || (settings.inboxUrl ? "good" : ""));
}
$("inboxUrl").addEventListener("change", () => {
  const c = checkInboxUrl($("inboxUrl").value);
  if (!c.ok) { showInboxMsg(c.message, "bad"); return; }
  settings.inboxUrl = c.url;
  $("inboxUrl").value = c.url;
  saveSettings();
  showInboxMsg();
});
$("openInbox").addEventListener("click", async () => {
  const c = checkInboxUrl($("inboxUrl").value);
  if (!c.ok) { showInboxMsg(c.message, "bad"); return; }
  if (c.url !== settings.inboxUrl) { settings.inboxUrl = c.url; saveSettings(); showInboxMsg(); }
  await openInbox(c.url);
  setState("offline", "Opening your inbox…");
  watchConnection();
});

// ---------- buttons ----------
$("start").addEventListener("click", async () => {
  readSettings();
  const r = await send("start");
  if (!r.ok) { setState(r.tab ? "idle" : "offline", r.message); if (!r.tab) watchConnection(); return; }
  setState("running", settings.testMode ? "Test mode: nothing will be sent." : "Working through your inbox…");
});
$("pause").addEventListener("click", async () => { await send(state === "paused" ? "resume" : "pause"); });
$("stop").addEventListener("click", async () => { await send("stop"); });

async function tool(cmd, busy) {
  const out = $("toolOut");
  out.hidden = false; out.textContent = busy;
  const r = await send(cmd);
  if (cmd === "diagnose" && r.ok) {
    const d = r.report, yes = (b) => (b ? "✓ found" : "✗ not found");
    out.textContent = [
      `Inbox list:        ${yes(d.inboxList)} (${d.rows} chats visible)`,
      ...d.firstRows.map((x) => `   • ${x.name}  → "${x.firstName}"${x.lastFromMe ? "" : "  (customer wrote last)"}`),
      `Open chat:         ${d.threadId ? "id " + d.threadId : "none selected"}`,
      `Message box:       ${yes(d.messageBox)}`,
      `Send button:       ${yes(d.sendButton)}${d.messageBox && !d.sendButton ? " (will press Enter instead)" : ""}`,
      `Done (✔) button:   ${yes(d.doneButton)}`,
      `Image upload:      ${yes(d.fileInput)}`,
      `"Can't message":   ${d.cantMessageBanner ? "shown on this chat" : "not shown"}`,
      `Meta warning:      ${d.warning ? '"' + d.warning + '"' : "none"}`,
    ].join("\n");
  } else {
    out.textContent = r.message || (r.ok ? "Done" : "Didn't work");
  }
}
// "Scroll inbox to the bottom": Start → Pause → Resume, with its own Stop.

function showScroll(p) {
  scrollState = p.state === "done" ? "idle" : p.state;
  const active = scrollState === "running" || scrollState === "paused";
  $("tLoad").textContent = scrollState === "running" ? "Pause scrolling" : scrollState === "paused" ? "Resume scrolling" : "Scroll inbox to the bottom";
  $("tLoad").classList.toggle("primary", active);
  $("scrollBar").hidden = !active;
  if (p.message) $("scrollMsg").textContent = p.message;
  if (p.state === "done") { $("toolOut").hidden = false; $("toolOut").textContent = `${p.message} (${p.rows} chats on screen)`; }
  $("start").disabled = active || state === "running" || state === "paused";
}
$("tLoad").addEventListener("click", async () => {
  const cmd = scrollState === "running" ? "pauseScroll" : scrollState === "paused" ? "resumeScroll" : "loadInbox";
  const r = await send(cmd);
  if (cmd === "loadInbox" && !r.ok) { $("toolOut").hidden = false; $("toolOut").textContent = r.message; }
});
$("tLoadStop").addEventListener("click", () => send("stopScroll"));

// Keyboard shortcuts, as currently set in Chrome
const KEY_LABELS = { "toggle-run": "Start / Pause / Resume", stop: "Stop", "toggle-scroll": "Scroll inbox: start / pause / resume", "scroll-latest": "Scroll chat to latest" };
async function showKeys() {
  const cmds = await chrome.commands.getAll();
  const order = Object.keys(KEY_LABELS);
  const rows = cmds.filter((c) => KEY_LABELS[c.name]).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((c) => {
    const tr = document.createElement("tr");
    const k = document.createElement("td"), d = document.createElement("td");
    const kbd = document.createElement("kbd");
    kbd.textContent = c.shortcut || "not set";
    k.append(kbd); d.textContent = KEY_LABELS[c.name];
    tr.append(k, d);
    return tr;
  });
  $("keys").replaceChildren(...rows);
}
$("kChange").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
window.addEventListener("focus", showKeys);
$("tLatest").addEventListener("click", () => tool("scrollLatest", "Scrolling…"));
$("tCheck").addEventListener("click", () => tool("diagnose", "Checking…"));

$("lExport").addEventListener("click", async () => {
  const { log = [] } = await chrome.storage.local.get("log");
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = "time,name,status,reason\n" + log.map((e) => [e.time, e.name, e.status, e.reason].map(q).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = `followup-log-${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
});
function ask(text, yes) {
  $("confirmText").textContent = text;
  $("confirm").hidden = false;
  $("confirmYes").onclick = () => { $("confirm").hidden = true; yes(); };
  $("confirmNo").onclick = () => { $("confirm").hidden = true; };
}
$("lClear").addEventListener("click", () => ask("Clear the activity list? (Who was already messaged is still remembered.)", async () => {
  await chrome.storage.local.set({ log: [] }); showLog([]);
}));
$("newCampaign").addEventListener("click", () => ask("Start a new campaign? The app forgets who it already messaged, so everyone becomes eligible again.", async () => {
  await chrome.storage.local.set({ campaign: { id: Date.now(), doneIds: [] } });
  $("remembered").textContent = "0 chats remembered in this campaign";
}));

// ---------- start up ----------
(async () => {
  await loadAll();
  setState("idle");
  showKeys();
  showBuyers();
  const bs = await send("buyersState");
  if (bs.ok && bs.busy) buyersBusy(true, "Working…");
  const sc = await send("scrollState");
  if (sc.ok && sc.state !== "idle") showScroll({ state: sc.state, message: sc.state === "paused" ? "Scrolling paused" : "Scrolling the inbox down…" });
  const r = await send("ping");
  if (r.ok && r.state !== "idle") setState(r.state, r.last && r.last.reason, r.last && r.last.current);
  else if (!r.ok) { setState("offline", r.message); watchConnection(); }
  else setState("idle", "Connected. Write your message, then press Start.");
})();
