"""Synced mutes through the real demo bridge and isolated notification daemon."""
import time
from app import Gtk, GLib


def exercise(app, pump, wait, notifications, closed, dock, defer, delayed):
    group, direct, loud = 'demo-weekend@g.us', 'demo-sam@s.whatsapp.net', 'demo-alex@s.whatsapp.net'
    original_request = app.bridge.request
    avatar_calls, held_avatars = [], []
    hold_avatar = [False]

    def request(action, callback=None, **args):
        if action == 'avatar':
            avatar_calls.append(args['chat'])
            if hold_avatar[0]:
                held_avatars.append((callback, args)); return
        original_request(action, callback, **args)

    def call(action, **args):
        result = []
        app.bridge.request(action, lambda value, error: result.append((value, error)), **args)
        wait(lambda: bool(result), 'Mute fixture command did not finish: ' + action)
        assert result[0][1] is None, result[0][1]
        return result[0][0]

    def labels(widget):
        if isinstance(widget, Gtk.Label): yield widget
        child = widget.get_first_child()
        while child:
            yield from labels(child)
            child = child.get_next_sibling()

    app.hide_window()
    for chat in (group, direct, loud): call('read', chat=chat)
    wait(lambda: app.desktop.unread == 0, 'Mute fixture did not start with clear badges')
    app.bridge.request = request
    try:
        before = len(notifications)
        for chat in (group, direct):
            call('demoMute', chat=chat, deadline=-1)
            call('demoIncoming', chat=chat, text='Muted fixture message')
        pump(.2)
        assert app.unread_chats[group] == app.unread_chats[direct] == 1
        assert app.desktop.unread == 0 and dock[-1][1]['count'] == 0
        assert app.desktop.property(None,None,None,'org.kde.StatusNotifierItem','Status').unpack() == 'Active'
        assert len(notifications) == before and not avatar_calls, 'Muted chat requested an avatar or popup'
        # Counts remain visible beside both muted chats, including direct chats.
        app.show_chat(loud)
        wait(lambda: group in app.chat_rows and direct in app.chat_rows, 'Sidebar did not load')
        for chat in (group, direct):
            assert app.chat_rows[chat].chat['unread'] == 1
            assert any(w.has_css_class('badge') and w.get_text() == '1' for w in labels(app.chat_rows[chat]))
        app.hide_window()
        call('demoIncoming', chat=loud, text='Unmuted fixture message')
        wait(lambda: len(notifications) == before+1 and app.desktop.unread == 1, 'Unmuted notification missing')
        assert dock[-1][1]['count'] == 1
        wait(lambda: any(c == loud for c in app.desktop.notification_ids.values()), 'Notification ID was not returned')
        popup = next(i for i,c in app.desktop.notification_ids.items() if c == loud)
        call('demoMute', chat=loud, deadline=-1)
        wait(lambda: popup in closed and app.desktop.unread == 0, 'Muting did not withdraw existing popup and badges')
        assert app.unread_chats[loud] == 1
        call('demoMute', chat=loud, deadline=None)
        wait(lambda: app.desktop.unread == 1, 'Unmute did not restore unread badge')
        assert len(notifications) == before+1, 'Unmute replayed old notifications'
        call('demoMute', chat=group, deadline=int(time.time()*1000)+700)
        wait(lambda: app.desktop.unread == 2, 'Mute expiry did not update badges while idle')
        assert len(notifications) == before+1, 'Expiry replayed old notifications'
        call('demoIncoming', chat=group, text='After mute expiry')
        wait(lambda: len(notifications) == before+2 and app.desktop.unread == 3, 'Expired mute blocked a new popup')
        # Mute arrives while the avatar fetch is still pending.
        call('demoMute', chat=direct, deadline=None)
        hold_avatar[0] = True
        call('demoIncoming', chat=direct, text='Pending avatar race')
        wait(lambda: bool(held_avatars), 'Avatar request was not held')
        call('demoMute', chat=direct, deadline=-1)
        hold_avatar[0] = False
        callback, args = held_avatars.pop(); original_request('avatar', callback, **args)
        wait(lambda: not app.desktop.pending_notifications, 'Cancelled popup was not released')
        assert len(notifications) == before+2 and app.desktop.unread == 3
        # Mute arrives after Notify is sent, before the daemon acknowledges it.
        defer[0] = True
        call('demoIncoming', chat=loud, text='Pending notification reply race')
        wait(lambda: bool(delayed), 'Daemon did not hold the popup reply')
        call('demoMute', chat=loud, deadline=-1)
        invocation, notification_id = delayed.pop()
        invocation.return_value(GLib.Variant('(u)', (notification_id,))); defer[0] = False
        wait(lambda: notification_id in closed, 'Mute did not close the late popup')
        assert app.desktop.unread == 2 and dock[-1][1]['count'] == 2
        # Old snapshots cannot restore muted counts.
        assert not app.apply_unread({'revision':app.unread_revision-1, 'unread_chats':{direct:99}, 'notification_chats':{direct:99}})
        assert app.desktop.unread == 2
        for chat in (group, direct, loud):
            call('read', chat=chat); call('demoMute', chat=chat, deadline=None)
        wait(lambda: app.desktop.unread == 0, 'Cleanup did not clear badges')
        app.show_chat(loud)
    finally:
        app.bridge.request = original_request
        defer[0] = False
