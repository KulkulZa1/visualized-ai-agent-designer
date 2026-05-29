import type { AuditEntry } from "@/types/audit";

export const ALL_AGENT_FILTER = "all";

export const AUDIT_FILTER_KINDS = ["all", "tool", "consent", "warn", "error"] as const;
export type AuditFilterKind = (typeof AUDIT_FILTER_KINDS)[number];

export interface AuditAgentFilterChip {
  id: string;
  label: string;
  count: number;
  isAll: boolean;
}

export function deriveAgentFilterChips(
  entries: AuditEntry[],
  agentNames: Record<string, string> = {},
): AuditAgentFilterChip[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.agentId) continue;
    counts.set(entry.agentId, (counts.get(entry.agentId) ?? 0) + 1);
  }

  return [
    { id: ALL_AGENT_FILTER, label: "All", count: entries.length, isAll: true },
    ...Array.from(counts.entries()).map(([id, count]) => ({
      id,
      label: agentNames[id] ?? id,
      count,
      isAll: false,
    })),
  ];
}

function isErrorEntry(entry: AuditEntry): boolean {
  return !entry.success || entry.action.includes("error");
}

function isWarningEntry(entry: AuditEntry): boolean {
  return entry.action.includes("warn");
}

function matchesKind(entry: AuditEntry, kind: AuditFilterKind): boolean {
  if (kind === "all") return true;
  if (kind === "error") return isErrorEntry(entry);
  if (isErrorEntry(entry)) return true;
  if (kind === "warn") return isWarningEntry(entry);
  if (kind === "tool") return entry.action.includes("tool");
  return entry.action.includes(kind);
}

export function filterAuditEntries(
  entries: AuditEntry[],
  filters: { kind: AuditFilterKind; agentId: string },
): AuditEntry[] {
  return entries.filter((entry) => {
    const agentMatches =
      filters.agentId === ALL_AGENT_FILTER || entry.agentId === filters.agentId;
    return agentMatches && matchesKind(entry, filters.kind);
  });
}

export function orderAuditEntries(entries: AuditEntry[], newestFirst: boolean): AuditEntry[] {
  return newestFirst ? entries : [...entries].reverse();
}

export function getAuditEmptyMessage(totalEntries: number, visibleEntries: number): string {
  if (totalEntries === 0) {
    return "No events yet. Run or load a workflow to populate the trace.";
  }
  if (visibleEntries === 0) {
    return "No events match the selected filters. Choose All or another chip.";
  }
  return "";
}
