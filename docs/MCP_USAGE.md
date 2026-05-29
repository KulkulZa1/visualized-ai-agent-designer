# MCP Server Usage

Harness Studio includes a local stdio MCP server at `mcp/server.mjs`.

Status: working read/test v0, verified 2026-05-18. It is not a workflow runner
and it has no write tools.

## Start

```powershell
npm run mcp
```

Expected stderr:

```text
[harness-studio MCP] ready - tools: run_tests, run_cargo_tests, validate_workflow, project_status, list_workflows
```

The server uses JSON-RPC over stdin/stdout and exits when stdin closes.

## Tools

| Tool | Status | Notes |
|---|---|---|
| `project_status` | Working | Counts workflows/tests/docs and runs a type-check probe |
| `list_workflows` | Working | Lists `.harness.yaml` files under the project |
| `validate_workflow` | Working | Validates a workflow path scoped to the project root |
| `run_tests` | Working | Runs Vitest; optional filter is validated before subprocess spawn |
| `run_cargo_tests` | Working | Runs `cargo test` in `src-tauri` |

Not implemented:

- `run_workflow`
- `save_workflow`
- `write_file`
- arbitrary command execution
- provider/API calls
- secrets access

## Manual Smoke Test

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_status","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"validate_workflow","arguments":{"path":"examples/purchasing-decision.harness.yaml"}}}
'@ | node mcp/server.mjs
```

Path safety check:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_workflow","arguments":{"path":"../package.json"}}}
'@ | node mcp/server.mjs
```

Expected result: `valid:false` and `Path rejected`.

Filtered test check:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_tests","arguments":{"filter":"tests/unit/services/wizard/goalTemplates.test.ts"}}}
'@ | node mcp/server.mjs
```

Verified result on 2026-05-18: 23 Vitest tests passed.

## Claude Code Configuration Example

```json
{
  "mcpServers": {
    "harness-studio": {
      "command": "node",
      "args": ["mcp/server.mjs"],
      "cwd": "D:/toy_project/AI_agent"
    }
  }
}
```

Restart the MCP client after changing configuration.

## Security Boundary

The MCP server is intentionally constrained:

- No file writes.
- No workflow execution.
- No hook execution.
- No provider calls or hidden network calls.
- No raw API key reads or output.
- `validate_workflow` rejects `..` and paths outside the project root.
- `run_tests.filter` rejects shell metacharacters and path traversal.
- Test commands are limited to the project's Vitest and Cargo suites.

Future write or execution tools require a permission system, user consent, and
audit logging before implementation.
