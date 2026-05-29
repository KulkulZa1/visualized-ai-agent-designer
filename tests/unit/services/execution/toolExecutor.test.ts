import { describe, it, expect, vi } from "vitest";
import {
  executeTool,
  parseToolCall,
  stripToolCall,
  buildToolInstructions,
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

  it("includes bash in write/execute section when allowed", () => {
    const instructions = buildToolInstructions(["bash"]);
    expect(instructions).toContain("bash");
    expect(instructions).toContain("WRITE / EXECUTE TOOLS");
  });

  it("separates read and write sections when both present", () => {
    const instructions = buildToolInstructions(["read_file", "fs.write", "bash"]);
    expect(instructions).toContain("read_file");
    expect(instructions).toContain("WRITE / EXECUTE TOOLS");
    expect(instructions).toContain("bash");
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

  it("creates file when it does not exist", async () => {
    let written = "";
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_workspace_file") throw new Error("not found");
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

  it("executes command and returns output", async () => {
    const invoke = mockInvoke({
      execute_inline_command: { exitCode: 0, stdout: "test output", stderr: "", durationMs: 50 },
    });
    const result = await executeTool(
      { name: "bash", args: { command: "echo test" } },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("exit 0");
    expect(result).toContain("test output");
  });

  it("run_command alias works when bash is allowed", async () => {
    const invoke = mockInvoke({
      execute_inline_command: { exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 },
    });
    const result = await executeTool(
      { name: "run_command", args: { command: "echo ok" } },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("exit 0");
  });

  it("reports non-zero exit code", async () => {
    const invoke = mockInvoke({
      execute_inline_command: { exitCode: 1, stdout: "", stderr: "command failed", durationMs: 5 },
    });
    const result = await executeTool(
      { name: "bash", args: { command: "false" } },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("exit 1");
    expect(result).toContain("command failed");
  });

  it("returns error when command is missing", async () => {
    const invoke = mockInvoke({});
    const result = await executeTool(
      { name: "bash", args: {} },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("[error]");
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
