export type AuditAction =
  | "file_read"
  | "file_write"
  | "hook_executed"
  | "command_executed"
  | "workflow_saved"
  | "workflow_loaded"
  | "workspace_opened";

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  path?: string;
  agentId?: string;
  details?: string;
  success: boolean;
}
