import type { AuditAction, AuditEntry } from "@/types/audit";
import { generateNodeId } from "./idGenerator";

export function makeAuditEntry(
  action: AuditAction,
  success: boolean,
  opts?: { path?: string; agentId?: string; details?: string }
): AuditEntry {
  return {
    id: generateNodeId("audit"),
    timestamp: new Date().toISOString(),
    action,
    success,
    path: opts?.path,
    agentId: opts?.agentId,
    details: opts?.details,
  };
}
