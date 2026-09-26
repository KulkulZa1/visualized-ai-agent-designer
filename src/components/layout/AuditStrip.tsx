import { useEffect, useMemo, useRef, useState } from "react";
import { useAuditStore } from "@/store/auditStore";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import {
  ALL_AGENT_FILTER,
  AUDIT_FILTER_KINDS,
  deriveAgentFilterChips,
  filterAuditEntries,
  getAuditEmptyMessage,
  orderAuditEntries,
  type AuditFilterKind,
} from "@/utils/auditFilters";

const KIND_COLOR: Record<string, string> = {
  file_write:        "var(--green)",
  hook_executed:     "var(--orange)",
  command_executed:  "var(--orange)",
  workflow_saved:    "var(--accent)",
  workflow_loaded:   "var(--blue)",
  file_read:         "var(--muted)",
  provider_check:    "var(--blue)",
  provider_fallback: "var(--accent)",
  agent_started:     "var(--accent)",
  agent_finished:    "var(--blue)",
  agent_failed:      "var(--red)",
  tool_call:         "var(--green)",
  subagent:          "var(--purple)",
  revision:          "var(--purple)",
};

export function AuditStrip() {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<AuditFilterKind>("all");
  const [agentFilter, setAgentFilter] = useState(ALL_AGENT_FILTER);
  const [newestFirst, setNewestFirst] = useState(true);
  const entries = useAuditStore((state) => state.entries);
  const isRunning = useExecutionStore((state) => state.isRunning);
  const nodes = useWorkflowStore((state) => state.nodes);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const node of nodes) map[node.id] = node.data.name;
    return map;
  }, [nodes]);

  const agentChips = useMemo(
    () => deriveAgentFilterChips(entries, agentNames),
    [entries, agentNames],
  );

  useEffect(() => {
    if (!agentChips.some((chip) => chip.id === agentFilter)) {
      setAgentFilter(ALL_AGENT_FILTER);
    }
  }, [agentChips, agentFilter]);

  const filtered = useMemo(
    () => filterAuditEntries(entries, { kind: filter, agentId: agentFilter }),
    [entries, filter, agentFilter],
  );

  const visible = useMemo(
    () => orderAuditEntries(filtered, newestFirst),
    [filtered, newestFirst],
  );

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    const target = newestFirst ? 0 : scrollRef.current.scrollHeight;
    if (typeof scrollRef.current.scrollTo === "function") {
      scrollRef.current.scrollTo({ top: target, behavior: "smooth" });
    } else {
      scrollRef.current.scrollTop = target;
    }
  }, [entries.length, newestFirst, open]);

  const emptyMessage = getAuditEmptyMessage(entries.length, visible.length);

  return (
    <div style={{
      gridArea: "bottom" as const,
      background: "var(--surface)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      maxHeight: open ? 320 : 28,
      transition: "max-height 200ms ease",
      flexShrink: 0,
    }}>
      {isRunning && (
        <div style={{
          height: 2,
          background: "linear-gradient(90deg, var(--accent), transparent)",
          backgroundSize: "200% 100%",
          animation: "auditProgress 1.5s linear infinite",
          flexShrink: 0,
        }}/>
      )}

      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "4px 12px",
        gap: 8,
        borderBottom: open ? "1px solid var(--border)" : "none",
        flexShrink: 0,
      }}>
        <button onClick={() => setOpen((value) => !value)} style={{
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: 11,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontFamily: "inherit",
          padding: 0,
        }}>
          <NodeIcon name={open ? "chev-d" : "chev"} size={10}/>
          <span style={{
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
            color: "var(--text)",
          }}>
            Audit - Trace
          </span>
        </button>

        <div style={{ display: "flex", gap: 3 }}>
          {AUDIT_FILTER_KINDS.map((kind) => (
            <button key={kind} onClick={() => setFilter(kind)} style={{
              padding: "2px 8px",
              borderRadius: 99,
              border: "none",
              fontFamily: "inherit",
              background: filter === kind ? "var(--surface-3)" : "transparent",
              color: filter === kind ? "var(--text)" : "var(--muted)",
              fontSize: 10,
              cursor: "pointer",
            }}>
              {kind}
            </button>
          ))}
        </div>

        <span style={{ color: "var(--border)", margin: "0 2px" }}>|</span>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", minWidth: 0 }}>
          {agentChips.map((chip) => {
            const active = agentFilter === chip.id;
            return (
              <button
                key={chip.id}
                onClick={() => setAgentFilter(chip.id)}
                title={`${chip.label}: ${chip.count} event${chip.count === 1 ? "" : "s"}`}
                style={{
                  padding: "1px 7px",
                  borderRadius: 99,
                  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--muted)",
                  fontSize: 10,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  maxWidth: 120,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setNewestFirst((value) => !value)}
          title={newestFirst ? "Showing newest first. Click for oldest first." : "Showing oldest first. Click for newest first."}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--hint)",
            cursor: "pointer",
            fontSize: 10,
            fontFamily: "inherit",
            padding: "2px 6px",
            borderRadius: 3,
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>

        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>
          {filtered.length !== entries.length ? `${filtered.length}/${entries.length}` : entries.length} events
        </span>
      </div>

      {open && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: "auto",
            padding: "4px 0",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {emptyMessage && (
            <div style={{ padding: "6px 12px", color: "var(--hint)" }}>{emptyMessage}</div>
          )}
          {visible.map((entry, index) => {
            const severity = !entry.success ? "error"
              : entry.warning ? "warn"
              : entry.action === "hook_executed" ? "hook"
              : "info";
            const borderColor = severity === "error" ? "var(--red)"
              : severity === "warn" ? "var(--accent)"
              : severity === "hook" ? "var(--orange)"
              : "transparent";
            return (
              <div
                key={entry.id ?? index}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "2px 12px",
                  borderLeft: `2px solid ${borderColor}`,
                }}
              >
                <span style={{ color: "var(--hint)", minWidth: 82, flexShrink: 0 }}>
                  {entry.timestamp.split("T")[1]?.split(".")[0] ?? entry.timestamp}
                </span>
                <span style={{
                  color: entry.warning ? "var(--accent)" : KIND_COLOR[entry.action] ?? "var(--muted)",
                  minWidth: 56,
                  flexShrink: 0,
                  textTransform: "uppercase",
                  fontSize: 10,
                  letterSpacing: "0.04em",
                  paddingTop: 1,
                }}>
                  {entry.warning && "⚠ "}{entry.action.replace(/_/g, " ")}
                </span>
                {entry.path && (
                  <span style={{
                    color: "var(--muted)",
                    minWidth: 120,
                    flexShrink: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {entry.path}
                  </span>
                )}
                <span style={{ color: entry.success ? "var(--text)" : "var(--red)" }}>
                  {entry.details ?? (entry.success ? "ok" : "error")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
