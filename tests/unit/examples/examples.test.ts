/**
 * Validates all three example .harness.yaml files against the Zod schema.
 * These tests catch format drift before it reaches users.
 */
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { EXAMPLES } from "@/hooks/useExamples";

// Helper: parse YAML + validate with Zod, pretty-print any errors
function parseAndValidate(yaml: string, label: string) {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (e) {
    throw new Error(`[${label}] YAML parse error: ${e}`);
  }
  const result = workflowDefSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((e) => `  ${String(e.path.join("."))}: ${e.message}`)
      .join("\n");
    throw new Error(`[${label}] Zod validation failed:\n${details}`);
  }
  return result.data;
}

describe("Example YAML files are schema-valid", () => {
  EXAMPLES.forEach((ex) => {
    it(`${ex.name} parses without errors`, () => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      expect(wf.meta.name).toBe(ex.name);
      expect(wf.agents.length).toBe(ex.nodeCount);
      expect(wf.connections.length).toBe(ex.edgeCount);
    });
  });
});

describe("Parallel Research — structure", () => {
  const wf = parseAndValidate(EXAMPLES[0].yaml, "parallel-research");

  it("has correct role sequence", () => {
    const roles = wf.agents.map((a) => a.role);
    expect(roles).toContain("orchestrator");
    expect(roles).toContain("gateway");
    expect(roles).toContain("worker");
    expect(roles).toContain("aggregator");
    expect(roles).toContain("critic");
    expect(roles).toContain("memory");
  });

  it("has a feedback edge from Verifier to Synthesizer", () => {
    const feedback = wf.connections.filter((c) => c.edgeKind === "feedback");
    expect(feedback.length).toBeGreaterThanOrEqual(1);
    expect(feedback[0].sourceAgentId).toBe("agent-7");
    expect(feedback[0].targetAgentId).toBe("agent-6");
  });

  it("has memory edges from workers to scratchpad", () => {
    const memEdges = wf.connections.filter((c) => c.edgeKind === "memory");
    expect(memEdges.length).toBe(3);
    memEdges.forEach((e) => expect(e.targetAgentId).toBe("agent-5"));
  });

  it("gateway has a condition", () => {
    const gw = wf.agents.find((a) => a.role === "gateway");
    expect(gw?.condition).toBeTruthy();
  });

  it("web searcher has a pre-hook requiring no consent", () => {
    const ws = wf.agents[2]; // Web Searcher at index 2
    expect(ws.preHook?.path).toContain("url_allowlist");
    expect(ws.preHook?.requireConsent).toBe(false);
  });

  it("coordinator has a pre-hook requiring consent", () => {
    const coord = wf.agents[0];
    expect(coord.preHook?.requireConsent).toBe(true);
  });

  it("all nodes have token budgets > 0 except hook/memory", () => {
    wf.agents.forEach((a) => {
      if (a.role !== "hook" && a.role !== "memory") {
        expect(a.tokens.budget).toBeGreaterThan(0);
      }
    });
  });
});

describe("Spec to PR — structure", () => {
  const wf = parseAndValidate(EXAMPLES[1].yaml, "spec-to-pr");

  it("is a linear pipeline with 5 nodes", () => {
    expect(wf.agents.length).toBe(5);
    expect(wf.executionSettings.maxParallel).toBe(1);
  });

  it("has a feedback edge from Verifier back to Implementer", () => {
    const feedback = wf.connections.filter((c) => c.edgeKind === "feedback");
    expect(feedback.length).toBe(1);
    expect(feedback[0].label).toBe("revise");
    expect(feedback[0].sourceAgentId).toBe("agent-3"); // Verifier
    expect(feedback[0].targetAgentId).toBe("agent-2"); // Implementer
  });

  it("implementer has destructive_guard pre-hook", () => {
    const impl = wf.agents[2];
    expect(impl.preHook?.path).toContain("destructive_guard");
    expect(impl.preHook?.requireConsent).toBe(false);
  });

  it("implementer has the highest token budget", () => {
    const budgets = wf.agents.map((a) => a.tokens.budget);
    expect(wf.agents[2].tokens.budget).toBe(Math.max(...budgets));
  });

  it("reporter uses git tool", () => {
    const reporter = wf.agents[4];
    expect(reporter.tools).toContain("git");
  });
});

describe("Self-Critic Loop — structure", () => {
  const wf = parseAndValidate(EXAMPLES[2].yaml, "self-critic");

  it("uses all 4 edge types", () => {
    const kinds = new Set(wf.connections.map((c) => c.edgeKind ?? "dataflow"));
    expect(kinds).toContain("dataflow");
    expect(kinds).toContain("feedback");
    expect(kinds).toContain("control");
    expect(kinds).toContain("memory");
  });

  it("has the drafter → critic → gate → drafter feedback loop", () => {
    const feedback = wf.connections.filter((c) => c.edgeKind === "feedback");
    expect(feedback.length).toBe(1);
    expect(feedback[0].sourceAgentId).toBe("agent-2"); // Loop Gate
    expect(feedback[0].targetAgentId).toBe("agent-0"); // Drafter
  });

  it("gate → iter_counter is a control edge", () => {
    const ctrl = wf.connections.filter((c) => c.edgeKind === "control");
    expect(ctrl.length).toBe(1);
    expect(ctrl[0].sourceAgentId).toBe("agent-2"); // Loop Gate
    expect(ctrl[0].targetAgentId).toBe("agent-3"); // iter_counter
  });

  it("hook node has empty model and zero token budget", () => {
    const hook = wf.agents.find((a) => a.role === "hook");
    expect(hook?.model).toBe("");
    expect(hook?.tokens.budget).toBe(0);
  });

  it("loop gate has a condition string", () => {
    const gate = wf.agents.find((a) => a.role === "gateway");
    expect(gate?.condition).toBeTruthy();
  });

  it("memory node writes to revision-log", () => {
    const mem = wf.agents.find((a) => a.role === "memory");
    expect(mem?.memoryWrite).toContain("revision-log");
  });
});

describe("useExamples metadata", () => {
  it("all examples have correct nodeCount matching agents array length", () => {
    EXAMPLES.forEach((ex) => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      expect(wf.agents.length).toBe(ex.nodeCount);
    });
  });

  it("all examples have correct edgeCount matching connections array length", () => {
    EXAMPLES.forEach((ex) => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      expect(wf.connections.length).toBe(ex.edgeCount);
    });
  });

  it("all examples have unique connection IDs within each workflow", () => {
    EXAMPLES.forEach((ex) => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      const ids = wf.connections.map((c) => c.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });
  });

  it("all examples start with status: idle for all agents", () => {
    EXAMPLES.forEach((ex) => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      wf.agents.forEach((a) => expect(a.status).toBe("idle"));
    });
  });

  it("all examples have tokens.used = 0", () => {
    EXAMPLES.forEach((ex) => {
      const wf = parseAndValidate(ex.yaml, ex.name);
      wf.agents.forEach((a) => expect(a.tokens.used).toBe(0));
    });
  });
});
