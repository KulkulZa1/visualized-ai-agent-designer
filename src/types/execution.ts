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

/** The tokens a node's model calls used, as the providers reported them (not an estimate), summed over every
 *  call the node made: its own turns and text calls, the summaries that compact its conversation, its helpers'
 *  calls, and every attempt of it (a revision runs the node again). A call whose reply carried no counts (a
 *  local server may leave them out) is in `calls` and `callsWithoutUsage`, and adds nothing to `input` and
 *  `output`: with `callsWithoutUsage > 0` they are a lower bound, not the node's total. */
export interface NodeUsage {
  input: number;
  output: number;
  calls: number;
  callsWithoutUsage: number;
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
  /** Set on an agent node that ran (done, failed or stopped), and kept on one a gateway then dropped: its calls were
   *  paid for. A memory or hook node makes no model call. Unlike `tokenEstimate`, it adds up the node's revision attempts. */
  usage?: NodeUsage;
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
  /** The workspace folder the run worked in (the one the engine was given). `changes` are paths
   *  relative to it, so they can only be reverted there. Unset when no workspace was open. */
  workspacePath?: string;
  /** True once `agents` was cleared because another workflow was opened (`clearRun`).
   *  The run itself and its `changes` are kept; its late agent updates are dropped. */
  agentsCleared?: boolean;
}
