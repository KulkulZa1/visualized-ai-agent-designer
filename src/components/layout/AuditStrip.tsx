import { useState, useEffect, useRef } from "react";
import { useAuditStore } from "@/store/auditStore";
import { useExecutionStore } from "@/store/executionStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";

const KIND_COLOR: Record<string, string> = {
  run:             "var(--accent)",
  tokens:          "var(--muted)",
  edge:            "var(--blue)",
  tool:            "var(--green)",
  fanout:          "var(--purple)",
  consent:         "var(--orange)",
  done:            "var(--blue)",
  warn:            "var(--accent)",
  error:           "var(--red)",
  file_write:      "var(--green)",
  hook_executed:   "var(--orange)",
  workflow_saved:  "var(--accent)",
  workflow_loaded: "var(--blue)",
  file_read:       "var(--muted)",
};

const FILTER_KINDS = ["all", "tool", "consent", "warn", "error"] as const;
type FilterKind = typeof FILTER_KINDS[number];

export function AuditStrip() {
  const [open,       setOpen]       = useState(true);
  const [filter,     setFilter]     = useState<FilterKind>("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const entries = useAuditStore((s) => s.entries);
  const isRunning = useExecutionStore((s) => s.isRunning);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: newestFirst ? 0 : scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries.length, newestFirst, open]);

  const filtered = filter === "all"
    ? entries
    : filter === "error"
    ? entries.filter((e) => !e.success || e.action.includes("error"))
    : filter === "warn"
    ? entries.filter((e) => e.action.includes("warn") || (!e.success && !e.action.includes("error")))
    : entries.filter((e) => e.action.includes(filter));

  const visible = newestFirst ? [...filtered].reverse() : filtered;

  return (
    <div style={{
      gridArea: "bottom" as const,
      background: "var(--surface)", borderTop: "1px solid var(--border)",
      display: "flex", flexDirection: "column", overflow: "hidden",
      maxHeight: open ? 320 : 28,
      transition: "max-height 200ms ease",
      flexShrink: 0,
    }}>
      {/* Progress bar */}
      {isRunning && (
        <div style={{
          height: 2,
          background: "linear-gradient(90deg, var(--accent), transparent)",
          backgroundSize: "200% 100%",
          animation: "auditProgress 1.5s linear infinite",
          flexShrink: 0,
        }}/>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "4px 12px", gap: 8,
        borderBottom: open ? "1px solid var(--border)" : "none", flexShrink: 0 }}>
        <button onClick={() => setOpen((v) => !v)} style={{
          background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer",
          fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "inherit", padding: 0,
        }}>
          <NodeIcon name={open ? "chev-d" : "chev"} size={10}/>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600,
            color: "var(--text)" }}>Audit · Trace</span>
        </button>

        {/* Filters */}
        <div style={{ display: "flex", gap: 3 }}>
          {FILTER_KINDS.map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "2px 8px", borderRadius: 99, border: "none", fontFamily: "inherit",
              background: filter === f ? "var(--surface-3)" : "transparent",
              color: filter === f ? "var(--text)" : "var(--muted)",
              fontSize: 10, cursor: "pointer",
            }}>{f}</button>
          ))}
        </div>

        {/* Order toggle */}
        <button
          onClick={() => setNewestFirst((v) => !v)}
          title={newestFirst ? "Showing newest first — click for oldest first" : "Showing oldest first — click for newest first"}
          style={{
            background: "transparent", border: "none", color: "var(--hint)", cursor: "pointer",
            fontSize: 10, fontFamily: "inherit", padding: "2px 6px", borderRadius: 3,
            display: "inline-flex", alignItems: "center", gap: 3,
          }}
        >
          {newestFirst ? "↓ Newest first" : "↑ Oldest first"}
        </button>

        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>
          {entries.length} events
        </span>
      </div>

      {/* Entries */}
      {open && (
        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "4px 0",
          fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {visible.length === 0 && (
            <div style={{ padding: "4px 12px", color: "var(--hint)" }}>No events yet.</div>
          )}
          {visible.map((e, i) => {
            const sev = !e.success ? "error"
              : e.action.includes("warn") ? "warn"
              : e.action.includes("hook") ? "hook"
              : "info";
            const borderColor = sev === "error" ? "var(--red)"
              : sev === "warn" ? "var(--accent)"
              : sev === "hook" ? "var(--orange)"
              : "transparent";
            return (
            <div key={e.id ?? i} style={{ display: "flex", gap: 12, padding: "2px 12px",
              borderLeft: `2px solid ${borderColor}` }}>
              <span style={{ color: "var(--hint)", minWidth: 82, flexShrink: 0 }}>
                {e.timestamp.split("T")[1]?.split(".")[0] ?? e.timestamp}
              </span>
              <span style={{
                color: KIND_COLOR[e.action] ?? "var(--muted)",
                minWidth: 56, flexShrink: 0,
                textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em", paddingTop: 1,
              }}>{e.action.replace(/_/g, " ")}</span>
              {e.path && (
                <span style={{ color: "var(--muted)", minWidth: 120, flexShrink: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.path}
                </span>
              )}
              <span style={{ color: e.success ? "var(--text)" : "var(--red)" }}>
                {e.details ?? (e.success ? "ok" : "error")}
              </span>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
