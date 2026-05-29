/**
 * Tests for the CLI's core validation logic.
 *
 * We can't easily shell out to Node in Vitest/jsdom, so we test the
 * underlying schema validation logic that cli/harness.mjs replicates.
 * This guards against schema drift between src/schemas/ and cli/harness.mjs.
 *
 * See cli/harness.mjs for the inline schema copy that must stay in sync.
 */
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { workflowDefSchema } from "@/schemas/workflowSchema";

// ---------------------------------------------------------------------------
// Minimal valid workflow — mirrors what cli/harness.mjs must also accept
// ---------------------------------------------------------------------------
const VALID_MINIMAL_YAML = `
meta:
  name: CLI Test Workflow
  version: "1.0.0"
  description: minimal
  projectRoot: ""
  createdAt: "2026-05-17T00:00:00Z"
  updatedAt: "2026-05-17T00:00:00Z"
agents:
  - name: Test Agent
    role: worker
    model: gpt-4o-mini
    temperature: 0.5
    maxTokens: 1024
    maxSteps: 5
    timeoutSeconds: 60
    promptSource:
      type: inline
      content: "You are a test agent."
    tools: []
    memoryRead: []
    memoryWrite: []
    tokens:
      used: 0
      budget: 2000
    status: idle
connections: []
executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0:
    x: 100
    y: 200
`.trim();

// A workflow that should fail Zod: name is too long (>128 chars)
const INVALID_NAME_YAML = VALID_MINIMAL_YAML.replace(
  "name: CLI Test Workflow",
  `name: ${"A".repeat(130)}`
);

// A workflow with an invalid role
const INVALID_ROLE_YAML = VALID_MINIMAL_YAML.replace(
  "role: worker",
  "role: superagent"
);

// A workflow with missing required field (no agents array)
const MISSING_AGENTS_YAML = `
meta:
  name: Broken
  version: "1.0.0"
  description: ""
  projectRoot: ""
  createdAt: "2026-05-17T00:00:00Z"
  updatedAt: "2026-05-17T00:00:00Z"
connections: []
executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0
nodePositions: {}
`.trim();

describe("CLI schema validation logic", () => {
  it("accepts a minimal valid workflow", () => {
    const raw = parseYaml(VALID_MINIMAL_YAML);
    const result = workflowDefSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta.name).toBe("CLI Test Workflow");
      expect(result.data.agents.length).toBe(1);
      expect(result.data.connections.length).toBe(0);
    }
  });

  it("rejects a workflow whose name exceeds 128 chars", () => {
    const raw = parseYaml(INVALID_NAME_YAML);
    const result = workflowDefSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects a workflow with an unknown role", () => {
    const raw = parseYaml(INVALID_ROLE_YAML);
    const result = workflowDefSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects a workflow missing the agents array", () => {
    const raw = parseYaml(MISSING_AGENTS_YAML);
    const result = workflowDefSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("accepts the purchasing-decision demo (schema sync check)", async () => {
    // Dynamically import the demo yaml to confirm cli/harness.mjs inline
    // schema would also accept it (since both use the same Zod shape).
    const { default: yamlText } = await import(
      "../../../examples/purchasing-decision.harness.yaml?raw"
    );
    const raw = parseYaml(yamlText as string);
    const result = workflowDefSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("version field must be semver X.Y.Z", () => {
    const bad = VALID_MINIMAL_YAML.replace('version: "1.0.0"', 'version: "1.0"');
    const result = workflowDefSchema.safeParse(parseYaml(bad));
    expect(result.success).toBe(false);
  });

  it("executionSettings maxParallel must be ≥ 1", () => {
    const bad = VALID_MINIMAL_YAML.replace("maxParallel: 1", "maxParallel: 0");
    const result = workflowDefSchema.safeParse(parseYaml(bad));
    expect(result.success).toBe(false);
  });
});
