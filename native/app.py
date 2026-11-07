"""QuietChat GTK4 frontend. The existing Node process owns WhatsApp and SQLite."""
import argparse
import collections
import gc
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from urllib.parse import urlparse

os.environ.setdefault('GSK_RENDERER', 'cairo')
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gtk, Gdk, Gio, GLib, GdkPixbuf, Pango
from bridge import Bridge, ROOT
from desktop_services import DesktopServices
from clipboard_images import ClipboardImages
from input_method import configure_input_method

APP_ID = 'ch.aboimpinto.QuietChat'
EMOJIS = ['👍', '❤️', '😂', '😊', '🙏', '🎉', '🔥', '✅', '👋', '😢']
URL_PATTERN = re.compile(r'https?://[^\s<>"\'`]+', re.I)


def links(text):
    for match in URL_PATTERN.finditer(text):
        url = match.group().rstrip('.,;:!')
        for left, right in [('(', ')'), ('[', ']'), ('{', '}')]:
            while url.endswith(right) and url.count(right) > url.count(left): url = url[:-1]
        try:
            if urlparse(url).hostname: yield match.start(), match.start() + len(url), url
        except ValueError: continue


def markup(text):
    parts, offset = [], 0
    for start, end, url in links(text):
        parts += [GLib.markup_escape_text(text[offset:start]), f'<a href="{GLib.markup_escape_text(url)}">{GLib.markup_escape_text(url)}</a>']
        offset = end
    parts.append(GLib.markup_escape_text(text[offset:]))
    return ''.join(parts)


def label(text='', css=None, wrap=False, selectable=False):
    widget = Gtk.Label(label=text, xalign=0)
    widget.set_wrap(wrap)
    widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
    widget.set_selectable(selectable)
    if css: widget.add_css_class(css)
    return widget


def button(text, callback, css=None):
    widget = Gtk.Button(label=text)
    if css: widget.add_css_class(css)
    widget.connect('clicked', lambda _button: callback())
    return widget


def margins(widget, value):
    for side in ('top', 'bottom', 'start', 'end'): getattr(widget, 'set_margin_' + side)(value)


def clear_box(box):
    while box.get_first_child(): box.remove(box.get_first_child())


def resident(pid):
    try:
        for line in Path(f'/proc/{pid}/status').read_text().splitlines():
            if line.startswith('VmRSS:'): return int(line.split()[1]) * 1024
    except (OSError, ValueError): pass
    return 0


class QuietChat(Gtk.Application):
    def __init__(self, demo=False, directory=None, background=False):
        super().__init__(application_id=APP_ID + ('.Demo' if demo else ''), flags=Gio.ApplicationFlags.NON_UNIQUE if demo else Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.demo, self.directory, self.start_background = demo, directory, background
        self.window = self.bridge = self.desktop = None
        self.current = None
        self.offset = 0
        self.selected = None
        self.reply = None
        self.attachment = None
        self.clipboard_images = ClipboardImages()
        self.clipboard_paste = None
        self.attachment_thumbnail_path = None
        self.sending_attachment = None
        self.drafts = {}
        self.messages = []
        self.chat_rows = {}
        self.chat_avatars = collections.OrderedDict()
        self.avatar_source = self.avatar_request = None
        self.message_boxes = {}
        self.chat_fingerprint = self.message_fingerprint = None
        self.generation = 0
        self.settings = {'notifications': True, 'background': True, 'thumbnails': True}
        self.ready = self.busy = self.quitting = False
        self.contacts = False
        self.refresh_source = self.search_source = None
        self.asset_queue = collections.deque()
        self.asset_running = 0
        self.image_count = 0
        self.asset_epoch = 0
        self.preview_targets = {}
        self.reaction_buttons = {}
        self.pending_chat = None
        self.hold_token = False
        self.unread_revision = -1
        self.unread_chats = {}
        self.read_pending = set()

    def do_startup(self):
        Gtk.Application.do_startup(self)
        configure_input_method()
        self.hold(); self.hold_token = True
        for name, callback in [('quit', self.shutdown), ('show', lambda: self.show_chat(None))]:
            action = Gio.SimpleAction.new(name, None)
            action.connect('activate', lambda _action, _value, fn=callback: fn())
            self.add_action(action)
        self.set_accels_for_action('app.quit', ['<Control>q'])
        if self.demo:
            action = Gio.SimpleAction.new('demo-notification', None)
            action.connect('activate', lambda *_: self.bridge.request('demoIncoming', self.action_done))
            self.add_action(action)

    def do_activate(self):
        if self.window:
            self.show_chat(None); return
        provider = Gtk.CssProvider()
        provider.load_from_path(str(ROOT / 'native/style.css'))
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        settings = Gtk.Settings.get_default()
        settings.set_property('gtk-application-prefer-dark-theme', True)
        settings.set_property('gtk-enable-animations', False)
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(str(ROOT / 'assets'))
        self.window = Gtk.ApplicationWindow(application=self, title='QuietChat' + (' · Offline demo' if self.demo else ''))
        self.window.set_default_size(1120, 800)
        self.window.set_size_request(780, 560)
        self.window.set_icon_name(APP_ID)
        self.window.connect('close-request', self.close_requested)
        self.window.connect('notify::is-active', lambda *_: self.mark_read())
        self.build_ui()
        self.desktop = DesktopServices(ROOT / 'assets' / f'{APP_ID}.svg', ROOT / 'assets' / f'{APP_ID}-unread.svg', self.show_chat, self.shutdown, self.notice)
        self.start_bridge()
        self.memory_timer = GLib.timeout_add_seconds(3, self.update_memory)
        self.window.present()
        if self.start_background: GLib.timeout_add(600, self.hide_when_ready)

    def build_ui(self):
        header = Gtk.HeaderBar()
        brand = Gtk.Box(spacing=10)
        image = Gtk.Image.new_from_file(str(ROOT / 'assets' / f'{APP_ID}.svg')); image.set_pixel_size(30)
        brand.append(image); brand.append(label('QuietChat', 'brand'))
        if self.demo: brand.append(label('OFFLINE DEMO', 'badge'))
        header.pack_start(brand)
        self.memory = label('Starting…', 'small'); header.pack_end(self.memory)
        menu = Gtk.MenuButton(icon_name='open-menu-symbolic')
        popover = Gtk.Popover(); options = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=9); margins(options, 12)
        self.toggles = {}
        for key, title in [('notifications','Desktop notifications'), ('background','Keep running in the system tray'), ('thumbnails','Show small media previews')]:
            toggle = Gtk.CheckButton(label=title); toggle.set_active(True)
            toggle.connect('toggled', self.toggle_setting, key)
            options.append(toggle); self.toggles[key] = toggle
        options.append(button('Reconnect', self.restart_bridge))
        if self.demo: options.append(button('Simulate incoming message', lambda: self.bridge.request('demoIncoming', self.action_done)))
        options.append(button('Quit QuietChat', self.shutdown))
        popover.set_child(options); menu.set_popover(popover); header.pack_end(menu)
        self.window.set_titlebar(header)
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.window.set_child(root)
        main = Gtk.Box(); main.set_vexpand(True); root.append(main)
        sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8); sidebar.set_size_request(280,-1); sidebar.add_css_class('sidebar')
        margins(sidebar, 10); main.append(sidebar)
        self.search = Gtk.SearchEntry(placeholder_text='Search chats or contacts')
        self.search.connect('search-changed', self.search_changed); sidebar.append(self.search)
        self.contact_button = button('Chats  ·  Switch to contacts', self.toggle_contacts, 'flat'); sidebar.append(self.contact_button)
        chat_scroll = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.chat_scroll = chat_scroll
        for signal_name in ('value-changed', 'changed'):
            chat_scroll.get_vadjustment().connect(signal_name, self.schedule_chat_avatars)
        self.window.connect('notify::visible', self.schedule_chat_avatars)
        self.chat_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.chat_list.connect('row-activated', self.chat_activated)
        self.chat_list.set_activate_on_single_click(True)
        chat_scroll.set_child(self.chat_list); sidebar.append(chat_scroll)
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL); right.set_hexpand(True); main.append(right)
        conversation_header = Gtk.Box(spacing=12); margins(conversation_header, 12)
        self.avatar = Gtk.Image(icon_name='avatar-default-symbolic'); self.avatar.set_pixel_size(40)
        conversation_header.append(self.avatar)
        self.title = label('Your conversations', 'title'); self.title.set_hexpand(True); conversation_header.append(self.title)
        self.older = button('Older', lambda: self.change_page(60)); self.newer = button('Newer', lambda: self.change_page(-60))
        self.copy_chat = button('Copy chat', self.copy_conversation)
        conversation_header.append(self.older); conversation_header.append(self.newer); conversation_header.append(self.copy_chat)
        right.append(conversation_header)
        self.content_stack = Gtk.Stack(vexpand=True)
        self.empty = label('Choose a chat to begin.\nYour phone remains your primary WhatsApp device.', 'empty', True)
        self.content_stack.add_named(self.empty, 'empty')
        self.qr_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.qr_box.append(label('Connect WhatsApp', 'title'))
        self.qr_box.append(label('On your phone: WhatsApp → Linked devices → Link a device', 'muted', True))
        self.qr_picture = Gtk.Picture(can_shrink=True); self.qr_picture.set_size_request(360,360); self.qr_box.append(self.qr_picture)
        self.content_stack.add_named(self.qr_box, 'qr')
        self.message_scroll = Gtk.ScrolledWindow(vexpand=True, hexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.message_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10); self.message_list.add_css_class('conversation')
        self.message_scroll.set_child(self.message_list); self.content_stack.add_named(self.message_scroll, 'messages')
        right.append(self.content_stack)
        composer_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8); composer_box.add_css_class('composer')
        self.reply_bar = Gtk.Box(spacing=8); self.reply_bar.add_css_class('reply-preview')
        self.reply_label = label('', wrap=True); self.reply_label.set_hexpand(True)
        self.reply_bar.append(self.reply_label); self.reply_bar.append(button('×', self.cancel_reply, 'flat')); self.reply_bar.set_visible(False)
        composer_box.append(self.reply_bar)
        self.attachment_bar = Gtk.Box(spacing=8)
        self.attachment_thumbnail = Gtk.Picture(can_shrink=True, content_fit=Gtk.ContentFit.CONTAIN)
        self.attachment_thumbnail.set_size_request(72, 54)
        self.attachment_thumbnail.set_visible(False)
        self.attachment_bar.append(self.attachment_thumbnail)
        self.attachment_label = label('', 'muted'); self.attachment_label.set_hexpand(True)
        self.attachment_bar.append(self.attachment_label); self.attachment_bar.append(button('Preview', self.preview_attachment)); self.attachment_bar.append(button('×', self.clear_attachment, 'flat'))
        self.attachment_bar.set_visible(False); composer_box.append(self.attachment_bar)
        self.composer = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD_CHAR, accepts_tab=False)
        self.composer.connect('paste-clipboard', self.composer_paste)
        self.composer.set_top_margin(8); self.composer.set_bottom_margin(8); self.composer.set_left_margin(10); self.composer.set_right_margin(10)
        self.composer.set_tooltip_text('Enter sends · Shift+Enter adds a line · Ctrl+V pastes')
        self.composer_scroll = Gtk.ScrolledWindow(min_content_height=66, max_content_height=150, propagate_natural_height=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.composer_scroll.set_child(self.composer); composer_box.append(self.composer_scroll)
        keys = Gtk.EventControllerKey(); keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE); keys.connect('key-pressed', self.composer_key); self.composer.add_controller(keys)
        actions = Gtk.Box(spacing=8)
        actions.append(button('Attach image / video', self.choose_attachment))
        self.emoji_menu = Gtk.MenuButton(label='Emoji'); self.emoji_menu.set_popover(self.emoji_popover(False)); actions.append(self.emoji_menu)
        hint = label('Enter sends · Shift+Enter new line', 'small'); hint.set_hexpand(True); actions.append(hint)
        self.send_button = button('Send', self.send_message, 'suggested-action'); actions.append(self.send_button)
        composer_box.append(actions); right.append(composer_box)
        self.status = label('Starting the saved WhatsApp connection…', 'status'); self.status.set_ellipsize(Pango.EllipsizeMode.END); root.append(self.status)
        key_controller = Gtk.EventControllerKey(); key_controller.connect('key-pressed', self.window_key); self.window.add_controller(key_controller)
        self.update_controls()

    def start_bridge(self):
        args = ['--demo'] if self.demo else []
        if self.directory and not self.demo: args += ['--data-dir', self.directory]
        self.bridge = Bridge(args, self.event)

    def restart_bridge(self):
        if self.busy: return
        self.cancel_clipboard_paste()
        if self.bridge: self.bridge.close()
        self.avatar_request = None
        self.generation += 1
        self.release_messages(); self.asset_running = 0
        self.message_fingerprint = self.chat_fingerprint = None
        self.ready = False; self.update_controls(); self.start_bridge(); self.notice('Reconnecting…')

    def event(self, event):
        kind = event['type']
        if kind == 'ready':
            self.ready = True
            self.unread_revision = -1; self.read_pending.clear()
            self.desktop.configure_notifications(event['directory'])
            self.settings.update(event['settings'])
            for key, toggle in self.toggles.items(): toggle.set_active(self.settings[key])
            self.refresh_chats()
            if self.current: self.refresh_messages(follow=True)
            self.update_controls()
        elif kind == 'connection': self.notice(event['connection']['detail'])
        elif kind == 'changed':
            self.apply_unread(event); self.queue_refresh()
        elif kind == 'incoming':
            if not self.apply_unread(event): return
            message = event['message']
            if self.current and message['chat'] == self.current['id'] and self.window.is_active() and self.offset == 0:
                self.mark_read(); return
            if self.settings['notifications']:
                ticket = self.desktop.begin_notification(message['chat'])
                title = event['chat_name']
                body = (message['sender'] + ':\n' if message['chat'].endswith('@g.us') else '') + message['text']
                self.bridge.request('avatar', lambda result, error: self.desktop.notify(message['chat'], title, body, result.get('path') if result else None, ticket=ticket), chat=event.get('avatar_id',message['chat']))
        elif kind == 'qr':
            if event.get('path'):
                self.qr_picture.set_filename(event['path']); self.content_stack.set_visible_child_name('qr')
            else:
                self.qr_picture.set_paintable(None); self.content_stack.set_visible_child_name('messages' if self.current else 'empty')
        elif kind in ('notice','fatal'):
            self.notice(event['message'], kind == 'fatal')
            if kind == 'fatal': self.ready = False; self.update_controls()
        elif kind == 'stopped':
            self.ready = False; self.update_controls()
            if not self.quitting: self.notice('Connection closed. Use the menu to reconnect; close any running terminal instance first.', True)

    def notice(self, text, error=False):
        if not self.window: return
        self.status.set_text(text)
        self.status.set_tooltip_text(text)
        if error: self.status.add_css_class('error')
        else: self.status.remove_css_class('error')

    def action_done(self, _result, error):
        if error: self.notice(error, True)

    def apply_unread(self, state):
        revision = state.get('revision', self.unread_revision)
        if revision < self.unread_revision: return False
        self.unread_revision = revision
        if 'unread_chats' in state:
            self.unread_chats = state['unread_chats']
            self.desktop.reconcile_unread(self.unread_chats)
        else: self.desktop.set_unread(state.get('unread',0))
        return True

    def toggle_setting(self, toggle, key):
        self.settings[key] = toggle.get_active()
        if self.ready: self.bridge.request('settings', self.action_done, **{key: self.settings[key]})
        if key == 'thumbnails' and self.current:
            self.message_fingerprint = None; self.refresh_messages()

    def search_changed(self, _entry):
        if self.search_source: GLib.source_remove(self.search_source)
        self.search_source = GLib.timeout_add(180, self.search_now)

    def search_now(self):
        self.search_source = None; self.refresh_chats(); return GLib.SOURCE_REMOVE

    def toggle_contacts(self):
        self.contacts = not self.contacts
        self.contact_button.set_label('Contacts  ·  Switch to chats' if self.contacts else 'Chats  ·  Switch to contacts')
        self.chat_fingerprint = None; self.refresh_chats()

    def queue_refresh(self):
        if not self.refresh_source: self.refresh_source = GLib.timeout_add(150, self.refresh_now)

    def refresh_now(self):
        self.refresh_source = None
        self.refresh_chats()
        if self.current and self.window.get_visible(): self.refresh_messages()
        return GLib.SOURCE_REMOVE

    def refresh_chats(self):
        if not self.ready: return
        search, contacts = self.search.get_text(), self.contacts
        def complete(result, error):
            if error: self.notice(error, True); return
            if search != self.search.get_text() or contacts != self.contacts: return
            if not self.apply_unread(result): return
            if self.current and self.unread_chats.get(self.current['id'],0): self.mark_read()
            fingerprint = json.dumps(result['chats'], ensure_ascii=False)
            if fingerprint == self.chat_fingerprint: return
            self.chat_fingerprint = fingerprint
            clear_box(self.chat_list); self.chat_rows.clear()
            for chat in result['chats']:
                row = Gtk.ListBoxRow(); row.chat = chat
                box = Gtk.Box(spacing=10); box.add_css_class('chat-row')
                row.avatar_stack = Gtk.Stack(valign=Gtk.Align.CENTER, halign=Gtk.Align.START, hexpand=False)
                row.avatar_stack.set_size_request(36, 36)
                row.avatar_stack.add_css_class('chat-avatar')
                row.avatar_stack.set_overflow(Gtk.Overflow.HIDDEN)
                initial = label(chat['name'][:1].upper(), 'avatar')
                initial.set_xalign(.5)
                row.avatar_stack.add_named(initial, 'initial')
                row.avatar_image = Gtk.Picture(can_shrink=True, content_fit=Gtk.ContentFit.COVER, hexpand=False)
                row.avatar_image.set_size_request(36, 36)
                row.avatar_stack.add_named(row.avatar_image, 'photo')
                box.append(row.avatar_stack)
                details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3); details.set_hexpand(True)
                name = label(chat['name']); name.set_ellipsize(Pango.EllipsizeMode.END); name.set_max_width_chars(24)
                snippet = label(chat['preview'].replace('\n',' ')[:70], 'small'); snippet.set_ellipsize(Pango.EllipsizeMode.END); snippet.set_max_width_chars(24)
                details.append(name); details.append(snippet); box.append(details)
                if chat['unread']: box.append(label(str(chat['unread']), 'badge'))
                row.set_child(box); self.chat_list.append(row); self.chat_rows[chat['id']] = row
                if self.current and self.current['id'] == chat['id']: self.chat_list.select_row(row)
            if self.pending_chat:
                target = self.pending_chat; self.pending_chat = None; self.open_chat_id(target)
            self.schedule_chat_avatars()
        self.bridge.request('chats', complete, search=search, contacts=contacts)

    def schedule_chat_avatars(self, *_args):
        if not self.quitting:
            if self.avatar_source: GLib.source_remove(self.avatar_source)
            # Coalesce scroll/layout changes; never request the whole contact book.
            self.avatar_source = GLib.timeout_add(100, self.load_chat_avatars)

    def cache_chat_avatar(self, chat, result, error=None):
        texture = None
        if result and result.get('path'):
            try:
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(result['path'], 72, 72, True)
                width, height = pixbuf.get_width(), pixbuf.get_height()
                side = min(width, height)
                pixbuf = pixbuf.new_subpixbuf((width-side)//2, (height-side)//2, side, side)
                pixbuf = pixbuf.scale_simple(36, 36, GdkPixbuf.InterpType.BILINEAR)
                texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            except GLib.Error: error = 'Image unavailable'
        self.chat_avatars[chat] = (time.monotonic() + (60 if error else 3600), texture)
        self.chat_avatars.move_to_end(chat)
        while len(self.chat_avatars) > 64: self.chat_avatars.popitem(last=False)
        return texture

    def load_chat_avatars(self):
        self.avatar_source = None
        if self.quitting or not self.ready or not self.window.get_visible(): return GLib.SOURCE_REMOVE
        missing = []
        now = time.monotonic()
        for chat, row in self.chat_rows.items():
            ok, bounds = row.compute_bounds(self.chat_scroll)
            visible = ok and bounds.get_y() + bounds.get_height() > 0 and bounds.get_y() < self.chat_scroll.get_height()
            cached = self.chat_avatars.get(chat)
            texture = cached[1] if cached and cached[0] > now and visible else None
            row.avatar_image.set_paintable(texture)
            row.avatar_stack.set_visible_child_name('photo' if texture else 'initial')
            if visible:
                if cached and cached[0] > now: self.chat_avatars.move_to_end(chat)
                else: missing.append(chat)
        if missing and not self.avatar_request:
            chat = missing[0]
            token = object(); self.avatar_request = token
            def complete(result, error):
                if self.avatar_request is not token: return
                self.avatar_request = None
                if self.quitting: return
                self.cache_chat_avatar(chat, result, error)
                self.schedule_chat_avatars()
            self.bridge.request('avatar', complete, chat=chat)
        # Retry transient failures / expired photos only while the list is visible.
        elif not self.avatar_source:
            self.avatar_source = GLib.timeout_add_seconds(60, self.load_chat_avatars)
        return GLib.SOURCE_REMOVE

    def chat_activated(self, _list, row): self.open_chat(row.chat)

    def save_draft(self):
        if self.current:
            self.drafts[self.current['id']] = {'text': self.text(), 'reply': self.reply, 'attachment': self.attachment}
            # Empty drafts do not keep old chat names or attachment objects alive.
            if not self.text() and not self.reply and not self.attachment: self.drafts.pop(self.current['id'], None)

    def open_chat_id(self, chat):
        if chat in self.chat_rows: self.open_chat(self.chat_rows[chat].chat)
        else: self.open_chat({'id':chat, 'name':chat, 'unread':0, 'preview':''})

    def open_chat(self, chat):
        if self.busy: self.notice('Wait for the current send to finish.'); return
        self.cancel_clipboard_paste()
        self.save_draft(); self.current = chat; self.offset = 0; self.generation += 1
        draft = self.drafts.get(chat['id'], {})
        self.composer.get_buffer().set_text(draft.get('text',''))
        self.reply, self.attachment = draft.get('reply'), draft.get('attachment')
        self.selected = None; self.message_fingerprint = None
        self.release_messages(); self.title.set_text(chat['name']); self.update_controls()
        self.content_stack.set_visible_child_name('messages')
        self.refresh_messages(follow=True)
        self.avatar.set_from_icon_name('avatar-default-symbolic')
        generation = self.generation
        def avatar_done(result, _error):
            if generation == self.generation and result and result.get('path'):
                texture = self.cache_chat_avatar(chat['id'], result, _error)
                if texture: self.avatar.set_from_paintable(texture)
                self.schedule_chat_avatars()
        self.bridge.request('avatar', avatar_done, chat=chat['id'])
        self.composer.grab_focus(); self.mark_read()

    def release_messages(self):
        focus = self.window.get_focus()
        if focus and focus.is_ancestor(self.message_list): self.composer.grab_focus()
        for menu in self.reaction_buttons.values():
            if menu.get_popover(): menu.popdown()
        self.asset_queue.clear()
        self.asset_epoch += 1
        self.preview_targets.clear(); self.reaction_buttons.clear()
        self.message_boxes.clear()
        clear_box(self.message_list)
        self.messages = []; self.image_count = 0
        gc.collect()

    def refresh_messages(self, follow=False):
        if not self.ready or not self.current: return
        chat, offset, generation = self.current['id'], self.offset, self.generation
        def complete(result, error):
            if generation != self.generation or not self.current or chat != self.current['id'] or offset != self.offset: return
            if error: self.notice(error, True); return
            if offset and not result['messages']:
                self.offset = max(0,offset-60); self.refresh_messages(); return
            self.title.set_text(result['name']); self.current['name'] = result['name']
            fingerprint = json.dumps(result['messages'], ensure_ascii=False)
            if fingerprint == self.message_fingerprint: return
            self.message_fingerprint = fingerprint
            adj = self.message_scroll.get_vadjustment()
            old_value = adj.get_value(); at_end = old_value >= adj.get_upper() - adj.get_page_size() - 30
            self.release_messages()
            self.messages = result['messages']
            for message in self.messages: self.build_message(message)
            if not self.messages: self.message_list.append(label('Messages will appear here after sync.', 'empty', True))
            if self.selected not in self.message_boxes: self.selected = self.messages[-1]['id'] if self.messages else None
            self.select_message(self.selected)
            self.update_controls()
            def scroll():
                if generation == self.generation:
                    adj.set_value(max(0, adj.get_upper()-adj.get_page_size()) if follow or at_end else min(old_value, max(0,adj.get_upper()-adj.get_page_size())))
                return GLib.SOURCE_REMOVE
            GLib.timeout_add(60, scroll)
            self.pump_assets()
        self.bridge.request('messages', complete, chat=chat, offset=offset)

    def build_message(self, message):
        wrapper = Gtk.Box(); wrapper.set_hexpand(True)
        bubble = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=7); bubble.add_css_class('bubble')
        if message['mine']: bubble.add_css_class('mine'); wrapper.set_halign(Gtk.Align.END)
        else: wrapper.set_halign(Gtk.Align.START)
        wrapper.append(bubble); self.message_list.append(wrapper)
        self.message_boxes[message['id']] = bubble
        header = Gtk.Box(spacing=16)
        author = label('You' if message['mine'] else message['sender'], 'message-meta'); author.set_hexpand(True)
        author.set_ellipsize(Pango.EllipsizeMode.END); author.set_max_width_chars(38)
        header.append(author); header.append(label(time.strftime('%H:%M', time.localtime(message['time'])), 'message-meta')); bubble.append(header)
        if message.get('quote'):
            quote = label('↪ ' + message['quote'], 'muted', True, True); quote.set_max_width_chars(62); bubble.append(quote)
        body = label(wrap=True, selectable=True, css='message-body'); body.set_max_width_chars(64)
        body.set_markup(markup(message['text'])); body.connect('activate-link', lambda _label, uri: self.open_link(uri)); bubble.append(body)
        preview = message.get('preview') or {}
        urls = list(links(message['text']))
        if urls:
            url = urls[0][2]
            card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5); card.add_css_class('preview-card')
            title = label(preview.get('title') or urlparse(url).hostname or 'Link', wrap=True); title.set_max_width_chars(60); card.append(title)
            description = label(preview.get('description') or url, 'small', True, True); description.set_max_width_chars(60); card.append(description)
            card_actions = Gtk.Box(spacing=8); card_actions.append(button('Open link', lambda u=url: self.open_link(u), 'flat'))
            preview_button = button('Load preview', lambda m=message, u=url: self.load_url_preview(m['id'], u), 'flat')
            card_actions.append(preview_button); card.append(card_actions); bubble.append(card)
            self.preview_targets[message['id']] = [title, description, card, None]
        if message['kind'] in ('image','video') or message.get('thumbnail'):
            picture = Gtk.Picture(can_shrink=True, content_fit=Gtk.ContentFit.CONTAIN)
            picture.set_size_request(260,160); picture.set_visible(False); bubble.append(picture)
            media_actions = Gtk.Box(spacing=8)
            if message['kind'] in ('image','video'):
                media_actions.append(button('Play video' if message['kind'] == 'video' else 'Open image', lambda m=message: self.open_media(m)))
                media_actions.append(button('Load preview', lambda m=message, p=picture: self.load_thumbnail(m, p, True), 'flat'))
            bubble.append(media_actions)
            if self.settings['thumbnails'] and message.get('thumbnail') and self.image_count < 12:
                self.image_count += 1
                self.asset_queue.append((self.asset_epoch, message, picture))
        if message.get('reactions'): bubble.append(label(message['reactions'], 'muted'))
        tools = Gtk.Box(spacing=6)
        tools.append(button('Reply', lambda m=message: self.start_reply(m), 'flat'))
        tools.append(button('Copy', lambda m=message: self.copy_text(m['text']), 'flat'))
        react = Gtk.MenuButton(label='React'); react.add_css_class('flat')
        react.set_create_popup_func(lambda menu, *_args, m=message: menu.set_popover(self.emoji_popover(True, m)))
        tools.append(react)
        self.reaction_buttons[message['id']] = react
        bubble.append(tools)
        gesture = Gtk.GestureClick(); gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        gesture.connect('pressed', lambda *_args, mid=message['id']: self.select_message(mid)); bubble.add_controller(gesture)

    def select_message(self, mid):
        if self.selected in self.message_boxes: self.message_boxes[self.selected].remove_css_class('selected')
        self.selected = mid
        if mid in self.message_boxes: self.message_boxes[mid].add_css_class('selected')

    def pump_assets(self):
        while self.asset_queue and self.asset_running < 2:
            epoch, message, picture = self.asset_queue.popleft()
            if epoch != self.asset_epoch: continue
            self.asset_running += 1
            self.load_thumbnail(message, picture, False, automatic=True)

    def load_thumbnail(self, message, picture, download, automatic=False):
        generation, epoch = self.generation, self.asset_epoch
        def complete(result, error):
            if automatic: self.asset_running -= 1
            if generation == self.generation and epoch == self.asset_epoch and picture.get_parent():
                if result and result.get('path'):
                    try:
                        adj = self.message_scroll.get_vadjustment()
                        at_end = adj.get_value() >= adj.get_upper() - adj.get_page_size() - 30
                        picture.set_paintable(Gdk.Texture.new_from_filename(result['path'])); picture.set_visible(True)
                        if at_end:
                            def scroll():
                                if generation == self.generation and epoch == self.asset_epoch:
                                    adj.set_value(max(0, adj.get_upper()-adj.get_page_size()))
                                return GLib.SOURCE_REMOVE
                            GLib.timeout_add(60, scroll)
                    except GLib.Error: pass
                elif error and not automatic: self.notice(error, True)
            self.pump_assets()
        self.bridge.request('thumbnail', complete, chat=message['chat'], message=message['id'], download=download)

    def load_url_preview(self, mid, url):
        generation = self.generation
        self.notice('Loading a small preview…')
        def complete(result, error):
            if generation != self.generation or mid not in self.message_boxes: return
            if error: self.notice(error, True); return
            target = self.preview_targets.get(mid)
            if not target: return
            title, description, card, picture = target
            title.set_text(result.get('title',''))
            description.set_text(result.get('description',''))
            if result.get('path'):
                if not picture:
                    picture = Gtk.Picture(can_shrink=True, content_fit=Gtk.ContentFit.CONTAIN)
                    picture.set_size_request(260,160); card.append(picture); target[3] = picture
                picture.set_filename(result['path'])
            self.notice('Preview loaded. Links always open in your normal browser.')
        self.bridge.request('urlPreview', complete, url=url)

    def open_link(self, url):
        if urlparse(url).scheme not in ('http','https'): return True
        try: Gio.AppInfo.launch_default_for_uri(url, None)
        except GLib.Error: self.notice('Could not open the default browser.', True)
        return True

    def copy_text(self, text):
        self.window.get_clipboard().set(text)
        self.notice('Copied. Use Ctrl+V to paste into any app or this composer.')

    def copy_conversation(self):
        if self.messages:
            self.copy_text('\n\n'.join(f"{'You' if m['mine'] else m['sender']} · {time.strftime('%Y-%m-%d %H:%M', time.localtime(m['time']))}\n{m['text']}" for m in self.messages))
            self.notice(f'Copied the {len(self.messages)} messages on this page.')

    def text(self):
        buffer = self.composer.get_buffer()
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)

    def clipboard_has_image(self):
        formats = self.window.get_clipboard().get_formats()
        return formats.contain_gtype(Gdk.Texture) or any(mime.startswith('image/') for mime in formats.get_mime_types())

    def composer_paste(self, composer):
        if self.clipboard_has_image():
            composer.stop_emission_by_name('paste-clipboard')
            self.paste_clipboard_image()

    def cancel_clipboard_paste(self):
        if self.clipboard_paste:
            self.clipboard_paste.cancel(); self.clipboard_paste = None

    def prune_clipboard_images(self):
        attachments = [self.attachment, self.sending_attachment] + [draft.get('attachment') for draft in self.drafts.values()]
        self.clipboard_images.retain(a['path'] for a in attachments if a)

    def set_attachment(self, attachment):
        self.cancel_clipboard_paste()
        self.attachment = attachment
        self.save_draft(); self.update_controls(); self.prune_clipboard_images()

    def paste_clipboard_image(self):
        if not self.current: self.notice('Choose a chat before pasting an image.'); return
        if self.busy or self.clipboard_paste or self.clipboard_images.pending:
            self.notice('Wait for the current attachment or send to finish.'); return
        chat = self.current['id']
        token = Gio.Cancellable(); self.clipboard_paste = token
        self.update_controls(); self.notice('Preparing clipboard image…')

        def active():
            return not self.quitting and self.clipboard_paste is token and self.current and self.current['id'] == chat

        def finish(filename, error):
            if not active(): self.prune_clipboard_images(); return
            if error:
                self.clipboard_paste = None; self.update_controls(); self.notice(error, True)
                self.prune_clipboard_images(); return
            def attached(value, error):
                if not active(): self.prune_clipboard_images(); return
                if error: finish(None, error); return
                value['clipboard'] = True
                self.set_attachment(value)
                self.composer.grab_focus()
                self.notice('Clipboard image attached. Add a caption, then press Enter to send.')
            self.bridge.request('attachment', attached, path=filename)

        def read(clipboard, result):
            try:
                texture = clipboard.read_texture_finish(result)
                if not active(): return
                if texture is None: finish(None, 'No image could be read from the clipboard.'); return
                self.clipboard_images.capture(texture, finish)
            except GLib.Error:
                if active(): finish(None, 'Could not read the clipboard image. Try copying it again.')
        self.window.get_clipboard().read_texture_async(token, read)

    def composer_key(self, controller, keyval, _keycode, state):
        shift = bool(state & Gdk.ModifierType.SHIFT_MASK)
        control = bool(state & Gdk.ModifierType.CONTROL_MASK)
        # Let GTK finish/cancel an input-method composition before our shortcuts.
        # In particular, Enter can commit an accented character, not send a chat.
        if keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter, Gdk.KEY_Escape):
            event = controller.get_current_event()
            if event and self.composer.im_context_filter_keypress(event): return True
            if keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and not shift:
                self.send_message(); return True
            if keyval == Gdk.KEY_Escape and self.reply: self.cancel_reply(); return True
        if control and keyval in (Gdk.KEY_v, Gdk.KEY_V):
            # Native paste inserts data rather than synthesizing Enter key events.
            if shift:
                self.composer.emit('paste-clipboard'); return True
        return False

    def window_key(self, _controller, keyval, _keycode, state):
        if state & Gdk.ModifierType.CONTROL_MASK and keyval in (Gdk.KEY_v, Gdk.KEY_V) and self.clipboard_has_image():
            self.paste_clipboard_image(); return True
        if keyval == Gdk.KEY_F5: self.emoji_menu.popup(); return True
        if keyval == Gdk.KEY_F6:
            if self.selected in self.reaction_buttons: self.reaction_buttons[self.selected].popup()
            return True
        if keyval == Gdk.KEY_F1: self.show_help(); return True
        if keyval == Gdk.KEY_F4: self.attachment_path(); return True
        if keyval == Gdk.KEY_F8:
            message = next((m for m in self.messages if m['id'] == self.selected), None)
            if message: self.start_reply(message)
            return True
        if keyval == Gdk.KEY_F3: self.choose_attachment(); return True
        if keyval == Gdk.KEY_F9: self.search.grab_focus(); return True
        if keyval == Gdk.KEY_F7: self.toggle_contacts(); return True
        if keyval == Gdk.KEY_F10:
            if self.attachment and self.composer.has_focus(): self.preview_attachment()
            else:
                message = next((m for m in self.messages if m['id'] == self.selected), None)
                if message: self.open_media(message)
            return True
        if state & Gdk.ModifierType.CONTROL_MASK and keyval in (Gdk.KEY_s,Gdk.KEY_S): self.send_message(); return True
        if state & Gdk.ModifierType.CONTROL_MASK and state & Gdk.ModifierType.SHIFT_MASK and keyval in (Gdk.KEY_c,Gdk.KEY_C):
            focus = self.window.get_focus()
            if isinstance(focus, Gtk.Label):
                selected, start, end = focus.get_selection_bounds()
                if selected: self.copy_text(focus.get_text()[start:end])
            elif isinstance(focus, Gtk.TextView): focus.get_buffer().copy_clipboard(self.window.get_clipboard())
            return True
        return False

    def start_reply(self, message):
        if message['kind'] == 'unsupported': self.notice('This message can only be opened on your phone.'); return
        self.reply = {key: message[key] for key in ('chat','id','sender','mine','text')}; self.reply['text'] = self.reply['text'][:200]
        self.selected = message['id']; self.update_controls(); self.composer.grab_focus()

    def cancel_reply(self): self.reply = None; self.update_controls(); self.composer.grab_focus()

    def emoji_popover(self, reaction, message=None):
        popover = Gtk.Popover(); grid = Gtk.FlowBox(max_children_per_line=5, selection_mode=Gtk.SelectionMode.NONE)
        margins(grid,8)
        for emoji in EMOJIS + (['Remove'] if reaction else []):
            def choose(value=emoji):
                if reaction: self.bridge.request('react', self.action_done, chat=message['chat'], message=message['id'], emoji='' if value == 'Remove' else value)
                else: self.composer.get_buffer().insert_at_cursor(value); self.composer.grab_focus()
                popover.popdown()
                self.composer.grab_focus()
            grid.append(button(emoji, choose))
        popover.set_child(grid); return popover

    def show_help(self):
        dialog = Gtk.Dialog(title='QuietChat controls', transient_for=self.window, modal=True)
        dialog.add_button('Close', Gtk.ResponseType.CLOSE)
        content = label('Select text with the mouse, then Ctrl+C to copy. Ctrl+V pastes text\nor attaches a clipboard image, ready to send with an optional caption.\nClick links normally. Copy chat copies the current message page.\n\nEnter sends · Shift+Enter adds a line · F8 replies · Escape cancels a reply\nF3 attaches · F4 enters a path · F5 emoji · F6 reaction\nF7 contacts/chats · F9 search · F10 opens media · Ctrl+Q quits\n\nClosing the window keeps QuietChat in the system tray when available.\nUse the menu or tray menu to quit fully.', wrap=True, selectable=True)
        margins(content,20); dialog.get_content_area().append(content)
        dialog.connect('response', lambda window, _response: window.destroy()); dialog.present()

    def attachment_path(self):
        if not self.current or self.busy: return
        self.cancel_clipboard_paste(); self.update_controls()
        dialog = Gtk.Dialog(title='Attach image or video', transient_for=self.window, modal=True)
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL); dialog.add_button('Attach', Gtk.ResponseType.ACCEPT)
        entry = Gtk.Entry(placeholder_text='File path (empty removes attachment)'); entry.set_width_chars(60)
        if self.attachment: entry.set_text(self.attachment['path'])
        margins(entry,16); dialog.get_content_area().append(entry)
        chat = self.current['id']
        def response(window, result):
            path = entry.get_text(); window.destroy()
            if result != Gtk.ResponseType.ACCEPT: return
            if not path: self.clear_attachment(); return
            def attached(value,error):
                if not self.current or self.current['id'] != chat: return
                if error: self.notice(error,True); return
                self.set_attachment(value)
            self.bridge.request('attachment', attached, path=path)
        dialog.connect('response', response); dialog.present()

    def choose_attachment(self):
        if not self.current or self.busy: return
        self.cancel_clipboard_paste(); self.update_controls()
        chooser = Gtk.FileChooserNative.new('Choose an image or video', self.window, Gtk.FileChooserAction.OPEN, 'Attach', 'Cancel')
        filter_ = Gtk.FileFilter(); filter_.set_name('Images and MP4 video')
        for mime in ('image/jpeg','image/png','image/webp','video/mp4'): filter_.add_mime_type(mime)
        chooser.add_filter(filter_)
        chat = self.current['id']
        def response(dialog, result):
            if result == Gtk.ResponseType.ACCEPT and dialog.get_file():
                path = dialog.get_file().get_path()
                def attached(value,error):
                    if not self.current or self.current['id'] != chat: return
                    if error: self.notice(error,True); return
                    self.set_attachment(value); self.composer.grab_focus()
                self.bridge.request('attachment', attached, path=path)
            dialog.destroy()
        chooser.connect('response', response); chooser.show()

    def clear_attachment(self): self.set_attachment(None)
    def preview_attachment(self):
        if self.attachment: self.bridge.request('previewAttachment', self.action_done, path=self.attachment['path'])
    def open_media(self, message):
        if message['kind'] in ('image','video'):
            self.notice('Opening media…'); self.bridge.request('media', self.action_done, chat=message['chat'], message=message['id'])

    def send_message(self):
        if self.busy or self.clipboard_paste or not self.current or not self.ready: return
        text, attachment, reply, chat = self.text(), self.attachment, self.reply, self.current['id']
        if not text.strip() and not attachment: return
        if len(text) > 16000: self.notice('Messages are limited to 16,000 characters.',True); return
        self.busy = True; self.sending_attachment = attachment; self.update_controls(); self.notice('Sending…')
        def complete(_result, error):
            self.busy = False
            self.sending_attachment = None
            if error: self.notice('Send failed; draft kept. ' + error, True)
            else:
                if self.text() == text: self.composer.get_buffer().set_text('')
                if self.attachment is attachment: self.attachment = None
                if self.reply is reply: self.reply = None
                self.drafts.pop(chat,None)
                self.offset = 0; self.refresh_messages(follow=True)
                self.notice('Added to offline demo. Nothing sent to WhatsApp.' if self.demo else 'Submitted to WhatsApp.')
            self.update_controls(); self.prune_clipboard_images(); self.composer.grab_focus()
        self.bridge.request('send', complete, chat=chat, text=text, path=attachment['path'] if attachment else None, reply={'chat':reply['chat'],'id':reply['id']} if reply else None)

    def update_controls(self):
        if not self.window: return
        self.send_button.set_sensitive(bool(self.ready and self.current and not self.busy and not self.clipboard_paste))
        self.composer.set_sensitive(bool(self.current))
        self.copy_chat.set_sensitive(bool(self.messages))
        self.older.set_sensitive(bool(self.current and not self.busy)); self.newer.set_sensitive(bool(self.current and self.offset and not self.busy))
        self.reply_bar.set_visible(bool(self.reply))
        if self.reply: self.reply_label.set_text(f"Reply to {'You' if self.reply['mine'] else self.reply['sender']}\n{self.reply['text'][:160]}")
        self.attachment_bar.set_visible(bool(self.attachment))
        if self.attachment:
            title = 'Clipboard image' if self.attachment.get('clipboard') else Path(self.attachment['path']).name
            self.attachment_label.set_text(title + f" · {self.attachment['size']/1048576:.1f} MiB")
        path = self.attachment['path'] if self.attachment and self.attachment.get('clipboard') else None
        if path != self.attachment_thumbnail_path:
            self.attachment_thumbnail_path = path
            self.attachment_thumbnail.set_paintable(None); self.attachment_thumbnail.set_visible(False)
            if path:
                try:
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 72, 54, True)
                    self.attachment_thumbnail.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
                    self.attachment_thumbnail.set_visible(True)
                except GLib.Error: pass

    def change_page(self, delta):
        if not self.current or self.busy: return
        self.offset = max(0,self.offset+delta); self.generation += 1; self.message_fingerprint = None; self.refresh_messages(follow=True)

    def mark_read(self):
        if self.ready and self.current and self.window.get_visible() and self.window.is_active() and self.offset == 0:
            chat = self.current['id']
            if chat in self.read_pending: return
            self.read_pending.add(chat)
            def complete(result,error):
                self.read_pending.discard(chat)
                if error: self.notice(error,True); return
                self.apply_unread(result); self.queue_refresh()
            self.bridge.request('read', complete, chat=chat)

    def show_chat(self, chat):
        if not self.window: self.activate(); return
        was_hidden = not self.window.get_visible(); self.window.present()
        if chat:
            if self.ready: self.open_chat_id(chat)
            else: self.pending_chat = chat
        elif was_hidden and self.current: self.message_fingerprint = None; self.refresh_messages(follow=True)
        self.mark_read()

    def hide_when_ready(self):
        if self.desktop.available: self.hide_window()
        return GLib.SOURCE_REMOVE

    def hide_window(self):
        self.cancel_clipboard_paste(); self.update_controls()
        self.save_draft(); self.window.set_visible(False); self.generation += 1
        self.release_messages(); self.message_fingerprint = None
        self.avatar.set_from_icon_name('avatar-default-symbolic')

    def close_requested(self, _window):
        if self.settings['background'] and self.desktop.available:
            self.hide_window(); return True
        self.shutdown(); return False

    def update_memory(self):
        if self.quitting: return GLib.SOURCE_REMOVE
        ui = resident(os.getpid()); backend = resident(self.bridge.process.pid) if self.bridge else 0
        self.memory.set_text(f'{(ui+backend)/1048576:.0f} MiB total RSS')
        self.memory.set_tooltip_text(f'Native UI: {ui/1048576:.0f} MiB · WhatsApp connection: {backend/1048576:.0f} MiB\nOnly the current message page is loaded; media player memory is separate.')
        return GLib.SOURCE_CONTINUE

    def shutdown(self):
        if self.quitting: return
        self.quitting = True
        if self.avatar_source: GLib.source_remove(self.avatar_source); self.avatar_source = None
        if self.desktop: self.desktop.close()
        if self.bridge: self.bridge.close()
        self.cancel_clipboard_paste(); self.clipboard_images.close()
        if self.hold_token: self.release(); self.hold_token = False
        self.quit()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='QuietChat native GTK4 interface')
    parser.add_argument('--demo', action='store_true')
    parser.add_argument('--data-dir')
    parser.add_argument('--background', action='store_true')
    arguments = parser.parse_args()
    GLib.set_prgname(APP_ID)
    GLib.set_application_name('QuietChat')
    app = QuietChat(arguments.demo, arguments.data_dir, arguments.background)
    for signum in (signal.SIGINT, signal.SIGTERM):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, app.shutdown)
    raise SystemExit(app.run([sys.argv[0]]))
