# Security

Updated: 2026-09-24

## Current Boundary

Harness Studio is a local desktop app with optional cloud provider calls. It
can execute local hook scripts only through the audited Rust command path.
Agents have no shell tool: model-issued `bash`/`run_command` calls are refused
and the `execute_inline_command` IPC command was removed. Model-issued
`fs.write`/`fs.append` calls do write files, confined to the open workspace.
CLI is read-only. MCP is read/test-only.

## Main Risks

| Risk | Current mitigation | Remaining work |
|---|---|---|
| API key leakage | CLI/MCP print credential references only; `.env*` ignored; Ollama errors redact submitted token; hook processes do not inherit provider API keys; network errors no longer echo URL query strings | Replace localStorage with OS keychain |
| Path traversal | Rust file commands use `resolve_safe_path()`, which resolves the deepest existing ancestor for new files so a symlink/junction inside the workspace cannot redirect writes outside it; MCP `validate_workflow` rejects `..` and outside-root paths | Add more MCP path tests as tools expand |
| Hook execution | Rust command requires a `consentGranted` flag (set by the caller, not a user-verified token); the Hooks tab asks before running hooks marked `requireConsent`; during runs only Hook-role nodes run their pre-hook, a `requireConsent` hook fails its node and stops the run, and hooks on agent nodes are not run (only manually from the Hooks tab); timeout is the Hook node's `timeoutSeconds` (default 30 s, max 1 h), 30 s from the Hooks tab | Add nonce-based consent if hooks become remotely callable |
| Frontend shell access | `shell:allow-execute` and `shell:allow-kill` removed from default Tauri capabilities | Remove unused shell plugin dependency later if no feature needs it |
| Debug tooling | DevTools are not enabled in release builds (tauri `devtools` feature removed); debug builds still open them | None |
| Hidden cloud calls | No hidden provider calls added; health checks are explicit run/setup actions and a run's preflight contacts only providers that run will use; the billing-error fallback only goes to a local Ollama server | Show exact payload previews before remote calls |
| Prompt injection | Agent shell execution is disabled, so model output never runs as a command. Model-issued `fs.write`/`fs.append` calls (for nodes granted those tools) do write files inside the open workspace | Add prompt-injection warnings and redaction for persisted traces; per-command consent before re-enabling shell execution |
| MCP command injection | `run_tests.filter` validates characters and rejects traversal before spawning | Keep MCP test tools bounded |
| Tool and sub-agent escalation | An agent runs only the tools offered to it (read tools included); the system prompt names only those. `subagent_dispatch` helpers get a subset of their parent's tools, cannot start helpers themselves, share the parent's deadline and Stop, and are capped at 5 per node run (3 at a time) | Show sub-agent activity in the activity panel, not only the audit log |

## Provider Privacy

- OpenAI and Anthropic are cloud providers. Prompts, upstream outputs, file
  snippets, and tool results may leave the device.
- Ollama local is local/private only when the base URL is local, such as
  `http://localhost:11434`.
- Ollama Cloud uses `https://ollama.com/api` and must be treated as hosted
  cloud execution.
- Authenticated remote Ollama gateways are also cloud/hosted from a privacy
  perspective.
- `OLLAMA_API_KEY` is endpoint-scoped to `ollama.com`.
- `OLLAMA_REMOTE_API_KEY` is for non-local remote Ollama gateways.
- Local Ollama does not inherit cloud env keys unless a token is explicitly
  supplied.

## CLI v0

`cli/harness.mjs`:

- reads project files and provider catalog metadata only;
- validates workflow YAML;
- prints credential references like `env:OPENAI_API_KEY`;
- does not read raw env values, localStorage, Tauri stores, or keychains;
- does not mutate files;
- does not run workflows, providers, hooks, commands, MCP write tools, or MATLAB.

## MCP v0

`mcp/server.mjs`:

- uses stdio transport only;
- exposes 8 tools: `project_status`, `list_workflows`, `validate_workflow`,
  `run_tests`, `run_cargo_tests`, `list_providers`, `list_artifacts`, and
  `get_recent_logs`;
- has no write tools and no workflow execution;
- rejects path traversal in `validate_workflow`, and workspace paths outside the
  project in `list_artifacts`/`get_recent_logs`;
- validates the optional Vitest filter before spawning (values starting with `-`
  are rejected) and runs `npx` with `--no-install`;
- does not read provider credentials; `list_providers` returns credential
  references only;
- returns `.harness/audit.log.jsonl` entries from `get_recent_logs` with
  best-effort secret redaction, which is not a guarantee;
- does not make provider calls.

## Audit and Artifacts

Current audit path is:

```text
.harness/audit.log.jsonl
```

Hook runs inside workflows and manual runs from the Hooks tab are appended to it
when a workspace is open. The old `.agent-audit/` path is deprecated and should
not be used in new docs or code. `.harness/snapshots/` and `.harness/artifacts/`
are ignored by git.

Artifacts shown in the context inspector are currently mock placeholders. Do
not treat them as durable evidence until execution is wired to artifact
persistence.

## Release Security Blockers

1. OS keychain or Stronghold storage for API keys.
2. Installer signing strategy.
3. Secret-pattern scan in CI.
4. Dependency audit in CI or release checklist. Current docs must not claim CI
   runs `npm audit` or `cargo audit` until that workflow exists.
5. Redaction pass for persisted snapshots/artifacts before enabling durable run
   traces by default.
6. Per-command consent system before re-enabling agent shell execution.
