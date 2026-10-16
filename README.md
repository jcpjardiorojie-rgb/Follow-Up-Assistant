# FollowUp Assistant

Sends your follow-up message (text, or text + image, with the person's first name) to each chat in your
**Meta Business Suite inbox**, one chat at a time. Chats you can't message, and chats named **"Facebook user"**,
are moved to **Done** automatically.

There are two versions so you can compare them. Both use the same "brain"
([`extension/engine.js`](extension/engine.js)), so they make exactly the same decisions.

| | **Option A: FollowUp Copilot** (Chrome extension) | **Option B: FollowUp Desk** (Windows app) |
|---|---|---|
| Looks like | A side panel next to your normal Business Suite tab | Its own window, plus a Chrome window it controls |
| Install | Load one folder into Chrome (2 minutes) | Install Python once, then `install.bat` |
| Uses | Your normal Chrome and your normal login | A separate Chrome profile (log in once) |
| Clicks & typing | In-page events | Real mouse/keyboard input from Playwright |
| While it runs | **Keep the Business Suite window visible** (not minimized). Chrome slows down hidden tabs. | Keeps running even when the window is behind other windows |
| Shows Meta it's automated? | Less visibly | Chrome shows "controlled by automated test software", and the browser reports it is automated |

![Option A side panel](docs/screenshots/option-a-side-panel.png)

![Option B desktop app](docs/screenshots/option-b-desktop-app.png)

---

## What happens on every chat

```
open the chat ─► is it really this person? ── no ──► mark REVIEW, send nothing
                         │ yes
                         ▼
   "Facebook user"  or  "You are no longer able to send messages…"?
                         │ yes ─► click ✔ Move to done ─► next chat
                         │ no
                         ▼
   customer wrote last? ── yes ─► SKIP (you should answer them yourself; can be turned off)
                         │ no
                         ▼
   scroll to latest ─► put text in (with first name) ─► attach image ─► Send
                         ▼
   check the message really appeared in the chat ─► SENT ─► wait "seconds between chats" ─► next chat
```

Safety rules built into both versions:

* **Never messages the same chat twice** in a campaign, even after a restart, refresh or crash.
* **Never sends if it can't confirm the open chat is the right person.**
* **Never retries an unclear send.** If it isn't sure, it marks UNKNOWN and moves on.
* **Pauses** when Meta shows a warning (blocked, restricted, security check…).
* **Pauses after 3 problems in a row**, which usually means Meta changed the page.
* **Daily limit**, which you set. Seconds between chats is adjustable.

---

## Option A: install the Chrome extension

1. Download this project (green **Code** button → **Download ZIP**) and unzip it.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the **`extension`** folder.
5. Pin the extension (puzzle icon → pin **FollowUp Copilot**).
6. Open Business Suite → **Inbox** and click the extension icon. The side panel opens and connects by itself.
7. (Optional) Paste your inbox link from Chrome's address bar into **Your inbox link**. Then
   **Open my inbox** takes you straight there, and the app refuses to run on a different Facebook Page
   by mistake. The badge at the top says **Ready** when it's connected.

## Option B: install the Windows app

1. Install Python from <https://www.python.org/downloads/windows/>. **Tick "Add python.exe to PATH".**
2. Make sure Google Chrome is installed.
3. In the `desktop` folder, double-click **`install.bat`** (one time only).
4. Double-click **`run.bat`** to start FollowUp Desk.
5. Press **1 Open Chrome**. The first time, log in to Facebook in that Chrome window. It remembers you after that.
6. (Optional) Paste your inbox link under **Message → Your inbox link**. **Open Chrome** then goes straight to it.

(Optional) `build_exe.bat` makes a single `FollowUpDesk.exe`.

---

## Your first run (do this with either version)

1. Write your message. Click **+ First name** to add `{first_name}`. Choose an image if you want one.
2. Open the Business Suite **Inbox**, open any chat, and press **Check page**. Every line should say **✓ found**.
   If something says **✗ not found**, send me a screenshot of that line.
3. Turn on **Test mode** in Settings and press **Start**. It fills in the message and image on a few chats but
   **never presses Send or Done**. Watch that the right first name and image appear.
4. Turn Test mode off, set the **Daily limit to about 20**, and press **Start** for a real run.
5. When that works, raise the limit.

**To send from the bottom of the inbox going up:** in Settings choose **Start from: Bottom**.
When you press Start, the app first scrolls the inbox all the way down until no older chats load
(you'll see "Scrolling to the bottom of the inbox first… (N chats)"). Then it messages the bottom chat
first and works upward to the top. Chats you message jump to the top of Business Suite's list, and the
app remembers them, so they're never messaged twice. Stop and Pause work while it scrolls.

**To start from a chat you choose:** scroll the inbox so that chat is the lowest one you can see, then use
**Start from: Lowest chat on screen now (no scrolling)**. It starts there and goes up; chats below it are left alone.

**Moving to Done is always on** for "Facebook user" chats and chats showing "You are no longer able to send
messages…" (except in Test mode). Chats you message are moved too only if you tick "Move chats to Done after sending".

**Scroll inbox to the bottom** (the separate button) can also be paused: press it once to start, again to
**Pause scrolling**, again to **Resume scrolling**. **Stop** ends it.

![Scroll paused](docs/screenshots/option-a-scroll-paused.png)

### Keyboard shortcuts (and mouse buttons)

| Keys | What it does |
|---|---|
| **Ctrl+Shift+1** | Start sending → Pause → Resume (one key does all three) |
| **Ctrl+Shift+2** | Stop (sending, or scrolling) |
| **Ctrl+Shift+3** | Scroll inbox to the bottom → Pause → Resume |
| **Ctrl+Shift+4** | Scroll the open chat to the latest message |

**To use mouse buttons:** in your mouse software (Logitech G HUB, Razer Synapse, Bloody, A4Tech and so on),
set a button to press one of these key combinations, the same way you set up your current macro. It's best
to set it on a button that isn't "Back", because Chrome also uses Back to leave the page.

* **Option A (extension):** the keys work while Chrome is the active window. To make them work **from any
  window**, click **Change keys** in the side panel (or open `chrome://extensions/shortcuts`) and switch
  each one from "In Chrome" to **Global**. You can also pick different keys there. A small green note
  appears at the bottom of the Business Suite page each time a shortcut is used.
* **Option B (desktop app):** the keys work from **any window** already. Change them under
  **Settings → Keyboard shortcuts** (type e.g. `Ctrl+Alt+S` or `F8`), then press **Apply shortcuts**.

If you install both versions, give them different keys so one key press doesn't control both.

![Option A shortcuts](docs/screenshots/option-a-shortcuts.png)

### Settings, in plain words

| Setting | What it does |
|---|---|
| Seconds between chats | Pause after each sent message |
| Wait after opening a chat | Time for the chat to load before reading it. Raise it if your internet is slow. |
| Daily limit | Stops after this many sends today |
| Start from | **Top**: newest first. **Bottom**: scrolls down to the oldest chat automatically, then goes up. **Lowest chat on screen**: starts at the bottom chat you can see right now (no scrolling down), goes up, and leaves the chats below it alone |
| Only follow up when the last message is mine | Skips people who replied to you, so you can answer them personally |
| Move chats to Done after sending | Also moves successfully messaged chats to Done |
| Don't send if the image fails to attach | Skips that chat instead of sending text only |
| Test mode | Does everything except pressing Send / Done |
| Advanced | The exact words it looks for, in case Meta changes them or your Business Suite is in another language |

**New campaign** makes the app forget who it already messaged. Use it when you start a new follow-up message.

---

## Please read: limits and risks

* **Tested on a practice copy of Business Suite, not on your real account.** I can't log in to your Facebook,
  so I built [`tests/mock_inbox.html`](tests/mock_inbox.html) from your screenshots. Meta's real page may label
  buttons differently. **Check page** and **Test mode** are there so you can confirm it on the real inbox before
  anything is sent.
* **It is not undetectable.** Every message goes through Meta's servers, whichever version you use. Neither version
  hides that it's automated. Meta mostly reacts to *volume* and to *recipients blocking or reporting* you. 2,000
  messages a day is high; if Meta shows a warning, the app pauses. Don't push past it.
* **Meta's reply window can't be bypassed.** Chats showing "You are no longer able to send messages…" are closed
  by Meta. The app moves them to Done and continues.
* When Meta redesigns the inbox, the app may stop finding a button. It will pause and tell you which part is
  missing, and the words under **Advanced** can usually fix it.

---

## For developers

```
extension/        Option A: Manifest V3 extension (engine.js, content.js, side panel)
desktop/          Option B: tkinter window (followup_desk.py), Playwright controller (bridge.py), shortcuts (hotkeys.py)
tests/            practice inbox + 22 automated tests (engine, extension, desktop controller, desktop window, shortcuts)
```

Run the tests (Python 3.10+):

```
pip install playwright==1.56.0 pytest pillow pynput
python -m playwright install chromium
python -m pytest tests            # on Linux, run the window test with: xvfb-run python -m pytest tests
```
