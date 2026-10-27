// Finds the WhatsApp Web tab and talks to it. Used by the side panel and the background worker.
const WA_URLS = ["https://web.whatsapp.com/*"];
const WA_HOME = "https://web.whatsapp.com/";

async function findWaTab() {
  const tabs = await chrome.tabs.query({ url: WA_URLS });
  return tabs.find((t) => t.active) || tabs[0] || null;
}
async function showWaTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}
async function openWhatsApp() {
  const tab = await findWaTab();
  if (tab) { await showWaTab(tab); return tab; }
  return chrome.tabs.create({ url: WA_HOME, active: true });
}
// If WhatsApp Web isn't showing (another tab on top, minimized, or its window is behind), bring it forward.
async function frontIfHidden(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (tab.active && win.state !== "minimized" && win.focused) return false;
    await showWaTab(tab);
    await new Promise((r) => setTimeout(r, 700));
    return true;
  } catch (_) { return false; }
}
async function hiddenReason() {
  const tab = await findWaTab();
  if (!tab) return null;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") return { tab, why: "the WhatsApp Web window is minimized" };
    if (!tab.active) return { tab, why: "WhatsApp Web isn't the tab showing in its window" };
    return { tab, why: "the WhatsApp Web window is behind another window (or the screen is locked)" };
  } catch (_) { return null; }
}
async function sendToWa(cmd, extra) {
  const tab = await findWaTab();
  if (!tab) return { ok: false, noTab: true, message: "Open WhatsApp Web (press “Open WhatsApp Web”). The panel connects by itself." };
  if (cmd === "start" || cmd === "resume" || cmd === "toggleRun") {
    const { settings } = await chrome.storage.local.get("settings");
    if (!settings || settings.frontOnStart !== false) await frontIfHidden(tab);
  }
  const msg = Object.assign({ to: "wa-content", cmd }, extra || {});
  try {
    return Object.assign({ tab }, await chrome.tabs.sendMessage(tab.id, msg));
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["wa-engine.js", "content.js"] });
      return Object.assign({ tab }, await chrome.tabs.sendMessage(tab.id, msg));
    } catch (e) {
      return { ok: false, tab, message: "Couldn't connect to WhatsApp Web. Press F5 on that tab, then try again. (" + (e && e.message ? e.message : e) + ")" };
    }
  }
}
