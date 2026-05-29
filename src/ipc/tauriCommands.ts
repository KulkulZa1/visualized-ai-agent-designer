import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isVsCode, vsCodeInvoke } from "@/ipc/vscodeInvoke";
import type { FileTreeEntry, HookResult } from "@/types/filesystem";
import type { WorkflowDef } from "@/types/workflow";
import type { AuditEntry } from "@/types/audit";

/** Unified invoke — uses VS Code bridge when running in a WebviewPanel, Tauri otherwise. */
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return isVsCode() ? vsCodeInvoke<T>(command, args) : tauriInvoke<T>(command, args);
}

export async function openWorkspaceDialog(): Promise<string | null> {
  return invoke<string | null>("open_workspace_dialog");
}

export async function listWorkspaceFiles(workspacePath: string): Promise<FileTreeEntry[]> {
  return invoke<FileTreeEntry[]>("list_workspace_files", { workspacePath });
}

export async function readWorkspaceFile(workspacePath: string, relativePath: string): Promise<string> {
  return invoke<string>("read_workspace_file", { workspacePath, relativePath });
}

export async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<void> {
  return invoke<void>("write_workspace_file", { workspacePath, relativePath, content });
}

export async function saveWorkflow(workspacePath: string, relativePath: string, def: WorkflowDef): Promise<void> {
  return invoke<void>("save_workflow", { workspacePath, relativePath, workflow: def });
}

export async function loadWorkflow(workspacePath: string, relativePath: string): Promise<WorkflowDef> {
  return invoke<WorkflowDef>("load_workflow", { workspacePath, relativePath });
}

export async function executeHook(
  workspacePath: string,
  hookPath: string,
  agentId: string,
  env: Record<string, string>,
  consentGranted: boolean
): Promise<HookResult> {
  return invoke<HookResult>("execute_hook", { workspacePath, hookPath, agentId, env, consentGranted });
}

export async function executeInlineCommand(
  workspacePath: string,
  command: string,
  consentGranted: boolean,
): Promise<HookResult> {
  return invoke<HookResult>("execute_inline_command", { workspacePath, command, consentGranted });
}

export async function writeAuditEntry(workspacePath: string, entry: AuditEntry): Promise<void> {
  return invoke<void>("write_audit_entry", { workspacePath, entry });
}
