// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Keyboard shortcuts (change them at chrome://extensions/shortcuts).
const COMMANDS = { "toggle-run": "toggleRun", stop: "stopAll", "toggle-scroll": "toggleScroll", "scroll-latest": "scrollLatestShortcut" };

async function handleCommand(command) {
  const cmd = COMMANDS[command];
  if (!cmd) return { ok: false, message: "Unknown shortcut" };
  const tabs = await chrome.tabs.query({ url: "https://business.facebook.com/*" });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) return { ok: false, message: "No Business Suite tab is open" };
  try {
    return await chrome.tabs.sendMessage(tab.id, { to: "content", cmd });
  } catch (_) {
    return { ok: false, message: "Reload the Business Suite tab once" };
  }
}
self.handleCommand = handleCommand; // used by the automated tests
chrome.commands.onCommand.addListener((command) => { handleCommand(command); });
