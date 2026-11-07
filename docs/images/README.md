# Publication screenshots

Captured on 8 November 2026 from the actual app, using its offline demo in an
isolated Xvfb/D-Bus session. No account, real messages, cookies, personal feed or
pairing QR code is visible. Demo content is labelled in the image and main README.
These are captures of the application, not product mockups.

From the repository root, after installing dependencies/building as documented:

```bash
GDK_BACKEND=x11 GSK_RENDERER=cairo xvfb-run -a -s '-screen 0 1500x1100x24' \
  dbus-run-session -- /usr/bin/python3 scripts/capture-demo.py
```

The terminal image was captured during `scripts/desktop-smoke.py --alacritty`
using `QUIETCHAT_SCREENSHOT="$PWD/docs/images/quietchat-terminal.png"` in an
isolated Xvfb session. This optional check needs Alacritty and the installed command.
The shown RSS is an offline snapshot, not the claimed typical live-account value.
