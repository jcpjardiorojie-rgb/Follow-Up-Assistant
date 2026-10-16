// Finds the Business Suite inbox tab and talks to it. Shared by the side panel and the shortcuts.
// If the tab was open before the extension was installed (or updated), Chrome never loaded the
// extension into it, so this loads it on the spot instead of asking for a page reload.
const INBOX_URLS = ["https://business.facebook.com/*", "https://www.facebook.com/latest/*"];

const DEFAULT_INBOX = "https://business.facebook.com/latest/inbox/all/";
const START_CMDS = ["start", "toggleRun"];

// The Page id in a Business Suite link (asset_id=…), or null.
function assetIdOf(url) {
  try { return new URL(url).searchParams.get("asset_id"); } catch (_) { return null; }
}
// Checks a pasted inbox link. Returns { ok, url, assetId, message }.
function checkInboxUrl(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: true, url: "", assetId: null, message: "" };
  let u;
  try { u = new URL(t); } catch (_) { return { ok: false, message: "That isn't a web link. Copy it from Chrome's address bar while your inbox is open." }; }
  const host = u.hostname.toLowerCase();
  if (!(host === "business.facebook.com" || (host === "www.facebook.com" && u.pathname.startsWith("/latest")))) {
    return { ok: false, message: "That link isn't Business Suite. It should start with https://business.facebook.com/latest/inbox" };
  }
  return { ok: true, url: u.href, assetId: u.searchParams.get("asset_id"), message: "" };
}
async function savedAssetId() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings && settings.inboxUrl ? assetIdOf(settings.inboxUrl) : null;
}

async function findInboxTab(assetId) {
  const tabs = await chrome.tabs.query({ url: INBOX_URLS });
  if (!tabs.length) return null;
  const inbox = (t) => /\/inbox/.test(t.url || "");
  const mine = (t) => assetId && assetIdOf(t.url) === assetId;
  return tabs.find((t) => t.active && inbox(t) && mine(t)) || tabs.find((t) => inbox(t) && mine(t)) ||
    tabs.find((t) => t.active && inbox(t)) || tabs.find(inbox) || tabs.find((t) => t.active) || tabs[0];
}

// Brings the saved inbox (or any open inbox) to the front, opening it if needed.
async function openInbox(url) {
  const assetId = url ? assetIdOf(url) : null;
  const tab = await findInboxTab(assetId);
  if (tab && /\/inbox/.test(tab.url || "") && (!assetId || assetIdOf(tab.url) === assetId)) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  return chrome.tabs.create({ url: url || DEFAULT_INBOX, active: true });
}

async function sendToInbox(cmd) {
  const assetId = await savedAssetId();
  const tab = await findInboxTab(assetId);
  if (!tab) return { ok: false, noTab: true, message: "Open Business Suite → Inbox in Chrome (or press “Open my inbox”). The panel connects by itself." };
  const tabAsset = assetIdOf(tab.url);
  if (START_CMDS.includes(cmd) && assetId && tabAsset && tabAsset !== assetId) {
    return { ok: false, tab, wrongPage: true, message: `The open inbox is a different Facebook Page (id ${tabAsset}) than your saved link (id ${assetId}). Press “Open my inbox” first.` };
  }
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
