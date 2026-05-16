/**
 * File-backed snapshot repository adapter.
 * Persists snapshots to disk via Tauri IPC using the same logical interface
 * as the in-memory SnapshotRepository. All methods are async because file I/O
 * is asynchronous.
 *
 * Storage layout:
 *   .harness/snapshots/index.json   — Record<nodeId, snapshotId[]>
 *   .harness/snapshots/<id>.json    — individual PersistedSnapshot
 */

import { invoke } from "@tauri-apps/api/core";
import type { PersistedSnapshot } from "./snapshotRepository";
import { snapshotRepo } from "./snapshotRepository";

const SNAPSHOTS_DIR = ".harness/snapshots";
const INDEX_PATH = `${SNAPSHOTS_DIR}/index.json`;
const MAX_SNAPSHOTS_PER_NODE = 20;

/** Maps nodeId → array of snapshotIds (insertion order preserved). */
type SnapshotIndex = Record<string, string[]>;

export class FileSnapshotRepository {
  constructor(private workspacePath: string) {}

  // ── Private helpers ────────────────────────────────────────────────────────

  private async readIndex(): Promise<SnapshotIndex> {
    try {
      const raw = await invoke<string>("read_workspace_file", {
        workspacePath: this.workspacePath,
        relativePath: INDEX_PATH,
      });
      return JSON.parse(raw) as SnapshotIndex;
    } catch {
      return {};
    }
  }

  private async writeIndex(index: SnapshotIndex): Promise<void> {
    await invoke<void>("write_workspace_file", {
      workspacePath: this.workspacePath,
      relativePath: INDEX_PATH,
      content: JSON.stringify(index, null, 2),
    });
  }

  private async writeOne(snap: PersistedSnapshot): Promise<void> {
    await invoke<void>("write_workspace_file", {
      workspacePath: this.workspacePath,
      relativePath: `${SNAPSHOTS_DIR}/${snap.id}.json`,
      content: JSON.stringify(snap, null, 2),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Create a new snapshot. Uses the in-memory repo for id + timestamp
   * generation, then persists to disk and updates the index.
   */
  async create(
    input: Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt">
  ): Promise<PersistedSnapshot> {
    const snap = snapshotRepo.create(input);
    await this.writeOne(snap);
    const index = await this.readIndex();
    index[snap.nodeId] = [...(index[snap.nodeId] ?? []), snap.id];
    if (index[snap.nodeId].length > MAX_SNAPSHOTS_PER_NODE) {
      // Keep the newest MAX_SNAPSHOTS_PER_NODE entries (last N of sorted array)
      index[snap.nodeId] = index[snap.nodeId].slice(-MAX_SNAPSHOTS_PER_NODE);
    }
    await this.writeIndex(index);
    return snap;
  }

  /** Read a single snapshot file by id. Returns undefined if not found. */
  async getById(id: string): Promise<PersistedSnapshot | undefined> {
    try {
      const raw = await invoke<string>("read_workspace_file", {
        workspacePath: this.workspacePath,
        relativePath: `${SNAPSHOTS_DIR}/${id}.json`,
      });
      return JSON.parse(raw) as PersistedSnapshot;
    } catch {
      return undefined;
    }
  }

  /**
   * Return all snapshots for a nodeId, newest-first by createdAt.
   * Gracefully returns [] when no index file exists.
   */
  async listByNodeId(nodeId: string): Promise<PersistedSnapshot[]> {
    const index = await this.readIndex();
    const ids = index[nodeId] ?? [];
    const snaps = await Promise.all(ids.map((id) => this.getById(id)));
    return (snaps.filter(Boolean) as PersistedSnapshot[]).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  /**
   * Apply a partial patch to an existing snapshot. Sets updatedAt to now.
   * Returns the updated snapshot, or undefined if not found.
   */
  async update(
    id: string,
    patch: Partial<Omit<PersistedSnapshot, "id" | "createdAt">>
  ): Promise<PersistedSnapshot | undefined> {
    const existing = await this.getById(id);
    if (!existing) return undefined;
    const updated: PersistedSnapshot = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.writeOne(updated);
    return updated;
  }

  /**
   * "Remove" a snapshot: remove it from the index and mark it as cancelled.
   * The file is kept on disk for audit purposes.
   */
  async remove(id: string, nodeId: string): Promise<boolean> {
    try {
      const index = await this.readIndex();
      if (index[nodeId]) {
        index[nodeId] = index[nodeId].filter((i) => i !== id);
        await this.writeIndex(index);
      }
      const existing = await this.getById(id);
      if (existing) {
        await this.update(id, { snapshotStatus: "cancelled" });
      }
      return true;
    } catch {
      return false;
    }
  }
}
