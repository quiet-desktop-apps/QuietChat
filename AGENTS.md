# QuietChat

Independent repository in the Quiet organization. Use this directory for all Git
operations; never commit these files from a parent workspace.

- Humans own requirements, acceptance criteria and important technical decisions.
  Read `docs/agentic-engineering.md` and `docs/architecture.md` before substantial work.
- Default integration branch: `master`. Work on a feature branch and open a PR.
  Never push directly to master or bypass protections. Merge only when the human
  task explicitly authorizes publication/merging and required checks pass.
- Preserve both native GTK4 and terminal frontends. No embedded browser engine.
- Keep IPC/cache/history/concurrency bounds and explicit completion handling.
- Use only synthetic accounts and temporary state in tests. Never read or publish
  real authentication databases, pairing QR codes, private messages or cookies.
- Run `npm test` and relevant terminal/native regressions. Record live-account
  checks separately. Do not imply X11 tests verify Wayland input-method behaviour.
- Keep installed launchers linked to this checkout; don't create a second code copy.
- Keep public memory claims scoped by process, workload, metric and elapsed time.
- No subagents unless explicitly requested by the human maintainer.
