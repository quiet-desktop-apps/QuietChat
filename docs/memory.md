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
