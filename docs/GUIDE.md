# Harness Studio — User Guide

> Version 3 (Phase 3+) · Last updated 2026-05-16

---

## What is Harness Studio?

Harness Studio is a **local-first visual designer** for AI agent workflows. A *harness* is everything around the language model: system prompts, tools, hooks, memory, permission gates, and orchestration logic. The model is a dependency — the harness is the product.

You design agent graphs on a canvas, configure each node, and the tool generates:
- **CLAUDE.md** — instruction file Claude Code reads automatically
- **AGENTS.md** — agent roster for any AI coding tool
- **LangGraph Python** — runnable code for production deployment
- **CrewAI Python** — crew-based multi-agent code
- **Hook scripts** — consent gates, URL allowlists, iteration counters

Everything is a file. Every change is diffable. Nothing lives only in the UI.

---

## Quick Start (5 minutes)

### 1. Open an example

Press **Ctrl+E** (or click **Examples** in the top bar) → click **Load** on "Parallel Research".

You'll see 8 agent nodes appear on the canvas connected by 12 edges.

### 2. Select a node

Click any node. The right panel shows 5 tabs:
- **Role** — name, model, budget, limits
- **Prompt** — system prompt (inline or file reference)
- **Tools** — which tools this node is allowed to use
- **Hooks** — pre/post execution scripts (with consent gate)
- **Memory** — which memory keys this node reads/writes

### 3. Add a node

Click one of the **Add:** buttons in the canvas toolbar. A new node appears at the next grid position. Drag it anywhere.

### 4. Connect nodes

Drag from the **right port** of one node to the **left port** of another. An edge appears. To change edge type (data/memory/control/feedback), right-click the edge (Phase 4+).

### 5. Save the workflow

Press **Ctrl+S**. If no workspace is open, choose one first (click the folder in the sidebar). The file is saved as `{workflow-name}.harness.yaml`.

### 6. Generate code

Press **Ctrl+G** → click **CLAUDE.md** → see a preview → it's written to your workspace.

---

## The Canvas

### Node types

| Glyph | Role | Purpose |
|---|---|---|
| ◆ | **Orchestrator** | Plans and delegates. Usually the entry point. |
| ◇ | **Gateway** | Routes conditionally based on classifier output. |
| ● | **Worker** | Executes a specific task (search, code, write). |
| ◐ | **Critic** | Reviews output and returns PASS / REVISE feedback. |
| ▣ | **Memory** | Persists shared state between agents (JSONL / vector). |
| ✕ | **Hook** | Pre/post gate that runs a script (consent required). |
| ⊕ | **Aggregator** | Merges parallel outputs into a single result. |
| ⬡ | **Tool Caller** | Specialized node for tool-heavy operations. |

### Edge types

| Color | Type | Meaning |
|---|---|---|
| white solid | `dataflow` | Normal output from one agent to the next |
| purple dashed | `memory` | Agent writes to a memory node |
| gray dashed | `control` | Triggers a node without passing data (e.g. hook) |
| red solid | `feedback` | Loop-back edge — rendered below the other nodes |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+S` | Save workflow |
| `Ctrl+K` | Open command palette |
| `Ctrl+E` | Open example picker |
| `Ctrl+G` | Open generate panel |
| `Ctrl+L` | Auto-layout (Dagre) |
| `Delete` | Delete selected nodes/edges |
| `Ctrl+Z / Ctrl+Y` | Undo / redo |

---

## The Config Inspector (right panel)

### Role tab

- **Name** — displayed on the canvas node card
- **Role** — determines glyph, color, and behavior
- **Provider + Model** — select provider first, then model. Use "Load from API" to fetch live model lists (Ollama, OpenRouter).
- **Temperature** — 0 = precise/deterministic, 2 = highly creative
- **Token budget** — how many tokens this node is allowed to consume
- **Max steps** — maximum tool calls before the node stops
- **Timeout** — hard wall-clock limit in seconds

### Prompt tab

Two modes:

**Inline** — write the system prompt directly. Character and token count shown.

**File reference** — point to a `.md` file in your workspace (e.g. `.harness/prompts/planner.md`). This enables:
- Separate version control for prompts
- Shared prompts across multiple workflows
- Monaco editor with full markdown formatting

### Tools tab

Checkboxes for all 17 tool permissions. Each shows a **risk level** (low / medium / high).

> **Security principle:** grant only the tools the agent actually needs.
> An agent with `bash` and no pre-hook is a security risk. Add a `destructive_guard.sh` hook.

### Hooks tab

Pre and post execution scripts. Each hook:
- Must be a path within your workspace root (enforced by Rust path validation)
- Runs with a **30-second timeout**
- Is logged to `.harness/audit.log.jsonl`
- Can require **user consent** (shown as a confirmation dialog before execution)

Use **Ctrl+G → Hook Templates** to generate starter scripts.

### Memory tab

- **Context window breakdown** — how many tokens are used vs. budget
- **Memory keys (reads)** — which shared keys this agent reads
- **Memory keys (writes)** — which shared keys this agent writes
- **Long-term memory strategy** — append-only JSONL, vector store, or rolling summary

---

## The Sidebar

### File tree

Shows all files in your workspace. Click a `.harness.yaml` file to load it into the canvas. Click a `.md` or `.yaml` file to open it in the Monaco editor.

Highlighted in amber = workflow files (`.harness.yaml`) — click to load.

### Node list

Below the file tree: all agents in the current workflow. Click to select a node and open its config panel.

---

## The Audit Strip (bottom)

Collapsible log of all events — file writes, hook executions, tool calls, consent events.

Filter by: `all` | `tool` | `consent` | `warn` | `error`

The audit log is also written to `.harness/audit.log.jsonl` on disk (append-only, gitignored).

---

## Generate Panel (Ctrl+G)

### Config & Code tab

| Generator | Output | Use for |
|---|---|---|
| **CLAUDE.md** | Markdown | Claude Code project instructions |
| **AGENTS.md** | Markdown | Agent roster for any AI coding tool |
| **LangGraph Python** | `.py` | Production-grade `StateGraph` |
| **CrewAI Python** | `.py` | Role-based `Crew` with `Agent` + `Task` |

### Hook Templates tab

5 pre-built security scripts:
- `pre_run_consent.sh` — pauses and asks before running
- `url_allowlist.py` — blocks requests to non-approved domains
- `path_scope.py` — restricts file access to workspace root
- `destructive_guard.sh` — blocks `rm -rf`, `DROP TABLE`, etc.
- `iter_counter.py` — prevents runaway loops (max 3 iterations)

All generated files are written to your workspace and logged to the audit strip.

---

## Workflow Files (`.harness.yaml`)

Everything is stored in a human-readable YAML file. The full format reference is in [`docs/AGENT_WORKFLOW_SPEC.md`](AGENT_WORKFLOW_SPEC.md).

Key rules:
- All keys use **camelCase** (`maxTokens`, not `max_tokens`)
- Node IDs in connections are `agent-0`, `agent-1`, … (0-based index in `agents[]`)
- `status` should be `idle` for new/saved workflows
- `tokens.used` should be `0` in saved files

### Working with git

```bash
# Recommended .gitignore additions (already in the project template):
.harness/audit.log.jsonl
.harness/trajectories/
.env.local
```

Commit: `*.harness.yaml`, `CLAUDE.md`, `AGENTS.md`, `.harness/hooks/`, `.harness/prompts/`

---

## Common Patterns

### Pattern 1: Sequential pipeline

```
Planner → Worker → Critic → Reporter
                ↑         |
                └─feedback┘
```

Use case: any task that has clear sequential stages with a quality gate.

Example: `examples/spec-to-pr.harness.yaml`

### Pattern 2: Parallel fan-out

```
Orchestrator → Gateway → Worker A ─┐
                        → Worker B ─┤ → Aggregator → Critic
                        → Worker C ─┘
                        → Memory (shared scratchpad)
```

Use case: research, multi-source queries, parallel analysis.

Example: `examples/parallel-research.harness.yaml`

### Pattern 3: Reflection loop

```
Drafter ─────────────→ Critic ─→ Loop Gate ─→ [ship]
  ↑                                  │
  └──────── feedback (revise) ←──────┘
                                     │
                                     → iter_counter (hook, blocks at N=3)
```

Use case: writing, code generation, any iterative refinement.

Example: `examples/self-critic.harness.yaml`

### Pattern 4: Recursive self-improvement

```
Architect → Code Searcher → Implementer → Tester → Documenter
                                ↑             │
                                └─ feedback ──┘
```

Use case: using the tool to build/improve itself.

Example: `examples/harness-studio-dev.harness.yaml`

---

## Providers & Models

The model selector supports:

| Provider | Type | Models loaded |
|---|---|---|
| **Anthropic** | Default list | Claude Opus/Sonnet/Haiku |
| **OpenAI** | Default list | GPT-4o, o3, o1 |
| **Ollama** | Live API | Models you have pulled locally |
| **OpenRouter** | Live API | 200+ community models |
| **Kilo** | Default list | Kilo proxy models |
| **Custom** | Manual entry | Any model ID string |

For **Ollama**: must be running locally (`ollama serve`). Harness Studio fetches `http://localhost:11434/api/tags`.

For **OpenRouter**: no API key needed to browse models. Key needed to run.

Provider runtime can be forced in Settings or with environment values:

```powershell
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
```

Suggested local fallback models: `qwen2.5-coder:7b`, `qwen2.5-coder:14b`, `llama3.1:8b`, `deepseek-coder`, `codellama`.

---

## Security Checklist

Before running any workflow, verify:

- [ ] All hook scripts are yours or from a trusted source
- [ ] API keys are in `.env.local` (never in `.harness.yaml`)
- [ ] `bash` tool is only granted to nodes that truly need it
- [ ] `destructive_guard.sh` is attached to any node with `bash`
- [ ] Consent required is **on** for any hook that touches production systems
- [ ] `path_scope.py` is attached to any node that reads/writes files outside `.harness/`
- [ ] Check the audit strip after every run

---

## Troubleshooting

**Canvas is empty after loading a file**
→ The YAML failed Zod validation. Check the audit strip for error details.
→ Common cause: missing `maxSteps`, `timeoutSeconds`, or `tokens` fields (added in v2).

**Node positions look wrong**
→ Click **Auto-layout** (Ctrl+L) to reflow.

**"No workspace open" error when saving**
→ Click the folder icon in the sidebar to open a workspace directory first.

**Hook timed out**
→ Default timeout is 30 seconds. Check the script for blocking operations.

**Ollama models not loading**
→ Make sure `ollama serve` is running. Try `curl http://localhost:11434/api/tags` in a terminal.

**Ollama selected but server unavailable**
→ Start Ollama and retry. Expected message: `Ollama is selected, but the local Ollama server is not reachable at http://localhost:11434. Please start Ollama and try again.`

**Ollama model missing**
→ Install the selected model, for example: `ollama pull qwen2.5-coder:7b`.

**OpenAI quota or billing limit**
→ Expected message: `OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.`
→ Check OpenAI Platform Billing, Usage, Limits, project, and organization settings. Billing-related failures are not retried.

**OpenAI rate limit**
→ Expected message: `OpenAI API rate limit reached. The application will retry with exponential backoff.`
→ Temporary rate-limit failures are retried with exponential backoff.

**Anthropic insufficient credits**
→ Expected message: `Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.`
→ Recharge credits in the Anthropic Console. Billing-related failures are not retried.

**OpenRouter not loading**
→ Check your network connection. The API is public and requires no key for model listing.

---

## Architecture (for contributors)

```
src/
  components/
    canvas/          ← React Flow canvas, node types, edge types
    config-panel/    ← 5-tab inspector
    generate/        ← Generate panel modal
    palette/         ← ⌘K command palette, example picker, guide viewer
    layout/          ← TopBar, Sidebar, StatusBar, AuditStrip
    nodes/           ← BaseAgentNode, NodeIcon, 8 role wrappers
  hooks/
    useWorkflow.ts   ← save/load via Tauri IPC
    useGenerator.ts  ← write generated files to workspace
    useExamples.ts   ← inline YAML + validation + canvas load
    useModelRegistry.ts ← provider + model list management
  store/
    workflowStore.ts ← canvas state + undo/redo (Zustand + zundo)
    modelStore.ts    ← loaded models per provider
  utils/
    generators/      ← CLAUDE.md, AGENTS.md, LangGraph, CrewAI, hooks
    autoLayout.ts    ← Dagre LR layout
    validateWorkflow.ts ← cycle detection, security checks
src-tauri/
  src/commands/      ← Rust: fs, workflow, audit, hooks
```

Full architecture: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
Format spec: [`docs/AGENT_WORKFLOW_SPEC.md`](AGENT_WORKFLOW_SPEC.md)
