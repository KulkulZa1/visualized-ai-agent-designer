import { describe, it, expect, vi } from "vitest";
import {
  executeTool,
  parseToolCall,
  stripToolCall,
  buildToolInstructions,
  runnableTools,
  toolDefinitions,
  nativeToolName,
  toolForNativeName,
} from "@/services/execution/toolExecutor";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockInvoke(responses: Record<string, unknown>): InvokeFn {
  return vi.fn(async (cmd: string) => {
    if (cmd in responses) return responses[cmd];
    throw new Error(`Unexpected invoke: ${cmd}`);
  }) as unknown as InvokeFn;
}

// ── parseToolCall ─────────────────────────────────────────────────────────────

describe("parseToolCall", () => {
  it("parses a valid tool call", () => {
    const text = `<tool_call>{"name":"read_file","args":{"path":"src/main.ts"}}</tool_call>`;
    expect(parseToolCall(text)).toEqual({ name: "read_file", args: { path: "src/main.ts" } });
  });

  it("returns null when no tag present", () => {
    expect(parseToolCall("just some text")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseToolCall("<tool_call>not-json</tool_call>")).toBeNull();
  });

  it("returns null when name is missing", () => {
    expect(parseToolCall(`<tool_call>{"args":{}}</tool_call>`)).toBeNull();
  });
});

// ── stripToolCall ─────────────────────────────────────────────────────────────

describe("stripToolCall", () => {
  it("removes the tag", () => {
    const text = `Before\n<tool_call>{"name":"x","args":{}}</tool_call>\nAfter`;
    expect(stripToolCall(text)).toBe("Before\n\nAfter");
  });

  it("no-ops when tag absent", () => {
    expect(stripToolCall("plain text")).toBe("plain text");
  });
});

// ── buildToolInstructions ────────────────────────────────────────────────────

describe("buildToolInstructions", () => {
  it("returns empty string when no tools allowed", () => {
    expect(buildToolInstructions([])).toBe("");
  });

  it("includes read_file when allowed", () => {
    const instructions = buildToolInstructions(["read_file"]);
    expect(instructions).toContain("read_file");
    expect(instructions).toContain("<tool_call>");
  });

  it("includes fs.write in write section when allowed", () => {
    const instructions = buildToolInstructions(["fs.write"]);
    expect(instructions).toContain("fs.write");
    expect(instructions).toContain("WRITE / EXECUTE TOOLS");
  });

  it("does not advertise bash to the model: agent shell execution is disabled", () => {
    expect(buildToolInstructions(["bash"])).toBe("");
    expect(buildToolInstructions(["fs.write", "bash"])).not.toContain("bash");
  });

  it("separates read and write sections when both present", () => {
    const instructions = buildToolInstructions(["read_file", "fs.write"]);
    expect(instructions).toContain("read_file");
    expect(instructions).toContain("WRITE / EXECUTE TOOLS");
    expect(instructions).toContain("fs.write");
  });
});

// ── executeTool — no workspace ────────────────────────────────────────────────

describe("executeTool — no workspace", () => {
  it("returns error when workspace is null", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool({ name: "read_file", args: { path: "x" } }, null, invoke);
    expect(result).toContain("[error]");
    expect(result).toContain("workspace");
  });
});

// ── executeTool — read tools ──────────────────────────────────────────────────

describe("executeTool — read_file", () => {
  it("reads a file and returns content", async () => {
    const invoke = mockInvoke({ read_workspace_file: "hello world" });
    const result = await executeTool(
      { name: "read_file", args: { path: "src/main.ts" } },
      "/workspace",
      invoke,
    );
    expect(result).toContain("hello world");
    expect(result).toContain("src/main.ts");
  });

  it("works with fs.read alias", async () => {
    const invoke = mockInvoke({ read_workspace_file: "content" });
    const result = await executeTool(
      { name: "fs.read", args: { path: "file.ts" } },
      "/workspace",
      invoke,
    );
    expect(result).toContain("content");
  });

  it("returns error when path is missing", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool({ name: "read_file", args: {} }, "/workspace", invoke);
    expect(result).toContain("[error]");
  });
});

// ── executeTool — fs.write ────────────────────────────────────────────────────

describe("executeTool — fs.write", () => {
  it("is blocked when fs.write not in allowedTools", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "fs.write", args: { path: "out.txt", content: "hi" } },
      "/workspace",
      invoke,
      [], // no allowed tools
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not enabled");
  });

  it("writes file when fs.write is in allowedTools", async () => {
    const invoke = mockInvoke({ write_workspace_file: undefined });
    const result = await executeTool(
      { name: "fs.write", args: { path: "out.txt", content: "hello" } },
      "/workspace",
      invoke,
      ["fs.write"],
    );
    expect(result).toContain("Written");
    expect(result).toContain("out.txt");
  });

  it("write_file alias is also blocked without permission", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "write_file", args: { path: "a.txt", content: "x" } },
      "/workspace",
      invoke,
      [],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not enabled");
  });

  it("write_file alias works when fs.write is allowed", async () => {
    const invoke = mockInvoke({ write_workspace_file: undefined });
    const result = await executeTool(
      { name: "write_file", args: { path: "a.txt", content: "x" } },
      "/workspace",
      invoke,
      ["fs.write"],
    );
    expect(result).toContain("Written");
  });

  it("returns error when path is missing", async () => {
    const invoke = mockInvoke({ write_workspace_file: undefined });
    const result = await executeTool(
      { name: "fs.write", args: { content: "no path" } },
      "/workspace",
      invoke,
      ["fs.write"],
    );
    expect(result).toContain("[error]");
  });
});

// ── executeTool — fs.append ───────────────────────────────────────────────────

describe("executeTool — fs.append", () => {
  it("is blocked when fs.append not in allowedTools", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "fs.append", args: { path: "log.txt", content: "line" } },
      "/workspace",
      invoke,
      [],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not enabled");
  });

  it("appends to existing file content", async () => {
    let written = "";
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_workspace_file") return "existing\n";
      if (cmd === "write_workspace_file") { written = args?.content as string; return undefined; }
      throw new Error(`Unexpected: ${cmd}`);
    }) as unknown as InvokeFn;

    const result = await executeTool(
      { name: "fs.append", args: { path: "log.txt", content: "new line" } },
      "/workspace",
      invoke,
      ["fs.append"],
    );
    expect(result).toContain("Appended");
    expect(written).toBe("existing\nnew line");
  });

  it("refuses to append when an existing file cannot be read, instead of overwriting it", async () => {
    let written: string | null = null;
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_workspace_file") throw new Error("IO error: stream did not contain valid UTF-8");
      if (cmd === "write_workspace_file") { written = args?.content as string; return undefined; }
      throw new Error(`Unexpected: ${cmd}`);
    }) as unknown as InvokeFn;

    const result = await executeTool(
      { name: "fs.append", args: { path: "data.csv", content: "x" } },
      "/workspace",
      invoke,
      ["fs.append"],
    );
    expect(result).toContain("[error]");
    expect(written).toBeNull();
  });

  it("creates file when it does not exist", async () => {
    let written = "";
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      // Rust io::Error text is localized, but the "(os error 2)" suffix is not.
      if (cmd === "read_workspace_file") throw new Error("IO error: 지정된 파일을 찾을 수 없습니다. (os error 2)");
      if (cmd === "write_workspace_file") { written = args?.content as string; return undefined; }
      throw new Error(`Unexpected: ${cmd}`);
    }) as unknown as InvokeFn;

    const result = await executeTool(
      { name: "fs.append", args: { path: "new.txt", content: "first line" } },
      "/workspace",
      invoke,
      ["fs.append"],
    );
    expect(result).toContain("Appended");
    expect(written).toBe("first line");
  });
});

// ── executeTool — bash ────────────────────────────────────────────────────────

describe("executeTool — bash", () => {
  it("is blocked when bash not in allowedTools", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "bash", args: { command: "rm -rf /" } },
      "/workspace",
      invoke,
      [],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not enabled");
  });

  it("run_command alias is also blocked without permission", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "run_command", args: { command: "ls" } },
      "/workspace",
      invoke,
      [],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not enabled");
  });

  it.each(["bash", "run_command"])("never runs %s commands, even when bash is allowed", async (name) => {
    // Agent-issued shell execution is disabled until a real permission system exists.
    const invoke = vi.fn() as unknown as InvokeFn;
    const result = await executeTool(
      { name, args: { command: "echo test" } },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("disabled");
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── executeTool — unknown tool ────────────────────────────────────────────────

describe("executeTool — unknown tool", () => {
  it("returns not available message for unknown tool names", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "fly_to_moon", args: {} },
      "/workspace",
      invoke,
      ["fly_to_moon"],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("not available");
  });
});

// ── executeTool — list_files ──────────────────────────────────────────────────

describe("executeTool — list_files", () => {
  // list_workspace_files returns a nested tree; on Windows paths use "\".
  const tree = [{
    name: "src", path: "src", isDirectory: true, children: [
      { name: "components", path: "src\\components", isDirectory: true, children: [
        { name: "App.tsx", path: "src\\components\\App.tsx", isDirectory: false, children: null },
      ] },
      { name: "main.ts", path: "src\\main.ts", isDirectory: false, children: null },
    ],
  }];

  it("lists nested files under a sub-directory, whatever the path separator", async () => {
    const invoke = mockInvoke({ list_workspace_files: tree });
    const result = await executeTool(
      { name: "list_files", args: { path: "src/components" } }, "/workspace", invoke,
    );
    expect(result).toContain("src/components/App.tsx");
    expect(result).not.toContain("main.ts");
  });

  it("filters nested files by pattern", async () => {
    const invoke = mockInvoke({ list_workspace_files: tree });
    const result = await executeTool(
      { name: "list_files", args: { pattern: ".tsx" } }, "/workspace", invoke,
    );
    expect(result).toContain("src/components/App.tsx");
    expect(result).not.toContain("main.ts");
  });
});

// ── Native tool definitions ───────────────────────────────────────────────────

describe("runnableTools / toolDefinitions", () => {
  it("keeps only the tools that actually run", () => {
    expect(runnableTools(["read_file", "todo_write", "web_search", "fs.append", "bash"]))
      .toEqual(["read_file", "fs.append"]);
  });

  it("offers runnable tools as JSON-schema definitions with provider-safe names", () => {
    const defs = toolDefinitions(["read_file", "fs.write", "web_search"]);
    expect(defs.map((d) => d.name)).toEqual(["read_file", "fs_write"]);
    expect(defs[0].parameters).toMatchObject({ type: "object", required: ["path"] });
    expect(defs[1].parameters).toMatchObject({ type: "object", required: ["path", "content"] });
    for (const d of toolDefinitions(["read_file", "fs.read", "list_files", "grep", "fs.write", "fs.append"])) {
      expect(d.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it("maps a native name back to the node's tool", () => {
    expect(nativeToolName("fs.append")).toBe("fs_append");
    expect(toolForNativeName("fs_append", ["read_file", "fs.append"])).toBe("fs.append");
    expect(toolForNativeName("fs_write", ["read_file"])).toBeNull();
    // Text-protocol aliases still resolve to the offered tool.
    expect(toolForNativeName("write_file", ["fs.write"])).toBe("fs.write");
  });
});

describe("executeTool — native (non-string) arguments", () => {
  it("coerces a numeric path and writes object content as JSON", async () => {
    const invoke = vi.fn(async () => undefined) as unknown as InvokeFn;
    await executeTool(
      { name: "fs.write", args: { path: 42, content: { ok: true } } }, "/workspace", invoke, ["fs.write"],
    );
    expect(invoke).toHaveBeenCalledWith("write_workspace_file", {
      workspacePath: "/workspace", relativePath: "42", content: JSON.stringify({ ok: true }, null, 2),
    });
  });
});
