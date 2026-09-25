# Headless + CI, Part 4: Saved Runs and Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run, in the app and in `harness run`, saves a record at `.harness/runs/<runId>/run.json`. `harness run --resume <runId>` reuses the agents that finished and didn't change.

**Architecture:**
- **`src/engine/runRecord.ts`** holds pure pieces:
  - the record types;
  - `definitionHash`, a pure-TS fingerprint;
  - `reusableNodes`, the reuse rule;
  - `writeRunRecord`.
- **The engine** builds the record from its own state and calls an optional `host.saveRun`, in order and awaited:
  - after the run starts;
  - after each node settles;
  - at the end.

  A failed save is reported once, and the run goes on.
- **On resume**, the engine keeps the run id, restores the reused nodes' outputs, memory and gateway routes plus the change log, and short-circuits reused nodes in `runNode`.
- **`harness-core`** ignores Ctrl+C, so Stop can finish and save.

**Tech Stack:** TypeScript, Rust (tokio signals), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-25-headless-ci-design.md` §4, with its Part 4 implementation notes.

---

## Design decisions (read before starting)

1. **Node keys.** The record keys nodes by their place in the workflow file (`agent-<i>`), not by graph id.
   - `harness run`'s ids already are `agent-<i>` (`defToGraph`).
   - The app's canvas ids are not, but `toWorkflowDef` saves canvas node *i* as `agent-<i>`.
   - So a run in the app is resumable by `harness run` on the saved file.
2. **`definitionHash`.** It is a pure-TS fingerprint (cyrb53) of the node's role, model, tools, max steps, timeout, max tokens, think depth, prompt source, prompt *text*, memory keys and hook.
   - It excludes status, tokens used and position.
   - File prompts are read at run start for this. An unreadable file hashes as `unreadable: …`; that node fails when it runs, so it is never "done" and never reused.
   - Only the CLI computes the YAML file's SHA-256 (`node:crypto`), and passes it in as `input.workflowFile`. The app passes its file path and `hash: null`.
3. **Reuse rule** (`reusableNodes`): a node is reused only if all of these hold:
   - its saved status is `done`;
   - its saved `definitionHash` equals the current one;
   - every forward predecessor is reused. "Forward" is the scheduler's own `isForwardEdge`, now exported.
4. **What resume restores.**
   - For reused nodes only: `agentOutputs` (from the record's `outputs`), the memory keys they write, and a reused gateway's route.
   - The whole change log, because those files were changed, and the audit list, which continues.
   - The record's `outputs` field exists because a memory node's `agentOutputs` (the text it passes on) is not its shown output.
5. **`runNode` short-circuits reused nodes.** It emits the saved state: an audit line `↩ <agent>: reused from the saved run (unchanged)`, then the done update. It skips `processNode` and the revision check.
   - A reused reviewer can therefore never re-trigger its revision loop.
   - A revision round that targets a reused node still runs it, because `revisionPath` calls `processNode` directly.
6. **Saving.** `save()` builds the record at the moment it is called and chains the write behind the previous one, so writes land in order. It returns the chain, which is awaited:
   - after the start;
   - in a `finally` at the end of each `runNode`, so a failure path saves too;
   - before `onRunFinished`.

   On a rejection: one audit entry `Could not save the run record: …`, and the run continues.
7. **The app saves when a workspace is open** (`host.saveRun` through the unified `invoke`). One hook test asserted that `write_workspace_file` was never called; that assertion now ignores `.harness/runs/`. The other hook tests have no `write_workspace_file` mock, so their saves reject and exercise the "reported once" path.
8. **CLI resume.**
   - `--resume <runId>` makes `--task` optional.
   - The CLI reads the record with `node:fs` *before* starting the core. These are exit 2: an unknown id or a bad id format, another workflow's run, and a different task.
   - Otherwise the run keeps the same id, `attempts` goes up by 1, and the saved task is used.
   - The summary prints `Saved: .harness/runs/<id>/run.json` and, for a run that didn't finish, a `Resume:` line.
   - The `run_finished` JSON event carries `trace`.
   - The reporter prints `↩` lines, skips the stale `✓ done` line for reused nodes, and marks `node_finished` with `reused: true`.
9. **Ctrl+C.** The terminal's Ctrl+C reaches `harness-core`, which shares the console on Windows and the process group on POSIX. By default that kills the core, so the run would exit 3 and never save as `cancelled`.
   - `harness-core` now installs a tokio handler that ignores it, registered before serving; the end of its input still stops it.
   - A Unix-only integration test sends SIGINT and checks that the core keeps answering. On Windows this is left to the Part 5 smoke test.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/bin/harness-core.rs` | modify | ignore Ctrl+C |
| `src-tauri/tests/core_bin.rs` | add a test | SIGINT does not stop the core (Unix) |
| `src/services/execution/parallelScheduler.ts` | modify | export `isForwardEdge` |
| `src/engine/runRecord.ts` | create | `RunRecord`, `NodeRecord`, `runRecordPath`, `savedNodeId`, `fingerprint`, `definitionHash`, `reusableNodes`, `writeRunRecord` |
| `src/engine/runWorkflow.ts` | modify | `workflowFile`, `resume` inputs; `saveRun` port; audit log; hashes; saves; resume restore; `runNode` wrapper |
| `src/hooks/useWorkflowExecution.ts` | modify | save runs when a workspace is open; pass the workflow file path |
| `src/cli/runArgs.ts`, `src/cli/runCli.ts`, `src/cli/report.ts` | modify | `--resume`, record loading, file hash, save, trace, reused lines |
| `tests/node-shims.d.ts` | modify | `node:crypto` `createHash`, `node:path` `relative` |
| `.gitignore` | modify | `.harness/runs/`, `**/.harness/runs/` |
| tests | create/modify | `runRecord.test.ts`; engine, hook, `runArgs`, `report` and `harnessRun` tests |

---

### Task 1: `harness-core` ignores Ctrl+C

- [ ] **Step 1: Failing test (Unix)**

Append to `src-tauri/tests/core_bin.rs`:

```rust
/// Asks for the provider defaults and returns the reply.
fn ask(stdin: &mut impl Write, stdout: &mut impl BufRead, id: u32) -> Value {
    writeln!(stdin, r#"{{"id":{id},"cmd":"get_provider_defaults"}}"#).unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

/// Ctrl+C in the terminal reaches the core along with harness run, which turns it
/// into Stop: the core must keep serving so the run can end and be saved.
#[cfg(unix)]
#[test]
fn keeps_serving_after_ctrl_c() {
    let mut core = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = core.stdin.take().unwrap();
    let mut stdout = BufReader::new(core.stdout.take().unwrap());
    assert_eq!(ask(&mut stdin, &mut stdout, 1)["id"], 1);

    let interrupted = Command::new("kill").args(["-INT", &core.id().to_string()]).status().unwrap();
    assert!(interrupted.success());
    std::thread::sleep(std::time::Duration::from_millis(200));

    assert_eq!(ask(&mut stdin, &mut stdout, 2)["id"], 2);
    drop(stdin);
    assert!(core.wait().unwrap().success());
}
```

On Windows it compiles out. Run `cd src-tauri && cargo test --no-default-features --features core --test core_bin`: the existing test passes. On Linux (CI), the new test fails before Step 2, because SIGINT kills the core.

- [ ] **Step 2: `src-tauri/src/bin/harness-core.rs`**

```rust
//! harness-core: the app's Rust commands without Tauri, served over stdin/stdout
//! for `harness run`. Build: `npm run build:core`. Protocol: commands/core_server.rs.

#[tokio::main]
async fn main() {
    ignore_ctrl_c();
    tauri_app_lib::serve_stdio().await;
}

/// Ctrl+C in the terminal reaches this process too (same console or process
/// group). harness run turns it into Stop and needs the core to finish the run
/// and save it, so the core ignores it: the end of its input is what stops it.
fn ignore_ctrl_c() {
    #[cfg(unix)]
    let signals = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
    #[cfg(windows)]
    let signals = tokio::signal::windows::ctrl_c();
    if let Ok(mut signals) = signals {
        tokio::spawn(async move { while signals.recv().await.is_some() {} });
    }
}
```

- [ ] **Step 3:** Run `cd src-tauri && cargo test --no-default-features --features core && cargo check`. Expected:
- all core-build tests pass;
- the app check is clean;
- `npm run build:core` succeeds.

- [ ] **Step 4: Commit:** `git add src-tauri/src/bin/harness-core.rs src-tauri/tests/core_bin.rs && git commit -m "harness-core ignores Ctrl+C: harness run turns it into Stop and still needs the core"`

---

### Task 2: `runRecord.ts`

- [ ] **Step 1: Failing test** — `tests/unit/engine/runRecord.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  definitionHash, fingerprint, reusableNodes, runRecordPath, savedNodeId, type NodeRecord, type RunRecord,
} from "@/engine/runRecord";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";

function data(name: string): AgentNodeData {
  return {
    name, role: AgentRole.Worker, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 3,
    timeoutSeconds: 300, promptSource: { type: "inline", content: `Be ${name}.` }, tools: [], memoryRead: [],
    memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
  };
}

describe("fingerprint", () => {
  it("is the same for the same text and differs for another", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("")).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("definitionHash", () => {
  it("changes with what shapes the work, not with the node's status or token count", () => {
    const base = definitionHash(data("A"), "Be A.");
    expect(definitionHash({ ...data("A"), status: "done", tokens: { used: 900, budget: 0 } }, "Be A.")).toBe(base);
    expect(definitionHash(data("A"), "Be A, but faster.")).not.toBe(base);
    expect(definitionHash({ ...data("A"), model: "qwen3:8b" }, "Be A.")).not.toBe(base);
    expect(definitionHash({ ...data("A"), tools: ["read_file"] as AgentNodeData["tools"] }, "Be A.")).not.toBe(base);
  });
});

describe("reusableNodes", () => {
  const node = (name: string, i: number): AgentNode =>
    ({ id: `n-${name}`, type: "agent", position: { x: i, y: 0 }, data: data(name) });
  // A → B → C, and D on its own; C sends feedback to A, which does not make A depend on C.
  const graph: WorkflowGraph = {
    nodes: ["A", "B", "C", "D"].map(node),
    edges: [
      { id: "ab", source: "n-A", target: "n-B" },
      { id: "bc", source: "n-B", target: "n-C" },
      { id: "ca", source: "n-C", target: "n-A", data: { edgeKind: "feedback" } },
    ] as Edge[],
    meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    executionSettings: { maxParallel: 4, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
  };
  const hashes = new Map(graph.nodes.map((n) => [n.id, `hash-${n.data.name}`]));
  const saved = (changes: Record<string, Partial<NodeRecord> | null>): RunRecord => {
    const nodes: Record<string, NodeRecord> = {};
    graph.nodes.forEach((n, i) => {
      const change = changes[n.data.name];
      if (change === null) return; // the saved run never got to it
      nodes[savedNodeId(i)] = { agent: n.data.name, status: "done", definitionHash: `hash-${n.data.name}`, ...change };
    });
    return {
      version: 1, runId: "run-1", workflow: { name: "W", path: null, hash: null }, task: "t",
      provider: { llmProvider: "ollama", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "" },
      status: "error", startedAt: 0, attempts: 1, nodes, outputs: {}, memory: {}, gatewayRoutes: {}, changes: [], audit: [],
    };
  };
  const reused = (changes: Record<string, Partial<NodeRecord> | null>) =>
    [...reusableNodes(graph, saved(changes), hashes)].map((id) => id.slice(2)).sort();

  it("reuses every node that finished and did not change", () => {
    expect(reused({})).toEqual(["A", "B", "C", "D"]);
  });

  it("re-runs a changed node and everything after it", () => {
    expect(reused({ B: { definitionHash: "an older hash" } })).toEqual(["A", "D"]);
  });

  it("re-runs a node that failed or was stopped, and what comes after it", () => {
    expect(reused({ A: { status: "error" } })).toEqual(["D"]);
    expect(reused({ C: { status: "stopped" } })).toEqual(["A", "B", "D"]);
  });

  it("runs a node the saved run never reached", () => {
    expect(reused({ D: null })).toEqual(["A", "B", "C"]);
  });
});

describe("runRecordPath", () => {
  it("is under .harness/runs in the workspace", () => {
    expect(runRecordPath("run-7")).toBe(".harness/runs/run-7/run.json");
  });
});
```

Run: `npx vitest run tests/unit/engine/runRecord.test.ts` → FAIL (module not found).

- [ ] **Step 2: Export the scheduler's edge rule** — in `src/services/execution/parallelScheduler.ts`, `function isForwardEdge(` becomes `export function isForwardEdge(`.

- [ ] **Step 3: `src/engine/runRecord.ts`**

```ts
/**
 * A run's saved record: .harness/runs/<runId>/run.json in the workspace, written
 * as the run goes (docs/HEADLESS.md). `harness run --resume` reuses the nodes it
 * saved as done when nothing that shapes their work has changed.
 */
import type { AgentNodeData } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { AgentStatus, FileChange, SubAgentRecord, WorkflowRun } from "@/types/execution";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import { isForwardEdge } from "@/services/execution/parallelScheduler";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { ProviderSettings } from "@/engine/runWorkflow";

export const RUN_RECORD_VERSION = 1;

/** Where a run's record is, relative to the workspace. */
export const runRecordPath = (runId: string) => `.harness/runs/${runId}/run.json`;

/** A node's key in the record: its place in the workflow file ("agent-<i>"), so
 *  a run in the app and a run of the saved file name the same node alike. */
export const savedNodeId = (index: number) => `agent-${index}`;

export interface NodeRecord {
  agent: string;
  status: AgentStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  modelUsed?: string;
  providerUsed?: string;
  tokenEstimate?: number;
  revision?: number;
  subAgents?: SubAgentRecord[];
  /** What shapes the node's work; resume re-runs the node when it changes. */
  definitionHash: string;
}

export interface RunRecord {
  version: typeof RUN_RECORD_VERSION;
  runId: string;
  /** The workflow file, relative to the workspace, and the SHA-256 of its text (harness run). */
  workflow: { name: string; path: string | null; hash: string | null };
  task: string;
  /** The run's provider settings, without keys. */
  provider: Omit<ProviderSettings, "apiKey" | "openaiApiKey" | "ollamaApiKey" | "customApiKey">;
  status: WorkflowRun["status"];
  startedAt: number;
  finishedAt?: number;
  /** 1 for the first run; each resume adds 1. */
  attempts: number;
  nodes: Record<string, NodeRecord>;
  /** The text each node passes downstream (a memory node's differs from its shown output). */
  outputs: Record<string, string>;
  memory: Record<string, string>;
  gatewayRoutes: Record<string, string>;
  changes: FileChange[];
  audit: AuditEntry[];
}

/** A short fingerprint of a text, to notice a change (cyrb53 by bryc, public
 *  domain). Not for security. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** What shapes a node's work, as a fingerprint. `prompt` is the prompt's text:
 *  a file prompt's content, so an edited file counts as a change. */
export function definitionHash(data: AgentNodeData, prompt: string): string {
  return fingerprint(JSON.stringify([
    data.role, data.model, data.tools, data.maxSteps, data.timeoutSeconds, data.maxTokens, data.thinkDepth ?? null,
    data.promptSource, prompt, data.memoryRead, data.memoryWrite, data.preHook ?? null,
  ]));
}

/** The nodes a resume reuses: saved as done, unchanged since (same definition
 *  hash), and fed only by nodes that are reused too. `hashes` are today's, by node id. */
export function reusableNodes(graph: WorkflowGraph, record: RunRecord, hashes: ReadonlyMap<string, string>): Set<string> {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const decided = new Map<string, boolean>();
  const reusable = (id: string): boolean => {
    const known = decided.get(id);
    if (known !== undefined) return known;
    decided.set(id, false); // nothing on a cycle is reused
    const saved = record.nodes[savedNodeId(index.get(id) ?? -1)];
    const ok = saved?.status === "done"
      && saved.definitionHash === hashes.get(id)
      && graph.edges
        .filter((e) => e.target === id && isForwardEdge(e) && index.has(e.source))
        .every((e) => reusable(e.source));
    decided.set(id, ok);
    return ok;
  };
  return new Set(graph.nodes.map((n) => n.id).filter(reusable));
}

/** Writes the record with the Rust command, which replaces the file atomically. */
export function writeRunRecord(invoke: InvokeFn, workspacePath: string, record: RunRecord): Promise<void> {
  return invoke<void>("write_workspace_file", {
    workspacePath, relativePath: runRecordPath(record.runId), content: `${JSON.stringify(record, null, 2)}\n`,
  });
}
```

- [ ] **Step 4:** Run `npx vitest run tests/unit/engine && npx tsc --noEmit` → PASS (runRecord: 8 tests; the boundary test still passes because `runRecord.ts` imports no UI code).

- [ ] **Step 5: Commit:** `git add src/engine/runRecord.ts src/services/execution/parallelScheduler.ts tests/unit/engine/runRecord.test.ts && git commit -m "Add the run record: types, definition hashes and the resume reuse rule"`

---

### Task 3: The engine saves the run record

**Files:** `src/engine/runWorkflow.ts`, `tests/unit/engine/runWorkflow.test.ts`

- [ ] **Step 1: Failing tests** — add to `runWorkflow.test.ts` (import `type RunRecord` from `@/engine/runRecord`):

```ts
describe("saving the run record", () => {
  const chain = (): [AgentNode[], Edge[]] => [[makeNode("A"), makeNode("B")], [{ id: "a-b", source: "A", target: "B" }]];

  it("saves the record at the start, after each node and at the end", async () => {
    const records: RunRecord[] = [];
    const { host } = fakeHost({ call_ollama_api: (args) => `out-${who(args)}` },
      { saveRun: async (record) => { records.push(JSON.parse(JSON.stringify(record))); } });

    const outcome = await runWorkflow(runInput(...chain()), host);

    if (!outcome.started) throw new Error(outcome.error);
    expect(records.length).toBeGreaterThanOrEqual(4); // start, A, B, end
    expect(records[0]).toMatchObject({
      version: 1, runId: outcome.run.id, status: "running", attempts: 1, task: "Ship it",
      workflow: { name: "W", path: null, hash: null },
    });
    const last = records.at(-1)!;
    expect(last).toMatchObject({ status: "done", outputs: { "agent-0": "out-A", "agent-1": "out-B" } });
    expect(last.nodes["agent-0"]).toMatchObject({
      agent: "A", status: "done", output: "out-A", modelUsed: "qwen2.5-coder:7b",
      definitionHash: expect.stringMatching(/^[0-9a-f]{14}$/),
    });
    expect(last.audit.some((e) => e.details?.startsWith("▶ A"))).toBe(true);
  });

  it("keeps provider keys out of the record", async () => {
    let record: RunRecord | undefined;
    const { host } = fakeHost({}, { saveRun: async (r) => { record = r; } });
    const input = runInput([makeNode("A")]);
    input.provider = { ...input.provider, apiKey: "sk-ant-secret", openaiApiKey: "sk-secret", ollamaApiKey: "ol-secret", customApiKey: "c-secret" };

    await runWorkflow(input, host);

    expect(JSON.stringify(record)).not.toMatch(/secret/);
  });

  it("reports a failing save once, and the run goes on", async () => {
    const { host, log } = fakeHost({}, { saveRun: async () => { throw new Error("disk full"); } });

    const outcome = await runWorkflow(runInput(...chain()), host);

    expect(outcome.started && outcome.run.status).toBe("done");
    expect(log.audit.filter((e) => e.details === "Could not save the run record: Error: disk full")).toHaveLength(1);
  });
});
```

Run: `npx vitest run tests/unit/engine/runWorkflow.test.ts` → the 3 new tests FAIL (`saveRun` is never called).

- [ ] **Step 2: Types and inputs** — in `runWorkflow.ts`:

Import:
```ts
import {
  definitionHash, RUN_RECORD_VERSION, reusableNodes, savedNodeId, type RunRecord,
} from "@/engine/runRecord";
```

Add to `RunInput`:
```ts
  /** The workflow file the graph came from, for the run record (harness run: its path and SHA-256). */
  workflowFile?: { path: string | null; hash: string | null };
  /** A saved run to resume (harness run --resume): same run id; unchanged finished nodes are reused. */
  resume?: RunRecord;
```

Add to `RunHost`:
```ts
  /** Saves the run record (.harness/runs/<id>/run.json) after the start, after each node and at the end.
   *  A failure is reported once; the run goes on. */
  saveRun?: (record: RunRecord) => Promise<void>;
```

- [ ] **Step 3: The audit log** — replace `const addEntry = (entry: AuditEntry) => host.events.onAudit(entry);` with:

```ts
  // Every audit entry of the run, for its record; a resumed run continues the saved list.
  const auditLog: AuditEntry[] = [...(input.resume?.audit ?? [])];
  const addEntry = (entry: AuditEntry) => {
    auditLog.push(entry);
    host.events.onAudit(entry);
  };
```

- [ ] **Step 4: Hashes, run id, record and `save`**

After the AGENTS.md block (before `// ── Per-run runtime state`):

```ts
  // What shapes each node's work, for the record and for resume.
  const hashes = new Map<string, string>();
  for (const n of nodes) {
    const prompt = await resolvePromptContent(n.data.promptSource, workspacePath, readWorkspaceFile)
      .catch((e) => `unreadable: ${String(e)}`);
    hashes.set(n.id, definitionHash(n.data, prompt));
  }
```

Replace `const runId = \`run-${Date.now()}\`;` with:

```ts
  const runId = input.resume?.runId ?? `run-${Date.now()}`;
  const attempts = (input.resume?.attempts ?? 0) + 1;
```

After `for (const n of nodes) updateNodeData(n.id, { status: "idle" });`, add:

```ts
  const buildRecord = (): RunRecord => ({
    version: RUN_RECORD_VERSION,
    runId,
    workflow: { name: meta.name, path: input.workflowFile?.path ?? null, hash: input.workflowFile?.hash ?? null },
    task: config.userInput,
    provider: { llmProvider, ollamaBaseUrl, ollamaModel, customApiUrl, customApiModel },
    status: run.status,
    startedAt: input.resume?.startedAt ?? run.startedAt,
    finishedAt: run.finishedAt,
    attempts,
    nodes: Object.fromEntries(nodes.map((n, i) => {
      const agent = run.agents[n.id];
      return [savedNodeId(i), {
        agent: n.data.name, status: agent?.status ?? "idle", output: agent?.output, error: agent?.error,
        startedAt: agent?.startedAt, finishedAt: agent?.finishedAt, modelUsed: agent?.modelUsed,
        providerUsed: agent?.providerUsed, tokenEstimate: agent?.tokenEstimate, revision: agent?.revision,
        subAgents: agent?.subAgents, definitionHash: hashes.get(n.id) ?? "",
      }];
    })),
    outputs: Object.fromEntries(nodes.flatMap((n, i) => {
      const output = agentOutputs.get(n.id);
      return output === undefined ? [] : [[savedNodeId(i), output]];
    })),
    memory: memory.dump(),
    gatewayRoutes: Object.fromEntries(nodes.flatMap((n, i) => {
      const route = gatewayRoutes.get(n.id);
      return route === undefined ? [] : [[savedNodeId(i), route]];
    })),
    changes: run.changes ?? [],
    audit: [...auditLog],
  });
  // Saves go out one at a time, in order. A failure is reported once; the run goes on.
  let saving = Promise.resolve();
  let saveFailed = false;
  const save = (): Promise<void> => {
    const saveRun = host.saveRun;
    if (!saveRun) return saving;
    const record = buildRecord();
    saving = saving.then(() => saveRun(record)).catch((e) => {
      if (saveFailed) return;
      saveFailed = true;
      addEntry({ id: `run-record-${Date.now()}`, timestamp: new Date().toISOString(), action: "workflow_loaded",
        agentId: "system", success: false, details: `Could not save the run record: ${String(e)}` });
    });
    return saving;
  };
  await save();
```

- [ ] **Step 5: Save after each node and at the end**

Rename the revision-loop function: `async function runNode(nodeId: string): Promise<void> {` becomes `async function runWithRevisions(nodeId: string): Promise<void> {`. Then, just before `// ── Parallel execution`, add:

```ts
  async function runNode(nodeId: string): Promise<void> {
    try {
      await runWithRevisions(nodeId);
    } finally {
      await save(); // after every node settles, a failed one too
    }
  }
```

At the end, the final save goes in before `onRunFinished`:

```ts
// old
  run.finishedAt = Date.now();
  host.events.onRunFinished(status);
// new
  run.finishedAt = Date.now();
  await save();
  host.events.onRunFinished(status);
```

- [ ] **Step 6:** Run `npx vitest run tests/unit/engine tests/unit/hooks/useWorkflowExecution.test.ts && npx tsc --noEmit` → PASS (the hook tests unchanged: the app has no `saveRun` yet).

- [ ] **Step 7: Commit:** `git add src/engine/runWorkflow.ts tests/unit/engine/runWorkflow.test.ts && git commit -m "The engine saves the run record through the host after the start, each node and the end"`

---

### Task 4: The engine resumes a saved run

- [ ] **Step 1: Failing tests** — add to `runWorkflow.test.ts`:

```ts
describe("resuming a saved run", () => {
  const edges: Edge[] = [{ id: "a-b", source: "A", target: "B" }];
  const nodes = () => {
    const a = makeNode("A");
    a.data.memoryWrite = ["notes"];
    const b = makeNode("B");
    b.data.memoryRead = ["notes"];
    return [a, b];
  };

  /** A first run in which A answers "first-A" and B fails. */
  async function firstRun(): Promise<RunRecord> {
    let record: RunRecord | undefined;
    const { host } = fakeHost(
      { call_ollama_api: (args) => (who(args) === "B" ? Promise.reject(new Error("model crashed")) : "first-A") },
      { saveRun: async (r) => { record = JSON.parse(JSON.stringify(r)); } },
    );
    await runWorkflow(runInput(nodes(), edges), host);
    return record!;
  }

  function secondRun(graphNodes: AgentNode[], graphEdges: Edge[], record: RunRecord) {
    const calls: Array<{ agent: string; userMessage: string }> = [];
    let saved: RunRecord | undefined;
    const { host, log } = fakeHost(
      { call_ollama_api: (args) => { calls.push({ agent: who(args), userMessage: String(args.userMessage) }); return `second-${who(args)}`; } },
      { saveRun: async (r) => { saved = JSON.parse(JSON.stringify(r)); } },
    );
    return runWorkflow(runInput(graphNodes, graphEdges, { resume: record }), host)
      .then((outcome) => ({ outcome, calls, saved: saved!, log }));
  }

  it("reuses the nodes that finished unchanged, under the same run id, and runs the rest", async () => {
    const record = await firstRun();

    const { outcome, calls, saved, log } = await secondRun(nodes(), edges, record);

    if (!outcome.started) throw new Error(outcome.error);
    expect(calls.map((c) => c.agent)).toEqual(["B"]);
    expect(calls[0].userMessage).toContain("[From: A]\nfirst-A");
    expect(calls[0].userMessage).toContain("[memory:notes]\nfirst-A");
    expect(outcome.run.id).toBe(record.runId);
    expect(outcome.run.agents.A).toMatchObject({ status: "done", output: "first-A" });
    expect(saved).toMatchObject({ runId: record.runId, attempts: 2, status: "done" });
    expect(log.audit.map((e) => e.details)).toContain("↩ A: reused from the saved run (unchanged)");
  });

  it("re-runs a changed node and everything after it", async () => {
    const record = await firstRun();
    const changed = nodes();
    changed[0].data.promptSource = { type: "inline", content: "A new prompt." };

    const { calls } = await secondRun(changed, edges, record);

    expect(calls.map((c) => c.agent)).toEqual(["A", "B"]);
  });

  it("resumes a run saved from the app's canvas ids with the workflow file's ids", async () => {
    // The app names canvas nodes as it creates them; the saved file (and harness run) by position.
    let record: RunRecord | undefined;
    const canvas = nodes().map((n, i) => ({ ...n, id: `node-17-${i}` }));
    const { host } = fakeHost(
      { call_ollama_api: (args) => (who(args) === "B" ? Promise.reject(new Error("model crashed")) : "first-A") },
      { saveRun: async (r) => { record = JSON.parse(JSON.stringify(r)); } },
    );
    await runWorkflow(runInput(canvas, [{ id: "e", source: "node-17-0", target: "node-17-1" }]), host);

    const file = nodes().map((n, i) => ({ ...n, id: `agent-${i}` }));
    const { calls } = await secondRun(file, [{ id: "e", source: "agent-0", target: "agent-1" }], record!);

    expect(calls.map((c) => c.agent)).toEqual(["B"]);
  });
});
```

Run → the 3 new tests FAIL (A runs again).

- [ ] **Step 2: Restore the reused nodes** — in `runWorkflow.ts`, right after `for (const n of nodes) updateNodeData(n.id, { status: "idle" });` and before `buildRecord`:

```ts
  // Resume: nodes saved as done, unchanged and fed only by reused nodes keep their
  // saved results; the change log and the audit continue.
  const reused = input.resume ? reusableNodes(input.graph, input.resume, hashes) : new Set<string>();
  if (input.resume) {
    const saved = input.resume;
    run.changes = saved.changes;
    nodes.forEach((n, i) => {
      if (!reused.has(n.id)) return;
      agentOutputs.set(n.id, saved.outputs[savedNodeId(i)] ?? saved.nodes[savedNodeId(i)]?.output ?? "");
      for (const key of n.data.memoryWrite) {
        if (key in saved.memory) memory.write(key, saved.memory[key]);
      }
      const route = saved.gatewayRoutes[savedNodeId(i)];
      if (route) gatewayRoutes.set(n.id, route);
    });
  }
  // A reused node shows its saved result, as if it had just run.
  const showReused = (nodeId: string) => {
    const i = nodes.findIndex((n) => n.id === nodeId);
    const saved = input.resume?.nodes[savedNodeId(i)];
    if (!saved) return;
    addEntry({ id: `${nodeId}-reused-${Date.now()}`, timestamp: new Date().toISOString(), action: "workflow_loaded",
      agentId: nodeId, success: true, details: `↩ ${nodes[i].data.name}: reused from the saved run (unchanged)` });
    updateAgent(nodeId, {
      agentId: nodeId, agentName: nodes[i].data.name, status: "done", output: saved.output,
      startedAt: saved.startedAt, finishedAt: saved.finishedAt, modelUsed: saved.modelUsed,
      providerUsed: saved.providerUsed, tokenEstimate: saved.tokenEstimate, revision: saved.revision,
      subAgents: saved.subAgents,
    });
    updateNodeData(nodeId, { status: "done" });
  };
```

- [ ] **Step 3: Short-circuit in `runNode`**

```ts
// old
      await runWithRevisions(nodeId);
// new
      // A reused node neither runs nor reviews again; a revision round that
      // targets it still runs it (revisionPath calls processNode).
      if (reused.has(nodeId)) showReused(nodeId);
      else await runWithRevisions(nodeId);
```

- [ ] **Step 4:** Run `npx vitest run tests/unit/engine tests/unit/hooks/useWorkflowExecution.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit:** `git add src/engine/runWorkflow.ts tests/unit/engine/runWorkflow.test.ts && git commit -m "The engine resumes a saved run: unchanged finished nodes keep their results"`

---

### Task 5: The app saves its runs

**Files:** `src/hooks/useWorkflowExecution.ts`, `tests/unit/hooks/useWorkflowExecution.test.ts`, `.gitignore`

- [ ] **Step 1: Failing test** — add to the hook tests. Add the imports `import { invoke as tauriInvoke } from "@tauri-apps/api/core";` (the mock, through the test alias), `import { runWorkflow } from "@/engine/runWorkflow";`, `import { defToGraph } from "@/engine/workflowGraph";` and `import type { RunRecord } from "@/engine/runRecord";`.

```ts
  it("saves each run's record in the workspace, where harness run can resume it", async () => {
    // Canvas ids, not the file's agent-<i>: the record names nodes by their place in the file.
    const a = { ...makeNode("A"), id: "node-1" };
    const b = { ...makeNode("B"), id: "node-2" };
    useWorkflowStore.setState({ nodes: [a, b], edges: [{ id: "e", source: "node-1", target: "node-2" }] });
    const records: RunRecord[] = [];
    mockInvokeHandler("write_workspace_file", (args) => {
      const { relativePath, content } = args as { relativePath: string; content: string };
      if (relativePath.startsWith(".harness/runs/")) records.push(JSON.parse(content));
    });
    mockInvokeHandler("call_ollama_api", (args) =>
      (args as { system: string }).system.startsWith("You are B") ? Promise.reject(new Error("model crashed")) : "first");

    const finished = await run();

    const record = records.at(-1)!;
    expect(record).toMatchObject({
      runId: finished?.id, status: "error",
      nodes: { "agent-0": { agent: "A", status: "done" }, "agent-1": { agent: "B", status: "error" } },
    });

    // harness run resumes it with the saved file's graph: A is reused.
    const calls: string[] = [];
    mockInvokeHandler("call_ollama_api", (args) => {
      calls.push(/^You are (\w+),/.exec((args as { system: string }).system)![1]);
      return "second";
    });
    const outcome = await runWorkflow({
      graph: defToGraph(useWorkflowStore.getState().toWorkflowDef()),
      config: { userInput: "", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
      provider: {
        llmProvider: "ollama", apiKey: "", openaiApiKey: "", ollamaApiKey: "", ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "qwen2.5-coder:7b", customApiUrl: "", customApiKey: "", customApiModel: "",
      },
      workspacePath: "/ws", continueOnError: true, resume: record,
    }, {
      invoke: tauriInvoke, askCommand: async () => "deny", isCancelled: () => false, revealOutput: false,
      events: {
        onRunStarted: () => {}, onAgentUpdate: () => {}, onNodeStatus: () => {}, onAudit: () => {},
        onFileChange: () => {}, onRunFinished: () => {},
      },
    });
    expect(calls).toEqual(["B"]);
    expect(outcome.started && outcome.run.agents["agent-0"]).toMatchObject({ status: "done", output: "first" });
  });
```

And in `"does not execute a tool call that arrives after the run was stopped"`, the assertion ignores the run record:

```ts
// old
    expect(writes).toEqual([]);
// new
    // Only the run record is written; the agent's write never ran.
    expect(writes.filter((w) => !(w as { relativePath: string }).relativePath.startsWith(".harness/runs/"))).toEqual([]);
```

Run → the new test FAILS (no record written).

- [ ] **Step 2: `useWorkflowExecution.ts`**

Add `const filePath = useWorkflowStore((s) => s.filePath);` with the other selectors, and `import { writeRunRecord } from "@/engine/runRecord";`.

In the `runWorkflow({ … })` input, after `continueOnError,`:

```ts
        // The record names the workflow file relative to the workspace, as harness run does.
        workflowFile: {
          path: filePath && workspacePath && filePath.startsWith(`${workspacePath}/`)
            ? filePath.slice(workspacePath.length + 1) : filePath,
          hash: null,
        },
```

In `appHost()`'s returned object, after `snapshot`:

```ts
      // With a workspace open, every run is saved to .harness/runs/<id>/run.json.
      saveRun: workspacePath ? (record) => writeRunRecord(invoke, workspacePath, record) : undefined,
```

- [ ] **Step 3: `.gitignore`** — after `.harness/snapshots/` add `.harness/runs/`, and after `**/.harness/snapshots/` add `**/.harness/runs/`.

- [ ] **Step 4:** Run `npx vitest run tests/unit/hooks tests/unit/engine && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit:** `git add src/hooks/useWorkflowExecution.ts tests/unit/hooks/useWorkflowExecution.test.ts .gitignore && git commit -m "The app saves each run's record when a workspace is open"`

---

### Task 6: `harness run --resume`

**Files:** `src/cli/runArgs.ts`, `src/cli/runCli.ts`, `src/cli/report.ts`, `tests/node-shims.d.ts`; tests `runArgs`, `report`, `harnessRun`

- [ ] **Step 1: Failing tests**

`runArgs.test.ts`, in `describe("parseRunArgs")`:

```ts
  it("takes --resume, which makes the task optional", () => {
    expect(ok(["wf.yaml", "--resume", "run-17"])).toEqual({
      workflow: "wf.yaml", resume: "run-17", provider: "auto", continueOnError: false, json: false, allowCommands: [],
    });
  });
```

`report.test.ts`:

```ts
  it("shows reused agents once, and names the saved record", () => {
    const { reporter, out } = capture(false);
    reporter.events.onAudit(audit("Coder", "workflow_loaded", "↩ Coder: reused from the saved run (unchanged)"));
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "done", output: "patched",
      startedAt: 0, finishedAt: 5000 });
    reporter.summary({ started: true, run: { ...run, changes: [] } }, 1000, ".harness/runs/run-1/run.json");

    expect(out[0]).toBe("↩ Coder: reused from the saved run (unchanged)");
    expect(out).not.toContain("✓ Coder done (5.0 s)");
    expect(out).toContain("Saved: .harness/runs/run-1/run.json");
  });

  it("marks reused agents and the record in --json events", () => {
    const { reporter, out } = capture(true);
    reporter.events.onAudit(audit("Coder", "workflow_loaded", "↩ Coder: reused from the saved run (unchanged)"));
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "done", output: "patched" });
    reporter.summary({ started: true, run }, 1000, ".harness/runs/run-1/run.json");

    const events = out.map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "reused", nodeId: "Coder" });
    expect(events[1]).toMatchObject({ type: "node_finished", nodeId: "Coder", reused: true });
    expect(events[2]).toMatchObject({ type: "run_finished", trace: ".harness/runs/run-1/run.json" });
  });
```

`harnessRun.test.ts`:

```ts
  const lastEvent = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, string>;
  const callsOf = (agent: string, requests: Array<{ cmd: string; args: Record<string, unknown> }>) =>
    requests.filter((r) => r.cmd === "call_ollama_api" && String(r.args.system).startsWith(`You are ${agent},`));

  it("saves each run, and --resume reuses the agents that finished unchanged", () => {
    const dir = workspace({ Coder: ["wrote the fix"], Reviewer: ["ERROR: model crashed"] });
    const first = harnessRun(dir, ["--task", "Fix the bug", "--json"]);
    expect(first.status).toBe(1);
    const { runId, trace } = lastEvent(first.stdout);
    expect(trace).toBe(`.harness/runs/${runId}/run.json`);

    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ replies: { Coder: ["another fix"], Reviewer: ["Looks good."] } }));
    const second = harnessRun(dir, ["--resume", runId]);

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("↩ Coder: reused from the saved run (unchanged)");
    expect(callsOf("Coder", second.requests)).toHaveLength(callsOf("Coder", first.requests).length);
    expect(callsOf("Reviewer", second.requests).at(-1)?.args.userMessage).toContain("[From: Coder]\nwrote the fix");
    expect(JSON.parse(readFileSync(join(dir, trace), "utf8"))).toMatchObject({ runId, attempts: 2, status: "done" });
  });

  it("exits 2 when the run to resume is missing, of another workflow, or given another task", () => {
    const dir = workspace({ Coder: ["x"], Reviewer: ["y"] });
    expect(harnessRun(dir, ["--resume", "run-404"]).status).toBe(2);
    const { runId } = lastEvent(harnessRun(dir, ["--task", "t", "--json"]).stdout);

    expect(harnessRun(dir, ["--resume", runId, "--task", "another task"]).status).toBe(2);
    const yaml = readFileSync(join(dir, "review.harness.yaml"), "utf8");
    writeFileSync(join(dir, "review.harness.yaml"), yaml.replace("name: Code Review", "name: Other Workflow"));
    expect(harnessRun(dir, ["--resume", runId]).status).toBe(2);
  });
```

Run → the new tests FAIL.

- [ ] **Step 2: Node typings** — in `tests/node-shims.d.ts`, add `export function relative(from: string, to: string): string;` to `node:path`, and:

```ts
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}
```

- [ ] **Step 3: `runArgs.ts`**
- Add `resume?: string;` to `RunArgs`, with the doc comment `/** A saved run to resume (its run id). */`.
- Add `"--resume"` to `TAKES_VALUE`, and `case "--resume": args.resume = value; break;`.
- Replace the task check:

```ts
  if (args.task !== undefined && args.taskFile !== undefined) {
    return { error: "Give the task with --task or --task-file (one of them)." };
  }
  if (args.task === undefined && args.taskFile === undefined && args.resume === undefined) {
    return { error: "Give the task with --task or --task-file (one of them)." };
  }
```

In `RUN_USAGE`, after the `--task` line:

```
  --resume <runId>           Resume a saved run (.harness/runs/<runId>): finished, unchanged agents are reused
```

- [ ] **Step 4: `report.ts`**
- `summary` becomes `(outcome: RunOutcome, elapsedMs: number, trace?: string) => void`, in the interface and in the implementation.
- Add `const reusedIds = new Set<string>();`.
- In `onAudit`, the type becomes `details.startsWith("↩") ? "reused" : …`, checked before the others, and `if (type === "reused" && entry.agentId) reusedIds.add(entry.agentId);`. Human mode prints every type except `"audit"`, as now.
- In `onAgentUpdate`'s ended branch:
  - JSON: `emit({ type: "node_finished", …, reused: reusedIds.has(nodeId) || undefined })`;
  - human: `else if (!reusedIds.has(nodeId)) out(endLine(agent, durationMs));`.
- JSON `run_finished` gains `trace`.
- Human summary: after the changed files, `if (trace) out(\`Saved: ${trace}\`);`.

- [ ] **Step 5: `runCli.ts`**

New imports: `import { createHash } from "node:crypto";`, `join` and `relative` from `node:path`, and `import { RUN_RECORD_VERSION, runRecordPath, writeRunRecord, type RunRecord } from "@/engine/runRecord";`.

`loadWorkflow` also returns the file's text: `{ def: WorkflowDef; text: string }`, where `text` is what was read.

Add:

```ts
/** The saved run to resume, from the workspace's .harness/runs; or what is wrong. */
function loadRunRecord(workspacePath: string, runId: string): { record: RunRecord } | { error: string } {
  if (!/^[\w.-]+$/.test(runId)) return { error: `${runId} is not a run id` };
  const file = join(workspacePath, runRecordPath(runId));
  if (!existsSync(file)) return { error: `no saved run ${runId} in ${join(workspacePath, ".harness", "runs")}` };
  let record: RunRecord;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  } catch (e) {
    return { error: `cannot read ${file}: ${String(e)}` };
  }
  if (record.version !== RUN_RECORD_VERSION) return { error: `${file} has an unknown record version` };
  return { record };
}
```

In `runHarness`, after the workspace check (which now comes before reading the task):

```ts
  let resume: RunRecord | undefined;
  if (args.resume) {
    const found = loadRunRecord(workspacePath, args.resume);
    if ("error" in found) {
      err(`harness run: ${found.error}`);
      return EXIT.usage;
    }
    resume = found.record;
    if (resume.workflow.name !== loaded.def.meta.name) {
      err(`harness run: run ${args.resume} is of the workflow "${resume.workflow.name}", not "${loaded.def.meta.name}"`);
      return EXIT.usage;
    }
  }
  let task: string;
  try {
    task = args.task ?? (args.taskFile !== undefined ? readFileSync(args.taskFile, "utf8") : resume?.task ?? "");
  } catch (e) {
    err(`harness run: cannot read the task file: ${String(e)}`);
    return EXIT.usage;
  }
  if (resume && task !== resume.task) {
    err("harness run: a resumed run keeps its saved task; leave out --task and --task-file");
    return EXIT.usage;
  }
```

The host gains saving:

```ts
  let saved = false;
  …
    saveRun: async (record) => {
      await writeRunRecord(core.invoke, workspacePath, record);
      saved = true;
    },
```

The input gains:

```ts
      workflowFile: {
        path: relative(workspacePath, resolve(args.workflow)).split("\\").join("/"),
        hash: createHash("sha256").update(loaded.text).digest("hex"),
      },
      resume,
```

After the run:

```ts
    const trace = outcome.started && saved ? runRecordPath(outcome.run.id) : undefined;
    reporter.summary(outcome, Date.now() - started, trace);
    if (!args.json && trace && outcome.started && outcome.run.status !== "done") {
      out(`Resume: harness run ${args.workflow} --resume ${outcome.run.id}`);
    }
```

- [ ] **Step 6:** Run `npx vitest run tests/unit/cli && npx tsc --noEmit` → PASS.

- [ ] **Step 7: Commit:** `git add src/cli tests/unit/cli tests/node-shims.d.ts && git commit -m "harness run --resume: reuse a saved run's finished, unchanged agents"`

---

### Task 7: Full verification

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run 2>&1 | tail -4`. Expected: all tests pass.
- [ ] **Step 2:** `cd src-tauri && cargo test 2>&1 | grep "test result: ok. 95" && cargo test --no-default-features --features core 2>&1 | grep "^test result"`. Expected: 95 app-build tests, and in the core build the library's 95 plus `core_bin`'s tests.
- [ ] **Step 3:** `npm run build && npm run build:core && npm run build:cli`. Expected: all three succeed.

---

## Spec coverage (Part 4)

| Spec §4 requirement | Where |
|---|---|
| record at `.harness/runs/<runId>/run.json`, atomic, at start / after each node / at end | Tasks 2–3 (`writeRunRecord`, `save`) |
| run fields (version, runId, workflow name/path/hash, task, provider without keys, status, times, attempts) | `RunRecord`, `buildRecord`; the keys test |
| per-node fields incl. `definitionHash` | `NodeRecord`, `definitionHash` |
| resume state: memory, gateway routes, changes, audit (+ outputs) | `buildRecord`; restored in Task 4 |
| the CLI saves; the app saves with a workspace open; `.gitignore` | Tasks 5–6 |
| `--resume`: same id, attempts + 1, saved task, another task → 2 | Task 6 |
| reuse rule (done, same hash, forward predecessors reused) | `reusableNodes` + tests |
| reused nodes keep outputs, revision, helpers; scheduler treats them as finished | `showReused`, `runNode` |
| unknown run id or another workflow → 2 | Task 6 end-to-end |
| failing save reported once, run continues | Task 3 test |
| tests: record after each node; reuse rule cases; app run resumed by the CLI | Tasks 2–5 |
