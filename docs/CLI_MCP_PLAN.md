# CLI and MCP Plan

Updated: 2026-05-18

This document is now a current-state plus roadmap note. Older text that said
"no MCP server exists" is obsolete.

## Current CLI v0

Entrypoint:

```powershell
npm run harness -- <command>
```

Implemented commands:

| Command | Status |
|---|---|
| `project status` | Working, read-only |
| `provider list [--json]` | Working, read-only, credential references only |
| `workflow validate <file> [--json]` | Working, nonzero on invalid/missing file |

Verified 2026-05-18:

- `npm run harness -- project status`
- `npm run harness -- provider list --json`
- `npm run harness -- workflow validate examples\purchasing-decision.harness.yaml`
- `npm run harness -- workflow validate missing-file-does-not-exist.harness.yaml`

Safety boundary:

- No writes.
- No workflow execution.
- No provider calls.
- No Tauri runtime required.
- No secrets read or printed.
- No MCP write tools.
- No command execution.
- No MATLAB execution.

## Current MCP v0

Entrypoint:

```powershell
npm run mcp
```

Implemented stdio tools:

| Tool | Status |
|---|---|
| `project_status` | Working |
| `list_workflows` | Working |
| `validate_workflow` | Working with project-root path safety |
| `run_tests` | Working with validated filter |
| `run_cargo_tests` | Working |

Safety boundary:

- Stdio only, no TCP server.
- No file writes.
- No workflow execution.
- No hook execution.
- No provider/API calls.
- No secrets read or returned.
- Path traversal rejected for workflow validation.
- Test filter rejects shell metacharacters before subprocess spawn.

## Deferred CLI/MCP v1 Ideas

These are not implemented:

- `workflow list`
- `workflow show`
- `agent list`
- `artifact list`
- `snapshot list`
- `logs tail`
- `run_workflow`
- `save_workflow`
- any write tool

Before adding write or execution tools, implement:

1. Permission model with explicit allow flags.
2. Per-call user consent.
3. Append-only audit entries visible in the UI.
4. Secret redaction for all returned text.
5. Workspace-scoped path resolution matching Rust `resolve_safe_path()`.
6. Tests for denial paths.

## Recommended Next Slice

Add read-only MCP tools only:

- `get_workflow_details`
- `list_examples`
- `get_recent_audit_log`
- `list_artifacts`

Do not add workflow execution or write tools until the permission/audit system
exists.
