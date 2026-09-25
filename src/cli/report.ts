/**
 * How `harness run` reports a run on stdout: a line per event and a summary,
 * or with --json one JSON object per line (docs/HEADLESS.md).
 */
import { isFeedbackEdge, type RunEvents, type RunOutcome } from "@/engine/runWorkflow";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { lineCounts } from "@/services/execution/changeLog";
import { AgentRole } from "@/types/agent";
import type { AgentRun, AgentStatus, WorkflowRun } from "@/types/execution";

export type Write = (line: string) => void;

export interface Reporter {
  events: RunEvents;
  summary: (outcome: RunOutcome, elapsedMs: number) => void;
}

const ENDED: ReadonlySet<AgentStatus> = new Set(["done", "error", "stopped", "skipped"]);
const ICON: Record<AgentStatus, string> = {
  idle: "·", waiting: "·", running: "·", done: "✓", error: "✗", stopped: "■", skipped: "–",
};
const RESULT: Record<WorkflowRun["status"], string> = {
  running: "Running", done: "Done", error: "Failed", cancelled: "Stopped",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function endLine(agent: AgentRun, durationMs: number | undefined): string {
  switch (agent.status) {
    case "done": return `✓ ${agent.agentName} done${durationMs === undefined ? "" : ` (${seconds(durationMs)})`}`;
    case "error": return `✗ ${agent.agentName} failed: ${agent.error ?? "unknown error"}`;
    case "stopped": return `■ ${agent.agentName} stopped`;
    default: return `– ${agent.agentName} skipped`;
  }
}

export function createReporter(graph: WorkflowGraph, json: boolean, out: Write, err: Write): Reporter {
  const emit = (event: Record<string, unknown>) => out(JSON.stringify(event));
  const name = (nodeId: string) => graph.nodes.find((n) => n.id === nodeId)?.data.name ?? nodeId;
  // The run's result is the output of the agents no other agent runs after
  // (memory and hook nodes store or check; they don't answer).
  const agentIds = new Set(graph.nodes
    .filter((n) => n.data.role !== AgentRole.Memory && n.data.role !== AgentRole.Hook)
    .map((n) => n.id));
  const hasNext = new Set(graph.edges
    .filter((e) => !isFeedbackEdge(e) && agentIds.has(e.target))
    .map((e) => e.source));
  const finalNodes = graph.nodes.filter((n) => agentIds.has(n.id) && !hasNext.has(n.id));
  const agents: Record<string, AgentRun> = {};

  const events: RunEvents = {
    onRunStarted: (runId, workflowName) => {
      if (json) emit({ type: "run_started", runId, workflow: workflowName });
      else out(`Run ${runId}: ${workflowName} (${graph.nodes.length} agents)`);
    },
    onAgentUpdate: (nodeId, partial) => {
      const agent = agents[nodeId] = {
        ...(agents[nodeId] ?? { agentId: nodeId, agentName: name(nodeId), status: "idle" }), ...partial,
      };
      if (partial.status === "running") {
        if (json) {
          emit({ type: "node_started", nodeId, agent: agent.agentName, model: agent.modelUsed,
            provider: agent.providerUsed, revision: agent.revision });
        } else {
          out(`▶ ${agent.agentName} started${agent.modelUsed ? ` (${agent.modelUsed} via ${agent.providerUsed})` : ""}`);
        }
      } else if (partial.status && ENDED.has(partial.status)) {
        const durationMs = agent.startedAt && agent.finishedAt ? agent.finishedAt - agent.startedAt : undefined;
        if (json) {
          emit({ type: "node_finished", nodeId, agent: agent.agentName, status: agent.status, output: agent.output,
            error: agent.error, durationMs, revision: agent.revision });
        } else {
          out(endLine(agent, durationMs));
        }
      }
    },
    onNodeStatus: () => {},
    onAudit: (entry) => {
      const details = entry.details ?? "";
      const type = entry.action === "command_executed" ? "command"
        : details.startsWith("↺") ? "revision"
        : details.startsWith("↻") ? "compaction"
        : "audit";
      if (json) emit({ type, nodeId: entry.agentId, details, success: entry.success });
      else if (type === "command") out(`$ ${details}`);
      else if (type !== "audit") out(details);
    },
    onFileChange: () => {},
    onRunFinished: () => {},
  };

  const summary = (outcome: RunOutcome, elapsedMs: number) => {
    if (!outcome.started) {
      if (json) emit({ type: "run_finished", status: "not_started", error: outcome.error });
      else err(`harness run: the run did not start: ${outcome.error}`);
      return;
    }
    const { run } = outcome;
    const changes = (run.changes ?? []).map((c) => ({
      path: c.path, created: c.before === null, ...lineCounts(c.before, c.after),
    }));
    const outputs = finalNodes
      .filter((n) => run.agents[n.id]?.output)
      .map((n) => ({ id: n.id, name: n.data.name, output: run.agents[n.id].output ?? "" }));
    if (json) {
      emit({
        type: "run_finished", runId: run.id, status: run.status, durationMs: elapsedMs,
        agents: Object.fromEntries(graph.nodes.map((n) => [n.id, { agent: n.data.name, status: run.agents[n.id]?.status ?? "idle" }])),
        changes,
        outputs: Object.fromEntries(outputs.map((o) => [o.id, o.output])),
      });
      return;
    }
    out("");
    out(`${RESULT[run.status]} in ${seconds(elapsedMs)} · run ${run.id}`);
    for (const n of graph.nodes) {
      const status = run.agents[n.id]?.status ?? "idle";
      out(`  ${ICON[status]} ${n.data.name}: ${status === "idle" ? "not run" : status}`);
    }
    if (changes.length > 0) {
      out("Changed files:");
      for (const c of changes) out(`  ${c.path}${c.created ? " (new)" : ""}  +${c.added} −${c.removed}`);
    }
    for (const o of outputs) {
      out("");
      out(`Final output — ${o.name}:`);
      for (const line of o.output.split("\n")) out(`  ${line}`);
    }
  };

  return { events, summary };
}
