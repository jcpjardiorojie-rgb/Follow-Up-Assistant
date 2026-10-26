// FollowUp for WhatsApp: the part that works inside WhatsApp Web (web.whatsapp.com).
// It reads the chat list, opens each chat, writes your message with the person's first name,
// adds your image and sends, one chat at a time, with a random pause between chats.
(() => {
  if (window.WAEngine) return;

  const DEFAULTS = {
    template: "Hi {first_name}! Just following up po 😊",
    unsavedWord: "po", // used instead of a phone number: "Hi po!"
    useTildeName: false, // an unsaved number that shows "~Mark D" gets "Hi Mark!"
    imageStyle: "one", // "one": image with the text under it (one bubble) · "two": text, then the image
    imageRequired: true, // don't send if the image doesn't attach
    order: "top", // "top": newest first · "bottom": oldest first (scrolls down, then goes up)
    limitMode: "ramp", // "ramp": grows by itself · "fixed": the same number every day
    ramp: [50, 80, 120, 160, 200], // days 1–3, 4–6, week 2, week 3, after
    dailyCap: 100, // used when limitMode is "fixed"
    capLeft: Infinity, // how many more today (worked out by the content script)
    gapMinSec: 30,
    gapMaxSec: 90,
    onlyIfLastFromMe: true, // skip chats where the customer wrote last (they need a real answer)
    skipGroups: true,
    stepDelayMs: 1200,
    pageTimeoutMs: 8000,
    maxConsecutiveFailures: 3,
    testMode: false,
    waitWhenHidden: true,
    frontOnStart: true,
    keepAwake: true,
    whenFinished: "nothing",
    finishCountdownSec: 60,
    finishOnEnd: true,
    finishOnDaily: false,
    notifyPC: true,
    notifyPhone: false,
    notifyOnPause: true,
    ntfyTopic: "",
    ntfyServer: "https://ntfy.sh",
    // Shown by WhatsApp in a pop-up when it's limiting or checking the account: stop right away.
    warnTexts: ["banned", "restricted", "unusual activity", "suspicious", "too many messages", "spam"],
    // Shown where the message box should be when the chat can't get messages.
    cantTexts: ["can't send messages", "cannot send messages", "you blocked this contact", "unblock", "only admins can send"],
  };

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const low = (s) => norm(s).toLowerCase();
  const sig = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const countOf = (hay, needle) => {
    if (!needle) return 0;
    let n = 0, i = hay.indexOf(needle);
    while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
    return n;
  };
  const rect = (el) => el.getBoundingClientRect();
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = rect(el);
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function isScrollable(el) {
    if (el.scrollHeight <= el.clientHeight + 10) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
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
  function sleepOrVisible(ms) {
    return new Promise((res) => {
      const done = () => { document.removeEventListener("visibilitychange", done); clearTimeout(t); res(); };
      const t = setTimeout(done, ms);
      document.addEventListener("visibilitychange", done);
    });
  }
  const textLines = (el) => String((el && el.innerText) || "").split("\n").map(norm).filter(Boolean);
  const icons = (el) => [...el.querySelectorAll("[data-icon]")].map((x) => x.getAttribute("data-icon") || "");

  // ---------- names ----------
  const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
  const isPhone = (name) => PHONE_RE.test(norm(name));
  function firstWord(name) {
    for (const tok of norm(name).split(" ")) {
      let w = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (w.length < 2) continue;
      if (w === w.toUpperCase() || w === w.toLowerCase()) w = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return w;
    }
    return "";
  }
  // The word that goes into {first_name}: the saved name, or for an unsaved number your own word
  // (or the "~name" they show, if you ticked that).
  function greetName(name, cfg, tilde) {
    if (!isPhone(name)) return firstWord(name) || cfg.unsavedWord;
    if (cfg.useTildeName && tilde) return firstWord(tilde) || cfg.unsavedWord;
    return cfg.unsavedWord;
  }
  function render(template, name, cfg, tilde) {
    return String(template || "")
      .replace(/\{\s*first[_ ]?name\s*\}/gi, greetName(name, cfg, tilde))
      .replace(/\{\s*(full[_ ]?)?name\s*\}/gi, isPhone(name) ? (cfg.useTildeName && tilde ? norm(tilde) : cfg.unsavedWord) : norm(name));
  }
  // "~Mark D" (the name an unsaved person set for themselves), if WhatsApp shows it.
  function tildeName(lines) {
    const l = (lines || []).find((x) => /^~\s*\S/.test(x));
    return l ? norm(l.replace(/^~\s*/, "")) : "";
  }

  // ---------- reading WhatsApp Web ----------
  function findList() {
    const pane = document.getElementById("pane-side");
    if (pane) {
      if (isScrollable(pane)) return pane;
      const inner = [...pane.querySelectorAll("div")].find(isScrollable);
      return inner || pane;
    }
    // Fallback: the scrolling area on the left with the most chat rows.
    let best = null, bestN = 0;
    for (const el of document.querySelectorAll("div")) {
      if (!isScrollable(el) || rect(el).left > window.innerWidth * 0.5) continue;
      const n = el.querySelectorAll('[role="listitem"],[role="row"]').length;
      if (n > bestN) { best = el; bestN = n; }
    }
    return best;
  }
  function rowEls(list) {
    let els = [...list.querySelectorAll('[role="listitem"]')];
    if (!els.length) els = [...list.querySelectorAll('[role="row"]')];
    els = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    return els.filter(isVisible);
  }
  function rowInfo(el) {
    const nameEl = el.querySelector("span[title]");
    if (!nameEl) return null;
    const name = norm(nameEl.getAttribute("title") || nameEl.textContent);
    if (!name) return null;
    const ic = icons(el);
    const lines = textLines(el);
    return {
      el, name, key: name, lines,
      // Ticks (or the clock) in the preview mean your message is the last one.
      fromMe: ic.some((i) => /check|msg-time|status-time/.test(i)),
      groupIcon: ic.some((i) => /default-group|community/.test(i)),
      unsaved: isPhone(name),
      tilde: tildeName(lines),
      top: rect(el).top,
    };
  }
  function getRows(list) {
    return rowEls(list).map(rowInfo).filter(Boolean).sort((a, b) => a.top - b.top);
  }
  const mainPane = () => document.getElementById("main");
  const header = () => { const m = mainPane(); return m ? m.querySelector("header") : null; };
  function headerLines() { const h = header(); return h ? textLines(h) : []; }
  const headerHasName = (name) => headerLines().some((l) => l === name);
  // A group shows its members under the name ("Ana, Ben, You") or the group picture placeholder.
  function headerIsGroup() {
    const h = header();
    if (!h) return false;
    if (icons(h).some((i) => /default-group|community/.test(i))) return true;
    return headerLines().slice(1).some((l) => (l.match(/,/g) || []).length >= 2 || /(^|,\s*)You$/.test(l));
  }
  function footer() { const m = mainPane(); return m ? m.querySelector("footer") || m : null; }
  function findComposer() {
    const f = footer();
    if (!f) return null;
    const eds = [...f.querySelectorAll('[contenteditable="true"]')].filter(isVisible);
    return eds.find((e) => e.getAttribute("role") === "textbox") || eds[eds.length - 1] || null;
  }
  const composerText = (c) => (c ? c.innerText || "" : "");
  function sendButtonIn(scope) {
    if (!scope) return null;
    const ic = [...scope.querySelectorAll('[data-icon*="send"]')].find(isVisible);
    if (ic) return ic.closest("button,[role=button]") || ic;
    return [...scope.querySelectorAll('[aria-label="Send"],button[title="Send"]')].find(isVisible) || null;
  }
  // Your messages in the open chat, and their text (the message box itself is left out).
  function outgoing() {
    const m = mainPane();
    if (!m) return [];
    let els = [...m.querySelectorAll('.message-out,[data-id^="true_"]')];
    return els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
  }
  function chatTextSig() {
    const m = mainPane();
    if (!m) return "";
    let t = sig(m.innerText);
    const f = m.querySelector("footer");
    if (f) { const ft = sig(f.innerText); if (ft) t = t.replace(ft, ""); }
    return t;
  }
  function errorIcons() { return outgoing().filter((e) => icons(e).some((i) => /error|alert|failed/.test(i))).length; }
  function dialogText() {
    return [...document.querySelectorAll('[role="dialog"],[data-animate-modal-body]')].filter(isVisible).map((d) => d.innerText).join(" ");
  }
  function warning(cfg) {
    const t = low(dialogText());
    const w = cfg.warnTexts.find((x) => t.includes(low(x)));
    return w ? norm(dialogText()).slice(0, 160) : "";
  }
  function cantMessage(cfg) {
    const f = footer();
    const t = low(f ? f.innerText : "");
    return cfg.cantTexts.some((x) => t.includes(low(x)));
  }
  // The caption box of WhatsApp's picture screen: a text box that isn't the chat's message box or the search.
  function captionBox(composer) {
    const side = document.getElementById("side");
    const f = footer();
    return [...document.querySelectorAll('[contenteditable="true"]')].filter(isVisible)
      .find((e) => e !== composer && !(side && side.contains(e)) && !(f && f.contains(e))) || null;
  }
  function mediaSendButton(caption) {
    for (let p = caption; p && p !== document.body; p = p.parentElement) {
      const b = sendButtonIn(p);
      if (b) return b;
    }
    return null;
  }

  // ---------- doing things like a person ----------
  function center(el) { const r = rect(el); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
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
  async function bringIntoView(el, container) {
    const box = rect(container), r = rect(el), margin = 8;
    let delta = 0;
    if (r.top < box.top + margin) delta = r.top - box.top - margin;
    else if (r.bottom > box.bottom - margin) delta = r.bottom - box.bottom + margin;
    if (!delta) return false;
    container.scrollTop += delta;
    await sleep(250);
    return true;
  }
  function click(el) {
    if (!el.isConnected) throw new Error("STALE");
    const { x, y } = center(el);
    const target = document.elementFromPoint(x, y);
    fireMouse(target && el.contains(target) ? target : el, x, y);
  }
  function selectAllIn(el) {
    el.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  async function clearBox(box) {
    if (!box || !box.isConnected || !sig(composerText(box))) return;
    selectAllIn(box);
    document.execCommand("delete");
    await sleep(150);
    if (sig(composerText(box))) { box.textContent = ""; box.dispatchEvent(new InputEvent("input", { bubbles: true })); }
  }
  const hasOnce = (box, text) => countOf(sig(composerText(box)), sig(text).slice(0, 40)) === 1;
  async function putText(box, text) {
    await clearBox(box);
    box.focus();
    // 1) paste, which WhatsApp's editor handles itself (keeps line breaks); 2) typing commands as a fallback
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(300);
    if (!hasOnce(box, text)) {
      await clearBox(box);
      selectAllIn(box);
      text.split("\n").forEach((line, i) => {
        if (i) document.execCommand("insertLineBreak");
        if (line) document.execCommand("insertText", false, line);
      });
    }
    return waitFor(() => hasOnce(box, text), 3000);
  }
  function pressEnter(box) {
    box.focus();
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    box.dispatchEvent(new KeyboardEvent("keydown", o));
    box.dispatchEvent(new KeyboardEvent("keypress", o));
    box.dispatchEvent(new KeyboardEvent("keyup", o));
  }
  function pressEscape(el) {
    const o = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    (el || document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", o));
  }
  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || "image.jpg", { type: mime });
  }
  function imageInput() {
    return [...document.querySelectorAll('input[type="file"]')].find((i) => /image/.test(i.getAttribute("accept") || "")) || null;
  }
  function attachButton() {
    const f = footer();
    if (!f) return null;
    const ic = [...f.querySelectorAll("[data-icon]")].find((e) => /plus|attach|clip/.test(e.getAttribute("data-icon")) && isVisible(e));
    if (ic) return ic.closest("button,[role=button]") || ic;
    return [...f.querySelectorAll('[title="Attach"],[aria-label="Attach"]')].find(isVisible) || null;
  }
  // Opens WhatsApp's picture screen with your image. Returns its caption box, or null.
  async function openPicture(composer, cfg) {
    const file = dataUrlToFile(cfg.image.dataUrl, cfg.image.name);
    composer.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    let cap = await waitFor(() => captionBox(composer), 4000);
    if (cap) return cap;
    let input = imageInput();
    if (!input) {
      const b = attachButton();
      if (b) { click(b); input = await waitFor(imageInput, 3000); }
    }
    if (!input) return null;
    const dt2 = new DataTransfer();
    dt2.items.add(file);
    input.files = dt2.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    cap = await waitFor(() => captionBox(composer), 8000);
    if (!cap) pressEscape(); // close the attach menu if it stayed open
    return cap || null;
  }
  async function closePicture(composer) {
    for (let i = 0; i < 3 && captionBox(composer); i++) {
      const cap = captionBox(composer);
      let x = null;
      for (let p = cap; p && p !== document.body && !x; p = p.parentElement) {
        x = [...p.querySelectorAll('[data-icon="x"],[data-icon*="close"],[aria-label="Close"]')].find(isVisible);
      }
      if (x) click(x.closest("button,[role=button]") || x); else pressEscape(cap);
      await sleep(400);
    }
  }

  // Plain-language explanation for every kind of problem: what happened, why, and how to fix it.
  const HELP = {
    CLICK_FAILED: { what: "The chat couldn't be clicked in the list, so nothing was sent.", why: "The chat list was moving at that moment.", fix: "Usually fixes itself on the next chat. If it repeats, press F5 on WhatsApp Web, then Resume." },
    OPEN_TIMEOUT: { what: "The chat didn't open in time, so nothing was sent.", why: "WhatsApp Web was slow, or the name at the top of the chat looks different from the list.", fix: "Settings → raise “Wait after opening a chat”. If it's always the same person, message them yourself." },
    NO_MESSAGE_BOX: { what: "This chat had no message box, so nothing was sent.", why: "WhatsApp Web changed, or the chat was still loading.", fix: "Press Check page and send Claude a screenshot of the result and of the chat." },
    TEXT_FAILED: { what: "The message couldn't be typed into the box, so nothing was sent.", why: "The message box wasn't ready, or WhatsApp Web changed.", fix: "Press F5 on WhatsApp Web, then Resume. If it keeps happening, send Claude a screenshot." },
    IMAGE_FAILED: { what: "The image didn't attach, so nothing was sent.", why: "The image is too big or WhatsApp's picture screen didn't open.", fix: "Choose a JPG or PNG under 5 MB. Or untick “Don't send if the image fails”." },
    SEND_STUCK: { what: "The message stayed in the box after pressing Send, so it was not sent.", why: "The Send button didn't respond, usually because of a slow connection.", fix: "Check your internet and that your phone is online, then Resume." },
    WA_NOT_SENT: { what: "WhatsApp showed that the message wasn't sent (red mark).", why: "Connection problem, or WhatsApp is limiting your messages.", fix: "Check your internet and phone. If it repeats, stop for today and lower the daily number." },
    WA_WARNING: { what: "WhatsApp showed a warning, so FollowUp stopped.", why: "WhatsApp may be limiting or checking your number.", fix: "Read the warning in WhatsApp Web. Stop for today, and use a lower daily number for a few days." },
    ERROR: { what: "Something unexpected went wrong on this chat, so nothing was sent.", why: "WhatsApp Web changed in a way FollowUp didn't expect.", fix: "Press F5 on WhatsApp Web, then Resume. If it repeats, send Claude the Problems tab." },
    SHUTDOWN_HELPER: { what: "The run finished, but the computer couldn't be shut down.", why: "The Windows helper isn't installed for this extension yet.", fix: "Double-click windows\\Setup-FollowUp.bat once more (after installing FollowUp for WhatsApp), then reload the extension." },
    NOTIFY_FAILED: { what: "The phone notification couldn't be sent.", why: "No internet, or the ntfy topic is empty or wrong.", fix: "Settings → Notifications: check the topic, then press “Send a test”." },
  };

  // ---------- one chat ----------
  async function processRow(ctx, row) {
    const { cfg, hooks, list } = ctx;
    const out = (status, reason, extra) => Object.assign({ time: new Date().toISOString(), name: row.name, key: row.key, status, reason: reason || "" }, extra || {});
    const problem = (code, reason, extra) => {
      const e = Object.assign({ code, help: HELP[code] }, extra);
      const status = e.status || "FAILED";
      delete e.status;
      return out(status, reason, e);
    };

    // Decided from the list, without opening the chat.
    if (cfg.skipGroups && row.groupIcon) return out("SKIPPED", "Group chat");
    if (cfg.onlyIfLastFromMe && !row.fromMe) return out("SKIPPED", "Customer wrote last — answer them yourself");
    if (await hooks.alreadyDone(row.key)) return out("SKIPPED", "Already got this message (this campaign)");

    // Open the chat and make sure it really is this person.
    const alreadyOpen = headerHasName(row.name);
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      const fresh = getRows(list).find((r) => r.key === row.key);
      if (!fresh) return out("SKIPPED", "Chat left the list before it could be opened");
      row = Object.assign({}, row, { el: fresh.el });
      try { if (await bringIntoView(row.el, list)) await sleep(150); click(row.el.querySelector("span[title]") || row.el); clicked = true; }
      catch (e) { if (e.message !== "STALE") throw e; await sleep(400); }
    }
    if (!clicked) return problem("CLICK_FAILED", "Couldn't click this chat — nothing sent", { status: "REVIEW" });
    const opened = await waitFor(() => headerHasName(row.name) && (alreadyOpen || findComposer() || cantMessage(cfg)), cfg.pageTimeoutMs);
    if (!opened) return problem("OPEN_TIMEOUT", "Couldn't confirm the open chat is this person — nothing sent", { status: "REVIEW", seen: headerLines()[0] || "" });
    await sleep(cfg.stepDelayMs);
    if (!headerHasName(row.name)) return problem("OPEN_TIMEOUT", "Chat changed while loading — nothing sent", { status: "REVIEW" });

    const w = warning(cfg);
    if (w) return out("STOP", `WhatsApp shows: "${w}"`, { code: "WA_WARNING", help: HELP.WA_WARNING });
    if (cfg.skipGroups && headerIsGroup()) return out("SKIPPED", "Group chat");
    if (cantMessage(cfg)) return out("SKIPPED", "Can't message this person (blocked or no longer on WhatsApp)");

    const composer = findComposer() || (await waitFor(findComposer, 3000, 250));
    if (!composer) return problem("NO_MESSAGE_BOX", "Message box not found — nothing sent");

    const tilde = row.tilde || tildeName(headerLines());
    const text = render(cfg.template, row.name, cfg, tilde);
    const hasImage = !!(cfg.image && cfg.image.dataUrl);
    const snip = sig(text).slice(0, 40);
    const outBefore = outgoing().length, errBefore = errorIcons(), textBefore = countOf(chatTextSig(), snip);
    const textShown = () => countOf(chatTextSig(), snip) > textBefore;

    // Test mode: fill everything in, then clear it again. Nothing is sent.
    if (cfg.testMode) {
      let note = "";
      if (hasImage && cfg.imageStyle === "one") {
        const cap = await openPicture(composer, cfg);
        if (cap) { await putText(cap, text); note = " (image with the text under it)"; await sleep(1500); await closePicture(composer); }
        else note = " (image didn't attach)";
      } else {
        await putText(composer, text);
        await sleep(1500);
        await clearBox(composer);
        if (hasImage) { const cap = await openPicture(composer, cfg); note = cap ? " + image" : " (image didn't attach)"; await sleep(800); await closePicture(composer); }
      }
      return out("TEST", "Ready to send (test mode)" + note + ": " + text.slice(0, 60));
    }

    let how;
    if (hasImage && cfg.imageStyle === "one") {
      // One bubble: the picture with your message under it.
      const cap = await openPicture(composer, cfg);
      if (!cap) {
        if (cfg.imageRequired) return problem("IMAGE_FAILED", "Image didn't attach — nothing sent");
        if (!(await sendText(composer, text))) return problem("SEND_STUCK", "Send didn't go through");
        how = "text only (image didn't attach)";
      } else {
        if (!(await putText(cap, text))) { await closePicture(composer); return problem("TEXT_FAILED", "Couldn't put the message under the image — nothing sent"); }
        const btn = mediaSendButton(cap);
        if (btn) click(btn); else pressEnter(cap);
        const gone = await waitFor(() => !captionBox(composer), 6000);
        if (!gone) { await closePicture(composer); return problem("SEND_STUCK", "The picture screen didn't send — nothing sent"); }
        how = "image with the message";
      }
    } else {
      if (!(await sendText(composer, text))) {
        if (hasOnce(composer, text)) { await clearBox(composer); return problem("SEND_STUCK", "Send didn't go through (text stayed in the box)"); }
        return problem("TEXT_FAILED", "Couldn't put the message in the box — nothing sent");
      }
      how = "text";
      if (hasImage) {
        const cap = await openPicture(composer, cfg);
        if (cap) {
          const btn = mediaSendButton(cap);
          if (btn) click(btn); else pressEnter(cap);
          how = (await waitFor(() => !captionBox(composer), 6000)) ? "text, then the image" : "text (the image didn't send)";
          if (captionBox(composer)) await closePicture(composer);
        } else how = "text (image didn't attach)";
      }
    }
    // Did it go out? Your new message shows in the chat (images can take a few seconds to upload).
    const ok = await waitFor(() => outgoing().length > outBefore || textShown(), hasImage ? 20000 : 8000);
    await sleep(600);
    if (errorIcons() > errBefore) {
      await hooks.markDone(row.key);
      return problem("WA_NOT_SENT", "WhatsApp says the message wasn't sent — not retried", { status: "UNKNOWN" });
    }
    await hooks.markDone(row.key);
    await hooks.onSent();
    return out("SENT", how + (ok ? "" : " · couldn't double-check it on screen, but the box emptied with no error"), { text, confirmed: !!ok });

    async function sendText(box, t) {
      if (!(await putText(box, t))) return false;
      const btn = sendButtonIn(footer());
      if (btn) click(btn); else pressEnter(box);
      let gone = await waitFor(() => !sig(composerText(box)), 3000);
      if (!gone && hasOnce(box, t)) { pressEnter(box); gone = await waitFor(() => !sig(composerText(box)), 3000); }
      return gone;
    }
  }

  // ---------- the run ----------
  const STOP = Symbol("stop");
  let current = null;
  class Runner {
    constructor(cfg, hooks) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.hooks = Object.assign({ log() {}, state() {}, alreadyDone: () => false, markDone() {}, onSent() {} }, hooks || {});
      this.state = "idle"; this.paused = false; this.stopped = false; this.wake = null;
    }
    setState(state, reason, code) {
      this.state = state;
      this.hooks.state({ state, reason: reason || "", code: code || "" });
    }
    pause(reason) { if (this.state !== "running") return; this.paused = true; this.setState("paused", reason || "Paused"); }
    resume() { if (!this.paused) return; this.paused = false; this.setState("running", "Resumed"); if (this.wake) this.wake(); }
    stop() { this.stopped = true; this.paused = false; if (this.wake) this.wake(); }
    async gate() {
      while (this.paused && !this.stopped) await new Promise((r) => { this.wake = r; setTimeout(r, 500); });
      if (this.stopped) throw STOP;
      if (this.cfg.waitWhenHidden !== false && document.hidden) {
        this.setState("running", "Waiting: WhatsApp Web is hidden (another tab, minimized, or behind another window). It continues the moment it's visible.", "hidden");
        while (document.hidden && !this.stopped && !this.paused) await sleepOrVisible(1000);
        if (this.stopped) throw STOP;
        this.setState("running", "Visible again, continuing…", "visible");
      }
    }
    async wait(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) { await this.gate(); await sleep(Math.min(250, end - Date.now())); }
      await this.gate();
    }
    async run() {
      const { cfg, hooks } = this;
      this.setState("running", cfg.testMode ? "Test mode: nothing will be sent." : "Starting…");
      try {
        let list = findList();
        while (!list) {
          this.pause("Can't find your chat list. Open WhatsApp Web, wait until your chats show, then press Resume.");
          await this.gate();
          list = findList();
        }
        const bottomFirst = cfg.order === "bottom";
        if (bottomFirst) {
          this.setState("running", "Scrolling down to your oldest chats…");
          let same = 0, last = -1;
          while (same < 3) {
            await this.gate();
            list.scrollTop = list.scrollHeight;
            await sleep(700);
            if (list.scrollHeight === last) same++; else { same = 0; last = list.scrollHeight; }
          }
          this.setState("running", "Reached the bottom of your chats. Sending from the bottom up.");
        }
        const visited = new Set();
        let failures = 0, sent = 0, stuck = 0;
        const cap = Math.max(0, cfg.capLeft === Infinity ? Infinity : Math.floor(+cfg.capLeft));
        for (;;) {
          await this.gate();
          if (sent >= cap) { this.setState("finished", `Today's limit reached (${cfg.todayLimit || sent} today). It continues tomorrow from where it stopped.`, "daily"); return; }
          list = findList() || list;
          const w = warning(cfg);
          if (w) { this.setState("stopped", `WhatsApp shows: "${w}". ${HELP.WA_WARNING.fix}`, "warning"); return; }
          const rows = getRows(list).filter((r) => !visited.has(r.key));
          const row = bottomFirst ? rows[rows.length - 1] : rows[0];
          if (!row) {
            const before = list.scrollTop;
            list.scrollTop = before + (bottomFirst ? -1 : 1) * Math.max(120, list.clientHeight * 0.7);
            await sleep(600);
            if (Math.abs(list.scrollTop - before) < 2) {
              if (++stuck >= 3) { this.setState("finished", bottomFirst ? "Reached the top of your chats" : "Reached the end of your chats", "end"); return; }
            } else stuck = 0;
            continue;
          }
          stuck = 0;
          visited.add(row.key);
          hooks.state({ state: "running", reason: "", current: row.name });
          let res;
          try { res = await processRow({ cfg, hooks, list }, row); }
          catch (e) {
            if (e === STOP) throw e;
            res = { time: new Date().toISOString(), name: row.name, key: row.key, status: "FAILED", reason: "Error: " + (e && e.message ? e.message : e), code: "ERROR", help: HELP.ERROR };
          }
          if (res.status === "STOP") { hooks.log(Object.assign({}, res, { status: "REVIEW" })); this.pause(res.reason + " " + HELP.WA_WARNING.fix); continue; }
          hooks.log(res);
          const bad = res.status === "FAILED" || res.status === "REVIEW" || res.status === "UNKNOWN";
          failures = bad ? failures + 1 : res.status === "SENT" ? 0 : failures;
          if (failures >= cfg.maxConsecutiveFailures) {
            failures = 0;
            const h = res.help || HELP.ERROR;
            this.pause(`Paused after ${cfg.maxConsecutiveFailures} problems in a row. Last one (${res.name}): ${h.what} How to fix: ${h.fix} See the Problems tab, then press Resume.`);
            continue;
          }
          if (res.status === "SENT") {
            sent++;
            const lo = Math.max(0, +cfg.gapMinSec || 0), hi = Math.max(lo, +cfg.gapMaxSec || lo);
            await this.wait((lo + Math.random() * (hi - lo)) * 1000);
          } else if (res.status === "TEST") await this.wait(1500);
          else await this.wait(res.status === "SKIPPED" && !headerHasName(res.name) ? 50 : 600);
        }
      } catch (e) {
        if (e === STOP) { this.setState("stopped", "Stopped"); return; }
        this.setState("stopped", "Error: " + (e && e.message ? e.message : e));
      }
    }
  }

  function start(cfg, hooks) {
    if (current && (current.state === "running" || current.state === "paused")) throw new Error("Already running");
    current = new Runner(cfg, hooks);
    current.done = current.run();
    return current;
  }

  // "Check page": what FollowUp can find on this page right now.
  function diagnose(cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const list = findList();
    const rows = list ? getRows(list) : [];
    const composer = findComposer();
    return {
      chatList: !!list,
      rows: rows.length,
      firstRows: rows.slice(0, 5).map((r) => ({ name: r.name, firstName: greetName(r.name, cfg, r.tilde), lastFromMe: r.fromMe, group: r.groupIcon, unsaved: r.unsaved })),
      openChat: header() ? headerLines()[0] || "" : "",
      openIsGroup: headerIsGroup(),
      messageBox: !!composer,
      sendButton: !!sendButtonIn(footer()),
      attach: !!(attachButton() || imageInput()),
      warning: warning(cfg),
      hidden: document.hidden,
    };
  }

  window.WAEngine = {
    DEFAULTS, HELP,
    start,
    status: () => (current ? current.state : "idle"),
    pause: (r) => current && current.pause(r),
    resume: () => current && current.resume(),
    stop: () => current && current.stop(),
    tools: { diagnose, greetName, render, isPhone, getRows: () => { const l = findList(); return l ? getRows(l) : []; } },
  };
})();
