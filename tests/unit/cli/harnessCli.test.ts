import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const cliPath = join(root, "cli", "harness.mjs");

// Scratch folders made through this helper are removed after each test.
const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "harness-cli-t-"));
  scratchDirs.push(dir);
  return dir;
}

// A valid workflow with `agentCount` agents (saved ids agent-0, agent-1, ...) and the given
// [source, target] connections.
function workflowYaml(agentCount: number, connections: Array<[string, string]> = []) {
  const agent = (i: number) => [
    `  - name: Agent ${i}`,
    "    role: worker",
    "    model: test-model",
    "    temperature: 0.5",
    "    maxTokens: 1024",
    "    maxSteps: 5",
    "    timeoutSeconds: 60",
    "    promptSource: { type: inline, content: Do the work. }",
    "    tools: []",
    "    memoryRead: []",
    "    memoryWrite: []",
    "    tokens: { used: 0, budget: 2000 }",
    "    status: idle",
  ].join("\n");
  return [
    "meta:",
    "  name: Fixture",
    '  version: "1.0.0"',
    "  description: fixture",
    '  projectRoot: ""',
    '  createdAt: "2026-01-01T00:00:00Z"',
    '  updatedAt: "2026-01-01T00:00:00Z"',
    agentCount > 0 ? "agents:" : "agents: []",
    ...Array.from({ length: agentCount }, (_, i) => agent(i)),
    connections.length > 0 ? "connections:" : "connections: []",
    ...connections.map(([source, target], i) =>
      `  - { id: c-${i}, sourceAgentId: ${JSON.stringify(source)}, targetAgentId: ${JSON.stringify(target)} }`),
    "executionSettings: { maxParallel: 1, timeoutSeconds: 600, retryOnFailure: false, maxRetries: 0 }",
    "nodePositions: {}",
    "",
  ].join("\n");
}

function runHarness(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      KILO_API_KEY: "",
    },
  });
}

describe("harness CLI v0 subprocess", () => {
  it("prints read-only project status", () => {
    const result = runHarness(["project", "status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Harness Studio");
    expect(result.stdout).toContain("Read-only CLI v0");
    expect(result.stdout).toContain("AGENT.md");
  });

  it("lists providers without printing key-like secret values", () => {
    const result = runHarness(["provider", "list", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    const providers = JSON.parse(result.stdout) as Array<{
      id: string;
      type: string;
      classification: string;
      capabilities: Record<string, boolean>;
      credentialRef?: string;
    }>;
    expect(providers.some((provider) => provider.id === "openai")).toBe(true);
    expect(providers.some((provider) => provider.classification === "local")).toBe(true);
    expect(providers.every((provider) => provider.capabilities)).toBe(true);
    expect(providers.find((provider) => provider.id === "openai")?.credentialRef).toBe(
      "env:OPENAI_API_KEY",
    );
  });

  it("validates the purchasing decision demo", () => {
    const result = runHarness([
      "workflow",
      "validate",
      "examples/purchasing-decision.harness.yaml",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALID");
    expect(result.stdout).toContain("Purchasing Decision Assistant");
    expect(result.stdout).toContain("Agents");
    expect(result.stdout).toContain("Connections");
  });

  it("fails cleanly when the workflow file is missing", () => {
    const result = runHarness(["workflow", "validate", "missing-file-does-not-exist.harness.yaml"]);

    expect(result.status).not.toBe(0);
    const error = JSON.parse(result.stderr) as { error: { message: string } };
    expect(error.error.message).toContain("File not found");
  });

  it("fails cleanly for invalid workflow YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-"));
    const file = join(dir, "invalid.harness.yaml");
    writeFileSync(file, "meta:\n  name: Broken\nagents: []\n", "utf8");

    const result = runHarness(["workflow", "validate", file, "--json"]);

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; issues: unknown[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("does not treat a leading --workspace value as the command", () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-cli-ws-"));

    const result = runHarness(["--workspace", workspace, "project", "status", "--json"]);

    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout) as { workspace: string };
    expect(status.workspace).toBe(resolve(workspace));
  });

  it("validates the file, not the --workspace value, when the flag precedes the path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-cli-ws-"));
    const file = join(root, "examples", "purchasing-decision.harness.yaml");

    const result = runHarness(["workflow", "validate", "--workspace", workspace, file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALID");
    expect(result.stdout).toContain("Purchasing Decision Assistant");
  });
});

describe("harness CLI workflow validate: connection references", () => {
  function validate(yaml: string, extraArgs: string[] = []) {
    const file = join(makeScratchDir(), "fixture.harness.yaml");
    writeFileSync(file, yaml, "utf8");
    return runHarness(["workflow", "validate", file, ...extraArgs]);
  }

  interface JsonIssues {
    valid: boolean;
    agents?: number;
    connections?: number;
    issues?: Array<{ path: string; message: string }>;
  }

  it("accepts connections between existing agents, including the last one", () => {
    const result = validate(workflowYaml(3, [["agent-0", "agent-1"], ["agent-2", "agent-0"]]), ["--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as JsonIssues).toMatchObject({ valid: true, agents: 3, connections: 2 });
  });

  const dangling: Array<[string, Array<[string, string]>, string[]]> = [
    ["a target that does not exist", [["agent-0", "agent-9"]], ["connections.0.targetAgentId"]],
    ["a source that does not exist", [["ghost", "agent-1"]], ["connections.0.sourceAgentId"]],
    ["the first index past the last agent", [["agent-0", "agent-2"]], ["connections.0.targetAgentId"]],
    ["a non-canonical id", [["agent-01", "agent-1"]], ["connections.0.sourceAgentId"]],
    ["both ends of a later connection", [["agent-0", "agent-1"], ["x", "y"]], ["connections.1.sourceAgentId", "connections.1.targetAgentId"]],
  ];

  it.each(dangling)("reports %s as invalid (--json)", (_label, connections, paths) => {
    const result = validate(workflowYaml(2, connections), ["--json"]);

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as JsonIssues;
    expect(parsed.valid).toBe(false);
    expect(parsed.issues?.map((issue) => issue.path)).toEqual(paths);
    for (const issue of parsed.issues ?? []) {
      expect(issue.message).toContain("Unknown agent");
      expect(issue.message).toContain("agent-0 to agent-1");
    }
  });

  it("names the offending id and prints INVALID with a non-zero exit in text mode", () => {
    const result = validate(workflowYaml(2, [["agent-0", "agent-7"]]));

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID");
    expect(result.stderr).toContain("[connections.0.targetAgentId]");
    expect(result.stderr).toContain('"agent-7"');
  });

  it("reports both ends when the workflow has no agents at all", () => {
    const result = validate(workflowYaml(0, [["agent-0", "agent-1"]]), ["--json"]);

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as JsonIssues;
    expect(parsed.issues?.map((issue) => issue.path)).toEqual(["connections.0.sourceAgentId", "connections.0.targetAgentId"]);
    expect(parsed.issues?.[0].message).toContain("no agents");
  });

  it("still reports schema errors when the shape is wrong", () => {
    const result = validate(workflowYaml(2, [["agent-0", "agent-1"]]).replace("role: worker", "role: superagent"), ["--json"]);

    expect(result.status).not.toBe(0);
    expect((JSON.parse(result.stdout) as JsonIssues).issues?.map((issue) => issue.path)).toContain("agents.0.role");
  });
});

describe("harness CLI project status: workspace discovery", () => {
  interface Status {
    workspace: string;
    workflowCount: number;
    workflows: string[];
    packageName: string;
  }

  function status(args: string[]) {
    const result = runHarness(["project", "status", "--json", ...args]);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Status;
  }

  it("accepts --workspace=<path>", () => {
    const workspace = makeScratchDir();

    expect(status([`--workspace=${workspace}`]).workspace).toBe(resolve(workspace));
  });

  it("accepts --workspace=<path> before the command and next to a positional", () => {
    const workspace = makeScratchDir();
    const leading = runHarness([`--workspace=${workspace}`, "project", "status", "--json"]);
    const file = join(root, "examples", "purchasing-decision.harness.yaml");
    const withPositional = runHarness(["workflow", "validate", `--workspace=${workspace}`, file]);

    expect(leading.status).toBe(0);
    expect((JSON.parse(leading.stdout) as Status).workspace).toBe(resolve(workspace));
    expect(withPositional.status).toBe(0);
    expect(withPositional.stdout).toContain("Purchasing Decision Assistant");
  });

  it("still accepts --workspace <path> after the command", () => {
    const workspace = makeScratchDir();

    expect(status(["--workspace", workspace]).workspace).toBe(resolve(workspace));
  });

  it("falls back to the default workspace when --workspace= has no value", () => {
    expect(status(["--workspace="]).workspace).toBe(status([]).workspace);
  });

  it("skips only directories named exactly node_modules or target", () => {
    const workspace = makeScratchDir();
    const layout: Array<[string, string]> = [
      ["", "top.harness.yaml"],
      ["targets", "in-targets.harness.yaml"],
      ["retargeting", "in-retargeting.harness.yaml"],
      ["nested/my-target-app", "in-my-target-app.harness.yaml"],
      ["target", "skipped-target.harness.yaml"],
      ["node_modules", "skipped-node-modules.harness.yaml"],
      ["src/node_modules", "skipped-nested-node-modules.harness.yaml"],
      ["nested/target", "skipped-nested-target.harness.yaml"],
    ];
    for (const [dir, file] of layout) {
      mkdirSync(join(workspace, dir), { recursive: true });
      writeFileSync(join(workspace, dir, file), "", "utf8");
    }

    const found = status(["--workspace", workspace]);

    expect([...found.workflows].sort()).toEqual([
      "in-my-target-app.harness.yaml",
      "in-retargeting.harness.yaml",
      "in-targets.harness.yaml",
      "top.harness.yaml",
    ]);
    expect(found.workflowCount).toBe(4);
  });

  it("reads the package name from a package.json object", () => {
    const workspace = makeScratchDir();
    writeFileSync(join(workspace, "package.json"), '{ "name": "demo-app" }', "utf8");

    expect(status(["--workspace", workspace]).packageName).toBe("demo-app");
  });

  it.each(["null", "[]", '"text"', "42", "true"])("treats a package.json containing %s as missing", (json) => {
    const workspace = makeScratchDir();
    writeFileSync(join(workspace, "package.json"), json, "utf8");

    const result = runHarness(["project", "status", "--json", "--workspace", workspace]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect((JSON.parse(result.stdout) as Status).packageName).toBe("unknown");
  });

  it("prints the status page instead of crashing on a null package.json", () => {
    const workspace = makeScratchDir();
    writeFileSync(join(workspace, "package.json"), "null", "utf8");

    const result = runHarness(["project", "status", "--workspace", workspace]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("App: Harness Studio (unknown)");
  });
});
