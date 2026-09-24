/** "skipped": not run because of gateway routing; "stopped": the run was stopped while it worked. */
export type AgentStatus = "idle" | "waiting" | "running" | "done" | "error" | "skipped" | "stopped";

/** A helper started with `subagent_dispatch` while its parent node ran. */
export interface SubAgentRecord {
  id: string;
  name: string;
  task: string;
  tools: string[];
  /** "stopped": the run was stopped while the helper worked. */
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  finishedAt?: number;
  /** The helper's final report. */
  output?: string;
  error?: string;
  toolCalls?: number;
}

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
  subAgents?: SubAgentRecord[];
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "error" | "cancelled";
  agents: Record<string, AgentRun>;
}
