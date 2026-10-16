"""Keyboard shortcut parsing and matching for the desktop app (no real keyboard needed)."""
import types

import pytest

from hotkeys import Hotkeys, describe, parse, token


def key(name=None, vk=None, char=None):
    return types.SimpleNamespace(name=name, vk=vk, char=char)


CTRL, SHIFT, ALT = key("ctrl_l"), key("shift"), key("alt_l")


def test_parse_and_describe():
    assert parse("ctrl+shift+1") == (frozenset({"ctrl", "shift"}), "1")
    assert describe("shift + ctrl + 1") == "Ctrl+Shift+1"
    assert describe("f8") == "F8"
    assert describe("Alt+PgDn") == "Alt+Page Down"
    for bad in ["", "Ctrl+Shift", "Ctrl+1+2", "p", "Ctrl+Banana"]:
        with pytest.raises(ValueError):
            parse(bad)


def test_windows_key_codes_ignore_shift_and_ctrl():
    # On Windows, Shift+1 reports "!" and Ctrl+P a control character; the key code stays the same.
    assert token(key(vk=0x31, char="!")) == "1"
    assert token(key(vk=0x50, char="\x10")) == "p"
    assert token(key(vk=0x21, char="!")) == "1"  # Linux reports the shifted symbol
    assert token(key("f8")) == "f8" and token(CTRL) == "ctrl" and token(key("alt_gr")) == "alt"


def test_shortcuts_fire_once_and_only_on_exact_combo():
    fired = []
    hk = Hotkeys(fired.append)
    errors = hk.set({"toggle_run": "Ctrl+Shift+1", "stop": "Ctrl+Shift+2", "scroll": "F8", "dup": "ctrl+shift+1", "bad": "x"})
    assert set(errors) == {"dup", "bad"}
    one = key(vk=0x31, char="!")
    hk.press(CTRL); hk.press(SHIFT); hk.press(one); hk.press(one)  # held down: auto-repeat must not fire again
    hk.release(one); hk.press(one)
    hk.release(one); hk.release(SHIFT)
    hk.press(one)  # Ctrl+1 alone is not bound
    hk.release(one); hk.release(CTRL)
    hk.press(key("f8")); hk.release(key("f8"))
    hk.press(ALT); hk.press(key("f8"))  # Alt+F8 is a different shortcut
    assert fired == ["toggle_run", "toggle_run", "scroll"]
