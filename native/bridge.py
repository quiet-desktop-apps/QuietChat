"""Bounded IPC to the existing WhatsApp transport; no account data enters Python logs."""
import json
import queue
import subprocess
import threading
from pathlib import Path
from gi.repository import GLib

ROOT = Path(__file__).resolve().parents[1]


class Bridge:
    def __init__(self, args, on_event):
        self.events = queue.Queue(maxsize=128)
        self.callbacks = {}
        self.sequence = 0
        self.closed = False
        self.on_event = on_event
        self.process = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'dist/src/native-bridge.js'), *args],
                                        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.timer = GLib.timeout_add(35, self.poll)

    def read(self):
        try:
            while not self.closed:
                line = self.process.stdout.readline(2 * 1024 * 1024)
                if not line: break
                if not line.endswith('\n'): raise ValueError('Oversized response')
                self.events.put(json.loads(line))
        except (ValueError, OSError):
            self.events.put({'type': 'fatal', 'message': 'The connection returned an invalid response.'})
        finally:
            if not self.closed: self.events.put({'type': 'stopped'})

    def request(self, action, callback=None, **arguments):
        if self.closed or self.process.poll() is not None:
            if callback: GLib.idle_add(lambda: callback(None, 'The connection is closed.'))
            return
        if len(self.callbacks) >= 32:
            if callback: GLib.idle_add(lambda: callback(None, 'Too many pending actions. Try again.'))
            return
        self.sequence += 1
        self.callbacks[self.sequence] = callback
        try:
            self.process.stdin.write(json.dumps({'id': self.sequence, 'action': action, **arguments}) + '\n')
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            self.callbacks.pop(self.sequence, None)
            if callback: GLib.idle_add(lambda: callback(None, 'The connection stopped.'))

    def poll(self):
        if self.closed: return GLib.SOURCE_REMOVE
        for _ in range(32):
            try: event = self.events.get_nowait()
            except queue.Empty: break
            if event['type'] == 'response':
                callback = self.callbacks.pop(event.get('id'), None)
                if callback: callback(event.get('result'), event.get('error'))
            else:
                if event['type'] == 'stopped':
                    pending, self.callbacks = self.callbacks, {}
                    for callback in pending.values():
                        if callback: callback(None, 'The connection stopped; reconnect from the menu.')
                self.on_event(event)
        return GLib.SOURCE_CONTINUE

    def close(self):
        if self.closed: return
        self.closed = True
        GLib.source_remove(self.timer)
        self.callbacks.clear()
        try: self.process.stdin.close()
        except OSError: pass
        try: self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
