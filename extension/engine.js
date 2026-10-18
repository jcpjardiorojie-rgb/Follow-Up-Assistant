/*
 * FollowUp engine — the shared "brain" used by both versions.
 *
 *   Option A (Chrome extension) runs it with in-page events.
 *   Option B (desktop app) runs the same file, but clicks, typing and file
 *   uploads come from real browser input through Playwright ("native" hooks).
 *
 * It reads the Business Suite page by its visible text and layout, so it does
 * not depend on Meta's internal class names. Every selector-like assumption
 * lives in DEFAULTS so it can be changed from Settings without code changes.
 */
(function (root) {
  "use strict";
  if (root.FollowUpEngine) return;

  const VERSION = "1.0.0";

  const DEFAULTS = {
    // Message
    template: "Hi {first_name}! Just following up po 😊",
    image: null, // { dataUrl, name } (A) — B attaches the file natively
    fallbackName: "there",

    // What to look for on the page
    blockedTexts: ["You are no longer able to send messages to this person"],
    excludeNames: ["Facebook user"],
    stopTexts: [
      "temporarily blocked",
      "temporarily restricted",
      "You can't use this feature right now",
      "We limit how often",
      "Your account has been restricted",
      "account is restricted",
      "Confirm your identity",
      "Security check",
      "Action blocked",
    ],
    sendFailTexts: ["couldn't send", "could not send", "failed to send", "message wasn't sent", "not delivered"],
    doneLabels: ["move to done", "mark as done", "done"],
    sendLabels: ["send", "press enter to send", "send message"],
    attachLabels: ["attach a file", "attach file", "attach", "add photo", "add photos", "photo/video", "attach media", "add file"],
    removeLabels: ["remove", "remove attachment", "remove file", "delete attachment"],
    ignoreRowTexts: ["Connect to Instagram"],
    listSelector: "", // optional CSS override for the inbox list
    youPrefixes: ["You:", "You sent", "You replied", "You unsent"],

    // Behaviour
    // "top": newest first. "bottom": scroll to the very bottom first, then work upward.
    // "screen": start at the lowest chat visible right now (no scrolling down), then work upward.
    order: "top",
    loadAllMaxMinutes: 30, // S4: longest time spent scrolling before giving up
    // Scrolling settings (Settings → Scrolling)
    scrollHow: "count", // S1: "all" (to the bottom), "count" (a number of scrolls), "chats" (about a number of chats)
    scrollCount: 25,
    scrollChats: 500,
    scrollWaitSec: 1.5, // S2: pause after each scroll
    unstickRetries: 2, // S3: "scroll up a little and back down" tries before deciding it's the bottom
    buttonUsesScrollSettings: true, // S5: the "Scroll inbox to the bottom" button follows S1 too
    // When the run finishes normally (not after Stop or a problem pause)
    whenFinished: "nothing", // "nothing", "closeTab", "closeChrome" or "shutdown"
    finishCountdownSec: 60,
    // "Already messaged" (Settings): never send the same message twice, and stop when the run reaches
    // people who already got it (chats you message jump to the top, so that's where the last run started).
    dupCheck: true, // don't send if this message is already in the open chat
    stopBy: "both", // "name", "message", "both" (name and message), or "off" (only skip, never stop)
    stopAfter: 3, // stop after this many already-messaged chats in a row
    onlyIfLastFromMe: true, // skip chats where the customer wrote last
    moveSentToDone: false,
    testMode: false, // prepare everything but never press Send / Done
    stepDelayMs: 1200,
    betweenChatsSec: 8,
    dailyCap: 300,
    pageTimeoutMs: 15000,
    maxConsecutiveFailures: 3,
    imageRequired: true,

    // Reading replies (Buyers tab). Words are matched as whole words, any language.
    hotWords: ["how much", "hm", "magkano", "mag kano", "price", "presyo", "pricelist", "order", "pa order", "mag order",
      "paorder", "cod", "available", "avail", "meron pa", "may stock", "stock", "saan", "location", "loc", "address",
      "reserve", "pa reserve", "bibili", "bili", "kukuha", "kuha", "buy", "payment", "gcash", "how to order", "paano",
      "pano", "delivery", "shipping", "sf", "rate"],
    warmWords: ["interested", "interesado", "details", "detail", "info", "more info", "pa send", "pasend", "send", "pm",
      "sige", "ok", "okay", "oo", "yes", "yup", "ge", "pwede", "pede", "ano po", "ano yan", "tell me more", "pakita",
      "picture", "pic", "pics"],
    coldWords: ["not interested", "no thanks", "no thank you", "hindi na", "di na", "wag na", "huwag na", "ayaw ko",
      "ayoko", "stop", "unsubscribe", "busy", "no", "ayaw", "hindi"],
    // Auto-replies to people who answered the follow-up (Buyers tab)
    replyMode: "ask", // "ask" (show them first, you press Send) or "auto" (send right away)
    autoCheckReplies: false, // also check for replies every few minutes while the inbox tab is open
    autoCheckMinutes: 10,
    autoCheckRows: 150, // how many chats from the top to read on an automatic check (replies jump to the top)
    // Tell me when it's done (Settings → When the run is finished)
    notifyPC: true, // Windows pop-up with its sound
    notifyOnPause: true, // also when a run pauses because of problems or a Meta warning
    notifyPhone: false, // phone notification through the free ntfy app
    ntfyTopic: "",
    ntfyServer: "https://ntfy.sh",
    // Names that got each saved message: a backup copy in a folder on your PC (needs the Windows helper)
    backupOn: true,
    backupFolder: "D:\\FollowUp-History",
    backupEvery: 25,
    labelName: "Hot lead",
    autoLabel: true, // add the label in Business Suite right after "Check replies"
  };

  // Example auto-replies (Buyers tab). Each can be turned on or off and have its own image.
  const DEFAULT_REPLIES = {
    hot: { on: true, text: "Hi {first_name}! 😊 Thank you for your message po! Here's our price list. Which one would you like po? Just reply with the item and we'll reserve it for you.", imageDataUrl: "", imageName: "" },
    warm: { on: true, text: "Hi {first_name}! Sure po 😊 Here are the details. If you have any questions, just message us anytime, happy to help!", imageDataUrl: "", imageName: "" },
    cold: { on: false, text: "Noted po, thank you {first_name}! 🙏 Just message us anytime if you change your mind.", imageDataUrl: "", imageName: "" },
    replied: { on: false, text: "Thank you for your message po, {first_name}! We'll get back to you shortly 😊", imageDataUrl: "", imageName: "" },
  };

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();
  // Letters and digits only: ignores emoji (often rendered as images), spacing and punctuation.
  const sig = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const countOf = (hay, needle) => {
    if (!needle) return 0;
    let n = 0, i = hay.indexOf(needle);
    while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
  };
  const TIME_RE = /^(\d{1,2}:\d{2}\s?(am|pm)?|mon|tue|wed|thu|fri|sat|sun|yesterday|now|just now|\d+\s?(s|m|h|d|w|y|min|mins|hr|hrs)|[a-z]{3,9}\.? \d{1,2}(, \d{4})?|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;

  function rect(el) { return el.getBoundingClientRect(); }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = rect(el);
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  async function waitFor(fn, timeoutMs, everyMs = 200) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v = false;
      try { v = fn(); } catch (_) { v = false; }
      if (v) return v;
      if (Date.now() > end) return false;
      await sleep(everyMs);
    }
  }

  // ---------- names & template ----------
  function firstName(name, cfg) {
    cfg = cfg || DEFAULTS;
    const n = norm(name);
    if (!n || (cfg.excludeNames || []).some((x) => low(x) === low(n))) return cfg.fallbackName;
    for (const tok of n.split(" ")) {
      let w = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (w.length < 2) continue;
      if (w === w.toUpperCase() || w === w.toLowerCase()) w = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return w;
    }
    return cfg.fallbackName;
  }
  function render(template, name, cfg) {
    return String(template || "")
      .replace(/\{\s*first[_ ]?name\s*\}/gi, firstName(name, cfg))
      .replace(/\{\s*(full[_ ]?)?name\s*\}/gi, norm(name));
  }

  // ---------- reading the page ----------
  function labelOf(el) {
    return low(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-tooltip-content") || "");
  }
  function labelMatches(label, wanted) {
    return wanted.some((w) => { w = low(w); return label === w || (w.length > 4 && label.startsWith(w)); });
  }
  function findLabeled(wanted, filter) {
    const out = [];
    for (const el of document.querySelectorAll("[aria-label],[title],[data-tooltip-content]")) {
      if (!labelMatches(labelOf(el), wanted)) continue;
      const target = el.closest("button,[role=button],a") || el;
      if (!isVisible(target)) continue;
      if (filter && !filter(target)) continue;
      out.push(target);
    }
    return out;
  }

  function isScrollable(el) {
    if (el.scrollHeight <= el.clientHeight + 10) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }

  // The group of siblings that repeat like inbox rows (same width, row-like height).
  function rowGroup(container) {
    const cw = rect(container).width;
    let best = null, bestRows = [];
    const queue = [[container, 0]];
    while (queue.length) {
      const [el, depth] = queue.shift();
      const rows = [];
      for (const ch of el.children) {
        const r = rect(ch);
        if (r.height >= 36 && r.height <= 140 && r.width >= cw * 0.6) rows.push(ch);
      }
      if (rows.length > bestRows.length) { best = el; bestRows = rows; }
      if (depth < 10) for (const ch of el.children) queue.push([ch, depth + 1]);
    }
    return bestRows.length >= 2 ? bestRows : [];
  }

  function findList(cfg) {
    if (cfg.listSelector) {
      const el = document.querySelector(cfg.listSelector);
      if (el) return el;
    }
    const W = window.innerWidth;
    let best = null, bestCount = 0;
    for (const el of document.querySelectorAll("div,ul,ol,section")) {
      if (!isScrollable(el)) continue;
      const r = rect(el);
      if (r.height < 200 || r.width < 150 || r.left > W * 0.45 || r.width > W * 0.55) continue;
      const n = rowGroup(el).length;
      if (n > bestCount) { best = el; bestCount = n; }
    }
    return best;
  }

  function textLines(el) {
    return String(el.innerText || "").split("\n").map(norm).filter(Boolean);
  }
  function rowInfo(el, cfg) {
    const lines = textLines(el);
    const nameLine = lines.find((l) => !TIME_RE.test(l)) || "";
    const fromMe = lines.some((l) => cfg.youPrefixes.some((p) => l.startsWith(p)));
    const img = el.querySelector("img,image");
    const src = img ? (img.getAttribute("src") || img.getAttribute("xlink:href") || img.getAttribute("href") || "").split("?")[0] : "";
    return { el, name: nameLine, fromMe, lines, key: nameLine + "|" + src.slice(-48) };
  }
  function getRows(list, cfg) {
    return rowGroup(list)
      .map((el) => rowInfo(el, cfg))
      .filter((r) => r.name && r.lines.length >= 1 && !cfg.ignoreRowTexts.some((t) => r.lines.join(" ").includes(t)));
  }
  function nameElementIn(row) {
    const walker = document.createTreeWalker(row.el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (norm(n.nodeValue) === row.name && n.parentElement && isVisible(n.parentElement)) return n.parentElement;
    }
    return row.el;
  }

  function threadId() {
    try { return new URL(location.href).searchParams.get("selected_item_id"); } catch (_) { return null; }
  }

  // Is this exact name shown in the open conversation (header area, right of the list)?
  function headerHasName(name, list) {
    const lr = rect(list);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (norm(n.nodeValue) !== name) continue;
      const p = n.parentElement;
      if (!p || list.contains(p) || !isVisible(p)) continue;
      const r = rect(p);
      if (r.left >= lr.right - 5 && r.top < window.innerHeight * 0.4) return true;
    }
    return false;
  }

  function findComposer(list) {
    const lr = rect(list);
    const W = window.innerWidth;
    let best = null;
    for (const el of document.querySelectorAll("[contenteditable=true],[contenteditable=''],textarea")) {
      if (!isVisible(el) || list.contains(el)) continue;
      const r = rect(el);
      if (r.left < lr.right - 5 || r.left > W * 0.85) continue;
      if (!best || r.bottom > rect(best).bottom) best = el;
    }
    return best;
  }
  function composerText(c) { return c ? (c.value !== undefined && c.tagName === "TEXTAREA" ? c.value : c.innerText) : ""; }

  function findMessageList(list, composer) {
    const lr = rect(list);
    const cr = composer ? rect(composer) : null;
    let best = null, bestH = 0;
    for (const el of document.querySelectorAll("div,section,main")) {
      if (!isScrollable(el) || list.contains(el) || el.contains(list)) continue;
      const r = rect(el);
      if (r.left < lr.right - 5 || r.height < 120) continue;
      if (cr && (r.right < cr.left || r.left > cr.right || r.top > cr.top)) continue;
      if (r.height > bestH) { best = el; bestH = r.height; }
    }
    if (best || !composer) return best;
    // Short chats have no scrollbar: use the chat column that holds the message box.
    for (let el = composer.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.contains(list)) break;
      if (rect(el).height >= 300) return el;
    }
    return null;
  }
  // Signatures of a message that survive a different first name, emoji and spacing (3A: "same beginning").
  function messageSigs(template, name, cfg) {
    const full = sig(render(template, name, cfg)).slice(0, 40);
    const parts = String(template || "").split(/\{\s*(?:first[_ ]?name|(?:full[_ ]?)?name)\s*\}/i).map(sig);
    const longest = parts.sort((a, b) => b.length - a.length)[0] || "";
    // The whole message as this person would get it, and (for longer messages) its longest part without the name.
    return [full.length >= 3 ? full : "", longest.length >= 12 ? longest.slice(0, 40) : ""].filter(Boolean);
  }
  async function chatHasMessage(list, composer, template, name, cfg) {
    const read = () => messagesSig(findMessageList(list, composer), composer);
    // Slow internet: the messages may still be loading, so wait (up to 2 s) until something shows.
    const text = read() || (await waitFor(read, 2000, 200)) || "";
    return !!text && messageSigs(template, name, cfg).some((x) => text.includes(x));
  }
  function messagesSig(msgList, composer) {
    if (!msgList) return "";
    let s = sig(msgList.innerText);
    if (composer && msgList.contains(composer)) s = s.replace(sig(composerText(composer)), "");
    return s;
  }

  function bodyHas(texts) {
    const t = low(document.body.innerText);
    return texts.find((x) => t.includes(low(x))) || null;
  }
  // Warnings from Meta. Text inside the open chat history is ignored, so a customer
  // writing "security check" does not pause the run.
  function stopReason(cfg, list) {
    const body = low(document.body.innerText);
    const composer = list ? findComposer(list) : null;
    const msgs = list ? findMessageList(list, composer) : null;
    const inChat = msgs ? low(msgs.innerText) : "";
    for (const s of cfg.stopTexts) {
      const k = low(s);
      if (countOf(body, k) > countOf(inChat, k)) return s;
    }
    return null;
  }

  // Images that look like attachment previews near the message box.
  function previewSet(composer) {
    const cr = rect(composer);
    const out = new Set();
    for (const el of document.querySelectorAll("img,video,canvas,[style*='background-image']")) {
      if (!isVisible(el)) continue;
      const r = rect(el);
      if (r.width < 24 || r.height < 24) continue;
      if (r.bottom < cr.top - 240 || r.top > cr.bottom + 60 || r.right < cr.left - 60 || r.left > cr.right + 60) continue;
      out.add(el);
    }
    return out;
  }
  function hasNewPreview(composer, before) {
    for (const el of previewSet(composer)) if (!before.has(el)) return true;
    return false;
  }

  function findFileInput(composer) {
    let el = composer;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      const inp = el.querySelector("input[type=file]");
      if (inp) return inp;
    }
    return document.querySelector("input[type=file][accept*=image]") || document.querySelector("input[type=file]");
  }
  function nearComposer(composer, maxDy) {
    const cr = rect(composer);
    return (el) => {
      const r = rect(el);
      return Math.abs((r.top + r.bottom) / 2 - (cr.top + cr.bottom) / 2) < maxDy && r.left > cr.left - 200;
    };
  }

  // ---------- acting on the page ----------
  function center(el) {
    const r = rect(el);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  function fireMouse(target, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const P = window.PointerEvent || MouseEvent;
    target.dispatchEvent(new P("pointerover", { ...o, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseover", o));
    target.dispatchEvent(new P("pointerdown", { ...o, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", o));
    if (target.focus) try { target.focus({ preventScroll: true }); } catch (_) {}
    target.dispatchEvent(new P("pointerup", { ...o, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", o));
    target.dispatchEvent(new MouseEvent("click", o));
  }
  function onScreen(el) {
    const r = rect(el);
    return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  }
  // Brings an element fully into view inside its scrolling list with a small, smooth move
  // (just far enough to show it, not jumping it to the middle). Returns true if it scrolled.
  async function bringIntoView(el, container) {
    const box = container ? rect(container) : { top: 0, bottom: window.innerHeight };
    const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, window.innerHeight);
    const r = rect(el), margin = 12;
    let delta = 0;
    if (r.top < top + margin) delta = r.top - top - margin;
    else if (r.bottom > bottom - margin) delta = r.bottom - bottom + margin;
    if (!delta) return false;
    const pos = () => (container ? container.scrollTop : window.scrollY);
    if (container) container.scrollBy({ top: delta, behavior: "smooth" });
    else el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    // wait until the glide has finished
    let last = null;
    for (let i = 0; i < 25; i++) {
      await sleep(60);
      const now = pos();
      if (now === last) break;
      last = now;
    }
    return true;
  }

  async function click(el, hooks) {
    if (!onScreen(el)) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(120);
    }
    if (!el.isConnected) throw new Error("STALE"); // the list redrew while scrolling
    const { x, y } = center(el);
    if (hooks.native && hooks.native.click) return hooks.native.click(x, y);
    const target = document.elementFromPoint(x, y);
    fireMouse(target && el.contains(target) ? target : el, x, y);
  }
  async function hover(el, hooks) {
    const { x, y } = center(el);
    if (hooks.native && hooks.native.hover) return hooks.native.hover(x, y);
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      const C = t.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new C(t, { ...o, bubbles: !t.endsWith("enter") }));
    }
  }
  function selectAllIn(el) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  async function clearComposer(composer, hooks) {
    if (!composer || !composer.isConnected) return;
    if (!sig(composerText(composer))) return;
    if (composer.tagName === "TEXTAREA") { setNativeValue(composer, ""); return; }
    if (hooks.native && hooks.native.key) {
      await click(composer, hooks);
      await hooks.native.key("Control+A");
      await hooks.native.key("Backspace");
    } else {
      selectAllIn(composer);
      document.execCommand("delete");
    }
    await sleep(150);
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function composerHasExactlyOnce(composer, text) {
    const snip = sig(text).slice(0, 40);
    return countOf(sig(composerText(composer)), snip) === 1;
  }

  async function putText(composer, text, hooks) {
    await clearComposer(composer, hooks);
    if (composer.tagName === "TEXTAREA") {
      setNativeValue(composer, text);
    } else if (hooks.native && hooks.native.typeText) {
      await click(composer, hooks);
      await hooks.native.typeText(text);
    } else {
      // 1) paste, which Meta's editor handles itself; 2) typing commands as a fallback
      composer.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(300);
      if (!composerHasExactlyOnce(composer, text)) {
        await clearComposer(composer, hooks);
        selectAllIn(composer);
        text.split("\n").forEach((line, i) => {
          if (i) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
      }
    }
    return waitFor(() => composerHasExactlyOnce(composer, text), 3000);
  }

  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || "image.jpg", { type: mime });
  }

  async function attachImage(composer, cfg, hooks, log) {
    const before = previewSet(composer);
    const seen = () => hasNewPreview(composer, before);
    if (hooks.native && hooks.native.attach) {
      document.querySelectorAll("[data-fu-file],[data-fu-attach]").forEach((e) => { e.removeAttribute("data-fu-file"); e.removeAttribute("data-fu-attach"); });
      const input = findFileInput(composer);
      if (input) input.setAttribute("data-fu-file", "1");
      const btn = findLabeled(cfg.attachLabels, nearComposer(composer, 160))[0];
      if (btn) btn.setAttribute("data-fu-attach", "1");
      if ((await hooks.native.attach()) && (await waitFor(seen, 6000))) return "file upload";
    }
    if (cfg.image && cfg.image.dataUrl) {
      const file = dataUrlToFile(cfg.image.dataUrl, cfg.image.name);
      composer.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      if (await waitFor(seen, 4000)) return "paste";
      const input = findFileInput(composer);
      if (input) {
        const dt2 = new DataTransfer();
        dt2.items.add(file);
        input.files = dt2.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        if (await waitFor(seen, 6000)) return "file input";
      }
    }
    if (log) log("Image could not be attached");
    return null;
  }

  async function removePreviews(composer, cfg, hooks) {
    for (let i = 0; i < 5; i++) {
      const btn = findLabeled(cfg.removeLabels, nearComposer(composer, 260))[0];
      if (!btn) return;
      await click(btn, hooks);
      await sleep(300);
    }
  }

  async function pressEnter(composer, hooks) {
    if (hooks.native && hooks.native.key) {
      await click(composer, hooks);
      return hooks.native.key("Enter");
    }
    composer.focus();
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", o));
    composer.dispatchEvent(new KeyboardEvent("keypress", o));
    composer.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  // ---------- one conversation ----------
  async function moveToDone(ctx, row) {
    const { cfg, hooks, list } = ctx;
    const lr = rect(list);
    // The list may redraw at any time, so always look rows up fresh by name + photo.
    const sameKey = () => getRows(list, cfg).filter((r) => r.key === row.key);
    const before = sameKey().length;
    let btn = findLabeled(cfg.doneLabels, (el) => { const r = rect(el); return !list.contains(el) && r.left >= lr.right - 5 && r.top < window.innerHeight * 0.35; })[0];
    const live = sameKey()[0];
    if (!btn && live) {
      await hover(live.el, hooks);
      await sleep(400);
      btn = findLabeled(cfg.doneLabels, (el) => live.el.contains(el))[0];
    }
    if (!btn) return { ok: false, why: "Couldn't find the Done (✔) button" };
    await click(btn, hooks);
    const ok = await waitFor(() => sameKey().length < before, 6000);
    return ok ? { ok: true } : { ok: false, why: "Clicked Done but the chat stayed in the list" };
  }

  // Plain-language explanation for every kind of problem: what happened, why, and how to fix it.
  const HELP = {
    CLICK_FAILED: {
      what: "The app couldn't click this chat in the list, so nothing was sent to this person.",
      why: "The inbox list was redrawing (loading or scrolling) at that moment.",
      fix: "Usually fixes itself on the next chat. If it repeats, press F5 on the Business Suite tab, then Resume.",
    },
    OPEN_TIMEOUT: {
      what: "The chat didn't open in time (tried twice), so nothing was sent to this person.",
      why: "Business Suite was slow to load the chat, or it shows this person's name differently in the chat than in the list.",
      fix: "Settings → raise “Wait after opening a chat” to 2–3 seconds. If it's always the same person, message them yourself.",
    },
    CHAT_CHANGED: {
      what: "Another chat opened while this one was loading, so nothing was sent.",
      why: "A new message arrived or something was clicked in the inbox during loading.",
      fix: "Nothing needed if it happens once. Avoid clicking in the Business Suite tab while it runs.",
    },
    NO_MESSAGE_BOX: {
      what: "This chat had no message box, so nothing was sent.",
      why: "The chat probably can't be messaged, but Meta showed a different warning than the one the app looks for (for example in another language).",
      fix: "Open this chat and read the text where the message box should be. Add that sentence under Settings → Advanced → “Can't message” banner text, so these chats go to Done.",
    },
    TEXT_FAILED: {
      what: "The message couldn't be typed into the box, so nothing was sent.",
      why: "The message box wasn't ready yet, or Meta changed how it works.",
      fix: "Press F5 on the Business Suite tab, then Resume. If it keeps happening, send Claude a screenshot of the chat.",
    },
    IMAGE_FAILED: {
      what: "The image didn't attach, so nothing was sent (the text was removed from the box).",
      why: "The image is too large or a format Messenger doesn't accept, or the upload was slow.",
      fix: "Choose a JPG or PNG under 5 MB. Or untick “Don't send if the image fails to attach” to send text only when this happens.",
    },
    SEND_STUCK: {
      what: "The message stayed in the box after pressing Send, so it was not sent. The box was cleared.",
      why: "The Send button didn't respond, usually because of a slow connection.",
      fix: "Check your internet, raise “Wait after opening a chat”, then Resume. This person will be tried again next run.",
    },
    META_NOT_SENT: {
      what: "Meta showed “couldn't send” for this message.",
      why: "Meta refused the message. This often means messages are going out too fast, or this person can't receive messages.",
      fix: "Raise “Seconds between chats”. The app won't retry this person, so message them yourself later if you want.",
    },
    DONE_FAILED: {
      what: "This chat should go to Done, but the ✔ (Move to done) button couldn't be clicked.",
      why: "The button wasn't found, or the chat stayed in the list after clicking.",
      fix: "Move this chat to Done yourself. If it happens on every chat, press Check page and look at the “Done (✔) button” line, then send Claude a screenshot.",
    },
    META_WARNING: {
      what: "Meta showed a warning on the page, so the app paused.",
      why: "Meta may be limiting or checking your account.",
      fix: "Read the warning in the Business Suite tab. If it's about limits or blocking, stop for today and lower the Daily limit.",
    },
    CHAT_NOT_FOUND: {
      what: "This person's chat couldn't be found in the inbox list.",
      why: "The chat is far down the list, was moved to Done, or the person changed their name.",
      fix: "Search for the name in Business Suite's inbox search box and open it yourself.",
    },
    LABEL_FAILED: {
      what: "The “Hot lead” label couldn't be added to this chat in Business Suite.",
      why: "The “Add label” box wasn't found on the right side of the chat, or the label didn't show after adding it.",
      fix: "Add the label yourself in the chat's right panel (Labels → Add label). If it fails for every chat, send Claude a screenshot of the right panel.",
    },
    SHUTDOWN_HELPER: {
      what: "The run finished, but the computer couldn't be shut down.",
      why: "Turning off the PC needs the small Windows helper, and it isn't installed (or Chrome can't reach it).",
      fix: "Double-click windows\\Setup-FollowUp.bat once, then click ↻ on the extension at chrome://extensions. Settings → When finished → “Check shutdown helper” should then show ✓.",
    },
    BACKUP_FAILED: {
      what: "The names couldn't be saved to the folder on your PC. Sending is not affected; Chrome still has them.",
      why: "The Windows helper is missing or is the older version (from before auto-save), or the folder can't be created (for example, there's no D drive).",
      fix: "Double-click windows\\Setup-FollowUp.bat once more, then click ↻ on the extension. Check the folder under Settings → Already messaged, then press “Save now”.",
    },
    NOTIFY_FAILED: {
      what: "The phone notification couldn't be sent.",
      why: "The ntfy topic name is empty, or the internet connection dropped.",
      fix: "Settings → When the run is finished: type your ntfy topic (the same name as in the ntfy app on your phone), then press “Send test notification”.",
    },
    ERROR: {
      what: "Something unexpected went wrong on this chat, so nothing was sent.",
      why: "The page changed in a way the app didn't expect.",
      fix: "Press F5 on the Business Suite tab, then Resume. If it repeats, send Claude a screenshot and the details below.",
    },
  };

  async function processRow(ctx, row) {
    const { cfg, hooks, list } = ctx;
    const out = (status, reason, extra) => Object.assign({ time: new Date().toISOString(), name: row.name, key: row.key, id: null, status, reason: reason || "" }, extra || {});
    // A problem entry: status (FAILED unless given), plus the code and its plain-language help.
    const problem = (code, reason, extra) => {
      const e = Object.assign({}, extra);
      const status = e.status || "FAILED";
      delete e.status;
      return out(status, reason, Object.assign({ code, help: HELP[code] }, e));
    };
    const excludedName = cfg.excludeNames.some((n) => low(n) === low(row.name));
    const run = ctx.run || null;
    const replying = !!cfg.replyText; // auto-reply to someone who answered (not the follow-up)

    if (replying && row.fromMe) return out("SKIPPED", "You already answered them");
    if (!replying && !excludedName && cfg.onlyIfLastFromMe && !row.fromMe) return out("SKIPPED", "Customer wrote last — reply to them yourself");

    // Already messaged? "Stop by name" decides from the list, without opening the chat.
    const thisRun = !!run && run.sentThisRun.has(row.name);
    const nameHit = !replying && !excludedName && hooks.nameSent ? !!(await hooks.nameSent(row.name)) : false;
    if (!replying && !excludedName && cfg.stopBy === "name" && nameHit) {
      return thisRun ? out("SKIPPED", "Messaged earlier in this run") : out("ALREADY", "Already got this message (name)", { counted: true });
    }

    // Open the chat and make sure it really is this person. Slow chats get a second try.
    const prevId = threadId();
    const alreadyOpen = headerHasName(row.name, list);
    // Which of several identical rows (e.g. two "Facebook user" chats) this is, so the right one gets clicked.
    const sameKey = () => getRows(list, cfg).filter((r) => r.key === row.key);
    const occ = Math.max(0, sameKey().findIndex((r) => r.el === row.el));
    let opened = false;
    for (let tryOpen = 0; tryOpen < 2 && !opened; tryOpen++) {
      // Long inboxes only draw the rows on screen and redraw them while scrolling,
      // so bring the row into view first, then look it up again before clicking.
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
        if (row.el.isConnected && (await bringIntoView(row.el, list))) await sleep(150);
        const cands = sameKey();
        const fresh = cands.find((r) => r.el === row.el) || cands[occ] || cands[0];
        if (!fresh) return out("SKIPPED", "Chat left the list before it could be opened");
        row = fresh;
        try { await click(nameElementIn(row), hooks); clicked = true; }
        catch (e) { if (e.message !== "STALE") throw e; await sleep(400); }
      }
      if (!clicked) return problem("CLICK_FAILED", "Couldn't click this chat in the list — nothing sent", { status: "REVIEW" });
      opened = await waitFor(() => headerHasName(row.name, list) && (alreadyOpen || threadId() === null || threadId() !== prevId), cfg.pageTimeoutMs);
    }
    if (!opened) return problem("OPEN_TIMEOUT", "Couldn't confirm the open chat is this person — nothing sent", { status: "REVIEW" });
    await sleep(cfg.stepDelayMs);
    if (!headerHasName(row.name, list)) return problem("CHAT_CHANGED", "Chat changed while loading — nothing sent", { status: "REVIEW" });

    const id = threadId() || row.key;
    const warn = stopReason(cfg, list);
    if (warn) return out("STOP", `Meta shows: "${warn}"`, { id, code: "META_WARNING", help: HELP.META_WARNING });

    // "Facebook user" and "can't message" chats: always try Done while they're still in the inbox.
    // They're never written down as handled, so a Done that didn't work is tried again next time.
    const blocked = replying ? null : excludedName ? `Name is "${row.name}"` : bodyHas(cfg.blockedTexts) ? "Can't message this person" : null;
    if (blocked) {
      if (cfg.testMode) return out("EXCLUDED", blocked + " (test mode: Done not clicked)", { id });
      const m = await moveToDone(ctx, row);
      return m.ok ? out("EXCLUDED", blocked + " → moved to Done", { id }) : problem("DONE_FAILED", blocked + ", but " + m.why, { id, countsAsFailure: true });
    }
    if (await hooks.alreadyDone(id)) return out("SKIPPED", replying ? "Already auto-replied" : "Already handled in this campaign", { id });

    // The chat area can still be redrawing (e.g. the chat was already open), so give the box a moment.
    const composer = findComposer(list) || (await waitFor(() => findComposer(list), 3000, 250));
    if (!composer) return problem("NO_MESSAGE_BOX", "Message box not found — nothing sent", { id });

    await scrollChatToLatestFor(list, composer);

    // Never send the same message twice: is it already in this chat?
    if (!replying && cfg.dupCheck !== false && (await chatHasMessage(list, composer, cfg.template, row.name, cfg))) {
      const counted = !thisRun && (cfg.stopBy === "message" || (cfg.stopBy === "both" && nameHit));
      return out(thisRun ? "SKIPPED" : "ALREADY", thisRun ? "Messaged earlier in this run" : "Already got this message" + (nameHit ? " (name and message)" : " (message)"), { id, counted });
    }

    const text = render(replying ? cfg.replyText : cfg.template, row.name, cfg);
    if (!(await putText(composer, text, hooks))) {
      await clearComposer(composer, hooks);
      return problem("TEXT_FAILED", "Couldn't put the message in the box — nothing sent", { id });
    }
    let how = "";
    if (cfg.image && (cfg.image.dataUrl || cfg.image.native)) {
      how = await attachImage(composer, cfg, hooks);
      if (!how && cfg.imageRequired) {
        await clearComposer(composer, hooks);
        await removePreviews(composer, cfg, hooks);
        return problem("IMAGE_FAILED", "Image didn't attach — nothing sent", { id });
      }
    }

    if (cfg.testMode) {
      await sleep(1500);
      await clearComposer(composer, hooks);
      await removePreviews(composer, cfg, hooks);
      return out("TEST", "Ready to send (test mode): " + text.slice(0, 60), { id });
    }

    // Send, then confirm. Two independent signs that it went out:
    //  1. the message text appears on the page (outside the message box), or
    //  2. this chat's preview in the inbox list changes to "You: <your message>".
    const snip = sig(text).slice(0, 40);
    const short = sig(text).slice(0, 12);
    const pageSig = () => {
      let t = sig(document.body.innerText);
      const c = sig(composerText(composer));
      if (c) t = t.replace(c, "");
      return t;
    };
    const shown = () => countOf(pageSig(), snip);
    const previewIsMine = () => {
      const r = getRows(list, cfg).find((x) => x.name === row.name);
      return !!r && r.lines.some((l) => cfg.youPrefixes.some((p) => l.startsWith(p)) && sig(l.slice(l.indexOf(":") + 1)).startsWith(short));
    };
    const failCount = () => cfg.sendFailTexts.reduce((n, t) => n + countOf(low(document.body.innerText), low(t)), 0);
    const before = shown(), previewBefore = previewIsMine(), failBefore = failCount();
    const confirmed = () => shown() > before || (!previewBefore && previewIsMine());

    const btn = findLabeled(cfg.sendLabels, nearComposer(composer, 120))[0];
    if (btn) await click(btn, hooks); else await pressEnter(composer, hooks);
    let ok = await waitFor(confirmed, 3000);
    if (!ok && composerHasExactlyOnce(composer, text)) {
      await pressEnter(composer, hooks); // the text is still in the box, so this can't double-send
    }
    ok = ok || (await waitFor(() => confirmed() || !sig(composerText(composer)), cfg.pageTimeoutMs));
    await sleep(800);
    ok = ok && confirmed();
    if (failCount() > failBefore) {
      await hooks.markDone(id);
      return problem("META_NOT_SENT", "Meta says the message wasn't sent — not retried", { id, status: "UNKNOWN", countsAsFailure: true });
    }
    if (composerHasExactlyOnce(composer, text) && !ok) {
      await clearComposer(composer, hooks);
      return problem("SEND_STUCK", "Send didn't go through (text stayed in the box)", { id });
    }
    // Sent: either confirmed on screen, or the box emptied with no error from Meta.
    await hooks.markDone(id);
    await hooks.onSent();
    let note = (how ? `with image (${how})` : "text only") + (ok ? "" : " · couldn't double-check it on screen, but the box emptied with no error");
    if (cfg.moveSentToDone) {
      const m = await moveToDone(ctx, row);
      note += m.ok ? ", moved to Done" : ", " + m.why;
    }
    return out("SENT", note, { id, text, confirmed: ok });
  }

  async function scrollChatToLatestFor(list, composer) {
    const msgs = findMessageList(list, composer);
    if (!msgs) return false;
    for (let i = 0; i < 3; i++) { msgs.scrollTop = msgs.scrollHeight; await sleep(250); }
    return msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 8;
  }

  // ---------- the run ----------
  const STOP = Symbol("stop");

  class Runner {
    constructor(config, hooks) {
      this.cfg = Object.assign({}, DEFAULTS, config || {});
      this.hooks = hooks;
      this.state = "idle";
      this.paused = false;
      this.stopped = false;
      this.done = this.run();
    }
    setState(state, reason) {
      this.state = state;
      Promise.resolve(this.hooks.state({ state, reason: reason || "" })).catch(() => {});
    }
    pause(reason) { if (this.state === "running") { this.paused = true; this.setState("paused", reason || "Paused"); } }
    resume() { if (this.paused) { this.paused = false; this.setState("running"); } }
    stop() { this.stopped = true; this.paused = false; }
    async gate() {
      while (this.paused && !this.stopped) { this.atGate = true; await sleep(250); }
      this.atGate = false;
      if (this.stopped) throw STOP;
    }
    async wait(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) { await this.gate(); await sleep(Math.min(250, end - Date.now())); }
    }
    async run() {
      const { cfg, hooks } = this;
      // How many chats with each name + photo this run has handled. Counting (not just "seen") keeps
      // two identical rows apart, like two "Facebook user" chats where Done didn't work on the first.
      const visited = new Map();
      const notVisited = (rows) => {
        const seq = cfg.order === "top" ? rows : [...rows].reverse();
        const seen = new Map();
        const keep = new Set(seq.filter((r) => { const n = (seen.get(r.key) || 0) + 1; seen.set(r.key, n); return n > (visited.get(r.key) || 0); }));
        return rows.filter((r) => keep.has(r));
      };
      this.sentThisRun = new Set();
      let failures = 0, emptyLoads = 0, already = 0;
      this.setState("running");
      try {
        let screen = null;
        if (cfg.order === "bottom") screen = await this.scrollToBottomFirst();
        if (cfg.order === "screen") screen = await this.lowestOnScreen();
        if (cfg.order === "screen" && !screen) return;
        for (;;) {
          await this.gate();
          if ((await hooks.sentToday()) >= cfg.dailyCap) { this.setState("finished", `Daily limit of ${cfg.dailyCap} reached`); return; }
          const list = findList(cfg);
          if (!list) { this.pause("Can't find the inbox list. Open Business Suite → Inbox, then press Resume."); continue; }
          const warn = stopReason(cfg, list);
          if (warn) { this.pause(`Meta shows a warning: "${warn}". Check the page, then Resume or Stop.`); continue; }

          let rows = getRows(list, cfg);
          if (screen) rows = onlyFromScreenUp(rows, screen);
          rows = notVisited(rows);
          if (cfg.order !== "top") rows.reverse();
          if (!rows.length) {
            // Bottom-up: everything is loaded already, so look further UP (needed when the
            // page only draws the rows on screen). Top-down: load older chats below.
            if (cfg.order !== "top") {
              if (await scrollUp(list)) continue;
              this.setState("finished", "Reached the top of the inbox");
              return;
            }
            if (await loadMore(list, cfg)) { emptyLoads = 0; continue; }
            if (++emptyLoads >= 3) { this.setState("finished", "No more conversations in this view"); return; }
            continue;
          }
          emptyLoads = 0;
          const row = rows[0];
          visited.set(row.key, (visited.get(row.key) || 0) + 1);
          await hooks.state({ state: "running", reason: "", current: row.name });

          let res;
          try { res = await processRow({ cfg, hooks, list, run: this }, row); }
          catch (e) { res = { time: new Date().toISOString(), name: row.name, status: "FAILED", reason: "Error: " + (e && e.message ? e.message : e), code: "ERROR", help: HELP.ERROR }; }
          if (res.status === "STOP") { await hooks.log(Object.assign(res, { status: "REVIEW" })); this.pause(res.reason + ". " + HELP.META_WARNING.fix); continue; }
          await hooks.log(res);
          // A chat moved to Done has left the list; another row with the same name
          // and default photo (e.g. a second "Facebook user") is a different person.
          if (res.status === "EXCLUDED" && res.reason.endsWith("moved to Done")) visited.set(row.key, visited.get(row.key) - 1);

          const bad = res.status === "FAILED" || res.status === "REVIEW" || res.countsAsFailure;
          // Only a confirmed send proves sending works; skips and Done moves don't reset the count.
          failures = bad ? failures + 1 : res.status === "SENT" ? 0 : failures;
          if (failures >= cfg.maxConsecutiveFailures) {
            failures = 0;
            const h = res.help || HELP.ERROR;
            this.pause(`Paused after ${cfg.maxConsecutiveFailures} problems in a row. Last one (${res.name}): ${h.what} How to fix: ${h.fix} See the Problems tab for details, then press Resume.`);
            continue;
          }
          if (res.status === "SENT" || res.status === "UNKNOWN" || res.status === "TEST") { this.sentThisRun.add(row.name); already = 0; }
          if (res.status === "ALREADY" && res.counted) already++;
          const stopAt = Math.max(1, Math.round(+cfg.stopAfter || 3));
          if (cfg.stopBy !== "off" && already >= stopAt) {
            this.setState("finished", `Stopped: ${already} chats in a row already had this message, so this run reached the people from your last run.`);
            return;
          }
          if (res.status === "SENT" || res.status === "UNKNOWN" || res.status === "TEST") await this.wait(cfg.betweenChatsSec * 1000);
          else if ((res.status === "SKIPPED" || res.status === "ALREADY") && !res.id) await this.wait(50); // decided from the list, chat never opened
          else await this.wait(Math.min(cfg.stepDelayMs, 1500));
        }
      } catch (e) {
        if (e === STOP) { this.setState("stopped", "Stopped"); return; }
        this.setState("stopped", "Error: " + (e && e.message ? e.message : e));
      }
    }
    // "Lowest chat on screen": remembers which chats sit below the lowest visible one, so they're left alone.
    async lowestOnScreen() {
      const { cfg, hooks } = this;
      let list = findList(cfg);
      while (!list) {
        this.pause("Can't find the inbox list. Open Business Suite → Inbox, then press Resume.");
        await this.gate();
        list = findList(cfg);
      }
      const lr = rect(list);
      const bottom = Math.min(lr.bottom, window.innerHeight);
      const rows = getRows(list, cfg);
      let start = -1;
      rows.forEach((r, i) => {
        const rr = rect(r.el);
        if (rr.bottom > lr.top && rr.top + rr.height / 2 <= bottom) start = i;
      });
      if (start < 0) { this.setState("finished", "No chats are visible in the inbox list"); return null; }
      const below = {};
      for (const r of rows.slice(start + 1)) below[r.key] = (below[r.key] || 0) + 1;
      await hooks.state({ state: "running", reason: `Starting from “${rows[start].name}”, the lowest chat on screen, and going up.`, current: "" });
      // Names (with photo) that were only below the screen. A name that is also on or above the
      // screen (like several "Facebook user" chats) stays allowed.
      const atOrAbove = new Set(rows.slice(0, start + 1).map((r) => r.key));
      const belowOnly = new Set(Object.keys(below).filter((k) => !atOrAbove.has(k)));
      return { below, belowOnly, known: new Set(rows.map((r) => r.key)) };
    }

    // Keeps scrolling the inbox down until no older chats load. Pause/Stop work during it.
    // "Start from: Bottom": scrolls down as far as the Scrolling settings say, then the run works upward.
    // Returns the chats that were loaded, so older chats that load in later stay out of this run.
    async scrollToBottomFirst() {
      const { cfg, hooks } = this;
      const goal = scrollGoal(cfg, true);
      const end = Date.now() + cfg.loadAllMaxMinutes * 60000;
      const seen = new Set(), known = new Set();
      const note = (l) => { noteRows(l, cfg, seen); for (const r of getRows(l, cfg)) known.add(r.key); };
      let still = 0, scrolls = 0, list = null;
      for (;;) {
        await this.gate();
        list = findList(cfg);
        if (!list) { this.pause("Can't find the inbox list. Open Business Suite → Inbox, then press Resume."); continue; }
        note(list);
        const grew = await loadMore(list, cfg);
        scrolls++;
        note(list);
        still = grew ? 0 : still + 1;
        await hooks.state({ state: "running", reason: scrollProgress(goal, scrolls, seen.size, "Scrolling to the bottom first"), current: "" });
        if (still >= 2) {
          await hooks.state({ state: "running", reason: "Reached the bottom of the inbox. Sending from the bottom up." });
          return null;
        }
        if (goalReached(goal, scrolls, seen.size)) {
          await hooks.state({ state: "running", reason: `Scrolled ${scrolls} times (${seen.size} chats loaded). Sending from the lowest loaded chat, going up.` });
          // Older chats that load in underneath later (when the list moves) stay out of this run.
          return { belowOnly: new Set(), known, dropUnknownBelow: true };
        }
        if (Date.now() > end) {
          await hooks.state({ state: "running", reason: `Scrolled for ${cfg.loadAllMaxMinutes} minutes without reaching the bottom; starting from the lowest chat loaded.` });
          return null;
        }
      }
    }
  }

  // Leaves out the chats that were below the screen at the start (counted from the bottom, so a
  // repeated name like "Facebook user" still works), plus chats that load in below them later.
  // "Lowest chat on screen": leaves out the chats that were below the screen when Start was pressed.
  // Business Suite only keeps the chats near the screen in the page, so chats further up appear only
  // after scrolling up; those are always allowed. The only other chats left out are ones that appear
  // underneath a below-the-screen chat (older chats loading in at the bottom).
  function onlyFromScreenUp(rows, screen) {
    const keep = rows.map((r) => !screen.belowOnly.has(r.key));
    const firstBelow = rows.findIndex((r) => screen.belowOnly.has(r.key));
    if (firstBelow >= 0) rows.forEach((r, i) => { if (i > firstBelow && !screen.known.has(r.key)) keep[i] = false; });
    if (screen.dropUnknownBelow) {
      let lastKnown = -1;
      rows.forEach((r, i) => { if (screen.known.has(r.key)) lastKnown = i; });
      rows.forEach((r, i) => { if (i > lastKnown && !screen.known.has(r.key)) keep[i] = false; });
    }
    return rows.filter((_, i) => keep[i]);
  }

  async function scrollUp(list) {
    if (list.scrollTop <= 0) return false;
    list.scrollTop = Math.max(0, list.scrollTop - list.clientHeight * 0.8);
    await sleep(700);
    return true;
  }

  async function loadMore(list, cfg) {
    // Only a taller list means older chats loaded. (Counting rows on screen is misleading: Business
    // Suite only keeps the rows near the screen, so that count changes just by scrolling.)
    const h = list.scrollHeight;
    const grew = () => list.scrollHeight > h + 5;
    const pause = Math.max(0, (cfg.scrollWaitSec == null ? 1.5 : +cfg.scrollWaitSec) * 1000);
    const retries = Math.max(0, Math.min(10, Math.round(cfg.unstickRetries == null ? 2 : +cfg.unstickRetries)));
    const t0 = Date.now();
    list.scrollTop = list.scrollHeight;
    let ok = await waitFor(grew, Math.max(3000, pause), 250);
    // Business Suite sometimes stops loading older chats until the list moves. Do what a person
    // does: scroll up a little, then back down, and wait again (a bit further up each try).
    for (let i = 0; !ok && i < retries; i++) {
      list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - (300 + 400 * i));
      await sleep(500);
      list.scrollTop = list.scrollHeight;
      ok = await waitFor(grew, 2500, 250);
    }
    const left = pause - (Date.now() - t0);
    if (ok && left > 0) await sleep(left); // "wait between scrolls"
    return ok;
  }

  // How far to scroll (S1). useLimits=false means "all the way to the bottom".
  function scrollGoal(cfg, useLimits) {
    if (!useLimits || cfg.scrollHow === "all") return { kind: "all" };
    if (cfg.scrollHow === "chats") return { kind: "chats", n: Math.max(1, Math.round(+cfg.scrollChats || 1)) };
    return { kind: "scrolls", n: Math.max(1, Math.round(+cfg.scrollCount || 1)) };
  }
  const goalReached = (goal, scrolls, chats) =>
    (goal.kind === "scrolls" && scrolls >= goal.n) || (goal.kind === "chats" && chats >= goal.n);
  function scrollProgress(goal, scrolls, chats, prefix) {
    const what = goal.kind === "scrolls" ? `${scrolls} of ${goal.n} scrolls` : goal.kind === "chats" ? `${chats} of about ${goal.n} chats` : `${scrolls} scrolls`;
    return `${prefix}… ${what} · ${chats} chats loaded`;
  }
  const noteRows = (list, cfg, seen) => { for (const r of getRows(list, cfg)) seen.add(r.key + "#" + r.name); };

  // ---------- tools for the buttons ----------
  // "Scroll inbox to the bottom" button. Runs in the background and can be paused,
  // resumed and stopped; progress goes to onProgress({ state, rows, message }).
  const scrollJob = { state: "idle", paused: false, cancel: false, rows: 0 };
  async function loadWholeInbox(cfg, onProgress, maxSeconds) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (scrollJob.state !== "idle") return { ok: false, message: "Already scrolling" };
    const goal = scrollGoal(cfg, cfg.buttonUsesScrollSettings);
    const seen = new Set();
    let scrolls = 0;
    const report = (state, message) => {
      scrollJob.state = state;
      if (onProgress) try { onProgress({ state, rows: scrollJob.rows, chats: seen.size, scrolls, message }); } catch (_) {}
    };
    Object.assign(scrollJob, { paused: false, cancel: false, rows: 0 });
    report("running", "Scrolling the inbox down…");
    let end = Date.now() + (maxSeconds || cfg.loadAllMaxMinutes * 60) * 1000;
    let still = 0, result;
    try {
      for (;;) {
        if (scrollJob.paused && !scrollJob.cancel) {
          report("paused", `Scrolling paused (${seen.size} chats loaded)`);
          const t0 = Date.now();
          while (scrollJob.paused && !scrollJob.cancel) await sleep(200);
          end += Date.now() - t0; // paused time doesn't count toward the time limit
          if (!scrollJob.cancel) report("running", "Scrolling the inbox down…");
        }
        if (scrollJob.cancel) { result = { ok: true, reachedEnd: false, message: "Scrolling stopped" }; break; }
        if (still >= 2) { result = { ok: true, reachedEnd: true, message: "Reached the bottom of the inbox" }; break; }
        if (goalReached(goal, scrolls, seen.size)) {
          result = { ok: true, reachedEnd: false, reachedGoal: true,
            message: goal.kind === "scrolls" ? `Scrolled ${scrolls} times` : `Loaded about ${goal.n} chats` };
          break;
        }
        if (Date.now() > end) { result = { ok: true, reachedEnd: false, message: "Stopped before the bottom (time limit)" }; break; }
        const list = findList(cfg);
        if (!list) { result = { ok: false, reachedEnd: false, message: "Can't find the inbox list" }; break; }
        noteRows(list, cfg, seen);
        const grew = await loadMore(list, cfg);
        scrolls++;
        noteRows(list, cfg, seen);
        still = grew ? 0 : still + 1;
        scrollJob.rows = getRows(list, cfg).length;
        if (!scrollJob.paused && !scrollJob.cancel) report("running", scrollProgress(goal, scrolls, seen.size, "Scrolling the inbox down"));
      }
    } catch (e) {
      result = { ok: false, reachedEnd: false, message: "Error: " + (e && e.message ? e.message : e) };
    }
    result.rows = scrollJob.rows;
    result.chats = seen.size;
    result.scrolls = scrolls;
    report("idle", result.message);
    if (onProgress) try { onProgress({ state: "done", rows: result.rows, chats: result.chats, scrolls, message: result.message, reachedEnd: result.reachedEnd }); } catch (_) {}
    return result;
  }
  function pauseScroll() { if (scrollJob.state === "running") { scrollJob.paused = true; return true; } return false; }
  function resumeScroll() { if (scrollJob.state === "paused" || scrollJob.paused) { scrollJob.paused = false; return true; } return false; }
  function stopScroll() { if (scrollJob.state !== "idle") { scrollJob.cancel = true; scrollJob.paused = false; return true; } return false; }
  function scrollState() { return scrollJob.state; }
  // ---------- replies and buyers ----------
  // Sorts a reply into "hot", "warm", "cold" (not interested) or "replied" (unclear).
  function classifyReply(text, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const words = (s) => " " + low(s).normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
    const t = words(text);
    const has = (w) => { const p = words(w); return p.trim() && t.includes(p); };
    const strongCold = cfg.coldWords.filter((w) => w.trim().includes(" ") || w.length > 5);
    if (strongCold.some(has)) return "cold";
    if (cfg.hotWords.some(has)) return "hot";
    if (cfg.warmWords.some(has)) return "warm";
    if (cfg.coldWords.some(has)) return "cold";
    return "replied";
  }
  // The latest message shown under the name in an inbox row.
  function previewOf(row) {
    const i = row.lines.indexOf(row.name);
    return row.lines.slice(i + 1).find((l) => !TIME_RE.test(l)) || "";
  }

  // Finds a chat in the inbox list (by name + photo, or by name), scrolling down if needed.
  async function findChat(cfg, key, name, maxPages = 60) {
    const list = findList(cfg);
    if (!list) return null;
    const match = (r) => r.key === key || r.name === name;
    let r = getRows(list, cfg).find(match);
    if (r) return { list, row: r };
    list.scrollTop = 0;
    await sleep(500);
    let stale = 0;
    for (let page = 0; page < maxPages && stale < 3; page++) {
      r = getRows(list, cfg).find(match);
      if (r) return { list, row: r };
      const before = list.scrollTop;
      list.scrollTop += list.clientHeight * 0.8;
      await sleep(500);
      if (list.scrollTop === before) stale = (await loadMore(list, cfg)) ? 0 : stale + 1;
    }
    return null;
  }
  async function openChat(cfg, key, name, hooks) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    hooks = hooks || {};
    const f = await findChat(cfg, key, name);
    if (!f) return { ok: false, code: "CHAT_NOT_FOUND", help: HELP.CHAT_NOT_FOUND };
    if (await bringIntoView(f.row.el, f.list)) await sleep(150);
    const row = getRows(f.list, cfg).find((r) => r.key === f.row.key) || f.row;
    await click(nameElementIn(row), hooks);
    const ok = await waitFor(() => headerHasName(row.name, f.list), cfg.pageTimeoutMs);
    return ok ? { ok: true, list: f.list, row } : { ok: false, code: "OPEN_TIMEOUT", help: HELP.OPEN_TIMEOUT };
  }

  // "Check replies": reads the inbox list from the top and reports which of the given people
  // wrote back (their row's latest message isn't "You: …"). Nothing is opened or clicked.
  const scanJob = { state: "idle", cancel: false };
  async function scanReplies(cfg, contacts, onProgress, maxRows = 600) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (scanJob.state !== "idle") return { ok: false, message: "Already checking replies" };
    const list = findList(cfg);
    if (!list) return { ok: false, message: "Can't find the inbox list. Open Business Suite → Inbox." };
    Object.assign(scanJob, { state: "running", cancel: false });
    const byKey = new Map(contacts.map((c) => [c.key, c]));
    const nameCount = {};
    contacts.forEach((c) => { nameCount[c.name] = (nameCount[c.name] || 0) + 1; });
    const byName = new Map(contacts.filter((c) => nameCount[c.name] === 1).map((c) => [c.name, c]));
    const found = new Map(), seen = new Set();
    try {
      list.scrollTop = 0;
      await sleep(600);
      let stale = 0;
      while (seen.size < maxRows && stale < 3 && !scanJob.cancel) {
        for (const r of getRows(list, cfg)) {
          if (seen.has(r.key + "#" + r.name)) continue;
          seen.add(r.key + "#" + r.name);
          const c = byKey.get(r.key) || byName.get(r.name);
          if (c && !r.fromMe && !found.has(c.key)) {
            const reply = previewOf(r);
            found.set(c.key, { key: c.key, name: r.name, reply, kind: classifyReply(reply, cfg) });
          }
        }
        if (onProgress) try { onProgress({ state: "running", rows: seen.size, replies: found.size }); } catch (_) {}
        const before = list.scrollTop;
        list.scrollTop += list.clientHeight * 0.8;
        await sleep(600);
        if (list.scrollTop === before) stale = (await loadMore(list, cfg)) ? 0 : stale + 1;
      }
      list.scrollTop = 0;
      return { ok: true, rows: seen.size, replies: [...found.values()], stopped: scanJob.cancel };
    } finally {
      scanJob.state = "idle";
    }
  }

  // Auto-reply: opens one person's chat and sends a prepared reply, only if they wrote last
  // (if you already answered them yourself, nothing is sent). Same checks and send as the follow-up.
  async function sendReply(cfg, contact, reply, hooks) {
    cfg = Object.assign({}, DEFAULTS, cfg || {}, {
      replyText: reply.text, image: reply.image || null, moveSentToDone: false, onlyIfLastFromMe: false,
    });
    hooks = Object.assign({ alreadyDone: () => false, markDone: () => {}, onSent: () => {} }, hooks || {});
    const f = await findChat(cfg, contact.key, contact.name);
    if (!f) return { time: new Date().toISOString(), name: contact.name, key: contact.key, status: "FAILED",
      reason: "Couldn't find this chat in the inbox list", code: "CHAT_NOT_FOUND", help: HELP.CHAT_NOT_FOUND };
    return processRow({ cfg, hooks, list: f.list }, f.row);
  }
  // Where the inbox list is scrolled to, so a reply round in the middle of a run can put it back.
  function listPosition(cfg) { const l = findList(Object.assign({}, DEFAULTS, cfg || {})); return l ? l.scrollTop : null; }
  async function restoreListPosition(cfg, top) {
    const l = findList(Object.assign({}, DEFAULTS, cfg || {}));
    if (!l || top == null) return false;
    for (let i = 0; i < 4 && Math.abs(l.scrollTop - top) > 5; i++) { l.scrollTop = top; await sleep(500); }
    return true;
  }

  // Adds a Business Suite label (e.g. "Hot lead") to one person's chat, then checks it shows.
  async function labelChat(cfg, contact, hooks) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    hooks = hooks || {};
    const name = cfg.labelName;
    const fail = (code, why) => ({ ok: false, code, why, help: HELP[code] });
    const o = await openChat(cfg, contact.key, contact.name, hooks);
    if (!o.ok) return o;
    await sleep(cfg.stepDelayMs);
    const lr = rect(o.list);
    const right = (el) => !o.list.contains(el) && rect(el).left > lr.right;
    const box = [...document.querySelectorAll("input,textarea,[contenteditable=true]")].find((el) => isVisible(el) && right(el) &&
      /label/i.test((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "")));
    if (!box) return fail("LABEL_FAILED", "No “Add label” box on the right side of the chat");
    const shown = () => {
      let n = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const p = t.parentElement;
        if (p && norm(t.nodeValue) === name && right(p) && isVisible(p) && !p.closest("input,textarea")) n++;
      }
      return n;
    };
    const before = shown();
    await click(box, hooks);
    box.focus();
    if (box.tagName === "INPUT" || box.tagName === "TEXTAREA") setNativeValue(box, name); else document.execCommand("insertText", false, name);
    await sleep(900);
    // Pick the matching item if a list of labels opened; otherwise press Enter.
    const option = [...document.querySelectorAll("[role=option],[role=menuitem],[role=button],li")].find((el) =>
      isVisible(el) && right(el) && norm(el.innerText) === name && rect(el).top > rect(box).top);
    if (option) await click(option, hooks);
    else {
      const k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      box.dispatchEvent(new KeyboardEvent("keydown", k));
      box.dispatchEvent(new KeyboardEvent("keyup", k));
    }
    const ok = await waitFor(() => shown() > before, 4000);
    if (box.isConnected && (box.value || "").trim()) setNativeValue(box, "");
    if (ok) return { ok: true };
    if (before > 0) return { ok: true, already: true };
    return fail("LABEL_FAILED", "The label didn't show on the chat after adding it");
  }

  async function labelLeads(cfg, contacts, onProgress) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    Object.assign(scanJob, { state: "running", cancel: false });
    const results = [];
    try {
      for (const c of contacts) {
        if (scanJob.cancel) break;
        let r;
        try { r = await labelChat(cfg, c, {}); } catch (e) { r = { ok: false, code: "ERROR", help: HELP.ERROR, why: String(e && e.message || e) }; }
        results.push(Object.assign({ key: c.key, name: c.name }, r));
        if (onProgress) try { onProgress({ state: "labeling", done: results.length, total: contacts.length, last: results[results.length - 1] }); } catch (_) {}
        await sleep(Math.min(cfg.stepDelayMs, 1500));
      }
    } finally {
      scanJob.state = "idle";
    }
    return { ok: true, results };
  }

  async function scrollChatToLatest(cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const list = findList(cfg);
    if (!list) return { ok: false, message: "Can't find the inbox list" };
    const composer = findComposer(list);
    const ok = await scrollChatToLatestFor(list, composer);
    return { ok, message: ok ? "Chat scrolled to the latest message" : "Couldn't find the open chat to scroll" };
  }
  // What the engine can see on the current page — for the "Check page" button.
  function diagnose(cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const list = findList(cfg);
    const rows = list ? getRows(list, cfg) : [];
    const composer = list ? findComposer(list) : null;
    const lr = list ? rect(list) : null;
    return {
      url: location.href,
      threadId: threadId(),
      inboxList: !!list,
      rows: rows.length,
      firstRows: rows.slice(0, 5).map((r) => ({ name: r.name, lastFromMe: r.fromMe, firstName: firstName(r.name, cfg) })),
      messageBox: !!composer,
      doneButton: list ? findLabeled(cfg.doneLabels, (el) => !list.contains(el) && rect(el).left >= lr.right - 5).length > 0 : false,
      sendButton: composer ? findLabeled(cfg.sendLabels, nearComposer(composer, 120)).length > 0 : false,
      fileInput: composer ? !!findFileInput(composer) : false,
      cantMessageBanner: !!bodyHas(cfg.blockedTexts),
      warning: stopReason(cfg, list),
    };
  }

  // Desktop app (B): hooks come from Playwright through window.fuHook(name, payload).
  function bridgeHooks() {
    const call = (name, payload) => root.fuHook(name, payload === undefined ? null : payload);
    return {
      log: (e) => call("log", e),
      state: (s) => call("state", s),
      alreadyDone: (id) => call("alreadyDone", id),
      markDone: (id) => call("markDone", id),
      sentToday: () => call("sentToday"),
      onSent: () => call("onSent"),
      native: {
        click: (x, y) => call("native.click", { x, y }),
        hover: (x, y) => call("native.hover", { x, y }),
        typeText: (text) => call("native.typeText", text),
        key: (k) => call("native.key", k),
        attach: () => call("native.attach"),
      },
    };
  }

  const api = {
    VERSION,
    DEFAULTS,
    DEFAULT_REPLIES,
    HELP,
    firstName,
    render,
    current: null,
    start(config, hooks) {
      if (api.current && !["stopped", "finished"].includes(api.current.state)) throw new Error("Already running");
      if (scrollJob.state !== "idle") throw new Error("Scrolling the inbox is still going. Stop it or wait for it to finish first.");
      api.current = new Runner(config, hooks);
      return api.current;
    },
    startWithBridge(config) { api.start(config, bridgeHooks()); return true; },
    pause() { api.current && api.current.pause("Paused"); },
    resume() { api.current && api.current.resume(); },
    stop() { api.current && api.current.stop(); stopScroll(); scanJob.cancel = true; },
    status() { return api.current ? api.current.state : "idle"; },
    // True once a paused run has finished the chat it was on and is just waiting.
    halted() { const r = api.current; return !r || !["running", "paused"].includes(r.state) || (r.paused && !!r.atGate); },
    // Pauses (if running) and waits until the current chat is finished, so a tool can use the page.
    async pauseAndWait(maxMs = 90000) {
      if (api.status() === "running") api.pause();
      return waitFor(() => api.halted(), maxMs, 250);
    },
    classifyReply,
    messageSigs,
    tools: { loadWholeInbox, pauseScroll, resumeScroll, stopScroll, scrollState, scrollChatToLatest, diagnose,
      scanReplies, labelChat, labelLeads, openChat, sendReply, listPosition, restoreListPosition,
      stopScan: () => { scanJob.cancel = true; },
      scanState: () => scanJob.state },
  };
  root.FollowUpEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
