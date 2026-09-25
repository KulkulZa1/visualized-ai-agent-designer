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
  /** Revision round the latest output belongs to (feedback loops); unset for the first run. */
  revision?: number;
}

/** A file the run's agents changed with fs.write, fs.append or edit_file. */
export interface FileChange {
  /** Workspace-relative, "/" separators. */
  path: string;
  /** Content before the run first changed it; null if the run created the file. */
  before: string | null;
  after: string;
  /** Names of the agents that changed it. */
  agents: string[];
  edits: number;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "error" | "cancelled";
  agents: Record<string, AgentRun>;
  /** Files changed by this run's agents (Changes dialog, revert). */
  changes?: FileChange[];
}
