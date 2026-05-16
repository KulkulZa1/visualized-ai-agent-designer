# Security

## Threat Model

The app runs entirely locally. The primary risks are:

1. **Malicious hook scripts** — hooks execute arbitrary code
2. **Prompt injection** — agent inputs/outputs containing instructions that hijack behavior
3. **Path traversal** — crafted file paths escaping the workspace
4. **API key leakage** — keys committed to git or leaked via audit log
5. **Supply chain** — vulnerable npm or Cargo dependencies

## Mitigations

### Hook Execution
- Every hook execution requires explicit user consent via a dialog
- The dialog shows the hook file path and warns it will execute code
- Hooks run with a 30-second hard timeout
- stdout/stderr captured and stored in audit log
- Hook processes run in the workspace directory context

### Path Traversal
- All Rust filesystem commands call `resolve_safe_path()` before any I/O
- The function resolves canonical paths and asserts they start with the workspace root
- `../` components are explicitly rejected before path resolution
- Tested in `fs_commands::tests::resolve_safe_path_rejects_traversal`

### Prompt Injection
- Per-node input validation via Zod schemas at IPC boundaries
- Agent outputs should not be passed directly as file paths or commands
- The app does not automatically execute anything from agent output

### API Key Storage
- API keys must NEVER be stored in workflow YAML files
- Use `.env.local` (gitignored) and reference by environment variable name
- OS keychain integration planned for Phase 7 (Tauri `plugin-stronghold`)
- New provider configuration must use credential references such as `env:OPENAI_API_KEY` or future `secure:openai`, not raw key values.
- Existing Settings localStorage key storage is a legacy development shortcut and must be replaced before production use.

### Audit Log
- All file writes and hook executions appended to `{workspace}/.agent-audit/audit.log.jsonl`
- Audit log is gitignored (not version-controlled)
- Audit log never contains API key values

### Supply Chain
- `npm audit` and `cargo audit` run in CI on every push
- Lock files committed (`package-lock.json`, `Cargo.lock`)
- Dependencies reviewed for license compatibility before commercial release

## Security Checklist (Phase 1)

- [x] Path traversal protection in Rust
- [x] User consent gate for hook execution
- [x] Audit log for file writes and hook runs
- [x] `.gitignore` blocks secrets, audit log, build artifacts
- [ ] OS keychain for API keys (Phase 7)
- [ ] Prompt injection scanner (Phase 7)
- [ ] Dependency audit UI (Phase 7)
- [ ] Pre-commit hook to detect secret patterns (Phase 7)

## Provider, Context, and Artifact Security

### Provider Health Checks
- Health checks must be explicit and visible in the UI before network calls.
- Provider configs must disclose local vs cloud execution.
- OpenAI-compatible endpoints must not be assumed safe or feature-complete; capability flags must gate streaming, tools, and model listing.
- Ollama health checks are local by default and must support a configurable base URL.

### Cloud Data Leakage
- Cloud providers may receive prompt text, upstream outputs, file snippets, tool results, and artifacts.
- Context inspection should show what would be sent before live execution whenever possible.
- Per-node provider selection should make local/cloud routing visible.

### Prompt Injection
- Static prompts, upstream outputs, file contents, and tool results must stay visually separated in the context inspector.
- Agent output must never become a file path, command, hook path, or credential reference without validation and user consent.

### Artifact Persistence
- Artifacts may contain generated code, prompts, logs, model payloads, or sensitive file excerpts.
- Artifact persistence must define retention and redaction rules before storing live payloads.
- Audit/log output must mask credential-like strings before display or disk writes.

### VS Code Extension Readiness
- A future VS Code extension should use VS Code Secret Storage for credentials.
- Webviews must use VS Code resource URI conversion and a restrictive content security policy.
- Workspace file and command execution should remain behind explicit permissioned adapters.

## Persisted Snapshot Data

Persisted snapshots at `.harness/snapshots/` may contain prompts, upstream outputs, tool results, and model responses. Do not commit the `.harness/` directory to source control. The `.gitignore` already excludes `.harness/snapshots/` and `.harness/artifacts/` data paths.

## Execution Context Snapshot Risks

Snapshots captured by `SnapshotRepository` may contain sensitive data:

- **Prompt content**: system prompts, developer notes, user prompts, and static node prompts may contain business logic, internal instructions, or data-governance requirements.
- **Upstream outputs**: tool results, file excerpts, and agent outputs may include personal data, credentials referenced in output, or confidential file contents.
- **Final context**: the assembled context string sent to a model may aggregate all of the above into a single payload.

### Constraints

- **No raw API keys in snapshot fields**: `PersistedSnapshot` must never store API key values. Use credential references (e.g., `env:OPENAI_API_KEY`) and never serialize a raw key into snapshot metadata.
- **No cloud persistence without explicit consent**: snapshot data must not be sent to any cloud service or remote endpoint without an explicit, per-user opt-in confirmation. The current implementation is in-memory only.
- **User-controlled deletion**: any future file or database persistence layer must expose a delete or clear operation accessible to the user from the UI.
- **Retention policy**: a future persistence layer must define a maximum retention period and support automatic expiry or user-controlled purge.
- **Ollama remote vs local**: a remote Ollama endpoint (`ollama-remote` provider type) does not provide the same local-only privacy guarantees as `ollama`. Data sent to a remote Ollama host should be treated as cloud data for governance purposes.

### Implementation checklist (future)

- [ ] Add user-visible deletion UI for persisted snapshots before any file/DB backing is added
- [ ] Mask credential-like patterns in snapshot content before display or disk writes
- [ ] Define and document retention policy before enabling file or SQLite persistence
- [ ] Confirm consent flow before sending snapshot content to any remote endpoint

## Reporting Issues

File security issues privately before creating a public GitHub issue.
