import type { WorkflowDef } from "@/types/workflow";

export interface WorkflowDiff {
  added: string[];
  removed: string[];
  changed: string[];
  edgeChanges: number;
  summary: string;
}

export function diffWorkflows(before: WorkflowDef, after: WorkflowDef): WorkflowDiff {
  const beforeNames = new Set(before.agents.map((a) => a.name));
  const afterNames  = new Set(after.agents.map((a) => a.name));

  const added   = [...afterNames].filter((n) => !beforeNames.has(n));
  const removed = [...beforeNames].filter((n) => !afterNames.has(n));
  const changed = before.agents
    .filter((ba) => {
      const aa = after.agents.find((a) => a.name === ba.name);
      return aa && JSON.stringify(ba) !== JSON.stringify(aa);
    })
    .map((a) => a.name);

  const edgeChanges = Math.abs(before.connections.length - after.connections.length);

  const parts = [
    added.length   ? `+${added.length} agents`  : "",
    removed.length ? `-${removed.length} agents` : "",
    changed.length ? `~${changed.length} changed` : "",
    edgeChanges    ? `${edgeChanges} edge Δ`      : "",
  ].filter(Boolean);

  return {
    added,
    removed,
    changed,
    edgeChanges,
    summary: parts.length ? parts.join(", ") : "No changes",
  };
}
