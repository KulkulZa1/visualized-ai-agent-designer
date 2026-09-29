# Security

Updated: 2026-09-29

## Current Boundary

Harness Studio is a local desktop app with optional cloud provider calls. It
can execute local hook scripts only through the audited Rust command path.
A model-issued `bash`/`run_command` call runs only after the user approves that
exact command in a dialog, once or for the rest of the run (a grant covers only
that exact text). It then runs in the open workspace folder (cmd.exe on
Windows, sh elsewhere) with the user's privileges: it is **not sandboxed** and
can reach outside the workspace. The approval is the only barrier. The
`execute_inline_command` IPC command stays removed. Model-issued
`fs.write`/`fs.append`/`edit_file` calls do write files, confined to the open
workspace; a run's changes can be reverted from the Changes dialog.
The CLI's `project`, `workflow` and `provider` commands are read-only; `harness run`
executes workflows (`docs/HEADLESS.md`). MCP is read/test-only.

## Main Risks

| Risk | Current mitigation | Remaining work |
|---|---|---|
| API key leakage | CLI/MCP print credential references only; `.env*` ignored; Ollama errors redact submitted token; hook processes do not inherit provider API keys; network errors no longer echo URL query strings | Replace localStorage with OS keychain |
| Path traversal | Rust file commands use `resolve_safe_path()`, which resolves the deepest existing ancestor for new files so a symlink/junction inside the workspace cannot redirect writes outside it, and rejects UNC and device paths before any filesystem call; the workspace listing does not follow links; audit entries are not written through a symlinked audit log; MCP `validate_workflow` reads only `*.harness.yaml`/`.yml` files and rejects paths, symlinks included, that resolve outside the project | Add more MCP path tests as tools expand |
| Hook execution | Rust command requires a `consentGranted` flag (set by the caller, not a user-verified token); the Hooks tab asks before running hooks marked `requireConsent`; during runs only Hook-role nodes run their pre-hook, a `requireConsent` hook fails its node and stops the run, and hooks on agent nodes are not run (only manually from the Hooks tab); timeout is the Hook node's `timeoutSeconds` (default 30 s, max 1 h), 30 s from the Hooks tab. A Hook node without `requireConsent` is refused, and stops the run, when its script changed during the run: by an agent's file tools (the change log, in any attempt of the run), or by anything else, as the script's SHA-256 taken for every Hook node when the run first starts and again just before the hook runs (this catches other spellings of the path, links and approved shell commands). The hashes are kept in the run record (`hookScripts`; never the script text). A resume never takes new ones (a record saved before the field is the exception), so a hook without a baseline is refused until a new run. Refusals are audited. The hash needs Web Crypto: `harness run` needs Node 20 or later, else a run with such a hook does not start (exit 3) | Hash the script in Rust, from its bytes, and verify the hash in `execute_hook`. The limits are listed below. Add nonce-based consent if hooks become remotely callable |
| Frontend shell access | `shell:allow-execute` and `shell:allow-kill` removed from default Tauri capabilities | Remove unused shell plugin dependency later if no feature needs it |
| Debug tooling | DevTools are not enabled in release builds (tauri `devtools` feature removed); debug builds still open them | None |
| Hidden cloud calls | No hidden provider calls added; health checks are explicit run/setup actions and a run's preflight contacts only providers that run will use; the billing-error fallback only goes to a local Ollama server | Show exact payload previews before remote calls |
| Prompt injection | Model output runs as a command only after the user approves that exact command, once or for the rest of the run (no blanket approval: a grant covers only that exact text). Model-issued `fs.write`/`fs.append` calls (for nodes granted those tools) do write files inside the open workspace | Add prompt-injection warnings and redaction for persisted traces |
| Agent file writes | `fs.write`/`fs.append`/`edit_file` refuse git internals (any `.git` path segment, including a `.git` file), `.harness/hooks/`, `.harness/runs/` (a resumed run trusts its saved record, which holds the hook-script hashes) and `.harness/audit.log.jsonl`. A Hook node whose script an agent wrote earlier in the same run is refused like one that needs consent (see Hook execution). `fs.write` refuses to overwrite a file it cannot read, so every agent write is in the run's change log and can be reverted | The check is on the path as written: Windows aliases (8.3 names such as `GIT~1`, trailing dots, NTFS streams) and links are not covered. An approved `bash` command can write these paths anyway |
| Agent shell commands | Approval dialog per command: it shows the agent, the command and the folder; Deny has the focus, Esc denies, and a click outside does nothing. "Allow for this run" grants that exact command text until the run ends; the dialog warns that it then runs again even if the agent changes what it runs (for example package.json scripts). The Rust `execute_command` refuses without `consentGranted` (set by the caller after approval, not a user-verified token). The command runs in the workspace folder without provider API keys or input, and is stopped at the node's remaining time. A network-share workspace is refused on Windows, because cmd.exe would run the command in `C:\Windows`. Stop kills a running command's process tree (`cancel_command`). Sub-agents never get `bash`; Stop, or the end of the run, denies pending approvals and ends the run's grants. Approvals, denials and results are audited | No sandbox or allowlist: an approved command has the user's privileges. The macOS `sh` path is untested; on Linux, tests cover the process-group kill on Stop and on timeout |
| MCP command injection | `run_tests.filter` validates characters and rejects traversal before spawning | Keep MCP test tools bounded |
| Tool and sub-agent escalation | An agent runs only the tools offered to it (read tools included); the system prompt names only those. `subagent_dispatch` helpers get a subset of their parent's tools, cannot start helpers themselves, share the parent's deadline and Stop, and are capped at 5 per node run (3 at a time) | A single helper cannot be stopped on its own (Stop ends the whole run) |

## Hook Script Check: Limits

A Hook node without `requireConsent` runs its script with nobody asking. The run
engine refuses it when the script changed during the run (Hook execution above).
The check has these limits:

- Scripts that aren't valid UTF-8 are covered only by the change log. The engine
  reads the script as text, so one it cannot read has no hash before or after, and
  the two compare equal.
- Files a script sources or imports are not covered: only the hook script's own
  text is hashed.
- There is a gap between the check and the hook's start: the engine hashes the
  script, and then `execute_hook` runs it by path.
- An approved `bash` command can still write anywhere in the workspace, run
  records included. The hash catches a rewritten script, not a rewritten record
  that a later resume trusts.
- A new run takes the scripts as they are as its baseline: a script changed before
  the run, or by an earlier run, is accepted.
- A record saved before the `hookScripts` field existed has no baselines, and
  resuming it takes them from the scripts as they are then.

The fix for the first and third is to hash the script's bytes in Rust and verify
the hash in `execute_hook` (AGENT.md, Next Best Work).

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

## CLI

`cli/harness.mjs` has read-only commands (`project`, `workflow`, `provider`) and
`run`. The read-only commands:

- read project files and provider catalog metadata only;
- validate workflow YAML;
- print credential references like `env:OPENAI_API_KEY`;
- do not read raw env values, localStorage, Tauri stores, or keychains;
- do not mutate files;
- do not run workflows, providers, hooks, commands, MCP write tools, or MATLAB;
- read `package.json`, the audit log and the snapshot index (`project status`) only
  when each is a regular file whose real path is inside the workspace, and do not
  follow links when they look for workflow files.

`harness run` is not read-only: it makes provider calls, reads and writes workspace
files, and runs hooks and the agent commands passed exactly with `--allow-command`,
through `harness-core`. Keys come from the environment only (`docs/HEADLESS.md`).

## MCP v0

`mcp/server.mjs`:

- uses stdio transport only;
- exposes 8 tools: `project_status`, `list_workflows`, `validate_workflow`,
  `run_tests`, `run_cargo_tests`, `list_providers`, `list_artifacts`, and
  `get_recent_logs`;
- has no write tools and no workflow execution;
- rejects path traversal in `validate_workflow`, and workspace paths outside the
  project in `list_artifacts`/`get_recent_logs`;
- resolves links before it reads: the real path of `.harness/artifacts` and of the
  audit log must be inside both the workspace and the project, and one that leads
  out through a symlink or junction is refused (the error names no outside path);
- reads only a regular file in `get_recent_logs`: an audit log that is a FIFO, a
  device or a folder is refused, because opening a FIFO with no writer would block
  the single-threaded server;
- does not follow symlinks or junctions when it searches for files
  (`list_workflows`, `project_status`), so a link can neither lead the walk out of
  the project nor loop it;
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
when a workspace is open, and so is every Hook node the engine refused to run (a
refusal says why). So is every agent shell command: approved and run
(with its exit code), denied, or failed to start (`command_executed`). The old `.agent-audit/` path is deprecated and should
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
6. Agent shell commands run unsandboxed once approved: decide on a sandbox or an
   allowlist.
