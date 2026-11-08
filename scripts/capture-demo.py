"""Capture the offline native UI under Xvfb; no account or real messages."""
import os
from pathlib import Path
import sys
import time
from PIL import ImageGrab
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from app import QuietChat, GLib


def pump(seconds=.1):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        time.sleep(.005)


app = QuietChat(demo=True)
app.register(None)
app.activate()
try:
    deadline = time.monotonic() + 15
    while not app.ready and time.monotonic() < deadline: pump()
    assert app.ready
    app.window.set_default_size(1120, 900)
    group = '--group' in sys.argv
    app.open_chat_id('demo-weekend@g.us' if group else 'demo-alex@s.whatsapp.net')
    pump(3)
    assert len(app.messages) >= (2 if group else 5)
    app.update_memory()
    pump(.5)
    target = Path(__file__).resolve().parents[1] / 'docs/images' / ('quietchat-group.png' if group else 'quietchat-desktop.png')
    ImageGrab.grab(bbox=(0, 0, app.window.get_surface().get_width(), app.window.get_surface().get_height()), xdisplay=os.environ['DISPLAY']).save(target)
    print(target.name)
finally:
    app.shutdown()
    pump(.3)
