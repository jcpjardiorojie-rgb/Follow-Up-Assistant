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
};
const BAD = new Set(["FAILED", "REVIEW", "UNKNOWN"]);
let settings = {}, template = {}, tabId = null, state = "idle", scrollState = "idle";

// ---------- storage ----------
async function loadAll() {
  const d = await chrome.storage.local.get(["settings", "template", "stats", "log", "campaign"]);
  settings = Object.assign({}, DEF, d.settings || {});
  template = d.template || { text: DEF.template, imageDataUrl: "", imageName: "" };
  fillForm();
  showStats(d.stats);
  showLog(d.log || []);
  $("remembered").textContent = `${(d.campaign && d.campaign.doneIds.length) || 0} chats remembered in this campaign`;
}
const saveSettings = () => chrome.storage.local.set({ settings });
const saveTemplate = () => chrome.storage.local.set({ template });

// ---------- form ----------
const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
function fillForm() {
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
for (const id of ["sBetween", "sStep", "sCap", "sOrder", "sLastMine", "sSentDone", "sImgReq", "sTest", "aBlocked", "aNames", "aStop"]) {
  $(id).addEventListener("change", readSettings);
}
$("aReset").addEventListener("click", () => {
  Object.assign(settings, { blockedTexts: DEF.blockedTexts, excludeNames: DEF.excludeNames, stopTexts: DEF.stopTexts });
  saveSettings(); fillForm();
});

// ---------- talking to the Business Suite tab ----------
async function send(cmd) {
  const r = await sendToInbox(cmd);
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
  if (msg.state) setState(msg.state.state, msg.state.reason, msg.state.current);
  if (msg.stats) showStats(msg.stats);
  if (msg.entry) {
    const ol = $("log");
    if (ol.firstElementChild && !ol.firstElementChild.querySelector(".st")) ol.innerHTML = "";
    ol.prepend(logItem(msg.entry));
    while (ol.children.length > 200) ol.lastElementChild.remove();
  }
  if (msg.progress) { $("toolOut").hidden = false; $("toolOut").textContent = msg.progress; }
  if (msg.scroll) showScroll(msg.scroll);
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.campaign) $("remembered").textContent = `${(ch.campaign.newValue && ch.campaign.newValue.doneIds.length) || 0} chats remembered in this campaign`;
});

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
  const sc = await send("scrollState");
  if (sc.ok && sc.state !== "idle") showScroll({ state: sc.state, message: sc.state === "paused" ? "Scrolling paused" : "Scrolling the inbox down…" });
  const r = await send("ping");
  if (r.ok && r.state !== "idle") setState(r.state, r.last && r.last.reason, r.last && r.last.current);
  else if (!r.ok) { setState("offline", r.message); watchConnection(); }
  else setState("idle", "Connected. Write your message, then press Start.");
})();
