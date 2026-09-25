/**
 * projectInstructions — the workspace's AGENTS.md (the instructions file Codex
 * and other coding agents read), for agents that work in the workspace.
 */
import { runnableTools } from "@/services/execution/toolExecutor";

const MAX_CHARS = 32 * 1024;
const WORKSPACE_TOOLS = new Set([
  "read_file", "fs.read", "list_files", "grep", "fs.write", "fs.append", "edit_file", "bash",
]);

/** AGENTS.md from the workspace root, capped at 32 KB; "" when there is none. */
export async function loadProjectInstructions(read: (path: string) => Promise<string>): Promise<string> {
  let text: string;
  try {
    text = await read("AGENTS.md");
  } catch {
    return "";
  }
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[AGENTS.md truncated at 32 KB]` : text;
}

/** Only agents that work in the workspace get the project's instructions. */
export function usesWorkspace(tools: string[]): boolean {
  return runnableTools(tools).some((t) => WORKSPACE_TOOLS.has(t));
}
