import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const serverPath = join(root, "mcp", "server.mjs");

interface JsonRpcResponse {
  id: number | null;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function callMcp(requests: unknown[], env: Record<string, string> = {}) {
  return callMcpRaw(requests.map((request) => JSON.stringify(request)).join("\n") + "\n", env);
}

function callMcpRaw(input: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 90_000,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OLLAMA_API_KEY: "",
      OLLAMA_REMOTE_API_KEY: "",
      ...env,
    },
  });

  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);

  return { ...result, responses: lines };
}

function makeWorkspace() {
  const base = join(root, "outputs");
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "mcp-test-"));
}

function contentJson(response: JsonRpcResponse) {
  const text = response.result?.content?.[0]?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

function toolCall(id: number, name: string, args: unknown) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function callTool(name: string, args: unknown, env: Record<string, string> = {}) {
  return callMcp([toolCall(1, name, args)], env);
}

// Puts fake executables (e.g. npx, cargo) first on PATH; each one runs `script` with this Node.
// Lets tests drive the server's subprocess tools without real vitest/tsc/cargo or any network.
function fakeBinEnv(dir: string, names: string[], script: string) {
  const scriptPath = join(dir, "fake-bin.cjs");
  writeFileSync(scriptPath, script);
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${scriptPath}" %*\r\n`);
    } else {
      writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
      chmodSync(join(dir, name), 0o755);
    }
  }
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}` };
}

function writeAuditLog(workspace: string, lines: string[]) {
  const harnessDir = join(workspace, ".harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, "audit.log.jsonl"), lines.join("\n") + "\n");
}

// Round-trips one audit log entry through get_recent_logs and returns what the server emitted.
function redactedLogEntry(fields: Record<string, unknown>) {
  const workspace = makeWorkspace();
  try {
    writeAuditLog(workspace, [JSON.stringify({ id: "entry", timestamp: "2026-06-28T01:00:00.000Z", ...fields })]);
    const result = callTool("get_recent_logs", { workspace });
    const parsed = contentJson(result.responses[0]) as { entries?: Array<Record<string, unknown>> };
    return { stdout: result.stdout, entry: parsed.entries?.[0] ?? {} };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const fakeJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWc";

describe("Harness Studio MCP stdio server", () => {
  it("initializes and lists read/test tools", () => {
    const result = callMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    expect(result.status).toBe(0);
    expect(result.responses[0].result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "harness-studio", version: "0.1.0" },
    });
    expect(result.responses[1].result?.tools?.map((tool) => tool.name)).toEqual([
      "run_tests",
      "run_cargo_tests",
      "validate_workflow",
      "project_status",
      "list_workflows",
      "list_providers",
      "list_artifacts",
      "get_recent_logs",
    ]);
  });

  it("lists provider metadata without exposing environment secret values", () => {
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_providers", arguments: {} },
      },
    ], {
      OLLAMA_API_KEY: "sk-secret-value-that-must-not-appear",
    });

    expect(result.status).toBe(0);
    const parsed = contentJson(result.responses[0]) as {
      providers?: Array<{ id: string; credentialRef: string | null }>;
    };
    expect(parsed.providers?.some((provider) => provider.id === "ollama-cloud")).toBe(true);
    expect(parsed.providers?.find((provider) => provider.id === "ollama-cloud")?.credentialRef)
      .toBe("env:OLLAMA_API_KEY");
    expect(result.stdout).not.toContain("sk-secret-value-that-must-not-appear");
  });

  it("lists artifact file metadata from a workspace without reading content", () => {
    const workspace = makeWorkspace();
    try {
      const artifactDir = join(workspace, ".harness", "artifacts", "agent-a");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "report.md"), "# secret report\nsk-content-should-not-print\n");

      const result = callMcp([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_artifacts", arguments: { workspace } },
        },
      ]);

      expect(result.status).toBe(0);
      const parsed = contentJson(result.responses[0]) as {
        count?: number;
        artifacts?: Array<{ path: string; nodeId: string; name: string; sizeBytes: number }>;
      };
      expect(parsed.count).toBe(1);
      expect(parsed.artifacts?.[0]).toMatchObject({
        path: ".harness/artifacts/agent-a/report.md",
        nodeId: "agent-a",
        name: "report.md",
      });
      expect(parsed.artifacts?.[0].sizeBytes).toBeGreaterThan(0);
      expect(result.stdout).not.toContain("sk-content-should-not-print");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("marks artifacts truncated only when more exist than the limit", () => {
    const workspace = makeWorkspace();
    try {
      const artifactDir = join(workspace, ".harness", "artifacts", "agent-a");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "a.md"), "a");
      writeFileSync(join(artifactDir, "b.md"), "b");
      const exact = contentJson(callTool("list_artifacts", { workspace, limit: 2 }).responses[0]);

      writeFileSync(join(artifactDir, "c.md"), "c");
      const over = contentJson(callTool("list_artifacts", { workspace, limit: 2 }).responses[0]);

      expect(exact).toMatchObject({ count: 2, truncated: false });
      expect(over).toMatchObject({ count: 2, truncated: true });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports nodeId only for artifacts inside a node folder", () => {
    const workspace = makeWorkspace();
    try {
      const artifactsRoot = join(workspace, ".harness", "artifacts");
      mkdirSync(join(artifactsRoot, "agent-a"), { recursive: true });
      writeFileSync(join(artifactsRoot, "agent-a", "report.md"), "r");
      writeFileSync(join(artifactsRoot, "loose.md"), "l");
      const parsed = contentJson(callTool("list_artifacts", { workspace }).responses[0]) as {
        artifacts?: Array<{ path: string; nodeId: string | null }>;
      };

      expect(parsed.artifacts?.map(({ path, nodeId }) => ({ path, nodeId }))).toEqual([
        { path: ".harness/artifacts/agent-a/report.md", nodeId: "agent-a" },
        { path: ".harness/artifacts/loose.md", nodeId: null },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not follow symlinks or junctions inside the artifacts folder", () => {
    const workspace = makeWorkspace();
    try {
      const artifactsRoot = join(workspace, ".harness", "artifacts");
      const elsewhere = join(workspace, "elsewhere");
      mkdirSync(join(artifactsRoot, "agent-a"), { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(artifactsRoot, "agent-a", "report.md"), "r");
      writeFileSync(join(elsewhere, "outside.md"), "o");
      // "junction" needs no privileges on Windows; other platforms create a directory symlink.
      symlinkSync(elsewhere, join(artifactsRoot, "linked"), "junction");
      const parsed = contentJson(callTool("list_artifacts", { workspace }).responses[0]) as {
        artifacts?: Array<{ path: string }>;
      };

      expect(parsed.artifacts?.map((artifact) => artifact.path)).toEqual([".harness/artifacts/agent-a/report.md"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns recent audit logs newest first with key-like details redacted", () => {
    const workspace = makeWorkspace();
    try {
      const harnessDir = join(workspace, ".harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(join(harnessDir, "audit.log.jsonl"), [
        JSON.stringify({
          id: "old",
          timestamp: "2026-06-28T01:00:00.000Z",
          action: "file_read",
          path: "a.txt",
          success: true,
        }),
        JSON.stringify({
          id: "new",
          timestamp: "2026-06-28T02:00:00.000Z",
          action: "hook_executed",
          agentId: "agent-b",
          details: "token sk-secret-value-that-must-not-appear",
          success: false,
        }),
      ].join("\n") + "\n");

      const result = callMcp([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_recent_logs", arguments: { workspace, limit: 1 } },
        },
      ]);

      expect(result.status).toBe(0);
      const parsed = contentJson(result.responses[0]) as {
        count?: number;
        entries?: Array<{ id: string; details?: string }>;
      };
      expect(parsed.count).toBe(1);
      expect(parsed.entries?.[0].id).toBe("new");
      expect(parsed.entries?.[0].details).toContain("[REDACTED]");
      expect(result.stdout).not.toContain("sk-secret-value-that-must-not-appear");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["api_key=value", "api_key=abc123def456", "abc123def456"],
    ["a JSON token field inside a string", '{"token":"xyz789secret"}', "xyz789secret"],
    ["password=value", "password=hunter2", "hunter2"],
    ["GEMINI_API_KEY=value", "GEMINI_API_KEY=AIzaFAKEfakeFAKEfake00000000", "AIzaFAKEfakeFAKEfake00000000"],
    ["OLLAMA_API_KEY=value", "OLLAMA_API_KEY=0123456789abcdef", "0123456789abcdef"],
    ["an Authorization header with a short Bearer token", "Authorization: Bearer abc.def", "abc.def"],
    ["a bare short Bearer token", "retrying with Bearer abc.def", "abc.def"],
    ["an sk- key", "called with sk-FAKEfake0000", "sk-FAKEfake0000"],
    ["an sk-ant- key", "called with sk-ant-api03-FAKEfake0000", "sk-ant-api03-FAKEfake0000"],
    ["a bare AIza key", "called with AIzaFAKEfakeFAKEfake00000000", "AIzaFAKEfakeFAKEfake00000000"],
    ["a GitHub ghp_ token", "pushed with ghp_FAKEfakeFAKEfakeFAKEfake0000", "ghp_FAKEfakeFAKEfakeFAKEfake0000"],
    ["a GitHub fine-grained PAT", "pushed with github_pat_FAKEfake0000_FAKEfakeFAKE0000", "github_pat_FAKEfake0000_FAKEfakeFAKE0000"],
    ["a JWT", `session ${fakeJwt} expired`, fakeJwt],
  ])("redacts %s in log strings", (_label, details, secret) => {
    const { stdout, entry } = redactedLogEntry({ details });

    expect(entry.details).toContain("[REDACTED]");
    expect(stdout).not.toContain(secret);
  });

  it("redacts values of secret-named keys whatever their shape", () => {
    const { stdout, entry } = redactedLogEntry({
      api_key: "plainvalue-a",
      password: 424242,
      token: { nested: "plainvalue-b" },
      Authorization: ["plainvalue-c"],
      OPENAI_API_KEY: "plainvalue-d",
      accessToken: "plainvalue-e",
    });

    expect(entry).toMatchObject({
      api_key: "[REDACTED]",
      password: "[REDACTED]",
      token: "[REDACTED]",
      Authorization: "[REDACTED]",
      OPENAI_API_KEY: "[REDACTED]",
      accessToken: "[REDACTED]",
    });
    expect(stdout).not.toContain("plainvalue");
    expect(stdout).not.toContain("424242");
  });

  it("does not redact ordinary prose or token counters", () => {
    const { entry } = redactedLogEntry({
      details: "Token budget 5000",
      maxTokens: 4096,
      tokens: { used: 12, budget: 5000 },
    });

    expect(entry).toMatchObject({
      details: "Token budget 5000",
      maxTokens: 4096,
      tokens: { used: 12, budget: 5000 },
    });
  });

  it("counts log lines that are valid JSON but not objects as invalid", () => {
    const workspace = makeWorkspace();
    try {
      writeAuditLog(workspace, ["null", "42", "[]", '"text"', JSON.stringify({ id: "ok", timestamp: "2026-06-28T01:00:00.000Z" })]);
      const result = callTool("get_recent_logs", { workspace });

      expect(result.responses[0].result?.isError).toBeUndefined();
      expect(contentJson(result.responses[0])).toMatchObject({ count: 1, totalEntries: 1, invalidLines: 4 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("sorts log entries without a valid timestamp as the oldest", () => {
    const workspace = makeWorkspace();
    try {
      writeAuditLog(workspace, [
        JSON.stringify({ id: "old", timestamp: "2026-06-28T01:00:00.000Z" }),
        JSON.stringify({ id: "no-time" }),
        JSON.stringify({ id: "bad-time", timestamp: "not-a-date" }),
        JSON.stringify({ id: "new", timestamp: "2026-06-28T02:00:00.000Z" }),
      ]);
      const parsed = contentJson(callTool("get_recent_logs", { workspace }).responses[0]) as {
        entries?: Array<{ id: string }>;
      };

      expect(parsed.entries?.map((entry) => entry.id)).toEqual(["new", "old", "no-time", "bad-time"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reads only the last 5 MiB of a large audit log", () => {
    const workspace = makeWorkspace();
    try {
      writeAuditLog(workspace, [
        JSON.stringify({ id: "huge", timestamp: "2026-06-28T01:00:00.000Z", pad: "x".repeat(6 * 1024 * 1024) }),
        JSON.stringify({ id: "last", timestamp: "2026-06-28T02:00:00.000Z" }),
      ]);
      const parsed = contentJson(callTool("get_recent_logs", { workspace, limit: 1 }).responses[0]) as {
        totalEntries?: number;
        invalidLines?: number;
        entries?: Array<{ id: string }>;
      };

      // The tail starts inside the huge first line, which is dropped as a partial line.
      expect(parsed).toMatchObject({ totalEntries: 1, invalidLines: 0 });
      expect(parsed.entries?.[0].id).toBe("last");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects artifact and log workspace paths outside the project", () => {
    const outside = resolve(root, "..");
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_artifacts", arguments: { workspace: outside } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_recent_logs", arguments: { workspace: outside } },
      },
    ]);

    expect(result.status).toBe(0);
    const artifacts = contentJson(result.responses[0]);
    const logs = contentJson(result.responses[1]);
    expect(artifacts.error).toContain("Path rejected");
    expect(logs.error).toContain("Path rejected");
  });

  it("validates a workflow inside the project", () => {
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "validate_workflow",
          arguments: { path: "examples/purchasing-decision.harness.yaml" },
        },
      },
    ]);

    expect(result.status).toBe(0);
    const parsed = contentJson(result.responses[0]);
    expect(parsed.valid).toBe(true);
    expect(parsed.name).toBe("Purchasing Decision Assistant");
  });

  it("rejects path traversal and absolute paths outside the project", () => {
    const outside = resolve(root, "..", "outside.harness.yaml");
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "validate_workflow", arguments: { path: "../package.json" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "validate_workflow", arguments: { path: outside } },
      },
    ]);

    expect(result.status).toBe(0);
    const traversal = contentJson(result.responses[0]);
    const absolute = contentJson(result.responses[1]);
    expect(traversal.valid).toBe(false);
    expect(String(traversal.error)).toContain("Path rejected");
    expect(absolute.valid).toBe(false);
    expect(String(absolute.error)).toContain("Path rejected");
  });

  it("rejects unsafe test filters before spawning a subprocess", () => {
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_tests", arguments: { filter: "goalTemplates;echo-nope" } },
      },
    ]);

    expect(result.status).toBe(0);
    const parsed = contentJson(result.responses[0]);
    expect(parsed.success).toBe(false);
    expect(parsed.summary).toContain("Invalid test filter");
  });

  it("rejects test filters that look like CLI options", () => {
    // Fake npx on PATH: if a filter slips through, no real `vitest --watch` is started.
    const bin = makeWorkspace();
    try {
      const env = fakeBinEnv(bin, ["npx"], 'console.log("FAKE_NPX_RAN");');
      const result = callMcp(
        ["--watch", "-w", "--coverage"].map((filter, index) => toolCall(index + 1, "run_tests", { filter })),
        env,
      );

      expect(result.responses).toHaveLength(3);
      for (const response of result.responses) {
        expect(contentJson(response).summary).toContain("Invalid test filter");
      }
      expect(result.stdout).not.toContain("FAKE_NPX_RAN");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("returns a JSON-RPC error for unknown tools", () => {
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_file", arguments: {} },
      },
      toolCall(2, "toString", {}),
    ]);

    expect(result.status).toBe(0);
    expect(result.responses[0].error).toMatchObject({
      code: -32602,
      message: "Unknown tool: write_file",
    });
    // Inherited Object.prototype members are not tools either.
    expect(result.responses[1].error).toMatchObject({ code: -32602, message: "Unknown tool: toString" });
  });

  it("never responds to notifications (messages without an id)", () => {
    const result = callMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);

    expect(result.status).toBe(0);
    expect(result.responses.map((response) => response.id)).toEqual([1, 2]);
    expect(result.responses.every((response) => response.error === undefined)).toBe(true);
  });

  it("answers invalid JSON with -32700 and non-request values with -32600", () => {
    const result = callMcpRaw([
      "{not json",
      "null",
      '"just a string"',
      "[1,2]",
      JSON.stringify({ jsonrpc: "2.0", id: 7 }),
    ].join("\n") + "\n");

    expect(result.status).toBe(0);
    const invalidRequest = { code: -32600, message: "Invalid Request" };
    expect(result.responses).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: invalidRequest },
      { jsonrpc: "2.0", id: null, error: invalidRequest },
      { jsonrpc: "2.0", id: null, error: invalidRequest },
      { jsonrpc: "2.0", id: 7, error: invalidRequest },
    ]);
  });

  it("processes a final request that has no trailing newline", () => {
    const result = callMcpRaw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(result.status).toBe(0);
    expect(result.responses).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("reports the type check as failed when tsc exits non-zero without printing TS errors", () => {
    const bin = makeWorkspace();
    try {
      // Simulates npx failing to run tsc at all (e.g. missing binary): no "error TS" in the output.
      const env = fakeBinEnv(bin, ["npx"], 'console.log("npm error could not determine executable to run"); process.exitCode = 7;');
      const parsed = contentJson(callTool("project_status", {}, env).responses[0]);

      expect(parsed.tscExitCode).toBe(7);
      expect(parsed.typeCheckPassed).toBe(false);
      expect(String(parsed.typeCheckErrors)).toContain("could not determine executable");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("runs npx with --no-install so a missing binary is never downloaded", () => {
    const bin = makeWorkspace();
    try {
      const env = fakeBinEnv(bin, ["npx"], 'console.log("FAKE_NPX " + process.argv.slice(2).join(" ")); process.exitCode = 3;');
      const result = callMcp([
        toolCall(1, "run_tests", { filter: "mcpServer" }),
        toolCall(2, "project_status", {}),
      ], env);

      expect(String(contentJson(result.responses[0]).output)).toContain("FAKE_NPX --no-install vitest run mcpServer");
      expect(String(contentJson(result.responses[1]).typeCheckErrors)).toContain("FAKE_NPX --no-install tsc --noEmit");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("parses vitest counts when some tests fail", () => {
    const bin = makeWorkspace();
    try {
      const env = fakeBinEnv(bin, ["npx"], [
        'console.log(" Test Files  1 failed | 1 passed (2)");',
        'console.log("      Tests  3 failed | 4 passed (7)");',
        "process.exitCode = 1;",
      ].join("\n"));
      const parsed = contentJson(callTool("run_tests", {}, env).responses[0]);

      expect(parsed.counts).toEqual({ passed: 4, failed: 3, files: 1, runner: "vitest" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("sums every cargo test result line", () => {
    const bin = makeWorkspace();
    try {
      const env = fakeBinEnv(bin, ["cargo"], [
        'console.log("test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");',
        'console.log("test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out");',
        'console.log("test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out");',
        "process.exitCode = 101;",
      ].join("\n"));
      const parsed = contentJson(callTool("run_cargo_tests", {}, env).responses[0]);

      expect(parsed.counts).toEqual({ passed: 6, failed: 1, files: null, runner: "cargo" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("handles test output larger than spawnSync's default 1 MiB buffer", () => {
    const bin = makeWorkspace();
    try {
      const env = fakeBinEnv(bin, ["npx"], [
        'process.stdout.write("x".repeat(2 * 1024 * 1024) + "\\n");',
        'console.log("      Tests  5 passed (5)");',
      ].join("\n"));
      const parsed = contentJson(callTool("run_tests", {}, env).responses[0]);

      expect(parsed.spawnError).toBeNull();
      expect(parsed.counts).toMatchObject({ passed: 5, failed: 0 });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reports a tool that throws as an isError result, not a JSON-RPC error", () => {
    // `arguments: null` makes validate_workflow's parameter destructuring throw inside run().
    const result = callTool("validate_workflow", null);

    expect(result.status).toBe(0);
    expect(result.responses[0].error).toBeUndefined();
    expect(result.responses[0].result?.isError).toBe(true);
    expect(result.responses[0].result?.content?.[0].type).toBe("text");
    expect(result.responses[0].result?.content?.[0].text).toContain("Tool error");
  });
});
