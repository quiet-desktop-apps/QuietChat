"""Freedesktop notifications and StatusNotifierItem tray, using the existing GLib loop."""
import os
import json
from pathlib import Path
import gi

gi.require_version('Gio', '2.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gio, GLib, GdkPixbuf

ITEM_XML = '''<node><interface name="org.kde.StatusNotifierItem">
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="u" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconThemePath" type="s" access="read"/><property name="IconPixmap" type="a(iiay)" access="read"/>
<property name="AttentionIconName" type="s" access="read"/><property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
<property name="AttentionMovieName" type="s" access="read"/>
<property name="OverlayIconName" type="s" access="read"/><property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
<property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
<property name="Menu" type="o" access="read"/>
<method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
<signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewToolTip"/>
<signal name="NewStatus"><arg type="s"/></signal><signal name="NewTitle"/>
</interface></node>'''
MENU_XML = '''<node><interface name="com.canonical.dbusmenu">
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
<method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
<arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method>
<method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
<method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
<signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
</interface></node>'''


def pixmap(path):
    image = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), 64, 64, True)
    pixels, stride, channels = image.get_pixels(), image.get_rowstride(), image.get_n_channels()
    data = bytearray()
    for y in range(image.get_height()):
        for x in range(image.get_width()):
            i = y * stride + x * channels
            data.extend((pixels[i+3] if channels == 4 else 255, pixels[i], pixels[i+1], pixels[i+2]))
    return [(image.get_width(), image.get_height(), bytes(data))]


class DesktopServices:
    def __init__(self, icon, unread_icon, show, quit_app, notice):
        self.icon, self.unread_icon = str(icon), str(unread_icon)
        self.show, self.quit_app, self.notice = show, quit_app, notice
        self.unread = 0
        self.available = False
        self.notification_ids = {}
        self.pending_notifications = []
        self.notification_owner = None
        self.notification_state = None
        self.closed = False
        self.registrations = []
        self.watch = self.owner = self.subscription = None
        self.dock_watch = self.notification_watch = None
        self.connection = None
        try:
            self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            self.normal_pixels = pixmap(icon)
            self.unread_pixels = self.normal_pixels
            for path, xml in [('/StatusNotifierItem', ITEM_XML), ('/MenuBar', MENU_XML)]:
                info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
                self.registrations.append(self.connection.register_object(path, info, self.method, self.property, None))
            self.owner = Gio.bus_own_name_on_connection(self.connection, f'org.kde.StatusNotifierItem-{os.getpid()}-1', Gio.BusNameOwnerFlags.NONE, None, None)
            self.watch = Gio.bus_watch_name_on_connection(self.connection, 'org.kde.StatusNotifierWatcher', Gio.BusNameWatcherFlags.NONE, self.watcher_appeared, self.watcher_gone)
            self.subscription = self.connection.signal_subscribe('org.freedesktop.Notifications', 'org.freedesktop.Notifications', None, '/org/freedesktop/Notifications', None, Gio.DBusSignalFlags.NONE, self.notification_event)
            self.dock_watch = Gio.bus_watch_name_on_connection(self.connection, 'com.canonical.Unity', Gio.BusNameWatcherFlags.NONE, lambda *_: self.update_dock(), None)
            self.notification_watch = Gio.bus_watch_name_on_connection(self.connection, 'org.freedesktop.Notifications', Gio.BusNameWatcherFlags.NONE, self.notification_service_appeared, None)
            self.update_dock()
        except GLib.Error:
            self.notice('Desktop tray/notifications are unavailable in this session. Closing the window will quit.')

    def watcher_appeared(self, connection, _name, _owner):
        def complete(bus, result):
            try:
                bus.call_finish(result)
                self.available = True
            except GLib.Error:
                self.available = False
        connection.call('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem',
                        GLib.Variant('(s)', ('/StatusNotifierItem',)), None, Gio.DBusCallFlags.NONE, 3000, None, complete)

    def watcher_gone(self, *_args):
        was_available = self.available
        self.available = False
        if was_available:
            self.show(None)
            self.notice('The system tray disappeared; QuietChat has been brought back to the screen.')

    def property(self, _connection, _sender, _path, interface, name):
        if interface == 'com.canonical.dbusmenu':
            return {'Version': GLib.Variant('u', 3), 'TextDirection': GLib.Variant('s', 'ltr'), 'Status': GLib.Variant('s', 'normal'), 'IconThemePath': GLib.Variant('as', [str(Path(self.icon).parent)])}.get(name)
        title = f'QuietChat · {self.unread} unread' if self.unread else 'QuietChat'
        icon_name = self.icon_name()
        strings = {'Category': 'Communications', 'Id': 'QuietChat', 'Title': title, 'Status': 'NeedsAttention' if self.unread else 'Active',
                   'IconName': icon_name, 'AttentionIconName': icon_name, 'AttentionMovieName': '', 'OverlayIconName': '', 'IconThemePath': str(Path(self.icon).parent)}
        if name in strings: return GLib.Variant('s', strings[name])
        if name == 'WindowId': return GLib.Variant('u', 0)
        if name == 'ItemIsMenu': return GLib.Variant('b', False)
        if name == 'Menu': return GLib.Variant('o', '/MenuBar')
        if name == 'ToolTip': return GLib.Variant('(sa(iiay)ss)', (icon_name, [], title, 'Click to open your conversations'))
        if name in ('IconPixmap', 'AttentionIconPixmap', 'OverlayIconPixmap'):
            pixels = [] if name == 'OverlayIconPixmap' else self.unread_pixels if name == 'AttentionIconPixmap' or self.unread else self.normal_pixels
            return GLib.Variant('a(iiay)', pixels)

    @staticmethod
    def menu_properties(item):
        labels = {1: 'Show QuietChat', 2: 'Quit QuietChat'}
        return {'label': GLib.Variant('s', labels.get(item, '')), 'enabled': GLib.Variant('b', True), 'visible': GLib.Variant('b', True)}

    def method(self, _connection, _sender, _path, interface, method, parameters, invocation):
        args = parameters.unpack()
        if interface == 'org.kde.StatusNotifierItem':
            if method in ('Activate', 'SecondaryActivate', 'ContextMenu'): self.show(None)
            invocation.return_value(None)
        elif method == 'GetLayout':
            parent = args[0]
            children = [GLib.Variant('(ia{sv}av)', (item, self.menu_properties(item), [])) for item in (1, 2)] if parent == 0 else []
            invocation.return_value(GLib.Variant('(u(ia{sv}av))', (1, (parent, {} if parent == 0 else self.menu_properties(parent), children))))
        elif method == 'GetGroupProperties':
            invocation.return_value(GLib.Variant('(a(ia{sv}))', ([(item, self.menu_properties(item)) for item in args[0]],)))
        elif method == 'GetProperty':
            invocation.return_value(GLib.Variant('(v)', (self.menu_properties(args[0]).get(args[1], GLib.Variant('s','')),)))
        elif method == 'AboutToShow': invocation.return_value(GLib.Variant('(b)', (False,)))
        elif method == 'Event':
            invocation.return_value(None)
            if args[1] == 'clicked':
                if args[0] == 1: self.show(None)
                if args[0] == 2: self.quit_app()
        else: invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    def set_unread(self, count):
        count = max(0, int(count))
        if self.unread == count: return
        previous_icon = self.icon_name()
        self.unread = count
        if self.icon_name() != previous_icon:
            self.unread_pixels = pixmap(Path(self.icon).parent / (self.icon_name() + '.svg')) if count else self.normal_pixels
        self.update_dock()
        if self.connection:
            for signal in ('NewIcon', 'NewAttentionIcon', 'NewToolTip', 'NewTitle', 'NewStatus'):
                value = GLib.Variant('(s)', ('NeedsAttention' if count else 'Active',)) if signal == 'NewStatus' else None
                self.connection.emit_signal(None, '/StatusNotifierItem', 'org.kde.StatusNotifierItem', signal, value)
            # Some tray hosts cache properties rather than reacting to NewStatus.
            properties = {name: self.property(None,None,None,'org.kde.StatusNotifierItem',name)
                          for name in ('Status','Title','IconName','AttentionIconName','IconPixmap','AttentionIconPixmap','ToolTip')}
            self.connection.emit_signal(None, '/StatusNotifierItem', 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                                        GLib.Variant('(sa{sv}as)', ('org.kde.StatusNotifierItem', properties, [])))

    def icon_name(self):
        base = Path(self.icon).stem
        return base + ('-unread-' + (str(self.unread) if self.unread <= 99 else 'plus99') if self.unread else '')

    def update_dock(self):
        if not self.connection: return
        self.connection.emit_signal(None, '/ch/aboimpinto/QuietChat/LauncherEntry', 'com.canonical.Unity.LauncherEntry', 'Update',
            GLib.Variant('(sa{sv})', ('application://ch.aboimpinto.QuietChat.desktop',
                {'count': GLib.Variant('x',self.unread), 'count-visible': GLib.Variant('b',self.unread > 0)})))

    def notification_service_appeared(self, _connection, _name, owner):
        if self.notification_owner != owner:
            self.notification_owner = owner
            self.notification_ids.clear()
            self.save_notifications()

    def configure_notifications(self, directory):
        self.notification_state = Path(directory) / 'native-notifications.json'
        if not self.connection: return
        try:
            owner = self.connection.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetNameOwner',
                GLib.Variant('(s)',('org.freedesktop.Notifications',)), GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
            self.notification_owner = owner
            saved = json.loads(self.notification_state.read_text())
            if saved.get('owner') == owner:
                self.notification_ids.update({int(key):chat for key,chat in list(saved.get('ids',{}).items())[:100]
                                              if str(key).isdigit() and int(key)>0 and isinstance(chat,str)})
        except (GLib.Error, OSError, ValueError, AttributeError, TypeError): pass

    def save_notifications(self):
        if not self.notification_state: return
        try:
            temporary = self.notification_state.with_suffix('.tmp')
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor,'w') as stream:
                json.dump({'owner':self.notification_owner,'ids':self.notification_ids},stream)
            temporary.replace(self.notification_state)
        except OSError: pass

    def begin_notification(self, chat):
        ticket = {'chat':chat, 'cancelled':False}
        self.pending_notifications.append(ticket)
        if len(self.pending_notifications)>128:
            self.pending_notifications.pop(0)['cancelled'] = True
        return ticket

    def close_notification(self, notification_id):
        if not self.connection: return
        owner = self.notification_owner
        def complete(bus,result):
            try: bus.call_finish(result)
            except GLib.Error: return
            if owner == self.notification_owner:
                self.notification_ids.pop(notification_id,None); self.save_notifications()
        self.connection.call(owner or 'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications',
                             'CloseNotification', GLib.Variant('(u)',(notification_id,)), None, Gio.DBusCallFlags.NONE, 3000, None, complete)

    def reconcile_unread(self, chats):
        unread = {chat:int(count) for chat,count in chats.items() if int(count)>0}
        for ticket in self.pending_notifications:
            if ticket['chat'] not in unread: ticket['cancelled'] = True
        for notification_id,chat in list(self.notification_ids.items()):
            if chat not in unread: self.close_notification(notification_id)
        self.set_unread(sum(unread.values()))

    def notify(self, chat, title, text, avatar=None, ticket=None):
        ticket = ticket if ticket is not None else self.begin_notification(chat)
        def finished():
            self.pending_notifications[:] = [pending for pending in self.pending_notifications if pending is not ticket]
        if not self.connection or self.closed or ticket['cancelled']:
            finished(); return
        hints = {'category': GLib.Variant('s', 'im.received'), 'desktop-entry': GLib.Variant('s', 'ch.aboimpinto.QuietChat'), 'urgency': GLib.Variant('y', 1)}
        if avatar and Path(avatar).is_file(): hints['image-path'] = GLib.Variant('s', str(avatar))
        body = GLib.markup_escape_text(text[:300])
        def complete(bus, result):
            try:
                notification_id = bus.call_finish(result).unpack()[0]
                self.notification_ids[notification_id] = chat
                self.save_notifications()
                if ticket['cancelled'] or self.closed: self.close_notification(notification_id)
                if len(self.notification_ids) > 100: self.close_notification(next(iter(self.notification_ids)))
            except GLib.Error:
                self.notice('Desktop popups are unavailable; unread messages remain marked in QuietChat.')
            finally: finished()
        self.connection.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
            GLib.Variant('(susssasa{sv}i)', ('QuietChat', 0, self.icon, title[:120], body, ['default', 'Open conversation'], hints, 6000)),
            GLib.VariantType.new('(u)'), Gio.DBusCallFlags.NONE, 3000, None, complete)

    def notification_event(self, _bus, _sender, _path, _interface, signal, parameters):
        args = parameters.unpack()
        if signal == 'ActionInvoked' and args[1] == 'default': self.show(self.notification_ids.get(args[0]))
        if signal == 'NotificationClosed':
            self.notification_ids.pop(args[0], None); self.save_notifications()

    def close(self):
        self.closed = True
        for ticket in self.pending_notifications: ticket['cancelled'] = True
        for notification_id in list(self.notification_ids): self.close_notification(notification_id)
        self.unread = 0; self.update_dock()
        if self.watch: Gio.bus_unwatch_name(self.watch)
        if self.owner: Gio.bus_unown_name(self.owner)
        if self.dock_watch: Gio.bus_unwatch_name(self.dock_watch)
        if self.notification_watch: Gio.bus_unwatch_name(self.notification_watch)
        if self.connection:
            if self.subscription: self.connection.signal_unsubscribe(self.subscription)
            for registration in self.registrations: self.connection.unregister_object(registration)
            self.connection.flush_sync(None)
