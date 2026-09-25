import { describe, it, expect } from "vitest";
import { createReporter } from "@/cli/report";
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
  it("prints each agent's start and end, and its commands, compactions and revisions", () => {
    const { reporter: { events }, out } = capture(false);

    events.onRunStarted("run-1", "W");
    events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running", startedAt: 1000,
      modelUsed: "qwen3:8b", providerUsed: "ollama" });
    events.onAudit(audit("Coder", "file_read", "Tool: read_file({})"));
    events.onAudit(audit("Coder", "command_executed", "Coder ran: npm test (allowed by --allow-command; exit 0, 900 ms)"));
    events.onAudit(audit("Coder", "workflow_loaded", "↻ Coder: compacted 2 earlier steps (~4,000 → ~900 tokens)"));
    events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 13_300 });
    events.onAudit(audit("Reviewer", "workflow_loaded", "↺ Reviewer asked for revision 1/2: re-running Coder"));
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

  it("emits one JSON event per line with --json, ending with the summary", () => {
    const { reporter, out } = capture(true);

    reporter.events.onRunStarted("run-1", "W");
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running",
      startedAt: 1000, modelUsed: "m", providerUsed: "ollama" });
    reporter.events.onAudit(audit("Coder", "command_executed", "Coder: command denied (not in --allow-command): rm -rf /", false));
    reporter.events.onAudit(audit("Coder", "file_read", "Tool: read_file({})"));
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
