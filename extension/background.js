// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

importScripts("connect.js");

// Keyboard shortcuts (change them at chrome://extensions/shortcuts).
const COMMANDS = { "toggle-run": "toggleRun", stop: "stopAll", "toggle-scroll": "toggleScroll", "scroll-latest": "scrollLatestShortcut" };

async function handleCommand(command) {
  const cmd = COMMANDS[command];
  if (!cmd) return { ok: false, message: "Unknown shortcut" };
  const r = await sendToInbox(cmd);
  delete r.tab;
  return r;
}
self.handleCommand = handleCommand; // used by the automated tests
chrome.commands.onCommand.addListener((command) => { handleCommand(command); });

// "When the run is finished": the content script counts down, then asks for the action here.
const HELPER = "com.rojie.followup_copilot";
async function finishAction(action, tabId) {
  if (action === "closeTab") { await chrome.tabs.remove(tabId); return { ok: true }; }
  if (action === "closeChrome") {
    for (const w of await chrome.windows.getAll()) await chrome.windows.remove(w.id);
    return { ok: true };
  }
  if (action === "shutdown") {
    let r;
    try { r = await chrome.runtime.sendNativeMessage(HELPER, { action: "shutdown", delaySec: 10 }); }
    catch (e) { return { ok: false, code: "SHUTDOWN_HELPER", message: String(e && e.message || e) }; }
    if (!r || !r.ok) return { ok: false, code: "SHUTDOWN_HELPER", message: (r && r.error) || "The helper didn't answer" };
    // Windows shuts down in 10 seconds; close Chrome first so it exits cleanly.
    setTimeout(async () => { for (const w of await chrome.windows.getAll()) chrome.windows.remove(w.id); }, 1500);
    return { ok: true };
  }
  return { ok: false, message: "Unknown action" };
}
self.finishAction = finishAction; // used by the automated tests
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "fu-finish-action") return;
  finishAction(msg.action, sender.tab && sender.tab.id).then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
  return true;
});

// Notifications: a Windows pop-up (with its sound) and/or a phone notification through ntfy.
async function notifyAll({ title, message, pc, phone, topic, server }) {
  const out = { ok: true };
  if (pc) {
    try {
      await chrome.notifications.create("fu-" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png", title, message,
        priority: 2, requireInteraction: true });
      out.pcOk = true;
    } catch (e) { out.pcOk = false; out.error = String(e && e.message || e); }
  }
  if (phone) {
    const t = String(topic || "").trim();
    if (!t) { out.phoneOk = false; out.error = "No ntfy topic set"; }
    else {
      try {
        const r = await fetch(String(server || "https://ntfy.sh").replace(/\/+$/, "") + "/" + encodeURIComponent(t), {
          method: "POST", body: message, headers: { Title: title.replace(/[^\x20-\x7e]/g, ""), Tags: "speech_balloon" } });
        out.phoneOk = r.ok;
        if (!r.ok) out.error = "ntfy answered " + r.status;
      } catch (e) { out.phoneOk = false; out.error = String(e && e.message || e); }
    }
  }
  out.ok = out.pcOk !== false && out.phoneOk !== false;
  return out;
}
self.notifyAll = notifyAll; // used by the automated tests

// Saving names to a folder on your PC goes through the same Windows helper as the shutdown.
async function fileAction(msg) {
  const { type, ...req } = msg;
  try {
    const r = await chrome.runtime.sendNativeMessage(HELPER, req);
    return r || { ok: false, error: "The helper didn't answer" };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || (msg.type !== "fu-notify" && msg.type !== "fu-file")) return;
  (msg.type === "fu-notify" ? notifyAll(msg) : fileAction(msg)).then(reply, (e) => reply({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// F1: keep the PC awake (no sleep, screen on) while a run or a scroll is going.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== "fu-awake") return;
  try { if (msg.on) chrome.power.requestKeepAwake("display"); else chrome.power.releaseKeepAwake(); reply({ ok: true }); }
  catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
});
