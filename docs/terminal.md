# QuietChat terminal interface

The terminal version is retained alongside GTK4 and uses the same Baileys transport,
SQLite history and saved login. It has **no built-in desktop notifications or
system tray**. Images and videos open on demand in a graphical mpv window.

## Start

From an installed checkout:

```bash
quietchat --terminal
quietchat --terminal --demo    # Offline sample chats, no account or real messages
```

From the repository root, use `./launch.sh --terminal` (or `./run.sh`). Quit the
native app with **Ctrl+Q** first; hiding it in the tray does not release the account
lock. Switching interfaces reuses the login. Initial pairing shows a QR for
**WhatsApp → Linked devices → Link a device** on your phone. **F2** opens a larger
QR image when the terminal is too small.

Requirements: Node.js 22.16+, npm, a terminal emulator, mpv and ffmpeg. The optional
zenity file picker can be installed separately; the path dialog works without it.
Alacritty has been tested with real key/mouse events. At least 80×24 characters
are required, with 120×40 more comfortable. Fonts affect emoji appearance.

## Keyboard and mouse

- **Enter** sends in the composer and opens a chat/media item in its list.
- **Shift+Enter** adds a line where the terminal supports distinct key reports.
- **Tab** moves focus; arrow keys navigate. **Page Up/Down** changes history pages.
- **F1** help, **F3** attach, **F5** emoji, **F6** react, **F7** contacts.
- **F8** replies to the selected message; **Escape** clears the pending quote.
- **F9** search; **F10** preview; **Ctrl+Q** quits.
- **Ctrl+click** opens links. **Shift+drag** selects terminal text, then use
  **Ctrl+Shift+C/V** for the emulator clipboard. Ordinary mouse input belongs to
  the chat interface; GTK-style drag selection is not provided by the terminal UI.

Clipboard image pasting and native notifications are GTK-only features. Use file
attachments in the terminal. Per-chat drafts and replies remain available; drafts
are not persisted after quitting. History is paged rather than loaded as one large
scrollback. See [memory evidence](memory.md) for the approximately 170 MiB everyday
app RSS observation and its exclusions.

The [historical 0.1 guide](history/terminal-0.1-guide.md) documents earlier launchers;
its defaults and GTK3/VTE host details do not describe the current installation.
