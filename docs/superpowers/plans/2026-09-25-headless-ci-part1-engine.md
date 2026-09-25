# Headless + CI, Part 1: Shared Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the workflow run out of the React hook into a plain TypeScript engine (`runWorkflow(input, host)`) that the app uses now and `harness run` will use in Part 3, and move the saved-workflow → graph conversion into a shared `defToGraph`.

**Architecture:** `src/engine/runWorkflow.ts` is the body of today's `useWorkflowExecution.runWorkflow`, moved. Store reads become fields of `input`. Store writes, the approval dialog, Stop and context snapshots become calls on `host`. The engine keeps its own copy of the run record (`WorkflowRun`) and returns it. The hook becomes an adapter: it builds `input` from the stores, and its `host` writes events into the stores. `defToGraph` moves out of `workflowStore.loadWorkflow` into `src/engine/workflowGraph.ts`.

**Tech Stack:** TypeScript, Zustand, Vitest (jsdom, `@tauri-apps/api/core` aliased to `src/ipc/mockTauri.ts`).

**Spec:** `docs/superpowers/specs/2026-09-25-headless-ci-design.md` §1.

**Deferred on purpose:**
- **Part 4:** the spec's `host.saveRun` port and the "saved run to resume from" input. Part 4 defines the record they carry.
- **Part 3:** any typed CLI events (command, revision, compaction). Adding them there is additive.

---

## Design decisions (read before starting)

1. **The engine owns the run id.** It creates `run-${Date.now()}`, as the store did, and announces it with `onRunStarted(runId, workflowName)`. `executionStore.startRun` gets an optional `id` parameter, so the app's run and the engine's run are the same id. Resume (Part 4) needs this.
2. **The engine keeps its own run record.** `updateAgent` updates a local `WorkflowRun` and emits `onAgentUpdate`. The file change log is updated the same way. The final status (`anyFailed`) comes from that record, not from the store. `RunOutcome` is `{ started: false, error }` when preflight fails, and `{ started: true, run }` otherwise.
3. **The app's guards move into the adapter.** Two places checked "is this still the current run?": helper updates and change-log writes. The engine no longer knows about newer runs, so the adapter checks for every agent update, file change and `finishRun`.
   - This covers more than before: an old run's late update can no longer write into a newer run. No test depends on the old leak.
4. **Snapshots become an optional port.** Building the context snapshot and the "live artifact" is app-only (Inspector), so that code moves into the adapter. The engine calls `host.snapshot?.({ runId, nodeId, status, output, error })`.
5. **The app's `host.invoke` is the unified IPC `invoke`** from `src/ipc/tauriCommands.ts`, which is Tauri, or the VS Code bridge inside a webview. It gets exported for this.
   - Today the hook mixes Tauri's `invoke` with the `readWorkspaceFile` and `writeAuditEntry` wrappers, and those wrappers use the unified one. One invoke for everything keeps the wrappers' routing.
   - In the Tauri app, and in tests, the unified invoke *is* Tauri's invoke.
6. **The move stays small.** At the top of `runWorkflow`, the engine defines local stand-ins with the old names: `invoke`, `addEntry`, `readWorkspaceFile`, `writeAuditEntry`, `isRunCancelled`, `updateAgent` and `updateNodeData`. The moved body then keeps its text, except for the edits listed in Task 2.
   - `readWorkspaceFile` and `writeAuditEntry` stay `async`, like the IPC wrappers they replace. The mock `invoke` throws synchronously when a handler throws, and `async` turns that into a rejection.
7. **`host.askCommand` takes `Omit<CommandRequest, "id">`,** so the adapter passes it straight to `commandConsentStore.request`. The engine imports only *types* from the store; the boundary test in Task 2 allows type-only imports.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/engine/workflowGraph.ts` | create | `WorkflowGraph` type, `defToGraph(def)` |
| `src/store/workflowStore.ts` | modify `loadWorkflow` (lines 199–222) | use `defToGraph` |
| `src/engine/runWorkflow.ts` | create (moved code) | `runWorkflow(input, host)`, `RunInput`, `RunHost`, `RunEvents`, `RunOutcome`, `ProviderSettings`, `NodeSnapshot` |
| `src/store/executionStore.ts` | modify `startRun` | accept the engine's run id |
| `src/ipc/tauriCommands.ts` | modify line 8 | export the unified `invoke` |
| `src/hooks/useWorkflowExecution.ts` | rewrite | adapter: stores → `input`, `host` → stores |
| `tests/unit/engine/workflowGraph.test.ts` | create | mapping and example round trips |
| `tests/unit/engine/runWorkflow.test.ts` | create | engine with a fake host, import boundary |
| `tests/unit/store/executionStore.test.ts` | add a test | `startRun` with an id |
| `AGENT.md`, `docs/ARCHITECTURE.md` | one line each | point at the engine |

`tests/unit/hooks/useWorkflowExecution.test.ts` is **not modified**. It passing unchanged is the proof that app behavior did not change.

---

### Task 0: Baseline

- [ ] **Step 1: Confirm the branch and a green suite**

Run: `git status --short && git branch --show-current && npx vitest run 2>&1 | tail -5`
Expected:
- A clean tree on `claude/headless-ci`.
- `Test Files  57 passed (57)` and `Tests  593 passed (593)`.

---

### Task 1: `defToGraph`

**Files:**
- Create: `src/engine/workflowGraph.ts`
- Modify: `src/store/workflowStore.ts` (`loadWorkflow`)
- Test: `tests/unit/engine/workflowGraph.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/engine/workflowGraph.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defToGraph } from "@/engine/workflowGraph";
import { useWorkflowStore } from "@/store/workflowStore";
import { deserializeWorkflow } from "@/utils/yamlSerializer";
import { EXAMPLES } from "@/hooks/useExamples";
import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";

function agent(name: string): AgentNodeData {
  return {
    name, role: AgentRole.Worker, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024,
    maxSteps: 5, timeoutSeconds: 300, promptSource: { type: "inline", content: "Do it." }, tools: [],
    memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 16000 }, status: "idle",
  };
}

describe("defToGraph", () => {
  it("names agents by list position, as connections do, and keeps each connection's label and kind", () => {
    const def: WorkflowDef = {
      meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      agents: [agent("Writer"), agent("Reviewer")],
      connections: [
        { id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1", label: "draft" },
        { id: "c2", sourceAgentId: "agent-1", targetAgentId: "agent-0", label: "revise", edgeKind: "feedback" },
      ],
      executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
      nodePositions: { "agent-0": { x: 5, y: 6 } },
    };

    const graph = defToGraph(def);

    expect(graph.nodes.map((n) => [n.id, n.type, n.position, n.data.name])).toEqual([
      ["agent-0", "agent", { x: 5, y: 6 }, "Writer"],
      ["agent-1", "agent", { x: 240, y: 120 }, "Reviewer"], // no saved position: laid out in a row
    ]);
    expect(graph.edges).toEqual([
      { id: "c1", source: "agent-0", target: "agent-1", label: "draft", type: "dataflow",
        data: { label: "draft", edgeKind: "dataflow" } },
      { id: "c2", source: "agent-1", target: "agent-0", label: "revise", type: "feedback",
        data: { label: "revise", edgeKind: "feedback" } },
    ]);
    expect(graph.meta).toBe(def.meta);
    expect(graph.executionSettings).toBe(def.executionSettings);
  });

  it.each(EXAMPLES.map((ex) => [ex.name, ex.yaml] as const))(
    "round-trips the %s example through the store's toWorkflowDef",
    (_name, yaml) => {
      const def = deserializeWorkflow(yaml);
      const graph = defToGraph(def);
      useWorkflowStore.setState(graph);

      const saved = useWorkflowStore.getState().toWorkflowDef();

      expect(saved.agents).toEqual(def.agents);
      expect(defToGraph(saved)).toEqual(graph);
    },
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/engine/workflowGraph.test.ts`
Expected: FAIL, because `@/engine/workflowGraph` cannot be resolved.

- [ ] **Step 3: Write `src/engine/workflowGraph.ts`**

```ts
import type { Edge } from "@xyflow/react";
import type { AgentNode, ExecutionSettings, WorkflowDef, WorkflowMeta } from "@/types/workflow";

/** What a run executes: the workflow's agents as canvas nodes, its edges and settings. */
export interface WorkflowGraph {
  nodes: AgentNode[];
  edges: Edge[];
  meta: WorkflowMeta;
  executionSettings: ExecutionSettings;
}

/** A saved workflow as a graph. Agents are named by list position ("agent-<i>"),
 *  which is how the saved connections refer to them. */
export function defToGraph(def: WorkflowDef): WorkflowGraph {
  return {
    meta: def.meta,
    executionSettings: def.executionSettings,
    edges: def.connections.map((c) => ({
      id: c.id,
      source: c.sourceAgentId,
      target: c.targetAgentId,
      label: c.label,
      type: c.edgeKind ?? "dataflow",
      data: {
        label: c.label,
        edgeKind: c.edgeKind ?? "dataflow",
      },
    })),
    nodes: def.agents.map((agent, i) => {
      const pos = def.nodePositions[`agent-${i}`] ?? { x: i * 240, y: 120 };
      return { id: `agent-${i}`, type: "agent", position: pos, data: agent } satisfies AgentNode;
    }),
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run tests/unit/engine/workflowGraph.test.ts`
Expected: PASS, with 1 + 7 example tests.

If an example fails the round trip, the diff names the field. Fix `defToGraph` only if it disagrees with `loadWorkflow`, whose code it copies. A difference that `loadWorkflow` has too is a finding: report it rather than changing the test.

- [ ] **Step 5: Use it in the store**

In `src/store/workflowStore.ts`, add `import { defToGraph } from "@/engine/workflowGraph";` after the `@/types/agent` import. Then replace the body of `loadWorkflow`:

```ts
      loadWorkflow: (def) => {
        const graph = defToGraph(def);
        set((state) => {
          state.meta = graph.meta;
          state.executionSettings = graph.executionSettings;
          state.edges = graph.edges;
          state.nodes = graph.nodes;
          state.isDirty = false;
          state.filePath = null;
        });
        // A loaded workflow starts a fresh history: undoing past the load would put the
        // previous graph under this workflow's name and file path.
        useWorkflowStore.temporal.getState().clear();
      },
```

- [ ] **Step 6: Run the store and engine tests**

Run: `npx vitest run tests/unit/store tests/unit/engine`
Expected: PASS. That includes the existing `loadWorkflow` tests in `workflowStore.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/engine/workflowGraph.ts src/store/workflowStore.ts tests/unit/engine/workflowGraph.test.ts
git commit -m "Move the saved-workflow to graph conversion into defToGraph (src/engine)"
```

(End every commit message with the `Co-Authored-By` trailer.)

---

### Task 2: The engine, `runWorkflow(input, host)`

**Files:**
- Create: `src/engine/runWorkflow.ts`, assembled from `src/hooks/useWorkflowExecution.ts`
- Test: `tests/unit/engine/runWorkflow.test.ts`

The hook is not touched in this task. Its copy of the code goes away in Task 3.

- [ ] **Step 1: Write the failing tests**

`tests/unit/engine/runWorkflow.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";
import { runWorkflow, type RunHost, type RunInput } from "@/engine/runWorkflow";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import type { AgentRun } from "@/types/execution";
import type { AuditEntry } from "@/types/audit";

function makeNode(id: string, tools: ToolPermission[] = []): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id, role: AgentRole.Worker, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024,
      maxSteps: 3, timeoutSeconds: 300, promptSource: { type: "inline", content: "" }, tools,
      memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 16000 }, status: "idle",
    },
  };
}

function runInput(nodes: AgentNode[], edges: Edge[] = [], overrides: Partial<RunInput> = {}): RunInput {
  return {
    graph: {
      nodes, edges,
      meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      executionSettings: { maxParallel: 4, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    },
    config: { userInput: "Ship it", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
    provider: {
      llmProvider: "ollama", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "http://localhost:11434", ollamaModel: "qwen2.5-coder:7b",
      customApiUrl: "", customApiKey: "", customApiModel: "",
    },
    workspacePath: "/ws",
    continueOnError: true,
    ...overrides,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

/** A host that records what the engine tells it. Rust commands are answered by
 *  `handlers`, falling back to a healthy local Ollama that answers "ok". */
function fakeHost(handlers: Record<string, Handler> = {}, overrides: Partial<RunHost> = {}) {
  const defaults: Record<string, Handler> = {
    get_provider_defaults: () => ({
      llm_provider: "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
      openai_api_key_configured: false, anthropic_api_key_configured: false,
      ollama_api_key_configured: false, suggested_ollama_models: [],
    }),
    check_provider_health: (args) => ({
      ok: true, provider: args.provider, latency_ms: 1, message: "ok", model_available: true, pull_command: null,
    }),
    // Nodes with tools use the text tool protocol unless a test answers chat_turn itself.
    chat_turn: () => ({ text: "", toolCalls: [], finishReason: "tools_unsupported", nativeToolsSupported: false }),
    read_workspace_file: () => { throw new Error("IO error: not found (os error 2)"); },
    write_audit_entry: () => undefined,
    call_ollama_api: () => "ok",
  };
  const commands: string[] = [];
  const log = {
    started: [] as string[],
    agents: [] as Array<[string, Partial<AgentRun>]>,
    nodeStatus: [] as Array<[string, string]>,
    audit: [] as AuditEntry[],
    files: [] as Array<{ path: string; before: string | null; after: string; agent: string }>,
    finished: [] as string[],
  };
  const host: RunHost = {
    invoke: async <T>(cmd: string, args: Record<string, unknown> = {}) => {
      commands.push(cmd);
      const handler = handlers[cmd] ?? defaults[cmd];
      if (!handler) throw new Error(`Unknown command: ${cmd}`);
      return (await handler(args)) as T;
    },
    events: {
      onRunStarted: (runId) => log.started.push(runId),
      onAgentUpdate: (nodeId, partial) => log.agents.push([nodeId, partial]),
      onNodeStatus: (nodeId, status) => log.nodeStatus.push([nodeId, status]),
      onAudit: (entry) => log.audit.push(entry),
      onFileChange: (path, before, after, agent) => log.files.push({ path, before, after, agent }),
      onRunFinished: (status) => log.finished.push(status),
    },
    askCommand: async () => "deny",
    isCancelled: () => false,
    ...overrides,
  };
  return { host, commands, log };
}

const who = (args: Record<string, unknown>) => /^You are (\w+),/.exec(String(args.system))![1];

describe("runWorkflow", () => {
  it("runs the graph through the host, passing outputs downstream, and returns the finished run", async () => {
    const userMessages: Record<string, string> = {};
    const { host, log } = fakeHost({
      call_ollama_api: (args) => {
        userMessages[who(args)] = String(args.userMessage);
        return `out-${who(args)}`;
      },
    });

    const outcome = await runWorkflow(
      runInput([makeNode("A"), makeNode("B")], [{ id: "a-b", source: "A", target: "B" }]), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(outcome.run).toMatchObject({ status: "done", workflowName: "W" });
    expect(outcome.run.agents.A).toMatchObject({ status: "done", output: "out-A", providerUsed: "ollama" });
    expect(outcome.run.agents.B).toMatchObject({ status: "done", output: "out-B" });
    expect(userMessages.A).toContain("USER TASK:\nShip it");
    expect(userMessages.B).toContain("[From: A]\nout-A");
    expect(log.started).toEqual([outcome.run.id]);
    expect(log.nodeStatus.slice(0, 2)).toEqual([["A", "idle"], ["B", "idle"]]);
    expect(log.finished).toEqual(["done"]);
  });

  it("does not start the run when the provider preflight fails", async () => {
    const { host, commands, log } = fakeHost({
      check_provider_health: (args) => ({
        ok: false, provider: args.provider, latency_ms: 0, message: "Ollama is not running",
        model_available: false, pull_command: null,
      }),
    });

    const outcome = await runWorkflow(runInput([makeNode("A")]), host);

    expect(outcome).toEqual({ started: false, error: "Ollama is not running" });
    expect(log.started).toEqual([]);
    expect(commands).not.toContain("call_ollama_api");
  });

  /** Node A asks to run `npm test` with bash, then answers. */
  function commandRun(): { nodes: AgentNode[]; handlers: Record<string, Handler> } {
    let calls = 0;
    return {
      nodes: [makeNode("A", [ToolPermission.Bash])],
      handlers: {
        call_ollama_api: () => (++calls === 1
          ? '<tool_call>{"name":"bash","args":{"command":"npm test"}}</tool_call>'
          : "checked"),
        execute_command: () => ({ exitCode: 0, stdout: "5 passed", stderr: "", durationMs: 900 }),
      },
    };
  }

  it("asks the host to approve a shell command and runs it when approved", async () => {
    const { nodes, handlers } = commandRun();
    const askCommand = vi.fn(async (_request: unknown) => "granted" as const);
    const { host, commands } = fakeHost(handlers, { askCommand });

    const outcome = await runWorkflow(runInput(nodes), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(askCommand).toHaveBeenCalledWith(
      { runId: outcome.run.id, agentName: "A", command: "npm test", workspacePath: "/ws" });
    expect(commands).toContain("execute_command");
    expect(outcome.run.agents.A.status).toBe("done");
  });

  it("does not run a shell command the host denies", async () => {
    const { nodes, handlers } = commandRun();
    const { host, commands, log } = fakeHost(handlers, { askCommand: async () => "deny" });

    await runWorkflow(runInput(nodes), host);

    expect(commands).not.toContain("execute_command");
    expect(log.audit.some((e) => e.action === "command_executed" && !e.success)).toBe(true);
  });

  it("ends the run as cancelled when the host says it was stopped", async () => {
    let stopped = false;
    const { host, log } = fakeHost(
      // Stop is pressed while the model works on its answer.
      { call_ollama_api: () => { stopped = true; return new Promise(() => {}); } },
      { isCancelled: () => stopped },
    );

    const outcome = await runWorkflow(runInput([makeNode("A")]), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(outcome.run.status).toBe("cancelled");
    expect(outcome.run.agents.A.status).toBe("stopped");
    expect(log.finished).toEqual(["cancelled"]);
  });

  it("keeps the files agents change in the run and reports each change to the host", async () => {
    const files: Record<string, string> = { "src/a.ts": "const x = 1;\n" };
    let calls = 0;
    const { host, log } = fakeHost({
      read_workspace_file: (args) => {
        const path = String(args.relativePath);
        if (path in files) return files[path];
        throw new Error("IO error: not found (os error 2)");
      },
      write_workspace_file: (args) => { files[String(args.relativePath)] = String(args.content); },
      call_ollama_api: () => (++calls === 1
        ? '<tool_call>{"name":"edit_file","args":{"path":"src/a.ts","old_string":"x = 1","new_string":"x = 2"}}</tool_call>'
        : "done"),
    });

    const outcome = await runWorkflow(runInput([makeNode("A", [ToolPermission.WriteFile])]), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(outcome.run.changes).toEqual([
      { path: "src/a.ts", before: "const x = 1;\n", after: "const x = 2;\n", agents: ["A"], edits: 1 },
    ]);
    expect(log.files).toEqual([{ path: "src/a.ts", before: "const x = 1;\n", after: "const x = 2;\n", agent: "A" }]);
  });

  it("stops at a failed node without continueOnError and reports the run as failed", async () => {
    const { host, log } = fakeHost({
      call_ollama_api: (args) => {
        if (who(args) === "A") throw new Error("model crashed");
        return "ok";
      },
    });

    const outcome = await runWorkflow(runInput(
      [makeNode("A"), makeNode("B")], [{ id: "a-b", source: "A", target: "B" }], { continueOnError: false }), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(outcome.run.status).toBe("error");
    expect(outcome.run.agents.A).toMatchObject({ status: "error", error: expect.stringMatching(/model crashed/) });
    expect(outcome.run.agents.B).toBeUndefined();
    expect(log.finished).toEqual(["error"]);
  });

  it("gives each finished node to the host's snapshot port when it has one", async () => {
    const snapshot = vi.fn();
    const { host } = fakeHost({}, { snapshot });

    const outcome = await runWorkflow(runInput([makeNode("A")]), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(snapshot).toHaveBeenCalledWith({ runId: outcome.run.id, nodeId: "A", status: "completed", output: "ok" });
  });
});

describe("the engine's boundary", () => {
  it("imports no React, UI store, IPC or Tauri code, so it can run outside the app", () => {
    const dir = resolve(__dirname, "../../../src/engine");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(resolve(dir, file), "utf8");
      const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
      const forbidden = runtimeImports.filter((from) => /^(react|@tauri-apps\/|@\/(store|hooks|components|ipc)\/)/.test(from));
      expect(forbidden, file).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/engine/runWorkflow.test.ts`
Expected: FAIL, because `@/engine/runWorkflow` cannot be resolved.

- [ ] **Step 3: Write the engine's head (header, imports, types)**

Write this to `$S/engine-head.ts`, where `$S` is a temporary folder (the session scratchpad):

```ts
/**
 * runWorkflow — the multi-agent workflow run engine.
 *
 * 1. AGENT CHAINING   — upstream agent outputs are passed as context to downstream agents
 * 2. MEMORY           — memoryRead/memoryWrite keys persist values across agents per run
 * 3. TOOL EXECUTION   — the node's tools run through agentLoop.ts (native tool calls, <tool_call>
 *                       fallback); subagent_dispatch starts helper agents (subAgents.ts)
 * 4. GATEWAY ROUTING  — gateway JSON output determines which downstream branch to follow
 * 5. MEMORY NODES     — aggregate upstream outputs into memory keys (no LLM call needed)
 * 6. PARALLEL EXEC    — independent branches run concurrently up to executionSettings.maxParallel
 *
 * Plain TypeScript with no React, UI stores or Tauri, so it can run outside the
 * app. The host runs the Rust commands, gets the run as events, approves shell
 * commands and says when the run is stopped. The app's host is in
 * hooks/useWorkflowExecution.ts.
 */

import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { AgentRun, SubAgentRecord, WorkflowRun } from "@/types/execution";
import type { HookResult } from "@/types/hookResult";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import type { CommandApproval, CommandRequest } from "@/store/commandConsentStore";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  isBillingRelatedError,
  isOllamaCloudUrl,
  isRemoteOllamaUrl,
  selectProviderForModel,
  shouldFallbackToOllama,
  type LlmProvider,
  type RuntimeProvider,
} from "@/utils/providerConfig";
import {
  callChatTurn,
  callProvider,
  buildSystemMessage,
  resolveModel,
  REASONING_EFFORT,
  isReasoningModel,
  type ChatMessage,
  type InvokeFn,
} from "@/services/model-providers/providerAdapter";
import { MemoryService } from "@/services/execution/memoryService";
import {
  executeTool,
  runnableTools,
  type ToolCall,
  type ToolSpec,
} from "@/services/execution/toolExecutor";
import { beforeDeadline, runAgentLoop } from "@/services/execution/agentLoop";
import { runCommandTool } from "@/services/execution/commandTool";
import { recordChange } from "@/services/execution/changeLog";
import { SUMMARY_INSTRUCTIONS } from "@/services/execution/compaction";
import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";
import {
  createSubAgentRunner,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_TOOL,
} from "@/services/execution/subAgents";
import { runParallel } from "@/services/execution/parallelScheduler";
import {
  firedFeedbackEdges,
  MAX_REVISION_ROUNDS,
  parseGatewayRoute,
  revisionPath,
} from "@/services/execution/routing";
import { resolvePromptContent } from "@/services/execution/promptSource";
import { entryAgentIds } from "@/services/execution/entryNodes";

// ── Run input and host ────────────────────────────────────────────────────────

/** Provider settings for a run: the fields of the app's executionStore. */
export interface ProviderSettings {
  llmProvider: LlmProvider;
  /** Anthropic key. */
  apiKey: string;
  openaiApiKey: string;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  customApiUrl: string;
  customApiKey: string;
  customApiModel: string;
}

export interface RunInput {
  graph: WorkflowGraph;
  config: WorkflowRunConfig;
  provider: ProviderSettings;
  /** Agents' file tools, commands and hooks work only inside it. */
  workspacePath: string | null;
  continueOnError: boolean;
}

/** A node that finished, for the app's context snapshots. */
export interface NodeSnapshot {
  runId: string;
  nodeId: string;
  status: "completed" | "failed";
  output: string;
  error?: string;
}

export interface RunEvents {
  onRunStarted: (runId: string, workflowName: string) => void;
  onAgentUpdate: (nodeId: string, partial: Partial<AgentRun>) => void;
  /** The canvas node's status, with its token count when it finishes. */
  onNodeStatus: (nodeId: string, status: AgentNodeData["status"], tokens?: { used: number; budget: number }) => void;
  onAudit: (entry: AuditEntry) => void;
  /** An agent changed a workspace file (fs.write, fs.append, edit_file). */
  onFileChange: (path: string, before: string | null, after: string, agent: string) => void;
  /** The run is over. The host must deny commands still waiting for approval. */
  onRunFinished: (status: "done" | "error" | "cancelled") => void;
}

export interface RunHost {
  /** Runs a Rust command by name, with the app's IPC arguments. */
  invoke: InvokeFn;
  events: RunEvents;
  /** Approves an agent's shell command, or not (in the app: the user). */
  askCommand: (request: Omit<CommandRequest, "id">) => Promise<CommandApproval>;
  /** True once the run is stopped. Asked only after onRunStarted. */
  isCancelled: () => boolean;
  snapshot?: (snapshot: NodeSnapshot) => void;
}

/** A run that never started (the provider preflight failed), or the finished run. */
export type RunOutcome =
  | { started: false; error: string }
  | { started: true; run: WorkflowRun };

```

Write this to `$S/engine-preamble.ts`:

```ts
// ── Engine ────────────────────────────────────────────────────────────────────

export async function runWorkflow(input: RunInput, host: RunHost): Promise<RunOutcome> {
  const { nodes, edges, meta, executionSettings } = input.graph;
  const { config, workspacePath, continueOnError } = input;
  const {
    apiKey, openaiApiKey, ollamaApiKey, customApiUrl, customApiKey, customApiModel,
    llmProvider, ollamaBaseUrl, ollamaModel,
  } = input.provider;
  const invoke = <T>(cmd: string, args?: Record<string, unknown>) => host.invoke<T>(cmd, args);
  const addEntry = (entry: AuditEntry) => host.events.onAudit(entry);
  // Async like the IPC wrappers they stand in for: a synchronous throw still rejects.
  const readWorkspaceFile = async (ws: string, relativePath: string) =>
    invoke<string>("read_workspace_file", { workspacePath: ws, relativePath });
  const writeAuditEntry = async (ws: string, entry: AuditEntry) =>
    invoke<void>("write_audit_entry", { workspacePath: ws, entry });

```

- [ ] **Step 4: Assemble the file from the hook**

First confirm the slice boundaries. Line 74 must be `// ── Edge helpers`, 116 `// ── Health checks`, 205 `// ── Resolve provider settings` and 845 `finishRun(anyFailed ? "error" : "done");`:

```bash
H=src/hooks/useWorkflowExecution.ts
for n in 74 110 116 162 205 845 846; do printf '%s: %s\n' $n "$(sed -n "${n}p" $H)"; done
```

Then assemble. The pieces:
- the hook's module helpers, lines 74–111 and 116–163, without `runInFlight` (lines 112–115);
- the preamble;
- the `runWorkflow` body, lines 205–845, dedented by two spaces because it is no longer nested in the hook;
- the closing brace.

```bash
S=<the temporary folder>
{ cat "$S/engine-head.ts"; sed -n '74,111p' $H; sed -n '116,163p' $H; cat "$S/engine-preamble.ts"
  sed -n '205,845p' $H | sed 's/^  //'; echo "}"; } > src/engine/runWorkflow.ts
```

(No template string in lines 205–845 spans two lines, so the dedent changes no string.)

- [ ] **Step 5: Edit the moved code to use `input` and `host`**

Apply these edits to `src/engine/runWorkflow.ts`. The "old" text is shown as it looks after the dedent.

**E1.** `runHealthChecks` takes `invoke`, and an audit callback instead of the store's `addEntry` type:

```ts
// old
async function runHealthChecks(
  openaiKey: string, anthropicKey: string,
// new
async function runHealthChecks(
  invoke: InvokeFn,
  openaiKey: string, anthropicKey: string,
```
```ts
// old
  addEntry: ReturnType<typeof useAuditStore.getState>["addEntry"],
// new
  addEntry: (entry: AuditEntry) => void,
```

**E2.** The call passes it:

```ts
// old
  const healthResults = await runHealthChecks(
    requiredProviders.has("openai") ? openaiApiKey : "",
// new
  const healthResults = await runHealthChecks(
    invoke,
    requiredProviders.has("openai") ? openaiApiKey : "",
```

**E3.** Preflight failures return instead of reporting. There are four sites.

```ts
// old
  if (missingKey) {
    reportError("No API key for the selected provider. Add one in Settings or switch to Ollama.");
    return;
  }
// new
  if (missingKey) {
    return { started: false, error: "No API key for the selected provider. Add one in Settings or switch to Ollama." };
  }
```
```ts
// old
    reportError("Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint.");
    return;
// new
    return { started: false, error: "Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint." };
```
```ts
// old
        reportError(`${ollamaHealth?.message ?? "Ollama not reachable."}${pull}`);
        return;
// new
        return { started: false, error: `${ollamaHealth?.message ?? "Ollama not reachable."}${pull}` };
```
```ts
// old
      reportError(h.message);
      return;
// new
      return { started: false, error: h.message };
```

**E4.** The run starts in the engine, which keeps its own record:

```ts
// old
  const runId = startRun(meta.name);
  // Scoped to this run: Stop (or any newer run) ends it.
  const isRunCancelled = () => {
    const run = useExecutionStore.getState().currentRun;
    return !run || run.id !== runId || run.status === "cancelled";
  };
  for (const n of nodes) updateNodeData(n.id, { status: "idle" });
// new
  const runId = `run-${Date.now()}`;
  const run: WorkflowRun = { id: runId, workflowName: meta.name, startedAt: Date.now(), status: "running", agents: {} };
  host.events.onRunStarted(runId, meta.name);
  const isRunCancelled = () => host.isCancelled();
  // The engine's record of the run; the host gets every change as an event.
  const updateAgent = (nodeId: string, partial: Partial<AgentRun>) => {
    run.agents[nodeId] = { ...(run.agents[nodeId] ?? { agentId: nodeId, agentName: nodeId, status: "idle" }), ...partial };
    host.events.onAgentUpdate(nodeId, partial);
  };
  const updateNodeData = (nodeId: string, data: { status: AgentNodeData["status"]; tokens?: { used: number; budget: number } }) =>
    host.events.onNodeStatus(nodeId, data.status, data.tokens);
  for (const n of nodes) updateNodeData(n.id, { status: "idle" });
```

**E5.** The change log goes into the record and to the host. The newer-run guard moves to the app's host.

```ts
// old
      // Every file an agent writes goes into the run's change log (Changes dialog,
      // revert). A helper can finish after its run ended: never write into a newer run.
      const recordChangeBy = (agent: string) => (path: string, before: string | null, after: string) => {
        if (useExecutionStore.getState().currentRun?.id !== runId) return;
        useExecutionStore.getState().recordFileChange(path, before, after, agent);
      };
// new
      // Every file an agent writes goes into the run's change log (Changes dialog, revert).
      const recordChangeBy = (agent: string) => (path: string, before: string | null, after: string) => {
        run.changes = recordChange(run.changes ?? [], path, before, after, agent);
        host.events.onFileChange(path, before, after, agent);
      };
```

**E6.** Commands are approved by the host:

```ts
// old
      // bash: each command waits for the user's approval (CommandConsentDialog).
      const runCommand = (args: Record<string, unknown>) => runCommandTool(args, {
        runId, agentName: data.name, workspacePath, invoke,
        askUser: (command) => useCommandConsentStore.getState().request({
// new
      // bash: the host approves each command (the app asks the user: CommandConsentDialog).
      const runCommand = (args: Record<string, unknown>) => runCommandTool(args, {
        runId, agentName: data.name, workspacePath, invoke,
        askUser: (command) => host.askCommand({
```

**E7.** Helper updates lose the store guard, which moves to the app's host:

```ts
// old
        // The activity panel shows the helpers from the node's run record. A helper
        // can finish after its run ended (Stop): never write it into a newer run.
        onUpdate: (record) => {
          if (useExecutionStore.getState().currentRun?.id !== runId) return;
          const i = helpers.findIndex((h) => h.id === record.id);
// new
        // The activity panel shows the helpers from the node's run record.
        onUpdate: (record) => {
          const i = helpers.findIndex((h) => h.id === record.id);
```

**E8.** Snapshots go to the optional port. Replace the whole block, starting at `// Build real artifact from agent output (not mock)` and running through the first `createSnapshot(...).catch(console.error);`, with:

```ts
      host.snapshot?.({ runId, nodeId, status: "completed", output: finalText });
```

In the `catch`, replace the second `createSnapshot(...).catch(console.error);`, the one with `snapshotStatus: "failed"`, with:

```ts
      host.snapshot?.({ runId, nodeId, status: "failed", output: "", error: String(e) });
```

**E9.** The ending reports to the host and returns the record:

```ts
// old
  } catch {
    finishRun("error");
    return;
  } finally {
    // A command still waiting for approval must not run once the run is over.
    useCommandConsentStore.getState().denyRun(runId);
  }

  const finalRun = useExecutionStore.getState().currentRun;
  if (finalRun?.status === "cancelled") return;
  // With continueOnError the scheduler completes despite failed agents; the run
  // must still be reported as failed rather than "done".
  const anyFailed = Object.values(finalRun?.agents ?? {}).some((a) => a.status === "error");
  finishRun(anyFailed ? "error" : "done");
}
// new
  } catch {
    failed = true;
  }

  // With continueOnError the scheduler completes despite failed agents; the run
  // must still be reported as failed rather than "done".
  const anyFailed = Object.values(run.agents).some((a) => a.status === "error");
  const status = failed ? "error" : isRunCancelled() ? "cancelled" : anyFailed ? "error" : "done";
  run.status = status;
  run.finishedAt = Date.now();
  host.events.onRunFinished(status);
  return { started: true, run };
}
```

and just above the `try`:

```ts
// old
  const maxParallel = executionSettings.maxParallel || 4;
  try {
// new
  const maxParallel = executionSettings.maxParallel || 4;
  let failed = false;
  try {
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. A leftover name from the hook, such as `useExecutionStore`, `reportError`, `startRun`, `createSnapshot` or `Artifact`, shows up here as "Cannot find name". Replace it as the edits above describe.

Then confirm that no store or snapshot name survived:

```bash
grep -nE "useExecutionStore|useCommandConsentStore|useAuditStore|reportError|startRun|finishRun|createSnapshot|Artifact" src/engine/runWorkflow.ts
```
Expected: no output.

- [ ] **Step 7: Run the engine tests**

Run: `npx vitest run tests/unit/engine`
Expected: PASS (all tests in both files).

- [ ] **Step 8: Check that the boundary guard catches a violation**

Temporarily add `import { useAuditStore } from "@/store/auditStore";` as the first import of `src/engine/runWorkflow.ts`. Then run `npx vitest run tests/unit/engine/runWorkflow.test.ts -t boundary`.
Expected: FAIL, listing `@/store/auditStore` for `runWorkflow.ts`.

Remove the line and run it again. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/engine/runWorkflow.ts tests/unit/engine/runWorkflow.test.ts
git commit -m "Add the shared run engine: runWorkflow(input, host), moved from the hook"
```

---

### Task 3: The hook becomes the app's host

**Files:**
- Modify: `src/store/executionStore.ts` (`startRun`)
- Modify: `src/ipc/tauriCommands.ts:8`
- Rewrite: `src/hooks/useWorkflowExecution.ts`
- Test: `tests/unit/store/executionStore.test.ts`, plus the **unchanged** `tests/unit/hooks/useWorkflowExecution.test.ts`

- [ ] **Step 1: Confirm the hook tests pass before the change**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts`
Expected: PASS. This is the safety net for the refactor.

- [ ] **Step 2: Write the failing store test**

Append to `tests/unit/store/executionStore.test.ts`:

```ts
describe("executionStore — runs", () => {
  it("starts a run under the id the engine gave it", () => {
    const id = useExecutionStore.getState().startRun("W", "run-42");

    expect(id).toBe("run-42");
    expect(useExecutionStore.getState().currentRun).toMatchObject({ id: "run-42", workflowName: "W", status: "running" });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/unit/store/executionStore.test.ts`
Expected: FAIL: `expected 'run-17…' to be 'run-42'`.

- [ ] **Step 4: Let `startRun` take the id**

In `src/store/executionStore.ts`, change the action's type:

```ts
  /** Starts a run; the engine passes its run id. */
  startRun: (workflowName: string, id?: string) => string;
```

and its implementation's first lines:

```ts
  startRun: (workflowName, id = `run-${Date.now()}`) => {
    const run: WorkflowRun = {
```

(Delete the old `const id = \`run-${Date.now()}\`;` line.)

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run tests/unit/store/executionStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Export the unified invoke**

In `src/ipc/tauriCommands.ts`, line 8, change `function invoke<T>(` to `export function invoke<T>(`.

- [ ] **Step 7: Rewrite `src/hooks/useWorkflowExecution.ts` as the adapter**

The whole file:

```ts
/**
 * useWorkflowExecution — runs the canvas workflow in the app.
 *
 * The run itself is the shared engine (src/engine/runWorkflow.ts). This hook
 * gives it the canvas and the settings, and a host that writes the run into the
 * stores, asks the user to approve commands and saves context snapshots.
 */

import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useAuditStore } from "@/store/auditStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useCommandConsentStore } from "@/store/commandConsentStore";
import { invoke } from "@/ipc/tauriCommands";
import { buildContextSnapshot } from "@/services/context-builder/contextSnapshot";
import { createSnapshot } from "@/services/context-builder/snapshotService";
import type { Artifact } from "@/types/inspection";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import { runWorkflow, type RunHost } from "@/engine/runWorkflow";

// Set synchronously when a run starts so a second Run click during the async
// provider preflight (before isRunning flips) is rejected too.
let runInFlight = false;

export function useWorkflowExecution() {
  const nodes             = useWorkflowStore((s) => s.nodes);
  const edges             = useWorkflowStore((s) => s.edges);
  const meta              = useWorkflowStore((s) => s.meta);
  const executionSettings = useWorkflowStore((s) => s.executionSettings);
  const updateNodeData    = useWorkflowStore((s) => s.updateNodeData);
  const workspacePath     = useWorkspaceStore((s) => s.workspacePath);
  const {
    currentRun, apiKey, openaiApiKey, ollamaApiKey,
    customApiUrl, customApiKey, customApiModel,
    llmProvider, ollamaBaseUrl, ollamaModel,
    startRun, updateAgent, finishRun, cancelRun, isRunning, continueOnError,
  } = useExecutionStore();
  const addEntry = useAuditStore((s) => s.addEntry);

  async function executeWorkflow(
    config: WorkflowRunConfig = {
      userInput: "", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null,
    },
    onError?: (msg: string) => void,
  ) {
    const reportError = (msg: string) => { if (onError) onError(msg); else alert(msg); };
    if (runInFlight || useExecutionStore.getState().isRunning) {
      reportError("A workflow run is already in progress. A stopped run first finishes its in-flight agent calls.");
      return;
    }
    runInFlight = true;
    // Run status is written onto the nodes; keep it out of the undo history.
    const history = useWorkflowStore.temporal.getState();
    history.pause();
    try {
      const outcome = await runWorkflow({
        graph: { nodes, edges, meta, executionSettings },
        config,
        provider: {
          llmProvider, apiKey, openaiApiKey, ollamaApiKey, ollamaBaseUrl, ollamaModel,
          customApiUrl, customApiKey, customApiModel,
        },
        workspacePath,
        continueOnError,
      }, appHost());
      if (!outcome.started) reportError(outcome.error);
    } finally {
      history.resume();
      runInFlight = false;
    }
  }

  /** Writes the run into the stores, asks the user to approve commands, saves snapshots. */
  function appHost(): RunHost {
    let runId = "";
    // Stop or a newer run ends this run; its late events never reach a newer run.
    const isCurrent = () => useExecutionStore.getState().currentRun?.id === runId;
    return {
      invoke,
      events: {
        onRunStarted: (id, workflowName) => { runId = id; startRun(workflowName, id); },
        onAgentUpdate: (nodeId, partial) => { if (isCurrent()) updateAgent(nodeId, partial); },
        onNodeStatus: (nodeId, status, tokens) => updateNodeData(nodeId, tokens ? { status, tokens } : { status }),
        onAudit: addEntry,
        onFileChange: (path, before, after, agent) => {
          if (isCurrent()) useExecutionStore.getState().recordFileChange(path, before, after, agent);
        },
        onRunFinished: (status) => {
          // A command still waiting for approval must not run once the run is over.
          useCommandConsentStore.getState().denyRun(runId);
          // Stop has already marked the run cancelled.
          if (status !== "cancelled" && isCurrent()) finishRun(status);
        },
      },
      askCommand: (request) => useCommandConsentStore.getState().request(request),
      isCancelled: () => {
        const run = useExecutionStore.getState().currentRun;
        return !run || run.id !== runId || run.status === "cancelled";
      },
      snapshot: ({ runId: id, nodeId, status, output, error }) => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const now = new Date().toISOString();
        // The node's real output, as a live artifact for the Inspector.
        const artifacts: Artifact[] = status === "completed" ? [{
          id: `artifact-${nodeId}-${Date.now()}`, title: `${node.data.name} output`, type: "markdown",
          sourceNodeId: nodeId, content: output, status: "live", createdAt: now, updatedAt: now,
          version: 1, previewMode: "rendered",
        }] : [];
        createSnapshot(
          buildContextSnapshot({ node, nodes, edges,
            agentRun: { agentId: nodeId, agentName: node.data.name, status: status === "completed" ? "done" : "error", output },
            artifacts }),
          { workspacePath, workflowId: meta.name, runId: id, snapshotStatus: status,
            ...(error === undefined ? {} : { metadata: { error } }) },
        ).catch(console.error);
      },
    };
  }

  return { executeWorkflow, currentRun, isRunning, cancelRun };
}
```

- [ ] **Step 8: Run the hook tests, unchanged**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts && git diff --stat -- tests/unit/hooks`
Expected: PASS, and an empty diff for `tests/unit/hooks`.

- [ ] **Step 9: Type-check and run the full suite**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected:
- No type errors.
- 59 test files pass: the 57 from Task 0 plus the 2 new engine files (the store test is a new `describe` in an existing file). That is 611 tests: 593 plus 18 new (8 in `workflowGraph`, 9 in `runWorkflow`, 1 in the store).

- [ ] **Step 10: Commit**

```bash
git add src/store/executionStore.ts src/ipc/tauriCommands.ts src/hooks/useWorkflowExecution.ts tests/unit/store/executionStore.test.ts
git commit -m "Run app workflows through the shared engine; the hook is now its host"
```

---

### Task 4: Docs pointers and final verification

**Files:**
- Modify: `AGENT.md` (Key Files table)
- Modify: `docs/ARCHITECTURE.md` (Current Runtime Architecture)

- [ ] **Step 1: Point the docs at the engine**

In `AGENT.md`, replace this Key Files row:

```md
| `src/hooks/useWorkflowExecution.ts` | Workflow runner (uses `runParallel`) |
```

with these two:

```md
| `src/engine/runWorkflow.ts` | Workflow run engine (uses `runParallel`); no React, stores or Tauri |
| `src/hooks/useWorkflowExecution.ts` | Runs the canvas workflow in the app through the engine |
```

In `docs/ARCHITECTURE.md`, replace:

```md
- `useWorkflowExecution.ts` runs workflows through the dependency-aware `runParallel()` scheduler.
```

with:

```md
- `src/engine/runWorkflow.ts` runs workflows through the dependency-aware `runParallel()` scheduler. The `useWorkflowExecution` hook gives it the canvas and settings, and a host that updates the stores.
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5 && npm run build 2>&1 | tail -3`
Expected:
- No type errors.
- All tests pass.
- The build succeeds with `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
git add AGENT.md docs/ARCHITECTURE.md
git commit -m "Point the docs at the shared run engine"
```

---

## Spec coverage (Part 1)

| Spec §1 requirement | Where |
|---|---|
| `src/engine/runWorkflow.ts`: plain TS, no React, UI stores or Tauri | Task 2, boundary test |
| `runWorkflow(input, host): Promise<RunOutcome>` | Task 2 |
| input: graph, run config, provider settings, `workspacePath`, `continueOnError` | `RunInput` (resume input: Part 4) |
| host: `invoke`, events, `askCommand`, `isCancelled`, `snapshot?` | `RunHost` (`saveRun`: Part 4) |
| the hook becomes an adapter; the hook tests pass unmodified | Task 3, Steps 7–8 |
| `defToGraph` in `src/engine/workflowGraph.ts`, shared by the store | Task 1 |
| refactor, not rewrite (scheduler, loop, tools, compaction, routing unchanged) | Task 2 edits touch only the moved body |
| engine unit tests with a fake host | Task 2, Step 1 |
| `defToGraph` round trip on the bundled examples | Task 1, Step 1 |
