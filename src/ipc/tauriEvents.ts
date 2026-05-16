import { listen } from "@tauri-apps/api/event";
import type { AuditEntry } from "@/types/audit";

export type UnlistenFn = () => void;

export async function onAuditEntry(callback: (entry: AuditEntry) => void): Promise<UnlistenFn> {
  return listen<AuditEntry>("audit:entry", (event) => callback(event.payload));
}

export async function onWorkflowSaved(callback: (filePath: string) => void): Promise<UnlistenFn> {
  return listen<string>("workflow:saved", (event) => callback(event.payload));
}
