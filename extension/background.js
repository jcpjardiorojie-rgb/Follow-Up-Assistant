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
