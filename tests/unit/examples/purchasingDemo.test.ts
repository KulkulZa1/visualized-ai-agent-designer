/**
 * Validates examples/purchasing-decision.harness.yaml against workflowDefSchema.
 * This demo is intentionally NOT registered in useExamples.ts yet — see
 * docs/E2E_DEMO_PLAN.md section 6.
 *
 * The test guards against schema drift even though the file is loaded only
 * via the file tree today.
 */
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { workflowDefSchema } from "@/schemas/workflowSchema";
// Vite ?raw import — works in Vitest (jsdom) without @types/node.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Vite raw-string import suffix.
import yamlText from "../../../examples/purchasing-decision.harness.yaml?raw";

describe("Purchasing Decision Assistant demo", () => {
  const raw = parse(yamlText as string);
  const parsed = workflowDefSchema.safeParse(raw);

  it("parses against workflowDefSchema", () => {
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((e) => `  ${String(e.path.join("."))}: ${e.message}`)
        .join("\n");
      throw new Error("Schema validation failed:\n" + details);
    }
    expect(parsed.success).toBe(true);
  });

  if (!parsed.success) return;
  const wf = parsed.data;

  it("has 5 agents and 7 edges", () => {
    expect(wf.agents.length).toBe(5);
    expect(wf.connections.length).toBe(7);
  });

  it("uses 4 distinct edge kinds (data/memory/feedback/control)", () => {
    const kinds = new Set(wf.connections.map((c) => c.edgeKind ?? "dataflow"));
    expect(kinds).toContain("dataflow");
    expect(kinds).toContain("memory");
    expect(kinds).toContain("feedback");
    expect(kinds).toContain("control");
  });

  it("memory node has empty model and zero token budget", () => {
    const mem = wf.agents.find((a) => a.role === "memory");
    expect(mem).toBeDefined();
    expect(mem!.model).toBe("");
    expect(mem!.tokens.budget).toBe(0);
  });

  it("evaluator has feedback edge from critic (revise)", () => {
    const fb = wf.connections.filter((c) => c.edgeKind === "feedback");
    expect(fb.length).toBe(1);
    expect(fb[0].sourceAgentId).toBe("agent-2");
    expect(fb[0].targetAgentId).toBe("agent-1");
  });

  it("all nodes start idle with tokens.used = 0", () => {
    wf.agents.forEach((a) => {
      expect(a.status).toBe("idle");
      expect(a.tokens.used).toBe(0);
    });
  });

  it("no agent uses high-risk tools (bash, subagent_dispatch)", () => {
    // Deliberate: this demo must run safely without elevated permissions.
    wf.agents.forEach((a) => {
      expect(a.tools).not.toContain("bash");
      expect(a.tools).not.toContain("subagent_dispatch");
    });
  });
});
