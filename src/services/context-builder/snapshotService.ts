/**
 * Snapshot service façade.
 * Selects the file-backed adapter when a workspacePath is available,
 * otherwise falls back to the in-memory singleton.
 */

import {
  snapshotRepo,
  snapshotFromContextSnapshot,
  type PersistedSnapshot,
  type SnapshotStatus,
} from "./snapshotRepository";
import { FileSnapshotRepository } from "./fileSnapshotRepository";
import type { ExecutionContextSnapshot } from "@/types/inspection";

export type { PersistedSnapshot, SnapshotStatus };
export { snapshotFromContextSnapshot };

export async function createSnapshot(
  ctx: ExecutionContextSnapshot,
  opts: {
    workspacePath?: string | null;
    workflowId?: string;
    runId?: string;
    snapshotStatus?: SnapshotStatus;
    metadata?: Record<string, unknown>;
  }
): Promise<PersistedSnapshot> {
  const input = snapshotFromContextSnapshot(ctx, {
    workflowId: opts.workflowId,
    runId: opts.runId,
    snapshotStatus: opts.snapshotStatus ?? "mock",
  });

  // Merge any extra metadata (e.g. error info from failed runs)
  if (opts.metadata) {
    Object.assign(input.metadata, opts.metadata);
  }

  if (opts.workspacePath) {
    const repo = new FileSnapshotRepository(opts.workspacePath);
    return repo.create(input);
  }
  return snapshotRepo.create(input);
}

export async function listSnapshotsForNode(
  nodeId: string,
  workspacePath?: string | null
): Promise<PersistedSnapshot[]> {
  if (workspacePath) {
    const repo = new FileSnapshotRepository(workspacePath);
    return repo.listByNodeId(nodeId);
  }
  return snapshotRepo.listByNodeId(nodeId);
}

export async function updateSnapshot(
  id: string,
  patch: Partial<Omit<PersistedSnapshot, "id" | "createdAt">>,
  workspacePath?: string | null
): Promise<PersistedSnapshot | undefined> {
  if (workspacePath) {
    const repo = new FileSnapshotRepository(workspacePath);
    return repo.update(id, patch);
  }
  return snapshotRepo.update(id, patch);
}
