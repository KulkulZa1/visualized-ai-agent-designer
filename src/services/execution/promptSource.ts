/**
 * promptSource — resolve an agent's system prompt text for a run.
 *
 * File prompts are read from the open workspace. A prompt that cannot be read
 * fails the node instead of silently sending a placeholder to the model.
 */

import type { PromptSource } from "@/types/agent";

export type ReadWorkspaceFileFn = (workspacePath: string, relativePath: string) => Promise<string>;

export async function resolvePromptContent(
  source: PromptSource,
  workspacePath: string | null,
  readFile: ReadWorkspaceFileFn,
): Promise<string> {
  if (source.type === "inline") return source.content;

  if (!workspacePath) {
    throw new Error(`Prompt file "${source.path}" cannot be read: no workspace is open.`);
  }
  try {
    return await readFile(workspacePath, source.path);
  } catch (e) {
    throw new Error(`Prompt file "${source.path}" could not be read: ${String(e)}`);
  }
}
