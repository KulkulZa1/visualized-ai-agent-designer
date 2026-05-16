export type AgentStatus = "idle" | "waiting" | "running" | "done" | "error" | "skipped";

export interface AgentRun {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  tokensUsed?: number;
  providerUsed?: string;
  modelUsed?: string;
  tokenEstimate?: number;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "error" | "cancelled";
  agents: Record<string, AgentRun>;
}
