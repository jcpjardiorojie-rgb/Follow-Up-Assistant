"""FollowUp Desk (Option B): a Windows app that runs your follow-ups in its own Chrome window.

Start it with run.bat (or: python followup_desk.py).
"""
import os
import queue
import subprocess
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from bridge import DEFAULT_SETTINGS, Controller, Store

C = {"bg": "#f4f6f4", "surface": "#ffffff", "line": "#d3dad5", "fg": "#18211d", "muted": "#56635c",
     "accent": "#0e6b58", "accent_soft": "#d6ede6", "good": "#1f7a3e", "good_soft": "#ddf1e3",
     "warn": "#9a6212", "warn_soft": "#f7e9cf", "bad": "#a83636", "bad_soft": "#f6dcdc"}
FONT = "Segoe UI" if sys.platform == "win32" else "DejaVu Sans"
STATE_LOOK = {"idle": ("Idle", C["line"], C["fg"]), "running": ("Running", C["good_soft"], C["good"]),
              "paused": ("Paused", C["warn_soft"], C["warn"]), "stopped": ("Stopped", C["accent_soft"], C["accent"]),
              "finished": ("Finished", C["accent_soft"], C["accent"]), "error": ("Problem", C["bad_soft"], C["bad"])}


def first_name(name, s):
    n = " ".join(name.split())
    if not n or n.lower() in [x.lower() for x in s["excludeNames"]]:
        return s["fallbackName"]
    for tok in n.split(" "):
        w = "".join(ch for ch in tok if ch.isalpha() or ch in "'-").strip("'-")
        if len(w) < 2:
            continue
        if w == w.upper() or w == w.lower():
            w = w[0].upper() + w[1:].lower()
        return w
    return s["fallbackName"]


class App:
    def __init__(self, root, store=None):
        self.root = root
        self.store = store or Store()
        self.s = self.store.settings
        self.events = queue.Queue()
        self.ctl = Controller(self.store, lambda kind, data: self.events.put((kind, data)))
        self.state = "idle"
        self.thumb = None
        root.title("FollowUp Desk")
        root.geometry("1180x720")
        root.minsize(1000, 640)
        root.configure(bg=C["bg"])
        self._style()
        self._build()
        self._load_log()
        self._set_state({"state": "idle", "reason": "Step 1: press “Open Chrome” and log in to Business Suite (first time only)."})
        root.protocol("WM_DELETE_WINDOW", self._quit)
        root.after(150, self._poll)

    # ---------- look ----------
    def _style(self):
        st = ttk.Style()
        st.theme_use("clam")
        st.configure(".", background=C["bg"], foreground=C["fg"], font=(FONT, 10))
        st.configure("Card.TFrame", background=C["surface"])
        st.configure("Card.TLabel", background=C["surface"])
        st.configure("Muted.TLabel", background=C["surface"], foreground=C["muted"], font=(FONT, 9))
        st.configure("H.TLabel", background=C["surface"], font=(FONT, 11, "bold"))
        st.configure("Title.TLabel", background=C["accent"], foreground="#ffffff", font=(FONT, 15, "bold"))
        st.configure("Sub.TLabel", background=C["accent"], foreground="#d6ede6", font=(FONT, 9))
        st.configure("TButton", padding=(10, 5), background=C["surface"], bordercolor=C["line"])
        st.map("TButton", background=[("active", C["accent_soft"]), ("disabled", C["bg"])])
        st.configure("Primary.TButton", background=C["accent"], foreground="#ffffff", font=(FONT, 10, "bold"))
        st.map("Primary.TButton", background=[("active", "#0b5848"), ("disabled", "#8fb8ad")])
        st.configure("Danger.TButton", foreground=C["bad"])
        st.configure("Card.TCheckbutton", background=C["surface"])
        st.configure("Test.TCheckbutton", background=C["warn_soft"])
        st.configure("Treeview", rowheight=24, fieldbackground=C["surface"], background=C["surface"])
        st.configure("Treeview.Heading", font=(FONT, 9, "bold"))
        st.configure("TNotebook", background=C["bg"], borderwidth=0)
        st.configure("TNotebook.Tab", padding=(10, 5), font=(FONT, 10))
        st.map("TNotebook.Tab", background=[("selected", C["surface"])])

    def _card(self, parent, title=None, hint=None):
        f = ttk.Frame(parent, style="Card.TFrame", padding=12)
        if title:
            row = ttk.Frame(f, style="Card.TFrame")
            row.pack(fill="x", pady=(0, 6))
            ttk.Label(row, text=title, style="H.TLabel").pack(side="left")
            if hint:
                ttk.Label(row, text=hint, style="Muted.TLabel").pack(side="left", padx=8)
        return f

    # ---------- layout ----------
    def _build(self):
        top = tk.Frame(self.root, bg=C["accent"], padx=16, pady=10)
        top.pack(fill="x")
        left = tk.Frame(top, bg=C["accent"])
        left.pack(side="left")
        ttk.Label(left, text="FollowUp Desk", style="Title.TLabel").pack(anchor="w")
        ttk.Label(left, text="Option B · runs in its own Chrome window", style="Sub.TLabel").pack(anchor="w")
        self.pill = tk.Label(top, text="Idle", font=(FONT, 10, "bold"), padx=12, pady=3)
        self.pill.pack(side="right")

        bar = ttk.Frame(self.root, padding=(16, 10, 16, 0))
        bar.pack(fill="x")
        self.b_open = ttk.Button(bar, text="1  Open Chrome", command=self._open)
        self.b_check = ttk.Button(bar, text="Check page", command=self._check)
        self.b_start = ttk.Button(bar, text="▶  Start", style="Primary.TButton", command=self._start)
        self.b_pause = ttk.Button(bar, text="Pause", command=self._pause)
        self.b_stop = ttk.Button(bar, text="Stop", style="Danger.TButton", command=self._stop)
        self.b_load = ttk.Button(bar, text="Scroll inbox to bottom", command=self._load_inbox)
        self.b_latest = ttk.Button(bar, text="Scroll chat to latest", command=self._latest)
        for b in (self.b_open, self.b_check, self.b_load, self.b_latest):
            b.pack(side="left", padx=(0, 6))
        for b in (self.b_stop, self.b_pause, self.b_start):
            b.pack(side="right", padx=(6, 0))
        self.reason = ttk.Label(self.root, text="", padding=(16, 6, 16, 0), foreground=C["fg"], font=(FONT, 10), wraplength=1100)
        self.reason.pack(fill="x")
        self.current = ttk.Label(self.root, text="", padding=(16, 0, 16, 4), foreground=C["muted"])
        self.current.pack(fill="x")

        body = ttk.Frame(self.root, padding=(16, 4, 16, 16))
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=0, minsize=430)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)
        tabs = ttk.Notebook(body)
        tabs.grid(row=0, column=0, sticky="nsew", padx=(0, 12))
        rcol = ttk.Frame(body)
        rcol.grid(row=0, column=1, sticky="nsew")
        msg_tab, set_tab = ttk.Frame(tabs, style="Card.TFrame"), ttk.Frame(tabs, style="Card.TFrame")
        tabs.add(msg_tab, text="  Message  ")
        tabs.add(set_tab, text="  Settings  ")
        self._build_message(msg_tab)
        self._build_settings(set_tab)
        self._build_activity(rcol)

    def _build_message(self, parent):
        card = self._card(parent, "Follow-up message")
        card.pack(fill="both", expand=True)
        self.t_text = tk.Text(card, height=7, width=50, wrap="word", font=(FONT, 10), relief="solid", bd=1,
                              highlightthickness=0, padx=6, pady=6)
        self.t_text.insert("1.0", self.s["template"])
        self.t_text.pack(fill="x")
        self.t_text.bind("<<Modified>>", self._on_text)
        row = ttk.Frame(card, style="Card.TFrame")
        row.pack(fill="x", pady=6)
        ttk.Button(row, text="+ First name", command=lambda: (self.t_text.insert("insert", "{first_name}"), self._on_text())).pack(side="left")
        ttk.Label(row, text=f"{{first_name}} → their first name, or “{self.s['fallbackName']}”", style="Muted.TLabel").pack(side="left", padx=8)
        self.preview = tk.Label(card, text="", bg=C["bg"], fg=C["fg"], justify="left", anchor="w", wraplength=380,
                                font=(FONT, 10), padx=8, pady=6)
        self.preview.pack(fill="x")
        img = ttk.Frame(card, style="Card.TFrame")
        img.pack(fill="x", pady=(8, 0))
        self.thumb_lbl = tk.Label(img, text="No image", bg=C["bg"], fg=C["muted"], width=12, height=3)
        self.thumb_lbl.pack(side="left")
        side = ttk.Frame(img, style="Card.TFrame")
        side.pack(side="left", padx=10, fill="x", expand=True)
        b = ttk.Frame(side, style="Card.TFrame")
        b.pack(anchor="w")
        ttk.Button(b, text="Choose image…", command=self._pick_image).pack(side="left")
        ttk.Button(b, text="Remove", command=self._remove_image).pack(side="left", padx=6)
        self.img_name = ttk.Label(side, text="", style="Muted.TLabel", wraplength=260)
        self.img_name.pack(anchor="w", pady=4)
        self._show_image()
        self._on_text()

    def _build_settings(self, parent):
        card = self._card(parent, "Settings", "applied when you press Start")
        card.pack(fill="both", expand=True)
        g = ttk.Frame(card, style="Card.TFrame")
        g.pack(fill="x")
        self.v_between = tk.DoubleVar(value=self.s["betweenChatsSec"])
        self.v_step = tk.DoubleVar(value=self.s["stepDelayMs"] / 1000)
        self.v_cap = tk.IntVar(value=self.s["dailyCap"])
        self.v_order = tk.StringVar(value="Top (newest first)" if self.s["order"] == "top" else "Bottom (scrolls down first, then goes up)")
        fields = [("Seconds between chats", ttk.Spinbox(g, from_=0, to=600, increment=1, textvariable=self.v_between, width=8)),
                  ("Wait after opening a chat (sec)", ttk.Spinbox(g, from_=0.3, to=20, increment=0.1, textvariable=self.v_step, width=8)),
                  ("Daily limit", ttk.Spinbox(g, from_=1, to=100000, increment=50, textvariable=self.v_cap, width=8)),
                  ("Start from", ttk.Combobox(g, textvariable=self.v_order, state="readonly", width=38,
                                              values=["Top (newest first)", "Bottom (scrolls down first, then goes up)"]))]
        for i, (label, w) in enumerate(fields):
            ttk.Label(g, text=label, style="Card.TLabel").grid(row=i, column=0, sticky="w", pady=2)
            w.grid(row=i, column=1, sticky="w", padx=8, pady=2)
        self.v_last = tk.BooleanVar(value=self.s["onlyIfLastFromMe"])
        self.v_sdone = tk.BooleanVar(value=self.s["moveSentToDone"])
        self.v_imgreq = tk.BooleanVar(value=self.s["imageRequired"])
        self.v_test = tk.BooleanVar(value=self.s["testMode"])
        for var, text, style in [(self.v_last, "Only follow up when the last message is mine (skip customers who replied)", "Card.TCheckbutton"),
                                 (self.v_sdone, "Move chats to Done after sending", "Card.TCheckbutton"),
                                 (self.v_imgreq, "Don't send if the image fails to attach", "Card.TCheckbutton"),
                                 (self.v_test, "Test mode: fill the message box, but never press Send or Done", "Test.TCheckbutton")]:
            ttk.Checkbutton(card, text=text, variable=var, style=style).pack(anchor="w", pady=3)
        ttk.Button(card, text="Advanced: words the app looks for…", command=self._advanced).pack(anchor="w", pady=(6, 0))

    def _build_activity(self, parent):
        counts = ttk.Frame(parent)
        counts.pack(fill="x", pady=(0, 10))
        self.count_lbls = {}
        for key, label in [("sent", "Sent today"), ("excluded", "Moved to Done"), ("skipped", "Skipped"), ("problems", "Problems")]:
            box = ttk.Frame(counts, style="Card.TFrame", padding=(12, 8))
            box.pack(side="left", fill="x", expand=True, padx=(0, 0 if key == "problems" else 8))
            num = tk.Label(box, text="0", bg=C["surface"], fg=C["fg"], font=(FONT, 20, "bold"))
            num.pack(anchor="w")
            sub = ttk.Label(box, text=label, style="Muted.TLabel")
            sub.pack(anchor="w")
            self.count_lbls[key] = (num, sub)
        card = self._card(parent, "Activity")
        card.pack(fill="both", expand=True)
        cols = ("time", "name", "status", "reason")
        frame = ttk.Frame(card, style="Card.TFrame")
        frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(frame, columns=cols, show="headings")
        for col, w, text in [("time", 72, "Time"), ("name", 150, "Name"), ("status", 80, "Result"), ("reason", 300, "Details")]:
            self.tree.heading(col, text=text)
            self.tree.column(col, width=w, stretch=(col == "reason"))
        sb = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        for tag, bg in [("SENT", C["good_soft"]), ("EXCLUDED", C["accent_soft"]), ("FAILED", C["bad_soft"]),
                        ("REVIEW", C["bad_soft"]), ("UNKNOWN", C["bad_soft"]), ("TEST", C["warn_soft"])]:
            self.tree.tag_configure(tag, background=bg)
        foot = ttk.Frame(card, style="Card.TFrame")
        foot.pack(fill="x", pady=(8, 0))
        ttk.Button(foot, text="Open log folder", command=self._open_folder).pack(side="right")
        ttk.Button(foot, text="New campaign", command=self._new_campaign).pack(side="right", padx=6)
        self.remembered = ttk.Label(foot, text="", style="Muted.TLabel")
        self.remembered.pack(side="left", fill="x", expand=True)
        self._show_stats(self.store.stats())

    # ---------- message & image ----------
    def _on_text(self, _event=None):
        self.t_text.edit_modified(False)
        text = self.t_text.get("1.0", "end-1c")
        self.s["template"] = text
        shown = text.replace("{first_name}", first_name("Lista Maison", self.s)).replace("{name}", "Lista Maison")
        self.preview.config(text="Preview for Lista Maison:\n" + (shown or "—"))

    def _pick_image(self):
        path = filedialog.askopenfilename(title="Choose the image to send",
                                          filetypes=[("Images", "*.jpg *.jpeg *.png *.gif *.webp"), ("All files", "*.*")])
        if path:
            self.s["image_path"] = path
            self.store.save_settings()
            self._show_image()

    def _remove_image(self):
        self.s["image_path"] = ""
        self.store.save_settings()
        self._show_image()

    def _show_image(self):
        path = self.s.get("image_path") or ""
        self.thumb = None
        if path and os.path.exists(path):
            try:
                from PIL import Image, ImageTk  # optional: nicer thumbnails for JPG
                im = Image.open(path)
                im.thumbnail((110, 80))
                self.thumb = ImageTk.PhotoImage(im)
            except Exception:
                try:
                    im = tk.PhotoImage(file=path)
                    factor = max(1, im.width() // 110, im.height() // 80)
                    self.thumb = im.subsample(factor)
                except Exception:
                    self.thumb = None
            self.thumb_lbl.config(image=self.thumb or "", text="" if self.thumb else "Image\nselected", width=0 if self.thumb else 12, height=0 if self.thumb else 4)
            self.img_name.config(text=os.path.basename(path))
        else:
            self.thumb_lbl.config(image="", text="No image", width=12, height=4)
            self.img_name.config(text="Text only. Add an image to send it with every message." if not path else "Image file not found: " + path)

    # ---------- settings ----------
    def _read_settings(self):
        s = self.s
        try:
            s["betweenChatsSec"] = max(0.0, float(self.v_between.get()))
            s["stepDelayMs"] = int(max(0.3, float(self.v_step.get())) * 1000)
            s["dailyCap"] = max(1, int(self.v_cap.get()))
        except (tk.TclError, ValueError):
            raise RuntimeError("Check the numbers in Settings.")
        s["order"] = "top" if self.v_order.get().startswith("Top") else "bottom"
        s["onlyIfLastFromMe"] = self.v_last.get()
        s["moveSentToDone"] = self.v_sdone.get()
        s["imageRequired"] = self.v_imgreq.get()
        s["testMode"] = self.v_test.get()
        self.store.save_settings()
        self._show_stats(self.store.stats())

    def _advanced(self):
        win = tk.Toplevel(self.root)
        win.title("Words the app looks for")
        win.configure(bg=C["surface"], padx=14, pady=14)
        boxes = {}
        for key, label in [("blockedTexts", "“Can't message” banner text (one per line)"),
                           ("excludeNames", "Names that go straight to Done (one per line)"),
                           ("stopTexts", "Meta warnings that pause the run (one per line)")]:
            ttk.Label(win, text=label, style="Card.TLabel").pack(anchor="w", pady=(6, 2))
            t = tk.Text(win, height=4 if key == "stopTexts" else 2, width=70, relief="solid", bd=1, font=(FONT, 10))
            t.insert("1.0", "\n".join(self.s[key]))
            t.pack(fill="x")
            boxes[key] = t

        def save():
            for key, t in boxes.items():
                self.s[key] = [ln.strip() for ln in t.get("1.0", "end").splitlines() if ln.strip()]
            self.store.save_settings()
            win.destroy()

        def reset():
            for key, t in boxes.items():
                t.delete("1.0", "end")
                t.insert("1.0", "\n".join(DEFAULT_SETTINGS[key]))
        row = ttk.Frame(win, style="Card.TFrame")
        row.pack(fill="x", pady=(10, 0))
        ttk.Button(row, text="Save", style="Primary.TButton", command=save).pack(side="right")
        ttk.Button(row, text="Reset to defaults", command=reset).pack(side="right", padx=6)

    # ---------- buttons ----------
    def _call(self, fut, done=None, label=""):
        def cb(f):
            err = f.exception()
            self.events.put(("result", (label, err, None if err else f.result(), done)))
        fut.add_done_callback(cb)

    def _open(self):
        self.reason.config(text="Opening Chrome… If you see a login page, log in to Facebook once. This window remembers you after that.")
        self._call(self.ctl.open_browser(), label="open")

    def _start(self):
        try:
            self._read_settings()
        except RuntimeError as e:
            messagebox.showwarning("FollowUp Desk", str(e))
            return
        if not self.s["template"].strip():
            messagebox.showwarning("FollowUp Desk", "Write your follow-up message first.")
            return
        self._call(self.ctl.start(), label="start")

    def _pause(self):
        self._call(self.ctl.resume() if self.state == "paused" else self.ctl.pause(), label="pause")

    def _stop(self):
        self._call(self.ctl.stop(), label="stop")

    def _check(self):
        self._call(self.ctl.diagnose(), done=self._show_report, label="check")

    def _load_inbox(self):
        self.reason.config(text="Scrolling the inbox to the bottom… (this can take a few minutes for months of chats)")
        self._call(self.ctl.load_inbox(), done=lambda r: self.reason.config(text=f"{r['message']} — {r.get('rows', 0)} chats loaded."), label="load")

    def _latest(self):
        self._call(self.ctl.scroll_latest(), done=lambda r: self.reason.config(text=r["message"]), label="latest")

    def _show_report(self, d):
        yes = lambda b: "✓ found" if b else "✗ not found"
        lines = [f"Inbox list:  {yes(d['inboxList'])} ({d['rows']} chats visible)"]
        lines += [f"    • {r['name']}  →  “{r['firstName']}”" + ("" if r["lastFromMe"] else "   (customer wrote last)") for r in d["firstRows"]]
        lines += [f"Open chat:  {'id ' + d['threadId'] if d['threadId'] else 'none selected'}",
                  f"Message box:  {yes(d['messageBox'])}",
                  f"Send button:  {yes(d['sendButton'])}" + (" (will press Enter instead)" if d["messageBox"] and not d["sendButton"] else ""),
                  f"Done (✔) button:  {yes(d['doneButton'])}",
                  f"Image upload:  {yes(d['fileInput'])}",
                  f"“Can't message” banner:  {'shown on this chat' if d['cantMessageBanner'] else 'not shown'}",
                  f"Meta warning:  {d['warning'] or 'none'}"]
        messagebox.showinfo("What the app can see", "\n".join(lines))

    def _new_campaign(self):
        if messagebox.askyesno("New campaign", "Start a new campaign?\n\nThe app forgets who it already messaged, so everyone becomes eligible again."):
            self.store.new_campaign()
            self._show_stats(self.store.stats())

    def _open_folder(self):
        path = str(self.store.dir)
        if sys.platform == "win32":
            os.startfile(path)  # noqa: S606 - opens Explorer on our own data folder
        else:
            subprocess.Popen(["xdg-open", path])

    def _quit(self):
        if self.state in ("running", "paused") and not messagebox.askyesno("Quit", "A run is in progress. Stop it and quit?"):
            return
        self._read_settings_quietly()
        self.ctl.close()
        self.root.destroy()

    def _read_settings_quietly(self):
        try:
            self._read_settings()
        except RuntimeError:
            pass

    # ---------- updates from the Playwright thread ----------
    def _poll(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == "state":
                    self._set_state(data)
                elif kind == "log":
                    self._add_log(data)
                elif kind == "stats":
                    self._show_stats(data)
                elif kind == "browser":
                    if data == "open":
                        self.reason.config(text="Chrome is open. Log in if asked, go to Inbox, then press Start. Tip: try Test mode first.")
                    else:
                        self._set_state({"state": "idle", "reason": "Chrome was closed. Press “Open Chrome” to continue."})
                elif kind == "result":
                    label, err, value, done = data
                    if err:
                        self._set_state({"state": "error" if self.state not in ("running", "paused") else self.state, "reason": str(err)})
                    elif done:
                        done(value)
        except queue.Empty:
            pass
        self.root.after(150, self._poll)

    def _set_state(self, st):
        s = st.get("state", "idle")
        if s in STATE_LOOK:
            self.state = s if s != "error" else "idle"
            text, bg, fg = STATE_LOOK[s]
            self.pill.config(text=text, bg=bg, fg=fg)
        if st.get("reason") or s != "running":
            self.reason.config(text=st.get("reason") or "")
        if s == "running" and st.get("current"):
            self.current.config(text="Now: " + st["current"])
        elif s != "running":
            self.current.config(text="")
        busy = self.state in ("running", "paused")
        self.b_start.state(["disabled"] if busy else ["!disabled"])
        self.b_pause.state(["!disabled"] if busy else ["disabled"])
        self.b_stop.state(["!disabled"] if busy else ["disabled"])
        self.b_pause.config(text="Resume" if self.state == "paused" else "Pause")
        for b in (self.b_load, self.b_latest, self.b_check):
            b.state(["disabled"] if busy else ["!disabled"])

    def _add_log(self, e):
        t = (e.get("time") or "")[11:19]
        status = e.get("status", "")
        shown = "DONE" if status == "EXCLUDED" else status
        self.tree.insert("", 0, values=(t, e.get("name", ""), shown, e.get("reason", "")), tags=(status,))
        kids = self.tree.get_children()
        for k in kids[500:]:
            self.tree.delete(k)

    def _load_log(self):
        for row in self.store.recent_log(300):
            self._add_log(row)

    def _show_stats(self, st):
        vals = {"sent": st.get("sent", 0), "excluded": st.get("excluded", 0), "skipped": st.get("skipped", 0),
                "problems": st.get("failed", 0) + st.get("unknown", 0)}
        for k, (num, sub) in self.count_lbls.items():
            num.config(text=str(vals[k]), fg=C["bad"] if k == "problems" and vals[k] else C["fg"])
        self.count_lbls["sent"][1].config(text=f"Sent today · limit {self.s['dailyCap']}")
        self.remembered.config(text=f"{len(self.store.campaign['doneIds'])} chats remembered")


def main():
    root = tk.Tk()
    try:
        root.tk.call("tk", "scaling", root.winfo_fpixels("1i") / 72)
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
