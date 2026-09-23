# Full Audit — Defects, Misleading Claims and Gaps

Date: 2026-09-24
Branch: `claude/airgap-hardening` (changes uncommitted at time of writing)

Scope: the whole repository — Rust backend and packaging, execution engine and
providers, workflow model / stores / generators, UI components, CLI / MCP /
VS Code extension / hook scripts, and documentation vs. code. Six independent
reviewers produced ~90 findings. Code fixes were made test-first (a failing test
reproducing the defect, then the fix); UI label, layout (`StatusBar` grid area)
and repository-hygiene changes were not.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx vitest run` | 456 tests / 42 files pass (was 288 / 30) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 45 tests pass (was 30) |
| `npm run build` | Passes (existing chunk-size warnings only) |
| `cargo check --release` | Passes without the `devtools` feature |

Not verified here: live provider calls (no network/keys), a real Tauri window,
and installer smoke tests on a clean machine.

## Fixed — critical / high

| Area | Defect | Fix |
|---|---|---|
| Providers | Dotted Claude IDs (`claude-sonnet-4.6`, used across the app) were sent verbatim → Anthropic 404 on every call, while preflight (hyphenated ID) passed | Normalized to API IDs in `providerAdapter.ts` and in Rust (`normalize_anthropic_model`) |
| Providers | OpenAI requests sent `reasoning: {effort}` and `max_tokens` → 400 on GPT-5.x / o-series | `openai_chat_body`: `max_completion_tokens` + `reasoning_effort` for OpenAI; custom endpoints keep `max_tokens` |
| Security | Model-issued `bash` commands ran through PowerShell with a hard-coded `consentGranted: true` (prompt injection → arbitrary commands) | **User decision:** agent shell execution blocked; `execute_inline_command` IPC removed |
| Data | Save → reload rewired or dropped edges for canvas-built workflows (node IDs vs positional `agent-<i>`) | `toWorkflowDef` writes positional IDs, drops dangling edges |
| Data | Undo after loading a workflow resurrected the previous graph under the new file name; Ctrl+S then overwrote it | Undo history cleared on load/reset; no-op writes not recorded |
| UI | `AgentActivityPanel` hook-order bug blanked the whole app when its node disappeared | Hooks moved above the early return |
| Execution | File-based prompts sent the literal `[System prompt from file: …]` | `promptSource.ts` reads the file (node fails if unreadable) |
| Execution | Scheduler kept starting nodes after a fatal error; settled while siblings still wrote results | Stops scheduling on failure, settles after in-flight nodes drain |
| Execution | Failed agents reported the run as DONE; overlapping runs possible; snapshots stamped with the previous run ID | Status `error` when any agent failed; single-run guard; run-scoped ID and cancellation |
| Execution | Gateway: joins with a live input were skipped; an unmatched route skipped every branch | Per-edge "not taken" tracking; unmatched route follows all branches |
| Execution | User task never reached agents behind a hook/memory node (flagship example) | `entryNodes.ts`, shared with the Run dialog |
| Execution | Keys set only as environment variables failed before reaching Rust | `requiresKey` waived when the backend reports an env key |
| Rust | Windows `\\?\` paths made every `.bat`/`.ps1`/`.sh` hook fail | `interpreter_path` strips the verbatim prefix |
| Rust | >64 KiB of child output deadlocked until timeout; grandchildren held pipes forever | Concurrent capped pipe readers, 2 s grace, tree kill on timeout |
| Editor | Unreadable (binary / non-UTF-8) files opened empty and Ctrl+S truncated them | Load-error state; editor never mounts |
| Editor | Switching tabs discarded unsaved edits; Ctrl+S could target the previous file | Per-tab unsaved buffers, `key={path}`, confirm on closing a dirty tab |
| Generators | CrewAI export never ran (JS booleans, unescaped strings, bad identifiers); LangGraph failed to build with gateways | Valid Python for all 7 examples (AST-checked) |

## Fixed — medium / low (selection)

- Security: hook processes no longer inherit provider API keys; `resolve_safe_path` resolves the deepest existing ancestor (junction/symlink escape); atomic writes use unique temp names and refuse directory targets; release builds no longer enable DevTools; network errors no longer echo URL query strings; the billing fallback never re-sends prompts to a remote Ollama; preflight no longer contacts unused cloud providers.
- Hooks: a failed or unconsented hook gate stops the run; hooks require an open workspace (no `projectRoot` from pasted YAML); workflow hook runs are audited to `.harness/audit.log.jsonl`; UI no longer calls agent-node hooks a "gate".
- Hook scripts: `url_allowlist.py` (lstrip bypass, scheme), `destructive_guard.sh` (SIGPIPE fail-open, trivial bypasses), `rate_limit_sentinel.py` (cp949 crash), `test_gate` personal path.
- Execution: per-node timeout enforced; hidden 4096 max-token cap removed; Stop prevents a pending tool call; think depth only for reasoning models; run status kept out of undo history; snapshot index race; `list_files` tool now sees nested files; `fs.append` no longer overwrites unreadable files.
- Rust providers: Ollama exact-tag model check and real error messages; 5xx/529 retried; Anthropic model list no longer masks a bad key.
- MCP: notification handling and JSON-RPC error codes, `--watch` filter hang, `npx --no-install`, result parsing, secret redaction (uncommitted additions), log sorting/null lines/size cap, artifact listing flags and link-following.
- CLI `--workspace` parsing; VS Code host path containment and OpenAI key exfiltration.
- UI: first-run "Open Workspace" button + Ctrl+Shift+O; Ctrl+L / Ctrl+. / Ctrl+Shift+Z; shortcuts ignored while typing; real valid/invalid badge; working command-palette actions; Ctrl+S validates; session restore; Generate asks before overwriting; Context tab no longer writes mock snapshots; status bar overlap; stale Claude pricing.
- Repo: build artifacts and personal settings untracked; `outputs/` ignored; `.gitattributes`; generated root `CLAUDE.md` moved to `examples/`.
- Found by a second (regression) review of this pass and fixed: LangGraph feedback edges are emitted as a conditional-edge template (an unconditional back edge looped until `GraphRecursionError`); Stop now releases the run promptly instead of blocking new runs until an in-flight provider call times out; a paid provider call is no longer started after the node's deadline; hook nodes run with their own `timeoutSeconds` (was a fixed 30 s); text typed during an editor save stays unsaved; Ctrl+L / Ctrl+. no longer fire while typing. A final review found that the longer hook timeout would have frozen the window: `execute_hook` (and `list_workspace_files`) were plain sync Tauri commands, which run on the main thread. Both now use `#[tauri::command(async)]` (thread pool), and Stop no longer waits for a running hook to finish.

## User decisions (2026-09-24)

1. Agent shell commands: **blocked** until a per-command consent system exists.
2. Root `CLAUDE.md`: generated content moved to `examples/harness-studio-project.CLAUDE.md`; root is a pointer to `AGENT.md`.
3. `.claude/settings.local.json`: untracked and ignored.
4. `outputs/`: evidence screenshot moved to `docs/assets/`, directory ignored.

## Not fixed — reported

| Item | Why not fixed here |
|---|---|
| Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` are not applied at runtime | Features; temperature needs per-model rules (newer Claude and OpenAI reasoning models reject sampling params). Now labeled in the UI and docs |
| Gateway label matching is substring-based (`ui` matches `build`) | May be intended for `approved-with-changes`; needs a routing-spec decision |
| Pre/post hooks never run on agent nodes; hooks get no per-call input | Running them would break the bundled examples (scripts expect `HOOK_INPUT`); needs a hook protocol design |
| Backend trusts the frontend-supplied workspace root | Needs a backend-remembered workspace (design change) |
| Snapshot files pruned from the index are never deleted | Needs a restricted delete command |
| No UI to change an edge's kind (feedback edges only via YAML) | Feature |
| Wizard `ollamaReady` hard-coded false; substring goal matching (`postgres` → blog) | Part of in-progress uncommitted wizard work |
| Memory nodes write one aggregated blob to every key | Semantics decision |
| Loading a workflow over unsaved changes does not ask first | Needs a confirm flow across 5 entry points |
| VS Code extension mostly non-functional (command-name mismatches) | Larger integration task |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` environment variables are ignored by the desktop app (Settings defaults always win) | Needs "explicitly set" tracking in Settings; documented in `.env.example` |
| Audit filter chips "tool"/"consent"/"warn" never match real entries; example YAML inline copies in `useExamples.ts` drift from `examples/*.yaml` | Low impact; needs audit action types / a drift test |
| HooksTab results are not keyed per node; Settings "Cancel" does not undo provider mode | Small UI state fixes, not done here |
| `iter_counter.py` counts across all runs and never resets | Needs a run identifier passed to hooks |
| Dead code: `KeyboardHelp.tsx` (also lists `Ctrl+?`), `WorkspaceSelector.tsx`, `FileTree*.tsx`, `nodeRegistry.ts`, `useModelRegistry.ts`; 80+ hex colour literals despite the CSS-variables rule | Reported, not removed |
| MCP `validate_workflow` schema is looser than the CLI's | Needs a shared schema module |
| Hook/command output decoded as UTF-8 (garbled on non-UTF-8 code pages) | Needs OEM code-page decoding |
| `docs/AGENT_WORKFLOW_SPEC.md` / `docs/DEVELOPMENT_LOG.md` contain mojibake since commit bec70ff | Restoring needs a careful per-line merge |
| Unused dependencies (`@radix-ui/*`, `clsx`, `rusqlite`, `anyhow`, …) | Removing them needs `npm install`/lockfile updates (no network here) |

## Before committing

Several new files are untracked but imported or linked by tracked files; commit
them together or `tsc`/`vitest` fail (or links break) on a clean checkout:

- `src/services/execution/promptSource.ts`, `src/services/execution/entryNodes.ts`,
  `src/services/wizard/recommendationBrief.ts`
- tests: `tests/unit/components/{AgentActivityPanel,CommandPalette,ContextInspectorTab,MarkdownEditor,TopBar}.test.tsx`,
  `tests/unit/generators/hookTemplates.test.ts`,
  `tests/unit/hooks/{useGenerator,useWorkflow,useWorkflowExecution}.test.ts`,
  `tests/unit/services/execution/{entryNodes,promptSource}.test.ts`,
  `tests/unit/store/uiStore.test.ts`
- `docs/REVIEW_FULL_AUDIT_2026-09.md` (this file; linked from PROJECT_STATUS and DEVELOPMENT_LOG),
  `docs/MARKET_RESEARCH.md` (linked from `docs/README.md`), `docs/assets/empty-state.png`
- `examples/harness-studio-project.CLAUDE.md`, `.gitattributes`

The removal of `src-tauri/target-codex-verify*` and `.claude/settings.local.json`
from the index is already staged.

`docs/REVIEW_AIRGAP_HARDENING.md` has an earlier uncommitted edit that changes the
historical "281 tests" of that review to "284" (a count no tree state had);
consider reverting that line so the record stays accurate.
