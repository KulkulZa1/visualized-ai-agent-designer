# CLAUDE.md

Instructions for AI coding agents working on this repository live in
[AGENT.md](AGENT.md) — read it before touching files.

The current verified / partial / mocked status is in
[docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md).

The Harness Studio–generated description of the example 12-agent harness that
used to be this file is now
[examples/harness-studio-project.CLAUDE.md](examples/harness-studio-project.CLAUDE.md).
It describes a workflow built *with* the app, not how to work on the app.

## Work process: director, advisor, workers (main session only)

This section is for the main Claude Code session. Subagents: skip it and follow
your own agent prompt.

Work is split into three roles. `.claude/settings.json` pins the director's
model (`model`), the advisor's model (`advisorModel`), and the default model
for subagents (`CLAUDE_CODE_SUBAGENT_MODEL`, which cloud sessions don't apply).
The workers in `.claude/agents/` pin theirs with `model:`. In cloud sessions,
the app's model picker and advisor setting can override the first two: pick
the same models there, and check the advisor with `/advisor`.

| Role | Runs as | Job |
|---|---|---|
| Director | the main session | Plans, briefs workers, decides, integrates, commits, reports |
| Advisor | the director's `advisor` tool | Reviews the director's whole conversation at key moments |
| Workers | `implementer`, `reviewer`, `verifier` subagents | Write code and tests, review changes, run the checks |

As the director:
- Delegate. Code and tests go to `implementer`, reviews to `reviewer`, checks
  to `verifier`, and broad code searches to `Explore`. Pass `model: sonnet`
  when you start a built-in agent (`Explore`, `general-purpose`, `Plan`);
  otherwise it may inherit your model. Edit files yourself only when writing
  the brief would take longer than the edit (a typo, a one-line fix, a doc
  tweak).
- Write self-contained briefs. Workers don't see this conversation: give the
  goal, the relevant files, the constraints from AGENT.md, and how to check the
  result.
- Run independent tasks in parallel. Give tasks that touch the same files to
  one worker at a time.
- For each task: `implementer`, then `reviewer`. Send blocking findings back to
  an `implementer` and review again, then run `verifier`. A task is done when
  the verifier reports PASS and the reviewer has nothing blocking.
- Use `advisor` as its tool description says, and also when a reviewer and an
  implementer disagree. It is the most expensive model and each call sends the
  whole conversation, so don't call it for routine steps. If you have no
  `advisor` tool, tell the user once so they can check `/advisor`.
- Own git (commits, pushes, PRs) and the final report. Base "done" on the
  verifier's evidence, not on an implementer's report.
