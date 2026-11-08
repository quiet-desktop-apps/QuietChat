#!/usr/bin/env python3
"""Exercise the real terminal widgets via a PTY, without an account or network."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]


def run():
    with tempfile.TemporaryDirectory(prefix="quietchat-ui-test-") as temporary:
        folder = Path(temporary)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        env = dict(os.environ, TERM="xterm-256color")
        child = subprocess.Popen(
            ["node", "--disable-warning=ExperimentalWarning", "dist/scripts/ui-fixture.js", temporary],
            cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        output = bytearray()

        def pump(seconds=0.25):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                ready, _, _ = select.select([master], [], [], min(0.05, max(0, until - time.monotonic())))
                if ready:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break

        def send(value):
            os.write(master, value.encode("utf8"))
            pump()

        def click(x, y):
            os.write(master, b"\x1b[M" + bytes([32, 32 + x, 32 + y]))
            pump(0.05)
            os.write(master, b"\x1b[M" + bytes([35, 32 + x, 32 + y]))
            pump()

        def rows(sql, args=()):
            with sqlite3.connect(folder / "fixture.db") as db:
                return db.execute(sql, args).fetchall()

        def count(text):
            return rows("SELECT count(*) FROM messages WHERE text=?", (text,))[0][0]

        def snapshot_lines():
            snapshot_path = folder / "screen.txt"
            snapshot_path.unlink(missing_ok=True)
            child.send_signal(signal.SIGHUP)
            wait_for(lambda: snapshot_path.exists(), "Terminal snapshot was not produced")
            return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", snapshot_path.read_text()).splitlines()

        def wait_for(condition, description, timeout=15):
            deadline = time.monotonic() + timeout
            while not condition():
                assert child.poll() is None, output.decode(errors="replace")
                assert time.monotonic() < deadline, description
                pump(0.05)

        try:
            wait_for(lambda: (folder / "ready").exists(), "Terminal chat list did not become ready")
            assert child.poll() is None, output.decode(errors="replace")
            assert len(rows("SELECT id FROM chats")) == 4
            rss = next(line for line in Path(f"/proc/{child.pid}/status").read_text().splitlines() if line.startswith("VmRSS:"))
            send("\r")  # Alex -> composer
            snapshot = "\n".join(snapshot_lines())
            assert "demo-alex@s.whatsapp.net" not in snapshot, "History still displays a protocol ID instead of the saved name"
            assert "Alex · demo ·" in snapshot, "Saved name missing from message bubbles"
            send("Terminal smoke test")
            send("\r")
            assert count("Terminal smoke test") == 1, "Enter did not send the composer text"
            send("First line")
            send("\n")  # Native window forwards Shift+Enter as LF, distinct from Return/CR.
            assert count("First line") == 0, "Shift+Enter sent the draft"
            send("Second line")
            send("\r")
            assert count("First line\nSecond line") == 1, "Shift+Enter did not preserve the newline"
            # Inspect the conversation itself, excluding the composer.
            conversation = snapshot_lines()[4:32]
            first = next((i, line.index("First line")) for i, line in enumerate(conversation) if "First line" in line)
            second = next((i, line.index("Second line")) for i, line in enumerate(conversation) if "Second line" in line)
            incoming = next(line.index("A second incoming line") for line in conversation if "A second incoming line" in line)
            assert second[0] == first[0] + 1 and second[1] == first[1], "Message newline flattened or misaligned"
            assert first[1] > incoming + 20, "Own messages are not right-aligned relative to incoming messages"

            # Mouse selection must target a whole multiline bubble, including its second line.
            incoming_row = next(i for i, line in enumerate(conversation) if "A second incoming line" in line)
            click(incoming + 2, incoming_row + 5)  # X10 coordinates are one-based.
            send("\x1b[17~")
            send("\r")
            assert rows("SELECT id FROM reactions") == [("history-without-name",)], "Clicking a bubble reacted to the wrong message"
            send("\x1b[17~")
            send("\x1b[B" * 10)  # Last picker item: remove my reaction.
            send("\r")
            assert rows("SELECT emoji FROM reactions") == []
            send("\x1b[Z\x1b[F\t")

            # F8 prepares a reply without sending even when the composer has text.
            send("\x1b[Z\x1b[H")  # Select first (incoming welcome) message.
            send("\x1b[19~")
            send("Reply smoke")
            send("\x1b[19~")
            assert count("Reply smoke") == 0, "F8 still sends messages"
            snapshot = "\n".join(snapshot_lines())
            assert "Selected message" not in snapshot and "F8 Send" not in snapshot
            assert "Reply to Alex" in snapshot and "F8 Reply" in snapshot
            send("\r")
            assert count("Reply smoke") == 1
            assert rows("SELECT quote FROM messages WHERE text='Reply smoke'")[0][0].startswith("Welcome to QuietChat")
            assert rows("SELECT instr(raw, CAST('welcome' AS BLOB)) FROM messages WHERE text='Reply smoke'")[0][0] > 0
            assert "Reply to Alex" not in "\n".join(snapshot_lines()), "Sent reply preview was not cleared"
            send("\x1b[19~")
            send("Cancelled reply")
            send("\x1b")  # Escape cancels reply but keeps the draft.
            cancelled_snapshot = "\n".join(snapshot_lines())
            assert "Esc cancels" not in cancelled_snapshot, "Escape did not cancel the reply"
            assert "Cancelled reply" in cancelled_snapshot, "Escape lost the draft"
            send("\r")
            assert rows("SELECT quote FROM messages WHERE text='Cancelled reply'") == [(None,)], rows("SELECT text,quote FROM messages WHERE mine=1")
            send("\x1b[Z\x1b[F\t")

            # Shrinking the real PTY must reflow long text without truncating its tail.
            long_text = "Wrap check " + "word " * 75 + "TAIL_MARKER"
            send(long_text)
            send("\r")
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 80, 0, 0))
            child.send_signal(signal.SIGWINCH)
            pump(0.5)
            send("\x1b[Z")  # Composer -> conversation.
            send("\x1b[F")  # End: select/reveal the newest bubble.
            conversation = snapshot_lines()[4:32]
            assert any("TAIL_MARKER" in line for line in conversation), "Long message tail clipped after resize"
            assert sum("word" in line for line in conversation) >= 8, "Long message did not wrap"
            send("\x1b[H")  # Home: selection and scroll return to first message.
            assert any("Welcome to QuietChat" in line for line in snapshot_lines()[4:32]), "Keyboard bubble navigation failed"
            send("\x1b[F")
            send("\t")  # Conversation -> composer.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            child.send_signal(signal.SIGWINCH)
            pump(0.5)

            send("\x1b[200~Pasted first\r\nPasted second\x1b[201~")
            assert count("Pasted first\nPasted second") == 0, "Pasting sent a message"
            send("\r")
            assert count("Pasted first\nPasted second") == 1, "Multiline paste was not retained"

            send("\x1b[19~")  # Start a reply that must survive a failed send.
            send("fail-send")
            send("\r")
            assert count("fail-send") == 0
            assert "Esc cancels" in "\n".join(snapshot_lines()), "Failed send lost the reply target"
            send("-retained")
            send("\r")
            assert count("fail-send-retained") == 1, "A failed send lost the draft"
            assert rows("SELECT quote FROM messages WHERE text='fail-send-retained'")[0][0] is not None

            send("\x1b[15~")  # F5 emoji
            send("\r")
            send("\r")
            assert count("👍") == 1, "Emoji did not reach the composer"

            send("\x1b[17~")  # F6 reaction
            send("\r")
            assert rows("SELECT emoji FROM reactions") == [("👍",)]

            # Type a path through the actual modal and send an image as a reply.
            send("\x1b[19~")
            send("\x1bOS")  # F4
            send(str(ROOT / "test/fixtures/demo.png"))
            send("\r")
            send("Image caption")
            send("\r")
            assert rows("SELECT kind FROM messages WHERE text='Image caption'") == [("image",)], "Image attachment failed"

            assert rows("SELECT quote FROM messages WHERE text='Image caption'")[0][0] is not None

            # Chat-specific drafts and keyboard navigation through contacts/search.
            send("\x1b[19~")
            send("Alex draft")
            send("\x1b[18~")  # F7 contacts
            send("\x1b[20~")  # F9 search
            send("Sam")
            send("\r")  # complete search
            send("\r")  # open selected contact
            assert "Esc cancels" not in "\n".join(snapshot_lines()), "Reply leaked into another chat"
            send("Message for Sam")
            send("\r")
            assert rows("SELECT chat FROM messages WHERE text='Message for Sam'") == [("demo-sam@s.whatsapp.net",)], "Recipient changed unexpectedly"
            send("\x1b[18~")  # return to chats, clears search

            # Mouse: click Alex's second row (Sam is newest). X10 press/release.
            click(10, 9)
            assert "Esc cancels" in "\n".join(snapshot_lines()), "Chat switch lost reply draft"
            send("\r")
            assert rows("SELECT chat FROM messages WHERE text='Alex draft'") == [("demo-alex@s.whatsapp.net",)], "Mouse navigation or per-chat draft restore failed"

            # Group display uses the same resolved names and mentions as GTK.
            send("\x1b[20~")
            send("Weekend")
            send("\r")
            send("\r")
            group_snapshot = "\n".join(snapshot_lines())
            assert "Ada (work)" in group_snapshot and "Lin" in group_snapshot
            assert "@Ada (work)" in group_snapshot and "@Lin" in group_snapshot and "@You" in group_snapshot
            assert "@140000001" not in group_snapshot, "Terminal mention was not resolved"

            # Terminal QR and generated PNG fallback, then remove on connection.
            child.send_signal(signal.SIGUSR1)
            pump()
            send("\x1bOQ")  # F2 (mpv may lack a graphical display, PNG generation still verified)
            pump(0.5)
            assert (folder / "pairing.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            assert (folder / "pairing.png").stat().st_mode & 0o777 == 0o600
            child.send_signal(signal.SIGUSR2)
            pump()
            assert not (folder / "pairing.png").exists(), "Pairing QR remains after connection"

            # Small-terminal fallback remains usable rather than clipping QR modules.
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            child.send_signal(signal.SIGWINCH)
            child.send_signal(signal.SIGUSR1)
            pump()
            child.send_signal(signal.SIGHUP)
            pump()
            snapshot = (folder / "screen.txt").read_text()
            assert "Press F2" in snapshot, "Small-terminal pairing instructions missing"
            child.send_signal(signal.SIGUSR2)
            pump()
            send("\x11")  # Ctrl+Q
            child.wait(timeout=3)
            assert child.returncode == 0
            print(json.dumps({"terminal_smoke": "passed", "checks": ["startup", "group participant names and mentions", "F8 quoted reply (text and image)", "reply cancellation", "reply retention on failure and chat switching", "selected panel removed", "multiline bubbles", "left/right alignment", "long-text wrapping and resize", "bubble keyboard navigation", "multiline bubble mouse selection/reaction", "text send", "failed-send draft retention", "emoji", "reaction", "image attachment", "contact search", "recipient selection", "mouse navigation", "per-chat drafts", "QR PNG generation/permissions/removal", "small-terminal QR fallback", "clean shutdown"], "offline_idle_rss": rss.split(":", 1)[1].strip()}, indent=2))
        except Exception:
            # Only synthetic demo data is present in this diagnostic output.
            if child.poll() is None:
                child.send_signal(signal.SIGHUP)
                pump()
            snapshot = folder / "screen.txt"
            if snapshot.exists():
                print(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", snapshot.read_text()))
            else:
                print(output[-1500:].decode(errors="replace"))
            raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            os.close(master)


if __name__ == "__main__":
    run()
