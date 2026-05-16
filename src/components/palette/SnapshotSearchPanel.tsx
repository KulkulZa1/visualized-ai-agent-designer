/**
 * SnapshotSearchPanel — full-text search across execution snapshots.
 * Triggered by Ctrl+Shift+F.
 */
import { useRef, useEffect } from "react";
import { useSnapshotSearch } from "@/hooks/useSnapshotSearch";
import { useUIStore } from "@/store/uiStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import type { PersistedSnapshot } from "@/services/context-builder/snapshotRepository";

interface SnapshotSearchPanelProps {
  onClose: () => void;
}

const MONO = '"JetBrains Mono", ui-monospace, monospace';

const STATUS_COLORS: Record<string, string> = {
  completed: "var(--green)",
  failed:    "var(--red)",
  running:   "var(--accent)",
  queued:    "var(--blue)",
  draft:     "var(--hint)",
  mock:      "var(--purple)",
  cancelled: "var(--muted)",
};

function SnapRow({ snap, onSelect }: { snap: PersistedSnapshot; onSelect: () => void }) {
  const nodeName = snap.metadata["nodeName"]?.toString() ?? snap.nodeId;
  const statusColor = STATUS_COLORS[snap.snapshotStatus] ?? "var(--hint)";
  const preview = snap.finalContext.slice(0, 80);

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "8px 16px",
        cursor: "pointer",
        borderBottom: "1px solid var(--border)",
        transition: "background 80ms",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "var(--accent-soft)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{nodeName}</span>
        <span style={{
          fontSize: 9, padding: "1px 5px", borderRadius: 3,
          background: "var(--surface-3)", color: statusColor,
          fontFamily: MONO, textTransform: "uppercase",
        }}>
          {snap.snapshotStatus}
        </span>
        <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO, marginLeft: "auto" }}>
          {snap.model}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: MONO,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {preview || "(empty context)"}
      </div>
    </div>
  );
}

export function SnapshotSearchPanel({ onClose }: SnapshotSearchPanelProps) {
  const { query, setQuery, results } = useSnapshotSearch();
  const selectNode = useUIStore((s) => s.selectNode);
  const setActivePanelTab = useUIStore((s) => s.setActivePanelTab);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSelect(snap: PersistedSnapshot) {
    selectNode(snap.nodeId);
    setActivePanelTab("context");
    onClose();
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: 80, zIndex: 300, fontFamily: "inherit",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 580, background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          overflow: "hidden", animation: "slide-up 140ms ease",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: "1px solid var(--border)", gap: 10 }}>
          <NodeIcon name="search" size={16} color="var(--hint)"/>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search execution snapshots…"
            style={{ flex: 1, background: "transparent", border: "none",
              color: "var(--text)", fontSize: 15, outline: "none", fontFamily: "inherit" }}
          />
          <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4,
            background: "var(--surface-3)", color: "var(--hint)", fontFamily: MONO }}>esc</span>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 400, overflow: "auto" }}>
          {!query.trim() && (
            <div style={{ padding: "24px 18px", fontSize: 12, color: "var(--hint)", textAlign: "center" }}>
              Type to search execution snapshots
            </div>
          )}
          {query.trim() && results.length === 0 && (
            <div style={{ padding: "24px 18px", fontSize: 12, color: "var(--hint)", textAlign: "center" }}>
              No snapshots match "{query}"
            </div>
          )}
          {results.map((snap) => (
            <SnapRow key={snap.id} snap={snap} onSelect={() => handleSelect(snap)} />
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding: "6px 18px", borderTop: "1px solid var(--border)",
          display: "flex", gap: 16, fontSize: 10, color: "var(--hint)" }}>
          <span>↵ jump to node</span>
          <span>esc close</span>
          {results.length > 0 && <span style={{ marginLeft: "auto" }}>{results.length} result{results.length !== 1 ? "s" : ""}</span>}
        </div>
      </div>
    </div>
  );
}
