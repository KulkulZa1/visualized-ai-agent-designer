import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CATALOG } from "@/services/model-providers/providerCatalog";

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

// `server` defaults to the real server; a test can pass a copy placed in a scratch project.
// `timeoutMs` kills a server that has not finished by then (it has no exit status afterwards).
function callMcp(requests: unknown[], env: Record<string, string> = {}, server = serverPath, timeoutMs = 90_000) {
  return callMcpRaw(requests.map((request) => JSON.stringify(request)).join("\n") + "\n", env, server, timeoutMs);
}

function callMcpRaw(input: string, env: Record<string, string> = {}, server = serverPath, timeoutMs = 90_000) {
  const result = spawnSync(process.execPath, [server], {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: timeoutMs,
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

function callTool(name: string, args: unknown, env: Record<string, string> = {}, server = serverPath, timeoutMs = 90_000) {
  return callMcp([toolCall(1, name, args)], env, server, timeoutMs);
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

  it("reports native tool calling for Ollama and streaming and tool calling for the OpenAI-compatible endpoint, as the app's catalog does", () => {
    const result = callTool("list_providers", {});

    const parsed = contentJson(result.responses[0]) as {
      providers?: Array<{ id: string; capabilities: Record<string, boolean> }>;
    };
    const providers = parsed.providers ?? [];
    const capabilities = (id: string) => providers.find((provider) => provider.id === id)?.capabilities;
    expect(capabilities("ollama")).toMatchObject({ streaming: true, toolCalling: true });
    expect(capabilities("ollama-cloud")).toMatchObject({ streaming: true, toolCalling: true });
    expect(capabilities("openai-compatible")).toMatchObject({ streaming: true, toolCalling: true });
    // [KEEP-IN-SYNC] the MCP server keeps its own copy of the catalog: no provider's flags may drift from the app's.
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.capabilities, provider.id)
        .toEqual(DEFAULT_PROVIDER_CATALOG.find((entry) => entry.id === provider.id)?.capabilities);
    }
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

// ── validate_workflow, project_status and limit handling ─────────────────────────

// Folders made by these helpers are removed after every test.
const trackedDirs: string[] = [];
afterEach(() => {
  for (const dir of trackedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trackedWorkspace() {
  const dir = makeWorkspace();
  trackedDirs.push(dir);
  return dir;
}

// A folder outside the project, for symlinks that try to escape it.
function trackedOutsideDir() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-outside-"));
  trackedDirs.push(dir);
  return dir;
}

// True where mkfifo can make a named pipe in a workspace (not on Windows). Tests that need one are
// skipped elsewhere.
const canMakeFifo = (() => {
  if (process.platform === "win32") return false;
  const dir = makeWorkspace();
  try {
    return spawnSync("mkfifo", [join(dir, "pipe")]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// A named pipe with nothing writing to it: opening it for reading blocks until something opens it
// for writing.
function makeFifo(path: string) {
  expect(spawnSync("mkfifo", [path]).status).toBe(0);
}

// A copy of the server in a scratch project inside outputs/ (yaml and zod still resolve from
// the repo's node_modules): the server's project root is the folder above its own file, so this
// lets a test decide which files exist in the project, under tests/ or anywhere else.
async function makeSandboxProject() {
  const { default: source } = await import("../../../mcp/server.mjs?raw");
  const dir = trackedWorkspace();
  mkdirSync(join(dir, "mcp"));
  const server = join(dir, "mcp", "server.mjs");
  writeFileSync(server, source);
  return { dir, server };
}

// A valid workflow with `agentCount` agents (saved ids agent-0, agent-1, ...) and the given
// [source, target] connections.
function workflowYaml(agentCount: number, connections: Array<[string, string]> = []) {
  const agent = (i: number) => [
    `  - name: Agent ${i}`,
    "    role: worker",
    "    model: test-model",
    "    temperature: 0.5",
    "    maxTokens: 1024",
    "    maxSteps: 5",
    "    timeoutSeconds: 60",
    "    promptSource: { type: inline, content: Do the work. }",
    "    tools: []",
    "    memoryRead: []",
    "    memoryWrite: []",
    "    tokens: { used: 0, budget: 2000 }",
    "    status: idle",
  ].join("\n");
  return [
    "meta:",
    "  name: Fixture",
    '  version: "1.0.0"',
    "  description: fixture",
    '  projectRoot: ""',
    '  createdAt: "2026-01-01T00:00:00Z"',
    '  updatedAt: "2026-01-01T00:00:00Z"',
    agentCount > 0 ? "agents:" : "agents: []",
    ...Array.from({ length: agentCount }, (_, i) => agent(i)),
    connections.length > 0 ? "connections:" : "connections: []",
    ...connections.map(([source, target], i) =>
      `  - { id: c-${i}, sourceAgentId: ${JSON.stringify(source)}, targetAgentId: ${JSON.stringify(target)} }`),
    "executionSettings: { maxParallel: 1, timeoutSeconds: 600, retryOnFailure: false, maxRetries: 0 }",
    "nodePositions: {}",
    "",
  ].join("\n");
}

// Runs validate_workflow; `stdout` is everything the server sent, for leak checks.
function validateWorkflow(path: string) {
  const result = callTool("validate_workflow", { path });
  expect(result.status).toBe(0);
  return { stdout: result.stdout, parsed: contentJson(result.responses[0]) };
}

// Writes `yaml` to `name` in a fresh in-project folder and validates it by absolute path.
function validateWorkflowText(name: string, yaml: string) {
  const file = join(trackedWorkspace(), name);
  writeFileSync(file, yaml);
  return validateWorkflow(file);
}

interface WorkflowIssues {
  valid?: boolean;
  error?: string;
  issues?: Array<{ path: string; message: string }>;
}

describe("MCP validate_workflow: connection references", () => {
  it("accepts connections between existing agents, including the last one", () => {
    const { parsed } = validateWorkflowText("ok.harness.yaml", workflowYaml(3, [["agent-0", "agent-1"], ["agent-2", "agent-0"]]));

    expect(parsed).toMatchObject({ valid: true, agents: 3, connections: 2 });
  });

  const dangling: Array<[string, Array<[string, string]>, string[]]> = [
    ["a target that does not exist", [["agent-0", "agent-9"]], ["connections.0.targetAgentId"]],
    ["a source that does not exist", [["ghost", "agent-1"]], ["connections.0.sourceAgentId"]],
    ["the first index past the last agent", [["agent-0", "agent-2"]], ["connections.0.targetAgentId"]],
    ["a non-canonical id", [["agent-01", "agent-1"]], ["connections.0.sourceAgentId"]],
    ["both ends of a later connection", [["agent-0", "agent-1"], ["x", "y"]], ["connections.1.sourceAgentId", "connections.1.targetAgentId"]],
  ];

  it.each(dangling)("reports %s as invalid", (_label, connections, paths) => {
    const { parsed } = validateWorkflowText("dangling.harness.yaml", workflowYaml(2, connections));
    const { valid, issues } = parsed as WorkflowIssues;

    expect(valid).toBe(false);
    expect(issues?.map((issue) => issue.path)).toEqual(paths);
    for (const issue of issues ?? []) {
      expect(issue.message).toContain("Unknown agent");
      expect(issue.message).toContain("agent-0 to agent-1");
    }
  });

  it("names the offending id in the message", () => {
    const { parsed } = validateWorkflowText("dangling.harness.yaml", workflowYaml(2, [["agent-0", "agent-7"]]));

    expect((parsed as WorkflowIssues).issues?.[0].message).toContain('"agent-7"');
  });

  it("reports both ends when the workflow has no agents at all", () => {
    const { parsed } = validateWorkflowText("no-agents.harness.yaml", workflowYaml(0, [["agent-0", "agent-1"]]));
    const { valid, issues } = parsed as WorkflowIssues;

    expect(valid).toBe(false);
    expect(issues?.map((issue) => issue.path)).toEqual(["connections.0.sourceAgentId", "connections.0.targetAgentId"]);
    expect(issues?.[0].message).toContain("no agents");
  });

  it("still reports schema errors when the shape is wrong", () => {
    const yaml = workflowYaml(2, [["agent-0", "agent-1"]]).replace("role: worker", "role: superagent");
    const { parsed } = validateWorkflowText("bad-role.harness.yaml", yaml);
    const { valid, issues } = parsed as WorkflowIssues;

    expect(valid).toBe(false);
    expect(issues?.map((issue) => issue.path)).toContain("agents.0.role");
  });
});

describe("MCP validate_workflow: which files it reads", () => {
  // Not valid YAML: a parse error message would quote both lines (this shape leaked a line of
  // .env.example). Nothing of this may ever come back.
  const leakyYaml = "first_line_marker: PREVMARKER\nfirst_line_marker: SECRETMARKER\n";
  const leakMarkers = ["PREVMARKER", "SECRETMARKER", "first_line_marker"];

  function expectNoLeak(stdout: string) {
    for (const marker of leakMarkers) expect(stdout).not.toContain(marker);
  }

  function expectWorkflowFileRefusal(parsed: Record<string, unknown>) {
    expect(Object.keys(parsed).sort()).toEqual(["error", "valid"]);
    expect(parsed.valid).toBe(false);
    expect(String(parsed.error)).toMatch(/\.harness\.yaml or \.harness\.yml/);
  }

  it.each(["secrets.env", "notes.txt", "workflow.yaml", "harness.yaml", "wf.harness.yaml.bak", "wf.harness.json"])(
    "refuses %s without reading it",
    (name) => {
      const { stdout, parsed } = validateWorkflowText(name, leakyYaml);

      expectWorkflowFileRefusal(parsed);
      expectNoLeak(stdout);
    },
  );

  it("refuses a workflow-shaped file that lacks the .harness.yaml/.yml name", () => {
    const { parsed } = validateWorkflowText("workflow.yaml", workflowYaml(2, [["agent-0", "agent-1"]]));

    expectWorkflowFileRefusal(parsed);
  });

  it.each([".env.example", "package.json", "README.md"])("refuses the project file %s", (path) => {
    const { parsed } = validateWorkflow(path);

    expectWorkflowFileRefusal(parsed);
  });

  it("checks the file name before the disk, so a refusal does not say whether a file exists", () => {
    const { parsed } = validateWorkflow("outputs/no-such-file.txt");

    expectWorkflowFileRefusal(parsed);
  });

  it("accepts .harness.yml as well as .harness.yaml", () => {
    const { parsed } = validateWorkflowText("wf.harness.yml", workflowYaml(2, [["agent-0", "agent-1"]]));

    expect(parsed).toMatchObject({ valid: true, agents: 2, connections: 1 });
  });

  it("reports a missing workflow file", () => {
    const { parsed } = validateWorkflow(join(trackedWorkspace(), "missing.harness.yaml"));

    expect(parsed.valid).toBe(false);
    expect(String(parsed.error)).toContain("File not found");
  });

  it("refuses a folder that is named like a workflow", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, "folder.harness.yaml"));

    const { parsed } = validateWorkflow(join(workspace, "folder.harness.yaml"));

    expect(parsed.valid).toBe(false);
    expect(String(parsed.error)).toContain("not a regular file");
  });

  it("refuses a symlinked folder that leads outside the project", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    writeFileSync(join(outside, "outside.harness.yaml"), workflowYaml(2, [["agent-0", "agent-1"]]));
    // "junction" needs no privileges on Windows; other platforms create a directory symlink.
    symlinkSync(outside, join(workspace, "linked"), "junction");

    const { parsed } = validateWorkflow(join(workspace, "linked", "outside.harness.yaml"));

    expect(parsed.valid).toBe(false);
    expect(String(parsed.error)).toContain("Path rejected");
    expect(String(parsed.error)).not.toContain(outside);
    expect(parsed).not.toHaveProperty("name");
  });

  it.skipIf(process.platform === "win32")("refuses a workflow symlink that leads outside the project", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    writeFileSync(join(outside, "target.harness.yaml"), workflowYaml(2, [["agent-0", "agent-1"]]));
    symlinkSync(join(outside, "target.harness.yaml"), join(workspace, "escape.harness.yaml"));

    const { parsed } = validateWorkflow(join(workspace, "escape.harness.yaml"));

    expect(parsed.valid).toBe(false);
    expect(String(parsed.error)).toContain("Path rejected");
    expect(String(parsed.error)).not.toContain(outside);
    expect(parsed).not.toHaveProperty("name");
  });

  it.skipIf(process.platform === "win32")("refuses a workflow-named symlink to a non-workflow file inside the project", () => {
    const workspace = trackedWorkspace();
    writeFileSync(join(workspace, "secrets.env"), leakyYaml);
    symlinkSync(join(workspace, "secrets.env"), join(workspace, "disguised.harness.yaml"));

    const { stdout, parsed } = validateWorkflow(join(workspace, "disguised.harness.yaml"));

    expectWorkflowFileRefusal(parsed);
    expectNoLeak(stdout);
  });

  it("still validates through a symlink that stays inside the project", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, "real"));
    writeFileSync(join(workspace, "real", "wf.harness.yaml"), workflowYaml(2, [["agent-0", "agent-1"]]));
    symlinkSync(join(workspace, "real"), join(workspace, "linked"), "junction");

    const { parsed } = validateWorkflow(join(workspace, "linked", "wf.harness.yaml"));

    expect(parsed).toMatchObject({ valid: true, agents: 2, connections: 1 });
  });

  it("validates a workflow in a project folder named ..data, as in a Kubernetes ConfigMap mount: not a way out", async () => {
    const { dir, server } = await makeSandboxProject();
    // Relative to the project root the path starts with "..data", which is not "..".
    mkdirSync(join(dir, "..data"));
    writeFileSync(join(dir, "..data", "wf.harness.yaml"), workflowYaml(2, [["agent-0", "agent-1"]]));

    const result = callTool("validate_workflow", { path: join(dir, "..data", "wf.harness.yaml") }, {}, server);

    expect(result.status).toBe(0);
    expect(contentJson(result.responses[0])).toMatchObject({ valid: true, agents: 2, connections: 1 });
  });
});

describe("MCP validate_workflow: YAML errors carry no file content", () => {
  // [label, file content, secret fragments that must never come back]
  const cases: Array<[string, string, string[]]> = [
    [
      "a duplicate key (the library quotes this line and the one before it)",
      "first_line_marker: PREVMARKER\nfirst_line_marker: SECRETMARKER\n",
      ["PREVMARKER", "SECRETMARKER", "first_line_marker"],
    ],
    ["a block scalar header (the library message interpolates it)", "a: |SECRETHEADER\n  text\n", ["SECRETHEADER"]],
    ["a bad escape sequence", 'a: "bad \\qSECRETESC"\n', ["SECRETESC"]],
    ["an unresolved alias (not a YAMLParseError, no position)", "a: *SECRETALIAS\n", ["SECRETALIAS"]],
    ["an over-long key (its error code contains digits)", `${"longkey".repeat(160)}: 1\n`, ["longkeylongkey"]],
  ];

  it.each(cases)("returns only a short message for %s", (_label, yaml, secrets) => {
    const { stdout, parsed } = validateWorkflowText("broken.harness.yaml", yaml);

    expect(parsed.valid).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(["error", "valid"]);
    expect(String(parsed.error)).toMatch(/^YAML parse error/);
    expect(String(parsed.error).length).toBeLessThan(80);
    expect(String(parsed.error)).not.toContain("\n");
    for (const secret of secrets) expect(stdout).not.toContain(secret);
  });

  it("gives the line and column of a parse error", () => {
    const { parsed } = validateWorkflowText("broken.harness.yaml", "first_line_marker: PREVMARKER\nfirst_line_marker: SECRETMARKER\n");

    expect(parsed.error).toMatch(/^YAML parse error \([A-Z_]+\) at line 2, column 1\.$/);
  });

  it("keeps an error code that contains digits", () => {
    const { parsed } = validateWorkflowText("broken.harness.yaml", `${"longkey".repeat(160)}: 1\n`);

    expect(parsed.error).toBe("YAML parse error (KEY_OVER_1024_CHARS) at line 1, column 1.");
  });

  it("keeps the yaml library's warnings, which quote the offending line, off stderr", () => {
    // An unresolved tag is only a warning: parsing goes on, and the library prints the source
    // line to stderr with process.emitWarning.
    const file = join(trackedWorkspace(), "warns.harness.yaml");
    writeFileSync(file, "meta: !TAGMARKER VALUEMARKER\n");

    const result = callTool("validate_workflow", { path: file });

    expect(result.status).toBe(0);
    expect(contentJson(result.responses[0]).valid).toBe(false);
    for (const marker of ["TAGMARKER", "VALUEMARKER"]) {
      expect(result.stdout).not.toContain(marker);
      expect(result.stderr).not.toContain(marker);
    }
  });
});

describe("MCP project_status test file count", () => {
  it("counts every .test.ts and .test.tsx file under tests/, however many there are", async () => {
    const { dir, server } = await makeSandboxProject();
    const populate = (folder: string, suffix: string, count: number) => {
      mkdirSync(join(dir, folder), { recursive: true });
      for (let i = 0; i < count; i++) writeFileSync(join(dir, folder, `case-${i}${suffix}`), "");
    };
    // Two folders of 51: the old 50-entry cap stopped walking after the first one.
    populate("tests/unit/a", ".test.ts", 51);
    populate("tests/unit/b", ".test.ts", 51);
    populate("tests/unit/c", ".test.tsx", 3);
    populate("tests/unit/c", ".ts", 2); // helpers are not tests
    populate("tests/unit/c", ".test.js", 2);
    // Fake npx: the real tsc would run in the scratch project.
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");

    const parsed = contentJson(callTool("project_status", {}, env, server).responses[0]);

    expect(parsed.testFileCount).toBe(51 + 51 + 3);
  });

  it("does not follow symlinks under tests/, so a link loop cannot freeze the server", async () => {
    const { dir, server } = await makeSandboxProject();
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    writeFileSync(join(dir, "tests", "unit", "a.test.ts"), "");
    writeFileSync(join(dir, "tests", "b.test.tsx"), "");
    // Two links back to tests/ itself: a walk that follows them visits about 2^40 folders (the
    // system stops resolving a path after 40 links), which is as good as endless.
    symlinkSync(join(dir, "tests"), join(dir, "tests", "loop1"), "junction");
    symlinkSync(join(dir, "tests"), join(dir, "tests", "loop2"), "junction");
    // Fake npx: the real tsc would run in the scratch project.
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");

    // A walk that ends takes well under a second. A server stuck in the loop is killed by the
    // timeout instead, and then has no exit status and has sent nothing.
    const result = callTool("project_status", {}, env, server, 20_000);

    expect(result.status).toBe(0);
    expect(contentJson(result.responses[0]).testFileCount).toBe(2);
  });

  it("counts no test file behind a symlinked folder, whether the link leads out of the project or not", async () => {
    const { dir, server } = await makeSandboxProject();
    mkdirSync(join(dir, "tests", "unit"), { recursive: true });
    writeFileSync(join(dir, "tests", "unit", "a.test.ts"), "");
    const outside = trackedOutsideDir();
    writeFileSync(join(outside, "outside.test.ts"), "");
    symlinkSync(outside, join(dir, "tests", "outside"), "junction");
    symlinkSync(join(dir, "tests", "unit"), join(dir, "tests", "alias"), "junction");
    // A linked folder is not a test file either, whatever it is called.
    symlinkSync(join(dir, "tests", "unit"), join(dir, "tests", "named.test.ts"), "junction");
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");

    const parsed = contentJson(callTool("project_status", {}, env, server).responses[0]);

    expect(parsed.testFileCount).toBe(1);
  });

  it("does not walk a tests/ folder that is itself a symlink", async () => {
    const { dir, server } = await makeSandboxProject();
    const outside = trackedOutsideDir();
    writeFileSync(join(outside, "outside.test.ts"), "");
    // `tests -> /` would walk the whole disk, with no cap to stop it.
    symlinkSync(outside, join(dir, "tests"), "junction");
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");

    const parsed = contentJson(callTool("project_status", {}, env, server).responses[0]);

    expect(parsed.testFileCount).toBe(0);
  });

  it.skipIf(process.platform === "win32")("does not count a symlink to a test file, as list_artifacts does not list one", async () => {
    const { dir, server } = await makeSandboxProject();
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "real.test.ts"), "");
    symlinkSync(join(dir, "tests", "real.test.ts"), join(dir, "tests", "linked.test.ts"));
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");

    const parsed = contentJson(callTool("project_status", {}, env, server).responses[0]);

    expect(parsed.testFileCount).toBe(1);
  });
});

describe("MCP workflow lists", () => {
  // Both tools list workflows; project_status shows only the file names. The timeout kills a
  // server that is stuck walking: it then has no exit status.
  function listWorkflows(server: string) {
    // Fake npx: the real tsc would run in the scratch project.
    const env = fakeBinEnv(trackedWorkspace(), ["npx"], "process.exitCode = 0;");
    const result = callMcp([toolCall(1, "list_workflows", {}), toolCall(2, "project_status", {})], env, server, 20_000);
    expect(result.status).toBe(0);
    const list = contentJson(result.responses[0]) as { count: number; workflows: Array<{ path: string; name: string }> };
    const status = contentJson(result.responses[1]) as { workflowCount: number; workflows: string[] };
    return {
      paths: list.workflows.map((workflow) => workflow.path.replace(/\\/g, "/")).sort(),
      listCount: list.count,
      statusNames: [...status.workflows].sort(),
      statusCount: status.workflowCount,
    };
  }

  it("lists .harness.yml files as well as .harness.yaml files", async () => {
    const { dir, server } = await makeSandboxProject();
    mkdirSync(join(dir, "examples"));
    writeFileSync(join(dir, "top.harness.yaml"), "");
    writeFileSync(join(dir, "examples", "nested.harness.yml"), "");
    // Neither of these ends in .harness.yaml or .harness.yml.
    writeFileSync(join(dir, "examples", "old.harness.yml.bak"), "");
    writeFileSync(join(dir, "workflow.yml"), "");

    const found = listWorkflows(server);

    expect(found.paths).toEqual(["examples/nested.harness.yml", "top.harness.yaml"]);
    expect(found.listCount).toBe(2);
    expect(found.statusNames).toEqual(["nested.harness.yml", "top.harness.yaml"]);
    expect(found.statusCount).toBe(2);
  });

  it("does not follow symlinked folders, so a link loop cannot freeze either tool", async () => {
    const { dir, server } = await makeSandboxProject();
    mkdirSync(join(dir, "flows"));
    writeFileSync(join(dir, "flows", "real.harness.yaml"), "");
    // A folder with no workflow in it and two links back to itself. The walk stops after 50
    // workflows, but a loop like this never yields one, so nothing else would end it.
    mkdirSync(join(dir, "void"));
    symlinkSync(join(dir, "void"), join(dir, "void", "loop1"), "junction");
    symlinkSync(join(dir, "void"), join(dir, "void", "loop2"), "junction");
    // Links to folders that hold workflows are not followed either.
    const outside = trackedOutsideDir();
    writeFileSync(join(outside, "outside.harness.yaml"), "");
    symlinkSync(outside, join(dir, "outside"), "junction");
    symlinkSync(join(dir, "flows"), join(dir, "alias"), "junction");

    const found = listWorkflows(server);

    expect(found.paths).toEqual(["flows/real.harness.yaml"]);
    expect(found.statusNames).toEqual(["real.harness.yaml"]);
  });
});

describe("MCP get_recent_logs and list_artifacts: links out of the workspace", () => {
  // What a link leads to, and must never come back in a reply.
  const logMarker = "OUTSIDELOGMARKER";
  const artifactMarker = "OUTSIDEARTIFACTMARKER";
  const logLine = (id: string) => JSON.stringify({ id, timestamp: "2026-06-28T01:00:00.000Z" }) + "\n";

  // The contents of a .harness folder: an audit log and one artifact.
  function fillHarnessFolder(folder: string) {
    mkdirSync(join(folder, "artifacts", "agent-a"), { recursive: true });
    writeFileSync(join(folder, "audit.log.jsonl"), logLine(logMarker));
    writeFileSync(join(folder, "artifacts", "agent-a", `${artifactMarker}.md`), "x");
  }

  // The tool's usual error result: no entries, and a message that names the problem only.
  function expectRefused(response: JsonRpcResponse, empty: "entries" | "artifacts") {
    expect(response.result?.isError).toBeUndefined();
    const parsed = contentJson(response);
    expect(parsed).toMatchObject({ count: 0, [empty]: [] });
    expect(String(parsed.error)).toMatch(/^Path rejected: the (audit log|artifacts folder) resolves outside the workspace \(symlink or junction\)\.$/);
  }

  function expectNothingOf(stdout: string, outside: string) {
    expect(stdout).not.toContain(logMarker);
    expect(stdout).not.toContain(artifactMarker);
    expect(stdout).not.toContain(outside);
  }

  it.skipIf(process.platform === "win32")("refuses an audit log that is a symlink to a file outside the project", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    // A JSON Lines file: its lines would come back as log entries if the link were followed.
    writeFileSync(join(outside, "other.jsonl"), logLine(logMarker));
    mkdirSync(join(workspace, ".harness"));
    symlinkSync(join(outside, "other.jsonl"), join(workspace, ".harness", "audit.log.jsonl"));

    const result = callTool("get_recent_logs", { workspace });

    expect(result.status).toBe(0);
    expectRefused(result.responses[0], "entries");
    expectNothingOf(result.stdout, outside);
  });

  it.skipIf(process.platform === "win32")("refuses an audit log that is a symlink to a file inside the project but outside the workspace", () => {
    const workspace = trackedWorkspace();
    const elsewhere = trackedWorkspace();
    writeFileSync(join(elsewhere, "other.jsonl"), logLine(logMarker));
    mkdirSync(join(workspace, ".harness"));
    symlinkSync(join(elsewhere, "other.jsonl"), join(workspace, ".harness", "audit.log.jsonl"));

    const result = callTool("get_recent_logs", { workspace });

    expectRefused(result.responses[0], "entries");
    expectNothingOf(result.stdout, elsewhere);
  });

  it.skipIf(process.platform === "win32")("still reads an audit log that is a symlink to a file inside the workspace", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, ".harness"));
    writeFileSync(join(workspace, ".harness", "real.jsonl"), logLine("inside"));
    symlinkSync(join(workspace, ".harness", "real.jsonl"), join(workspace, ".harness", "audit.log.jsonl"));

    const parsed = contentJson(callTool("get_recent_logs", { workspace }).responses[0]) as {
      error?: string;
      entries?: Array<{ id: string }>;
    };

    expect(parsed.error).toBeUndefined();
    expect(parsed.entries?.map((entry) => entry.id)).toEqual(["inside"]);
  });

  // The link is refused for leading outside, before anything asks what it leads to: the reply must
  // not tell a caller that an outside file is a FIFO. (A server that opened it would hang, and the
  // timeout would kill it.)
  it.skipIf(!canMakeFifo)("refuses an audit log that is a symlink to a FIFO outside the project as leading outside", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    makeFifo(join(outside, "pipe"));
    mkdirSync(join(workspace, ".harness"));
    symlinkSync(join(outside, "pipe"), join(workspace, ".harness", "audit.log.jsonl"));

    const result = callTool("get_recent_logs", { workspace }, {}, serverPath, 20_000);

    expect(result.status).toBe(0);
    expectRefused(result.responses[0], "entries");
    expectNothingOf(result.stdout, outside);
  });

  it("refuses an artifacts folder that is a symlink to a folder outside the project", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    mkdirSync(join(outside, "agent-a"));
    writeFileSync(join(outside, "agent-a", `${artifactMarker}.md`), "x");
    mkdirSync(join(workspace, ".harness"));
    // "junction" needs no privileges on Windows; other platforms create a directory symlink.
    symlinkSync(outside, join(workspace, ".harness", "artifacts"), "junction");

    const result = callTool("list_artifacts", { workspace });

    expect(result.status).toBe(0);
    expectRefused(result.responses[0], "artifacts");
    expectNothingOf(result.stdout, outside);
  });

  it("still lists an artifacts folder that is a symlink to a folder inside the workspace", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, ".harness", "store", "agent-a"), { recursive: true });
    writeFileSync(join(workspace, ".harness", "store", "agent-a", "report.md"), "r");
    symlinkSync(join(workspace, ".harness", "store"), join(workspace, ".harness", "artifacts"), "junction");

    const parsed = contentJson(callTool("list_artifacts", { workspace }).responses[0]) as {
      error?: string;
      artifacts?: Array<{ path: string }>;
    };

    expect(parsed.error).toBeUndefined();
    expect(parsed.artifacts?.map((artifact) => artifact.path)).toEqual([".harness/artifacts/agent-a/report.md"]);
  });

  it("refuses both when .harness itself is a symlink to a folder outside the project", () => {
    const workspace = trackedWorkspace();
    const outside = trackedOutsideDir();
    fillHarnessFolder(outside);
    symlinkSync(outside, join(workspace, ".harness"), "junction");

    const result = callMcp([toolCall(1, "get_recent_logs", { workspace }), toolCall(2, "list_artifacts", { workspace })]);

    expectRefused(result.responses[0], "entries");
    expectRefused(result.responses[1], "artifacts");
    expectNothingOf(result.stdout, outside);
  });

  it("refuses both when the workspace folder is a symlink to a folder outside the project", () => {
    const outside = trackedOutsideDir();
    fillHarnessFolder(join(outside, ".harness"));
    // The link itself is inside the project, so the path check on the name alone passes.
    const workspace = join(trackedWorkspace(), "linked");
    symlinkSync(outside, workspace, "junction");

    const result = callMcp([toolCall(1, "get_recent_logs", { workspace }), toolCall(2, "list_artifacts", { workspace })]);

    expectRefused(result.responses[0], "entries");
    expectRefused(result.responses[1], "artifacts");
    expectNothingOf(result.stdout, outside);
  });
});

describe("MCP get_recent_logs: an audit log that is not a regular file", () => {
  // The refusal for a log the tool will not open: no entries, and fixed text that names no path.
  function expectNotRegular(response: JsonRpcResponse) {
    expect(response.result?.isError).toBeUndefined();
    expect(contentJson(response)).toEqual({
      count: 0,
      entries: [],
      error: "Path rejected: the audit log is not a regular file.",
    });
  }

  it("refuses an audit log that is a folder", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, ".harness", "audit.log.jsonl"), { recursive: true });

    const result = callTool("get_recent_logs", { workspace });

    expect(result.status).toBe(0);
    expectNotRegular(result.responses[0]);
  });

  // A FIFO that has no writer blocks whoever opens it to read, and the server is single-threaded.
  // A server that reads it never answers: the timeout kills it, and it then has no exit status and
  // has sent nothing.
  it.skipIf(!canMakeFifo)("returns at once for an audit log that is a FIFO", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, ".harness"));
    makeFifo(join(workspace, ".harness", "audit.log.jsonl"));

    const result = callTool("get_recent_logs", { workspace }, {}, serverPath, 20_000);

    expect(result.status).toBe(0);
    expectNotRegular(result.responses[0]);
  });

  it.skipIf(!canMakeFifo)("returns at once for an audit log that is a symlink to a FIFO inside the workspace", () => {
    const workspace = trackedWorkspace();
    mkdirSync(join(workspace, ".harness"));
    makeFifo(join(workspace, ".harness", "pipe"));
    symlinkSync(join(workspace, ".harness", "pipe"), join(workspace, ".harness", "audit.log.jsonl"));

    const result = callTool("get_recent_logs", { workspace }, {}, serverPath, 20_000);

    expect(result.status).toBe(0);
    expectNotRegular(result.responses[0]);
  });
});

describe("MCP limit handling", () => {
  // Three artifacts and three log entries, so the default limit (100 / 20) shows all of them
  // and a limit clamped to 1 shows one.
  function seedWorkspace() {
    const workspace = trackedWorkspace();
    const artifactDir = join(workspace, ".harness", "artifacts", "agent-a");
    mkdirSync(artifactDir, { recursive: true });
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(artifactDir, name), name);
    writeAuditLog(workspace, [1, 2, 3].map((n) => JSON.stringify({ id: `e${n}`, timestamp: `2026-06-28T0${n}:00:00.000Z` })));
    return workspace;
  }

  function counts(workspace: string, limit: unknown) {
    const artifacts = contentJson(callTool("list_artifacts", { workspace, limit }).responses[0]);
    const logs = contentJson(callTool("get_recent_logs", { workspace, limit }).responses[0]);
    return { artifacts: artifacts.count, logs: logs.count };
  }

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["false", false],
    ["an empty array", []],
    ["a non-numeric string", "abc"],
  ])("uses the default limit when limit is %s", (_label, limit) => {
    expect(counts(seedWorkspace(), limit)).toEqual({ artifacts: 3, logs: 3 });
  });

  it.each([
    [2, 2],
    ["2", 2],
    [2.9, 2],
    [0, 1],
    [-5, 1],
  ])("clamps limit %j to %i", (limit, expected) => {
    expect(counts(seedWorkspace(), limit)).toEqual({ artifacts: expected, logs: expected });
  });
});
