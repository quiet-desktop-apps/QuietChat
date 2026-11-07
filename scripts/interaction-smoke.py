"""Verify native Alacritty clipboard selection/paste and application Ctrl+click links."""
import ctypes
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import json
import sqlite3
import gi

gi.require_version('Gdk', '3.0')
gi.require_version('GdkX11', '3.0')
gi.require_version('Gtk', '3.0')
from gi.repository import Gdk, GdkX11, Gtk

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


with tempfile.TemporaryDirectory(prefix='quietchat-interaction-') as folder:
    env = dict(os.environ, GDK_BACKEND='x11', WINIT_UNIX_BACKEND='x11')
    env.pop('WAYLAND_DISPLAY', None)
    bindir = Path(folder) / 'bin'
    bindir.mkdir()
    opener = bindir / 'xdg-open'
    opener.write_text('#!/usr/bin/python3\nimport json, os, sys\nopen(os.environ["QUIETCHAT_OPEN_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\n')
    opener.chmod(0o700)
    env['PATH'] = str(bindir) + os.pathsep + env['PATH']
    env['QUIETCHAT_OPEN_LOG'] = str(Path(folder) / 'opened.jsonl')
    with open(Path(folder) / 'terminal.log', 'w+') as log:
        child = subprocess.Popen(['alacritty', '--title', 'QuietChat interaction test',
            '-o', 'window.dimensions.columns=150', '-o', 'window.dimensions.lines=48',
            '-e', 'node', '--disable-warning=ExperimentalWarning', str(ROOT / 'dist/scripts/ui-fixture.js'), folder, '--interaction'],
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
            xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            cell_width, cell_height = window.get_width() / 150, window.get_height() / 48

            def point(col, row):
                xt.XTestFakeMotionEvent(display, -1, round((col + 0.5) * cell_width), round((row + 0.5) * cell_height), 0)
                x.XFlush(display); time.sleep(0.05)

            def button(down):
                xt.XTestFakeButtonEvent(display, 1, down, 0)
                x.XFlush(display); time.sleep(0.05)

            def snapshot():
                os.kill(app, signal.SIGHUP)
                time.sleep(0.15)
                return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", '', (Path(folder) / 'screen.txt').read_text()).splitlines()

            def find(text):
                return next((line.index(text), row) for row, line in enumerate(snapshot()) if text in line)

            def chord(letter):
                key(0xffe3, 1); key(0xffe1, 1)
                press(ord(letter))
                key(0xffe1, 0); key(0xffe3, 0)
                time.sleep(0.15)

            press(0xff0d)
            text = 'Copy this conversation text'
            col, row = find(text)
            point(col, row); key(0xffe1, 1); button(1)
            point(col + len(text), row); button(0); key(0xffe1, 0)
            # Idle status refreshes must not destroy native selection.
            time.sleep(2.2)
            chord('c')
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            copied = clipboard.wait_for_text()
            assert copied is not None and copied.rstrip(' ') == text, f'Native clipboard copy mismatch: {copied!r}'
            # Plain Ctrl+C should no longer exit while a user is trying to copy.
            key(0xffe3, 1); press(ord('c')); key(0xffe3, 0)
            assert child.poll() is None
            chord('v')
            time.sleep(0.3)
            with sqlite3.connect(Path(folder) / 'fixture.db') as db:
                assert db.execute('SELECT count(*) FROM messages WHERE mine=1').fetchone()[0] == 0, 'Paste sent a message'
            assert text in '\n'.join(snapshot()[-8:]), 'Clipboard text did not reach composer'
            press(0xff0d)
            with sqlite3.connect(Path(folder) / 'fixture.db') as db:
                assert db.execute('SELECT count(*) FROM messages WHERE mine=1 AND text=?', (copied,)).fetchone()[0] == 1

            # Click a wrapped continuation, not only the visible URL beginning.
            col, row = find('?x=1&y=$value')
            point(col + 2, row)
            button(1); button(0)
            logpath = Path(env['QUIETCHAT_OPEN_LOG'])
            assert not logpath.exists(), 'An ordinary click launched the browser'
            key(0xffe3, 1); button(1); button(0); key(0xffe3, 0)
            time.sleep(0.3)
            assert logpath.exists(), (Path(folder) / 'mouse.jsonl').read_text() + '\n' + '\n'.join(snapshot())
            opened = [json.loads(line) for line in logpath.read_text().splitlines()]
            expected = 'https://example.test/' + 'section/' * 18 + '?x=1&y=$value'
            assert opened == [[expected]], f'Wrong URL or duplicate opening: {opened!r}'
            print('Alacritty interactions passed: Shift+drag, Ctrl+Shift+C, clipboard access, Ctrl+Shift+V without sending, Ctrl+C stays open, Enter sends, Ctrl+click opens the full wrapped URL exactly once.')
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
