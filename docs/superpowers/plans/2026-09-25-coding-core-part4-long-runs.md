# Coding Core, Part 4: Compaction and AGENTS.md — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long agent runs stay within the node's Token budget, because older steps are summarized. Agents that work in the workspace follow its `AGENTS.md`.

**Architecture:**
- **Compaction:** `compaction.ts` is pure; the summarizer call is injected. `agentLoop` calls it before each model call in native and text mode when the conversation passes 75% of `compaction.budget`. The hook passes the node's Token budget and a no-tools summary call, and audits each compaction.
- **AGENTS.md:** `projectInstructions.ts` loads the file, capped at 32 KB, and decides who gets it. `buildSystemMessage` appends it, and the hook and the sub-agent runner pass it.

**Tech Stack:** TypeScript, Vitest.

Spec: `docs/superpowers/specs/2026-09-25-coding-core-design.md` §4.

## File map

| File | Change |
|---|---|
| `src/services/execution/compaction.ts` (new) | `needsCompaction`, `historyTokens`, `textTokens`, `truncateMiddle`, `compactNative`, `compactText`, `SUMMARY_INSTRUCTIONS` |
| `src/services/execution/agentLoop.ts` | `compaction` option; compaction before each model call |
| `src/services/execution/projectInstructions.ts` (new) | `loadProjectInstructions`, `usesWorkspace` |
| `src/services/model-providers/providerAdapter.ts` | `SystemMessageParams.projectInstructions` |
| `src/services/execution/subAgents.ts` | `projectInstructions` option for helpers |
| `src/hooks/useWorkflowExecution.ts` | Loads AGENTS.md at run start; passes the budget, summary call and instructions |

---

### Task 1: `compaction.ts`

**Files:** Create `src/services/execution/compaction.ts`. Test: `tests/unit/services/execution/compaction.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  compactNative, compactText, needsCompaction, truncateMiddle,
} from "@/services/execution/compaction";
import type { ChatMessage } from "@/services/model-providers/providerAdapter";

const call = (id: string) => ({ id, name: "read_file", args: { path: `${id}.md` } });
const result = (id: string, content: string) => ({ id, name: "read_file", content, isError: false });

/** user task, then `turns` tool exchanges. */
function history(turns: number, content = "file text"): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", text: "Fix the bug." }];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: "assistant", text: `step ${i}`, toolCalls: [call(`c${i}`)] });
    messages.push({ role: "tool", toolResults: [result(`c${i}`, `${content} ${i}`)] });
  }
  return messages;
}

describe("needsCompaction", () => {
  it("starts past 75% of the budget, and never without one", () => {
    expect(needsCompaction(7500, 10000)).toBe(false);
    expect(needsCompaction(7501, 10000)).toBe(true);
    expect(needsCompaction(99999, 0)).toBe(false);
  });
});

describe("truncateMiddle", () => {
  it("keeps the start and the end", () => {
    const cut = truncateMiddle(`${"a".repeat(500)}${"b".repeat(500)}`, 200);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("bbb")).toBe(true);
    expect(cut).toMatch(/characters cut/);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(truncateMiddle("short", 200)).toBe("short");
  });
});

describe("compactNative", () => {
  it("replaces the older steps with a note and keeps the newest exchange verbatim", async () => {
    const summarize = vi.fn(async () => "Read c1 and c2; the bug is in c2.");
    const messages = history(3);

    const { messages: compacted, steps } = await compactNative(messages, 100_000, summarize);

    expect(steps).toBe(2);
    expect(compacted).toHaveLength(3);
    expect(compacted[0]).toEqual({
      role: "user",
      text: "Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nRead c1 and c2; the bug is in c2.",
    });
    expect(compacted.slice(1)).toEqual(messages.slice(-2));
    const input = summarize.mock.calls[0][0] as string;
    expect(input).toContain("Fix the bug.");
    expect(input).toContain("CALLED read_file");
    expect(input).toContain("file text 2");
    expect(input).not.toContain("file text 3");
  });

  it("replaces an earlier note instead of stacking notes", async () => {
    const first = await compactNative(history(3), 100_000, async () => "note one");
    const again = [...first.messages, ...history(2).slice(1)];

    const { messages } = await compactNative(again, 100_000, async () => "note two");

    expect((messages[0] as { text: string }).text).toBe(
      "Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nnote two");
  });

  it("leaves a conversation with one exchange as it is", async () => {
    const summarize = vi.fn(async () => "x");
    const messages = history(1);
    expect(await compactNative(messages, 100, summarize)).toEqual({ messages, steps: 0 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("cuts kept tool results that alone are too big", async () => {
    const { messages } = await compactNative(history(2, "x".repeat(50_000)), 1000, async () => "note");
    const kept = messages[2] as { role: "tool"; toolResults: Array<{ content: string }> };
    expect(kept.toolResults[0].content.length).toBeLessThan(2000);
    expect(kept.toolResults[0].content).toMatch(/characters cut/);
  });
});

describe("compactText", () => {
  it("keeps the task, a new note and the newest step", async () => {
    const summarize = vi.fn(async () => "note");
    const text = await compactText("Fix the bug.", "Fix the bug.\n\n[Step 1…]\n\n[Step 2…]", "[Step 2…]", summarize);
    expect(text).toBe("Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nnote\n\n[Step 2…]");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/compaction.test.ts`
Expected: FAIL, the import cannot be resolved

- [ ] **Step 3: Implement**

```ts
/**
 * compaction — keeps a long agent conversation within the node's Token budget.
 * Once it passes 75% of the budget, the older steps are replaced by a progress
 * note the model writes. The newest tool exchange stays verbatim, so every tool
 * call still has its results: a history every provider accepts.
 */
import type { ChatMessage } from "@/services/model-providers/providerAdapter";

const COMPACT_AT = 0.75;
const NOTE_MARKER = "\n\nPROGRESS SO FAR (summary of earlier steps):\n";
const RESULT_CHARS_FOR_SUMMARY = 4000;

export const SUMMARY_INSTRUCTIONS =
  "Summarize the work so far for the agent that will continue it: the task, what was found, " +
  "files read or changed, commands run and their results, and what remains. Be specific " +
  "(paths, names, errors, numbers). Reply with the summary only.";

/** Estimated tokens: characters ÷ 4, like estimateTokens. */
export function textTokens(...parts: string[]): number {
  return Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 4);
}

export function historyTokens(system: string, messages: ChatMessage[]): number {
  return textTokens(system, JSON.stringify(messages));
}

export function needsCompaction(tokens: number, budget: number): boolean {
  return budget > 0 && tokens > budget * COMPACT_AT;
}

/** Keep the start and the end of a long text, at most `max` characters. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 60);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}\n[… ${text.length - keep} characters cut …]\n${text.slice(text.length - (keep - head))}`;
}

/** The summarizer sees at most about the budget's worth of text. */
function summaryInput(text: string, budget: number): string {
  return truncateMiddle(text, Math.max(8000, budget * 4));
}

function render(messages: ChatMessage[]): string {
  return messages.map((m) => {
    if (m.role === "user") return `USER:\n${m.text}`;
    if (m.role === "assistant") {
      const calls = m.toolCalls.map((c) => `CALLED ${c.name}(${JSON.stringify(c.args)})`);
      return [`ASSISTANT:${m.text ? `\n${m.text}` : ""}`, ...calls].join("\n");
    }
    return m.toolResults
      .map((r) => `RESULT of ${r.name}${r.isError ? " (error)" : ""}:\n${truncateMiddle(r.content, RESULT_CHARS_FOR_SUMMARY)}`)
      .join("\n");
  }).join("\n\n");
}

/** Cut the kept tool results in the middle when they alone are too big. */
function fit(kept: ChatMessage[], budget: number): ChatMessage[] {
  const chars = Math.floor(budget * 4 * COMPACT_AT / 2); // room for the task, the note and the reply
  return kept.map((m) => m.role !== "tool" ? m : {
    ...m,
    toolResults: m.toolResults.map((r) => ({
      ...r, content: truncateMiddle(r.content, Math.floor(chars / m.toolResults.length)),
    })),
  });
}

/**
 * Replace the older steps of a native conversation with a progress note: the
 * first user message (task + note), then the newest assistant turn and its tool
 * results. Returns the steps folded into the note (0: nothing to compact).
 */
export async function compactNative(
  messages: ChatMessage[], budget: number, summarize: (text: string) => Promise<string>,
): Promise<{ messages: ChatMessage[]; steps: number }> {
  const first = messages[0];
  const older = messages.slice(1, -2);
  if (first?.role !== "user" || older.length === 0) return { messages, steps: 0 };
  const task = first.text.split(NOTE_MARKER)[0];
  const note = await summarize(summaryInput(`TASK:\n${first.text}\n\nSTEPS SO FAR:\n${render(older)}`, budget));
  return {
    messages: [{ role: "user", text: `${task}${NOTE_MARKER}${note.trim()}` }, ...fit(messages.slice(-2), budget)],
    steps: older.filter((m) => m.role === "assistant").length,
  };
}

/** The text-protocol conversation after compaction: the task, a new note, the newest step. */
export async function compactText(
  task: string, conversation: string, lastStep: string, summarize: (text: string) => Promise<string>,
  budget = 0,
): Promise<string> {
  const note = await summarize(summaryInput(`TASK AND STEPS SO FAR:\n${conversation}`, budget));
  return `${task}${NOTE_MARKER}${note.trim()}\n\n${lastStep}`;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/compaction.test.ts`
Expected: PASS, 8 tests

---

### Task 2: Compaction in `agentLoop`

**Files:** Modify `src/services/execution/agentLoop.ts`. Test: `tests/unit/services/execution/agentLoop.test.ts`.

- [ ] **Step 1: Write the failing tests.** Append:

```ts
describe("runAgentLoop — compaction", () => {
  const big = "x".repeat(4000);

  it("summarizes older steps once the conversation passes the budget, then carries on", async () => {
    let turn = 0;
    const callTurn = vi.fn(async () => (++turn < 4
      ? reply({ toolCalls: [{ id: `c${turn}`, name: "read_file", args: { path: `${turn}.md` } }] })
      : reply({ text: "done" })));
    const summarize = vi.fn(async () => "note");
    const onCompacted = vi.fn();

    const result = await runAgentLoop(options({
      callTurn, runTool: vi.fn(async () => big),
      compaction: { budget: 3000, summarize, onCompacted },
    }));

    expect(result.text).toBe("done");
    expect(summarize).toHaveBeenCalled();
    expect(onCompacted).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.any(Number));
    const lastMessages = callTurn.mock.calls.at(-1)![1] as Array<{ role: string; text?: string }>;
    expect(lastMessages).toHaveLength(3);
    expect(lastMessages[0].text).toContain("PROGRESS SO FAR");
  });

  it("carries on uncompacted when the summary call fails", async () => {
    let turn = 0;
    const callTurn = vi.fn(async () => (++turn < 3
      ? reply({ toolCalls: [{ id: `c${turn}`, name: "read_file", args: { path: "a.md" } }] })
      : reply({ text: "done" })));
    const onFailed = vi.fn();

    const result = await runAgentLoop(options({
      callTurn, runTool: vi.fn(async () => big),
      compaction: { budget: 1000, summarize: vi.fn(async () => { throw new Error("busy"); }), onFailed },
    }));

    expect(result.text).toBe("done");
    expect(onFailed).toHaveBeenCalled();
  });

  it("compacts the text protocol too", async () => {
    let step = 0;
    const callText = vi.fn(async () => (++step < 4
      ? `<tool_call>{"name":"read_file","args":{"path":"${step}.md"}}</tool_call>`
      : "done"));
    const summarize = vi.fn(async () => "note");

    const result = await runAgentLoop(options({
      preferText: true, callText, runTool: vi.fn(async () => big),
      compaction: { budget: 3000, summarize },
    }));

    expect(result.text).toBe("done");
    expect(summarize).toHaveBeenCalled();
    expect(callText.mock.calls.at(-1)![1]).toContain("PROGRESS SO FAR");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/services/execution/agentLoop.test.ts -t compaction`
Expected: FAIL. `summarize` is never called.

- [ ] **Step 3: Implement.** Import from compaction:

```ts
import { compactNative, compactText, historyTokens, needsCompaction, textTokens } from "@/services/execution/compaction";
```

Add to `AgentLoopOptions`:

```ts
  /** Summarize older steps once the conversation passes 75% of `budget` tokens. */
  compaction?: {
    budget: number;
    summarize: (text: string) => Promise<string>;
    onCompacted?: (steps: number, beforeTokens: number, afterTokens: number) => void;
    onFailed?: (error: unknown) => void;
  };
```

Helpers after `guarded`:

```ts
/** A failed summary leaves the conversation as it is (the next call tries again),
 *  unless the run was stopped or the node ran out of time. */
function compactionFailed(opts: AgentLoopOptions, error: unknown): void {
  if (opts.isCancelled() || Date.now() >= opts.deadline()) throw error;
  opts.compaction?.onFailed?.(error);
}

async function compactNativeIfNeeded(opts: AgentLoopOptions, messages: ChatMessage[]): Promise<void> {
  const c = opts.compaction;
  if (!c) return;
  const before = historyTokens(opts.system, messages);
  if (!needsCompaction(before, c.budget)) return;
  try {
    const result = await compactNative(messages, c.budget, (text) => guarded(opts, c.summarize(text)));
    if (result.steps === 0) return;
    messages.splice(0, messages.length, ...result.messages);
    c.onCompacted?.(result.steps, before, historyTokens(opts.system, messages));
  } catch (e) {
    compactionFailed(opts, e);
  }
}

async function compactTextIfNeeded(
  opts: AgentLoopOptions, system: string, message: string, lastStep: string, steps: number,
): Promise<string> {
  const c = opts.compaction;
  if (!c || !lastStep || steps < 2) return message;
  const before = textTokens(system, message);
  if (!needsCompaction(before, c.budget)) return message;
  try {
    const compacted = await compactText(opts.userMessage, message, lastStep,
      (text) => guarded(opts, c.summarize(text)), c.budget);
    c.onCompacted?.(steps - 1, before, textTokens(system, compacted));
    return compacted;
  } catch (e) {
    compactionFailed(opts, e);
    return message;
  }
}
```

In `runNative`, right after `checkpoint(opts);` in the loop: `await compactNativeIfNeeded(opts, messages);`.

In `runText`:
  - Declare `let lastStep = "";` next to `let message`.
  - Right after `checkpoint(opts);` in the loop: `message = await compactTextIfNeeded(opts, system, message, lastStep, toolCalls);`.
  - Replace the `message = …` step append with:

```ts
    lastStep =
      `[Step ${toolCalls}: called ${call.name}]\n` +
      (before ? `${before}\n` : "") +
      `<tool_result>${result}</tool_result>\n\n` +
      `Now continue your task based on the tool result above.`;
    message = `${message}\n\n${lastStep}`;
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/services/execution/agentLoop.test.ts`
Expected: PASS (all agent loop tests)

---

### Task 3: `projectInstructions.ts` and the system message

**Files:**
- Create `src/services/execution/projectInstructions.ts`.
- Modify `src/services/model-providers/providerAdapter.ts`.
- Tests: `tests/unit/services/execution/projectInstructions.test.ts`; `tests/unit/services/providerAdapter.test.ts` (add a case).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";

describe("loadProjectInstructions", () => {
  it("reads AGENTS.md from the workspace root", async () => {
    const read = async (path: string) => { expect(path).toBe("AGENTS.md"); return "Use pnpm."; };
    expect(await loadProjectInstructions(read)).toBe("Use pnpm.");
  });

  it("is empty when there is no AGENTS.md", async () => {
    expect(await loadProjectInstructions(async () => { throw new Error("(os error 2)"); })).toBe("");
  });

  it("caps a long file at 32 KB", async () => {
    const text = await loadProjectInstructions(async () => "x".repeat(40_000));
    expect(text.length).toBeLessThan(33_000);
    expect(text).toMatch(/truncated at 32 KB/);
  });
});

describe("usesWorkspace", () => {
  it("is true for agents with a workspace tool", () => {
    expect(usesWorkspace(["read_file"])).toBe(true);
    expect(usesWorkspace(["bash"])).toBe(true);
    expect(usesWorkspace(["web_search", "subagent_dispatch"])).toBe(false);
    expect(usesWorkspace([])).toBe(false);
  });
});
```

Add to `describe("buildSystemMessage")` in `providerAdapter.test.ts`:

```ts
  it("adds the project's instructions when given", () => {
    const msg = buildSystemMessage({
      agentName: "A", role: "worker", workflowName: "W", tools: [], memoryRead: [], memoryWrite: [],
      promptContent: "Do it.", projectInstructions: "Use pnpm.",
    });
    expect(msg.endsWith("\n\nPROJECT INSTRUCTIONS (AGENTS.md):\nUse pnpm.")).toBe(true);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/services/execution/projectInstructions.test.ts tests/unit/services/providerAdapter.test.ts`
Expected: FAIL (the module is missing; there is no instructions section)

- [ ] **Step 3: Implement**

```ts
/**
 * projectInstructions — the workspace's AGENTS.md (the instructions file Codex
 * and other coding agents read), for agents that work in the workspace.
 */
import { runnableTools } from "@/services/execution/toolExecutor";

const MAX_CHARS = 32 * 1024;
const WORKSPACE_TOOLS = new Set([
  "read_file", "fs.read", "list_files", "grep", "fs.write", "fs.append", "edit_file", "bash",
]);

/** AGENTS.md from the workspace root, capped at 32 KB; "" when there is none. */
export async function loadProjectInstructions(read: (path: string) => Promise<string>): Promise<string> {
  let text: string;
  try {
    text = await read("AGENTS.md");
  } catch {
    return "";
  }
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[AGENTS.md truncated at 32 KB]` : text;
}

/** Only agents that work in the workspace get the project's instructions. */
export function usesWorkspace(tools: string[]): boolean {
  return runnableTools(tools).some((t) => WORKSPACE_TOOLS.has(t));
}
```

In `providerAdapter.ts`, add to `SystemMessageParams`:

```ts
  /** The workspace's AGENTS.md, for agents that work in the workspace. */
  projectInstructions?: string;
```

and, as the last element of the array in `buildSystemMessage`:

```ts
    p.projectInstructions ? `\n\nPROJECT INSTRUCTIONS (AGENTS.md):\n${p.projectInstructions}` : "",
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/services/execution/projectInstructions.test.ts tests/unit/services/providerAdapter.test.ts`
Expected: PASS

---

### Task 4: Helpers get the instructions

**Files:** Modify `src/services/execution/subAgents.ts`. Test: `tests/unit/services/execution/subAgents.test.ts`.

- [ ] **Step 1: Write the failing test.** Append inside the main `describe`:

```ts
  it("gives helpers with workspace tools the project's instructions", async () => {
    const loop = vi.fn(async (): Promise<AgentLoopResult> => ({
      text: "ok", toolCalls: 0, mode: "native", nativeRefused: false, tokenEstimate: 1,
    }));
    const subAgents = createSubAgentRunner({
      parentName: "Lead", workflowName: "W", parentTools: ["read_file", "web_search"],
      runLoop: loop, projectInstructions: "Use pnpm.",
    });

    await subAgents.dispatch({ task: "t", tools: ["read_file"] });
    await subAgents.dispatch({ task: "t", tools: [] });

    expect(loop.mock.calls[0][0].system).toContain("PROJECT INSTRUCTIONS (AGENTS.md):\nUse pnpm.");
    expect(loop.mock.calls[1][0].system).not.toContain("PROJECT INSTRUCTIONS");
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/subAgents.test.ts`
Expected: FAIL. The instructions are not in the helper's system message.

- [ ] **Step 3: Implement.**
  - Import `import { usesWorkspace } from "@/services/execution/projectInstructions";`.
  - Add to `SubAgentRunnerOptions`: `/** The workspace's AGENTS.md, for helpers that work in the workspace. */ projectInstructions?: string;`.
  - In `dispatch`'s `buildSystemMessage({...})`, add: `projectInstructions: usesWorkspace(tools) ? opts.projectInstructions : undefined,`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/subAgents.test.ts`
Expected: PASS

---

### Task 5: Wiring in the run

**Files:** Modify `src/hooks/useWorkflowExecution.ts`. Test: `tests/unit/hooks/useWorkflowExecution.test.ts`.

- [ ] **Step 1: Write the failing tests.** Add to the top-level `describe`:

```ts
  it("gives agents that work in the workspace the project's AGENTS.md", async () => {
    const coder = makeNode("A");
    coder.data.tools = [ToolPermission.ReadFile];
    const writer = makeNode("B");
    useWorkflowStore.setState({ nodes: [coder, writer], edges: [] });
    mockInvokeHandler("read_workspace_file", (args) => {
      if ((args as { relativePath: string }).relativePath === "AGENTS.md") return "Use pnpm, never npm.";
      throw new Error("not found (os error 2)");
    });
    const systems: Record<string, string> = {};
    mockInvokeHandler("call_ollama_api", (args) => {
      const a = args as { system: string };
      systems[/^You are (\w+),/.exec(a.system)![1]] = a.system;
      return "done";
    });

    await run();

    expect(systems.A).toContain("PROJECT INSTRUCTIONS (AGENTS.md):\nUse pnpm, never npm.");
    expect(systems.B).not.toContain("PROJECT INSTRUCTIONS");
    expect(useAuditStore.getState().entries.some((e) => /AGENTS\.md/.test(e.details ?? ""))).toBe(true);
  });

  it("compacts a long conversation within the node's token budget and audits it", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 5;
    node.data.tokens = { used: 0, budget: 3000 };
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("read_workspace_file", () => "x".repeat(4000));
    let turns = 0;
    mockInvokeHandler("chat_turn", () => (++turns < 4
      ? { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
          toolCalls: [{ id: `c${turns}`, name: "read_file", args: { path: `${turns}.md` } }] }
      : { text: "done", toolCalls: [], finishReason: "stop", nativeToolsSupported: true }));
    mockInvokeHandler("call_ollama_api", () => "progress note");

    const finished = await run();

    expect(finished?.agents.A).toMatchObject({ status: "done", output: "done" });
    expect(useAuditStore.getState().entries.some((e) => /compacted \d+ earlier step/.test(e.details ?? ""))).toBe(true);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts -t "AGENTS|compacts"`
Expected: FAIL

- [ ] **Step 3: Implement.**
  - Imports: `import { SUMMARY_INSTRUCTIONS } from "@/services/execution/compaction";` and `import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";`.
  - After the context-files block:

```ts
    // ── Project instructions (AGENTS.md at the workspace root) ─────────────────
    const projectInstructions = workspacePath
      ? await loadProjectInstructions((path) => readWorkspaceFile(workspacePath, path))
      : "";
    if (projectInstructions) {
      addEntry({ id: `agents-md-${Date.now()}`, timestamp: new Date().toISOString(), action: "file_read",
        path: "AGENTS.md", success: true,
        details: `Project instructions: AGENTS.md (${projectInstructions.length.toLocaleString()} chars)` });
    }
```

  - In the node's `buildSystemMessage({...})`, add `projectInstructions: usesWorkspace(data.tools as string[]) ? projectInstructions : undefined,`.
  - In `createSubAgentRunner({...})`, add `projectInstructions,`.
  - In the node's `runAgentLoop({...})`, add:

```ts
          // Past 75% of the node's Token budget, older steps become a progress note.
          compaction: (data.tokens?.budget ?? 0) > 0 ? {
            budget: data.tokens.budget,
            summarize: (text) => shared.callText(SUMMARY_INSTRUCTIONS, text),
            onCompacted: (steps, before, after) => addEntry({
              id: `${nodeId}-compact-${Date.now()}`, timestamp: new Date().toISOString(),
              action: "workflow_loaded", agentId: nodeId, success: true,
              details: `↻ ${data.name}: compacted ${steps} earlier step${steps === 1 ? "" : "s"} ` +
                `(~${before.toLocaleString()} → ~${after.toLocaleString()} tokens)`,
            }),
            onFailed: (e) => addEntry({
              id: `${nodeId}-compact-fail-${Date.now()}`, timestamp: new Date().toISOString(),
              action: "workflow_loaded", agentId: nodeId, success: false,
              details: `↻ ${data.name}: could not compact the conversation: ${String(e)}`,
            }),
          } : undefined,
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts`
Expected: PASS

---

**Found during execution:**
- Mock handlers persist across tests. A timeout test's slow `read_workspace_file` (120 ms) leaked into the next test. The AGENTS.md read at run start then delayed the run past that test's 50 ms Stop.
- Fix, in the hook tests' `beforeEach`: a default `read_workspace_file` that reports "not found". The app code was fine.

---

### Task 6: Verify and commit Part 4

- [ ] Run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run build`; all must pass.
- [ ] Commit: `git commit -m "Summarize long agent conversations within the token budget, and follow AGENTS.md"`
