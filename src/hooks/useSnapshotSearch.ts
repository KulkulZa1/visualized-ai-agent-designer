import { useMemo, useState } from "react";
import { snapshotRepo } from "@/services/context-builder/snapshotRepository";
import type { PersistedSnapshot } from "@/services/context-builder/snapshotRepository";

export function useSnapshotSearch() {
  const [query, setQuery] = useState("");

  const allSnapshots = snapshotRepo.list();

  const results = useMemo((): PersistedSnapshot[] => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return snapshotRepo
      .list()
      .filter((snap) => {
        return (
          snap.nodeId.toLowerCase().includes(q) ||
          snap.finalContext.toLowerCase().includes(q) ||
          snap.promptLayers.system.toLowerCase().includes(q) ||
          snap.model.toLowerCase().includes(q) ||
          snap.metadata["nodeName"]?.toString().toLowerCase().includes(q)
        );
      })
      .slice(0, 20);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allSnapshots.length]);

  return { query, setQuery, results };
}
