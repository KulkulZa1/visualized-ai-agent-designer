/**
 * Artifact persistence service.
 * Writes artifact content to .harness/artifacts/<nodeId>/<id>.<ext> via Tauri IPC.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Artifact } from "@/types/inspection";

const ARTIFACTS_DIR = ".harness/artifacts";

const _persistedPaths = new Set<string>();

export function getPersistedArtifactPaths(): string[] {
  return [..._persistedPaths];
}

function extForType(type: Artifact["type"]): string {
  if (type === "json") return "json";
  if (type === "yaml") return "yaml";
  if (type === "html") return "html";
  return "md";
}

/**
 * Persist an artifact to disk. Returns the relative path written.
 */
export async function persistArtifact(
  artifact: Artifact,
  workspacePath: string
): Promise<string> {
  const ext = extForType(artifact.type);
  const relativePath = `${ARTIFACTS_DIR}/${artifact.sourceNodeId}/${artifact.id}.${ext}`;
  await invoke<void>("write_workspace_file", {
    workspacePath,
    relativePath,
    content: artifact.content,
  });
  _persistedPaths.add(relativePath);
  return relativePath;
}

/**
 * Load artifact content from disk by its stored relative path.
 */
export async function loadArtifact(
  filePath: string,
  workspacePath: string
): Promise<string> {
  return invoke<string>("read_workspace_file", {
    workspacePath,
    relativePath: filePath,
  });
}

/**
 * Check whether an artifact file exists on disk.
 */
export async function artifactExists(
  filePath: string,
  workspacePath: string
): Promise<boolean> {
  try {
    await invoke<string>("read_workspace_file", {
      workspacePath,
      relativePath: filePath,
    });
    return true;
  } catch {
    return false;
  }
}
