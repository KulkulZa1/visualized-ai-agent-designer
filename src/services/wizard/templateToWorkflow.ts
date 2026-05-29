/**
 * templateToWorkflow — converts a GoalTemplate into a runnable WorkflowDef.
 *
 * Pure function. No side effects. Produces a workflow that passes
 * workflowDefSchema validation and can be loaded directly into the canvas.
 */
import { AgentRole, ToolPermission } from "@/types/agent";
import type { AgentNodeData } from "@/types/agent";
import type { WorkflowDef, WorkflowConnection } from "@/types/workflow";
import type { GoalTemplate, ProviderCategory } from "./goalTemplates";

const DEFAULT_BUDGETS: Record<AgentRole, number> = {
  [AgentRole.Orchestrator]: 32000,
  [AgentRole.Worker]:       40000,
  [AgentRole.Critic]:       24000,
  [AgentRole.Aggregator]:   48000,
  [AgentRole.Memory]:       16000,
  [AgentRole.Gateway]:       8000,
  [AgentRole.Hook]:             0,
  [AgentRole.ToolCaller]:   20000,
};

function defaultToolsForRole(role: AgentRole): ToolPermission[] {
  switch (role) {
    case AgentRole.Orchestrator: return [ToolPermission.ReadFile, ToolPermission.ListFiles, ToolPermission.TodoWrite];
    case AgentRole.Worker:       return [ToolPermission.ReadFile, ToolPermission.FsRead, ToolPermission.ListFiles];
    case AgentRole.Critic:       return [ToolPermission.ReadFile, ToolPermission.Grep];
    case AgentRole.Aggregator:   return [ToolPermission.ReadFile];
    case AgentRole.Memory:       return [ToolPermission.FsAppend, ToolPermission.FsRead];
    case AgentRole.Hook:         return [];
    case AgentRole.Gateway:      return [ToolPermission.Classify];
    case AgentRole.ToolCaller:   return [ToolPermission.ReadFile, ToolPermission.ListFiles, ToolPermission.Grep];
    default:                     return [];
  }
}

function modelForProvider(category: ProviderCategory, capability: "general" | "fast" | "strong"): string {
  if (category === "local") {
    return capability === "strong" ? "qwen2.5-coder:14b"
         : capability === "fast"   ? "qwen2.5:7b"
         : "qwen2.5-coder:7b";
  }
  if (category === "ollama-cloud") return "gemma4:31b-cloud";
  if (category === "anthropic") {
    return capability === "strong" ? "claude-opus-4.6"
         : capability === "fast"   ? "claude-haiku-4.5"
         : "claude-sonnet-4.6";
  }
  if (category === "openai") {
    return capability === "strong" ? "gpt-5.5-xhigh"
         : capability === "fast"   ? "gpt-4o-mini"
         : "gpt-4o";
  }
  // openai-compatible — let user fill in
  return "";
}

function capabilityForRole(role: AgentRole): "general" | "fast" | "strong" {
  if (role === AgentRole.Orchestrator) return "strong";
  if (role === AgentRole.Critic)       return "strong";
  if (role === AgentRole.Aggregator)   return "general";
  if (role === AgentRole.Worker)       return "general";
  return "fast";
}

export interface ConvertOptions {
  /** Provider category to pick models from. */
  provider: ProviderCategory;
  /** Optional override for all agent models (e.g. force one specific model). */
  modelOverride?: string;
  /** Optional workspace project root to bake into the workflow meta. */
  projectRoot?: string;
}

/**
 * Convert a GoalTemplate into a fully-formed WorkflowDef that can be loaded
 * into the canvas. Positions are auto-generated in a left-to-right layout.
 */
export function templateToWorkflowDef(
  template: GoalTemplate,
  opts: ConvertOptions,
): WorkflowDef {
  const now = new Date().toISOString();

  const agents: AgentNodeData[] = template.recommendedAgents.map((a) => {
    const role = a.role;
    const isExecutable = role !== AgentRole.Memory && role !== AgentRole.Hook;
    const model = !isExecutable
      ? ""
      : (opts.modelOverride ?? modelForProvider(opts.provider, capabilityForRole(role)));

    return {
      name: a.name,
      role,
      model,
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 10,
      timeoutSeconds: 300,
      promptSource: {
        type: "inline" as const,
        content: a.description
          ? `You are ${a.name}.\n\n${a.description}\n\nOutput a concise result for the next agent.`
          : `You are ${a.name}. Execute your role in the ${template.title} workflow.`,
      },
      tools: defaultToolsForRole(role),
      memoryRead: [],
      memoryWrite: role === AgentRole.Memory ? [`${template.id}-store`] : [],
      tokens: { used: 0, budget: DEFAULT_BUDGETS[role] ?? 16000 },
      status: "idle" as const,
      description: a.description,
    };
  });

  const connections: WorkflowConnection[] = template.recommendedEdges.map((e, i) => ({
    id: `edge-${i}`,
    sourceAgentId: `agent-${e.from}`,
    targetAgentId: `agent-${e.to}`,
    label: e.label,
    edgeKind: e.kind,
  }));

  // Auto-layout: cycle-safe LR layering.
  // Ignores feedback edges so we don't loop forever on workflows with revision loops.
  const nodePositions: Record<string, { x: number; y: number }> = {};
  const forwardConnections = connections.filter((c) => c.edgeKind !== "feedback");

  const inDegree = new Map<string, number>();
  for (let i = 0; i < agents.length; i++) inDegree.set(`agent-${i}`, 0);
  for (const c of forwardConnections) {
    inDegree.set(c.targetAgentId, (inDegree.get(c.targetAgentId) ?? 0) + 1);
  }

  // Kahn-style topo layering with explicit guard against re-enqueueing
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const id = `agent-${i}`;
    if ((inDegree.get(id) ?? 0) === 0) { levels.set(id, 0); queue.push(id); }
  }
  const visited = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const curLevel = levels.get(cur) ?? 0;
    for (const c of forwardConnections) {
      if (c.sourceAgentId !== cur) continue;
      const t = c.targetAgentId;
      const tLevelNew = curLevel + 1;
      const tLevelOld = levels.get(t) ?? 0;
      if (tLevelNew > tLevelOld) levels.set(t, tLevelNew);
      const remaining = (inDegree.get(t) ?? 0) - 1;
      inDegree.set(t, remaining);
      if (remaining <= 0 && !visited.has(t)) queue.push(t);
    }
  }

  // Group by level — any unleveled nodes (cycle leftovers) go in a final column
  const maxKnownLevel = Math.max(0, ...Array.from(levels.values()));
  const byLevel = new Map<number, string[]>();
  for (let i = 0; i < agents.length; i++) {
    const id = `agent-${i}`;
    const lvl = levels.has(id) ? levels.get(id)! : maxKnownLevel + 1;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(id);
  }
  for (const [level, ids] of byLevel) {
    ids.forEach((id, idx) => {
      nodePositions[id] = { x: 80 + level * 260, y: 80 + idx * 160 };
    });
  }

  return {
    meta: {
      name: template.title,
      version: "1.0.0",
      description: template.description,
      projectRoot: opts.projectRoot ?? "",
      createdAt: now,
      updatedAt: now,
    },
    agents,
    connections,
    executionSettings: {
      maxParallel: 4,
      timeoutSeconds: 600,
      retryOnFailure: false,
      maxRetries: 0,
    },
    nodePositions,
  };
}
