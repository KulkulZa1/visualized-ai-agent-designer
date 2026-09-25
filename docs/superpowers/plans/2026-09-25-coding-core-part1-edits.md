# Coding Core, Part 1: Edits, Change Log, Diff View and Revert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents change existing files with an exact-snippet `edit_file` tool. Every file a run changes is recorded, shown as a side-by-side diff, and can be reverted.

**Architecture:**
- **Edit logic:** a pure `applyEdit` function (`editFile.ts`) behind a new `edit_file` tool in `toolExecutor.ts`. Any node with `fs.write` gets it.
- **Change log:** `executeTool` reports each write through an optional listener. The hook records the reports into `WorkflowRun.changes`, merged by the pure `changeLog.ts`.
- **Revert:** `revertChanges.ts`. Restoring uses `write_workspace_file`; deleting a created file uses a new Rust `delete_workspace_file`.
- **UI:** `ChangesDialog` shows Monaco's `DiffEditor`, loaded lazily from the offline bundle. It opens from the run panel.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest + Testing Library (jsdom), Tauri 2 (Rust), `@monaco-editor/react`.

Spec: `docs/superpowers/specs/2026-09-25-coding-core-design.md` §1. Branch: `claude/coding-core`.

**Conventions:**
- Run the unit tests with `npx vitest run <path>` from the repo root.
- Run the Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>`.
- In tests, `@tauri-apps/api/core` resolves to `src/ipc/mockTauri.ts`, so use `mockInvokeHandler(cmd, fn)`.
- Rust `io::Error` messages are localized, but they always end in "(os error 2)" for a missing file.

## File map

| File | Responsibility |
|---|---|
| `src/services/execution/editFile.ts` (new) | Pure exact-snippet replacement with CRLF tolerance |
| `src/services/execution/toolExecutor.ts` | `edit_file` definition, offering, permission and execution; the change listener; `isNotFound` |
| `src/services/execution/changeLog.ts` (new) | Pure change-log merging, path normalization, +/− line counts |
| `src/types/execution.ts` | `FileChange` type; `WorkflowRun.changes` |
| `src/store/executionStore.ts` | `recordFileChange` and `forgetFileChange` actions |
| `src/hooks/useWorkflowExecution.ts` | Passes the change listener for the node and its helpers |
| `src-tauri/src/commands/fs_commands.rs`, `src-tauri/src/lib.rs`, `src/ipc/tauriCommands.ts` | `delete_workspace_file` |
| `src/services/execution/revertChanges.ts` (new) | Reverts one file change, with a "changed since" check |
| `src/components/editor/monacoLocal.ts` | Also exports `DiffEditor` |
| `src/components/execution/ChangesDialog.tsx` (new), `src/components/execution/RunPanel.tsx` | Diff dialog and its "Changes (N)" button |

---

### Task 1: `applyEdit`

**Files:**
- Create: `src/services/execution/editFile.ts`
- Test: `tests/unit/services/execution/editFile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { applyEdit } from "@/services/execution/editFile";

describe("applyEdit", () => {
  it("replaces a snippet that occurs once", () => {
    expect(applyEdit("const x = 1;\nconst y = 2;\n", "x = 1", "x = 10"))
      .toEqual({ ok: true, content: "const x = 10;\nconst y = 2;\n", replacements: 1 });
  });

  it("refuses a snippet that is not in the file", () => {
    const result = applyEdit("const x = 1;\n", "x = 2", "x = 3");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/not found/);
  });

  it("refuses an ambiguous snippet unless replace_all is set", () => {
    const text = "a();\na();\n";
    const refused = applyEdit(text, "a()", "b()");
    expect(!refused.ok && refused.error).toMatch(/occurs 2 times/);
    expect(applyEdit(text, "a()", "b()", true)).toEqual({ ok: true, content: "b();\nb();\n", replacements: 2 });
  });

  it("matches a \\n snippet in a \\r\\n file and keeps the file's line endings", () => {
    expect(applyEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "one\n2"))
      .toEqual({ ok: true, content: "one\r\n2\r\nthree\r\n", replacements: 1 });
  });

  it("refuses an empty or unchanged snippet", () => {
    expect(applyEdit("x", "", "y").ok).toBe(false);
    expect(applyEdit("x", "x", "x").ok).toBe(false);
  });

  it("inserts the replacement literally, even with $ patterns", () => {
    expect(applyEdit("price", "price", "$& $1 $$")).toEqual({ ok: true, content: "$& $1 $$", replacements: 1 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/editFile.test.ts`
Expected: FAIL, `Failed to resolve import "@/services/execution/editFile"`

- [ ] **Step 3: Implement**

```ts
/**
 * editFile — the text replacement behind the `edit_file` tool.
 *
 * The model names an exact snippet. It must occur once (or the call sets
 * replace_all), so an ambiguous edit fails instead of changing the wrong place.
 * Models often send "\n" line endings for a "\r\n" file: a snippet that is not
 * found verbatim is retried with "\r\n".
 */

export type EditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; error: string };

function occurrences(text: string, snippet: string): number {
  let count = 0;
  for (let i = text.indexOf(snippet); i !== -1; i = text.indexOf(snippet, i + snippet.length)) count++;
  return count;
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): EditResult {
  if (oldString === "") return { ok: false, error: "old_string is empty. Use fs.write to create or overwrite a file." };
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are the same, so there is nothing to change." };
  }
  let find = oldString;
  let replace = newString;
  let count = occurrences(content, find);
  if (count === 0 && content.includes("\r\n")) {
    find = find.replace(/\r?\n/g, "\r\n");
    replace = replace.replace(/\r?\n/g, "\r\n");
    count = occurrences(content, find);
  }
  if (count === 0) {
    return { ok: false, error: "old_string was not found. Read the file and copy the exact text, including whitespace and indentation." };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string occurs ${count} times. Include more surrounding lines so it is unique, or set replace_all to true.` };
  }
  // split/join instead of String.replace: "$&" and friends stay literal.
  return { ok: true, content: content.split(find).join(replace), replacements: count };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/editFile.test.ts`
Expected: PASS, 6 tests

---

### Task 2: The `edit_file` tool

**Files:**
- Modify: `src/services/execution/toolExecutor.ts`
- Test: `tests/unit/services/execution/toolExecutor.test.ts`, `tests/unit/services/execution/subAgents.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `toolExecutor.test.ts`:

```ts
// ── executeTool — edit_file ───────────────────────────────────────────────────

/** An in-memory workspace for read/write tool calls. */
function fileInvoke(files: Record<string, string>): InvokeFn {
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.relativePath as string;
    if (cmd === "read_workspace_file") {
      if (path in files) return files[path];
      throw new Error("IO error: The system cannot find the file specified. (os error 2)");
    }
    if (cmd === "write_workspace_file") { files[path] = args?.content as string; return undefined; }
    throw new Error(`Unexpected: ${cmd}`);
  }) as unknown as InvokeFn;
}

describe("executeTool — edit_file", () => {
  it("comes with fs.write and edits the file", async () => {
    const files = { "src/a.ts": "const x = 1;\n" };
    const result = await executeTool(
      { name: "edit_file", args: { path: "src/a.ts", old_string: "x = 1", new_string: "x = 2" } },
      "/workspace", fileInvoke(files), ["fs.write"],
    );
    expect(result).toBe("Edited: src/a.ts (1 replacement)");
    expect(files["src/a.ts"]).toBe("const x = 2;\n");
  });

  it("is refused without fs.write, naming that permission", async () => {
    const result = await executeTool(
      { name: "edit_file", args: { path: "a.ts", old_string: "a", new_string: "b" } },
      "/workspace", fileInvoke({ "a.ts": "a" }), ["fs.append"],
    );
    expect(result).toContain('Enable "fs.write"');
  });

  it("reports a mismatch without writing", async () => {
    const files = { "a.ts": "a();\na();\n" };
    const result = await executeTool(
      { name: "edit_file", args: { path: "a.ts", old_string: "a()", new_string: "b()" } },
      "/workspace", fileInvoke(files), ["fs.write"],
    );
    expect(result).toMatch(/^\[error\] old_string occurs 2 times/);
    expect(files["a.ts"]).toBe("a();\na();\n");
  });

  it("points to fs.write for a file that does not exist", async () => {
    const result = await executeTool(
      { name: "edit_file", args: { path: "new.ts", old_string: "a", new_string: "b" } },
      "/workspace", fileInvoke({}), ["fs.write"],
    );
    expect(result).toBe("[error] new.ts does not exist. Use fs.write to create it.");
  });

  it("is offered to nodes with fs.write, with its required arguments", () => {
    expect(runnableTools(["read_file", "fs.write"])).toEqual(["read_file", "fs.write", "edit_file"]);
    const edit = toolDefinitions(["fs.write"]).find((d) => d.name === "edit_file");
    expect(edit?.parameters).toMatchObject({
      required: ["path", "old_string", "new_string"],
      properties: { replace_all: { type: "boolean" } },
    });
  });
});
```

Update the existing native-definitions test, which now also sees `edit_file`:

```ts
    expect(defs.map((d) => d.name)).toEqual(["read_file", "fs_write", "edit_file"]);
```

(replaces `expect(defs.map((d) => d.name)).toEqual(["read_file", "fs_write"]);`)

In `subAgents.test.ts`, the helper that gets all of its parent's tools now also gets `edit_file`:

```ts
    expect(loop.mock.calls[1][0].tools).toEqual(["read_file", "fs.write", "edit_file"]);
```

(replaces `expect(loop.mock.calls[1][0].tools).toEqual(["read_file", "fs.write"]);`)

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/services/execution/toolExecutor.test.ts tests/unit/services/execution/subAgents.test.ts`
Expected: FAIL. The new `edit_file` tests fail, and so do the updated definitions and helper-tools expectations.

- [ ] **Step 3: Implement in `toolExecutor.ts`**

Header comment, write-tools block:

```ts
 * Write tools (require "fs.write" or "fs.append" in node's allowedTools):
 *   fs.write / write_file   — overwrite a file
 *   fs.append / append_file — append to a file
 *   edit_file               — replace an exact snippet (comes with fs.write)
```

Import, below the existing imports:

```ts
import { applyEdit } from "@/services/execution/editFile";
```

Add to `WRITE_EXEC_TOOL_DEFS` after `"fs.append"`:

```ts
  edit_file: {
    name: "edit_file",
    description:
      "Replace an exact piece of text in an existing workspace file. old_string must match the file exactly " +
      "(whitespace and indentation included) and occur once, unless replace_all is true. " +
      "Use it to change existing files; use fs.write to create a file.",
    args: {
      path: "Relative path from workspace root",
      old_string: "The exact text to replace",
      new_string: "The replacement text",
      replace_all: "(optional) true to replace every occurrence",
    },
  },
```

`REQUIRED_ARGS` gets `edit_file: ["path", "old_string", "new_string"],`. `ARG_SCHEMAS` gets `edit_file: { replace_all: { type: "boolean" } },`.

Replace `runnableTools`:

```ts
/** The node's tools that actually run; the others (web_search, …) never execute.
 *  Editing is part of writing: a node with fs.write also gets edit_file. */
export function runnableTools(allowedTools: string[]): string[] {
  const tools = allowedTools.filter((t) => toolDef(t) !== undefined);
  if (tools.includes("fs.write") && !tools.includes("edit_file")) tools.push("edit_file");
  return tools;
}
```

Replace the permission helpers:

```ts
/** The node permission a tool needs; edit_file comes with fs.write. */
function permissionFor(toolName: string): string {
  const canonical = resolveCanonical(toolName);
  return canonical === "edit_file" ? "fs.write" : canonical;
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes(toolName) || allowedTools.includes(permissionFor(toolName));
}

const WRITE_EXEC_TOOLS = new Set([
  "fs.write", "write_file",
  "fs.append", "append_file",
  "edit_file",
  "bash", "run_command",
]);

/** A Rust io error for a missing file or folder: "(os error 2)" / "(os error 3)"
 *  end the message whatever the OS language. */
export function isNotFound(error: unknown): boolean {
  return /\(os error [23]\)/.test(String(error));
}
```

In `executeTool`, change the guard message to name the permission:

```ts
  if (WRITE_EXEC_TOOLS.has(name) && !isToolAllowed(name, allowedTools)) {
    return `[error] Tool "${name}" is not enabled for this agent. Enable "${permissionFor(name)}" in the Permission Matrix.`;
  }
```

Add the branch after the `fs.append` branch:

```ts
    if (name === "edit_file") {
      const path = argText(args.path).trim();
      if (!path) return "[error] edit_file requires a 'path' argument.";
      let before: string;
      try {
        before = await invokeFn<string>("read_workspace_file", { workspacePath, relativePath: path });
      } catch (e) {
        if (isNotFound(e)) return `[error] ${path} does not exist. Use fs.write to create it.`;
        throw e;
      }
      const replaceAll = args.replace_all === true || args.replace_all === "true";
      const edit = applyEdit(before, argText(args.old_string), argText(args.new_string), replaceAll);
      if (!edit.ok) return `[error] ${edit.error}`;
      await invokeFn<void>("write_workspace_file", { workspacePath, relativePath: path, content: edit.content });
      return `Edited: ${path} (${edit.replacements} replacement${edit.replacements === 1 ? "" : "s"})`;
    }
```

In the `fs.append` branch, replace `if (!/\(os error [23]\)/.test(String(e))) {` with `if (!isNotFound(e)) {`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/services/execution/`
Expected: PASS (all execution service tests)

---

### Task 3: The change listener

**Files:**
- Modify: `src/services/execution/toolExecutor.ts`
- Test: `tests/unit/services/execution/toolExecutor.test.ts`

- [ ] **Step 1: Write the failing test.** Append:

```ts
describe("executeTool — change listener", () => {
  it("reports the before and after content of each write, edit and append", async () => {
    const files: Record<string, string> = { "a.ts": "old\n" };
    const changes: Array<[string, string | null, string]> = [];
    const onChange = (path: string, before: string | null, after: string) => { changes.push([path, before, after]); };
    const tools = ["fs.write", "fs.append"];
    const invoke = fileInvoke(files);

    await executeTool({ name: "fs.write", args: { path: "a.ts", content: "new\n" } }, "/w", invoke, tools, onChange);
    await executeTool({ name: "edit_file", args: { path: "a.ts", old_string: "new", new_string: "newer" } }, "/w", invoke, tools, onChange);
    await executeTool({ name: "fs.append", args: { path: "log.txt", content: "line\n" } }, "/w", invoke, tools, onChange);

    expect(changes).toEqual([
      ["a.ts", "old\n", "new\n"],
      ["a.ts", "new\n", "newer\n"],
      ["log.txt", null, "line\n"],
    ]);
  });

  it("does not read the old content when nothing listens", async () => {
    const invoke = mockInvoke({ write_workspace_file: undefined });
    await executeTool({ name: "fs.write", args: { path: "a.ts", content: "x" } }, "/w", invoke, ["fs.write"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/toolExecutor.test.ts -t "change listener"`
Expected: FAIL, `changes` is `[]`

- [ ] **Step 3: Implement.** Add the type and a helper above `executeTool`:

```ts
/** Told about every file an agent changes: its content before (null if new) and after. */
export type FileChangeListener = (path: string, before: string | null, after: string) => void;

/** The file's content, null if it does not exist, undefined if it cannot be read. */
async function readBefore(invokeFn: InvokeFn, workspacePath: string, path: string): Promise<string | null | undefined> {
  try {
    return await invokeFn<string>("read_workspace_file", { workspacePath, relativePath: path });
  } catch (e) {
    return isNotFound(e) ? null : undefined;
  }
}
```

New signature:

```ts
export async function executeTool(
  call: ToolCall,
  workspacePath: string | null,
  invokeFn: InvokeFn,
  allowedTools: string[] = [],
  onChange?: FileChangeListener,
): Promise<string> {
```

`fs.write` branch:

```ts
    if (name === "fs.write" || name === "write_file") {
      const path = argText(args.path);
      if (!path) return "[error] fs.write requires a 'path' argument.";
      const content = argText(args.content);
      // The old content is only read when someone records changes.
      const before = onChange ? await readBefore(invokeFn, workspacePath, path.trim()) : undefined;
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content,
      });
      if (before !== undefined) onChange?.(path.trim(), before, content);
      return `Written: ${path} (${content.length} chars)`;
    }
```

`fs.append` branch, tail replacing the `let existing` block through the return:

```ts
      let existing: string | null;
      try {
        existing = await invokeFn<string>("read_workspace_file", {
          workspacePath,
          relativePath: path.trim(),
        });
      } catch (e) {
        if (!isNotFound(e)) {
          return `[error] fs.append could not read ${path}; nothing was written: ${String(e)}`;
        }
        existing = null;
      }
      const after = (existing ?? "") + toAppend;
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content: after,
      });
      onChange?.(path.trim(), existing, after);
      return `Appended to: ${path} (+${toAppend.length} chars)`;
```

In the `edit_file` branch, after the `write_workspace_file` call: `onChange?.(path, before, edit.content);`

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/toolExecutor.test.ts`
Expected: PASS

---

### Task 4: `FileChange` and the change log

**Files:**
- Modify: `src/types/execution.ts`
- Create: `src/services/execution/changeLog.ts`
- Test: `tests/unit/services/execution/changeLog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { lineCounts, normalizeChangePath, recordChange } from "@/services/execution/changeLog";

describe("recordChange", () => {
  it("keeps the first before, the latest after, and every agent once", () => {
    let log = recordChange([], "src/a.ts", "v1", "v2", "Coder");
    log = recordChange(log, "src\\a.ts", "v2", "v3", "Helper");
    log = recordChange(log, "./src/a.ts", "v3", "v4", "Coder");
    expect(log).toEqual([{ path: "src/a.ts", before: "v1", after: "v4", agents: ["Coder", "Helper"], edits: 3 }]);
  });

  it("drops a file changed back to its original content", () => {
    const log = recordChange(recordChange([], "a.ts", "same", "edited", "Coder"), "a.ts", "edited", "same", "Coder");
    expect(log).toEqual([]);
  });

  it("records a created file with no before", () => {
    expect(recordChange([], "new.ts", null, "x", "Coder"))
      .toEqual([{ path: "new.ts", before: null, after: "x", agents: ["Coder"], edits: 1 }]);
  });
});

describe("normalizeChangePath", () => {
  it("uses / separators without a leading ./", () => {
    expect(normalizeChangePath(" .\\src\\a.ts ")).toBe("src/a.ts");
  });
});

describe("lineCounts", () => {
  it("counts added and removed lines", () => {
    expect(lineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/changeLog.test.ts`
Expected: FAIL, the import cannot be resolved

- [ ] **Step 3: Implement.** In `src/types/execution.ts`, add above `WorkflowRun`:

```ts
/** A file the run's agents changed with fs.write, fs.append or edit_file. */
export interface FileChange {
  /** Workspace-relative, "/" separators. */
  path: string;
  /** Content before the run first changed it; null if the run created the file. */
  before: string | null;
  after: string;
  /** Names of the agents that changed it. */
  agents: string[];
  edits: number;
}
```

and in `WorkflowRun`:

```ts
  /** Files changed by this run's agents (Changes dialog, revert). */
  changes?: FileChange[];
```

Create `src/services/execution/changeLog.ts`:

```ts
/**
 * changeLog — the files a run's agents changed, for the Changes dialog and
 * revert: one entry per file with its content before the run first changed it,
 * the latest content, and the agents that changed it.
 */
import type { FileChange } from "@/types/execution";

export function normalizeChangePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function recordChange(
  changes: FileChange[], path: string, before: string | null, after: string, agent: string,
): FileChange[] {
  const key = normalizeChangePath(path);
  const prev = changes.find((c) => c.path === key);
  if (!prev) return [...changes, { path: key, before, after, agents: [agent], edits: 1 }];
  // Changed back to what it was before the run: nothing left to show or revert.
  if (prev.before === after) return changes.filter((c) => c !== prev);
  const next: FileChange = {
    ...prev,
    after,
    agents: prev.agents.includes(agent) ? prev.agents : [...prev.agents, agent],
    edits: prev.edits + 1,
  };
  return changes.map((c) => (c === prev ? next : c));
}

/** Added and removed lines, counted as multisets: an approximation of a diff. */
export function lineCounts(before: string | null, after: string): { added: number; removed: number } {
  const lines = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const remaining = new Map<string, number>();
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after)) {
    const n = remaining.get(line) ?? 0;
    if (n > 0) remaining.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of remaining.values()) removed += n;
  return { added, removed };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/changeLog.test.ts`
Expected: PASS, 5 tests

---

### Task 5: Store actions

**Files:**
- Modify: `src/store/executionStore.ts`
- Test: `tests/unit/store/executionStore.test.ts`

- [ ] **Step 1: Write the failing test.** Append:

```ts
describe("executionStore — file changes", () => {
  it("records changes on the current run and forgets reverted files", () => {
    useExecutionStore.getState().startRun("W");
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    useExecutionStore.getState().recordFileChange("b.ts", null, "new", "Coder");
    useExecutionStore.getState().forgetFileChange("a.ts");
    expect(useExecutionStore.getState().currentRun?.changes).toEqual([
      { path: "b.ts", before: null, after: "new", agents: ["Coder"], edits: 1 },
    ]);
  });

  it("ignores changes when there is no run", () => {
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    expect(useExecutionStore.getState().currentRun).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/store/executionStore.test.ts`
Expected: FAIL, `recordFileChange is not a function`

- [ ] **Step 3: Implement.** Import `import { recordChange } from "@/services/execution/changeLog";`. Add to `ExecutionActions`:

```ts
  recordFileChange: (path: string, before: string | null, after: string, agent: string) => void;
  forgetFileChange: (path: string) => void;
```

and to the store, after `finishRun`:

```ts
  recordFileChange: (path, before, after, agent) =>
    set((state) => state.currentRun
      ? { currentRun: { ...state.currentRun,
          changes: recordChange(state.currentRun.changes ?? [], path, before, after, agent) } }
      : {}),

  forgetFileChange: (path) =>
    set((state) => state.currentRun
      ? { currentRun: { ...state.currentRun,
          changes: (state.currentRun.changes ?? []).filter((c) => c.path !== path) } }
      : {}),
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/store/executionStore.test.ts`
Expected: PASS

---

### Task 6: Record changes during runs

**Files:**
- Modify: `src/hooks/useWorkflowExecution.ts`
- Test: `tests/unit/hooks/useWorkflowExecution.test.ts`

- [ ] **Step 1: Write the failing test.** Add to the top-level `describe("useWorkflowExecution")`:

```ts
  it("records the files an agent edits in the run's change log", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.WriteFile];
    node.data.maxSteps = 2;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const files: Record<string, string> = { "src/a.ts": "const x = 1;\n" };
    mockInvokeHandler("read_workspace_file", (args) => {
      const path = (args as { relativePath: string }).relativePath;
      if (path in files) return files[path];
      throw new Error("IO error: not found (os error 2)");
    });
    mockInvokeHandler("write_workspace_file", (args) => {
      const a = args as { relativePath: string; content: string };
      files[a.relativePath] = a.content;
    });
    let calls = 0;
    mockInvokeHandler("call_ollama_api", () => (++calls === 1
      ? '<tool_call>{"name":"edit_file","args":{"path":"src/a.ts","old_string":"x = 1","new_string":"x = 2"}}</tool_call>'
      : "done"));

    const finished = await run();

    expect(files["src/a.ts"]).toBe("const x = 2;\n");
    expect(finished?.changes).toEqual([
      { path: "src/a.ts", before: "const x = 1;\n", after: "const x = 2;\n", agents: ["A"], edits: 1 },
    ]);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts -t "change log"`
Expected: FAIL, `changes` is `undefined`

- [ ] **Step 3: Implement.** In `processNode`, before `const runCommand = …`:

```ts
        // Every file an agent writes goes into the run's change log (Changes dialog,
        // revert). A helper can finish after its run ended: never write into a newer run.
        const recordChangeBy = (agent: string) => (path: string, before: string | null, after: string) => {
          if (useExecutionStore.getState().currentRun?.id !== runId) return;
          useExecutionStore.getState().recordFileChange(path, before, after, agent);
        };
```

Helper `runTool`:

```ts
            runTool: (call) => executeTool(call, workspacePath, invoke, child.tools, recordChangeBy(child.name)),
```

Node `runTool`, last branch:

```ts
            : executeTool(call, workspacePath, invoke, data.tools as string[], recordChangeBy(data.name)),
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts`
Expected: PASS

---

### Task 7: `delete_workspace_file`

**Files:**
- Modify: `src-tauri/src/commands/fs_commands.rs`, `src-tauri/src/lib.rs`, `src/ipc/tauriCommands.ts`

- [ ] **Step 1: Write the failing Rust tests.** Append to the `tests` module in `fs_commands.rs`:

```rust
    #[test]
    fn delete_workspace_file_removes_a_file_inside_the_workspace() {
        let dir = temp_workspace();
        fs::write(dir.path().join("new.txt"), "x").unwrap();

        delete_workspace_file(dir.path().to_string_lossy().to_string(), "new.txt".to_string()).unwrap();

        assert!(!dir.path().join("new.txt").exists());
    }

    #[test]
    fn delete_workspace_file_refuses_folders_and_paths_outside() {
        let dir = temp_workspace();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let root = dir.path().to_string_lossy().to_string();

        assert!(delete_workspace_file(root.clone(), "sub".to_string()).is_err());
        assert!(dir.path().join("sub").exists());
        assert!(matches!(
            delete_workspace_file(root, "../outside.txt".to_string()),
            Err(AppError::PathTraversal(_))
        ));
    }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib delete_workspace_file`
Expected: FAIL to compile, `cannot find function delete_workspace_file`

- [ ] **Step 3: Implement.** After `write_workspace_file` in `fs_commands.rs`:

```rust
/// Delete one file inside the workspace (reverting a file an agent created).
/// Folders are refused.
#[tauri::command]
pub fn delete_workspace_file(workspace_path: String, relative_path: String) -> AppResult<()> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    if !safe.is_file() {
        return Err(AppError::Other(format!("{relative_path} is not a file")));
    }
    std::fs::remove_file(safe)?;
    Ok(())
}
```

In `lib.rs`, add `delete_workspace_file` to the `fs_commands::{…}` import and to `generate_handler![…]` after `write_workspace_file`. In `tauriCommands.ts`, after `writeWorkspaceFile`:

```ts
export async function deleteWorkspaceFile(workspacePath: string, relativePath: string): Promise<void> {
  return invoke<void>("delete_workspace_file", { workspacePath, relativePath });
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib delete_workspace_file`
Expected: PASS, 2 tests

---

### Task 8: `revertChange`

**Files:**
- Create: `src/services/execution/revertChanges.ts`
- Test: `tests/unit/services/execution/revertChanges.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { revertChange } from "@/services/execution/revertChanges";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

function disk(files: Record<string, string>): InvokeFn {
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.relativePath as string;
    if (cmd === "read_workspace_file") {
      if (path in files) return files[path];
      throw new Error("IO error: not found (os error 2)");
    }
    if (cmd === "write_workspace_file") { files[path] = args?.content as string; return undefined; }
    if (cmd === "delete_workspace_file") { delete files[path]; return undefined; }
    throw new Error(`Unexpected: ${cmd}`);
  }) as unknown as InvokeFn;
}

describe("revertChange", () => {
  it("restores a modified file", async () => {
    const files = { "a.ts": "new" };
    const outcome = await revertChange(
      { path: "a.ts", before: "old", after: "new", agents: ["A"], edits: 1 }, "/w", disk(files));
    expect(outcome).toBe("reverted");
    expect(files).toEqual({ "a.ts": "old" });
  });

  it("deletes a file the run created", async () => {
    const files: Record<string, string> = { "new.ts": "x" };
    await revertChange({ path: "new.ts", before: null, after: "x", agents: ["A"], edits: 1 }, "/w", disk(files));
    expect(files).toEqual({});
  });

  it("does not overwrite a file that changed since, unless forced", async () => {
    const files = { "a.ts": "edited by you" };
    const change = { path: "a.ts", before: "old", after: "new", agents: ["A"], edits: 1 };
    expect(await revertChange(change, "/w", disk(files))).toBe("changed-since");
    expect(files["a.ts"]).toBe("edited by you");
    expect(await revertChange(change, "/w", disk(files), true)).toBe("reverted");
    expect(files["a.ts"]).toBe("old");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/execution/revertChanges.test.ts`
Expected: FAIL, the import cannot be resolved

- [ ] **Step 3: Implement**

```ts
/**
 * revertChanges — undo a run's change to one file (Changes dialog).
 * A modified file gets its content from before the run back; a file the run
 * created is deleted. A file that changed again after the agent's last write
 * (by the user or a command) is only overwritten with `force`.
 */
import { isNotFound } from "@/services/execution/toolExecutor";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { FileChange } from "@/types/execution";

export type RevertOutcome = "reverted" | "changed-since";

export async function revertChange(
  change: FileChange, workspacePath: string, invoke: InvokeFn, force = false,
): Promise<RevertOutcome> {
  const file = { workspacePath, relativePath: change.path };
  let current: string | null;
  try {
    current = await invoke<string>("read_workspace_file", file);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    current = null;
  }
  if (current !== change.after && !force) return "changed-since";
  if (change.before !== null) {
    await invoke<void>("write_workspace_file", { ...file, content: change.before });
  } else if (current !== null) {
    await invoke<void>("delete_workspace_file", file);
  }
  return "reverted";
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/execution/revertChanges.test.ts`
Expected: PASS, 3 tests

---

### Task 9: Changes dialog and its button

**Files:**
- Modify: `src/components/editor/monacoLocal.ts`, `src/components/execution/RunPanel.tsx`
- Create: `src/components/execution/ChangesDialog.tsx`
- Test: `tests/unit/components/ChangesDialog.test.tsx`, `tests/unit/components/RunPanel.test.tsx`

- [ ] **Step 1: Write the failing tests.** `ChangesDialog.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { ChangesDialog } from "@/components/execution/ChangesDialog";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";

vi.mock("@/components/editor/monacoLocal", () => ({
  default: () => null,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <pre data-testid="diff">{`${original}|${modified}`}</pre>
  ),
}));

beforeEach(() => {
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useExecutionStore.setState({
    currentRun: {
      id: "run-1", workflowName: "W", startedAt: 0, status: "done", agents: {},
      changes: [
        { path: "src/a.ts", before: "a\nb\n", after: "a\nB\nc\n", agents: ["Coder"], edits: 2 },
        { path: "src/new.ts", before: null, after: "x\n", agents: ["Helper"], edits: 1 },
      ],
    },
  });
});

describe("ChangesDialog", () => {
  it("lists the changed files with their line counts and shows a diff", async () => {
    render(<ChangesDialog onClose={() => {}} />);

    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("+2 −1")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect((await screen.findByTestId("diff")).textContent).toBe("a\nb\n|a\nB\nc\n");

    fireEvent.click(screen.getByText("src/new.ts"));
    expect((await screen.findByTestId("diff")).textContent).toBe("|x\n");
  });

  it("reverts a file and drops it from the list", async () => {
    const written: Record<string, string> = {};
    mockInvokeHandler("read_workspace_file", () => "a\nB\nc\n");
    mockInvokeHandler("write_workspace_file", (args) => {
      const a = args as { relativePath: string; content: string };
      written[a.relativePath] = a.content;
    });
    mockInvokeHandler("write_audit_entry", () => undefined);
    render(<ChangesDialog onClose={() => {}} />);

    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]); });

    expect(written).toEqual({ "src/a.ts": "a\nb\n" });
    expect(useExecutionStore.getState().currentRun?.changes?.map((c) => c.path)).toEqual(["src/new.ts"]);
  });
});
```

`RunPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "@/components/execution/RunPanel";
import { useExecutionStore } from "@/store/executionStore";

vi.mock("@/components/editor/monacoLocal", () => ({ default: () => null, DiffEditor: () => null }));

beforeEach(() => {
  useExecutionStore.setState({
    currentRun: {
      id: "run-1", workflowName: "W", startedAt: 0, status: "done", agents: {},
      changes: [{ path: "a.ts", before: "1", after: "2", agents: ["A"], edits: 1 }],
    },
    isRunning: false,
  });
});

describe("RunPanel", () => {
  it("opens the Changes dialog from the changed-file count", () => {
    render(<RunPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    expect(screen.getByRole("dialog", { name: /Changes/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/components/ChangesDialog.test.tsx tests/unit/components/RunPanel.test.tsx`
Expected: FAIL. `ChangesDialog` can't be resolved, and the run panel has no Changes button.

- [ ] **Step 3: Implement.** `monacoLocal.ts`: change the import to `import Editor, { DiffEditor, loader } from "@monaco-editor/react";` and add `export { DiffEditor };` after `export default Editor;`.

Create `ChangesDialog.tsx`:

```tsx
/**
 * ChangesDialog — the files this run's agents changed with fs.write, fs.append
 * or edit_file, as a side-by-side diff, with revert per file or for all.
 * Changes made by shell commands are not tracked.
 */
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { writeAuditEntry } from "@/ipc/tauriCommands";
import { lineCounts } from "@/services/execution/changeLog";
import { revertChange } from "@/services/execution/revertChanges";
import type { FileChange } from "@/types/execution";
import { NodeIcon } from "@/components/nodes/NodeIcon";

const DiffEditor = React.lazy(() =>
  import("@/components/editor/monacoLocal").then((m) => ({ default: m.DiffEditor })),
);

const MONO = '"JetBrains Mono", monospace';
const NO_CHANGES: FileChange[] = [];
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json",
  md: "markdown", rs: "rust", py: "python", css: "css", html: "html", yaml: "yaml", yml: "yaml",
};
const languageOf = (path: string) => LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

const smallButton: React.CSSProperties = {
  padding: "2px 8px", border: "1px solid var(--border-md)", borderRadius: 4, background: "var(--surface-3)",
  color: "var(--text)", cursor: "pointer", fontSize: 11, fontFamily: "inherit",
};

export function ChangesDialog({ onClose }: { onClose: () => void }) {
  const changes = useExecutionStore((s) => s.currentRun?.changes) ?? NO_CHANGES;
  const forgetFileChange = useExecutionStore((s) => s.forgetFileChange);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const shown = changes.find((c) => c.path === selected) ?? changes[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function revert(targets: FileChange[]) {
    if (!workspacePath) { setMessage("Open the workspace to revert changes."); return; }
    const reverted: string[] = [];
    try {
      for (const change of targets) {
        let outcome = await revertChange(change, workspacePath, invoke);
        if (outcome === "changed-since" &&
            window.confirm(`${change.path} changed after the agent's last edit. Revert it anyway?`)) {
          outcome = await revertChange(change, workspacePath, invoke, true);
        }
        if (outcome !== "reverted") continue;
        forgetFileChange(change.path);
        reverted.push(change.path);
        const entry = {
          id: `revert-${change.path}-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "file_write" as const, path: change.path, success: true,
          details: `↶ Reverted ${change.path} to its content before the run`,
        };
        useAuditStore.getState().addEntry(entry);
        writeAuditEntry(workspacePath, entry).catch(console.error);
      }
      setMessage(reverted.length ? `Reverted ${reverted.join(", ")}.` : "Nothing was reverted.");
    } catch (e) {
      setMessage(`Revert failed: ${String(e)}`);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="changes-title" style={{
        width: 1100, maxWidth: "96vw", height: "80vh", display: "flex", flexDirection: "column",
        background: "var(--surface-2)", border: "1px solid var(--border-md)", borderRadius: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
          borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <NodeIcon name="file" size={14} color="var(--accent)" />
          <div id="changes-title" style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>
            Changes · {changes.length} file{changes.length === 1 ? "" : "s"}
          </div>
          {changes.length > 0 && <button onClick={() => revert(changes)} style={smallButton}>Revert all</button>}
          <button onClick={onClose} aria-label="Close" style={{ ...smallButton, border: "none", background: "transparent" }}>
            <NodeIcon name="x" size={13} />
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ width: 280, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
            {changes.map((c) => {
              const { added, removed } = lineCounts(c.before, c.after);
              return (
                <div key={c.path} onClick={() => setSelected(c.path)} style={{
                  padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid var(--border)",
                  background: c === shown ? "var(--accent-soft)" : "transparent",
                }}>
                  <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: "break-all" }}>{c.path}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, color: "var(--muted)" }}>
                    <span style={{ color: c.before === null ? "var(--green)" : "var(--accent)" }}>
                      {c.before === null ? "new" : "modified"}
                    </span>
                    <span style={{ fontFamily: MONO }}>{`+${added} −${removed}`}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.agents.join(", ")}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); void revert([c]); }} style={smallButton}>Revert</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {shown && (
              <React.Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: "var(--hint)" }}>Loading diff…</div>}>
                <DiffEditor
                  height="100%"
                  language={languageOf(shown.path)}
                  original={shown.before ?? ""}
                  modified={shown.after}
                  options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 }}
                />
              </React.Suspense>
            )}
          </div>
        </div>

        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11,
          color: "var(--muted)", background: "var(--surface)" }}>
          {message || "Only changes made with fs.write, fs.append and edit_file are listed; changes made by shell commands are not tracked."}
        </div>
      </div>
    </div>
  );
}
```

`RunPanel.tsx`: add `import { useState } from "react";` and `import { ChangesDialog } from "./ChangesDialog";` at the top. In the component, after `const selectNode = …`:

```tsx
  const [showChanges, setShowChanges] = useState(false);
  const changeCount = currentRun?.changes?.length ?? 0;
```

Directly before the `{/* Agent list */}` block:

```tsx
      {/* Files changed by this run's agents */}
      {changeCount > 0 && (
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <button onClick={() => setShowChanges(true)} style={{
            width: "100%", padding: "5px 0", border: "1px solid var(--border-md)", borderRadius: 5,
            background: "var(--surface-3)", color: "var(--text)", cursor: "pointer", fontSize: 12,
            fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <NodeIcon name="file" size={12} /> Changes ({changeCount})
          </button>
        </div>
      )}
      {showChanges && <ChangesDialog onClose={() => setShowChanges(false)} />}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/components/ChangesDialog.test.tsx tests/unit/components/RunPanel.test.tsx`
Expected: PASS, 3 tests

---

### Task 10: Verify and commit Part 1

- [ ] **Step 1: Full checks**

Run each and confirm:

```bash
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

Expected: tsc prints nothing; vitest has 0 failures (baseline 538 plus the new tests); cargo has 0 failures (baseline 74 + 2); the build passes.

- [ ] **Step 2: Commit**

```bash
git add src tests src-tauri/src docs/superpowers/plans
git commit -m "Let agents edit files with edit_file, and review or revert a run's changes"
```
