"""Synthetic received attachments through GTK, real IPC, and isolated viewer stubs."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
os.environ.setdefault('GSK_RENDERER', 'cairo')
from app import QuietChat, Gtk, GLib


def pump():
    while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
    time.sleep(.01)


def wait(predicate, reason):
    end = time.monotonic() + 10
    while time.monotonic() < end:
        pump()
        if predicate(): return
    raise AssertionError(reason)


def widgets(widget):
    yield widget
    child = widget.get_first_child()
    while child:
        yield from widgets(child)
        child = child.get_next_sibling()


with tempfile.TemporaryDirectory(prefix='quietchat-received-test-') as temporary:
    folder = Path(temporary)
    log = folder / 'viewers.jsonl'
    os.environ['QUIETCHAT_VIEWER_LOG'] = str(log)
    os.environ['PATH'] = str(folder) + os.pathsep + os.environ['PATH']
    for name in ('mpv', 'xdg-open'):
        path = folder / name
        path.write_text('''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
log=Path(os.environ['QUIETCHAT_VIEWER_LOG'])
with log.open('a') as file: file.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')
sys.exit(3 if log.with_suffix('.fail').exists() else 0)
''')
        path.chmod(0o700)
    app = QuietChat(demo=True)
    app.register(None); app.activate()
    try:
        wait(lambda: app.ready and app.chat_rows, 'Demo did not start')
        app.open_chat_id('demo-alex@s.whatsapp.net')
        completed = []
        app.bridge.request('demoAttachments', lambda result, error: completed.append(error), chat=app.current['id'])
        wait(lambda: completed and any(m['kind'] == 'document' for m in app.messages), 'Attachments did not arrive')
        assert completed == [None]
        assert not log.exists(), 'Receiving an attachment launched a viewer automatically'
        for mid, title in [('audio', 'Play audio'), ('document', 'Open document')]:
            box = app.message_boxes[mid]
            assert not any(isinstance(w, Gtk.Picture) for w in widgets(box)), 'Attachment loaded a preview automatically'
            button = next(w for w in widgets(box) if isinstance(w, Gtk.Button) and w.get_label() == title)
            button.emit('clicked')
            count = 1 if mid == 'audio' else 2
            wait(lambda: log.exists() and len(log.read_text().splitlines()) == count, 'Viewer was not launched')
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        assert calls[0][0] == 'mpv' and calls[0][-2] == '--' and calls[0][-1].endswith('demo.wav')
        assert '--image-display-duration=inf' not in calls[0]
        assert calls[1] == ['xdg-open', str(ROOT / 'test/fixtures/demo.pdf')]
        assert 'Voice message' in next(m['text'] for m in app.messages if m['id'] == 'audio')
        assert 'Meeting notes.pdf' in next(m['text'] for m in app.messages if m['id'] == 'document')
        # A missing/broken viewer must report a useful failure, not silent success.
        log.with_suffix('.fail').touch()
        app.open_media(next(m for m in app.messages if m['id'] == 'document'))
        wait(lambda: 'No application could open this document' in app.status.get_text(), 'Viewer failure was not reported')
        print('Received voice/PDF: GTK controls, metadata, on-demand IPC opening, audio/document routing and viewer errors passed.')
    finally:
        app.shutdown()
