# QuietChat memory evidence

All units below are **MiB** (1,048,576 bytes). RSS is resident memory per process;
summing it can count shared libraries more than once. PSS apportions shared pages.
Neither metric alone captures all GPU/desktop costs. Values are observations,
not limits or guarantees.

## Live development observations — 7 November 2026

These figures were captured during interactive development on one Linux workstation
and discussed with the owner. They are not a controlled equal-workload benchmark;
original raw process snapshots were not retained as a publishable benchmark artifact.

| Observation | QuietChat | Chromium-based WhatsApp client |
|---|---:|---:|
| Desktop app/process-group RSS snapshot | ~244 MiB | ~1,536 MiB |
| Same snapshot, process-group PSS | ~132 MiB | ~1,110 MiB |
| QuietChat hidden in tray, later snapshot | ~238 MiB RSS / ~132 MiB PSS | Not remeasured |
| Terminal, owner-reported everyday observation | ~170 MiB app RSS | Not paired |

The desktop RSS snapshot was about **84% lower**, and PSS about **88% lower**,
than that particular Chromium client. This does not establish equivalent history,
media state, startup age or feature coverage. QuietChat's group included its GTK
UI, Node backend and small helpers; external media players and shared desktop
services were not included. The terminal observation excludes the terminal emulator
and mpv. It is approximate, not a newly reproduced 170 MiB benchmark.

A process-age check once showed about two minutes after a restart, despite the
owner's longer session of app usage. It must not be labelled a one-hour continuous
process benchmark. Hiding to tray releases message widgets, but keeps the backend
connected and notifications working. It does not periodically restart the app.

## Recorded synthetic checks

| Workload | Reported RSS | Scope |
|---|---:|---|
| Offline terminal startup | 120.2 MiB | Node only |
| Synthetic history: 12,000 inserted, 10,000 retained, 500 page reads | 191.9 MiB peak | Node; no live protocol or terminal emulator |
| Native offline integration with media/clipboard fixtures | ~308–315 MiB | GTK + Node; excludes mpv/ffmpeg and desktop daemons |
| Ten repeated native chat round trips | ~0 MiB additional RSS after warm-up in recorded runs | Short stability check, not a long-duration guarantee |

Synthetic results differ from live results because fixtures, UI interactions and
allocator state differ. The GTK frontend is not always the same size as the terminal
frontend. Freed widgets do not necessarily return pages immediately to the OS.

## Reproduce and report honestly

From the repository root, `npm run benchmark` runs the synthetic history workload.
`npm run test:native` reports combined UI/backend RSS and chat-switch growth during
its offline integration. `npm run test:terminal` exercises terminal behaviour.
For a process-tree sample use the script in the organization repository:
[measure-memory.py](https://github.com/quiet-desktop-apps/.github/blob/master/scripts/measure-memory.py).

A meaningful new comparison records distribution, app/dependency versions, codec
and resolution (if any), process ages, loaded history and workload. Use the same
metric and include every renderer/worker/player belonging to each app. Measure
startup, steady idle, active use, media playback and tray separately. Preserve
sanitized numeric samples; do not publish process command lines containing private
URLs or credentials. We welcome reproducible improvements over these initial
observations.

## Hidden UI cache cleanup — 8 November 2026 (0.2.10)

A same-workload offline probe compared the old UI with the new cleanup after ten
chat round trips. It used a fresh Xvfb/D-Bus session per run, three synthetic chats
and two media messages. It did not connect an account or restart the owner's app.

| Tray measurement, three seconds after hiding | Before | After |
|---|---:|---:|
| GTK RSS | 191.60 MiB | 187.06 MiB |
| Backend RSS | 102.70 MiB | 102.40 MiB |
| Combined RSS | 294.30 MiB | 289.46 MiB |
| Retained sidebar rows / decoded avatar entries | 3 / 3 | 0 / 0 |

This small fixture recovered about 4.5 MiB in GTK, not the whole 30 MiB overnight
increase reported in live use. Backend variation is not attributed to the UI fix.
See the [numeric samples](cache-memory-2026-11-08.json); they include warm, switched
and reopened phases plus PSS. Shared-library attribution varies between runs.
The live ~300 MiB session was left running and was not used for this comparison.

Hidden windows now release sidebar widgets, decoded avatars, message widgets and
preview textures, including the attachment thumbnail (its draft file is kept).
Late display requests cannot recreate them while hidden; tray counters and popup
notifications continue. Scrolling drops offscreen avatar textures. The existing
16 MiB/200-file preview disk cache remains available for rebuilding the view.

After navigation or hiding settles, a single deferred cleanup collects Python
cycles and, where glibc provides it, calls `malloc_trim(0)` to request return of
unused native heap pages. Other platforms use object cleanup alone. This is not
a periodic forced-GC loop and does not discard live objects or restart the backend.
The GTK/Node runtimes, connection and drafts still need memory; there is no fixed
RSS target or guarantee that every freed object immediately lowers RSS.

Reproduce the synthetic probe with:

```bash
GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1400x1000x24' \
  dbus-run-session -- /usr/bin/python3 scripts/cache-memory.py
```
