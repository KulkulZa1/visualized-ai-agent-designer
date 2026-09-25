# Harness Studio User Manual

Updated: 2026-09-25

## What Harness Studio Is

Harness Studio is a local-first Tauri desktop app for visual multi-agent AI
workflows. Users create agent graphs, configure prompts/tools/hooks/models, and
run the workflow against configured providers.

## Current Truth

- Execution uses dependency-aware bounded parallel scheduling for independent forward-edge branches.
- Agents have separate node IDs, prompts, models, outputs, status, logs, and snapshots, but are not separate OS processes.
- Feedback edges do not create scheduling dependencies, and gateway routing can skip unmatched branches.
- A node with a feedback edge acts as a reviewer: when it answers REVISE (or names the edge's label, e.g. `rust-fix`), the agents from the edge's target back to the reviewer re-run with its review (for a gateway that only answers a route, also the critique it read) and their previous output, and the reviewer checks again — at most 2 rounds, then the run continues with the latest version.
- An agent whose model calls tools natively shows its reply live as it arrives. The text-protocol fallback and helper agents still show each reply after it arrives.
- Context inspector is useful but not a complete durable trace yet.
- Artifact viewer still uses mock placeholders during execution.
- Agents can use workspace file tools (read, list, grep, `fs.write`, `fs.append`, and `edit_file`, which comes with `fs.write` and replaces an exact snippet). An agent only runs the tools you gave it.
- **Changes (N)** in the run panel lists every file the run's agents changed with those tools:
  - The dialog shows a side-by-side diff and reverts one file or all of them.
  - A file the run created is deleted.
  - A file that changed again after the agent's last edit is only overwritten after you confirm.
  - Changes made by shell commands are not listed.
- A node's **Token budget** (Role tab) now applies. Once an agent's conversation passes 75% of it, older steps are summarized into a progress note by one extra model call. The newest step stays as it is. Raise the budget for agents that read large files; 0 turns this off.
- If the workspace has an `AGENTS.md` at its root, agents with workspace tools (and their helpers) get it as project instructions (at most 32 KB).
- An agent with the `bash` tool can run shell commands, for example the tests:
  - A dialog shows each command, the agent that wants it and the folder. The command runs only if you click **Allow once** or **Allow for this run**; **Deny** or Esc refuses it and tells the agent.
  - **Allow for this run** lets that exact command run again without asking until the run ends, even if the agent changes what it runs (for example `package.json` scripts). A different command still asks.
  - It runs in the workspace folder (cmd.exe on Windows, sh elsewhere) with your permissions. There is no sandbox, so allow only commands you understand.
  - It gets no input and no provider API keys, and it stops at the agent's time limit. Time spent waiting for your answer does not count toward that limit.
  - Stop refuses commands still waiting for approval and kills a command that is running.
  - Helpers started with `subagent_dispatch` cannot run commands.
  - Every approval, denial and result is in the audit log.
- An agent with the `subagent_dispatch` tool can start helper agents while it runs: each gets a fresh context, a subset of the agent's tools and the same model, and reports back. Helpers cannot start helpers; at most 5 per node run, 3 at a time. The node's activity panel lists each helper with its status, task, tools, time and report (or error); a helper still working when you press Stop shows as stopped, and so does the node itself; starts and tool calls are also in the audit log.
- During runs only Hook-role nodes run their pre-hook. Hooks on agent nodes run only when you click **Run hook** in the Hooks tab, and a hook marked "require consent" is not run automatically (the node fails and the run stops).
- Temperature, per-node fallback model, gateway condition text, prompt `{{variables}}`, and workflow-level timeout/retry settings are saved but not applied at runtime yet.
- CLI is read-only.
- MCP is read/test-only.

## Main UI Areas

| Area | Purpose |
|---|---|
| TopBar | Workflow name, counts, help, examples, wizard, settings, save, run |
| Sidebar | Workspace files, workflow node list, artifacts summary |
| Canvas | Visual workflow graph |
| Config Panel | Role, Prompt, Tools, Hooks, Memory, Context tabs for selected node |
| AuditStrip | Event log with kind and agent filters |
| StatusBar | Save state, workflow summary, active run state |
| Guide Assistant | Rule-based help panel |

## Starting From Zero

1. Launch with `npm run tauri -- dev`.
2. Open `Create from Goal`.
3. Type a goal, such as `I want to automate blog writing.`
4. Review the recommended workflow and privacy/setup notes.
5. Load the workflow.
6. Configure provider settings.
7. Click Run and provide the initial prompt.

## Provider Choices

| Provider | Local/cloud | Key required | Notes |
|---|---|---|---|
| Ollama local | Local | No | Requires Ollama installed and model pulled |
| Ollama Cloud | Cloud | Yes | `https://ollama.com/api`, `gemma4:31b-cloud`, `OLLAMA_API_KEY` |
| Remote Ollama | Cloud/hosted | Maybe | Requires base URL and possibly `OLLAMA_REMOTE_API_KEY` |
| OpenAI | Cloud | Yes | Capabilities depend on selected model/account |
| Anthropic | Cloud | Yes | Claude models |
| OpenAI-compatible | Gateway | Maybe | Capabilities vary; do not assume streaming/tools |
| Gemini | Planned | Yes | Catalog only; direct adapter not implemented |

## CLI

```powershell
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
```

CLI v0 does not mutate files, call providers, execute workflows, run hooks, or
print secrets.

## MCP

```powershell
npm run mcp
```

Available tools (8): `project_status`, `list_workflows`, `validate_workflow`,
`run_tests`, `run_cargo_tests`, `list_providers` (metadata and credential
references only), `list_artifacts` (file metadata only; empty until runs persist
artifacts), and `get_recent_logs` (audit-log entries with best-effort, not
guaranteed, secret redaction). No write tools and no workflow execution.

## Verification Commands

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
npm run tauri -- build
```

Latest verified baseline (2026-09-25): TypeScript passed, Vitest 593 tests /
57 files passed, 86 Rust tests passed, and the frontend build passed. Tauri dev
launch and the MSI/NSIS package build were verified in an earlier pass and not
re-run.


