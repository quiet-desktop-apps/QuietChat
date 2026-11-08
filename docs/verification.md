# QuietChat prototype verification

Verified on **7 November 2026**, Linux, Node.js **22.22.2**, with the repository's
locked dependencies. No personal WhatsApp account was linked during development.


## Hidden display memory cleanup — 8 November 2026 (0.2.10)

Core suite: 28 tests passed. Full native GTK/D-Bus regression passed with new
assertions for zero hidden sidebar/avatar/message objects, late request rejection,
no hidden display fetches, unchanged on-disk preview files, clipboard draft/reply
restoration, image reload from cache, preserved history position, and continued
notification delivery/badges. Existing clipboard, accents, group mentions and
navigation checks remained enabled. Cleanup leaves the backend connected.

A synthetic before/after measurement is recorded in [memory evidence](memory.md)
and the accompanying numeric samples. It demonstrated resource release and a
modest RSS reduction; it does not establish the cause of the overnight live-memory
increase or promise recovery of all 30 MiB. Only synthetic state was accessed.

## Group participants and mentions — 8 November 2026 (0.2.9)

Fixed history attribution using both key-level and top-level participant IDs.
Saved contact names take priority over profile names, including explicitly linked
phone/LID identities. Group titles are never used as a missing sender fallback.
Protocol-declared mentions in text and image/video captions resolve at read time;
raw protocol text remains unchanged for replies. No speculative @number matching.

GTK sender and mention links open private conversations without sending, reuse
known existing chats, preserve per-chat drafts, and discard stale navigation replies.
Both frontends share resolved display names. A streaming schema migration learns
available profile names from retained history without rewriting messages or auth.
Legacy cached names remain protected because their original source was not stored.

Validation: all 28 core tests passed, including legacy schema/profile recovery,
alias mapping, contact-sync precedence, repeated/unknown mentions, emoji, caption
mentions and URL exclusion. The PTY regression passed with explicit group-name
and mention assertions. The full GTK/D-Bus suite passed, including physical sender
and mention clicks, copied names, literal markup-like names, draft preservation,
clipboard attachments, accents, replies, tray badges and notifications. All data
was synthetic; live WhatsApp account interoperability was not exercised.

The installed command launched from /tmp reported 0.2.9 and opened the same GTK
checkout/application identity under Xvfb. Existing running instances need a full
quit/reopen. The synthetic [group example](images/quietchat-group.png) was captured
from the actual app with `scripts/capture-demo.py --group` and visually inspected.
No browser engine, new dependency or eager profile-image loading was introduced.

## Dependabot integration — 8 November 2026 (0.2.8)

Reviewed QuietChat PRs #2–#7 together. Updated SHA-pinned GitHub Actions to
checkout 7.0.1, setup-node 7.1.0 and upload-artifact 7.0.2, verifying their pins
against upstream release tags. CI continues to run the app on Node 22 with
read-only repository permissions and no persisted checkout credentials.

Updated TypeScript to 7.0.2 and the direct Pino dependency to 10.4.0. TypeScript's
platform-specific compiler packages are development dependencies, not a resident
UI runtime. Baileys retains its own supported Pino 9 dependency; no override forces
its transitive dependency to a different major.

Declined the Node 26 declaration upgrade in #6: the app supports Node 22.16+ and
should type-check against the Node 22 API family. The manifest now explicitly
starts at @types/node 22.20.5 (already present in the original lockfile), and
Dependabot ignores major updates for this package until a deliberate runtime
migration. Node 22 minor/patch updates remain enabled.

Combined verification in an isolated checkout: clean npm install, all 24 core
checks, terminal PTY and native GTK/D-Bus regressions passed on Node 22.22.2.
The install audit reported zero known vulnerabilities. These are offline tests;
no real WhatsApp account was accessed or messaged. GitHub CI is also required on
the combined PR before merging; individual Dependabot checks alone do not prove
combined compatibility.

The first combined GitHub run exposed a PTY harness startup race: its fixed
one-second delay could send Enter before the debounced chat list was ready. The
offline fixture now signals readiness after rendering the populated list; the
harness waits with a bounded timeout and requests fresh snapshots explicitly.
The terminal suite was rerun normally and with a deliberate two-second Node
startup delay to verify the fix without weakening any interaction assertions.

## Open-source publication preparation — 8 November 2026

Prepared for the independent `quiet-desktop-apps` repository: MIT licensing,
architecture and Agentic Engineering docs, scoped memory evidence, synthetic-data
screenshots, contributor/security guidance and PR-only CI configuration.
Clean-runner GTK compatibility fix (0.2.7): older GTK PNG encoders replace the
initial private file, losing its 0600 mode. Reapply 0600 after successful encoding;
the 0700 parent directory stays private throughout. A replacement-encoder fixture
checks the permission contract independently of the installed GTK version.
The reaction keyboard test explicitly brings its button into view after the URL
preview grows; font/layout differences otherwise leave the popup anchor offscreen.
CI captures the offline native window for visual inspection on Ubuntu 24.04.

Local verification: 24 core tests, the terminal PTY regression, the native GTK/D-Bus
integration and installed Alacritty keyboard/reply checks passed. Runtime `npm audit
--omit=dev` reported zero known vulnerabilities at this check. This is not a security
audit. The screenshots were captured from fresh offline sessions. CI on a clean
GitHub runner is tracked on the publication PR, separately from these local results.

Earlier dated records below describe development at that time; install paths and
version references in them are historical, not current release instructions.


## Wayland dead-key input (0.2.6)

Reproduced the user's actual symptom on their Wayland session using a hidden GTK
input-method test widget: dead_acute+a/e/u produced `aeu` through the default
`wayland` context, but `áéú` through `ibus`. The session already advertises
`XMODIFIERS=@im=ibus`, has the GTK4 IBus module installed, and uses the Portuguese
keyboard. GTK version is 4.22.4. The earlier X11 regression missed this distinction.
GNOME describes the changed Wayland dead-key handling in this
[upstream discussion](https://discourse.gnome.org/t/issues-with-diacritics-in-gtkentry/32503).

At startup, QuietChat now selects the IBus GTK input module for sessions advertising
IBus when GTK would otherwise select its Wayland context. This is a process-local
GtkSettings override, covering the composer and other editable widgets. Explicit
GTK_IM_MODULE/gtk-im-module settings and other default input contexts are preserved.
Ubuntu's keyboard settings and other applications are untouched.

`scripts/wayland-input-smoke.py` verifies the production configuration helper on
the actual Wayland session: `áéíóúãõâêôàçÁ` all passed. It feeds keyboard-layout
keycodes through GTK's input-method API in a hidden widget, without injecting
desktop key events, changing the layout, opening the backend or sending messages.
The full native regression passed with the startup change, including physical
keyboard composition, Enter/Shift+Enter, text/image paste, replies, tray badges and
notifications. An explicit GTK_IM_MODULE choice was preserved. The installed-command
smoke test launched version 0.2.6 from /tmp and confirmed the same source checkout.
The installed launcher continues to use the same checkout; quit fully and reopen
to load the new startup setting.

## Accent composition (0.2.5)

Confirmed that the capture-phase Enter shortcut sent the draft before GTK could
commit Unicode input (Ctrl+Shift+U, e1, Enter). The composer now calls GTK's own
input-method filter before overriding Enter, keypad Enter or Escape, following
the installed Gtk.TextView API contract. No global keyboard/input-method settings
were changed.

Physical key tests in an isolated X display with Portuguese layout produced
áéíóúãõâêôàçÁ. Unicode Enter commits á without sending; a second Enter sends the
completed text. Escape cancels composition and allows subsequent accent input.
The full native regression passed, including ordinary Enter/Shift+Enter, clipboard
images/text, quoted replies, notifications and unread counters. The initial focused
test also passed with GTK_IM_MODULE=simple; expanded tests used the default module.
The user's exact dead-key failure was not reproduced in this X11 test environment;
their desktop uses Wayland with Portuguese XKB/IBus. Further diagnosis of that
specific failure needs the exact key sequence and observed result after restart.

## Extended tray count (0.2.4)

Extended the red tray badge to exact counts 1–99, then +99 from 100 onward.
Wider rounded badges preserve the font size for two and three characters.
Inspected rendered 99/+99 icons at 24 and 32 pixels as well as a larger preview.
The native regression passed, including transitions 1/9/10/24/99/100/1000/99/0,
notification dismissal, dock counts, and existing messaging/clipboard behavior.
Only the current badge is rasterized in memory. Ubuntu Dock continues to format
its own actual count using the system theme. Installed launchers still use this
checkout; restart QuietChat to load the new threshold.

## Unread indicator synchronization (0.2.3)

Read-only inspection of the live store found zero unread messages while the dock
still showed a count. The running tray service advertised Active and the normal
icon. Installed Ubuntu Dock source confirmed that retained desktop notifications
contribute to its badge; QuietChat previously never dismissed them on read.

Implemented an authoritative, revisioned unread snapshot shared by read replies,
chat queries and incoming/change events. Older replies cannot restore stale counts.
Read chats dismiss only their owned notifications, including after an avatar fetch
or Notify acknowledgement completes late. Notification IDs persist privately,
bound to the daemon’s unique D-Bus owner to avoid closing another app’s notification
after a daemon restart. Notifications created before this release lack that saved
mapping and may require one manual dismissal from Ubuntu’s notification panel.

The tray uses red numbered SVG icons for 1–9 and +9, with both normal/attention
properties restored at zero and explicit PropertiesChanged signals for caching
hosts. The dock receives actual counts via com.canonical.Unity.LauncherEntry;
Ubuntu Dock’s installed API exposes neither per-app badge colours nor a custom
+9 label. Its theme and number formatting remain unchanged. The installed desktop
has application-counter-overrides-notifications enabled, avoiding double counts
while the app advertises a positive unread total. No setting was changed.

The isolated native regression passed: 1/9/10/24/0 tray transitions, dock updates,
notification dismissal on read, delayed-avatar and delayed-Notify races, preserving
other chats’ notifications, stale revision rejection, notification-ID recovery and
daemon-owner invalidation. Existing clipboard, media, navigation and tray checks
also passed. All 24 core tests passed, including read-sync clearing one chat while
another remains unread. Rendered the red 1 and +9 assets for visual inspection.

## Clipboard image attachments (0.2.2)

Ctrl+V now handles both native image clipboard content and image/png clipboard
bytes. Images become draft PNG attachments with a small thumbnail; text remains
an optional caption. Existing text paste stays native and does not send.
PNG encoding runs in one worker, with 32-megapixel / 100 MiB per-image limits and
256 MiB across clipboard drafts. Files/directories are private (0600/0700). The
original full-size texture is released after encoding; the UI retains a thumbnail.

Verified with physical Ctrl+V/Ctrl+Shift+V in the isolated offline GTK test:
image preparation without sending, caption preservation, per-chat image drafts,
replacement/removal cleanup, failed-send retention, explicit Enter sending, and
reopening the sent demo image after removing its temporary draft. An asynchronous
capture deliberately completed after switching chats: it attached to neither the
new chat nor a stale draft, and its temporary file was removed. The temporary
directory was also removed on shutdown. Existing text selection/paste, replies,
links, profile photos, QR, tray and notification checks passed; 24 core tests passed.

The installed command points to the same checkout at version 0.2.2. Restart the app
with Ctrl+Q and reopen to load the change. No real WhatsApp message was sent by tests.

## Chat-list profile photos (0.2.1)

Chat/contact rows now display circular 36×36 profile photos using the existing
avatar endpoint and disk cache, with initials for unavailable photos. The UI loads
one visible-row request at a time, releases offscreen row textures, and keeps at
most 64 small decoded images (about 324 KiB of pixel data). Negative results are
cached to prevent repeated requests on every chat refresh; transient errors retry.

The offline GTK regression passed, including an 80-chat fixture that checks initial
visible-only loading, newly visible photos after scrolling, offscreen texture
release, fixed circular dimensions and cached initials for unavailable photos.
Existing mouse selection, links, replies, QR, reactions, tray and notification checks
also passed. The installed command still links to this checkout; quit with Ctrl+Q
and reopen to load this Python UI change. No live account was restarted for testing.

## Native GTK4 release 0.2.0

Implemented on 7 November 2026 with system Python 3 / PyGObject / GTK **4.22**,
retaining the existing Node/Baileys transport and SQLite login. The existing
installed command, application entry, normal icon and new unread icon link to this
checkout. `quietchat --version` reports **0.2.0**. Default launch is native;
`quietchat --terminal` retains the Alacritty experience.

Verified in a fresh Xvfb display and isolated D-Bus session, using synthetic chats:

- Native application startup through the installed command from `/tmp`; GTK
  application identity and WM_CLASS match the existing desktop launcher.
- Actual mouse dragging selects part of a message; physical Ctrl+C/Ctrl+V copies
  and pastes. Paste does not send. Enter sends and Shift+Enter inserts a newline.
- Actual mouse click activates the complete URL (browser launch replaced by a
  capture in the test); on-demand preview card loads its bounded offline fixture.
- F8 quotes the selected message; sending persists the original quote. Per-chat
  draft/reply state survives navigation, and cancellation retains text.
- F6 opens the reaction picker and adds a reaction. Existing terminal integration
  also verifies image attachment sends and emoji insertion through the same backend.
- Inline image/video thumbnails decode; native QR image displays, has private
  permissions and is removed when pairing ends.
- Closing releases current page widgets/images and hides to the tray. New incoming
  messages mark the icon and emit a popup containing text and an avatar path.
  Clicking the notification opens its chat; marking read clears the badge.
- Actual StatusNotifierItem registration and D-Bus menu GetLayout with an isolated
  host; notification service tested with a fake desktop daemon. The user's running
  Ubuntu session separately reports both real services available.
- Ten round trips between chats do not accumulate prior pages. Latest measured
  combined UI/backend RSS was **314.7 MiB**, with **0.0 MiB** additional RSS after
  those switches. Other final runs were approximately **308–315 MiB**. This is an
  offline measurement, not a promise for live history synchronization, and does
  not establish savings against a separately measured Chromium WhatsApp app.
- Closing the installed offline app cleans its backend process and temporary state.
- **24 core tests passed**, covering existing behavior plus incoming notification
  deduplication/history/self suppression, metadata limits and failed preview cleanup.
- Existing pseudoterminal regression passed, including attachments, reactions,
  contact search, drafts, QR lifecycle and clean shutdown. The installed
  `quietchat --terminal --demo` also passed physical Enter/Shift+Enter and F8 reply
  checks inside Alacritty, launched through Bash PATH from `/tmp`.

Memory is summed process RSS and includes shared-library pages in both processes;
mpv/ffmpeg and desktop services are separate. The app deliberately retains drafts
and the SQLite connection, but destroys inactive message widgets. Allocators may
retain freed pages; a stable RSS plateau is more meaningful than an immediate drop.
Native widgets use no Chromium, webview or JavaScript UI runtime.

Reproduce from `QuietChat/`:

```bash
npm test
npm run test:terminal
npm run test:native
GDK_BACKEND=x11 xvfb-run -a dbus-run-session -- python3 scripts/installed-native-smoke.py
GDK_BACKEND=x11 xvfb-run -a dbus-run-session -- python3 scripts/desktop-smoke.py --alacritty
```

Native pairing UI is tested with an offline QR fixture; prior transport tests cover
QR refresh and saved credentials. No real account was accessed or messaged for
this upgrade. Real avatar availability, remote delivery and the desktop's chosen
popup presentation remain account/desktop-dependent.

## Earlier terminal verification (0.1.x)

The following records describe the retained terminal UI and its previous GTK3/VTE
host. References to default terminal launches predate the GTK4 default above.

## Completed checks

### Ubuntu installation

Installed the user-local `quietchat` command and
`ch.aboimpinto.QuietChat.desktop` application entry, with a scalable mint chat/Q
icon matching QuietTube. The command and icon are symlinks to this checkout;
the desktop entry also launches this checkout. Both launch routes build the
current source through `run.sh`, rather than using an independently installed copy.

Verified:

- Repeat installation and desktop-entry validation in a temporary directory.
- Launch with Ubuntu's system Node.js 22.22.1 and a minimal desktop-style PATH.
- Installed `quietchat --version` reports version 0.1.6 and this source directory.
- GNOME's application registry resolves the installed name, command and icon.
- A real desktop launch under an isolated Xvfb/D-Bus session starts the offline
  demo and sets `_GTK_APPLICATION_ID` to `ch.aboimpinto.QuietChat` for GNOME
  application/icon matching. The current GTK/VTE host also sets that identity in
  the X11 window class.
- Physical XTest keyboard events verified that Shift+Enter does not send a draft,
  and that a subsequent Enter sends exactly one message containing the newline.
  This is tested against the installed launcher, not only synthetic terminal bytes.
- Native SVG rendering was visually inspected at 256 pixels.

Reproduce the desktop check after installation:

```bash
xvfb-run -a dbus-run-session -- python3 QuietChat/scripts/desktop-smoke.py
```

### Links and terminal clipboard (0.1.6)

HTTP(S) links are underlined and Ctrl+click opens their original full URL through
`xdg-open`, even when the displayed URL wraps across multiple bubble lines. URL
arguments are passed without a shell. SGR mouse reporting preserves Ctrl-modified
release events that the library's legacy X10 decoder misclassified. Reporting
is scoped to the running application and restored on exit.

The footer/help explain Shift+drag for native terminal selection, Ctrl+Shift+C
to copy and Ctrl+Shift+V to paste. Plain Ctrl+C now shows copying guidance;
Ctrl+Q remains Quit. In isolated Alacritty, physical mouse/key events verified
selection surviving an idle refresh, clipboard text readable by another process,
pasting into the composer without sending, and Enter sending the pasted draft.
Ctrl+click on a wrapped URL continuation invoked a stub opener exactly once
with the full query string; an ordinary click did not invoke it. No real browser
was launched and the user's clipboard was not accessed by these tests.

### Clean redraws with emoji (0.1.5)

Reproduced stale text/background fragments in real Alacritty pixels with synthetic
long chats. The pinned terminal library's Unicode tables counted modern emoji
such as 🍻 and 👍 as one cell; Alacritty uses two. Its incremental cursor moves
then wrote/erased the wrong columns. A small compatibility hook updates both
character measurement and the renderer's reserved cells, without changing stored
messages, installing another runtime, or forcing full-screen repaints in normal use.
Regional indicators remain one cell each, matching a two-cell flag pair.

The isolated redraw test compares the displayed pixels against a clean repaint
across direct/group/empty chat switches, selection, scrolling, older/newer pages,
reply preview/cancellation and terminal resizing. Fixtures include accents, CJK,
hearts, flags and compound emoji. The pre-fix code failed this comparison on
opening a direct chat; the corrected emoji widths passed it. Unit coverage also
checks layout/reservation agreement and repeated initialization.

### Quoted replies and compact layout (0.1.4)

Removed the permanent selected-message detail panel and reassigned F8/the footer
button to Reply. Enter remains Send. The reply preview occupies two rows only
while a reply is pending; Escape clears the target without clearing the draft.
Reply targets are retained per chat and after failed sends. New incoming/outgoing
reply bubbles show a bounded quote excerpt; existing rows are preserved by an
additive database migration.

The fake-socket adapter checks exercise direct, own-message and group-participant
quotes with the pinned Baileys message generator, including text/image/video
sends and rejection of missing, private or cross-chat targets. The migration test
checks preservation of existing messages and authentication records. Terminal
checks cover F8 not sending, reply preview removal, cancellation, attachment
replies, failed-send retention, and chat switching. No real messages were sent;
recipient-side rendering of replies remains a live-account check. An isolated
Alacritty run of the installed launcher also passed physical F8/Enter reply
creation and Shift+Enter multiline input; visual inspection confirmed the removed
detail panel, expanded conversation and quoted bubble. The installed command
reports version 0.1.4 from this checkout.

### Multiline conversation (0.1.3)

Incoming messages render in left-aligned gray bubbles; outgoing messages render
in right-aligned teal bubbles. Both retain line breaks, blank lines, captions and
reactions, and wrap to the current panel width without the previous 300-character
preview limit. Selection uses a brighter bubble and a marker. The interface still
loads at most one 60-message page.

The offline PTY checks verify separate rendered lines, opposite alignment, wrapping
beyond 300 characters, resizing from 120 to 80 columns, Home/End navigation and
clicking the second line of a bubble to react to the correct message. The unit
checks also cover blank lines, long URLs, combining characters and wide glyphs.
The installed command was checked from `/tmp` and resolves this checkout at 0.1.3.
An isolated Alacritty run verified physical Shift+Enter/Enter and visually checked
the gray/teal bubble colors and automatic scrolling to the final message line.
Alacritty uses the xterm-256color capability profile inside QuietChat; no terminal
configuration file was changed.

### Application behavior

| Check | Result |
|---|---|
| TypeScript strict build | Passed |
| `npm test` | 22 tests passed |
| `npm run test:terminal` | Passed with the actual widgets in a 120×40 pseudoterminal and an 80×24 resize |
| WhatsApp QR compatibility probe | Real QR received in 571 ms; no account linked; temporary state removed |
| `mpv` PNG decoding | Passed with the synthetic image fixture, null video output |
| `mpv` MP4 decoding | Passed with the synthetic H.264 fixture, null audio/video output |
| Normal CLI startup/help and Ctrl+Q shutdown | Passed |

The core tests cover history deduplication and pagination, retention, literal
search, exclusion of view-once/disappearing bodies, independent reactions,
revocations/edits, binary authentication keys across database reopening,
transaction-backed credentials, partial download cleanup, cache eviction,
file-type inspection, terminal-control sanitization, private directories,
instance locking, QR lifecycle, disconnected sends and reconnection policies.

The terminal test covers:

- Enter-to-send and a distinct newline input; saved contact names in both the
  message bubbles, including history lacking a push name.
- Sending text and preserving a draft after a simulated connection failure.
- Emoji insertion and message reactions.
- Choosing a file through the path modal and sending a captioned image in demo mode.
- Contact search and selecting the correct recipient.
- Single-click chat navigation and preserving a separate draft for each recipient.
- Generating a QR PNG with owner-only permissions and removing it after pairing ends.
- QR fallback instructions in a small terminal and clean shutdown.

The terminal tests revealed and resolved focus/listener defects in the initial
input implementation. The final editor uses one persistent key listener per
widget, avoiding duplicate characters after opening/closing modal pickers.

Version 0.1.1 resolves incoming sender labels at read time from existing chat and
contact records, so old history displays names without rewriting messages or
authentication data. Tests also prevent a group title replacing a participant's
name. The native GTK/VTE window replaces the original Ptyxis host because a
physical-key probe confirmed that the installed stock terminal encoded both
Enter and Shift+Enter as the same carriage return, even after keyboard-protocol
negotiation. The native host forwards Shift+Enter as a separate linefeed.

Version 0.1.2 adds in-place Alacritty support. An isolated physical-key test
launched `quietchat --demo` through an interactive Bash shell from `/tmp`, using
the installed PATH command. The application remained inside Alacritty, with no
native window spawned; Shift+Enter inserted a newline and Enter sent one complete
multiline demo message. A minimal-PATH Bash check also resolved the command from
`~/.local/bin`. No global Alacritty configuration was changed.

QuietChat enables the modern keyboard protocol after flushing its alternate-screen
switch, translates key reports for neo-blessed, and restores the mode on exit.
New tests cover split key reports, control shortcuts and multiline bracketed paste
remaining unsent until the user presses Enter. Reproduce the Alacritty test with:

```bash
xvfb-run -a dbus-run-session -- python3 QuietChat/scripts/desktop-smoke.py --alacritty
```

## Memory measurements

These are measurements of this machine and synthetic workloads, not guarantees
for a real account or comparisons against a measured Chromium application.

| Scenario | Node process RSS |
|---|---:|
| Offline terminal demo after startup | 123,068 KiB, approximately **120.2 MiB** |
| Synthetic benchmark before loading history | **109.1 MiB** |
| After inserting 12,000 messages, retaining 10,000, and reading 500 pages | **191.9 MiB** |
| Peak RSS during that synthetic benchmark | **191.9 MiB** |

The demo and history benchmark are separate processes. Neither result includes
mpv, ffmpeg, zenity, the terminal emulator, live WhatsApp protocol traffic or
initial account synchronization. The benchmark does not force garbage collection.
UI history pages contain only display data; raw protocol/media metadata is read
from SQLite only when needed for sending retries, reactions or downloads.

## Requires the owner's phone/account

The real QR probe verifies the current Baileys connection can reach WhatsApp and
obtain a pairing code. It does **not** establish that linked-account operations
have been exercised end to end.

After launching `./QuietChat/run.sh` and scanning the QR, verify:

1. Pairing completes and the expected chats/contacts appear.
2. Text sent deliberately to a chosen contact arrives, and their reply appears.
3. One image and one compatible MP4 can be sent and received; received attachments
   download/decrypt and open in the graphical mpv window.
4. Reactions appear on the phone as expected.
5. Quitting/reopening reuses the login, and a temporary network outage recovers.
6. Observe app RSS during initial synchronization, idle use and media operations;
   measure the viewer processes separately before judging total savings.

Automatic full-history retrieval, live account memory/CPU, recipient delivery
indicators, and complete support for WhatsApp's evolving message formats remain
outside the verified prototype scope.
