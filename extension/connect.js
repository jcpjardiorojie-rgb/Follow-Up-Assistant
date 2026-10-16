// Finds the Business Suite inbox tab and talks to it. Shared by the side panel and the shortcuts.
// If the tab was open before the extension was installed (or updated), Chrome never loaded the
// extension into it, so this loads it on the spot instead of asking for a page reload.
const INBOX_URLS = ["https://business.facebook.com/*", "https://www.facebook.com/latest/*"];

async function findInboxTab() {
  const tabs = await chrome.tabs.query({ url: INBOX_URLS });
  if (!tabs.length) return null;
  const inbox = (t) => /\/inbox/.test(t.url || "");
  return tabs.find((t) => t.active && inbox(t)) || tabs.find(inbox) || tabs.find((t) => t.active) || tabs[0];
}

async function sendToInbox(cmd) {
  const tab = await findInboxTab();
  if (!tab) return { ok: false, noTab: true, message: "Open Business Suite → Inbox in Chrome. The panel connects by itself." };
  const msg = { to: "content", cmd };
  try {
    return Object.assign({ tab }, await chrome.tabs.sendMessage(tab.id, msg));
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["engine.js", "content.js"] });
      return Object.assign({ tab }, await chrome.tabs.sendMessage(tab.id, msg));
    } catch (e) {
      return { ok: false, tab, message: "Couldn't connect to the Business Suite tab. Press F5 on that tab, then try again. (" + (e && e.message ? e.message : e) + ")" };
    }
  }
}
