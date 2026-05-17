import { useMemo, useState, useCallback } from "react";
import { snapshotRepo } from "@/services/context-builder/snapshotRepository";
import type { PersistedSnapshot } from "@/services/context-builder/snapshotRepository";

export function useSnapshotSearch() {
  const [query, setQuery] = useState("");
  // Snapshot count for triggering re-search; updated only via refreshSearch().
  const [snapCount, setSnapCount] = useState(() => snapshotRepo.list().length);

  /** Call this after adding/removing snapshots to refresh results. */
  const refreshSearch = useCallback(() => {
    setSnapCount(snapshotRepo.list().length);
  }, []);

  const results = useMemo((): PersistedSnapshot[] => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return snapshotRepo
      .list()
      .filter((snap) =>
        snap.nodeId.toLowerCase().includes(q) ||
        snap.finalContext.toLowerCase().includes(q) ||
        snap.promptLayers.system.toLowerCase().includes(q) ||
        snap.model.toLowerCase().includes(q) ||
        snap.metadata["nodeName"]?.toString().toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [query, snapCount]);

  return { query, setQuery, results, refreshSearch };
}
