import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CATALOG } from "@/services/model-providers/providerCatalog";

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

// True where mkfifo can make a named pipe here (not on Windows). Tests that need one are skipped
// elsewhere.
const canMakeFifo = (() => {
  if (process.platform === "win32") return false;
  const dir = mkdtempSync(join(tmpdir(), "harness-cli-t-"));
  try {
    return spawnSync("mkfifo", [join(dir, "pipe")]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// A named pipe with nothing writing to it: opening it for reading blocks until something opens it
// for writing.
function makeFifo(path: string) {
  expect(spawnSync("mkfifo", [path]).status).toBe(0);
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

// `timeoutMs` kills a CLI that has not finished by then (it has no exit status afterwards).
function runHarness(args: string[], timeoutMs?: number) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
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

  it("reports native tool calling for Ollama and streaming and tool calling for the OpenAI-compatible endpoint, as the app's catalog does", () => {
    const result = runHarness(["provider", "list", "--json"]);

    const providers = JSON.parse(result.stdout) as Array<{ id: string; capabilities: Record<string, boolean> }>;
    const capabilities = (id: string) => providers.find((provider) => provider.id === id)?.capabilities;
    expect(capabilities("ollama")).toMatchObject({ streaming: true, toolCalling: true });
    expect(capabilities("ollama-cloud")).toMatchObject({ streaming: true, toolCalling: true });
    expect(capabilities("openai-compatible")).toMatchObject({ streaming: true, toolCalling: true });
    // [KEEP-IN-SYNC] the CLI keeps its own copy of the catalog: no provider's flags may drift from the app's.
    for (const provider of providers) {
      expect(provider.capabilities, provider.id)
        .toEqual(DEFAULT_PROVIDER_CATALOG.find((entry) => entry.id === provider.id)?.capabilities);
    }
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
    exampleWorkflowCount: number;
    packageName: string;
    auditEntries: number;
    snapshots: number;
  }

  function status(args: string[], timeoutMs?: number) {
    const result = runHarness(["project", "status", "--json", ...args], timeoutMs);
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

  it("does not follow symlinked folders, so a link loop cannot hang the workflow search", () => {
    const workspace = makeScratchDir();
    mkdirSync(join(workspace, "flows"));
    writeFileSync(join(workspace, "flows", "real.harness.yaml"), "", "utf8");
    // Two links back to the workspace itself: a search that follows them visits about 2^40 folders
    // (the system stops resolving a path after 40 links), which is as good as endless.
    // "junction" needs no privileges on Windows; other platforms create a directory symlink.
    symlinkSync(workspace, join(workspace, "flows", "loop1"), "junction");
    symlinkSync(workspace, join(workspace, "flows", "loop2"), "junction");

    // A search that ends takes well under a second. One stuck in the loop is killed by the
    // timeout instead, and then has no exit status.
    const found = status(["--workspace", workspace], 20_000);

    expect(found.workflows).toEqual(["real.harness.yaml"]);
  });

  it("lists no workflow behind a symlinked folder, whether the link leads out of the workspace or not", () => {
    const workspace = makeScratchDir();
    mkdirSync(join(workspace, "flows"));
    writeFileSync(join(workspace, "flows", "real.harness.yaml"), "", "utf8");
    const outside = makeScratchDir();
    writeFileSync(join(outside, "outside.harness.yml"), "", "utf8");
    symlinkSync(outside, join(workspace, "outside"), "junction");
    symlinkSync(join(workspace, "flows"), join(workspace, "alias"), "junction");
    // A linked folder is not a workflow file either, whatever it is called.
    symlinkSync(join(workspace, "flows"), join(workspace, "named.harness.yaml"), "junction");

    const found = status(["--workspace", workspace]);

    expect(found.workflows).toEqual(["real.harness.yaml"]);
    expect(found.workflowCount).toBe(1);
  });

  it("does not search an examples/ folder that is itself a symlink", () => {
    const workspace = makeScratchDir();
    const outside = makeScratchDir();
    writeFileSync(join(outside, "outside.harness.yaml"), "", "utf8");
    // `examples -> /` would walk the whole disk.
    symlinkSync(outside, join(workspace, "examples"), "junction");

    const found = status(["--workspace", workspace]);

    expect(found.exampleWorkflowCount).toBe(0);
    expect(found.workflowCount).toBe(0);
  });

  it("still searches a workspace that is given as a symlink, since the user chose it", () => {
    const real = makeScratchDir();
    writeFileSync(join(real, "flow.harness.yaml"), "", "utf8");
    const link = join(makeScratchDir(), "workspace-link");
    symlinkSync(real, link, "junction");

    expect(status(["--workspace", link]).workflows).toEqual(["flow.harness.yaml"]);
  });

  it.skipIf(process.platform === "win32")("does not list a symlink to a workflow file", () => {
    const workspace = makeScratchDir();
    writeFileSync(join(workspace, "real.harness.yaml"), "", "utf8");
    symlinkSync(join(workspace, "real.harness.yaml"), join(workspace, "linked.harness.yml"));

    expect(status(["--workspace", workspace]).workflows).toEqual(["real.harness.yaml"]);
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

  // The three files project status reads: where each is, what it holds, the JSON field that shows
  // it, and that field's value when the file is read and when it counts as missing.
  const readFiles = [
    { file: "package.json", content: '{ "name": "demo-app" }', field: "packageName", read: "demo-app", missing: "unknown" },
    { file: ".harness/audit.log.jsonl", content: '{"id":1}\n\n{"id":2}\n{"id":3}\n', field: "auditEntries", read: 3, missing: 0 },
    { file: ".harness/snapshots/index.json", content: '{ "a": [1, 2], "b": [3] }', field: "snapshots", read: 3, missing: 0 },
  ] as const;

  // Writes `content` to `path`, making its folders, and returns `path`.
  function writeFileIn(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("reads package.json, the audit log and the snapshot index when they are regular files", () => {
    const workspace = makeScratchDir();
    for (const { file, content } of readFiles) writeFileIn(join(workspace, file), content);

    const text = runHarness(["project", "status", "--workspace", workspace]);

    // The blank line in the audit log is not an entry.
    expect(status(["--workspace", workspace])).toMatchObject({ packageName: "demo-app", auditEntries: 3, snapshots: 3 });
    expect(text.stdout).toContain("App: Harness Studio (demo-app)");
    expect(text.stdout).toContain("Audit entries  : 3");
    expect(text.stdout).toContain("Snapshots      : 3");
  });

  it("still reads the files of a workspace that is given as a symlink, since the user chose it", () => {
    const real = makeScratchDir();
    for (const { file, content } of readFiles) writeFileIn(join(real, file), content);
    const link = join(makeScratchDir(), "workspace-link");
    symlinkSync(real, link, "junction");

    expect(status(["--workspace", link])).toMatchObject({ packageName: "demo-app", auditEntries: 3, snapshots: 3 });
  });

  it("still reads the audit log and the snapshot index behind a .harness folder that is a symlink to a folder inside the workspace", () => {
    const workspace = makeScratchDir();
    writeFileIn(join(workspace, "store", "audit.log.jsonl"), '{"id":1}\n{"id":2}\n');
    writeFileIn(join(workspace, "store", "snapshots", "index.json"), '{ "a": [1] }');
    // "junction" needs no privileges on Windows; other platforms create a directory symlink.
    symlinkSync(join(workspace, "store"), join(workspace, ".harness"), "junction");

    expect(status(["--workspace", workspace])).toMatchObject({ auditEntries: 2, snapshots: 1 });
  });

  it.skipIf(process.platform === "win32").each(readFiles)(
    "still reads $file when it is a symlink to a file inside the workspace",
    ({ file, content, field, read }) => {
      const workspace = makeScratchDir();
      const target = writeFileIn(join(workspace, "real", "data.txt"), content);
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      symlinkSync(target, join(workspace, file));

      expect(status(["--workspace", workspace])[field]).toBe(read);
    },
  );

  it.skipIf(process.platform === "win32").each(readFiles)(
    "still reads $file when it is a symlink into a folder named ..data, as in a Kubernetes ConfigMap mount",
    ({ file, content, field, read }) => {
      const workspace = makeScratchDir();
      // The real path of the file starts with "..data" under the workspace: that is inside it, not a way out.
      const target = writeFileIn(join(workspace, "..data", "data.txt"), content);
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      symlinkSync(target, join(workspace, file));

      expect(status(["--workspace", workspace])[field]).toBe(read);
    },
  );

  it.skipIf(process.platform === "win32").each(readFiles)(
    "shows no data of $file when it is a symlink to a file outside the workspace",
    ({ file, content, field, missing }) => {
      const workspace = makeScratchDir();
      const outside = writeFileIn(join(makeScratchDir(), "outside.txt"), content);
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      symlinkSync(outside, join(workspace, file));

      const result = runHarness(["project", "status", "--json", "--workspace", workspace]);

      expect(result.status).toBe(0);
      expect((JSON.parse(result.stdout) as Status)[field]).toBe(missing);
      // The package name it would have shown.
      expect(result.stdout).not.toContain("demo-app");
    },
  );

  it("shows no audit or snapshot data behind a .harness folder that is a symlink to a folder outside the workspace", () => {
    const workspace = makeScratchDir();
    const outside = makeScratchDir();
    // The files themselves are regular files: only the folder above them is a link.
    writeFileIn(join(outside, "audit.log.jsonl"), '{"id":1}\n{"id":2}\n{"id":3}\n');
    writeFileIn(join(outside, "snapshots", "index.json"), '{ "a": [1, 2], "b": [3] }');
    symlinkSync(outside, join(workspace, ".harness"), "junction");

    expect(status(["--workspace", workspace])).toMatchObject({ auditEntries: 0, snapshots: 0 });
  });

  it.skipIf(process.platform !== "linux").each(readFiles)(
    "returns promptly when $file is a symlink to /dev/zero",
    ({ file, field, missing }) => {
      const workspace = makeScratchDir();
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      symlinkSync("/dev/zero", join(workspace, file));

      // A CLI that reads it never reaches an end: it dies of memory exhaustion (std::bad_alloc), or
      // the timeout kills it. Either way it has no exit status.
      expect(status(["--workspace", workspace], 20_000)[field]).toBe(missing);
    },
  );

  it.skipIf(!canMakeFifo).each(readFiles)(
    "returns promptly when $file is a FIFO",
    ({ file, field, missing }) => {
      const workspace = makeScratchDir();
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      makeFifo(join(workspace, file));

      // Opening a FIFO that has no writer blocks for good: the timeout kills the CLI, which then
      // has no exit status.
      expect(status(["--workspace", workspace], 20_000)[field]).toBe(missing);
    },
  );
});
