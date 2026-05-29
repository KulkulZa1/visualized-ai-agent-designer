import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const serverPath = join(root, "mcp", "server.mjs");

interface JsonRpcResponse {
  id: number;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

function callMcp(requests: unknown[]) {
  const input = requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
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
    },
  });

  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);

  return { ...result, responses: lines };
}

function contentJson(response: JsonRpcResponse) {
  const text = response.result?.content?.[0]?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

describe("Harness Studio MCP stdio server", () => {
  it("initializes and lists read/test tools", () => {
    const result = callMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    expect(result.status).toBe(0);
    expect(result.responses[0].result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "harness-studio" },
    });
    expect(result.responses[1].result?.tools?.map((tool) => tool.name)).toEqual([
      "run_tests",
      "run_cargo_tests",
      "validate_workflow",
      "project_status",
      "list_workflows",
    ]);
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

  it("returns a JSON-RPC error for unknown tools", () => {
    const result = callMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_file", arguments: {} },
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.responses[0].error).toMatchObject({
      code: -32601,
      message: "Unknown tool: write_file",
    });
  });
});
