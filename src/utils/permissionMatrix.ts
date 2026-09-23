import { AgentRole, TOOL_RISK, ToolPermission, type AgentNodeData } from "@/types/agent";

export type PermissionRisk = "low" | "medium" | "high";

const RISK_ORDER: Record<PermissionRisk, number> = { low: 0, medium: 1, high: 2 };

export interface PermissionMatrixRow {
  agentName: string;
  role: AgentNodeData["role"];
  tools: ToolPermission[];
  grantedCount: number;
  highestRisk: PermissionRisk | null;
  requiresHookGate: boolean;
  hasHookGate: boolean;
  ungatedHighRiskTools: ToolPermission[];
}

export interface PermissionSummary {
  nodeCount: number;
  grantedCount: number;
  highRiskNodeCount: number;
  ungatedHighRiskNodeCount: number;
}

export function getHighestRisk(tools: ToolPermission[]): PermissionRisk | null {
  return tools.reduce<PermissionRisk | null>((highest, tool) => {
    const risk = TOOL_RISK[tool] ?? "low";
    if (!highest || RISK_ORDER[risk] > RISK_ORDER[highest]) return risk;
    return highest;
  }, null);
}

/** Pre/post hooks gate nothing on agent nodes: a workflow run executes a preHook
 *  only for Hook-role nodes and never executes postHooks. */
export function hasHookGate(agent: AgentNodeData): boolean {
  return agent.role === AgentRole.Hook && Boolean(agent.preHook?.path);
}

export function buildPermissionMatrix(agents: AgentNodeData[]): PermissionMatrixRow[] {
  return agents.map((agent) => {
    const highRiskTools = agent.tools.filter((tool) => TOOL_RISK[tool] === "high");
    const gated = hasHookGate(agent);
    return {
      agentName: agent.name,
      role: agent.role,
      tools: agent.tools,
      grantedCount: agent.tools.length,
      highestRisk: getHighestRisk(agent.tools),
      requiresHookGate: highRiskTools.length > 0,
      hasHookGate: gated,
      ungatedHighRiskTools: gated ? [] : highRiskTools,
    };
  });
}

export function getPermissionSummary(agents: AgentNodeData[]): PermissionSummary {
  const rows = buildPermissionMatrix(agents);
  return {
    nodeCount: rows.length,
    grantedCount: rows.reduce((sum, row) => sum + row.grantedCount, 0),
    highRiskNodeCount: rows.filter((row) => row.highestRisk === "high").length,
    ungatedHighRiskNodeCount: rows.filter((row) => row.ungatedHighRiskTools.length > 0).length,
  };
}
