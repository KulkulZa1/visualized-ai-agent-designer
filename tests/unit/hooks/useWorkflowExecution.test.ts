import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkflowExecution } from "@/hooks/useWorkflowExecution";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";

const { createSnapshot } = vi.hoisted(() => ({ createSnapshot: vi.fn(async () => ({})) }));
vi.mock("@/services/context-builder/snapshotService", () => ({ createSnapshot }));

function makeNode(id: string): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id,
      role: AgentRole.Worker,
      model: "qwen2.5-coder:7b",
      temperature: 0.7,
      maxTokens: 1024,
      maxSteps: 1,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" },
      tools: [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 16000 },
      status: "idle",
    },
  };
}

async function run(onError: (msg: string) => void = vi.fn()) {
  const { result } = renderHook(() => useWorkflowExecution());
  await act(async () => {
    await result.current.executeWorkflow(undefined, onError);
  });
  return useExecutionStore.getState().currentRun;
}

beforeEach(() => {
  createSnapshot.mockClear();
  useWorkflowStore.setState({ nodes: [makeNode("A"), makeNode("B")], edges: [] });
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useExecutionStore.setState({
    currentRun: null, isRunning: false, continueOnError: true,
    llmProvider: "ollama", ollamaBaseUrl: "http://localhost:11434", ollamaModel: "qwen2.5-coder:7b",
    apiKey: "", openaiApiKey: "", ollamaApiKey: "", customApiUrl: "", customApiKey: "",
  });
  mockInvokeHandler("get_provider_defaults", () => ({
    llm_provider: "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
    openai_api_key_configured: false, anthropic_api_key_configured: false,
    ollama_api_key_configured: false, suggested_ollama_models: [],
  }));
  mockInvokeHandler("check_provider_health", (args) => ({
    ok: true, provider: (args as { provider: string }).provider, latency_ms: 1,
    message: "ok", model_available: true, pull_command: null,
  }));
  mockInvokeHandler("call_ollama_api", () => "ok");
});

describe("useWorkflowExecution", () => {
  it("reports the run as failed when an agent errors, even with continueOnError", async () => {
    mockInvokeHandler("call_ollama_api", (args) =>
      (args as { system: string }).system.startsWith("You are B")
        ? Promise.reject(new Error("model crashed"))
        : "ok");

    const finished = await run();

    expect(finished?.agents.A.status).toBe("done");
    expect(finished?.agents.B.status).toBe("error");
    expect(finished?.status).toBe("error");
  });

  it("runs a tool-using node with native tool calls, offering and naming only runnable tools", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile, ToolPermission.WebSearch];
    node.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const turns: Array<{ system: string; tools: Array<{ name: string }>; messages: unknown[] }> = [];
    mockInvokeHandler("chat_turn", (args) => {
      turns.push(args as (typeof turns)[number]);
      return turns.length === 1
        ? { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
            toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.md" } }] }
        : { text: "done", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });
    mockInvokeHandler("read_workspace_file", () => "A");

    const finished = await run();

    expect(finished?.agents.A).toMatchObject({ status: "done", output: "done" });
    expect(turns[0].tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(turns[0].system).toContain("Allowed tools: read_file\n");
    expect(turns[1].messages).toHaveLength(3); // user, assistant tool call, tool result
  });

  it("falls back to the text protocol when the model refuses native tools, for the rest of the run", async () => {
    const a = makeNode("A");
    const b = makeNode("B");
    a.data.tools = b.data.tools = [ToolPermission.ReadFile];
    useWorkflowStore.setState({
      nodes: [a, b],
      edges: [{ id: "e", source: "A", target: "B" }],
    });
    let nativeCalls = 0;
    let textCalls = 0;
    mockInvokeHandler("chat_turn", () => {
      nativeCalls++;
      return { text: "", toolCalls: [], finishReason: "tools_unsupported", nativeToolsSupported: false };
    });
    mockInvokeHandler("call_ollama_api", () => { textCalls++; return "ok"; });

    const finished = await run();

    expect(finished?.status).toBe("done");
    expect(nativeCalls).toBe(1); // B does not try native tools again
    expect(textCalls).toBe(2);
  });

  it("uses the text protocol when the backend has no chat_turn command (VS Code extension)", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("chat_turn", () => {
      throw new Error('[HarnessVscode] Unhandled command: "chat_turn". This command requires the Tauri runtime.');
    });
    mockInvokeHandler("call_ollama_api", () => "ok");

    const finished = await run();

    expect(finished?.agents.A).toMatchObject({ status: "done", output: "ok" });
  });

  it("lets an agent dispatch helpers that start fresh, use only its tools and report back", async () => {
    const lead = makeNode("Lead");
    lead.data.tools = [ToolPermission.SubagentDispatch, ToolPermission.ReadFile];
    lead.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [lead], edges: [] });
    type Turn = {
      system: string; tools: Array<{ name: string }>;
      messages: Array<{ role: string; text?: string; toolResults?: Array<{ content: string }> }>;
    };
    const turns: Turn[] = [];
    mockInvokeHandler("chat_turn", (args) => {
      const turn = args as Turn;
      turns.push(turn);
      if (!turn.system.startsWith("You are Lead,")) {
        return { text: `summary of ${turn.messages[0].text}`, toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
      }
      return turn.messages.length === 1
        ? { text: "", finishReason: "tool_calls", nativeToolsSupported: true, toolCalls: [
            { id: "d1", name: "subagent_dispatch", args: { task: "Summarize a.md", name: "A-reader" } },
            { id: "d2", name: "subagent_dispatch", args: { task: "Summarize b.md", name: "B-reader" } },
          ] }
        : { text: "combined", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });

    const finished = await run();

    expect(finished?.agents.Lead).toMatchObject({ status: "done", output: "combined" });
    const helpers = turns.filter((t) => !t.system.startsWith("You are Lead,"));
    expect(helpers.map((h) => h.messages).sort((x, y) => String(x[0].text).localeCompare(String(y[0].text))))
      .toEqual([[{ role: "user", text: "Summarize a.md" }], [{ role: "user", text: "Summarize b.md" }]]);
    expect(helpers[0].tools.map((t) => t.name)).toEqual(["read_file"]);
    const leadFinal = turns.find((t) => t.system.startsWith("You are Lead,") && t.messages.length === 3);
    expect(leadFinal?.messages[2].toolResults?.map((r) => r.content)).toEqual([
      "Report from A-reader:\nsummary of Summarize a.md",
      "Report from B-reader:\nsummary of Summarize b.md",
    ]);
    // The activity panel reads the helpers from the node's run record.
    expect(finished?.agents.Lead.subAgents).toEqual([
      expect.objectContaining({
        name: "A-reader", task: "Summarize a.md", tools: ["read_file"],
        status: "done", output: "summary of Summarize a.md",
      }),
      expect.objectContaining({
        name: "B-reader", task: "Summarize b.md", status: "done", output: "summary of Summarize b.md",
      }),
    ]);
  });

  it("refuses to start a second run while one is already starting or running", async () => {
    useWorkflowStore.setState({ nodes: [makeNode("A")], edges: [] });
    let providerCalls = 0;
    mockInvokeHandler("call_ollama_api", () => { providerCalls++; return "ok"; });
    const onError = vi.fn();

    const { result } = renderHook(() => useWorkflowExecution());
    await act(async () => {
      await Promise.all([
        result.current.executeWorkflow(undefined, vi.fn()),
        result.current.executeWorkflow(undefined, onError),
      ]);
    });

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/already/i));
    expect(providerCalls).toBe(1);
  });

  it("stamps context snapshots with the id of the run that produced them", async () => {
    const finished = await run();

    expect(finished?.id).toBeTruthy();
    expect(createSnapshot).toHaveBeenCalled();
    for (const call of createSnapshot.mock.calls as unknown as Array<[unknown, { runId?: string }]>) {
      expect(call[1].runId).toBe(finished?.id);
    }
  });

  it("uses a provider key configured only in the environment (Rust resolves it)", async () => {
    // docs/INSTALLATION.md tells users to set OPENAI_API_KEY in the environment.
    const node = makeNode("A");
    node.data.model = "gpt-4o";
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    useExecutionStore.setState({ llmProvider: "auto" });
    mockInvokeHandler("get_provider_defaults", () => ({
      llm_provider: "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
      openai_api_key_configured: true, anthropic_api_key_configured: false,
      ollama_api_key_configured: false, suggested_ollama_models: [],
    }));
    const openaiCalls: Array<{ apiKey: string }> = [];
    mockInvokeHandler("call_openai_api", (args) => {
      openaiCalls.push(args as { apiKey: string });
      return "ok";
    });

    const finished = await run();

    expect(finished?.agents.A.status).toBe("done");
    expect(openaiCalls).toHaveLength(1);
    expect(openaiCalls[0].apiKey).toBe("");
  });

  it("does not execute a tool call that arrives after the run was stopped", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.WriteFile];
    node.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const writes: unknown[] = [];
    mockInvokeHandler("write_workspace_file", (args) => { writes.push(args); return undefined; });
    mockInvokeHandler("call_ollama_api", () => {
      useExecutionStore.getState().cancelRun(); // user presses Stop while the model answers
      return '<tool_call>{"name":"fs.write","args":{"path":"x.txt","content":"hi"}}</tool_call>';
    });

    await run();

    expect(writes).toEqual([]);
  });

  it("gives the user's task to agents fed only by hook/memory nodes, not to downstream agents", async () => {
    // Sentinel(hook) → Planner → Log(memory) → Writer
    const hook = makeNode("Sentinel");
    hook.data.role = AgentRole.Hook;
    const log = makeNode("Log");
    log.data.role = AgentRole.Memory;
    useWorkflowStore.setState({
      nodes: [hook, makeNode("Planner"), log, makeNode("Writer")],
      edges: [
        { id: "e1", source: "Sentinel", target: "Planner" },
        { id: "e2", source: "Planner", target: "Log" },
        { id: "e3", source: "Log", target: "Writer" },
      ],
    });
    const userMessages = new Map<string, string>();
    mockInvokeHandler("call_ollama_api", (args) => {
      const { system, userMessage } = args as { system: string; userMessage: string };
      userMessages.set(system.startsWith("You are Planner") ? "Planner" : "Writer", userMessage);
      return "ok";
    });

    const { result } = renderHook(() => useWorkflowExecution());
    await act(async () => {
      await result.current.executeWorkflow(
        { userInput: "Summarize the repo", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
        vi.fn(),
      );
    });

    expect(userMessages.get("Planner")).toContain("USER TASK:\nSummarize the repo");
    expect(userMessages.get("Writer")).not.toContain("USER TASK");
  });

  it("applies a run-level think depth only to reasoning models", async () => {
    const node = makeNode("A");
    node.data.model = "gpt-4o-mini";
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    useExecutionStore.setState({ llmProvider: "openai", openaiApiKey: "sk-test-openai" });
    const efforts: unknown[] = [];
    mockInvokeHandler("call_openai_api", (args) => {
      efforts.push((args as { reasoningEffort: unknown }).reasoningEffort);
      return "ok";
    });

    const { result } = renderHook(() => useWorkflowExecution());
    await act(async () => {
      await result.current.executeWorkflow(
        { userInput: "", contextFilePaths: [], thinkDepthOverride: "high", providerOverride: null },
        vi.fn(),
      );
    });

    expect(efforts).toEqual([null]);
  });

  it("keeps run status updates out of the undo history", async () => {
    useWorkflowStore.temporal.getState().clear();

    await run();

    expect(useWorkflowStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it("stops the run when a hook gate fails, even with continueOnError", async () => {
    const gate = makeNode("Gate");
    gate.data.role = AgentRole.Hook;
    gate.data.preHook = { path: ".harness/hooks/pre_run_consent.sh", requireConsent: true };
    useWorkflowStore.setState({
      nodes: [gate, makeNode("A")],
      edges: [{ id: "e1", source: "Gate", target: "A" }],
    });
    let providerCalls = 0;
    mockInvokeHandler("call_ollama_api", () => { providerCalls++; return "ok"; });

    const finished = await run();

    expect(finished?.agents.Gate.status).toBe("error");
    expect(providerCalls).toBe(0);
    expect(finished?.status).toBe("error");
  });

  it("refuses to run hooks when no workspace is open instead of using the workflow's projectRoot", async () => {
    // A pasted/loaded YAML must not choose the folder hooks execute in.
    useWorkspaceStore.setState({ workspacePath: null });
    const hook = makeNode("Hook");
    hook.data.role = AgentRole.Hook;
    hook.data.preHook = { path: "hooks/check.py", requireConsent: false };
    useWorkflowStore.setState({ nodes: [hook], edges: [] });
    useWorkflowStore.getState().updateMeta({ projectRoot: "\\\\attacker\\share" });
    const hookRoots: string[] = [];
    mockInvokeHandler("execute_hook", (args) => {
      hookRoots.push((args as { workspacePath: string }).workspacePath);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    });

    const finished = await run();

    expect(hookRoots).toEqual([]);
    expect(finished?.agents.Hook.status).toBe("error");
  });

  it("lets a new run start soon after Stop, even while a provider call hangs", async () => {
    useWorkflowStore.setState({ nodes: [makeNode("A")], edges: [] });
    mockInvokeHandler("call_ollama_api", () => new Promise<string>(() => {})); // never answers
    const { result } = renderHook(() => useWorkflowExecution());

    await act(async () => {
      const first = result.current.executeWorkflow(undefined, vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 50)); // provider call now pending
      useExecutionStore.getState().cancelRun();
      await first; // must settle promptly, not after the node's 300 s timeout
    });
    expect(useExecutionStore.getState().currentRun?.status).toBe("cancelled");
    expect(useExecutionStore.getState().currentRun?.agents.A.status).not.toBe("done");

    const onError = vi.fn();
    mockInvokeHandler("call_ollama_api", () => "ok");
    await act(async () => { await result.current.executeWorkflow(undefined, onError); });
    expect(onError).not.toHaveBeenCalled();
    expect(useExecutionStore.getState().currentRun?.status).toBe("done");
  });

  it("does not start another provider call after a tool step used up the node's time", async () => {
    const node = makeNode("A");
    node.data.timeoutSeconds = 0.05;
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    let providerCalls = 0;
    // A node with tools uses native tool calls (chat_turn).
    mockInvokeHandler("chat_turn", () => {
      providerCalls++;
      return {
        text: "", finishReason: "tool_calls", nativeToolsSupported: true,
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.md" } }],
      };
    });
    mockInvokeHandler("read_workspace_file", () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("text"), 120)));

    const finished = await run();

    expect(providerCalls).toBe(1);
    expect(finished?.agents.A.error).toMatch(/timed out/);
  });

  it("lets a new run start soon after Stop, even while a hook is still running", async () => {
    const hook = makeNode("Gate");
    hook.data.role = AgentRole.Hook;
    hook.data.preHook = { path: ".harness/hooks/test_gate.sh", requireConsent: false };
    useWorkflowStore.setState({ nodes: [hook], edges: [] });
    mockInvokeHandler("execute_hook", () => new Promise(() => {})); // still running
    const { result } = renderHook(() => useWorkflowExecution());

    await act(async () => {
      const first = result.current.executeWorkflow(undefined, vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 50));
      useExecutionStore.getState().cancelRun();
      await first; // must settle promptly, not after the hook's timeout
    });
    expect(useExecutionStore.getState().currentRun?.status).toBe("cancelled");

    mockInvokeHandler("execute_hook", () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }));
    const onError = vi.fn();
    await act(async () => { await result.current.executeWorkflow(undefined, onError); });
    expect(onError).not.toHaveBeenCalled();
  });

  it("runs a hook node with the node's own timeout", async () => {
    const hook = makeNode("Gate");
    hook.data.role = AgentRole.Hook;
    hook.data.timeoutSeconds = 120;
    hook.data.preHook = { path: ".harness/hooks/test_gate.sh", requireConsent: false };
    useWorkflowStore.setState({ nodes: [hook], edges: [] });
    const timeouts: unknown[] = [];
    mockInvokeHandler("execute_hook", (args) => {
      timeouts.push((args as { timeoutSecs?: number }).timeoutSecs);
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    });

    await run();

    expect(timeouts).toEqual([120]);
  });

  it("does not probe cloud providers the run will not use", async () => {
    useExecutionStore.setState({ openaiApiKey: "sk-test-openai", apiKey: "sk-ant-test" });
    const probed: string[] = [];
    mockInvokeHandler("check_provider_health", (args) => {
      const { provider } = args as { provider: string };
      probed.push(provider);
      return { ok: true, provider, latency_ms: 1, message: "ok", model_available: true, pull_command: null };
    });

    await run();

    expect(probed).toEqual(["ollama"]);
  });

  it("fails a node whose provider call exceeds the node's timeoutSeconds", async () => {
    const node = makeNode("A");
    node.data.timeoutSeconds = 0.05;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("call_ollama_api", () => new Promise<string>(() => {})); // never answers

    const finished = await run();

    expect(finished?.agents.A.status).toBe("error");
    expect(finished?.agents.A.error).toMatch(/timed out after 0\.05s/);
    expect(finished?.status).toBe("error");
  });

  it("passes the node's configured maxTokens to the provider without a hidden cap", async () => {
    const node = makeNode("A");
    node.data.maxTokens = 8192;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const maxTokens: number[] = [];
    mockInvokeHandler("call_ollama_api", (args) => {
      maxTokens.push((args as { maxTokens: number }).maxTokens);
      return "ok";
    });

    await run();

    expect(maxTokens).toEqual([8192]);
  });

  it("sends the contents of a file-based prompt to the model", async () => {
    const node = makeNode("A");
    node.data.promptSource = { type: "file", path: "prompts/a.md" };
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("read_workspace_file", () => "FILE PROMPT BODY");
    const systems: string[] = [];
    mockInvokeHandler("call_ollama_api", (args) => {
      systems.push((args as { system: string }).system);
      return "ok";
    });

    await run();

    expect(systems[0]).toContain("FILE PROMPT BODY");
  });
});
