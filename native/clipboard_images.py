"""Private, short-lived clipboard attachments; never retain full-size textures."""
import os
from pathlib import Path
import tempfile
import threading
from gi.repository import GLib

MAX_PIXELS = 32 * 1024 * 1024
MAX_BYTES = 100 * 1024 * 1024
MAX_DRAFT_BYTES = 256 * 1024 * 1024


class ClipboardImages:
    def __init__(self):
        self.directory = None
        self.paths = set()
        self.pending = set()
        self.closed = False

    def capture(self, texture, callback):
        if self.closed: return
        if texture.get_width() * texture.get_height() > MAX_PIXELS:
            callback(None, 'Clipboard image is too large (maximum 32 megapixels).')
            return
        if self.pending:
            callback(None, 'An image is still being prepared. Try again in a moment.')
            return
        try:
            stored_bytes = sum(Path(path).stat().st_size for path in self.paths if Path(path).exists())
            if not self.directory:
                self.directory = tempfile.TemporaryDirectory(prefix='quietchat-clipboard-')
            descriptor, filename = tempfile.mkstemp(prefix='Clipboard-image-', suffix='.png', dir=self.directory.name)
            os.close(descriptor)
        except OSError:
            callback(None, 'Could not create a temporary image attachment.')
            return
        self.paths.add(filename); self.pending.add(filename)

        def done(error):
            self.pending.discard(filename)
            if not self.closed: callback(filename if not error else None, error)
            if error: self.remove(filename)
            return GLib.SOURCE_REMOVE

        def save():
            error = None
            try:
                if not texture.save_to_png(filename): raise OSError('PNG encoding failed')
                size = Path(filename).stat().st_size
                if size > MAX_BYTES:
                    error = 'Clipboard image exceeds the 100 MiB attachment limit.'
                elif stored_bytes + size > MAX_DRAFT_BYTES:
                    error = 'Clipboard drafts reached 256 MiB. Send or remove an existing image first.'
            except (OSError, GLib.Error): error = 'Could not prepare the clipboard image.'
            GLib.idle_add(done, error)

        # GdkTexture is immutable/threadsafe. PNG encoding must not block GTK input.
        threading.Thread(target=save, name='clipboard-image', daemon=False).start()

    def remove(self, filename):
        if filename in self.paths:
            try: Path(filename).unlink(missing_ok=True)
            except OSError: return
            self.paths.discard(filename)

    def retain(self, paths):
        for filename in self.paths - set(paths) - self.pending: self.remove(filename)

    def close(self):
        self.closed = True
        if self.directory: self.directory.cleanup()
        self.paths.clear()
