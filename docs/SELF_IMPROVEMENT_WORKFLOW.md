# Self-Improvement Workflow

Updated: 2026-05-18

The Harness Studio Self-Improvement template exists in the rule-based Workflow
Wizard as `harness-self-improvement`. It is the benchmark workflow for the long
term goal: Harness Studio should eventually help develop, debug, and improve
Harness Studio itself.

## Current Status

Implemented:

- Template appears in Create from Goal.
- Template converts to schema-valid workflow.
- Agents are logically separated by node, prompt, model, output, and status.
- The workflow is safe by design: it proposes changes and test plans; it does not auto-apply patches.

Not implemented yet:

- True parallel execution.
- Durable artifact persistence for produced reports.
- Complete per-agent context trace persistence.
- Automatic code patching.
- Safe command execution from workflow agents.
- MCP write tools.

## Agents

1. Project Inspector.
2. UX Reviewer.
3. Bug Reproducer.
4. Test Planner.
5. Change Planner.
6. Security Reviewer.
7. Docs Updater.
8. Release Readiness.

## Expected Artifacts

- `issue-list.md`
- `proposed-changes.md`
- `test-plan.md`
- `security-report.md`
- `docs-draft.md`
- `release-readiness.md`

Current limitation: these artifacts are expected outputs in the workflow design.
Harness Studio does not yet persist them as real per-run files from execution.

## Verification Method

A useful self-improvement run must include:

- exact files inspected;
- exact commands and results used as evidence;
- identified root causes, not only symptoms;
- proposed tests;
- security review for secret, path, hook, MCP, and provider-call risks;
- a go/no-go release readiness decision.

## Future Completion Criteria

Harness Studio can claim this benchmark is working only after a run can:

1. Inspect current project state.
2. Create separate per-agent logs and outputs.
3. Persist artifacts to disk with source node identity.
4. Verify tests/build/package results.
5. Produce a release-readiness report without hidden cloud calls or unsafe execution.
