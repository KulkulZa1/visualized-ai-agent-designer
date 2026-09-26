export type AuditAction =
  | "file_read"
  | "file_write"
  | "hook_executed"
  | "command_executed"
  | "workflow_saved"
  | "workflow_loaded"
  | "workspace_opened"
  // A run's events. Only commands and hooks are also saved to .harness/audit.log.jsonl.
  | "provider_check"
  | "provider_fallback"
  | "agent_started"
  | "agent_finished"
  | "agent_failed"
  | "agent_skipped"
  | "agent_reused"
  | "tool_call"
  | "subagent"
  | "revision"
  | "compaction"
  | "gateway_route"
  | "memory_write"
  | "run_record";

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  path?: string;
  agentId?: string;
  details?: string;
  success: boolean;
  /** A problem the run went on after (a fallback, a limit reached); `success` stays true. */
  warning?: boolean;
}
