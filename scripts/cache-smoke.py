"""Hidden UI lifetimes, late replies, on-disk previews and draft restoration."""
from pathlib import Path
from app import Gdk


def exercise(app, root, directory, pump, wait):
    wait(lambda: app.asset_running == 0 and app.avatar_request is None, 'Asset requests did not settle')
    pump(.3)
    cache = Path(directory) / 'native-previews'
    files = {path: (path.stat().st_size, path.stat().st_mtime_ns) for path in cache.glob('*.png')}
    assert files, 'No disk previews were prepared'
    # Keep a real clipboard attachment while releasing only its decoded thumbnail.
    captured = []
    app.clipboard_images.capture(Gdk.Texture.new_from_filename(str(root/'test/fixtures/demo.png')),
                                lambda path,error: captured.append((path,error)))
    wait(lambda: bool(captured), 'Clipboard fixture was not saved')
    path,error = captured[0]; assert path and not error
    app.set_attachment({'path':path, 'kind':'image', 'mime':'image/png', 'size':Path(path).stat().st_size, 'clipboard':True})
    app.composer.get_buffer().set_text('Keep this draft in the tray')
    app.start_reply(next(message for message in app.messages if message['id']=='welcome'))
    assert app.attachment_thumbnail.get_paintable()
    saved_chat = dict(app.current)
    old_messages = list(app.messages)
    old_chats = [dict(row.chat) for row in app.chat_rows.values()]
    old_rows = list(app.chat_rows.values())
    pending = []
    request = app.bridge.request
    def delay(action, callback=None, **args):
        if action in ('chats','messages','avatar'): pending.append((action,callback,args))
        else: request(action,callback,**args)
    app.bridge.request = delay
    app.refresh_chats(); app.refresh_messages(); app.load_header_avatar(app.current)
    app.chat_avatars.clear(); app.load_chat_avatars()
    app.bridge.request = request
    assert {action for action,_,_ in pending} == {'chats','messages','avatar'}
    app.hide_window()
    assert not app.messages and not app.message_boxes and not app.chat_rows and not app.chat_avatars
    assert all(row.avatar_image.get_paintable() is None for row in old_rows)
    assert app.attachment_thumbnail.get_paintable() is None and Path(path).exists()
    for action,callback,args in pending:
        if action=='chats': result={'chats':old_chats,'unread':0}
        elif action=='messages': result={'messages':old_messages,'name':saved_chat['name']}
        else: result={'path':str(root/'test/fixtures/demo.png')}
        if callback: callback(result,None)
    old_rows.clear(); old_messages.clear(); pending.clear()
    calls=[]
    def track(action, callback=None, **args):
        calls.append(action); request(action,callback,**args)
    app.bridge.request=track
    app.queue_refresh(); app.refresh_chats(); app.refresh_messages(); app.schedule_chat_avatars()
    wait(lambda: app.reclaim_source is None, 'Deferred cleanup did not finish')
    assert not calls, 'Hidden window fetched display-only data'
    assert not app.messages and not app.chat_rows and not app.chat_avatars, 'Late callback repopulated hidden UI'
    assert all(file.exists() and (file.stat().st_size,file.stat().st_mtime_ns)==metadata for file,metadata in files.items()), 'Hiding deleted or rewrote the disk cache'
    app.bridge.request=request
    app.show_chat(None)
    wait(lambda:len(app.messages)>=5 and app.chat_rows and app.asset_running==0 and app.avatar_request is None, 'Reopening did not restore UI')
    assert app.current['id']==saved_chat['id'] and app.text()=='Keep this draft in the tray'
    assert app.reply and app.reply['id']=='welcome'
    assert app.attachment['path']==path and app.attachment_thumbnail.get_paintable()
    assert all(file.stat().st_mtime_ns==metadata[1] for file,metadata in files.items()), 'Reopening regenerated valid cached previews'
    # Returning from the tray must not reset history position or mark an old page read.
    app.offset=60
    app.hide_window()
    delayed=[]
    def retain(action, callback=None, **args):
        if action=='messages': delayed.append(args)
        else: request(action,callback,**args)
    app.bridge.request=retain
    app.show_chat(None)
    assert app.offset==60 and delayed and delayed[0]['offset']==60
    app.bridge.request=request; app.offset=0; app.refresh_messages()
    wait(lambda:len(app.messages)>=5, 'Restoring the current page failed')
    app.clear_attachment(); app.cancel_reply(); app.composer.get_buffer().set_text('')
    app.save_draft()
    assert not Path(path).exists(), 'Removed clipboard draft was not cleaned up'
