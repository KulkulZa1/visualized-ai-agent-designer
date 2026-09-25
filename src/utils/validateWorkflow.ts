/**
 * Workflow graph validation — runs client-side before save or on demand.
 */
import type { AgentNode, ValidationResult, ValidationError, ValidationWarning } from "@/types/workflow";
import type { Edge } from "@xyflow/react";
import { AgentRole, ToolPermission } from "@/types/agent";

type EdgeData = { edgeKind?: string };

function isFeedbackEdge(edge: Edge): boolean {
  return (edge.data as EdgeData | undefined)?.edgeKind === "feedback" || edge.type === "feedback";
}

export function validateWorkflow(nodes: AgentNode[], edges: Edge[]): ValidationResult {
  const errors:   ValidationError[]   = [];
  const warnings: ValidationWarning[] = [];

  // ── Disconnected nodes ──────────────────────────────────────────────────
  const connected = new Set<string>();
  edges.forEach((e) => { connected.add(e.source); connected.add(e.target); });
  nodes.forEach((n) => {
    if (!connected.has(n.id) && nodes.length > 1) {
      errors.push({ nodeId: n.id, kind: "disconnected",
        message: `"${n.data.name}" is not connected to any other node.` });
    }
  });

  // ── Cycle detection (DFS) ───────────────────────────────────────────────
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => adj.set(n.id, []));
  edges.forEach((e) => {
    if (!isFeedbackEdge(e)) adj.get(e.source)?.push(e.target);
  });

  const visited = new Set<string>();
  const inStack = new Set<string>();
  let hasCycle  = false;

  function dfs(id: string): void {
    if (inStack.has(id)) { hasCycle = true; return; }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    adj.get(id)?.forEach(dfs);
    inStack.delete(id);
  }
  nodes.forEach((n) => dfs(n.id));
  if (hasCycle) {
    errors.push({ kind: "cycle", message: "Workflow contains a cycle (non-feedback loop). Remove or mark edges as feedback." });
  }

  // ── Per-node checks ─────────────────────────────────────────────────────
  nodes.forEach((n) => {
    const d = n.data;

    // Missing prompt (ignore memory/hook nodes)
    if (d.role !== AgentRole.Memory && d.role !== AgentRole.Hook) {
      const empty = d.promptSource.type === "inline"
        ? d.promptSource.content.trim().length === 0
        : d.promptSource.path.trim().length === 0;
      if (empty) {
        errors.push({ nodeId: n.id, kind: "missing_prompt",
          message: `"${d.name}" has no system prompt.` });
      }
    }

    // No model (ignore hook/memory/tool nodes)
    if (!d.model && d.role !== AgentRole.Hook && d.role !== AgentRole.Memory) {
      errors.push({ nodeId: n.id, kind: "no_model",
        message: `"${d.name}" has no model selected.` });
    }

    // High token budget (>100k)
    if (d.tokens.budget > 100000) {
      warnings.push({ nodeId: n.id, kind: "high_token_budget",
        message: `"${d.name}" has a very high token budget (${(d.tokens.budget/1000).toFixed(0)}k). Verify this is intentional.` });
    }

    // Many tools (>8)
    if (d.tools.length > 8) {
      warnings.push({ nodeId: n.id, kind: "many_tools",
        message: `"${d.name}" has ${d.tools.length} tools — consider restricting to what's needed.` });
    }

    // Bash: commands wait for the user's approval during the run (hooks on agent
    // nodes are not run during workflows, so they are no gate).
    if (d.tools.includes(ToolPermission.Bash)) {
      warnings.push({ nodeId: n.id, kind: "no_hooks_on_bash",
        message: `"${d.name}" can run shell commands (bash): each new command waits for your approval (once, or for the rest of the run) while the workflow runs.` });
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}
