# Terminal interface (retained)

Use `quietchat --terminal` or `./QuietChat/run.sh`. The default installed launcher now opens the native GTK4 interface described in [the main guide](../../README.md).

The following is the historical terminal guide; its references to the old desktop host and default launcher describe versions through 0.1.6.

# QuietChat

A small Linux terminal companion for WhatsApp, written in TypeScript. It connects
through Baileys without Chromium or an embedded browser. Images and videos open
on demand in a separate `mpv` window.

This is a personal prototype, not an official WhatsApp application. WhatsApp
[warns that unofficial linked clients can result in account restrictions](https://faq.whatsapp.com/378279804439436/).
The connection depends on the community-maintained
[Baileys library](https://github.com/WhiskeySockets/Baileys), pinned in the lockfile.

## Start and pair

From the consulting workspace root:

```bash
./QuietChat/launch.sh
```

The launcher installs dependencies if missing, builds TypeScript, and starts the
app. Requirements: **Node.js 22.16+**, npm, `mpv`, and `ffmpeg`. The native window
uses system Python 3, PyGObject, GTK 3 and VTE (`python3-gi`, `gir1.2-gtk-3.0`,
`gir1.2-vte-2.91` on Ubuntu). `zenity` enables
the graphical attachment picker; typing a path works without it. Those programs
were already installed on the development machine.

1. On first launch, wait for the pairing QR.
2. On your phone, open **WhatsApp → Linked devices → Link a device** and scan it.
3. If the terminal is too small, press **F2** to open a larger QR image window.
   The code refreshes automatically, including the image window.
4. After pairing, the QR disappears and recent chats/contacts synchronize.
5. Later launches reuse the saved session. Your phone remains the primary device.

Use a terminal of at least 80×24 characters; 120×40 is more comfortable. Emoji
appearance depends on terminal/font support. No browser is needed for login.

Try the interface without an account:

```bash
./QuietChat/launch.sh --demo
```

The demo has synthetic chats, an image and a short test video. It never connects
to WhatsApp or sends real messages, and its temporary data is removed on exit.

## Ubuntu installation and application icon

QuietChat is installed for the current user. Press **Super**, search for
**QuietChat**, and open it, or run:

```bash
quietchat
# Also accepted:
quietchat start
quietchat --demo
quietchat --version
```

From Alacritty (or another interactive terminal), `quietchat` and `quietchat start`
run inside that terminal, from any directory. `~/.local/bin` is already included
in this machine's Bash startup PATH. The command is a symlink to this checkout.
Use `quietchat --desktop` to explicitly open the native window instead.

The mint chat/Q icon matches QuietTube's visual style. On this Ubuntu installation,
the desktop launcher opens a small native GTK/VTE terminal window with application
ID `ch.aboimpinto.QuietChat`, so GNOME can associate the window with its own icon.
This window captures Shift+Enter before terminal encoding, preserving the
difference between sending a message and adding a newline. The chat application
inside it remains TypeScript; no browser is involved.
You can right-click the running icon to pin it to the dock.

**The installed app and this checkout are the same code.** The command at
`~/.local/bin/quietchat` links directly to this project's `launch.sh`. The desktop
entry also launches that file. Both use `run.sh`, which builds this checkout's
TypeScript before starting. Restart the app after source changes; an already
running process does not hot-reload. `quietchat --version` prints the version,
source directory and Node version so the installation can be checked.

The icon links point to `assets/ch.aboimpinto.QuietChat.svg` in this checkout.
There is no separate copied application bundle to become stale. Keep the checkout
in place, or rerun the installer after moving it:

```bash
python3 QuietChat/scripts/install_desktop.py
```

The installer updates only the user's command, application entry and icon links;
it preserves the WhatsApp session and data. `quietchat --terminal` also explicitly
selects the current terminal. Alacritty's modern keyboard protocol is enabled
only while QuietChat runs, allowing Shift+Enter without changing global Alacritty
settings. On legacy terminals that cannot distinguish it from Enter, use Ctrl+J
for a newline, or open the native window. Multiline bracketed paste stays in the
composer until you send it.

The conversation displays multiline bubbles: incoming messages sit on the left,
and your messages sit on the right. Explicit line breaks and blank lines are
preserved; long messages and captions wrap to the terminal width. A brighter
bubble with a `›` marker indicates the selected message for reactions or media.

## Controls

| Control | Action |
|---|---|
| Click a chat/contact, or arrows + Enter | Open conversation |
| Tab / Shift+Tab | Move between chats, messages, composer and search |
| F7 | Switch between chats and contacts |
| F9 | Search the current chat/contact list; Enter returns to the list |
| Enter in composer | Send to the recipient named above the composer |
| Shift+Enter in Alacritty or the native window / Ctrl+J | Add a new line |
| F8 / Reply footer button | Prepare a quoted reply to the selected message and focus the composer |
| Escape in composer | Cancel the pending reply while keeping its text/attachment |
| Ctrl+S | Alternative send shortcut |
| F3 | Choose an image/video with the system file picker |
| F4 | Type a file path; submit an empty path to remove an attachment |
| F10 with composer focused | Preview the attached file before sending |
| Enter / F10 on a media message | Download if needed and open in mpv |
| F5 | Insert an emoji into the composer |
| F6 | React to the selected message or remove your reaction |
| Click a bubble / Up or Down in messages | Select a message for reactions or media |
| Mouse wheel / Ctrl+Up or Ctrl+Down in messages | Scroll through the conversation, including very tall messages |
| Home / End in messages | Select the first/last message on the current page |
| Page Up / Page Down in messages | Older/newer pages of locally stored history |
| F2 | Open the active login QR in an image window |
| F1 | Show help |
| Ctrl+click an underlined URL | Open the full link in your default browser, including wrapped URLs |
| Shift+drag | Select terminal text with the mouse |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy selected text / paste into the composer |
| Ctrl+Q | Quit and close media windows |

For copying conversation text in Alacritty, **hold Shift while dragging** so
Alacritty handles selection instead of QuietChat's message clicks. Press
**Ctrl+Shift+C** to copy, then **Ctrl+Shift+V** to paste into the composer (or
Ctrl+V in a normal graphical app). Paste never sends the message; press Enter
when ready. Plain Ctrl+C shows this guidance instead of quitting. Use Ctrl+Q
to quit. No global Alacritty settings are changed.

The footer actions are also clickable. The composer supports typing, pasting,
newlines and backspace; cursor-position editing is not implemented yet. In the
native window, Ctrl+Shift+V / Shift+Insert paste text without sending its line
breaks, and Ctrl+Shift+C copies selected text. Drafts
and pending attachments/reply targets are kept separately per chat in memory. Failed sends
preserve the draft and its reply target. Quitting discards drafts. Sending an attachment requires an
explicit Enter or Ctrl+S after choosing the file; it is not sent on selection.

To reply, click a message bubble (or select it with arrows), press **F8**, type
your answer, and press **Enter**. A compact preview appears only while composing
a reply; **Escape** removes it without discarding your draft. Text, image and
video replies quote the original WhatsApp message. New reply bubbles show a
short excerpt of the original message. The permanent selected-message panel has
been removed to give the conversation more space.

## Current scope

- QR pairing, persistent local credentials and reconnection with bounded backoff.
- Recent chat history, synchronized contacts, direct and group conversations.
- Sending/receiving text, image and video messages; captions and emoji reactions.
- JPEG, PNG and WebP image uploads; MP4 video uploads up to **100 MiB**. Videos
  must already use a WhatsApp-compatible codec; automatic conversion is not included.
- One on-demand media viewer, without background video playback or eager downloads.
- Local history pages of 60 messages; chat/contact searches return at most 200 rows.

The initial history available to a linked device depends on WhatsApp. QuietChat
does not request a full archive. It does not implement calls, voice messages,
stickers, photo annotation, message editing, delivery/read indicators, or desktop
notifications yet. Emoji overlays on images are a later feature; emoji captions
and reactions work now.

View-once and disappearing message bodies are not retained or opened by this
prototype. Use your phone for them. Sending to chats known to have disappearing
messages enabled is also disabled for now. Do not treat this as a WhatsApp backup.

## Memory and local data

- Recent messages live in SQLite, with a **10,000-message global retention limit**.
- The interface loads only one history page and bounded chat/contact lists.
- Downloads stream to disk, stop at **100 MiB**, and time out after 90 seconds.
- The media cache is limited to **256 MiB** and removes older files first.
- The header shows the Node process's resident memory (RSS). It **excludes** mpv,
  ffmpeg, the terminal emulator and file-picker processes.
- Initial sync and protocol-library caches can temporarily use additional memory.
  Limits on history/cache size are not a hard limit on total process RAM.

Normal data is outside the source tree:

```text
${XDG_DATA_HOME:-~/.local/share}/quietchat/
  quietchat.db       credentials, encryption keys, contacts and recent messages
  quietchat.db-wal   temporary SQLite write-ahead log
  quietchat.db-shm   temporary SQLite shared memory
  media/            downloaded attachments
  pairing.png       only while an image pairing QR is active
  instance.lock     prevents two processes sharing one session
```

The data directory has owner-only permissions, and newly created state files
have owner-only access. **The database and media are not encrypted at rest**;
protect the machine/user account and use disk encryption where needed. Protocol
logging is suppressed because dependencies can otherwise print session objects.
No message contents or credentials are copied into this repository.

Maintenance commands (quit the running app first):

```bash
./QuietChat/run.sh --clear-cache
./QuietChat/run.sh --reset-session
./QuietChat/run.sh --data-dir /path/to/private/alternate-directory
```

`--reset-session` forgets local authentication and starts QR pairing again. It
preserves local history, and does **not** revoke an old linked device on your phone.
Remove an obsolete QuietChat session from WhatsApp's **Linked devices** screen.
Never share the database or a live pairing QR.

## Development and validation

```bash
cd QuietChat
npm ci
npm test
npm run test:terminal
npm run benchmark
npm run probe
```

`test:terminal` uses Python 3 and a pseudoterminal to exercise the actual widgets
with synthetic data, including failed sends, attachments and QR lifecycle.
`benchmark` runs an offline synthetic history workload. `probe` contacts WhatsApp
to request a fresh unpaired QR, never prints it, and removes its temporary state;
it does not link an account.

The redraw regression check compares actual Alacritty pixels before and after
an independent clean repaint, using synthetic long group/direct chats:

```bash
GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1680x1100x24' dbus-run-session -- /usr/bin/python3 QuietChat/scripts/redraw-smoke.py
```

The native clipboard and Ctrl+click check uses an isolated clipboard and a
stub browser opener (no browser or real message is opened/sent):

```bash
GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1680x1100x24' dbus-run-session -- /usr/bin/python3 QuietChat/scripts/interaction-smoke.py
```

Run these checks from the workspace root after building. It uses the installed system
Alacritty, Xvfb, PyGObject and Pillow, without connecting to WhatsApp.

See [verification.md](../verification.md) for measured results and the remaining
account-dependent checks. The project is currently part of the parent consulting
repository; it has no separate GitHub repository or deployment.

## Layout

- `src/transport.ts`: WhatsApp connection, typed connection/content events and sends.
- `src/auth.ts`: SQLite-backed authentication and binary Signal key persistence.
- `src/store.ts`: message/contact persistence, bounded reads and retention.
- `src/media.ts`: file inspection, streamed downloads, cache and native viewer.
- `src/ui.ts`: terminal interface, QR rendering, recipient-specific drafts.
- `src/conversation.ts`: multiline bubble layout, wrapping, selection and scrolling.
- `src/links.ts`: HTTP(S) link detection and opening through the system browser.
- `src/terminal-unicode.ts`: modern emoji cell widths shared by layout and terminal redraws.
- `src/demo.ts`: offline transport using synthetic fixtures.
- `src/main.ts`: startup, private storage, instance locking and shutdown.
- `scripts/desktop.py`: native terminal host, Shift+Enter and clipboard handling.

The UI consumes a transport interface and typed events, so the connection can be
tested independently and a native graphical interface can be added later.
