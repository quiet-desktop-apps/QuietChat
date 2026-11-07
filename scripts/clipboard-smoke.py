"""Clipboard regression checks, called inside the isolated native desktop test."""
from pathlib import Path
import sys
import subprocess
from app import Gdk, GLib
from gi.repository import GObject
from clipboard_images import ClipboardImages


def exercise(app, root, press, pump, wait, row_count):
    clipboard = app.window.get_clipboard()
    fixture = root / 'test/fixtures/demo.png'
    # Model older GTK encoders that replace the file and discard mkstemp's mode.
    class ReplacingEncoder:
        def get_width(self): return 1
        def get_height(self): return 1
        def save_to_png(self, filename):
            path = Path(filename)
            path.unlink()
            path.write_bytes(fixture.read_bytes())
            path.chmod(0o644)
            return True
    private_images = ClipboardImages()
    encoded = []
    try:
        private_images.capture(ReplacingEncoder(), lambda path, error: encoded.append((path, error)))
        wait(lambda: bool(encoded), 'Replacement encoder did not finish')
        path, error = encoded[0]
        assert error is None and Path(path).stat().st_mode & 0o777 == 0o600
    finally:
        private_images.close()
    provider = Gdk.ContentProvider.new_for_bytes('image/png', GLib.Bytes.new(fixture.read_bytes()))
    clipboard.set_content(provider)
    app.composer.get_buffer().set_text('Clipboard screenshot caption')
    app.composer.grab_focus(); press(ord('v'), control=True)
    wait(lambda:app.attachment and not app.clipboard_paste, 'PNG clipboard did not attach')
    first = Path(app.attachment['path'])
    assert first.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    assert first.stat().st_mode & 0o777 == 0o600
    assert first.parent.stat().st_mode & 0o777 == 0o700
    assert app.attachment_thumbnail.get_paintable() and app.attachment_thumbnail.get_visible()
    assert app.text() == 'Clipboard screenshot caption' and row_count(app.text()) == 0, 'Paste must preserve caption and never send'
    if '--screenshot' in sys.argv:
        subprocess.run(['/usr/bin/python3', '-c', '''import gi
gi.require_version('Gdk','3.0')
from gi.repository import Gdk
window=Gdk.get_default_root_window()
Gdk.pixbuf_get_from_window(window,0,0,1120,800).savev('/tmp/quietchat-clipboard.png','png',[],[])
'''], check=True)
    app.open_chat_id('demo-sam@s.whatsapp.net'); pump(.15)
    assert app.attachment is None and first.exists()
    app.open_chat_id('demo-alex@s.whatsapp.net'); pump(.15)
    assert app.attachment['path'] == str(first), 'Switching chats lost the image draft'
    # Texture clipboard content and the terminal-style shortcut use the same flow.
    clipboard.set_content(Gdk.ContentProvider.new_for_value(GObject.Value(Gdk.Texture, Gdk.Texture.new_from_filename(str(fixture)))))
    app.composer.grab_focus(); press(ord('v'), control=True, shift=True)
    pump(.4)
    wait(lambda:app.attachment and app.attachment['path'] != str(first) and not app.clipboard_paste, 'Replacement paste failed')
    second = Path(app.attachment['path'])
    assert second.exists() and not first.exists(), 'Replaced temporary image leaked'
    original_request = app.bridge.request
    def fail_send(action, callback=None, **arguments):
        if action == 'send': GLib.idle_add(lambda:callback(None, 'Offline simulated failure'))
        else: original_request(action, callback, **arguments)
    app.bridge.request = fail_send
    press(0xff0d)
    wait(lambda:not app.busy, 'Failed send did not finish')
    assert second.exists() and app.attachment and app.text() == 'Clipboard screenshot caption'
    assert row_count(app.text()) == 0
    app.bridge.request = original_request
    press(0xff0d)
    wait(lambda:row_count('Clipboard screenshot caption') == 1 and not app.busy, 'Pasted image did not send on Enter')
    assert not app.attachment and not second.exists(), 'Sent clipboard draft was retained'
    wait(lambda:any(m['kind']=='image' and m['text']=='Clipboard screenshot caption' for m in app.messages), 'Sent image/caption missing')
    sent = next(m for m in app.messages if m['text']=='Clipboard screenshot caption')
    result = []
    app.bridge.request('thumbnail', lambda value,error:result.append((value,error)), chat=sent['chat'], message=sent['id'], download=True)
    wait(lambda:bool(result), 'Sent image could not be reopened')
    assert not result[0][1] and Path(result[0][0]['path']).exists()
    app.composer.grab_focus(); press(ord('v'), control=True)
    wait(lambda:app.attachment and not app.clipboard_paste, 'Second image paste failed')
    third = Path(app.attachment['path']); app.clear_attachment()
    assert not third.exists() and fixture.exists(), 'Removal must delete only owned clipboard files'
    # Delay encoding while switching chats; a completed async read must never
    # attach the screenshot to a different conversation or leave an orphan file.
    original_capture = app.clipboard_images.capture; delayed = []
    app.clipboard_images.capture = lambda texture, callback:delayed.append((texture,callback))
    app.composer.grab_focus(); press(ord('v'), control=True)
    wait(lambda:bool(delayed), 'Delayed clipboard read did not arrive')
    app.open_chat_id('demo-sam@s.whatsapp.net')
    app.clipboard_images.capture = original_capture
    original_capture(*delayed.pop())
    wait(lambda:not app.clipboard_images.pending, 'Canceled capture did not finish')
    assert app.attachment is None and not app.clipboard_images.paths, 'Stale image attached or leaked'
    app.open_chat_id('demo-alex@s.whatsapp.net'); pump(.15)
    clipboard.set('Text paste still works\nwithout sending')
    app.composer.grab_focus(); press(ord('v'), control=True)
    wait(lambda:app.text()=='Text paste still works\nwithout sending','Text paste regressed')
    assert app.attachment is None and row_count(app.text())==0
    app.composer.get_buffer().set_text('')
