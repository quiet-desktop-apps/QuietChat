"""Small native terminal host: preserves Shift+Enter before terminal encoding."""
import os
from pathlib import Path
import re
import signal
import sys
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("Vte", "2.91")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango, Vte

APP_ID = "ch.aboimpinto.QuietChat"
PROJECT = Path(__file__).resolve().parents[1]


class QuietChatWindow(Gtk.Application):
    def __init__(self, arguments):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.arguments = arguments
        self.pid = None
        self.closing = False

    def do_activate(self):
        window = Gtk.ApplicationWindow(application=self, title="QuietChat")
        window.set_default_size(1120, 760)
        window.set_icon_from_file(str(PROJECT / "assets" / f"{APP_ID}.svg"))
        window.connect("delete-event", self.close_window)
        self.terminal = Vte.Terminal()
        self.terminal.set_font(Pango.FontDescription("Monospace 11"))
        self.terminal.set_scrollback_lines(0)
        foreground, background = Gdk.RGBA(), Gdk.RGBA()
        foreground.parse("#e3eee9")
        background.parse("#15232f")
        self.terminal.set_colors(foreground, background, [])
        self.terminal.connect("key-press-event", self.key_pressed)
        self.terminal.connect("child-exited", self.child_exited)
        window.add(self.terminal)
        window.show_all()
        self.terminal.grab_focus()
        self.terminal.spawn_async(
            Vte.PtyFlags.DEFAULT, str(PROJECT), [str(PROJECT / "run.sh"), *self.arguments],
            None, GLib.SpawnFlags.DEFAULT, None, None, -1, None, self.spawned, None,
        )

    def key_pressed(self, terminal, event):
        modifiers = event.state & Gtk.accelerator_get_default_mod_mask()
        shift = Gdk.ModifierType.SHIFT_MASK
        control = Gdk.ModifierType.CONTROL_MASK
        if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and modifiers == shift:
            # LF stays distinct from the CR emitted by ordinary Return.
            terminal.feed_child(b"\n")
            return True
        if modifiers == (control | shift) and event.keyval in (Gdk.KEY_C, Gdk.KEY_c):
            terminal.copy_clipboard_format(Vte.Format.TEXT)
            return True
        if (modifiers == (control | shift) and event.keyval in (Gdk.KEY_V, Gdk.KEY_v)) or (modifiers == shift and event.keyval == Gdk.KEY_Insert):
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).request_text(self.paste_text, None)
            return True
        return False

    def paste_text(self, _clipboard, text, _data):
        if text and not self.closing:
            # A pasted line break must never become an Enter-to-send action.
            text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
            self.terminal.feed_child(re.sub(r"[\x00-\x09\x0b-\x1f\x7f]", "", text).encode("utf-8"))

    def spawned(self, _terminal, pid, error, _data=None):
        if error:
            self.terminal.feed(f"\r\nCould not start QuietChat: {error.message}\r\n".encode())
            return
        self.pid = pid
        if self.closing:
            self.stop_child()

    def stop_child(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def close_window(self, _window, _event):
        self.closing = True
        self.stop_child()
        return False

    def child_exited(self, terminal, status):
        self.pid = None
        if status == 0 or self.closing:
            self.quit()
        else:
            terminal.feed(b"\r\nQuietChat stopped. Review the error above, then close this window.\r\n")


if __name__ == "__main__":
    GLib.set_prgname(APP_ID)
    GLib.set_application_name("QuietChat")
    app = QuietChatWindow(sys.argv[1:])
    raise SystemExit(app.run([sys.argv[0]]))
