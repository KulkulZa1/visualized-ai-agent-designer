import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke as mockInvoke, mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkflowExecution } from "@/hooks/useWorkflowExecution";
import { runWorkflow } from "@/engine/runWorkflow";
import type { RunRecord } from "@/engine/runRecord";
import { defToGraph } from "@/engine/workflowGraph";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { useCommandConsentStore, type CommandRequest } from "@/store/commandConsentStore";
import { MAX_REVISION_ROUNDS } from "@/services/execution/routing";
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
  // Nodes with tools use the text tool protocol unless a test registers its own chat_turn.
  mockInvokeHandler("chat_turn", () => ({
    text: "", toolCalls: [], finishReason: "tools_unsupported", nativeToolsSupported: false,
  }));
  // No workspace files (AGENTS.md included) unless a test registers its own reader.
  mockInvokeHandler("read_workspace_file", () => { throw new Error("IO error: not found (os error 2)"); });
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

  it("records a late-finishing helper on its own run only, never on a newer run", async () => {
    const lead = makeNode("Lead");
    // read_file gives the helper a runnable tool, so it too uses chat_turn.
    lead.data.tools = [ToolPermission.SubagentDispatch, ToolPermission.ReadFile];
    lead.data.maxSteps = 2;
    useWorkflowStore.setState({ nodes: [lead], edges: [] });
    let helperCalled = false;
    mockInvokeHandler("chat_turn", (args) => {
      if ((args as { system: string }).system.startsWith("You are Lead,")) {
        return { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
          toolCalls: [{ id: "d1", name: "subagent_dispatch", args: { task: "t", name: "H" } }] };
      }
      helperCalled = true;
      return new Promise(() => {}); // the helper is still working
    });
    const { result } = renderHook(() => useWorkflowExecution());

    await act(async () => {
      const first = result.current.executeWorkflow(undefined, vi.fn());
      while (!helperCalled) await new Promise((resolve) => setTimeout(resolve, 10));
      useExecutionStore.getState().startRun("next run"); // the helper now belongs to an old run
      await first;
    });

    expect(useExecutionStore.getState().currentRun?.workflowName).toBe("next run");
    expect(useExecutionStore.getState().currentRun?.agents.Lead?.subAgents).toBeUndefined();
  });

  async function stopWhileRunning() {
    const { result } = renderHook(() => useWorkflowExecution());
    await act(async () => {
      const first = result.current.executeWorkflow(undefined, vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 50));
      useExecutionStore.getState().cancelRun();
      await first;
    });
    return useExecutionStore.getState().currentRun;
  }

  it("marks a node stopped, without an error, when the run is stopped while it works", async () => {
    mockInvokeHandler("call_ollama_api", () => new Promise<string>(() => {})); // never answers
    useWorkflowStore.setState({ nodes: [makeNode("A")], edges: [] });

    const run = await stopWhileRunning();

    expect(run?.agents.A.status).toBe("stopped");
    expect(run?.agents.A.error).toBeUndefined();
    // The canvas node shows it too.
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe("stopped");
  });

  it("marks a hook node stopped when the run is stopped while its hook runs", async () => {
    const hook = makeNode("Gate");
    hook.data.role = AgentRole.Hook;
    hook.data.preHook = { path: ".harness/hooks/test_gate.sh", requireConsent: false };
    useWorkflowStore.setState({ nodes: [hook], edges: [] });
    mockInvokeHandler("execute_hook", () => new Promise(() => {})); // still running

    const run = await stopWhileRunning();

    expect(run?.agents.Gate.status).toBe("stopped");
    expect(run?.agents.Gate.error).toBeUndefined();
    expect(useWorkflowStore.getState().nodes[0].data.status).toBe("stopped");
  });

  it("shows a helper as stopped when the run is stopped while it works", async () => {
    const lead = makeNode("Lead");
    lead.data.tools = [ToolPermission.SubagentDispatch, ToolPermission.ReadFile];
    lead.data.maxSteps = 2;
    useWorkflowStore.setState({ nodes: [lead], edges: [] });
    let helperCalled = false;
    mockInvokeHandler("chat_turn", (args) => {
      if ((args as { system: string }).system.startsWith("You are Lead,")) {
        return { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
          toolCalls: [{ id: "d1", name: "subagent_dispatch", args: { task: "t", name: "H" } }] };
      }
      helperCalled = true;
      return new Promise(() => {}); // still working when Stop is pressed
    });
    const { result } = renderHook(() => useWorkflowExecution());

    await act(async () => {
      const first = result.current.executeWorkflow(undefined, vi.fn());
      while (!helperCalled) await new Promise((resolve) => setTimeout(resolve, 10));
      useExecutionStore.getState().cancelRun();
      await first;
    });

    const run = useExecutionStore.getState().currentRun;
    expect(run?.status).toBe("cancelled");
    expect(run?.agents.Lead.status).toBe("stopped");
    expect(run?.agents.Lead.subAgents).toEqual([expect.objectContaining({ name: "H", status: "stopped" })]);
  });

  describe("revision loops", () => {
    const who = (args: unknown) => /^You are (\w+),/.exec((args as { system: string }).system)![1];
    const feedback = (source: string, target: string, label: string) =>
      ({ id: `fb-${source}-${target}`, source, target, data: { edgeKind: "feedback", label } });

    /** W drafts, R reviews (feedback edge back to W), D runs after the review. */
    function reviewLoop(reviews: string[]) {
      useWorkflowStore.setState({
        nodes: [makeNode("W"), makeNode("R"), makeNode("D")],
        edges: [{ id: "w-r", source: "W", target: "R" }, feedback("R", "W", "revise"), { id: "r-d", source: "R", target: "D" }],
      });
      const calls: Record<string, string[]> = { W: [], R: [], D: [] };
      mockInvokeHandler("call_ollama_api", (args) => {
        const name = who(args);
        calls[name].push((args as { userMessage: string }).userMessage);
        if (name === "W") return `draft ${calls.W.length}`;
        if (name === "R") return reviews[Math.min(calls.R.length, reviews.length) - 1];
        return "shipped";
      });
      return calls;
    }

    it("re-runs the reviewed agent with the review and its previous output until the reviewer passes", async () => {
      const calls = reviewLoop(["REVISE — tighten the intro", '{"verdict":"PASS"}']);

      const finished = await run();

      expect([calls.W.length, calls.R.length, calls.D.length]).toEqual([2, 2, 1]);
      expect(calls.W[1]).toContain("REVISION REQUEST (round 1) from R");
      expect(calls.W[1]).toContain("tighten the intro");
      expect(calls.W[1]).toContain("YOUR PREVIOUS OUTPUT:\ndraft 1");
      expect(calls.W[1].match(/draft 1/g)).toHaveLength(1); // the draft the reviewer read isn't repeated
      expect(calls.D[0]).toContain('{"verdict":"PASS"}'); // downstream sees the final review
      expect(finished?.status).toBe("done");
      expect(finished?.agents.W.revision).toBe(1);
    });

    it("stops after the revision limit and continues downstream", async () => {
      const calls = reviewLoop(["REVISE"]);

      const finished = await run();

      expect([calls.W.length, calls.R.length, calls.D.length]).toEqual([1 + MAX_REVISION_ROUNDS, 1 + MAX_REVISION_ROUNDS, 1]);
      expect(finished?.status).toBe("done");
      // The run goes on with the latest version: a warning, not a failure.
      expect(useAuditStore.getState().entries.find((e) => /revision limit/.test(e.details ?? "")))
        .toMatchObject({ action: "revision", success: true, warning: true });
    });

    it("re-runs every node between the target and a gateway that routes back, then follows its final route", async () => {
      const gate = makeNode("G");
      gate.data.role = AgentRole.Gateway;
      useWorkflowStore.setState({
        nodes: [makeNode("D"), makeNode("C"), gate, makeNode("S")],
        edges: [
          { id: "d-c", source: "D", target: "C" }, { id: "c-g", source: "C", target: "G" },
          feedback("G", "D", "revise"), { id: "g-s", source: "G", target: "S", data: { label: "ship" } },
        ],
      });
      const count: Record<string, number> = { D: 0, C: 0, G: 0, S: 0 };
      const drafts: string[] = [];
      mockInvokeHandler("call_ollama_api", (args) => {
        const name = who(args);
        count[name]++;
        if (name === "D") drafts.push((args as { userMessage: string }).userMessage);
        if (name === "G") return count.G === 1 ? '{"route":"revise"}' : '{"route":"ship"}';
        if (name === "C") return count.C === 1 ? "REVISE: add the missing section" : "PASS";
        return `${name} ${count[name]}`;
      });

      const finished = await run();

      expect(count).toEqual({ D: 2, C: 2, G: 2, S: 1 });
      expect(finished?.agents.S.status).toBe("done");
      // The gateway only routes: the drafter must still see the critique it acted on.
      expect(drafts[1]).toContain("REVISE: add the missing section");
      expect(drafts[1]).toContain('{"route":"revise"}');
    });

    it("re-runs only the agents whose feedback edge the verdict names", async () => {
      useWorkflowStore.setState({
        nodes: [makeNode("A"), makeNode("B"), makeNode("R")],
        edges: [
          { id: "a-r", source: "A", target: "R" }, { id: "b-r", source: "B", target: "R" },
          feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix"),
        ],
      });
      const count: Record<string, number> = { A: 0, B: 0, R: 0 };
      mockInvokeHandler("call_ollama_api", (args) => {
        const name = who(args);
        count[name]++;
        return name === "R" ? (count.R === 1 ? '{"verdict":"rust-fix"}' : "APPROVED") : "ok";
      });

      await run();

      expect(count).toEqual({ A: 1, B: 2, R: 2 });
    });

    it("ends the loop when the run is stopped during a revision round", async () => {
      useWorkflowStore.setState({
        nodes: [makeNode("W"), makeNode("R")],
        edges: [{ id: "w-r", source: "W", target: "R" }, feedback("R", "W", "revise")],
      });
      let draftCalls = 0;
      mockInvokeHandler("call_ollama_api", (args) => {
        if (who(args) === "R") return "REVISE";
        draftCalls++;
        return draftCalls === 1 ? "draft 1" : new Promise<string>(() => {}); // revising when Stop is pressed
      });
      const { result } = renderHook(() => useWorkflowExecution());

      await act(async () => {
        const first = result.current.executeWorkflow(undefined, vi.fn());
        while (draftCalls < 2) await new Promise((resolve) => setTimeout(resolve, 10));
        useExecutionStore.getState().cancelRun();
        await first;
      });

      const stopped = useExecutionStore.getState().currentRun;
      expect(stopped?.status).toBe("cancelled");
      expect(stopped?.agents.W.status).toBe("stopped");
      expect(draftCalls).toBe(2);
    });
  });

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

  it("shows a native turn's text as it streams in, then the final answer", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 2;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const seen: string[] = [];
    mockInvokeHandler("chat_turn", async (args) => {
      const { onDelta } = args as { onDelta: { onmessage: (d: { text: string }) => void } | null };
      onDelta?.onmessage({ text: "Hel" });
      onDelta?.onmessage({ text: "lo" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      seen.push(useExecutionStore.getState().currentRun?.agents.A.output ?? "");
      return { text: "Hello", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });

    const finished = await run();

    expect(seen).toEqual(["Hello"]);
    expect(finished?.agents.A.output).toBe("Hello");
  });

  it("asks again without streaming when the server cannot stream, and stops streaming to it", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("read_workspace_file", () => "A");
    const streamed: boolean[] = [];
    let calls = 0;
    mockInvokeHandler("chat_turn", async (args) => {
      calls++;
      const streaming = Boolean((args as { onDelta: unknown }).onDelta);
      streamed.push(streaming);
      if (streaming) throw new Error("Streaming is not supported by this server");
      return calls < 3
        ? { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
            toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.md" } }] }
        : { text: "done", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });

    const finished = await run();

    expect(finished?.agents.A).toMatchObject({ status: "done", output: "done" });
    expect(streamed).toEqual([true, false, false]);
  });

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

  describe("shell commands", () => {
    /** Node A runs `npm test` with bash, then answers from the result. */
    function commandNode(timeoutSeconds = 300) {
      const node = makeNode("A");
      node.data.tools = [ToolPermission.Bash];
      node.data.maxSteps = 3;
      node.data.timeoutSeconds = timeoutSeconds;
      useWorkflowStore.setState({ nodes: [node], edges: [] });
      const messages: string[] = [];
      mockInvokeHandler("call_ollama_api", (args) => {
        messages.push((args as { userMessage: string }).userMessage);
        return messages.length === 1
          ? '<tool_call>{"name":"bash","args":{"command":"npm test"}}</tool_call>'
          : "tests checked";
      });
      const executed = vi.fn(() => ({ exitCode: 0, stdout: "5 passed", stderr: "", durationMs: 900 }));
      mockInvokeHandler("execute_command", executed);
      return { messages, executed };
    }

    async function waitForApprovalPrompt() {
      while (useCommandConsentStore.getState().queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return useCommandConsentStore.getState().queue[0];
    }

    beforeEach(() => useCommandConsentStore.setState({ queue: [], grants: {} }));

    it("runs an agent's command once the user approves it and gives the agent the result", async () => {
      const { messages, executed } = commandNode();
      const { result } = renderHook(() => useWorkflowExecution());

      let request: CommandRequest | undefined;
      await act(async () => {
        const running = result.current.executeWorkflow(undefined, vi.fn());
        request = await waitForApprovalPrompt();
        expect(executed).not.toHaveBeenCalled();
        useCommandConsentStore.getState().answer(request.id, "allow");
        await running;
      });

      expect(request).toMatchObject({ agentName: "A", command: "npm test", workspacePath: "/ws" });
      expect(executed).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/ws", command: "npm test", consentGranted: true }));
      expect(messages[1]).toContain("5 passed");
      expect(useExecutionStore.getState().currentRun?.agents.A.status).toBe("done");
      expect(useAuditStore.getState().entries.some((e) => e.action === "command_executed" && e.success)).toBe(true);
    });

    it("stops the node and runs nothing when Stop is pressed while a command waits for approval", async () => {
      const { executed } = commandNode();
      const { result } = renderHook(() => useWorkflowExecution());

      await act(async () => {
        const running = result.current.executeWorkflow(undefined, vi.fn());
        await waitForApprovalPrompt();
        useExecutionStore.getState().cancelRun();
        await running;
      });

      expect(executed).not.toHaveBeenCalled();
      expect(useCommandConsentStore.getState().queue).toEqual([]);
      expect(useExecutionStore.getState().currentRun?.agents.A.status).toBe("stopped");
    });

    it("kills a command that is running when Stop is pressed", async () => {
      commandNode();
      mockInvokeHandler("execute_command", () => new Promise(() => {}));
      const cancelled = vi.fn(() => true);
      mockInvokeHandler("cancel_command", cancelled);
      const { result } = renderHook(() => useWorkflowExecution());

      await act(async () => {
        const running = result.current.executeWorkflow(undefined, vi.fn());
        const request = await waitForApprovalPrompt();
        useCommandConsentStore.getState().answer(request.id, "allow");
        await new Promise((resolve) => setTimeout(resolve, 50));
        useExecutionStore.getState().cancelRun();
        await running;
      });

      expect(cancelled).toHaveBeenCalledWith({ commandId: expect.stringMatching(/-cmd-\d+$/) });
      expect(useExecutionStore.getState().currentRun?.agents.A.status).toBe("stopped");
    });

    it("does not time the agent out while it waits for the user's answer", async () => {
      const { executed } = commandNode(1);
      const { result } = renderHook(() => useWorkflowExecution());

      await act(async () => {
        const running = result.current.executeWorkflow(undefined, vi.fn());
        const request = await waitForApprovalPrompt();
        await new Promise((resolve) => setTimeout(resolve, 1300)); // past the node's 1 s limit
        useCommandConsentStore.getState().answer(request.id, "allow");
        await running;
      });

      expect(executed).toHaveBeenCalled();
      expect(useExecutionStore.getState().currentRun?.agents.A.status).toBe("done");
    });
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

    // Only the run record is written; the agent's write never ran.
    expect(writes.filter((w) => !(w as { relativePath: string }).relativePath.startsWith(".harness/runs/"))).toEqual([]);
  });

  it("saves each run's record in the workspace, where harness run can resume it", async () => {
    // Canvas ids, not the file's agent-<i>: the record names nodes by their place in the file.
    const a = { ...makeNode("A"), id: "node-1" };
    const b = { ...makeNode("B"), id: "node-2" };
    useWorkflowStore.setState({ nodes: [a, b], edges: [{ id: "e", source: "node-1", target: "node-2" }] });
    const records: RunRecord[] = [];
    mockInvokeHandler("write_workspace_file", (args) => {
      const { relativePath, content } = args as { relativePath: string; content: string };
      if (relativePath.startsWith(".harness/runs/")) records.push(JSON.parse(content));
    });
    mockInvokeHandler("call_ollama_api", (args) =>
      (args as { system: string }).system.startsWith("You are B") ? Promise.reject(new Error("model crashed")) : "first");

    const finished = await run();

    const record = records.at(-1)!;
    expect(record).toMatchObject({
      runId: finished?.id, status: "error",
      nodes: { "agent-0": { agent: "A", status: "done" }, "agent-1": { agent: "B", status: "error" } },
    });

    // harness run resumes it with the saved file's graph: A is reused.
    const calls: string[] = [];
    mockInvokeHandler("call_ollama_api", (args) => {
      calls.push(/^You are (\w+),/.exec((args as { system: string }).system)![1]);
      return "second";
    });
    const outcome = await runWorkflow({
      graph: defToGraph(useWorkflowStore.getState().toWorkflowDef()),
      config: { userInput: "", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
      provider: {
        llmProvider: "ollama", apiKey: "", openaiApiKey: "", ollamaApiKey: "", ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "qwen2.5-coder:7b", customApiUrl: "", customApiKey: "", customApiModel: "",
      },
      workspacePath: "/ws", continueOnError: true, resume: record,
    }, {
      invoke: mockInvoke, askCommand: async () => "deny", isCancelled: () => false, revealOutput: false,
      events: {
        onRunStarted: () => {}, onAgentUpdate: () => {}, onNodeStatus: () => {}, onAudit: () => {},
        onFileChange: () => {}, onRunFinished: () => {},
      },
    });
    expect(calls).toEqual(["B"]);
    expect(outcome.started && outcome.run.agents["agent-0"]).toMatchObject({ status: "done", output: "first" });
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
