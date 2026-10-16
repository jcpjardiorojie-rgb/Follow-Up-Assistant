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
