"""Compare incremental Alacritty pixels with a clean repaint, in isolated Xvfb."""
import ctypes
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import gi

gi.require_version('Gdk', '3.0')
gi.require_version('GdkX11', '3.0')
from gi.repository import Gdk, GdkX11
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
x = ctypes.CDLL('libX11.so.6')
xt = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
display = x.XOpenDisplay(None)
x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x.XResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_uint, ctypes.c_uint]
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XKeysymToKeycode.restype = ctypes.c_uint
xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]


def key(symbol, down):
    xt.XTestFakeKeyEvent(display, x.XKeysymToKeycode(display, symbol), down, 0)
    x.XFlush(display)
    time.sleep(0.015)


def press(symbol, shift=False):
    if shift: key(0xffe1, 1)
    key(symbol, 1); key(symbol, 0)
    if shift: key(0xffe1, 0)
    time.sleep(0.12)


with tempfile.TemporaryDirectory(prefix='quietchat-redraw-') as folder:
    env = dict(os.environ, GDK_BACKEND='x11', WINIT_UNIX_BACKEND='x11')
    env.pop('WAYLAND_DISPLAY', None)
    with open(Path(folder) / 'terminal.log', 'w+') as log:
        child = subprocess.Popen(['alacritty', '--title', 'QuietChat redraw test',
            '-o', 'window.dimensions.columns=150', '-o', 'window.dimensions.lines=48',
            '-e', 'node', '--disable-warning=ExperimentalWarning', str(ROOT / 'dist/scripts/ui-fixture.js'), folder, '--redraw-stress'],
            cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                tree = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True)
                match = re.search(r'(0x[0-9a-f]+) "QuietChat', tree)
                children = Path(f'/proc/{child.pid}/task/{child.pid}/children').read_text().split()
                if match and children and (Path(folder) / 'fixture.db').exists(): break
                time.sleep(0.1)
            assert match and children, 'Isolated Alacritty did not start'
            app = int(children[0])
            window_id = int(match.group(1), 16)
            x.XSetInputFocus(display, window_id, 1, 0)
            window = GdkX11.X11Window.foreign_new_for_display(Gdk.Display.get_default(), window_id)
            time.sleep(0.5)
            cell_height = window.get_height() / 48

            def capture():
                geometry = window.get_geometry()
                pixbuf = Gdk.pixbuf_get_from_window(window, 0, 0, geometry.width, geometry.height)
                mode = 'RGBA' if pixbuf.get_n_channels() == 4 else 'RGB'
                image = Image.frombytes(mode, (pixbuf.get_width(), pixbuf.get_height()), pixbuf.get_pixels(), 'raw', mode, pixbuf.get_rowstride()).convert('RGB')
                # Exclude the clock/RSS/status and composer cursor. Compare both panels,
                # their borders, all message text and background colors.
                return image.crop((0, round(cell_height * 3), image.width, round(image.height - cell_height * 9)))

            checks = []
            def check(name):
                time.sleep(0.15)
                before = capture()
                os.kill(app, signal.SIGCONT)  # Fixture only: force a clean baseline paint.
                time.sleep(0.15)
                after = capture()
                difference = ImageChops.difference(before, after)
                if difference.getbbox():
                    before.save(f'/tmp/quietchat-redraw-{name}-before.png')
                    after.save(f'/tmp/quietchat-redraw-{name}-after.png')
                    raise AssertionError(f'{name}: incremental frame differs from clean repaint at {difference.getbbox()}')
                checks.append(name)

            press(0xff0d)  # Open direct chat; long history scrolls to bottom.
            check('direct-open')
            press(0xff09, shift=True)  # Composer -> messages.
            press(0xff50); check('direct-home')
            press(0xff57); check('direct-end')
            for _ in range(8): press(0xff52)
            check('direct-selection')
            press(0xff55); check('older-page')
            press(0xff56); check('newer-page')
            for name, term in [('group', 'Weekend'), ('direct', 'Alex'), ('empty', 'Sam'), ('group-again', 'Weekend')]:
                press(0xffc6)  # F9 search.
                # Clear the previous search using backspace.
                for _ in range(8): press(0xff08)
                for letter in term: press(ord(letter))
                press(0xff0d); press(0xff0d)
                check(name)
            press(0xffc5); check('reply-preview')
            press(0xff1b); check('reply-cancel')
            x.XResizeWindow(display, window_id, 900, 720); x.XFlush(display)
            time.sleep(0.6); check('resize-smaller')
            x.XResizeWindow(display, window_id, 1350, 864); x.XFlush(display)
            time.sleep(0.6); check('resize-larger')
            print('Redraw pixel checks passed:', ', '.join(checks))
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
