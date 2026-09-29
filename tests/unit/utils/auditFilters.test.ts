import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/types/audit";
import {
  deriveAgentFilterChips,
  filterAuditEntries,
  getAuditEmptyMessage,
  orderAuditEntries,
  type AuditFilterKind,
} from "@/utils/auditFilters";

function entry(
  id: string,
  action: AuditEntry["action"],
  agentId: string | undefined,
  success: boolean,
  details: string,
): AuditEntry {
  return {
    id,
    timestamp: `2026-05-17T00:00:0${id}.000Z`,
    action,
    agentId,
    success,
    details,
  };
}

describe("auditFilters", () => {
  const entries: AuditEntry[] = [
    entry("1", "hook_executed", "agent-1", true, "started"),
    entry("2", "file_read", "agent-2", false, "read failed"),
    entry("3", "workflow_loaded", "agent-1", true, "loaded"),
    entry("4", "file_write", undefined, true, "saved"),
  ];

  it("derives an All chip and agent chips in first-seen order", () => {
    const chips = deriveAgentFilterChips(entries, {
      "agent-1": "Project Orchestrator",
      "agent-2": "Frontend Worker With A Long Name",
    });

    expect(chips).toEqual([
      { id: "all", label: "All", count: 4, isAll: true },
      { id: "agent-1", label: "Project Orchestrator", count: 2, isAll: false },
      { id: "agent-2", label: "Frontend Worker With A Long Name", count: 1, isAll: false },
    ]);
  });

  it("filters by agent independently from kind filters while preserving errors", () => {
    const agentOne = filterAuditEntries(entries, {
      kind: "all",
      agentId: "agent-1",
    });
    expect(agentOne.map((e) => e.id)).toEqual(["1", "3"]);

    const fileReadWithErrors = filterAuditEntries(entries, {
      kind: "tool",
      agentId: "all",
    });
    expect(fileReadWithErrors.map((e) => e.id)).toEqual(["2"]);
  });

  describe("kind filters on a run's entries", () => {
    const run: AuditEntry[] = [
      entry("1", "agent_started", "A", true, "▶ Coder — openai via openai-compatible"),
      entry("2", "tool_call", "A", true, 'Tool: read_file({"path":"sum.mjs"})'),
      entry("3", "command_executed", "A", true, "Coder ran: node --test (approved once; exit 0, 398 ms)"),
      entry("4", "hook_executed", "A", true, ".harness/hooks/gate.sh exited 0"),
      entry("5", "hook_executed", "B", false,
        "Hook requires explicit manual consent. Open the Hooks tab and run it there."),
      { ...entry("6", "provider_fallback", "A", true, "Billing error — fell back to Ollama (qwen2.5-coder:7b)"),
        warning: true },
      entry("7", "agent_finished", "A", true, "✓ Coder — 689 est. tokens (1 tool call)"),
    ];
    // Errors (5) show under every kind.
    const ids = (kind: AuditFilterKind) => filterAuditEntries(run, { kind, agentId: "all" }).map((e) => e.id);

    it("tool shows tool calls and commands", () => {
      expect(ids("tool")).toEqual(["2", "3", "5"]);
    });

    it("consent shows commands, which all need approval, and hooks waiting for consent", () => {
      expect(ids("consent")).toEqual(["3", "5"]);
    });

    it("warn shows non-fatal problems", () => {
      expect(ids("warn")).toEqual(["5", "6"]);
    });

    it("error shows failures only", () => {
      expect(ids("error")).toEqual(["5"]);
    });
  });

  it("keeps existing newest-first order unless oldest-first is requested", () => {
    expect(orderAuditEntries(entries, true).map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
    expect(orderAuditEntries(entries, false).map((e) => e.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("returns beginner-friendly empty messages", () => {
    expect(getAuditEmptyMessage(0, 0)).toBe(
      "No events yet. Run or load a workflow to populate the trace.",
    );
    expect(getAuditEmptyMessage(4, 0)).toBe(
      "No events match the selected filters. Choose All or another chip.",
    );
  });
});
