# ADR 0001: native UI, explicit resource bounds and shared behaviour

Status: accepted during initial development; recorded for public release on
8 November 2026. Human owner: Paulo Aboim Pinto.

## Context and decision

The human requirement was a focused desktop companion that keeps essential daily
features without embedding Chromium. Memory use must be measured and unused
content released; a lightweight interface alone is not evidence of low total RAM.

Use Python + GTK4 for native desktop widgets and mpv for media. Keep service
integration separated from rendering and exchange explicit completion/events at
asynchronous boundaries. Bound history/feed pages, caches and concurrent work.
Use the user's browser only for explicit actions that require it.

QuietChat retains the TypeScript/Node/Baileys backend and its terminal frontend, sharing authentication and SQLite. Native tray/notifications belong to the GTK frontend.

## Consequences

No embedded browser engine, but external services and runtime processes still cost
memory. Unofficial integrations can break upstream. Native dependencies need Linux
packaging; cross-platform support is not implied. Agents implement and verify within
these human-owned constraints; material changes require a new human-reviewed ADR.
