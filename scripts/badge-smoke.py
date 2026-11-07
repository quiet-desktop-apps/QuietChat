"""Unread indicator regressions against the native test's isolated D-Bus host."""
from pathlib import Path
from app import GLib


def exercise(app, pump, wait, notifications, closed, dock, tray, defer, delayed, directory):
    desktop = app.desktop
    pump(.3)
    assert dock[-1][1]['count']==0 and not dock[-1][1]['count-visible']
    for count, suffix in ((1,'1'),(9,'9'),(10,'10'),(24,'24'),(99,'99'),(100,'plus99'),(1000,'plus99'),(99,'99'),(0,None)):
        desktop.reconcile_unread({'badge-test':count} if count else {})
        pump(.05)
        name = desktop.property(None,None,None,'org.kde.StatusNotifierItem','IconName').unpack()
        assert name.endswith('-'+suffix) if suffix else name=='ch.aboimpinto.QuietChat'
        assert desktop.property(None,None,None,'org.kde.StatusNotifierItem','AttentionIconName').unpack()==name
        assert dock[-1][0]=='application://ch.aboimpinto.QuietChat.desktop'
        assert dock[-1][1]['count']==count and dock[-1][1]['count-visible']==bool(count)
    assert tray[-1][1]['Status']=='Active'
    assert tray[-1][1]['IconName']==tray[-1][1]['AttentionIconName']=='ch.aboimpinto.QuietChat'
    # The old count must not return when an earlier query completes after a read.
    assert not app.apply_unread({'revision':app.unread_revision-1,'unread_chats':{'stale-chat':4}})
    assert desktop.unread==0
    # Cancel a notification while its avatar is still being fetched.
    before=len(notifications)
    ticket=desktop.begin_notification('avatar-race')
    desktop.reconcile_unread({})
    desktop.notify('avatar-race','Old message','Already read',ticket=ticket)
    pump(.1); assert len(notifications)==before
    # Cancel after Notify was sent but before the daemon returns its notification ID.
    defer[0]=True
    desktop.reconcile_unread({'reply-race':1})
    desktop.notify('reply-race','Delayed popup','Already read before acknowledgement')
    wait(lambda:bool(delayed),'Notify was not dispatched')
    desktop.reconcile_unread({})
    invocation, notification_id=delayed.pop()
    invocation.return_value(GLib.Variant('(u)',(notification_id,))); defer[0]=False
    wait(lambda:notification_id in closed,'Late notification recreated the dock badge')
    # Reading one chat must leave another chat's notification and count intact.
    desktop.reconcile_unread({'chat-a':1,'chat-b':1})
    desktop.notify('chat-a','A','One'); desktop.notify('chat-b','B','Two')
    wait(lambda:len(desktop.notification_ids)==2,'Notification bookkeeping missing')
    a=next(i for i,c in desktop.notification_ids.items() if c=='chat-a')
    b=next(i for i,c in desktop.notification_ids.items() if c=='chat-b')
    desktop.reconcile_unread({'chat-b':1})
    wait(lambda:a in closed,'Read chat notification was not dismissed')
    assert b not in closed and desktop.unread==1
    # IDs survive app restart, but must never be reused after the daemon restarts.
    state=Path(directory)/'native-notifications.json'
    assert state.exists() and state.stat().st_mode & 0o777==0o600
    desktop.notification_ids.clear(); desktop.configure_notifications(directory)
    assert desktop.notification_ids.get(b)=='chat-b'
    desktop.reconcile_unread({}); wait(lambda:b in closed,'Restored notification was not dismissed')
    desktop.notification_ids[987654]='stale-daemon'
    original_owner=desktop.notification_owner
    desktop.notification_service_appeared(None,None,':different-daemon')
    assert not desktop.notification_ids and 987654 not in closed
    desktop.notification_service_appeared(None,None,original_owner)
    pump(.1)
    assert desktop.unread==0 and dock[-1][1]['count']==0
