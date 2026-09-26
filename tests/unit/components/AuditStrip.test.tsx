import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditStrip } from "@/components/layout/AuditStrip";
import { useAuditStore } from "@/store/auditStore";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { AuditEntry } from "@/types/audit";
import { AgentRole } from "@/types/agent";

function auditEntry(id: string, agentId: string, details: string): AuditEntry {
  return {
    id,
    timestamp: `2026-05-17T00:00:0${id}.000Z`,
    action: "hook_executed",
    agentId,
    details,
    success: true,
  };
}

beforeEach(() => {
  useAuditStore.setState({
    entries: [
      auditEntry("1", "agent-1", "orchestrator event"),
      auditEntry("2", "agent-2", "frontend event"),
    ],
    maxEntries: 500,
  });
  useExecutionStore.setState({ isRunning: false });
  useWorkflowStore.setState({
    nodes: [
      {
        id: "agent-1",
        type: "agent",
        position: { x: 0, y: 0 },
        data: {
          name: "Project Orchestrator",
          role: AgentRole.Orchestrator,
          model: "gpt-4o-mini",
          temperature: 0.7,
          maxTokens: 1024,
          maxSteps: 5,
          timeoutSeconds: 60,
          promptSource: { type: "inline", content: "" },
          tools: [],
          memoryRead: [],
          memoryWrite: [],
          tokens: { used: 0, budget: 2000 },
          status: "idle",
        },
      },
      {
        id: "agent-2",
        type: "agent",
        position: { x: 0, y: 0 },
        data: {
          name: "Frontend Worker",
          role: AgentRole.Worker,
          model: "gpt-4o-mini",
          temperature: 0.7,
          maxTokens: 1024,
          maxSteps: 5,
          timeoutSeconds: 60,
          promptSource: { type: "inline", content: "" },
          tools: [],
          memoryRead: [],
          memoryWrite: [],
          tokens: { used: 0, budget: 2000 },
          status: "idle",
        },
      },
    ],
  });
});

describe("AuditStrip agent filters", () => {
  it("shows All and agent chips, then filters entries by selected agent", async () => {
    render(<AuditStrip />);

    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Orchestrator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Frontend Worker" })).toBeInTheDocument();
    expect(screen.getByText("orchestrator event")).toBeInTheDocument();
    expect(screen.getByText("frontend event")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Project Orchestrator" }));

    expect(screen.getByText("orchestrator event")).toBeInTheDocument();
    expect(screen.queryByText("frontend event")).not.toBeInTheDocument();
  });
});

describe("AuditStrip entries", () => {
  it("names each entry by what happened and marks warnings", () => {
    useAuditStore.setState({
      entries: [
        { id: "1", timestamp: "2026-05-17T00:00:01.000Z", action: "tool_call", agentId: "agent-1",
          details: 'Tool: read_file({"path":"a.md"})', success: true },
        { id: "2", timestamp: "2026-05-17T00:00:02.000Z", action: "provider_fallback", agentId: "agent-1",
          details: "Billing error — fell back to Ollama (qwen2.5-coder:7b)", success: true, warning: true },
      ],
      maxEntries: 500,
    });

    render(<AuditStrip />);

    expect(screen.getByText("tool call")).toBeInTheDocument();
    expect(screen.getByText("⚠ provider fallback")).toBeInTheDocument();
  });
});
