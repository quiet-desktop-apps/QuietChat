# Third-party software and assets

The MIT license covers QuietChat's original code and original bundled SVG/demo
assets. It does not replace the licenses of dependencies or service trademarks.
No WhatsApp/Meta endorsement or rights to their marks are granted.

| Component | Role / upstream license |
|---|---|
| Baileys (`@whiskeysockets/baileys`) | WhatsApp protocol; MIT |
| neo-blessed | Terminal widgets; MIT |
| pino, qrcode, qrcode-terminal | Logging/QR utilities; MIT |
| Node.js | JavaScript runtime; Node distribution license and bundled notices |
| Python / PyGObject / GTK / GdkPixbuf / GLib | Native runtime and bindings; retain each system package's licenses (including PSF/LGPL) |
| mpv | External media player; GPL/LGPL depending on build/components |
| ffmpeg | External thumbnail/media tool; LGPL/GPL depending on build configuration |

The dependency graph and locked versions are in `package-lock.json`; individual
packages contain their license texts and attribution. External runtime binaries,
fonts and GTK libraries are installed separately, not bundled in this repository.
Before distributing a binary bundle, audit the actual resolved artifacts and retain
all required notices/source obligations; an MIT app does not make those artifacts MIT.

`test/fixtures/demo.png` and `demo.mp4` are synthetic test-pattern media. Public
screenshots show the application's offline demo, not real chats or profile photos.
System-rendered fonts and emoji remain subject to their respective font licenses.
