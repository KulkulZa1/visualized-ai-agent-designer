# Harness Studio User Manual

Updated: 2026-09-30

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
  - Opening another workflow clears the agents' results but keeps **Changes (N)**. Revert needs the folder the run worked in to be open: with another folder open it says "These changes were made in `<folder>`. Open that folder to revert them." and changes nothing. The diff stays viewable.
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
- The CLI's `project`, `workflow` and `provider` commands are read-only. `harness run` runs a workflow without the app (see [HEADLESS.md](HEADLESS.md)).
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
| Ollama local | Local | No | Requires Ollama installed and model pulled. The app asks it for a 16384-token context window (see Settings for Local Models) |
| Ollama Cloud | Cloud | Yes | `https://ollama.com/api`, `gemma4:31b-cloud`, `OLLAMA_API_KEY` |
| Remote Ollama | Cloud/hosted | Maybe | Requires base URL and possibly `OLLAMA_REMOTE_API_KEY` |
| OpenAI | Cloud | Yes | Capabilities depend on selected model/account |
| Anthropic | Cloud | Yes | Claude models |
| OpenAI-compatible | Gateway | Maybe | Settings calls it Custom Endpoint. The app asks the server for native tool calls and streamed replies, and falls back to the text tool protocol, or to a reply that is not streamed, when the server refuses, so what works depends on the server. The model name has no default |
| Gemini | Planned | Yes | Catalog only; direct adapter not implemented |

## Settings for Local Models

A model on the same machine or network (Ollama, or an OpenAI-compatible server) is
set up in **Settings** (gear icon). Save with **Save all & close**.

| Field | Section | What it does |
|---|---|---|
| **Ollama context window (tokens)** | Ollama — Local or Cloud | The window the app asks Ollama for (`num_ctx`). Default 16384. It overrides the server's default (`OLLAMA_CONTEXT_LENGTH`) and a model's own `num_ctx` (Modelfile); `0` sends none, so those stand. Not sent to ollama.com. |
| **Model name** | Custom Endpoint (OpenAI-compatible) | The model your server serves. There is no default. Blank sends each agent's own model. |
| **Model call timeout (seconds)** | Execution Behavior | How long one model call may take in total: 30 to 86400, default 600. |

- **Context window.** Ollama may cut off a prompt that does not fit its window,
  without saying so. The app's value overrides the server's own
  `OLLAMA_CONTEXT_LENGTH` and a model's own `num_ctx` (its Modelfile): if either sets
  one, use `0` or the same value. Otherwise a model built with a larger window, say
  32768, is lowered to the app's window (16384 by default). A larger window needs more
  memory on the Ollama server: lower it if the model no longer fits. Ollama reloads a
  model when a request asks for a different window, so other tools on the same server
  with another window cause reloads. A number that is not valid turns red and
  **Save all & close** stays off.
- **Context window warning.** When a node's estimated prompt (about 4 characters per
  token) plus its `maxTokens`, counted as at most half the window, is more than the
  window, the audit strip shows a warning (the `warn` chip), once per node. It reads
  "⚠ `<name>`: its prompt is about N tokens and it may reply with up to M tokens, but
  Ollama's context window is W tokens, so Ollama may cut off the start of the prompt.
  Raise the context window …". A generous `maxTokens` alone does not warn: at the
  default window, 16384 counts as 8192. The run goes on. The estimate is a minimum: it
  leaves out the tool definitions and the steps after the first.
- **Test connection** (Custom Endpoint) with a blank Model name sends nothing and
  says: "No model name is set, so there is nothing to test. Enter the model name your
  server serves, or click ↻ Models to list the models it has." **↻ Models** lists
  what the server has, under **Available models**: click a name to copy it, and paste
  it into **Model name**. A `gpt-4o-mini` that Settings saved earlier, when it was the
  default, stays until you clear the field.
- **Run dialog.** **Provider Override** has a **Custom** chip beside OpenAI,
  Anthropic, Ollama and Ollama Cloud. It runs that one run on the Custom endpoint
  from Settings. **Use Settings** keeps the provider set in Settings.
- **Slow hardware.** Raise the model call timeout and the agent's **Timeout (s)**
  (Role tab, Limits; 300 for a new agent). The agent's Timeout bounds its whole run,
  all its model calls and tools, so with the defaults it ends a slow call before the
  call's own 600 s does. A call that runs out of its timeout says "The model did not
  answer within the request timeout. On slow hardware, raise the model call timeout
  (Settings in the app, --request-timeout in harness run)."
- **`harness run`** has the same settings as flags and variables
  (`--num-ctx`, `--request-timeout`, `HARNESS_CUSTOM_BASE_URL` and others:
  [HEADLESS.md](HEADLESS.md)). The app does not read those variables.

See [AIRGAPPED.md](AIRGAPPED.md) for the full guide.

## CLI

```powershell
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
```

These three commands do not mutate files, call providers, execute workflows, run
hooks, or print secrets. `harness run` does execute workflows: it makes provider
calls and runs only the agent commands you pass with `--allow-command`
([HEADLESS.md](HEADLESS.md)).

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


