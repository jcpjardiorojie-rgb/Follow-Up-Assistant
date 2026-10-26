// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });

// "When the run is finished": the page counts down, then asks for the action here.
// Shutdown uses the same Windows helper as FollowUp Copilot (windows\Setup-FollowUp.bat).
const HELPER = "com.rojie.followup_copilot";
async function finishAction(action, tabId) {
  if (action === "closeTab") { await chrome.tabs.remove(tabId); return { ok: true }; }
  if (action === "closeChrome") { for (const w of await chrome.windows.getAll()) await chrome.windows.remove(w.id); return { ok: true }; }
  if (action === "shutdown") {
    let r;
    try { r = await chrome.runtime.sendNativeMessage(HELPER, { action: "shutdown", delaySec: 10 }); }
    catch (e) { return { ok: false, code: "SHUTDOWN_HELPER", message: String(e && e.message || e) }; }
    if (!r || !r.ok) return { ok: false, code: "SHUTDOWN_HELPER", message: (r && r.error) || "The helper didn't answer" };
    setTimeout(async () => { for (const w of await chrome.windows.getAll()) chrome.windows.remove(w.id); }, 1500);
    return { ok: true };
  }
  return { ok: false, message: "Unknown action" };
}
self.finishAction = finishAction; // used by the automated tests

// Notifications: a Windows pop-up and/or a phone notification through ntfy.
async function notifyAll({ title, message, pc, phone, topic, server }) {
  const out = { ok: true };
  if (pc) {
    try {
      await chrome.notifications.create("wa-" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2, requireInteraction: true });
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === "wa-finish-action") {
    finishAction(msg.action, sender.tab && sender.tab.id).then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "wa-notify") {
    notifyAll(msg).then(reply, (e) => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "wa-awake") {
    try { if (msg.on) chrome.power.requestKeepAwake("display"); else chrome.power.releaseKeepAwake(); reply({ ok: true }); }
    catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
  }
});
