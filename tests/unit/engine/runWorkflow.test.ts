import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";
import { runWorkflow, type RunHost, type RunInput } from "@/engine/runWorkflow";
import type { RunRecord } from "@/engine/runRecord";
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

  it("tells the host each node's model and provider when it starts", async () => {
    const { host, log } = fakeHost();

    await runWorkflow(runInput([makeNode("A")]), host);

    expect(log.agents.find(([id, p]) => id === "A" && p.status === "running")?.[1])
      .toMatchObject({ modelUsed: "qwen2.5-coder:7b", providerUsed: "ollama" });
  });

  it("skips the progressive reveal of answers when the host asks (harness run)", async () => {
    const answer = "x".repeat(300);
    const revealSteps = (agents: Array<[string, Partial<AgentRun>]>) =>
      agents.filter(([, p]) => p.output !== undefined && p.status === undefined).length;

    const shown = fakeHost({ call_ollama_api: () => answer });
    await runWorkflow(runInput([makeNode("A")]), shown.host);
    const plain = fakeHost({ call_ollama_api: () => answer }, { revealOutput: false });
    await runWorkflow(runInput([makeNode("A")]), plain.host);

    expect(revealSteps(shown.log.agents)).toBeGreaterThan(1);
    expect(revealSteps(plain.log.agents)).toBe(0);
  });

  it("names the host's command policy in the audit", async () => {
    const { nodes, handlers } = commandRun();
    const { host, log } = fakeHost(handlers, { askCommand: async () => "deny", commandPolicy: "--allow-command" });

    await runWorkflow(runInput(nodes), host);

    expect(log.audit.map((e) => e.details)).toContain("A: command denied (not in --allow-command): npm test");
  });
});

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
