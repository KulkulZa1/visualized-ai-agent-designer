import { describe, it, expect } from "vitest";
import {
  GOAL_TEMPLATES, matchGoal, recommendProvider,
} from "@/services/wizard/goalTemplates";
import { buildRecommendationBrief } from "@/services/wizard/recommendationBrief";
import { templateToWorkflowDef } from "@/services/wizard/templateToWorkflow";
import { workflowDefSchema } from "@/schemas/workflowSchema";

describe("goalTemplates catalog", () => {
  it("has all required first-slice templates", () => {
    expect(GOAL_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    const ids = GOAL_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([
      "blog-automation",
      "purchasing-decision",
      "logistics-routing-assistant",
      "finance-expense-analysis",
      "coding-task-assistant",
      "matlab-parameter-sweep",
      "harness-self-improvement",
    ]));
  });

  it("every template has unique id", () => {
    const ids = GOAL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template has at least 2 agents and 1 edge", () => {
    for (const t of GOAL_TEMPLATES) {
      expect(t.recommendedAgents.length).toBeGreaterThanOrEqual(2);
      expect(t.recommendedEdges.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every edge references valid agent indices", () => {
    for (const t of GOAL_TEMPLATES) {
      for (const e of t.recommendedEdges) {
        expect(e.from).toBeGreaterThanOrEqual(0);
        expect(e.from).toBeLessThan(t.recommendedAgents.length);
        expect(e.to).toBeGreaterThanOrEqual(0);
        expect(e.to).toBeLessThan(t.recommendedAgents.length);
        expect(e.from).not.toBe(e.to); // no self-loops
      }
    }
  });

  it("every template has at least one trigger keyword", () => {
    for (const t of GOAL_TEMPLATES) {
      expect(t.triggers.length).toBeGreaterThan(0);
      for (const trig of t.triggers) {
        expect(trig).toBe(trig.toLowerCase()); // triggers must be lowercase
      }
    }
  });

  it("includes blog-automation and harness-self-improvement", () => {
    const ids = GOAL_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("blog-automation");
    expect(ids).toContain("harness-self-improvement");
  });
});

describe("matchGoal()", () => {
  it("matches blog automation goal", () => {
    const results = matchGoal("I want to automate my blog writing");
    expect(results[0].template.id).toBe("blog-automation");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].matchedTriggers).toContain("blog");
  });

  it("matches self-improvement goal", () => {
    const results = matchGoal("improve harness studio itself");
    expect(results[0].template.id).toBe("harness-self-improvement");
  });

  it("matches purchasing decision goal", () => {
    const results = matchGoal("pick the best supplier for my project");
    expect(results[0].template.id).toBe("purchasing-decision");
  });

  it("matches coding task goal", () => {
    const results = matchGoal("implement a refactor for this function");
    expect(results[0].template.id).toBe("coding-task-assistant");
  });

  it("matches logistics routing goal", () => {
    const results = matchGoal("plan delivery routes for a logistics fleet");
    expect(results[0].template.id).toBe("logistics-routing-assistant");
  });

  it("matches finance expense analysis goal", () => {
    const results = matchGoal("analyze my expense CSV for unusual spend");
    expect(results[0].template.id).toBe("finance-expense-analysis");
  });

  it("matches MATLAB parameter sweep goal", () => {
    const results = matchGoal("plan a MATLAB parameter sweep simulation");
    expect(results[0].template.id).toBe("matlab-parameter-sweep");
  });

  it("falls back to beginner templates when no match", () => {
    const results = matchGoal("xyzabcunknown");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(0);
    expect(results[0].template.difficulty).toBe("beginner");
  });

  it("returns at most topN results", () => {
    const results = matchGoal("blog", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("is case-insensitive", () => {
    const r1 = matchGoal("BLOG WRITING");
    const r2 = matchGoal("blog writing");
    expect(r1[0].template.id).toBe(r2[0].template.id);
  });
});

describe("recommendProvider()", () => {
  const template = GOAL_TEMPLATES.find((t) => t.id === "blog-automation")!;

  it("recommends local when Ollama is ready", () => {
    const rec = recommendProvider(template, {
      hasOpenAIKey: false, hasAnthropicKey: false,
      ollamaReady: true, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });
    // blog-automation has providers ["anthropic", "local", "openai"] — anthropic is preferred,
    // but since no anthropic key, it should fall through to local (which is ready).
    expect(rec.ready).toBe(true);
    expect(rec.category).toBe("local");
  });

  it("recommends Anthropic when key is set", () => {
    const rec = recommendProvider(template, {
      hasOpenAIKey: false, hasAnthropicKey: true,
      ollamaReady: false, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });
    expect(rec.ready).toBe(true);
    expect(rec.category).toBe("anthropic");
  });

  it("returns not-ready with setup steps when nothing configured", () => {
    const rec = recommendProvider(template, {
      hasOpenAIKey: false, hasAnthropicKey: false,
      ollamaReady: false, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });
    expect(rec.ready).toBe(false);
    expect(rec.setupSteps.length).toBeGreaterThan(0);
  });

  it("prefers local setup for local-friendly templates when no provider is ready", () => {
    const rec = recommendProvider(template, {
      hasOpenAIKey: false, hasAnthropicKey: false,
      ollamaReady: false, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });

    expect(rec.ready).toBe(false);
    expect(rec.category).toBe("local");
    expect(rec.reason).toContain("Ollama");
  });
});

describe("buildRecommendationBrief()", () => {
  it("explains why a matched template was recommended", () => {
    const match = matchGoal("automate blog writing")[0];
    const provider = recommendProvider(match.template, {
      hasOpenAIKey: false, hasAnthropicKey: false,
      ollamaReady: true, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });

    const brief = buildRecommendationBrief(match, provider);

    expect(brief.templateId).toBe("blog-automation");
    expect(brief.confidence).toBe("strong");
    expect(brief.why.join(" ")).toContain("blog");
    expect(brief.why.join(" ")).toContain("Workflow shape");
    expect(brief.provider.ready).toBe(true);
    expect(brief.evidenceArtifacts).toEqual(match.template.expectedArtifacts);
    expect(brief.nextSteps.join(" ")).toContain("verify");
  });

  it("includes provider setup steps when the provider is not ready", () => {
    const match = matchGoal("improve harness studio itself")[0];
    const provider = recommendProvider(match.template, {
      hasOpenAIKey: false, hasAnthropicKey: false,
      ollamaReady: false, hasOllamaCloudKey: false, hasCustomEndpoint: false,
    });

    const brief = buildRecommendationBrief(match, provider);

    expect(brief.provider.ready).toBe(false);
    expect(brief.nextSteps.length).toBeGreaterThan(0);
    expect(brief.nextSteps.join(" ")).toMatch(/Install|Open Settings|Create an API key|Return/);
    expect(brief.privacy).toBe(match.template.privacyNotes);
  });
});

describe("templateToWorkflowDef()", () => {
  it("produces a schema-valid WorkflowDef for every template", () => {
    for (const template of GOAL_TEMPLATES) {
      const def = templateToWorkflowDef(template, { provider: "local" });
      const result = workflowDefSchema.safeParse(def);
      if (!result.success) {
        const errs = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
        throw new Error(`Template "${template.id}" produced invalid workflow: ${errs}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it("agent count matches template", () => {
    const template = GOAL_TEMPLATES[0];
    const def = templateToWorkflowDef(template, { provider: "local" });
    expect(def.agents.length).toBe(template.recommendedAgents.length);
    expect(def.connections.length).toBe(template.recommendedEdges.length);
  });

  it("memory and hook nodes have empty model field", () => {
    const selfImprovement = GOAL_TEMPLATES.find((t) => t.id === "research-synthesis")!;
    const def = templateToWorkflowDef(selfImprovement, { provider: "local" });
    const memoryAgents = def.agents.filter((a) => a.role === "memory");
    for (const a of memoryAgents) {
      expect(a.model).toBe("");
    }
  });

  it("assigns Ollama model when provider is local", () => {
    const t = GOAL_TEMPLATES.find((t) => t.id === "blog-automation")!;
    const def = templateToWorkflowDef(t, { provider: "local" });
    const executableAgents = def.agents.filter((a) => a.role !== "memory" && a.role !== "hook");
    for (const a of executableAgents) {
      expect(a.model).toMatch(/qwen2\.5/);
    }
  });

  it("assigns Anthropic model when provider is anthropic", () => {
    const t = GOAL_TEMPLATES.find((t) => t.id === "blog-automation")!;
    const def = templateToWorkflowDef(t, { provider: "anthropic" });
    const executableAgents = def.agents.filter((a) => a.role !== "memory" && a.role !== "hook");
    for (const a of executableAgents) {
      expect(a.model).toMatch(/claude/);
    }
  });

  it("modelOverride applies to all executable agents", () => {
    const t = GOAL_TEMPLATES[0];
    const def = templateToWorkflowDef(t, { provider: "anthropic", modelOverride: "test-model" });
    const executableAgents = def.agents.filter((a) => a.role !== "memory" && a.role !== "hook");
    for (const a of executableAgents) {
      expect(a.model).toBe("test-model");
    }
  });

  it("produces positions for every agent", () => {
    const t = GOAL_TEMPLATES[0];
    const def = templateToWorkflowDef(t, { provider: "local" });
    for (let i = 0; i < def.agents.length; i++) {
      const pos = def.nodePositions[`agent-${i}`];
      expect(pos).toBeDefined();
      expect(typeof pos.x).toBe("number");
      expect(typeof pos.y).toBe("number");
    }
  });
});
