"""Run inside xvfb-run + dbus-run-session to verify the installed desktop app."""
import os
import ctypes
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
import sys


def descendants(pid):
    path = Path(f"/proc/{pid}/task/{pid}/children")
    try:
        children = [int(value) for value in path.read_text().split()]
    except FileNotFoundError:
        return []
    return children + [child for parent in children for child in descendants(parent)]


with tempfile.TemporaryDirectory(prefix="quietchat-desktop-test-") as temporary:
    env = dict(os.environ, TMPDIR=temporary, GDK_BACKEND="x11")
    env.pop('WAYLAND_DISPLAY', None)
    env['WINIT_UNIX_BACKEND'] = 'x11'
    command = Path.home() / ".local/bin/quietchat"
    with open(Path(temporary) / "terminal.log", "w+") as log:
        alacritty = '--alacritty' in sys.argv
        launch = ['alacritty', '--title', 'QuietChat', '--working-directory', '/tmp', '-e', 'bash', '-ic', 'quietchat --terminal --demo'] if alacritty else ['/usr/bin/python3', str(Path(__file__).resolve().parent / 'desktop.py'), '--demo']
        child = subprocess.Popen(launch, env=env,
                                 stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 20
            window = None
            app = None
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True, check=True).stdout
                window = re.search(r'(0x[0-9a-f]+) "QuietChat"', tree)
                for pid in descendants(child.pid):
                    try:
                        arguments = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
                        if "dist/src/main.js --demo" in arguments:
                            app = pid
                    except FileNotFoundError:
                        pass
                if window and app:
                    break
                time.sleep(0.2)
            log.seek(0)
            assert window and app, "Desktop terminal or demo app did not start: " + log.read() + '\n' + tree
            properties = subprocess.run(["xprop", "-id", window.group(1), "_GTK_APPLICATION_ID", "WM_CLASS"], capture_output=True, text=True, check=True).stdout
            if not alacritty:
                assert 'ch.aboimpinto.QuietChat' in properties, properties
            print(properties.strip())
            # Real physical Enter/Shift+Enter events, inside this isolated X display.
            x = ctypes.CDLL('libX11.so.6')
            xt = ctypes.CDLL('libXtst.so.6')
            x.XOpenDisplay.restype = ctypes.c_void_p
            display = x.XOpenDisplay(None)
            x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            x.XSetInputFocus(display, int(window.group(1), 16), 1, 0)
            x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x.XKeysymToKeycode.restype = ctypes.c_uint
            xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            x.XFlush.argtypes = [ctypes.c_void_p]

            def key(symbol, down):
                xt.XTestFakeKeyEvent(display, x.XKeysymToKeycode(display, symbol), down, 0)
                x.XFlush(display)
                time.sleep(0.04)

            def press(symbol):
                key(symbol, 1)
                key(symbol, 0)

            def count(text):
                databases = list(Path(temporary).glob('quietchat-demo-*/quietchat.db'))
                assert len(databases) == 1, 'Offline demo database missing'
                with sqlite3.connect(databases[0]) as db:
                    return db.execute('SELECT count(*) FROM messages WHERE text=?', (text,)).fetchone()[0]

            time.sleep(0.5)
            press(0xff0d)  # Open Alex's chat.
            for char in 'first':
                press(ord(char))
            key(0xffe1, 1)  # Shift
            press(0xff0d)
            key(0xffe1, 0)
            assert count('first') == 0, 'Physical Shift+Enter sent the message'
            for char in 'second':
                press(ord(char))
            press(0xff0d)
            time.sleep(0.3)
            assert count('first\nsecond') == 1, 'Physical Shift+Enter/Enter behavior failed'
            print('Physical Shift+Enter inserted a newline; Enter sent one multiline demo message.')
            press(0xffc5)  # F8: reply to the selected multiline message.
            for char in 'quoted reply':
                press(ord(char))
            assert count('quoted reply') == 0, 'F8 sent the draft'
            press(0xff0d)
            time.sleep(0.3)
            databases = list(Path(temporary).glob('quietchat-demo-*/quietchat.db'))
            with sqlite3.connect(databases[0]) as db:
                assert db.execute("SELECT quote FROM messages WHERE text='quoted reply'").fetchone() == ('first\nsecond',), 'F8/Enter did not quote the selected message'
            print('Physical F8 prepared a reply; Enter sent it with the original message quote.')
            if os.environ.get('QUIETCHAT_SCREENSHOT'):
                from PIL import ImageGrab
                geometry = subprocess.check_output(['xwininfo', '-id', window.group(1)], text=True)
                width = int(re.search(r'Width: (\d+)', geometry).group(1))
                height = int(re.search(r'Height: (\d+)', geometry).group(1))
                ImageGrab.grab(bbox=(0, 0, width, height), xdisplay=os.environ['DISPLAY']).save(os.environ['QUIETCHAT_SCREENSHOT'])
            if alacritty:
                assert not any('scripts/desktop.py' in Path(f'/proc/{pid}/cmdline').read_bytes().decode() for pid in descendants(child.pid) if Path(f'/proc/{pid}/cmdline').exists()), 'Terminal command opened a separate native window'
                print('quietchat resolved through Bash PATH from /tmp and ran inside Alacritty.')
            else:
                print("Installed desktop launcher opened the real offline app with QuietChat's application identity.")
        finally:
            # Only this test's dedicated process group/display/session is affected.
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
