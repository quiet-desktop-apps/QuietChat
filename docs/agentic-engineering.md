# Agentic Engineering at Quiet

Quiet uses Agentic Engineering: humans own the idea, high-level requirements,
acceptance criteria and important technical decisions; coding agents carry out
implementation, tests and documentation within that direction.

Paulo Aboim Pinto is the founding human maintainer. The original applications were
developed iteratively with coding agents, through real use, screenshots, feedback
and measured resource usage. This is a description of the working process, not a
claim that every change is correct because an agent produced it.

## Responsibility and change flow

1. A human describes the user problem, expected outcome and constraints in an issue
   or PR. Significant scope, architecture, privacy and dependency decisions need
   human agreement; record the rationale under `docs/decisions/`.
2. An agent or contributor implements on a feature branch. Keep changes scoped,
   preserve unrelated work, and use synthetic accounts/data for tests.
3. Run relevant checks. Report exactly what passed, failed or was not exercised.
   A simulated interaction is not proof of live service compatibility.
4. Open a PR describing the outcome, human requirement, agent involvement,
   significant decisions, tests, memory impact and remaining limitations.
5. The human maintainer owns acceptance and merge authority. Agents may carry out
   an explicitly authorized publication or merge after reviewing the diff and
   passing the required checks. Otherwise, leave the PR for human review. Never
   claim an agent review is independent human approval, or bypass repository rules.

The `master` branch requires a pull request and passing CI, with no configured
bypass actors. Feature branches necessarily accept commits for a PR. At launch,
there is one maintainer: GitHub cannot require that author to approve their own PR,
so an independent approval is not a merge prerequisite yet. Human direction and
merge authorization remain part of the workflow. Add a second maintainer and require one independent approval
when available. Repository administrators can edit rules; this is access control,
not an irreversible guarantee against the account owner.

Agent disclosure is welcome, and contributors remain responsible for the code,
its provenance and its license compatibility. Do not submit credentials, private
conversations, real session cookies or personally identifying screenshots to an
agent prompt, public issue or pull request.
