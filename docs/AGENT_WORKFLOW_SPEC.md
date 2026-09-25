# Harness Workflow Specification

> **Version:** 2.0 (Phase 3)  
> **Format:** YAML 1.2  
> **File extension:** `.harness.yaml` or `.harness.yml`  
> **Load:** Click the file in the Harness Studio sidebar file tree.  
> **Generate:** Harness Studio > Generate > LangGraph / CrewAI exports this format.

---

## Overview

A `.harness.yaml` file defines a complete AI agent workflow ??every agent, every connection, every permission, and every hook. It is the source of truth. The visual canvas is a view of this file.

Every node on the canvas maps 1-to-1 to an entry in `agents[]`. Node IDs are assigned by index: `agents[0]` ??`agent-0`, `agents[1]` ??`agent-1`, and so on.

---

## Top-Level Structure

```yaml
meta:          # workflow metadata
  name: string
  version: string
  description: string
  projectRoot: string
  createdAt: string
  updatedAt: string

agents:        # ordered array ??index determines node ID
  - <AgentNode>

connections:   # edges between agents
  - <Connection>

executionSettings:
  maxParallel: integer
  timeoutSeconds: integer
  retryOnFailure: boolean
  maxRetries: integer

nodePositions: # x/y coordinates for canvas layout
  agent-0: { x: number, y: number }
  agent-1: { x: number, y: number }
```

All top-level fields are **required**. `agents` and `connections` may be empty arrays.

---

## `meta` Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ??| 1??28 chars |
| `version` | string | ??| Semver: `"1.0.0"` |
| `description` | string | ??| Can be `""` |
| `projectRoot` | string | ??| Can be `""` ??filled at runtime |
| `createdAt` | string | ??| ISO 8601: `"2026-05-16T00:00:00Z"` |
| `updatedAt` | string | ??| ISO 8601, updated on save |

---

## `agents[]` ??Agent Node

Each entry in `agents[]` becomes a node on the canvas.  
**Key fact:** All field names use **camelCase** in YAML.

```yaml
agents:
  - name: My Agent           # required
    role: worker             # required ??see Role enum
    model: claude-sonnet-4.6 # required (empty string "" for hook/memory)
    temperature: 0.7         # required, 0.0-2.0; saved but not yet sent to providers
    maxTokens: 4096          # required, 0 ??200000
    maxSteps: 20             # required, 1 ??1000
    timeoutSeconds: 300      # required, 1 ??86400
    promptSource:            # required
      type: inline           #   "inline" ??content field
      content: |             #   "file"   ??path field
        You are a ??    tools:                   # required array (may be [])
      - read_file
      - web_search
    memoryRead: []           # required array ??memory keys this agent reads
    memoryWrite: []          # required array ??memory keys this agent writes
    tokens:                  # required
      used: 0                #   always 0 in a fresh workflow file
      budget: 32000          #   token budget for this node
    status: idle             # required ??starting state
    # ?? Optional fields ????????????????????????????????
    description: "..."       # human-readable purpose
    condition: "..."         # gateway nodes only - shown as a badge; not sent to the model at runtime
    preHook:                 # hook nodes: runs when the run reaches the node; agent nodes: manual only (Hooks tab)
      path: .harness/hooks/my-hook.sh
      requireConsent: true   # true: never run automatically - the node fails and the run stops
    postHook:                # manual only (Hooks tab); never run during workflow runs
      path: .harness/hooks/post.sh
      requireConsent: false
```

### Role enum

| Value | Glyph | Color | Typical use |
|---|---|---|---|
| `orchestrator` | ??| amber `#e5a142` | Plans, delegates, aggregates |
| `gateway` | ??| blue `#7c9eff` | Routes conditionally |
| `worker` | ??| green `#5fbf7f` | Executes specific tasks |
| `critic` | ??| red `#e07575` | Reviews, validates |
| `memory` | ??| purple `#b88bd9` | Persists shared state |
| `hook` | ??| orange `#d97757` | Pre/post execution gates |
| `aggregator` | ??| teal `#5fbfb5` | Merges parallel outputs |
| `tool_caller` | 燧?| gray `#9aa4b2` | Specialized tool execution |

### Status enum

| Value | Meaning |
|---|---|
| `idle` | Not yet started ??use this in new workflow files |
| `running` | Currently executing (set by runtime) |
| `waiting` | Waiting for an upstream agent |
| `done` | Completed successfully |
| `error` | Failed |

### promptSource

Two modes:

```yaml
# Mode 1: inline text
promptSource:
  type: inline
  content: |
    You are an agent that does X.
    Always output JSON.

# Mode 2: file reference (relative to workspace root)
promptSource:
  type: file
  path: .harness/prompts/my-agent.md
```

File-reference mode is preferred for long prompts ??enables version-controlled prompt history.

### tools ??Permission values

Grant only the tools each agent actually needs.

| Value | Risk | Description |
|---|---|---|
| `read_file` | low | Read a file within the workspace |
| `fs.read` | low | Alias for read_file (serde compatible) |
| `fs.append` | medium | Append to a file (no overwrite) |
| `list_files` | low | List directory contents |
| `web_search` | low | Search the web |
| `grep` | low | Search file contents |
| `classify` | low | Classify text |
| `vector_search` | low | Query a vector store |
| `cite` | low | Format citations |
| `git` | medium | Read git history, diff |
| `web_fetch` | medium | Fetch a URL |
| `todo_write` | medium | Write to a todo list |
| `fs.write` | medium | Write/overwrite a file |
| `test` | medium | Run a test suite |
| `puppeteer` | medium | Browser automation |
| `bash` | high | Run a shell command line in the workspace (the user approves each one) |
| `subagent_dispatch` | high | Spawn sub-agents |

At runtime only `read_file`/`fs.read`, `list_files`, `grep`, `fs.write`, and
`fs.append` execute, all confined to the open workspace, plus `bash`: each
command runs in the workspace folder (cmd.exe on Windows, sh elsewhere) only
after the user approves it, and is not sandboxed. The other values currently
have no executor (a call returns an error).

### tokens

```yaml
tokens:
  used: 0       # tokens consumed so far ??set to 0 in new files
  budget: 32000 # maximum tokens for this node
```

Recommended budgets by role:

| Role | Suggested budget |
|---|---|
| orchestrator | 32 000 |
| worker | 20 000 ??60 000 |
| critic | 24 000 |
| aggregator | 48 000 |
| gateway | 4 000 ??8 000 |
| memory | 8 000 ??16 000 |
| hook | 0 |
| tool_caller | 20 000 |

---

## `connections[]` ??Edges

```yaml
connections:
  - id: c-01                       # required, unique string
    sourceAgentId: agent-0         # required, "agent-" + source index
    targetAgentId: agent-1         # required, "agent-" + target index
    label: "query"                 # optional ??shown on the edge in canvas
    edgeKind: dataflow             # optional ??default: dataflow
```

### edgeKind enum

| Value | Appearance | Semantic meaning |
|---|---|---|
| `dataflow` | solid white | Normal data passing between agents |
| `memory` | dashed purple | Agent writes to a shared memory node |
| `feedback` | solid red | Loop-back edge (rendered below other nodes) |
| `control` | dashed gray | Triggers execution without passing data |

If `edgeKind` is omitted, it defaults to `dataflow`.

---

## `executionSettings`

```yaml
executionSettings:
  maxParallel: 4      # 1-32, active bounded-parallel scheduler limit
  timeoutSeconds: 300 # 1-3600; saved but not yet enforced
  retryOnFailure: false # saved but not yet enforced
  maxRetries: 0       # 0-10; saved but not yet enforced
```

---

Runtime note, verified 2026-06-11: Harness Studio uses `maxParallel` during execution. Independent forward-edge branches can run concurrently up to this limit. Feedback edges are excluded from dependency scheduling, and gateway routes can skip unmatched branches. As of 2026-09-24, `timeoutSeconds`, `retryOnFailure`, and `maxRetries` here are saved but not enforced; each agent's own `timeoutSeconds` is enforced.

---

## `nodePositions`

Keys are `"agent-"` plus the zero-based index of the agent in `agents[]`.

```yaml
nodePositions:
  agent-0: { x: 60,  y: 220 }
  agent-1: { x: 360, y: 220 }
```

If a node has no entry, it falls back to `{ x: index * 240, y: 120 }`.  
Use Harness Studio's **Auto-layout** button (`Ctrl+L`) to reflow positions and save them back.

---

## Minimal valid example

The smallest `.harness.yaml` that loads without errors:

```yaml
meta:
  name: Hello Harness
  version: "1.0.0"
  description: ""
  projectRoot: ""
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"

agents:
  - name: My Agent
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.7
    maxTokens: 4096
    maxSteps: 20
    timeoutSeconds: 300
    promptSource:
      type: inline
      content: "You are a helpful agent."
    tools: []
    memoryRead: []
    memoryWrite: []
    tokens:
      used: 0
      budget: 32000
    status: idle

connections: []

executionSettings:
  maxParallel: 4
  timeoutSeconds: 300
  retryOnFailure: false
  maxRetries: 0

nodePositions:
  agent-0: { x: 100, y: 100 }
```

---

## Example files

Three ready-to-load examples are in the `examples/` directory:

| File | Pattern | Nodes | Edges |
|---|---|---|---|
| `examples/parallel-research.harness.yaml` | Fan-out with gateway routing | 8 | 12 |
| `examples/spec-to-pr.harness.yaml` | Sequential pipeline | 5 | 5 |
| `examples/self-critic.harness.yaml` | Bounded critic loop | 5 | 6 |

**To load:** Open the `examples/` folder in Harness Studio, then click any `.harness.yaml` file.

---

## Loading rules

1. The file is read by the Rust `load_workflow` command.
2. Parsed from YAML via `serde_yaml` (YAML 1.2).
3. Passed as JSON over Tauri IPC to the frontend.
4. Validated by the `workflowDefSchema` Zod schema.
5. Loaded into the Zustand `workflowStore` via `loadWorkflow()`.
6. Node IDs assigned: `agents[i]` ??node id `"agent-i"`.

If validation fails, the canvas is not modified and an error is logged to the audit strip.

---

## Common mistakes

| Mistake | Fix |
|---|---|
| Using `snake_case` keys (e.g. `max_tokens`) | Use `camelCase` (`maxTokens`) |
| Missing `tokens:` or `status:` | Both are required ??add with `used: 0` and `status: idle` |
| Agent ID in connections doesn't match index | `agent-0` = first agent in array, not by name |
| `promptSource` missing `content` or `path` | `inline` requires `content:`, `file` requires `path:` |
| `temperature` > 2.0 | Maximum is `2.0` |
| `maxParallel` = 0 | Minimum is `1` |

