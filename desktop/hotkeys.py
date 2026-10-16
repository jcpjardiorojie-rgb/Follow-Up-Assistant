"""Global keyboard shortcuts for FollowUp Desk. They work in any window, so a
programmable mouse button that presses the same keys works too.

Shortcuts are written like "Ctrl+Shift+1", "Alt+P" or "F8".
Keys are matched by their key code, so Shift or Ctrl don't change what "1" means.
"""
import threading

MODIFIERS = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "win": "Win"}
NAMED = {"space", "enter", "tab", "esc", "pause", "insert", "delete", "home", "end", "page_up", "page_down",
         "up", "down", "left", "right"}
# Shift+digit on a US keyboard, for systems that report the symbol instead of the key code.
SHIFTED = dict(zip("!@#$%^&*()", "1234567890"))
ALIASES = {"control": "ctrl", "cmd": "win", "windows": "win", "escape": "esc", "return": "enter",
           "pgup": "page_up", "pgdn": "page_down", "del": "delete", "ins": "insert"}


def parse(spec):
    """'Ctrl+Shift+1' -> (frozenset({'ctrl','shift'}), '1'). Raises ValueError if it isn't a usable shortcut."""
    parts = [p.strip().lower().replace(" ", "_") for p in str(spec).split("+") if p.strip()]
    if not parts:
        raise ValueError("empty shortcut")
    parts = [ALIASES.get(p, p) for p in parts]
    mods, keys = set(), []
    for p in parts:
        (mods.add if p in MODIFIERS else keys.append)(p)
    if len(keys) != 1:
        raise ValueError(f'"{spec}" needs exactly one key besides Ctrl/Shift/Alt/Win')
    key = keys[0]
    is_f = key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24
    if not (is_f or key in NAMED or (len(key) == 1 and key.isalnum())):
        raise ValueError(f'"{spec}": unknown key "{key}"')
    if not mods and not is_f and key not in ("pause",):
        raise ValueError(f'"{spec}" would fire while typing. Add Ctrl, Alt or Shift, or use an F-key.')
    return frozenset(mods), key


def describe(spec):
    mods, key = parse(spec)
    order = [MODIFIERS[m] for m in ("ctrl", "alt", "shift", "win") if m in mods]
    return "+".join(order + [key.upper() if len(key) <= 3 else key.replace("_", " ").title()])


def token(key):
    """A pynput key -> our name for it ('ctrl', '1', 'f8', …), or None."""
    name = getattr(key, "name", None)  # pynput.keyboard.Key members
    if name:
        for prefix, mod in (("ctrl", "ctrl"), ("shift", "shift"), ("alt", "alt"), ("cmd", "win")):
            if name.startswith(prefix):
                return mod
        return name
    vk = getattr(key, "vk", None)
    if vk is not None:
        if 0x30 <= vk <= 0x39 or 0x41 <= vk <= 0x5A:  # Windows: digits and letters by key code
            return chr(vk).lower()
    char = getattr(key, "char", None)
    if char and char.isprintable():
        return SHIFTED.get(char, char.lower())
    return None


class Hotkeys:
    """Calls on_action(action) when a bound shortcut is pressed (from a background thread)."""

    def __init__(self, on_action):
        self.on_action = on_action
        self.table = {}
        self.mods = set()
        self.held = set()
        self.listener = None
        self.error = None
        self.lock = threading.Lock()

    def set(self, bindings):
        """bindings: {action: 'Ctrl+Shift+1'}. Returns {action: error text} for shortcuts that can't be used."""
        table, errors = {}, {}
        for action, spec in bindings.items():
            if not str(spec).strip():
                continue
            try:
                combo = parse(spec)
            except ValueError as e:
                errors[action] = str(e)
                continue
            if combo in table:
                errors[action] = f'"{spec}" is already used for another action'
                continue
            table[combo] = action
        with self.lock:
            self.table = table
        return errors

    def start(self):
        if self.listener:
            return True
        try:
            from pynput import keyboard
            self.listener = keyboard.Listener(on_press=self.press, on_release=self.release, daemon=True)
            self.listener.start()
            return True
        except Exception as e:  # pynput missing, or no desktop session
            self.error = f"Keyboard shortcuts are unavailable: {e}"
            self.listener = None
            return False

    def stop(self):
        if self.listener:
            self.listener.stop()
            self.listener = None

    def press(self, key):
        t = token(key)
        if t is None:
            return
        if t in MODIFIERS:
            self.mods.add(t)
            return
        if t in self.held:  # key auto-repeat while held down
            return
        self.held.add(t)
        with self.lock:
            action = self.table.get((frozenset(self.mods), t))
        if action:
            self.on_action(action)

    def release(self, key):
        t = token(key)
        self.mods.discard(t)
        self.held.discard(t)
