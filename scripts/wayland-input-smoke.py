"""Portuguese GTK input-method regression on a live Wayland/IBus session.

Run with GDK_BACKEND=wayland /usr/bin/python3 scripts/wayland-input-smoke.py.
Requires the Portuguese keyboard layout. Uses a hidden test widget, never sends
desktop key events, changes the keyboard layout, or opens the WhatsApp backend.
"""
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from input_method import Gtk, configure_input_method
from gi.repository import Gdk, GLib


def pump():
    deadline = time.monotonic() + .1
    while time.monotonic() < deadline:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        time.sleep(.005)


Gtk.init()
display = Gdk.Display.get_default()
assert type(display).__name__ == 'GdkWaylandDisplay', 'Run this test on Wayland'
configure_input_method()
window = Gtk.Window()
view = Gtk.TextView()
window.set_child(view)
window.realize()
im = Gtk.IMMulticontext()
committed = []
im.connect('commit', lambda _im, text: committed.append(text))
try:
    im.set_client_widget(view)
    im.focus_in()
    pump()
    assert im.get_context_id() == 'ibus', 'Expected the session IBus input method'
    sequences = [(Gdk.KEY_dead_acute, ord(letter)) for letter in 'aeiou']
    sequences += [(Gdk.KEY_dead_tilde, ord(letter)) for letter in 'ao']
    sequences += [(Gdk.KEY_dead_circumflex, ord(letter)) for letter in 'aeo']
    sequences += [(Gdk.KEY_dead_grave, Gdk.KEY_a), (Gdk.KEY_ccedilla,), (Gdk.KEY_dead_acute, Gdk.KEY_A)]
    for sequence in sequences:
        for symbol in sequence:
            found, entries = display.map_keyval(symbol)
            assert found, f'Key missing from layout: {Gdk.keyval_name(symbol)}'
            key = next(entry for entry in entries if entry.level in (0, 1))
            state = Gdk.ModifierType.SHIFT_MASK if key.level else Gdk.ModifierType(0)
            arguments = (window.get_surface(), display.get_default_seat().get_keyboard(),
                         Gdk.CURRENT_TIME, key.keycode, state, key.group)
            handled = im.filter_key(True, *arguments)
            if not handled:
                code = Gdk.keyval_to_unicode(symbol)
                if code: committed.append(chr(code))
            im.filter_key(False, *arguments)
            pump()
    result = ''.join(committed)
    assert result == 'áéíóúãõâêôàçÁ', repr(result)
    print(f'Wayland + {im.get_context_id()}: {result} — passed')
finally:
    im.focus_out()
    im.set_client_widget(None)
    window.destroy()
