/**
 * In-memory snapshot repository for persisted execution context snapshots.
 *
 * Storage layer: in-memory only (this module).
 * Future layers (not implemented here):
 *   - localStorage: serialize/deserialize via exportJson/importJson
 *   - Tauri file: replace SnapshotRepository with a file-backed adapter
 *   - SQLite: replace with a Tauri plugin-sql adapter
 * The interface is designed to be drop-in replaceable without touching callers.
 */

import type { ExecutionContextSnapshot } from "@/types/inspection";

// ── Types ────────────────────────────────────────────────────────────────────

export type SnapshotStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "mock";

export interface SnapshotPromptLayers {
  system: string;
  developer: string;
  user: string;
  agentInstruction: string;
  nodePrompt: string;
}

export interface PersistedSnapshot {
  id: string;
  workflowId?: string;
  nodeId: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  snapshotStatus: SnapshotStatus;
  providerId: string;
  model: string;
  promptLayers: SnapshotPromptLayers;
  upstreamInputs: Array<{ nodeId: string; nodeName: string; preview: string }>;
  selectedFiles: string[];
  toolResults: string[];
  finalContext: string;
  tokenEstimate?: number;
  warnings: string[];
  artifactIds: string[];
  metadata: Record<string, unknown>;
}

// ── ID generation ────────────────────────────────────────────────────────────

function generateId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 9)
  );
}

// ── Repository ───────────────────────────────────────────────────────────────

class SnapshotRepository {
  // In-memory store: Map preserves insertion order.
  private store = new Map<string, PersistedSnapshot>();

  /** Create a new snapshot with generated id, createdAt, and updatedAt. */
  create(
    input: Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt">
  ): PersistedSnapshot {
    const now = new Date().toISOString();
    const snapshot: PersistedSnapshot = {
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(snapshot.id, snapshot);
    return { ...snapshot };
  }

  /** Return a snapshot by id, or undefined if not found. */
  getById(id: string): PersistedSnapshot | undefined {
    const snap = this.store.get(id);
    return snap ? { ...snap } : undefined;
  }

  /** Return all snapshots, newest-first by createdAt. */
  list(): PersistedSnapshot[] {
    return [...this.store.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ ...s }));
  }

  /** Return all snapshots for a given nodeId, newest-first. */
  listByNodeId(nodeId: string): PersistedSnapshot[] {
    return this.list().filter((s) => s.nodeId === nodeId);
  }

  /** Return all snapshots for a given workflowId, newest-first. */
  listByWorkflowId(workflowId: string): PersistedSnapshot[] {
    return this.list().filter((s) => s.workflowId === workflowId);
  }

  /**
   * Apply a partial patch to an existing snapshot.
   * Sets updatedAt to now. Returns the updated snapshot, or undefined if not found.
   */
  update(
    id: string,
    patch: Partial<Omit<PersistedSnapshot, "id" | "createdAt">>
  ): PersistedSnapshot | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;
    const updated: PersistedSnapshot = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return { ...updated };
  }

  /** Remove a snapshot. Returns true if it existed and was removed. */
  remove(id: string): boolean {
    return this.store.delete(id);
  }

  /** Serialize the entire store to a JSON string. */
  exportJson(): string {
    return JSON.stringify([...this.store.values()]);
  }

  /**
   * Replace the store with snapshots parsed from a JSON string.
   * Validates that each item has at minimum: id, nodeId, createdAt, updatedAt.
   * Throws if the JSON is invalid or the basic shape is wrong.
   */
  importJson(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new TypeError("importJson expects a JSON array");
    }
    const next = new Map<string, PersistedSnapshot>();
    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as Record<string, unknown>)["id"] !== "string" ||
        typeof (item as Record<string, unknown>)["nodeId"] !== "string" ||
        typeof (item as Record<string, unknown>)["createdAt"] !== "string" ||
        typeof (item as Record<string, unknown>)["updatedAt"] !== "string"
      ) {
        throw new TypeError(
          "importJson: each item must have id, nodeId, createdAt, updatedAt strings"
        );
      }
      const snap = item as PersistedSnapshot;
      next.set(snap.id, snap);
    }
    this.store = next;
  }

  /** Remove all snapshots from the store. */
  clear(): void {
    this.store.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const snapshotRepo = new SnapshotRepository();

// ── Converter helper ──────────────────────────────────────────────────────────

/**
 * Convert an ExecutionContextSnapshot (the live/mock inspection type) into the
 * shape expected by SnapshotRepository.create().
 * No API calls, no external dependencies.
 */
export function snapshotFromContextSnapshot(
  ctx: ExecutionContextSnapshot,
  opts?: {
    workflowId?: string;
    runId?: string;
    snapshotStatus?: SnapshotStatus;
  }
): Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt"> {
  return {
    workflowId: opts?.workflowId,
    nodeId: ctx.nodeId,
    runId: opts?.runId,
    snapshotStatus: opts?.snapshotStatus ?? "draft",
    providerId: ctx.providerId,
    model: ctx.model,
    promptLayers: {
      system: ctx.prompt.systemPrompt,
      developer: ctx.prompt.developerNotes,
      user: ctx.prompt.userPrompt,
      agentInstruction: ctx.prompt.staticPrompt,
      nodePrompt: ctx.prompt.staticPrompt,
    },
    upstreamInputs: ctx.inputs.upstreamOutputs.map((u) => ({
      nodeId: u.nodeId,
      nodeName: u.nodeName,
      preview: u.output.slice(0, 200),
    })),
    selectedFiles: ctx.files.selectedFiles,
    toolResults: ctx.inputs.toolResults,
    finalContext: ctx.finalContext.content,
    tokenEstimate: ctx.finalContext.tokenEstimate,
    warnings: ctx.finalContext.warnings,
    artifactIds: ctx.artifacts.map((a) => a.id),
    metadata: {
      nodeName: ctx.nodeName,
      status: ctx.status,
      localOnly: ctx.debugInfo.localOnly,
    },
  };
}
