// Side panel: your message, settings, and Start/Pause/Stop for the WhatsApp Web tab.
const $ = (id) => document.getElementById(id);
const D = WAEngine.DEFAULTS;
try { $("ver").textContent = "v" + chrome.runtime.getManifest().version; } catch (_) {}
const today = () => new Date().toLocaleDateString("en-CA");
let settings = {}, templates = [], active = "t1", state = "idle", lastStats = null;

// ---------- settings form ----------
const CHECKS = { sLastMine: "onlyIfLastFromMe", sGroups: "skipGroups", sTilde: "useTildeName", sImgReq: "imageRequired", sFront: "frontOnStart",
  sAwake: "keepAwake", sTest: "testMode", sFinEnd: "finishOnEnd", sFinDaily: "finishOnDaily", sPC: "notifyPC", sPhone: "notifyPhone" };
const NUMS = { sCap: "dailyCap", sGapMin: "gapMinSec", sGapMax: "gapMaxSec", sCountdown: "finishCountdownSec", scCount: "scrollCount", scPatience: "bottomWaitSec" };
const SELECTS = { sOrder: "order", sImgStyle: "imageStyle", sFinish: "whenFinished" };

function fillForm() {
  for (const [id, k] of Object.entries(CHECKS)) $(id).checked = !!settings[k];
  for (const [id, k] of Object.entries(NUMS)) $(id).value = settings[k];
  for (const [id, k] of Object.entries(SELECTS)) $(id).value = settings[k];
  $("sStep").value = (settings.stepDelayMs / 1000).toFixed(1);
  $("scWait").value = settings.scrollWaitSec;
  for (const r of document.querySelectorAll("input[name=scrollHow]")) r.checked = r.value === settings.scrollHow;
  $("sWord").value = settings.unsavedWord;
  $("sTopic").value = settings.ntfyTopic || "";
  settings.ramp.forEach((n, i) => { $("r" + i).value = n; });
  for (const r of document.querySelectorAll("input[name=limitMode]")) r.checked = r.value === settings.limitMode;
  showPlan();
}
function readForm() {
  for (const [id, k] of Object.entries(CHECKS)) settings[k] = $(id).checked;
  for (const [id, k] of Object.entries(NUMS)) settings[k] = Math.max(0, Math.round(+$(id).value || 0));
  for (const [id, k] of Object.entries(SELECTS)) settings[k] = $(id).value;
  settings.dailyCap = Math.max(1, settings.dailyCap);
  settings.finishCountdownSec = Math.max(10, settings.finishCountdownSec || 60);
  if (settings.gapMaxSec < settings.gapMinSec) settings.gapMaxSec = settings.gapMinSec;
  settings.stepDelayMs = Math.round(Math.max(0.3, +$("sStep").value || 1.2) * 1000);
  settings.scrollWaitSec = Math.max(0.3, +$("scWait").value || 1.5);
  settings.scrollCount = Math.max(1, settings.scrollCount || 1);
  const sh = document.querySelector("input[name=scrollHow]:checked");
  settings.scrollHow = sh ? sh.value : "all";
  settings.unsavedWord = $("sWord").value.trim() || D.unsavedWord;
  settings.ntfyTopic = $("sTopic").value.trim();
  settings.ramp = [0, 1, 2, 3, 4].map((i) => Math.max(1, Math.round(+$("r" + i).value || D.ramp[i])));
  const lm = document.querySelector("input[name=limitMode]:checked");
  settings.limitMode = lm ? lm.value : "ramp";
  chrome.storage.local.set({ settings });
  showPreview();
  showPlan();
}
for (const el of document.querySelectorAll("#tab-settings input:not(#sToday), #tab-settings select")) el.addEventListener("change", readForm);
$("sWord").addEventListener("input", () => { $("wordEx").textContent = $("sWord").value.trim() || D.unsavedWord; });
$("sToday").addEventListener("change", async () => {
  const n = Math.round(+$("sToday").value || 0);
  await chrome.storage.local.set({ todayOverride: n > 0 ? { date: today(), n } : null });
  showPlan();
});

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
$("imgFile").addEventListener("change", () => {
  const f = $("imgFile").files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { Object.assign(tpl(), { imageDataUrl: r.result, imageName: f.name }); saveTemplates(); showImage(); showPreview(); };
  r.readAsDataURL(f);
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
function bubble(el, text) {
  const t = tpl();
  el.replaceChildren();
  if (t.imageDataUrl && settings.imageStyle === "one") { const i = document.createElement("img"); i.src = t.imageDataUrl; el.appendChild(i); }
  el.appendChild(document.createTextNode(text));
  if (t.imageDataUrl && settings.imageStyle === "two") el.appendChild(document.createTextNode("\n＋ then the image as a second bubble"));
}
function showPreview() {
  const text = tpl().text || "";
  bubble($("pv1"), WAEngine.tools.render(text, "Joy Santos", settings));
  bubble($("pv2"), WAEngine.tools.render(text, "+63 917 123 4567", settings, "Mark D"));
}

// ---------- tabs ----------
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) x.setAttribute("aria-selected", String(x === b));
    for (const name of ["main", "activity", "problems", "settings"]) $("tab-" + name).hidden = name !== b.dataset.tab;
    if (b.dataset.tab === "activity") showLog();
    if (b.dataset.tab === "problems") showProblems();
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
$("copyClaude").addEventListener("click", async () => {
  const d = await chrome.storage.local.get(["log", "events", "problems"]);
  const lines = [`FollowUp for WhatsApp v${chrome.runtime.getManifest().version} · ${new Date().toLocaleString()}`, "", "Settings: " + JSON.stringify(settings, (k, v) => (k === "warnTexts" || k === "cantTexts" ? undefined : v))];
  const r = await sendToWa("diagnose");
  if (r.ok) lines.push("Check page: " + JSON.stringify(r.report));
  lines.push("", "Events:", ...(d.events || []).slice(-60).map((e) => `${e.t} ${e.k} ${e.m}`));
  lines.push("", "Last chats:", ...(d.log || []).slice(-80).map((e) => `${e.time} ${e.status} ${e.name} · ${e.reason}`));
  lines.push("", "Problems:", ...(d.problems || []).slice(-20).map((e) => `${e.time} ${e.code} ${e.name} · ${e.reason}`));
  try { await navigator.clipboard.writeText(lines.join("\n")); } catch (_) {}
  $("copied").hidden = false; setTimeout(() => { $("copied").hidden = true; }, 4000);
});

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
  $("start").disabled = s === "running" || s === "paused";
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
  const active = scrollState === "running" || scrollState === "paused";
  $("scroll").textContent = scrollState === "running" ? "Pause scrolling" : scrollState === "paused" ? "Resume scrolling" : "Scroll chat list to the bottom";
  $("scroll").classList.toggle("primary", active);
  $("scrollBar").hidden = !active;
  if (p.message) $("scrollMsg").textContent = p.message;
  if (p.state === "done") { $("checkOut").hidden = false; $("checkOut").textContent = p.message; }
  $("start").disabled = active || state === "running" || state === "paused";
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
$("newCampaign").addEventListener("click", async () => {
  if (!confirm("Start a new campaign? FollowUp forgets who already got the message, so everyone can get the next one.")) return;
  await chrome.storage.local.set({ campaign: { id: Date.now(), doneKeys: [] } });
  showCampaign();
});
async function showCampaign() {
  const { campaign } = await chrome.storage.local.get("campaign");
  $("campaignInfo").textContent = `${campaign ? campaign.doneKeys.length : 0} people already got it in this campaign.`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "wa-status") return;
  if (msg.state) {
    setState(msg.state.state, msg.state.reason, msg.state.current);
    showHidden(msg.state.state === "running" && msg.state.code === "hidden");
  }
  if (msg.limit) showToday(msg.limit);
  if (msg.scroll) showScroll(msg.scroll);
  if (msg.entry) {
    if (!$("tab-activity").hidden) $("log").prepend(item(msg.entry));
    if (["FAILED", "REVIEW", "UNKNOWN"].includes(msg.entry.status)) showProblems();
  }
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
  $("hiddenBox").hidden = false;
}
chrome.storage.onChanged.addListener((ch) => {
  if (ch.stats || ch.days || ch.todayOverride) showPlan();
  if (ch.campaign) showCampaign();
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
  const d = await chrome.storage.local.get(["settings", "templates", "activeTemplate"]);
  settings = Object.assign({}, D, d.settings || {});
  templates = d.templates && d.templates.length ? d.templates : [{ id: "t1", name: "Message 1", text: D.template, imageDataUrl: "", imageName: "" }];
  active = d.activeTemplate && templates.some((t) => t.id === d.activeTemplate) ? d.activeTemplate : templates[0].id;
  $("wordEx").textContent = settings.unsavedWord;
  fillForm();
  showTemplates();
  showProblems();
  showCampaign();
  const r = await send("ping");
  if (r.ok) {
    setState(r.state, r.state !== "idle" && r.last ? r.last.reason : "Connected. Write your message, then press Start.");
    if (r.limit) showToday(r.limit);
    if (r.last && r.last.code === "hidden") showHidden(true);
    if (r.scroll && r.scroll !== "idle") showScroll({ state: r.scroll, message: "Scrolling the chat list down…" });
  } else { setState("offline", r.message); watch(); }
})();
