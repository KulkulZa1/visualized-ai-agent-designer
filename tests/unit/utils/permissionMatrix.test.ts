import { describe, expect, it } from "vitest";
import { AgentRole, ToolPermission, type AgentNodeData } from "@/types/agent";
import { buildPermissionMatrix, getPermissionSummary } from "@/utils/permissionMatrix";

function agent(overrides: Partial<AgentNodeData>): AgentNodeData {
  return {
    name: "Worker",
    role: AgentRole.Worker,
    model: "claude-sonnet-4.6",
    temperature: 0.7,
    maxTokens: 4096,
    maxSteps: 20,
    timeoutSeconds: 300,
    promptSource: { type: "inline", content: "" },
    tools: [],
    memoryRead: [],
    memoryWrite: [],
    tokens: { used: 0, budget: 1000 },
    status: "idle",
    ...overrides,
  };
}

describe("permission matrix", () => {
  it("marks high-risk tools without a hook gate as ungated", () => {
    const rows = buildPermissionMatrix([
      agent({ name: "Shell Worker", tools: [ToolPermission.Bash] }),
    ]);

    expect(rows[0].grantedCount).toBe(1);
    expect(rows[0].highestRisk).toBe("high");
    expect(rows[0].requiresHookGate).toBe(true);
    expect(rows[0].hasHookGate).toBe(false);
    expect(rows[0].ungatedHighRiskTools).toEqual([ToolPermission.Bash]);
  });

  it("treats pre or post hooks as a gate for high-risk tools", () => {
    const rows = buildPermissionMatrix([
      agent({
        tools: [ToolPermission.SubagentDispatch],
        preHook: { path: ".harness/hooks/destructive_guard.sh", requireConsent: false },
      }),
    ]);

    expect(rows[0].requiresHookGate).toBe(true);
    expect(rows[0].hasHookGate).toBe(true);
    expect(rows[0].ungatedHighRiskTools).toEqual([]);
  });

  it("summarizes granted permissions and ungated high-risk nodes", () => {
    const summary = getPermissionSummary([
      agent({ tools: [ToolPermission.ReadFile, ToolPermission.WebFetch] }),
      agent({ name: "Danger", tools: [ToolPermission.Bash] }),
    ]);

    expect(summary.nodeCount).toBe(2);
    expect(summary.grantedCount).toBe(3);
    expect(summary.highRiskNodeCount).toBe(1);
    expect(summary.ungatedHighRiskNodeCount).toBe(1);
  });
});
