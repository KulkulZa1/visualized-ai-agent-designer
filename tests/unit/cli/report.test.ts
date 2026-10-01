import { describe, it, expect } from "vitest";
import { createReporter, finalNodes, finalOutputs } from "@/cli/report";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { WorkflowRun } from "@/types/execution";
import type { AgentNode } from "@/types/workflow";

function node(id: string): AgentNode {
  return {
    id, type: "agent", position: { x: 0, y: 0 },
    data: {
      name: id, role: AgentRole.Worker, model: "m", temperature: 0.7, maxTokens: 1024, maxSteps: 3,
      timeoutSeconds: 300, promptSource: { type: "inline", content: "" }, tools: [], memoryRead: [],
      memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    },
  };
}

/** Coder → Reviewer, with a feedback edge back: only Reviewer's output is the result. */
const graph: WorkflowGraph = {
  nodes: [node("Coder"), node("Reviewer")],
  edges: [
    { id: "c-r", source: "Coder", target: "Reviewer" },
    { id: "r-c", source: "Reviewer", target: "Coder", data: { edgeKind: "feedback", label: "revise" } },
  ],
  meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
  executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
};

const audit = (agentId: string, action: AuditEntry["action"], details: string, success = true): AuditEntry =>
  ({ id: details, timestamp: "", action, agentId, details, success });

const run: WorkflowRun = {
  id: "run-1", workflowName: "W", startedAt: 0, status: "done",
  agents: {
    Coder: { agentId: "Coder", agentName: "Coder", status: "done", output: "patched" },
    Reviewer: { agentId: "Reviewer", agentName: "Reviewer", status: "done", output: "Looks good.\nShip it." },
  },
  changes: [{ path: "src/a.ts", before: "a\n", after: "a\nb\n", agents: ["Coder"], edits: 1 }],
};

function capture(json: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return { reporter: createReporter(graph, json, (l) => out.push(l), (l) => err.push(l)), out, err };
}

describe("createReporter", () => {
  it("says 1 agent, not 1 agents", () => {
    const out: string[] = [];
    const { events } = createReporter({ ...graph, nodes: [node("Coder")], edges: [] }, false,
      (l) => out.push(l), () => {});
    events.onRunStarted("run-1", "W");
    expect(out).toEqual(["Run run-1: W (1 agent)"]);
  });

  it("prints each agent's start and end, and its commands, compactions and revisions", () => {
    const { reporter: { events }, out } = capture(false);

    events.onRunStarted("run-1", "W");
    events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running", startedAt: 1000,
      modelUsed: "qwen3:8b", providerUsed: "ollama" });
    events.onAudit(audit("Coder", "tool_call", "Tool: read_file({})"));
    events.onAudit(audit("Coder", "command_executed", "Coder ran: npm test (allowed by --allow-command; exit 0, 900 ms)"));
    events.onAudit(audit("Coder", "compaction", "↻ Coder: compacted 2 earlier steps (~4,000 → ~900 tokens)"));
    events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 13_300 });
    events.onAudit(audit("Reviewer", "revision", "↺ Reviewer asked for revision 1/2: re-running Coder"));
    events.onAgentUpdate("Reviewer", { agentId: "Reviewer", agentName: "Reviewer", status: "error",
      error: "model crashed", finishedAt: 14_000 });

    expect(out).toEqual([
      "Run run-1: W (2 agents)",
      "▶ Coder started (qwen3:8b via ollama)",
      "$ Coder ran: npm test (allowed by --allow-command; exit 0, 900 ms)",
      "↻ Coder: compacted 2 earlier steps (~4,000 → ~900 tokens)",
      "✓ Coder done (12.3 s)",
      "↺ Reviewer asked for revision 1/2: re-running Coder",
      "✗ Reviewer failed: model crashed",
    ]);
  });

  it("prints and emits nothing more for the usage a node's update carries: the lines, and the events, are the same", () => {
    const usage = { input: 250, output: 30, calls: 2, callsWithoutUsage: 0 };
    for (const json of [false, true]) {
      const lines = (withUsage: boolean) => {
        const { reporter: { events }, out } = capture(json);
        events.onRunStarted("run-1", "W");
        events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running", startedAt: 1000,
          modelUsed: "qwen3:8b", providerUsed: "ollama" });
        events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 13_300, ...(withUsage ? { usage } : {}) });
        events.onAgentUpdate("Reviewer", { agentId: "Reviewer", agentName: "Reviewer", status: "error",
          error: "model crashed", finishedAt: 14_000, ...(withUsage ? { usage } : {}) });
        return out;
      };

      expect(lines(true), `json: ${json}`).toEqual(lines(false));
      expect(lines(true).join("\n")).not.toContain("usage");
    }
  });

  it("sums up the run: status, each agent, changed files and the final output", () => {
    const { reporter, out } = capture(false);

    reporter.summary({ started: true, run }, 45_210);

    expect(out).toEqual([
      "",
      "Done in 45.2 s · run run-1",
      "  ✓ Coder: done",
      "  ✓ Reviewer: done",
      "Changed files:",
      "  src/a.ts  +1 −0",
      "",
      "Final output — Reviewer:",
      "  Looks good.",
      "  Ship it.",
    ]);
  });

  it("takes the final output from the last agents, not from memory or hook nodes after them", () => {
    const writer = node("Writer");
    const log = node("Log");
    log.data.role = AgentRole.Memory;
    const out: string[] = [];
    const reporter = createReporter({ ...graph, nodes: [writer, log], edges: [{ id: "w-l", source: "Writer", target: "Log" }] },
      false, (l) => out.push(l), () => {});

    reporter.summary({ started: true, run: { ...run, changes: [], agents: {
      Writer: { agentId: "Writer", agentName: "Writer", status: "done", output: "The report." },
      Log: { agentId: "Log", agentName: "Log", status: "done", output: "Stored 1 key(s): report" },
    } } }, 1000);

    expect(out.slice(-2)).toEqual(["Final output — Writer:", "  The report."]);
  });

  it("shows reused agents once, and names the saved record", () => {
    const { reporter, out } = capture(false);
    reporter.events.onAudit(audit("Coder", "agent_reused", "↩ Coder: reused from the saved run (unchanged)"));
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "done", output: "patched",
      startedAt: 0, finishedAt: 5000 });
    reporter.summary({ started: true, run: { ...run, changes: [] } }, 1000, ".harness/runs/run-1/run.json");

    expect(out[0]).toBe("↩ Coder: reused from the saved run (unchanged)");
    expect(out).not.toContain("✓ Coder done (5.0 s)");
    expect(out).toContain("Saved: .harness/runs/run-1/run.json");
  });

  it("marks reused agents and the record in --json events", () => {
    const { reporter, out } = capture(true);
    reporter.events.onAudit(audit("Coder", "agent_reused", "↩ Coder: reused from the saved run (unchanged)"));
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "done", output: "patched" });
    reporter.summary({ started: true, run }, 1000, ".harness/runs/run-1/run.json");

    const events = out.map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "reused", nodeId: "Coder" });
    expect(events[1]).toMatchObject({ type: "node_finished", nodeId: "Coder", reused: true });
    expect(events[2]).toMatchObject({ type: "run_finished", trace: ".harness/runs/run-1/run.json" });
  });

  it("marks a warning in --json events: the run went on", () => {
    const { reporter, out } = capture(true);
    const details = "↺ Reviewer: revision limit (2) reached — continuing with the latest version";
    reporter.events.onAudit({ ...audit("Reviewer", "revision", details), warning: true });

    expect(JSON.parse(out[0])).toEqual(
      { type: "revision", nodeId: "Reviewer", details, success: true, warning: true });
  });

  describe("a context window warning", () => {
    // The audit entry's text starts with the ⚠ the app's audit strip shows.
    const text = "Coder: its prompt is about 4,000 tokens and it may reply with up to 1,000 tokens, but Ollama's " +
      "context window is 2,048 tokens, so Ollama may cut off the start of the prompt. Raise the context window.";
    const details = `⚠ ${text}`;
    const warning = { ...audit("Coder", "context_window", details), warning: true };

    it("goes to stderr as a warning, where the run's other warnings are, and not among the run's lines", () => {
      const { reporter: { events }, out, err } = capture(false);

      events.onAudit(warning);

      expect(err).toEqual([`warning: ${text}`]);
      expect(out).toEqual([]);
    });

    it("has one marker on stderr: the leading ⚠ goes, with its emoji selector when there is one, and the rest is left as it is", () => {
      const { reporter: { events }, err } = capture(false);
      // A name that starts with a digit or holds a ⚠ stays whole.
      const named = text.replace(/^Coder/, "2nd ⚠ Reviewer");

      events.onAudit({ ...warning, details: `\u26A0\uFE0F ${text}` });
      events.onAudit({ ...warning, details: `\u26A0${text}` });
      events.onAudit({ ...warning, details: text });
      events.onAudit({ ...warning, details: `⚠ ${named}` });
      events.onAudit({ ...warning, details: named });

      expect(err).toEqual([`warning: ${text}`, `warning: ${text}`, `warning: ${text}`, `warning: ${named}`, `warning: ${named}`]);
    });

    it("is a warning audit event with --json, and nothing on stderr", () => {
      const { reporter: { events }, out, err } = capture(true);

      events.onAudit(warning);

      expect(out.map((line) => JSON.parse(line))).toEqual([{ type: "audit", nodeId: "Coder", details, success: true, warning: true }]);
      expect(err).toEqual([]);
    });
  });

  it("emits one JSON event per line with --json, ending with the summary", () => {
    const { reporter, out } = capture(true);

    reporter.events.onRunStarted("run-1", "W");
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running",
      startedAt: 1000, modelUsed: "m", providerUsed: "ollama" });
    reporter.events.onAudit(audit("Coder", "command_executed", "Coder: command denied (not in --allow-command): rm -rf /", false));
    reporter.events.onAudit(audit("Coder", "tool_call", "Tool: read_file({})"));
    reporter.events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 2000 });
    reporter.summary({ started: true, run }, 5000);

    expect(out.map((line) => JSON.parse(line))).toEqual([
      { type: "run_started", runId: "run-1", workflow: "W" },
      { type: "node_started", nodeId: "Coder", agent: "Coder", model: "m", provider: "ollama" },
      { type: "command", nodeId: "Coder", details: "Coder: command denied (not in --allow-command): rm -rf /", success: false },
      { type: "audit", nodeId: "Coder", details: "Tool: read_file({})", success: true },
      { type: "node_finished", nodeId: "Coder", agent: "Coder", status: "done", output: "patched", durationMs: 1000 },
      {
        type: "run_finished", runId: "run-1", status: "done", durationMs: 5000,
        agents: { Coder: { agent: "Coder", status: "done" }, Reviewer: { agent: "Reviewer", status: "done" } },
        changes: [{ path: "src/a.ts", created: false, added: 1, removed: 0 }],
        outputs: { Reviewer: "Looks good.\nShip it." },
      },
    ]);
  });

  describe("a run that failed as a whole", () => {
    const error = "Run failed: No runnable nodes remain. Workflow may contain a cycle or blocked dependency: Coder, Reviewer";
    // No agent ran: only the error says what happened.
    const failed: WorkflowRun = { id: "run-1", workflowName: "W", startedAt: 0, status: "error", agents: {} };

    it("prints why after the agents' lines", () => {
      const { reporter, out, err } = capture(false);

      reporter.summary({ started: true, run: failed, error }, 1000);

      expect(out).toEqual([
        "",
        "Failed in 1.0 s · run run-1",
        "  · Coder: not run",
        "  · Reviewer: not run",
        error,
      ]);
      expect(err).toEqual([]);
    });

    it("has the error on the run_finished event with --json", () => {
      const { reporter, out } = capture(true);

      reporter.summary({ started: true, run: failed, error }, 1000);

      expect(out.map((line) => JSON.parse(line))).toEqual([{
        type: "run_finished", runId: "run-1", status: "error", durationMs: 1000,
        agents: { Coder: { agent: "Coder", status: "idle" }, Reviewer: { agent: "Reviewer", status: "idle" } },
        changes: [], outputs: {}, error,
      }]);
    });

    it("says nothing extra, and has no error field, for a run whose agents failed", () => {
      const agentFailed: WorkflowRun = { ...failed, agents: {
        Coder: { agentId: "Coder", agentName: "Coder", status: "error", error: "model crashed" },
      } };
      const human = capture(false);
      const json = capture(true);

      human.reporter.summary({ started: true, run: agentFailed }, 1000);
      json.reporter.summary({ started: true, run: agentFailed }, 1000);

      expect(human.out.some((line) => line.startsWith("Run failed"))).toBe(false);
      expect(JSON.parse(json.out[0])).not.toHaveProperty("error");
    });
  });

  it("reports a run that did not start on stderr, or as run_finished with --json", () => {
    const human = capture(false);
    human.reporter.summary({ started: false, error: "Ollama is not running" }, 10);
    expect(human.out).toEqual([]);
    expect(human.err).toEqual(["harness run: the run did not start: Ollama is not running"]);

    const json = capture(true);
    json.reporter.summary({ started: false, error: "Ollama is not running" }, 10);
    expect(json.out.map((line) => JSON.parse(line))).toEqual([
      { type: "run_finished", status: "not_started", error: "Ollama is not running" },
    ]);
  });
});

describe("finalNodes and finalOutputs: the run's result, which harness eval's output scorer reads too", () => {
  const memory = (id: string): AgentNode => ({ ...node(id), data: { ...node(id).data, role: AgentRole.Memory } });
  const hook = (id: string): AgentNode => ({ ...node(id), data: { ...node(id).data, role: AgentRole.Hook } });
  const finished = (outputs: Record<string, string | undefined>): WorkflowRun => ({
    id: "run-1", workflowName: "W", startedAt: 0, status: "done",
    agents: Object.fromEntries(Object.entries(outputs).map(([id, output]) => [id, { agentId: id, agentName: id, status: "done" as const, output }])),
  });

  it("are the agents no other agent runs after: a feedback edge does not make its source a predecessor", () => {
    // graph: Coder → Reviewer, and Reviewer → Coder as feedback
    expect(finalNodes(graph).map((n) => n.id)).toEqual(["Reviewer"]);
  });

  it("leave out memory and hook nodes, and a node followed only by them is still final", () => {
    const g: WorkflowGraph = {
      ...graph, nodes: [node("Writer"), memory("Notes"), hook("Check")],
      edges: [{ id: "w-n", source: "Writer", target: "Notes" }, { id: "n-c", source: "Notes", target: "Check" }],
    };

    expect(finalNodes(g).map((n) => n.id)).toEqual(["Writer"]);
  });

  it("are every agent nothing follows, when there are several", () => {
    const g: WorkflowGraph = { ...graph, nodes: [node("A"), node("B"), node("C")], edges: [{ id: "a-c", source: "A", target: "C" }] };

    expect(finalNodes(g).map((n) => n.id)).toEqual(["B", "C"]);
  });

  it("give each final agent's output with its name, in node order, and skip one with no output", () => {
    const g: WorkflowGraph = { ...graph, nodes: [node("A"), node("B"), node("C")], edges: [] };

    expect(finalOutputs(g, finished({ A: "first", B: undefined, C: "third" }))).toEqual([
      { id: "A", name: "A", output: "first" }, { id: "C", name: "C", output: "third" },
    ]);
    expect(finalOutputs(g, finished({ A: "", B: "" }))).toEqual([]);
    expect(finalOutputs(g, { ...finished({}), agents: {} })).toEqual([]);
  });

  it("are what the reporter's summary prints as the final output", () => {
    const { reporter, out } = capture(false);

    reporter.summary({ started: true, run }, 1000);

    expect(finalOutputs(graph, run)).toEqual([{ id: "Reviewer", name: "Reviewer", output: "Looks good.\nShip it." }]);
    expect(out.join("\n")).toContain("Final output — Reviewer:\n  Looks good.\n  Ship it.");
  });
});
