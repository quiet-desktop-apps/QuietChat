"""Offline GTK4 integration, real clipboard/keys, fake tray watcher + notification daemon."""
import os
os.environ.setdefault('GSK_RENDERER','cairo')
import sys
from pathlib import Path
import time
import sqlite3
import ctypes
import json
import gc

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
from app import QuietChat, Gtk, Gdk, Gio, GLib, resident
import gi
gi.require_version('GdkX11', '4.0')
from gi.repository import GdkX11

WATCHER_XML = '''<node><interface name="org.kde.StatusNotifierWatcher"><method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method></interface></node>'''
NOTIFY_XML = '''<node><interface name="org.freedesktop.Notifications"><method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method><method name="CloseNotification"><arg type="u" direction="in"/></method><signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal><signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal></interface></node>'''
context = GLib.MainContext.default()
def pump(seconds=.1):
    end = time.monotonic()+seconds
    while time.monotonic()<end:
        while context.pending(): context.iteration(False)
        time.sleep(.005)

def wait(predicate, reason, timeout=8):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        pump(.04)
        if predicate(): return
    raise AssertionError(reason)

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
notifications=[]; registered=[]; closed_notifications=[]; dock_updates=[]; tray_updates=[]; delayed_notifications=[]; defer_notifications=[False]
def watcher(_bus,_sender,_path,_interface,_method,args,invocation):
    registered.append(args.unpack()[0]); invocation.return_value(None)
def notification(_bus,_sender,_path,_interface,_method,args,invocation):
    if _method=='CloseNotification':
        closed_notifications.append(args.unpack()[0]); invocation.return_value(None)
        bus.emit_signal(None,'/org/freedesktop/Notifications','org.freedesktop.Notifications','NotificationClosed',GLib.Variant('(uu)',(args.unpack()[0],3)))
    else:
        notifications.append(args.unpack())
        if defer_notifications[0]: delayed_notifications.append((invocation,len(notifications)))
        else: invocation.return_value(GLib.Variant('(u)',(len(notifications),)))
regs=[bus.register_object('/StatusNotifierWatcher',Gio.DBusNodeInfo.new_for_xml(WATCHER_XML).interfaces[0],watcher,None,None),
      bus.register_object('/org/freedesktop/Notifications',Gio.DBusNodeInfo.new_for_xml(NOTIFY_XML).interfaces[0],notification,None,None)]
owners=[Gio.bus_own_name_on_connection(bus,name,Gio.BusNameOwnerFlags.NONE,None,None) for name in ('org.kde.StatusNotifierWatcher','org.freedesktop.Notifications')]
bus.signal_subscribe(None,'com.canonical.Unity.LauncherEntry','Update',None,None,Gio.DBusSignalFlags.NONE,lambda *args:dock_updates.append(args[-1].unpack()))
bus.signal_subscribe(None,'org.freedesktop.DBus.Properties','PropertiesChanged','/StatusNotifierItem',None,Gio.DBusSignalFlags.NONE,lambda *args:tray_updates.append(args[-1].unpack()))
pump(.2)
app=QuietChat(demo=True)
app.register(None); app.activate()

x=ctypes.CDLL('libX11.so.6'); xt=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p; display=x.XOpenDisplay(None)
x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong]; x.XKeysymToKeycode.restype=ctypes.c_uint
x.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x.XFlush.argtypes=[ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
xt.XTestFakeMotionEvent.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_ulong]
xt.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
def focus():
    xid=GdkX11.X11Surface.get_xid(app.window.get_surface())
    x.XSetInputFocus(display,xid,1,0); x.XFlush(display); pump(.1)
def key(symbol, down):
    xt.XTestFakeKeyEvent(display,x.XKeysymToKeycode(display,symbol),down,0); x.XFlush(display); pump(.025)
def press(symbol, control=False, shift=False):
    if control:key(0xffe3,1)
    if shift:key(0xffe1,1)
    key(symbol,1);key(symbol,0)
    if shift:key(0xffe1,0)
    if control:key(0xffe3,0)
    pump(.1)
def clipboard():
    result=[]
    def ready(clip,event): result.append(clip.read_text_finish(event))
    app.window.get_clipboard().read_text_async(None,ready)
    wait(lambda:bool(result),'clipboard did not respond')
    return result[0]
def widgets(widget):
    yield widget
    child=widget.get_first_child()
    while child:
        yield from widgets(child); child=child.get_next_sibling()
def row_count(text):
    with sqlite3.connect(Path(state_dir)/'quietchat.db') as db:
        return db.execute('SELECT count(*) FROM messages WHERE text=?',(text,)).fetchone()[0]

try:
    wait(lambda:app.ready and len(app.chat_rows)==4 and app.desktop.available,'native startup/tray registration failed')
    # The ready frame's temporary state directory can be derived from this child only.
    matches=list(Path('/tmp').glob('quietchat-native-demo-*/instance.lock'))
    state_dir=next(path.parent for path in matches if path.read_text().strip()==str(app.bridge.process.pid))
    assert registered==['/StatusNotifierItem']
    menu_result=[]
    def menu_done(connection,result): menu_result.append(connection.call_finish(result).unpack())
    bus.call(bus.get_unique_name(),'/MenuBar','com.canonical.dbusmenu','GetLayout',GLib.Variant('(iias)',(0,-1,[])),None,Gio.DBusCallFlags.NONE,2000,None,menu_done)
    wait(lambda:bool(menu_result),'tray menu protocol failed')
    assert len(menu_result[0][1][2])==2
    wait(lambda:all(row.avatar_image.get_paintable() for row in app.chat_rows.values()), 'chat list photos missing')
    assert all(row.avatar_image.get_paintable().get_intrinsic_width() == row.avatar_image.get_paintable().get_intrinsic_height() == 36 for row in app.chat_rows.values())
    app.open_chat_id('demo-alex@s.whatsapp.net')
    wait(lambda:len(app.messages)>=5 and app.asset_running==0,'chat/thumbnail load failed')
    focus(); pump(.2)
    import runpy
    runpy.run_path(str(ROOT/'scripts/accent-smoke.py'))['exercise'](app, press, pump, row_count)
    assert any(isinstance(w,Gtk.Picture) and w.get_paintable() for w in widgets(app.message_list)), 'Media thumbnails are missing'
    if '--screenshot' in sys.argv:
        import subprocess
        subprocess.run(['/usr/bin/python3','-c', '''import gi
gi.require_version('Gdk','3.0')
from gi.repository import Gdk
window=Gdk.get_default_root_window()
image=Gdk.pixbuf_get_from_window(window,0,0,1120,800)
image.savev('/tmp/quietchat-native.png','png',[],[])
'''],check=True)
    body=next(w for w in widgets(app.message_list) if isinstance(w,Gtk.Label) and w.get_text().startswith('A proper native window.'))
    # Physical mouse drag across part of a message, without Shift or other modifiers.
    adj=app.message_scroll.get_vadjustment(); adj.set_value(adj.get_upper()-adj.get_page_size()); pump(.15)
    ok, bounds=body.compute_bounds(app.window); assert ok
    ox,oy=body.get_layout_offsets()
    def position(index):
        rect=body.get_layout().index_to_pos(index)
        return int(bounds.get_x()+ox+rect.x/1024),int(bounds.get_y()+oy+(rect.y+rect.height/2)/1024)
    sx,sy=position(2); ex,ey=position(15)
    xt.XTestFakeMotionEvent(display,-1,sx,sy,0); x.XFlush(display); pump(.05)
    xt.XTestFakeButtonEvent(display,1,1,0); x.XFlush(display); pump(.05)
    for step in range(1,11):
        xt.XTestFakeMotionEvent(display,-1,sx+(ex-sx)*step//10,sy+(ey-sy)*step//10,0)
        x.XFlush(display); pump(.02)
    xt.XTestFakeButtonEvent(display,1,0,0); x.XFlush(display); pump(.05)
    press(ord('c'),control=True)
    copied=clipboard(); selected,start,end=body.get_selection_bounds()
    assert selected and copied==body.get_text()[start:end] and 8<=len(copied)<=16,repr(copied)
    app.composer.grab_focus(); press(ord('v'),control=True)
    wait(lambda:app.text()==copied,'native Ctrl+V paste failed')
    assert row_count(copied)==0,'paste sent the draft'
    press(0xff0d,shift=True)
    assert app.text()==copied+'\n','Shift+Enter did not add a line'
    for ch in 'second': press(ord(ch))
    draft=app.text(); press(0xff0d)
    wait(lambda:row_count(draft)==1 and not app.busy,'Enter did not send')
    import runpy
    runpy.run_path(str(ROOT/'scripts/clipboard-smoke.py'))['exercise'](app, ROOT, press, pump, wait, row_count)
    app.select_message('welcome'); press(0xffc5)
    assert app.reply and app.reply['id']=='welcome'
    app.composer.get_buffer().set_text('Native quoted reply')
    press(0xff0d)
    wait(lambda:row_count('Native quoted reply')==1 and not app.reply,'quoted send failed')
    with sqlite3.connect(Path(state_dir)/'quietchat.db') as db:
        assert db.execute("SELECT quote FROM messages WHERE text='Native quoted reply'").fetchone()[0].startswith('Welcome')
    app.composer.get_buffer().set_text('Alex draft'); app.start_reply(next(m for m in app.messages if m['id']=='welcome'))
    app.open_chat_id('demo-sam@s.whatsapp.net'); wait(lambda:app.current['id'].startswith('demo-sam') and not app.messages,'switch to empty chat failed')
    assert app.text()=='' and app.reply is None
    app.open_chat_id('demo-alex@s.whatsapp.net'); wait(lambda:len(app.messages)>=5,'switch back failed')
    assert app.text()=='Alex draft' and app.reply['id']=='welcome'
    app.cancel_reply(); assert app.text()=='Alex draft'
    app.copy_conversation(); assert 'Welcome to QuietChat' in clipboard()
    # Test actual pointer activation; replace only the external browser launch.
    adj=app.message_scroll.get_vadjustment(); adj.set_value(adj.get_upper()-adj.get_page_size()); pump(.2)
    link_body=next(w for w in widgets(app.message_list) if isinstance(w,Gtk.Label) and w.get_text().startswith('Let’s keep this simple:'))
    ok, link_bounds=link_body.compute_bounds(app.message_list); assert ok
    adj.set_value(max(0,link_bounds.get_y()-100)); pump(.2)
    captured=[]; launch_link=app.open_link; app.open_link=lambda url: captured.append(url) or True
    ok,bounds=link_body.compute_bounds(app.window); assert ok
    ox,oy=link_body.get_layout_offsets(); index=len(link_body.get_text().split('https:')[0].encode())+8
    rect=link_body.get_layout().index_to_pos(index)
    px=int(bounds.get_x()+ox+rect.x/1024); py=int(bounds.get_y()+oy+(rect.y+rect.height/2)/1024)
    xt.XTestFakeMotionEvent(display,-1,px,py,0); x.XFlush(display); pump(.05)
    xt.XTestFakeButtonEvent(display,1,1,0); xt.XTestFakeButtonEvent(display,1,0,0); x.XFlush(display); pump(.1)
    assert captured==['https://example.com/native-chat'], 'Click did not activate the complete URL'
    app.open_link=launch_link
    app.load_url_preview('native-link','https://example.com/native-chat')
    wait(lambda:app.preview_targets.get('native-link',[None])[0].get_text()=='A native link preview','URL preview failed')
    # The preview adds an image below the link. Bring the reaction button into
    # view after layout; GTK versions/fonts give this card different heights.
    pump(.2)
    react_button=app.reaction_buttons['native-link']
    ok, react_bounds=react_button.compute_bounds(app.message_list); assert ok
    adj.set_value(max(0,react_bounds.get_y()-adj.get_page_size()/2)); pump(.2)
    ok, react_bounds=react_button.compute_bounds(app.message_scroll); assert ok
    assert 0 <= react_bounds.get_y() < app.message_scroll.get_height(), 'Reaction anchor is outside the viewport'
    app.select_message('native-link'); app.composer.grab_focus(); pump(.1); press(0xffc3)  # F6 opens lazy reaction picker.
    popover=app.reaction_buttons['native-link'].get_popover()
    assert popover and popover.get_visible(), f'Reaction picker did not open: {popover}'
    next(w for w in widgets(popover) if isinstance(w,Gtk.Button) and w.get_label()=='👍').emit('clicked')
    wait(lambda:any(m['id']=='native-link' and '👍' in m.get('reactions','') for m in app.messages),'reaction failed')
    # Participant names and mentions use actual pointer activation, preserve drafts,
    # and open a private conversation without sending the group draft.
    def click_label_text(widget, text):
        pump(.15)
        adjustment = app.message_scroll.get_vadjustment()
        ok, location = widget.compute_bounds(app.message_list); assert ok
        adjustment.set_value(max(0, location.get_y()-80)); pump(.15)
        ok, bounds = widget.compute_bounds(app.window); assert ok
        ox, oy = widget.get_layout_offsets()
        index = len(widget.get_text().split(text)[0].encode('utf8')) + 1
        rect = widget.get_layout().index_to_pos(index)
        px = int(bounds.get_x()+ox+rect.x/1024)
        py = int(bounds.get_y()+oy+(rect.y+rect.height/2)/1024)
        xt.XTestFakeMotionEvent(display,-1,px,py,0); x.XFlush(display); pump(.05)
        xt.XTestFakeButtonEvent(display,1,1,0); xt.XTestFakeButtonEvent(display,1,0,0); x.XFlush(display); pump(.1)

    group = 'demo-weekend@g.us'
    app.open_chat_id(group)
    wait(lambda: len(app.messages)==3, 'Group fixture did not load')
    assert [m['sender'] for m in app.messages] == ['Ada (work)', 'Lin', 'Unknown participant (…0003)']
    assert '@Ada (work)' in app.messages[1]['text'] and '@Lin' in app.messages[1]['text']
    assert app.messages[1]['senderId']=='140000002@lid'
    assert app.messages[1]['quote']=='Thanks @You!'
    assert app.messages[2]['senderId']=='144400003@lid'
    app.composer.get_buffer().set_text('Group draft kept')
    app.copy_conversation()
    assert '@Ada (work)' in clipboard() and '@140000001' not in clipboard()
    author = next(w for w in widgets(app.message_boxes['group-saved']) if isinstance(w,Gtk.Label) and w.get_text()=='Ada (work)')
    click_label_text(author, 'Ada')
    wait(lambda: app.current['id']=='140000001@lid' and not app.messages, 'Clicking saved sender did not open its direct chat')
    assert app.text()=='' and row_count('Group draft kept')==0
    app.open_chat_id(group)
    wait(lambda: len(app.messages)==3, 'Returning to group failed')
    assert app.text()=='Group draft kept'
    body = next(w for w in widgets(app.message_boxes['group-profile']) if isinstance(w,Gtk.Label) and 'Hi @Ada' in w.get_text())
    click_label_text(body, '@Lin')
    wait(lambda: app.current['id']=='140000002@lid' and not app.messages, 'Mention click did not open profile-only person')
    app.open_chat_id(group); wait(lambda: len(app.messages)==3, 'Group reload failed')
    assert app.text()=='Group draft kept' and row_count('Group draft kept')==0
    body = next(w for w in widgets(app.message_boxes['group-profile']) if isinstance(w,Gtk.Label) and 'Hi @Ada' in w.get_text() and '@You' in w.get_text())
    click_label_text(body, '@You')
    wait(lambda: app.current['id']=='447700900099@s.whatsapp.net' and app.current['name']=='You', 'Self mention did not open You chat')
    app.open_chat_id('447700900099@s.whatsapp.net')
    wait(lambda: app.current['id']=='447700900099@s.whatsapp.net' and app.current['name']=='You', 'Self chat was not labeled You')
    app.open_chat_id(group); wait(lambda: len(app.messages)==3, 'Group reload for unknown participant failed')
    unknown = next(w for w in widgets(app.message_boxes['group-unknown']) if isinstance(w,Gtk.Label) and w.get_text()=='Unknown participant (…0003)')
    click_label_text(unknown, 'Unknown')
    wait(lambda: app.current['id']=='144400003@lid' and app.current['name']=='Unknown participant (…0003)', 'Unknown participant lost its direct-chat identity')
    # Profile text remains literal even when it looks like Pango markup.
    from app import markup
    escaped = Gtk.Label()
    escaped.set_markup(markup('', [{'text':'@José & <b>Ana</b>', 'jid':'123@lid'}]))
    assert escaped.get_text()=='@José & <b>Ana</b>'
    app.open_chat_id('demo-alex@s.whatsapp.net'); wait(lambda: len(app.messages)>=5, 'Return to direct chat failed')
    app.bridge.request('demoQr')
    wait(lambda:app.content_stack.get_visible_child_name()=='qr' and app.qr_picture.get_paintable(),'native QR missing')
    assert (Path(state_dir)/'native-pairing.png').stat().st_mode & 0o777 == 0o600
    app.bridge.request('demoQr',clear=True)
    wait(lambda:app.content_stack.get_visible_child_name()=='messages' and not (Path(state_dir)/'native-pairing.png').exists(),'QR did not clear')
    pump(.3)
    baseline=resident(os.getpid())+resident(app.bridge.process.pid)
    for _ in range(10):
        app.open_chat_id('demo-sam@s.whatsapp.net'); wait(lambda:not app.messages,'inactive page was retained')
        app.open_chat_id('demo-alex@s.whatsapp.net'); wait(lambda:len(app.messages)>=5 and app.asset_running==0,'switch reload failed')
    gc.collect(); pump(.3)
    after=resident(os.getpid())+resident(app.bridge.process.pid)
    assert after-baseline<40*1048576,f'Repeated chat switches grew RSS by {(after-baseline)/1048576:.1f} MiB'
    runpy.run_path(str(ROOT/'scripts/cache-smoke.py'))['exercise'](app, ROOT, state_dir, pump, wait)
    app.window.close(); pump(.2)
    assert not app.window.get_visible() and not app.messages and not app.message_boxes,'close did not hide/release the page'
    app.bridge.request('demoIncoming',chat='demo-sam@s.whatsapp.net',text='Offline notification test 👋')
    wait(lambda:len(notifications)==1 and app.desktop.unread>0,'tray/popup missing')
    assert not app.chat_rows and not app.chat_avatars and not app.messages, 'Notification recreated hidden display widgets'
    popup=notifications[0]
    assert popup[3]=='Sam · demo' and 'Offline notification test' in popup[4]
    assert 'image-path' in popup[6] and Path(popup[6]['image-path']).exists(),'avatar missing from notification'
    assert app.desktop.property(None,None,None,'org.kde.StatusNotifierItem','Status').unpack()=='NeedsAttention'
    bus.emit_signal(None,'/org/freedesktop/Notifications','org.freedesktop.Notifications','ActionInvoked',GLib.Variant('(us)',(1,'default')))
    wait(lambda:app.window.get_visible() and app.current['id']=='demo-sam@s.whatsapp.net','notification click did not open its chat')
    focus();app.mark_read();wait(lambda:app.desktop.unread==0,'read did not clear tray badge')
    wait(lambda:1 in closed_notifications,'Reading did not dismiss the old popup/dock notification')
    runpy.run_path(str(ROOT/'scripts/badge-smoke.py'))['exercise'](app, pump, wait, notifications, closed_notifications, dock_updates, tray_updates, defer_notifications, delayed_notifications, state_dir)
    # Large sidebar: only visible rows load; missing photos retain initials and are cached.
    wait(lambda:app.avatar_request is None,'avatar request did not finish')
    original_request=app.bridge.request
    avatar_calls=[]
    fake_chats=[{'id':f'avatar-{i}', 'name':f'Contact {i}', 'preview':'', 'unread':0} for i in range(80)]
    def sidebar_request(action,callback=None,**args):
        if action=='chats': GLib.idle_add(lambda:callback({'chats':fake_chats,'unread':0},None))
        elif action=='avatar' and args.get('chat','').startswith('avatar-'):
            avatar_calls.append(args['chat'])
            value={'path':None if args['chat']=='avatar-0' else str(ROOT/'test/fixtures/demo.png')}
            GLib.idle_add(lambda:callback(value,None))
        else: original_request(action,callback,**args)
    app.bridge.request=sidebar_request; app.chat_fingerprint=None; app.chat_avatars.clear(); app.refresh_chats()
    wait(lambda:'avatar-1' in app.chat_rows and app.chat_rows['avatar-1'].avatar_image.get_paintable(),'visible sidebar photo missing')
    pump(1.4)
    assert len(avatar_calls)<20, f'Loaded offscreen avatars: {len(avatar_calls)}'
    assert app.chat_rows['avatar-0'].avatar_stack.get_visible_child_name()=='initial'
    assert app.chat_rows['avatar-1'].avatar_stack.get_width()==36, 'Avatar must remain a small circle'
    app.chat_fingerprint=None; app.refresh_chats(); pump(.4)
    assert avatar_calls.count('avatar-0')==1, 'Unavailable photo was requested again on refresh'
    sidebar_adj=app.chat_scroll.get_vadjustment()
    sidebar_adj.set_value(sidebar_adj.get_upper()-sidebar_adj.get_page_size())
    wait(lambda:app.chat_rows['avatar-79'].avatar_image.get_paintable(),'scrolling did not load newly visible photo')
    assert not app.chat_rows['avatar-1'].avatar_image.get_paintable(), 'Offscreen row retained its texture'
    assert 'avatar-1' not in app.chat_avatars, 'Offscreen texture survived in the RAM cache'
    assert len(avatar_calls)<35, 'Scrolling loaded unrelated rows'
    app.bridge.request=original_request
    print(json.dumps({'native_smoke':'passed','checks':['GTK4 startup','group sender and profile names','clickable participant names and mentions','mention copy and escaped names','group drafts survive direct-chat navigation','saved-backend protocol','physical mouse drag and Ctrl+C/V','F6 reaction','native QR lifecycle','paste does not send','clipboard PNG/texture paste and caption','clipboard draft switching/replacement/removal','clipboard failed-send retention and cleanup','clipboard async chat-switch cancellation','Enter/Shift+Enter','Portuguese dead keys and Unicode composition','composition cancellation','quoted replies','per-chat drafts','copy chat','media thumbnails','chat list profile photos','lazy avatar scrolling and fallback','clickable URL','URL preview','tray menu protocol','bounded chat switching','close to tray','hidden widget/avatar release','disk-cache and clipboard draft retention','late hidden callback rejection','history position restored','new-message badge','popup body/avatar','notification activation/read badge','red numbered tray and dock counters','notification dismissal and late-read races','notification ID recovery'],
          'ui_rss_mib':round(resident(os.getpid())/1048576,1),'backend_rss_mib':round(resident(app.bridge.process.pid)/1048576,1),'total_rss_mib':round(after/1048576,1),'switch_growth_mib':round((after-baseline)/1048576,1)},indent=2))
finally:
    clipboard_directory = Path(app.clipboard_images.directory.name) if app.clipboard_images.directory else None
    app.shutdown();pump(.1)
    assert clipboard_directory is None or not clipboard_directory.exists(), 'Clipboard directory survived shutdown'
    for owner in owners:Gio.bus_unown_name(owner)
    for registration in regs:bus.unregister_object(registration)
