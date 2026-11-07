# Contributing

Thank you for helping build Quiet. Start with a small issue explaining the user
problem and expected behaviour. Discuss significant features or architecture
changes before implementing them. See [our engineering process](docs/agentic-engineering.md).

## Pull requests only

Fork the repository, create a feature branch from `master`, make focused changes,
and open a PR. Never push directly to `master`, force-push it or bypass checks.
The maintainer owns acceptance and authorizes merges through GitHub. Keep agent-generated changes
reviewable and disclose agent involvement in the PR; using agents is welcome.

Use English for code, issues and documentation. Preserve existing behaviour and
include a meaningful regression check for a bug fix. Document architecture/privacy
changes and do not claim tests or live-service checks you have not run.

See the README for setup and test commands. Tests must use temporary storage and
synthetic accounts; never depend on a contributor's WhatsApp/YouTube login.
Memory reports should include the workload, process scope, RSS/PSS metric,
software versions and elapsed runtime. See `docs/memory.md` where provided.

## Licensing and community

By submitting a contribution, you agree that your original contribution is
available under this repository's MIT license and that you have the right to
submit it. Preserve third-party copyright/license notices. No CLA is required.
Be respectful, assume good faith and focus criticism on behaviour or code.
Harassment and disclosure of personal information are not acceptable. Maintainers
may moderate or close abusive interactions. Do not put sensitive material in issues;
use [private security reporting](SECURITY.md) for vulnerabilities.

Founding maintainer: [Paulo Aboim Pinto](https://github.com/aboimpinto).
