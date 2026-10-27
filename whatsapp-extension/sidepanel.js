// Side panel: your message, settings, Buyers, Log, and Start/Pause/Stop for the WhatsApp Web tab.
const $ = (id) => document.getElementById(id);
const D = WAEngine.DEFAULTS;
try { $("ver").textContent = "v" + chrome.runtime.getManifest().version; } catch (_) {}
const today = () => new Date().toLocaleDateString("en-CA");
let settings = {}, templates = [], active = "t1", state = "idle", replies = {};

// ---------- settings form ----------
const CHECKS = { sLastMine: "onlyIfLastFromMe", sGroups: "skipGroups", sTilde: "useTildeName", sImgReq: "imageRequired", sFront: "frontOnStart",
  sLauncher: "launcherCheck", sAwake: "keepAwake", sTest: "testMode", sFinEnd: "finishOnEnd", sFinDaily: "finishOnDaily", sFinAlready: "finishOnAlready",
  sPC: "notifyPC", sPhone: "notifyPhone", dCheck: "dupCheck", rAuto: "autoCheckReplies", bLabelOn: "labelHot", bkOn: "backupOn", bkLog: "diaryToFile" };
const NUMS = { sCap: "dailyCap", sGapMin: "gapMinSec", sGapMax: "gapMaxSec", sCountdown: "finishCountdownSec", scCount: "scrollCount",
  scPatience: "bottomWaitSec", sStopAfter: "stopAfter", rMins: "autoCheckMinutes" };
const SELECTS = { sOrder: "order", sImgStyle: "imageStyle", sFinish: "whenFinished", sStopBy: "stopBy" };
const TEXTS = { sWord: "unsavedWord", sTopic: "ntfyTopic", bLabelName: "labelName", sAccount: "accountName", bkFolder: "backupFolder" };
const RADIOS = { limitMode: "limitMode", scrollHow: "scrollHow", replyMode: "replyMode" };

function fillForm() {
  for (const [id, k] of Object.entries(CHECKS)) $(id).checked = !!settings[k];
  for (const [id, k] of Object.entries(NUMS)) $(id).value = settings[k];
  for (const [id, k] of Object.entries(SELECTS)) $(id).value = settings[k];
  for (const [id, k] of Object.entries(TEXTS)) $(id).value = settings[k] || "";
  for (const [name, k] of Object.entries(RADIOS)) for (const r of document.querySelectorAll(`input[name=${name}]`)) r.checked = r.value === settings[k];
  $("sStep").value = (settings.stepDelayMs / 1000).toFixed(1);
  $("scWait").value = settings.scrollWaitSec;
  settings.ramp.forEach((n, i) => { $("r" + i).value = n; });
  $("wordEx").textContent = settings.unsavedWord;
  showDerived();
}
function readForm() {
  for (const [id, k] of Object.entries(CHECKS)) settings[k] = $(id).checked;
  for (const [id, k] of Object.entries(NUMS)) settings[k] = Math.max(0, Math.round(+$(id).value || 0));
  for (const [id, k] of Object.entries(SELECTS)) settings[k] = $(id).value;
  for (const [id, k] of Object.entries(TEXTS)) settings[k] = $(id).value.trim() || (k === "ntfyTopic" ? "" : D[k]);
  for (const [name, k] of Object.entries(RADIOS)) { const r = document.querySelector(`input[name=${name}]:checked`); settings[k] = r ? r.value : D[k]; }
  settings.dailyCap = Math.max(1, settings.dailyCap);
  settings.finishCountdownSec = Math.max(10, settings.finishCountdownSec || 60);
  settings.stopAfter = Math.max(1, settings.stopAfter || 3);
  settings.autoCheckMinutes = Math.max(1, settings.autoCheckMinutes || 10);
  settings.scrollCount = Math.max(1, settings.scrollCount || 1);
  if (settings.gapMaxSec < settings.gapMinSec) settings.gapMaxSec = settings.gapMinSec;
  settings.stepDelayMs = Math.round(Math.max(0.3, +$("sStep").value || 1.2) * 1000);
  settings.scrollWaitSec = Math.max(0.3, +$("scWait").value || 1.5);
  settings.ramp = [0, 1, 2, 3, 4].map((i) => Math.max(1, Math.round(+$("r" + i).value || D.ramp[i])));
  chrome.storage.local.set({ settings });
  showPreview();
  showDerived();
}
for (const el of document.querySelectorAll("#tab-settings input:not(#sToday), #tab-settings select")) el.addEventListener("change", readForm);
$("sWord").addEventListener("input", () => { $("wordEx").textContent = $("sWord").value.trim() || D.unsavedWord; });
$("sToday").addEventListener("change", async () => {
  const n = Math.round(+$("sToday").value || 0);
  await chrome.storage.local.set({ todayOverride: n > 0 ? { date: today(), n } : null });
  showPlan();
});
function waFolder() {
  const base = String(settings.backupFolder || D.backupFolder).replace(/[\\/]+$/, "");
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return base + sep + "WhatsApp - " + (String(settings.accountName || "WhatsApp").replace(/[\\/:*?"<>|]+/g, " ").trim() || "WhatsApp");
}
// Things that depend on the settings: summaries, sub-options, folder, account name.
function showDerived() {
  $("dOptions").hidden = !settings.dupCheck;
  $("account").textContent = settings.accountName;
  $("bkWhere").textContent = "Files go to: " + waFolder();
  showSummaries();
  showPlan();
}

// W4: one line under each section title with its current values.
const ORDER_NAME = { top: "Newest first", bottom: "Oldest first (all the way)", bottomFar: "Oldest first (How far)", screen: "Lowest on screen" };
const FINISH_NAME = { nothing: "Do nothing", closeTab: "Close the tab", closeChrome: "Close Chrome", shutdown: "Shut down" };
function showSummaries() {
  const s = settings, put = (k, t) => { $("sum_" + k).textContent = t; };
  put("order", `${ORDER_NAME[s.order]} · ${s.onlyIfLastFromMe ? "my message last" : "everyone"}${s.skipGroups ? " · no groups" : ""} · Already messaged: ${s.dupCheck ? "stop after " + s.stopAfter : "Off"}`);
  put("names", `Numbers only: “${s.unsavedWord}”${s.useTildeName ? " · ~name" : ""}`);
  put("perday", s.limitMode === "fixed" ? `${s.dailyCap} every day` : `Warm-up ${s.ramp.join(" → ")}`);
  put("send", `${s.gapMinSec}–${s.gapMaxSec} s between chats · image ${s.imageStyle === "one" ? "one bubble" : "two bubbles"}${s.testMode ? " · TEST MODE" : ""}`);
  put("finish", `${FINISH_NAME[s.whenFinished]}${s.whenFinished !== "nothing" ? ` · ${s.finishCountdownSec} s` : ""} · ${[s.notifyPC && "PC", s.notifyPhone && "phone"].filter(Boolean).join(" + ") || "no notifications"}`);
  put("buyers", `${s.replyMode === "auto" ? "Send right away" : "Ask me first"}${s.autoCheckReplies ? ` · every ${s.autoCheckMinutes} min` : ""}${s.labelHot ? ` · label “${s.labelName}”` : ""}`);
  put("scroll", `${s.scrollHow === "count" ? s.scrollCount + " scrolls" : "All the way"} · ${s.scrollWaitSec} s · keeps trying ${s.bottomWaitSec} s`);
  put("saving", `“${s.accountName}” · ${s.backupOn ? waFolder() : "saving off"}`);
}
const SECTION_KEYS = {
  order: ["order", "onlyIfLastFromMe", "skipGroups", "dupCheck", "stopBy", "stopAfter"],
  names: ["unsavedWord", "useTildeName"],
  perday: ["limitMode", "ramp", "dailyCap"],
  send: ["gapMinSec", "gapMaxSec", "stepDelayMs", "imageStyle", "imageRequired", "frontOnStart", "launcherCheck", "keepAwake", "testMode"],
  finish: ["whenFinished", "finishCountdownSec", "finishOnAlready", "finishOnEnd", "finishOnDaily", "notifyPC", "notifyPhone"], // your ntfy topic is kept
  buyers: ["replyMode", "autoCheckReplies", "autoCheckMinutes", "labelHot", "labelName"],
  scroll: ["scrollHow", "scrollCount", "scrollWaitSec", "bottomWaitSec"],
  saving: ["backupOn", "backupFolder", "diaryToFile"], // the account name is kept
};
for (const b of document.querySelectorAll("button.reset[data-reset]")) {
  b.addEventListener("click", () => {
    const sec = b.dataset.reset;
    const title = b.closest("details.sec").querySelector(".sect").textContent.replace(/^\d+ · /, "");
    if (!confirm(`Reset “${title}” to the default values?`)) return;
    for (const k of SECTION_KEYS[sec]) settings[k] = Array.isArray(D[k]) ? [...D[k]] : D[k];
    chrome.storage.local.set({ settings });
    fillForm(); showPreview();
  });
}
// Remember which sections are open (first time: only the first one).
(async () => {
  let open = ["order"];
  try { const d = await chrome.storage.local.get("openSections"); if (Array.isArray(d.openSections)) open = d.openSections; } catch (_) {}
  for (const d of document.querySelectorAll("details.sec")) {
    d.open = open.includes(d.dataset.sec);
    d.addEventListener("toggle", () => {
      chrome.storage.local.set({ openSections: [...document.querySelectorAll("details.sec")].filter((x) => x.open).map((x) => x.dataset.sec) }).catch(() => {});
    });
  }
})();

// ---------- daily limit (the same rule as in the WhatsApp tab) ----------
async function limitNow() {
  const d = await chrome.storage.local.get(["days", "todayOverride", "stats"]);
  const t = today(), days = d.days || [];
  const day = days.filter((x) => x < t).length + 1;
  const r = settings.ramp;
  const plan = settings.limitMode === "fixed" ? settings.dailyCap : day <= 3 ? r[0] : day <= 6 ? r[1] : day <= 13 ? r[2] : day <= 20 ? r[3] : r[4];
  const own = d.todayOverride && d.todayOverride.date === t && +d.todayOverride.n > 0 ? +d.todayOverride.n : 0;
  const sent = d.stats && d.stats.date === t ? d.stats.sent : 0;
  return { day, plan, own, limit: own || plan, sent };
}
async function showPlan() {
  const l = await limitNow();
  $("sToday").value = l.own || "";
  $("planNow").textContent = (settings.limitMode === "fixed" ? `Plan: ${l.plan} every day.` : `Plan: day ${l.day} → ${l.plan} today.`) +
    (l.own ? ` Today you chose ${l.own} instead.` : "") + ` ${l.sent} sent so far today.`;
  showToday(l);
}
function showToday(l) {
  if (!l) return;
  $("todayText").textContent = `Today: ${l.sent} of ${l.limit} sent`;
  $("dayText").textContent = l.own ? "your own number today" : settings.limitMode === "fixed" ? "same every day" : `warm-up day ${l.day}`;
  $("todayBar").style.width = Math.min(100, Math.round((l.sent / Math.max(1, l.limit)) * 100)) + "%";
}
// W5: today's counters
function showStats(st) {
  if (!st || st.date !== today()) st = { sent: 0, skipped: 0, already: 0, replies: 0, failed: 0 };
  $("cSent").textContent = st.sent || 0;
  $("cSkipped").textContent = (st.skipped || 0) + (st.already || 0);
  $("cReplies").textContent = st.replies || 0;
  $("cFailed").textContent = st.failed || 0;
}

// ---------- saved messages ----------
const tpl = () => templates.find((t) => t.id === active) || templates[0];
function saveTemplates() { chrome.storage.local.set({ templates, activeTemplate: active }); }
function showTemplates() {
  $("tplSelect").replaceChildren(...templates.map((t) => { const o = document.createElement("option"); o.value = t.id; o.textContent = t.name; return o; }));
  $("tplSelect").value = active;
  $("text").value = tpl().text;
  $("tplDelete").disabled = templates.length < 2;
  showImage();
  showPreview();
}
$("tplSelect").addEventListener("change", () => { active = $("tplSelect").value; saveTemplates(); showTemplates(); });
$("tplNew").addEventListener("click", () => {
  const name = prompt("Name for the new message:", `Message ${templates.length + 1}`);
  if (!name) return;
  const t = { id: "t" + Date.now(), name: name.trim(), text: "", imageDataUrl: "", imageName: "" };
  templates.push(t); active = t.id; saveTemplates(); showTemplates();
});
$("tplRename").addEventListener("click", () => {
  const name = prompt("New name:", tpl().name);
  if (!name) return;
  tpl().name = name.trim(); saveTemplates(); showTemplates();
});
$("tplDelete").addEventListener("click", () => {
  if (templates.length < 2 || !confirm(`Delete “${tpl().name}”?`)) return;
  templates = templates.filter((t) => t.id !== active); active = templates[0].id; saveTemplates(); showTemplates();
});
let typing = null;
$("text").addEventListener("input", () => { tpl().text = $("text").value; showPreview(); clearTimeout(typing); typing = setTimeout(saveTemplates, 300); });
function readImage(file, done) { const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(file); }
$("imgFile").addEventListener("change", () => {
  const f = $("imgFile").files[0];
  if (!f) return;
  readImage(f, (url) => { Object.assign(tpl(), { imageDataUrl: url, imageName: f.name }); saveTemplates(); showImage(); showPreview(); });
  $("imgFile").value = "";
});
$("imgRemove").addEventListener("click", () => { Object.assign(tpl(), { imageDataUrl: "", imageName: "" }); saveTemplates(); showImage(); showPreview(); });
function showImage() {
  const t = tpl(), has = !!t.imageDataUrl;
  $("thumb").style.backgroundImage = has ? `url("${t.imageDataUrl}")` : "";
  $("thumb").textContent = has ? "" : "No image";
  $("imgName").textContent = has ? t.imageName : "";
  $("imgRemove").hidden = !has;
}
function bubble(el, text, img, style) {
  el.replaceChildren();
  if (img && style !== "two") { const i = document.createElement("img"); i.src = img; el.appendChild(i); }
  el.appendChild(document.createTextNode(text));
  if (img && style === "two") el.appendChild(document.createTextNode("\n＋ then the image as a second bubble"));
}
function showPreview() {
  const text = tpl().text || "";
  bubble($("pv1"), WAEngine.tools.render(text, "Joy Santos", settings), tpl().imageDataUrl, settings.imageStyle);
  bubble($("pv2"), WAEngine.tools.render(text, "+63 917 123 4567", settings, "Mark D"), tpl().imageDataUrl, settings.imageStyle);
}

// ---------- tabs ----------
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) x.setAttribute("aria-selected", String(x === b));
    for (const name of ["main", "buyers", "activity", "problems", "log", "settings"]) $("tab-" + name).hidden = name !== b.dataset.tab;
    if (b.dataset.tab === "activity") showLog();
    if (b.dataset.tab === "problems") showProblems();
    if (b.dataset.tab === "log") showDiary();
    if (b.dataset.tab === "buyers") showBuyers();
  });
}

// ---------- activity & problems ----------
function item(e, withHelp) {
  const li = document.createElement("li");
  const st = document.createElement("span"); st.className = "st " + e.status; st.textContent = e.status;
  const who = document.createElement("span"); who.textContent = e.name;
  const why = document.createElement("span"); why.className = "why"; why.textContent = new Date(e.time).toLocaleString() + " · " + e.reason;
  li.append(st, who, why);
  if (withHelp && e.help) {
    li.classList.add("prob");
    for (const [k, label] of [["what", "What happened"], ["why", "Why"], ["fix", "How to fix"]]) {
      const b = document.createElement("b"); b.textContent = label; const p = document.createElement("span"); p.textContent = e.help[k];
      li.append(b, p);
    }
  }
  return li;
}
async function showLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  $("log").replaceChildren(...log.slice(-300).reverse().map((e) => item(e)));
  if (!log.length) $("log").innerHTML = '<li class="why">Nothing yet. Each chat shows here while it runs.</li>';
}
async function showProblems() {
  const { problems = [] } = await chrome.storage.local.get("problems");
  $("problems").replaceChildren(...problems.slice(-100).reverse().map((e) => item(e, true)));
  if (!problems.length) $("problems").innerHTML = '<li class="why">No problems. 👍</li>';
  $("probCount").hidden = !problems.length;
  $("probCount").textContent = problems.length;
}
$("logClear").addEventListener("click", async () => { if (confirm("Clear the Activity list?")) { await chrome.storage.local.set({ log: [] }); showLog(); } });
$("probClear").addEventListener("click", async () => { await chrome.storage.local.set({ problems: [] }); showProblems(); });
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
// W5: Activity as a spreadsheet
$("logExport").addEventListener("click", async () => {
  const { log = [] } = await chrome.storage.local.get("log");
  const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  download(`whatsapp-followup-activity-${today()}.csv`, "Time,Name,Status,Details\r\n" + log.map((e) => [new Date(e.time).toLocaleString(), e.name, e.status, e.reason].map(cell).join(",")).join("\r\n"), "text/csv");
});

// ---------- Log (W2) ----------
const FILTERS = { runs: /^(RUN|FINISH|STOP|AFTER)$/, problems: /^(PROBLEM)$/, wait: /^(WAIT|SCREEN|SLEEP\?|PAUSE|RESUME|AWAKE)$/, replies: /^(REPLIES|LABEL)$/ };
async function showDiary() {
  await sendToWa("flushDiary").catch(() => {});
  const { diary = [], runs = [] } = await chrome.storage.local.get(["diary", "runs"]);
  $("runs").replaceChildren(...runs.slice(-5).reverse().map((r) => {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.className = "st " + (r.end ? (r.code === "stopped" || r.code === "warning" ? "FAILED" : "SENT") : "TEST");
    t.textContent = r.end ? "ENDED" : "RUNNING";
    const a = document.createElement("span"); a.textContent = `${new Date(r.start).toLocaleString()} → ${r.end ? new Date(r.end).toLocaleTimeString() : "now"} · “${r.message}”`;
    const b = document.createElement("span"); b.className = "why";
    b.textContent = `${r.sent || 0} sent · ${r.skipped || 0} skipped · ${r.already || 0} already had it · ${r.problems || 0} problems · ${r.ended || ""}${r.after ? " · then: " + r.after : ""}`;
    li.append(t, a, b);
    return li;
  }));
  if (!runs.length) $("runs").innerHTML = '<li class="why">No runs yet.</li>';
  const f = FILTERS[$("dFilter").value];
  const list = diary.filter((e) => !f || f.test(e.k)).slice(-400).reverse();
  $("diary").replaceChildren(...list.map((e) => {
    const li = document.createElement("li");
    const k = document.createElement("span"); k.className = "st " + (e.k === "PROBLEM" ? "FAILED" : e.k === "RUN" || e.k === "FINISH" ? "SENT" : "SKIPPED"); k.textContent = e.k;
    const m = document.createElement("span"); m.className = "why"; m.textContent = new Date(e.t).toLocaleString() + " · " + e.m;
    li.append(k, m);
    return li;
  }));
  if (!list.length) $("diary").innerHTML = '<li class="why">Nothing here yet.</li>';
}
$("dFilter").addEventListener("change", showDiary);
$("dClear").addEventListener("click", async () => { if (confirm("Clear the Log (all 30 days)?")) { await chrome.storage.local.set({ diary: [], runs: [] }); showDiary(); } });
$("dExport").addEventListener("click", async () => {
  const { diary = [] } = await chrome.storage.local.get("diary");
  download(`whatsapp-followup-log-${today()}.txt`, diary.map((e) => `${new Date(e.t).toLocaleString()}  ${e.k.padEnd(8)} ${e.m}`).join("\r\n"), "text/plain");
});
$("copyClaude").addEventListener("click", async () => {
  await sendToWa("flushDiary").catch(() => {});
  const d = await chrome.storage.local.get(["log", "diary", "problems", "runs"]);
  const lastRun = (d.runs || []).slice(-1)[0];
  const since = lastRun ? lastRun.start : "";
  const lines = [`WhatsApp FollowUp-Assistant v${chrome.runtime.getManifest().version} · ${new Date().toLocaleString()}`, "",
    "Settings: " + JSON.stringify(settings, (k, v) => (/Words$|Texts$/.test(k) ? undefined : v))];
  const r = await sendToWa("diagnose");
  if (r.ok) lines.push("Check page: " + JSON.stringify(r.report));
  lines.push("", "Last run:", ...(d.diary || []).filter((e) => e.t >= since).slice(-150).map((e) => `${e.t} ${e.k} ${e.m}`));
  lines.push("", "Last chats:", ...(d.log || []).slice(-60).map((e) => `${e.time} ${e.status} ${e.name} · ${e.reason}`));
  lines.push("", "Problems:", ...(d.problems || []).slice(-20).map((e) => `${e.time} ${e.code} ${e.name} · ${e.reason}`));
  try { await navigator.clipboard.writeText(lines.join("\n")); } catch (_) {}
  $("copied").hidden = false; setTimeout(() => { $("copied").hidden = true; }, 4000);
});

// ---------- Buyers (W1) ----------
const KINDS = [["hot", "🔥 Hot (wants to buy)"], ["warm", "🙂 Warm (interested)"], ["cold", "❄️ Not interested"], ["replied", "💬 Other replies"]];
async function showBuyers() {
  const { contacts = {} } = await chrome.storage.local.get("contacts");
  const withReply = Object.entries(contacts).filter(([, c]) => c.reply);
  const box = $("buyers");
  box.replaceChildren();
  for (const [kind, title] of KINDS) {
    const list = withReply.filter(([, c]) => c.kind === kind).sort((a, b) => String(b[1].replyAt).localeCompare(String(a[1].replyAt)));
    if (!list.length) continue;
    const h = document.createElement("h3"); h.textContent = `${title} · ${list.length}`; box.appendChild(h);
    const ol = document.createElement("ol"); ol.className = "log";
    for (const [, c] of list) {
      const li = document.createElement("li");
      const n = document.createElement("span"); n.textContent = c.name + (c.labeled ? "  🏷" : "");
      const r = document.createElement("span"); r.className = "why"; r.textContent = `“${c.reply}”` + (c.answeredFor === c.reply ? " · answered ✓" : c.replyPending ? " · waiting for you" : "");
      li.append(n, r); ol.appendChild(li);
    }
    box.appendChild(ol);
  }
  if (!withReply.length) box.innerHTML = '<p class="hint">No replies yet. Press “Check replies now” after your follow-ups went out.</p>';
  const hot = withReply.filter(([, c]) => c.kind === "hot").length;
  $("hotCount").hidden = !hot; $("hotCount").textContent = hot;
  // Waiting for you (ask-first mode)
  const pending = Object.entries(contacts).filter(([, c]) => c.replyPending);
  $("pendingBox").hidden = !pending.length;
  $("bSendAll").hidden = !pending.length;
  $("pending").replaceChildren(...pending.map(([key, c]) => {
    const li = document.createElement("li");
    const n = document.createElement("span"); n.textContent = `${c.name} · ${KINDS.find((k) => k[0] === c.kind)[1]}`;
    const r = document.createElement("span"); r.className = "why"; r.textContent = `They wrote: “${c.reply}”`;
    const ans = document.createElement("span"); ans.className = "why"; ans.textContent = "Reply: " + WAEngine.tools.render((replies[c.kind] || {}).text || "", c.name, settings);
    const row = document.createElement("div"); row.className = "row";
    const s = document.createElement("button"); s.className = "small primary"; s.textContent = "Send"; s.addEventListener("click", () => buyersCmd("sendReplies", { keys: [key] }));
    const k = document.createElement("button"); k.className = "small"; k.textContent = "Skip"; k.addEventListener("click", async () => { await send("skipReply", { key }); showBuyers(); });
    row.append(s, k);
    li.append(n, r, ans, row);
    return li;
  }));
}
async function buyersCmd(cmd, extra) {
  const r = await send(cmd, extra);
  $("bMsg").textContent = r.message || "";
  if (r.ok && cmd !== "skipReply") buyersBusy(true, r.message);
}
function buyersBusy(on, msg) {
  $("bStop").hidden = !on;
  for (const id of ["bCheck", "bSendAll", "bLabel"]) $(id).disabled = on;
  if (msg) $("bMsg").textContent = msg;
  if (!on) showBuyers();
}
$("bCheck").addEventListener("click", () => buyersCmd("checkReplies"));
$("bSendAll").addEventListener("click", () => buyersCmd("sendReplies"));
$("bLabel").addEventListener("click", () => buyersCmd("labelHot"));
$("bStop").addEventListener("click", () => send("stopBuyers"));
// Your ready replies: one card per kind, with on/off, text and an optional image.
function saveReplies() { chrome.storage.local.set({ replies }); }
function showReplyCards() {
  const box = $("replyCards");
  box.replaceChildren(...KINDS.map(([kind, title]) => {
    const r = replies[kind];
    const card = document.createElement("div"); card.className = "sec replycard"; card.dataset.kind = kind;
    const on = document.createElement("label"); on.className = "check";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!r.on; cb.className = "rOn";
    cb.addEventListener("change", () => { r.on = cb.checked; saveReplies(); });
    on.append(cb, document.createTextNode(" " + title));
    const ta = document.createElement("textarea"); ta.rows = 3; ta.value = r.text; ta.className = "rText";
    ta.addEventListener("input", () => { r.text = ta.value; saveReplies(); });
    const img = document.createElement("div"); img.className = "row";
    const fb = document.createElement("label"); fb.className = "filebtn"; fb.textContent = r.imageDataUrl ? "Change image" : "Add image";
    const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*"; fb.appendChild(fi);
    fi.addEventListener("change", () => { const f = fi.files[0]; if (f) readImage(f, (url) => { Object.assign(r, { imageDataUrl: url, imageName: f.name }); saveReplies(); showReplyCards(); }); });
    img.appendChild(fb);
    if (r.imageDataUrl) {
      const nm = document.createElement("span"); nm.className = "hint"; nm.textContent = r.imageName;
      const rm = document.createElement("button"); rm.className = "small"; rm.textContent = "Remove";
      rm.addEventListener("click", () => { Object.assign(r, { imageDataUrl: "", imageName: "" }); saveReplies(); showReplyCards(); });
      img.append(nm, rm);
    }
    card.append(on, ta, img);
    return card;
  }));
}

// ---------- talking to WhatsApp Web ----------
async function send(cmd, extra) {
  const r = await sendToWa(cmd, extra);
  $("where").textContent = r.tab && r.ok !== false ? "Connected to WhatsApp Web" : r.message || "Connected to WhatsApp Web";
  return r;
}
function setState(s, reason, current) {
  state = s;
  const label = { idle: "Ready", running: "Running", paused: "Paused", stopped: "Stopped", finished: "Finished", offline: "Not connected" }[s] || s;
  $("pill").textContent = label; $("pill").className = "pill " + s;
  if (reason !== undefined) $("reason").textContent = reason || (s === "running" ? "Working through your chats…" : "");
  if (current !== undefined) $("current").textContent = current ? "Now: " + current : "";
  $("start").disabled = s === "running" || s === "paused" || scrollState !== "idle";
  $("pause").disabled = !(s === "running" || s === "paused");
  $("pause").textContent = s === "paused" ? "Resume" : "Pause";
  $("stop").disabled = !(s === "running" || s === "paused");
}
$("start").addEventListener("click", async () => {
  setState("running", "Starting…", "");
  const r = await send("start");
  if (!r.ok) { setState(r.tab ? "idle" : "offline", r.message); if (!r.tab) watch(); }
});
$("pause").addEventListener("click", () => send(state === "paused" ? "resume" : "pause"));
$("stop").addEventListener("click", () => send("stop"));
$("hStop").addEventListener("click", () => send("stop"));
$("openWa").addEventListener("click", () => openWhatsApp());
$("hShow").addEventListener("click", async () => { const r = await hiddenReason(); if (r) showWaTab(r.tab); });
$("finishCancel").addEventListener("click", () => send("cancelFinish"));
// "Scroll chat list to the bottom": Scroll → Pause → Resume, with its own Stop.
let scrollState = "idle";
function showScroll(p) {
  scrollState = p.state === "done" ? "idle" : p.state;
  const activeScroll = scrollState === "running" || scrollState === "paused";
  $("scroll").textContent = scrollState === "running" ? "Pause scrolling" : scrollState === "paused" ? "Resume scrolling" : "Scroll chat list to the bottom";
  $("scroll").classList.toggle("primary", activeScroll);
  $("scrollBar").hidden = !activeScroll;
  if (p.message) $("scrollMsg").textContent = p.message;
  if (p.state === "done") { $("checkOut").hidden = false; $("checkOut").textContent = p.message; }
  $("start").disabled = activeScroll || state === "running" || state === "paused";
}
$("scroll").addEventListener("click", async () => {
  const cmd = scrollState === "running" ? "pauseScroll" : scrollState === "paused" ? "resumeScroll" : "scrollList";
  const r = await send(cmd);
  if (cmd === "scrollList" && !r.ok) { $("checkOut").hidden = false; $("checkOut").textContent = r.message; }
});
$("scrollStop").addEventListener("click", () => send("stopScroll"));
$("check").addEventListener("click", async () => {
  const out = $("checkOut"); out.hidden = false; out.textContent = "Checking…";
  const r = await send("diagnose");
  if (!r.ok) { out.textContent = r.message; return; }
  const d = r.report, yes = (b) => (b ? "✓ found" : "✗ not found");
  out.textContent = [
    `Chat list:      ${yes(d.chatList)} (${d.rows} chats on screen)`,
    ...d.firstRows.map((x) => `   • ${x.name}  → "Hi ${x.firstName}!"${x.group ? "  (group: skipped)" : ""}${x.lastFromMe ? "" : "  (they wrote last)"}`),
    `Open chat:      ${d.openChat || "none open (click any chat to check the message box)"}${d.openIsGroup ? " (group)" : ""}`,
    `Message box:    ${d.openChat ? yes(d.messageBox) : "-"}`,
    `Send button:    ${d.openChat ? (d.sendButton ? "✓ found" : "shows after typing (Enter is used)") : "-"}`,
    `Attach image:   ${d.openChat ? yes(d.attach) : "-"}`,
    `WhatsApp warning: ${d.warning ? '"' + d.warning + '"' : "none"}`,
    `Window:         ${d.hidden ? "hidden (bring WhatsApp Web to the front)" : "visible"}`,
  ].join("\n");
});
$("testNotify").addEventListener("click", async () => {
  $("notifyOut").textContent = "Sending…";
  const r = await send("testNotify", { settings });
  $("notifyOut").textContent = r.ok ? "Sent ✓" : "Didn't work: " + (r.error || r.message || "");
});
// W3: saving names
$("bkNow").addEventListener("click", async () => {
  $("bkStatus").textContent = "Saving…";
  const r = await send("backupNow");
  $("bkStatus").textContent = r.ok ? `Saved ✓ ${r.path || ""}` : r.message || "Didn't work";
});
$("helperCheck").addEventListener("click", async () => {
  $("bkStatus").textContent = "Checking…";
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "wa-helper" }); } catch (e) { r = { ok: false }; }
  $("bkStatus").textContent = r && r.ok && +r.version >= 1.2 ? "✓ Windows helper installed (shutdown, saving names and the Log)"
    : r && r.ok ? "The Windows helper is old. Double-click windows\\Setup-FollowUp.bat once more."
    : "✗ Windows helper not found. Double-click windows\\Setup-FollowUp.bat once, then reload this extension.";
});
async function showBackupStatus() {
  const { backupStatus: b } = await chrome.storage.local.get("backupStatus");
  if (b) $("bkStatus").textContent = b.ok ? `Last saved ${new Date(b.at).toLocaleString()} · ${b.count} names` : `Not saved (${b.error}). ${WAEngine.HELP.BACKUP_FAILED.fix}`;
}
$("newCampaign").addEventListener("click", async () => {
  if (!confirm("Start a new campaign? FollowUp forgets who already got the message, so everyone can get the next one.")) return;
  await chrome.storage.local.set({ campaign: { id: Date.now(), doneKeys: [] } });
  showCampaign();
});
async function showCampaign() {
  const { campaign } = await chrome.storage.local.get("campaign");
  const n = campaign ? campaign.doneKeys.length : 0;
  $("campaignInfo").textContent = `${n} people already got it in this campaign.`;
  $("sum_campaign").textContent = `${n} people in this campaign`;
}
// W6: keyboard shortcuts, as currently set in Chrome
const KEY_LABELS = { "toggle-run": "Start / Pause / Resume", stop: "Stop", "toggle-scroll": "Scroll chat list: start / pause / resume" };
async function showKeys() {
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch (_) {}
  $("keys").replaceChildren(...cmds.filter((c) => KEY_LABELS[c.name]).map((c) => {
    const li = document.createElement("li"); li.textContent = `${c.shortcut || "(not set)"} · ${KEY_LABELS[c.name]}`; return li;
  }));
}
$("keysEdit").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "wa-status") return;
  if (msg.state) {
    setState(msg.state.state, msg.state.reason, msg.state.current);
    showHidden(msg.state.state === "running" && msg.state.code === "hidden");
  }
  if (msg.stats) showStats(msg.stats);
  if (msg.limit) showToday(msg.limit);
  if (msg.scroll) showScroll(msg.scroll);
  if (msg.entry) {
    if (!$("tab-activity").hidden) $("log").prepend(item(msg.entry));
    if (["FAILED", "REVIEW", "UNKNOWN"].includes(msg.entry.status)) showProblems();
  }
  if (msg.problem) showProblems();
  if (msg.buyers) buyersBusy(msg.buyers.state !== "done", msg.buyers.message);
  if (msg.backup) showBackupStatus();
  if (msg.diary && !$("tab-log").hidden) { clearTimeout(window.__dt); window.__dt = setTimeout(showDiary, 1500); }
  if (msg.finish) {
    const f = msg.finish;
    $("finishBar").hidden = !(f.left != null && !f.done && !f.cancelled);
    if (f.text) $("finishText").textContent = f.text;
    if (f.failed) $("reason").textContent = f.message;
  }
});
async function showHidden(on) {
  if (!on) { $("hiddenBox").hidden = true; return; }
  const r = await hiddenReason();
  $("hiddenWhy").textContent = `⏸ Waiting: ${r ? r.why : "WhatsApp Web is hidden"}. FollowUp continues the moment it's visible.`;
  $("hiddenLaunch").hidden = !(settings.launcherCheck && r && /behind another window/.test(r.why));
  $("hiddenBox").hidden = false;
}
chrome.storage.onChanged.addListener((ch) => {
  if (ch.stats) showStats(ch.stats.newValue);
  if (ch.stats || ch.days || ch.todayOverride) showPlan();
  if (ch.campaign) showCampaign();
  if (ch.contacts && !$("tab-buyers").hidden) showBuyers();
});

let watchTimer = null;
function watch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(async () => {
    if (state !== "offline") { clearInterval(watchTimer); return; }
    const r = await send("ping");
    if (r.ok) { clearInterval(watchTimer); setState(r.state === "idle" ? "idle" : r.state, r.state !== "idle" && r.last ? r.last.reason : "Connected. Write your message, then press Start."); }
  }, 3000);
}

(async () => {
  const d = await chrome.storage.local.get(["settings", "templates", "activeTemplate", "replies", "stats"]);
  settings = Object.assign({}, D, d.settings || {});
  replies = JSON.parse(JSON.stringify(Object.assign({}, WAEngine.DEFAULT_REPLIES, d.replies || {})));
  templates = d.templates && d.templates.length ? d.templates : [{ id: "t1", name: "Message 1", text: D.template, imageDataUrl: "", imageName: "" }];
  active = d.activeTemplate && templates.some((t) => t.id === d.activeTemplate) ? d.activeTemplate : templates[0].id;
  fillForm();
  showTemplates();
  showReplyCards();
  showStats(d.stats);
  showProblems();
  showCampaign();
  showKeys();
  showBackupStatus();
  showBuyers();
  const r = await send("ping");
  if (r.ok) {
    setState(r.state, r.state !== "idle" && r.last ? r.last.reason : "Connected. Write your message, then press Start.");
    if (r.limit) showToday(r.limit);
    if (r.stats) showStats(r.stats);
    if (r.last && r.last.code === "hidden") showHidden(true);
    if (r.scroll && r.scroll !== "idle") showScroll({ state: r.scroll, message: "Scrolling the chat list down…" });
    if (r.buyersBusy) buyersBusy(true, "Working on replies…");
  } else { setState("offline", r.message); watch(); }
})();
