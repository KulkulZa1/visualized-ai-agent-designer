import { describe, it, expect, vi } from "vitest";
import {
  executeTool,
  readToolCall,
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

// ── readToolCall ──────────────────────────────────────────────────────────────

const FENCE = "`".repeat(3);

describe("readToolCall", () => {
  it("reads a valid call", () => {
    expect(readToolCall(`<tool_call>{"name":"grep","args":{"path":"a","pattern":"b"}}</tool_call>`))
      .toEqual({ kind: "call", call: { name: "grep", args: { path: "a", pattern: "b" } } });
  });

  it("reads JSON wrapped in a ```, ```json, ```jsonc or ```javascript fence inside the tags", () => {
    const call = { name: "read_file", args: { path: "src/main.ts" } };
    const json = JSON.stringify(call);
    const bodies = [
      `${FENCE}json\n${json}\n${FENCE}`,
      `${FENCE}\n${json}\n${FENCE}`,
      `\n  ${FENCE}JSON\r\n${json}\r\n${FENCE}\n`,
      `${FENCE}json ${json}${FENCE}`,
      `${FENCE}jsonc\n${json}\n${FENCE}`,
      `${FENCE}javascript\n${json}\n${FENCE}`,
      `${FENCE}JavaScript\r\n${json}\r\n${FENCE}`,
    ];
    for (const body of bodies) {
      expect(readToolCall(`Reading.\n<tool_call>${body}</tool_call>`), body).toEqual({ kind: "call", call });
    }
  });

  it("reads JSON wrapped in a ```js, ```ts, ```typescript or ```json5 fence inside the tags", () => {
    const call = { name: "read_file", args: { path: "src/main.ts" } };
    const json = JSON.stringify(call);
    const bodies = [
      `${FENCE}js\n${json}\n${FENCE}`,
      `${FENCE}ts\n${json}\n${FENCE}`,
      `${FENCE}typescript\n${json}\n${FENCE}`,
      `${FENCE}json5\n${json}\n${FENCE}`,
      `\n  ${FENCE}JS\r\n${json}\r\n${FENCE}\n`,
      `${FENCE}TypeScript\r\n${json}\r\n${FENCE}`,
      `${FENCE}ts ${json}${FENCE}`,
      `${FENCE}json5 ${json}${FENCE}`,
    ];
    for (const body of bodies) {
      expect(readToolCall(`Reading.\n<tool_call>${body}</tool_call>`), body).toEqual({ kind: "call", call });
    }
  });

  it("keeps a code fence inside a string argument", () => {
    const call = { name: "fs.write", args: { path: "README.md", content: `${FENCE}js\nrun()\n${FENCE}` } };
    expect(readToolCall(`<tool_call>${JSON.stringify(call)}</tool_call>`)).toEqual({ kind: "call", call });
    expect(readToolCall(`<tool_call>${FENCE}json\n${JSON.stringify(call)}\n${FENCE}</tool_call>`))
      .toEqual({ kind: "call", call });
    expect(readToolCall(`<tool_call>${FENCE}ts\n${JSON.stringify(call)}\n${FENCE}</tool_call>`))
      .toEqual({ kind: "call", call });
  });

  it("does not stall on a very long run of whitespace inside the block, fenced or not", () => {
    // A regex that scans for the closing fence backtracks quadratically over the run (about
    // 4 s at this size) once the body is fenced; an unfenced body never reaches that regex.
    const call = { name: "fs.write", args: { path: "a.txt", content: " ".repeat(100_000) } };
    const json = JSON.stringify(call);
    for (const [label, body] of [["unfenced", json], ["fenced", `${FENCE}json\n${json}\n${FENCE}`]]) {
      const started = Date.now();
      expect(readToolCall(`<tool_call>${body}</tool_call>`), label).toEqual({ kind: "call", call });
      expect(Date.now() - started, label).toBeLessThan(1000);
    }
  });

  it("gives a call without args (or with null args) an empty args object", () => {
    expect(readToolCall(`<tool_call>{"name":"list_files"}</tool_call>`))
      .toEqual({ kind: "call", call: { name: "list_files", args: {} } });
    expect(readToolCall(`<tool_call>{"name":"list_files","args":null}</tool_call>`))
      .toEqual({ kind: "call", call: { name: "list_files", args: {} } });
  });

  it("finds no call in prose, even when the reply mentions the tag", () => {
    for (const text of [
      "just some text",
      "Use the <tool_call> tag to call a tool.",
      "<tool_call>not-json</tool_call>",
      "<tool_call>call read_file with path a.ts</tool_call>",
      `<tool_call>${FENCE}python\nprint(1)\n${FENCE}</tool_call>`,
      `<tool_call>${FENCE}ts\nconst x = 1;\n${FENCE}</tool_call>`,
      "<tool_call>[1, 2]</tool_call>",
      "<tool_call></tool_call>",
      // The tag mentioned without a closing tag: what follows it is not a call either.
      "Wrap the call in a <tool_call>",
      "Use <tool_call>read_file a.ts and stop.",
      `<tool_call>${FENCE}python\nprint(1)`,
      "<tool_call>[1, 2]",
      // A closed mention, and a stray closing tag.
      "Use <tool_call>x</tool_call> like so.",
      "</tool_call> ends a call.",
    ]) {
      expect(readToolCall(text), text).toEqual({ kind: "none" });
    }
  });

  it("reports a block that starts with { but is not a valid call, with a reason", () => {
    const bad: Array<[string, RegExp]> = [
      [`{"name":"read_file","args":{"path":"a"},}`, /./],       // trailing comma
      [`{"name":"read_file","args":{"path":"a"}`, /./],         // cut off
      [`{'name':'read_file'}`, /./],                             // single quotes
      [`{"args":{}}`, /name/],
      [`{"name":42}`, /name/],
      [`{"name":"read_file","args":"a.ts"}`, /args/],
      [`{"name":"read_file","args":["a.ts"]}`, /args/],
    ];
    for (const [json, reason] of bad) {
      for (const body of [json, `${FENCE}json\n${json}\n${FENCE}`, `${FENCE}ts\n${json}\n${FENCE}`]) {
        const reading = readToolCall(`<tool_call>${body}</tool_call>`);
        expect(reading.kind, body).toBe("malformed");
        expect(reading.kind === "malformed" && reading.reason, body).toMatch(reason);
      }
    }
  });

  it("reports a call cut off before </tool_call> as malformed, whatever it holds so far", () => {
    const jsons = [
      `{"name":"read_file","args":{"path":"a`,     // cut off inside a string
      `{"name":"read_file","args":`,                // cut off after a key
      `{"name":"read_file","args":{"path":"a"}}`,  // complete JSON, but the tag is never closed
      "{",
    ];
    for (const json of jsons) {
      for (const body of [
        json,
        `\n  ${json}`,
        `${FENCE}json\n${json}`,
        `${FENCE}javascript\n${json}\n${FENCE}`,
        `${FENCE}ts\n${json}`,
        `${FENCE}json5\n${json}\n${FENCE}`,
      ]) {
        for (const text of [`<tool_call>${body}`, `Reading a.\n<tool_call>${body}`]) {
          const reading = readToolCall(text);
          expect(reading.kind, text).toBe("malformed");
          expect(reading.kind === "malformed" && reading.reason, text).toMatch(/cut off before <\/tool_call>/);
        }
      }
    }
  });

  it("reports the cut-off call when an earlier mention of the tag is closed or unclosed", () => {
    for (const text of [
      `Use <tool_call>x</tool_call> like so.\n<tool_call>{"name":"read_file","args":{"path":"a`,
      `Use the <tool_call> tag.\n<tool_call>{"name":"read_file","args":{"path":"a`,
    ]) {
      const reading = readToolCall(text);
      expect(reading.kind, text).toBe("malformed");
      expect(reading.kind === "malformed" && reading.reason, text).toMatch(/cut off before <\/tool_call>/);
    }
  });

  it("reads the first closed call even when a later one is cut off", () => {
    const text = `<tool_call>{"name":"list_files"}</tool_call>\n<tool_call>{"name":"read_file","args":{"path":"a`;
    expect(readToolCall(text)).toEqual({ kind: "call", call: { name: "list_files", args: {} } });
  });

  it("does not stall on a very long run of whitespace in a call cut off inside a fence", () => {
    // Cut off after the run, so the body has an opening fence, no closing one, and text after the spaces.
    const text = `<tool_call>${FENCE}json\n{"name":"fs.write","args":{"path":"a.txt","content":"${" ".repeat(100_000)}tail`;
    const started = Date.now();
    expect(readToolCall(text).kind).toBe("malformed");
    expect(Date.now() - started).toBeLessThan(1000);
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

  it("removes a call cut off before its closing tag, keeping the text around the rest", () => {
    expect(stripToolCall(`Before\n<tool_call>{"name":"read_file","args":{"path":"a`)).toBe("Before");
    expect(stripToolCall(`Before\n<tool_call>${FENCE}json\n{"name":"read_file"`)).toBe("Before");
    expect(stripToolCall(`<tool_call>{"name":"x","args":{}}</tool_call>\nAfter\n<tool_call>{"name":"y"`)).toBe("After");
  });

  it("keeps the tag mentioned in prose", () => {
    expect(stripToolCall("Use the <tool_call> tag.")).toBe("Use the <tool_call> tag.");
    expect(stripToolCall("Use <tool_call>read_file a.ts")).toBe("Use <tool_call>read_file a.ts");
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

  it("offers bash when listed, saying each command needs the user's approval", () => {
    const instructions = buildToolInstructions(["bash"]);
    expect(instructions).toContain("• bash:");
    expect(instructions).toContain("approve");
  });

  it("tells the model to start a program in the workspace folder by path on Windows", () => {
    // Commands run with NoDefaultCurrentDirectoryInExePath=1, so cmd.exe finds .\build.bat but not build.bat.
    const [bash] = toolDefinitions(["bash"]);
    for (const text of [buildToolInstructions(["bash"]), bash.description]) {
      expect(text).toContain("On Windows");
      expect(text).toContain(".\\build.bat");
    }
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

  it("refuses to overwrite an existing file it cannot read, and records nothing", async () => {
    const written: string[] = [];
    const onChange = vi.fn();
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_workspace_file") throw new Error("IO error: stream did not contain valid UTF-8");
      if (cmd === "write_workspace_file") { written.push(args?.content as string); return undefined; }
      throw new Error(`Unexpected: ${cmd}`);
    }) as unknown as InvokeFn;

    const result = await executeTool(
      { name: "fs.write", args: { path: "data.csv", content: "x" } },
      "/workspace", invoke, ["fs.write"], onChange,
    );

    expect(result).toMatch(/^\[error\] fs\.write could not read data\.csv; nothing was written: .*UTF-8/);
    expect(written).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["(os error 2)", "(os error 3)"])(
    "still creates a file the read reports as missing %s, recording it as new",
    async (code) => {
      const written: string[] = [];
      const onChange = vi.fn();
      const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        // Rust io::Error text is localized, but the "(os error N)" suffix is not.
        if (cmd === "read_workspace_file") throw new Error(`IO error: 지정된 경로를 찾을 수 없습니다. ${code}`);
        if (cmd === "write_workspace_file") { written.push(args?.content as string); return undefined; }
        throw new Error(`Unexpected: ${cmd}`);
      }) as unknown as InvokeFn;

      const result = await executeTool(
        { name: "fs.write", args: { path: "new/out.txt", content: "hello" } },
        "/workspace", invoke, ["fs.write"], onChange,
      );

      expect(result).toContain("Written");
      expect(written).toEqual(["hello"]);
      expect(onChange).toHaveBeenCalledWith("new/out.txt", null, "hello");
    },
  );

  it.each([
    ["left out", { path: "a.txt" }],
    ["null", { path: "a.txt", content: null }],
  ])("returns an error and writes nothing when content is %s", async (_case, args) => {
    const invoke = vi.fn() as unknown as InvokeFn;
    const onChange = vi.fn();
    for (const name of ["fs.write", "write_file"]) {
      const result = await executeTool({ name, args }, "/workspace", invoke, ["fs.write"], onChange);
      expect(result).toBe("[error] fs.write requires 'content'");
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("writes an empty file when content is an explicit empty string", async () => {
    const files: Record<string, string> = { "a.txt": "old" };
    const result = await executeTool(
      { name: "fs.write", args: { path: "a.txt", content: "" } },
      "/workspace", fileInvoke(files), ["fs.write"],
    );
    expect(result).toBe("Written: a.txt (0 chars)");
    expect(files["a.txt"]).toBe("");
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

  it.each([
    ["left out", { path: "log.txt" }],
    ["null", { path: "log.txt", content: null }],
  ])("returns an error and writes nothing when content is %s", async (_case, args) => {
    const invoke = vi.fn() as unknown as InvokeFn;
    const onChange = vi.fn();
    for (const name of ["fs.append", "append_file"]) {
      const result = await executeTool({ name, args }, "/workspace", invoke, ["fs.append"], onChange);
      expect(result).toBe("[error] fs.append requires 'content'");
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts an explicit empty string as content", async () => {
    const files: Record<string, string> = { "log.txt": "kept\n" };
    const result = await executeTool(
      { name: "fs.append", args: { path: "log.txt", content: "" } },
      "/workspace", fileInvoke(files), ["fs.append"],
    );
    expect(result).toBe("Appended to: log.txt (+0 chars)");
    expect(files["log.txt"]).toBe("kept\n");
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
    // Commands run only through a workflow node's approval prompt (commandTool.ts).
    const invoke = vi.fn() as unknown as InvokeFn;
    const result = await executeTool(
      { name, args: { command: "echo test" } },
      "/workspace",
      invoke,
      ["bash"],
    );
    expect(result).toContain("[error]");
    expect(result).toContain("approves");
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
      .toEqual(["read_file", "fs.append", "bash"]);
  });

  it("offers bash with a required command line", () => {
    const [bash] = toolDefinitions(["bash"]);
    expect(bash.name).toBe("bash");
    expect(bash.parameters).toMatchObject({ type: "object", required: ["command"] });
  });

  it("offers runnable tools as JSON-schema definitions with provider-safe names", () => {
    const defs = toolDefinitions(["read_file", "fs.write", "web_search"]);
    expect(defs.map((d) => d.name)).toEqual(["read_file", "fs_write", "edit_file"]);
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

describe("subagent_dispatch definition", () => {
  it("is runnable and offered with a required task, a name and a tools list", () => {
    expect(runnableTools(["subagent_dispatch", "todo_write"])).toEqual(["subagent_dispatch"]);
    const [def] = toolDefinitions(["subagent_dispatch"]);
    expect(def.name).toBe("subagent_dispatch");
    expect(def.parameters).toMatchObject({
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        name: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("is described in the text protocol too", () => {
    expect(buildToolInstructions(["subagent_dispatch"])).toContain("• subagent_dispatch:");
  });
});

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

  it.each([
    ["left out", { path: "a.ts", old_string: "a" }],
    ["null", { path: "a.ts", old_string: "a", new_string: null }],
  ])("returns an error and writes nothing when new_string is %s", async (_case, args) => {
    const files: Record<string, string> = { "a.ts": "a();\n" };
    const invoke = fileInvoke(files);
    const onChange = vi.fn();

    const result = await executeTool({ name: "edit_file", args }, "/workspace", invoke, ["fs.write"], onChange);

    expect(result).toBe("[error] edit_file requires 'new_string'");
    expect(invoke).not.toHaveBeenCalled();
    expect(files["a.ts"]).toBe("a();\n");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes the snippet when new_string is an explicit empty string", async () => {
    const files: Record<string, string> = { "a.ts": "a();\nb();\n" };
    const result = await executeTool(
      { name: "edit_file", args: { path: "a.ts", old_string: "b();\n", new_string: "" } },
      "/workspace", fileInvoke(files), ["fs.write"],
    );
    expect(result).toBe("Edited: a.ts (1 replacement)");
    expect(files["a.ts"]).toBe("a();\n");
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

// ── executeTool — protected paths ─────────────────────────────────────────────

/** Every way an agent can write a file; each call would succeed on an ordinary path. */
const WRITE_CALLS: Array<[string, (path: string) => { name: string; args: Record<string, unknown> }]> = [
  ["fs.write", (path) => ({ name: "fs.write", args: { path, content: "x" } })],
  ["write_file", (path) => ({ name: "write_file", args: { path, content: "x" } })],
  ["fs.append", (path) => ({ name: "fs.append", args: { path, content: "x" } })],
  ["append_file", (path) => ({ name: "append_file", args: { path, content: "x" } })],
  ["edit_file", (path) => ({ name: "edit_file", args: { path, old_string: "a", new_string: "b" } })],
];

const PROTECTED_PATHS = [
  // git internals, at any depth
  ".git/hooks/pre-commit",
  ".git/config",
  "vendor/x/.git/hooks/post-checkout",
  ".git", // worktrees and submodules use a .git *file*
  "vendor/x/.git",
  // hook scripts and the audit log
  ".harness/hooks/pre-run.sh",
  ".harness/hooks/nested/guard.py",
  ".harness/hooks",
  ".harness/audit.log.jsonl",
  // run records, which a resumed run trusts
  ".harness/runs/run-1/run.json",
  ".harness/runs",
  // the same places, spelled another way
  ".git\\hooks\\pre-commit",
  "./.git/config",
  "src/../.git/hooks/x",
  "a/b/../../.harness/hooks/x.sh",
  "src//./.git/config",
  ".GIT/Config",
  ".Harness/HOOKS/x.sh",
  ".harness\\Audit.Log.JSONL",
  ".Harness\\RUNS\\run-1\\run.json",
  "  .git/config  ",
  // Their text cannot place them under the workspace root, yet the backend accepts
  // an absolute or ../<workspace> path that lands inside it.
  "/home/user/ws/.harness/hooks/x.sh",
  "C:\\ws\\.harness\\audit.log.jsonl",
  "../ws/.harness/hooks/x.sh",
  "src/../../ws/.harness/audit.log.jsonl",
  "/home/user/ws/.git/config",
  "../ws/.harness/runs/run-1/run.json",
];

const LOOKALIKE_PATHS = [
  ".gitignore",
  ".github/workflows/ci.yml",
  "src/git/x.ts",
  ".harness/hooks-old/a.sh",
  ".harness/audit.log.jsonl.bak",
  ".harness/runs-old/run.json",
  ".harness/inputs/requirements.yaml",
  "hooks/pre-commit",
];

describe("executeTool — protected paths", () => {
  it.each(PROTECTED_PATHS)("refuses %s for every write tool: nothing read or written, no change recorded", async (path) => {
    for (const [tool, makeCall] of WRITE_CALLS) {
      const invoke = vi.fn(async () => { throw new Error("no file access expected"); }) as unknown as InvokeFn;
      const onChange = vi.fn();

      const result = await executeTool(makeCall(path), "/workspace", invoke, ["fs.write", "fs.append"], onChange);

      expect(result, `${tool} ${path}`).toMatch(/^\[error\] .*protected/);
      expect(result, `${tool} ${path}`).toContain(path.trim());
      expect(result, `${tool} ${path}`).toContain("nothing was written");
      expect(invoke, `${tool} ${path}`).not.toHaveBeenCalled();
      expect(onChange, `${tool} ${path}`).not.toHaveBeenCalled();
    }
  });

  it("leaves an existing protected file as it was", async () => {
    const files: Record<string, string> = { ".git/hooks/pre-commit": "#!/bin/sh\n", ".harness/audit.log.jsonl": "{}\n" };
    const before = { ...files };
    const tools = ["fs.write", "fs.append"];
    for (const path of Object.keys(files)) {
      for (const [, makeCall] of WRITE_CALLS) {
        await executeTool(makeCall(path), "/workspace", fileInvoke(files), tools);
      }
    }
    expect(files).toEqual(before);
  });

  it.each(LOOKALIKE_PATHS)("still writes, appends to and edits %s", async (path) => {
    const files: Record<string, string> = { [path]: "a" };
    const changed: string[] = [];
    const onChange = (p: string) => { changed.push(p); };
    const invoke = fileInvoke(files);
    const tools = ["fs.write", "fs.append"];

    expect(await executeTool({ name: "fs.write", args: { path, content: "a" } }, "/w", invoke, tools, onChange))
      .toMatch(/^Written/);
    expect(await executeTool({ name: "fs.append", args: { path, content: "b" } }, "/w", invoke, tools, onChange))
      .toMatch(/^Appended/);
    expect(await executeTool({ name: "edit_file", args: { path, old_string: "ab", new_string: "c" } }, "/w", invoke, tools, onChange))
      .toMatch(/^Edited/);

    expect(files[path]).toBe("c");
    expect(changed).toEqual([path, path, path]);
  });

  it.each([".git/config", ".harness/hooks/pre-run.sh", ".harness/audit.log.jsonl"])("still reads %s", async (path) => {
    const invoke = mockInvoke({ read_workspace_file: "line one\nsecret" });
    expect(await executeTool({ name: "read_file", args: { path } }, "/workspace", invoke)).toContain("line one");
    expect(await executeTool({ name: "fs.read", args: { path } }, "/workspace", invoke)).toContain("line one");
    expect(await executeTool({ name: "grep", args: { path, pattern: "secret" } }, "/workspace", invoke)).toContain("2: secret");
  });

  it("names the missing permission before the protected path", async () => {
    const result = await executeTool({ name: "fs.write", args: { path: ".git/config", content: "x" } }, "/workspace", mockInvoke({}), []);
    expect(result).toContain("not enabled");
  });
});
