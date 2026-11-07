"""Use the session's IBus service when GTK's Wayland default loses dead keys."""
import os

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk


def configure_input_method():
    # Keep explicit input-method choices and non-IBus sessions unchanged.
    # This GtkSettings override applies only to QuietChat, including search/dialogs.
    settings = Gtk.Settings.get_default()
    if os.environ.get('GTK_IM_MODULE') or os.environ.get('XMODIFIERS') != '@im=ibus':
        return
    if settings.get_property('gtk-im-module'):
        return
    if Gtk.IMMulticontext().get_context_id() == 'wayland':
        settings.set_property('gtk-im-module', 'ibus')
