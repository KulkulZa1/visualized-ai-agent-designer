// @vitest-environment node
/**
 * harness run end to end: the built bundle (npm run build:cli) through
 * cli/harness.mjs, against the fake harness-core with canned model replies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const root = resolve(__dirname, "../../..");
const fakeCore = join(root, "tests", "fixtures", "fake-core.mjs");

beforeAll(() => {
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--config", "vite.cli.config.ts", "--logLevel", "error"],
    { cwd: root, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
}, 120_000);

function agent(name: string, role: string, tools: string[] = []) {
  return {
    name, role, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 3, timeoutSeconds: 60,
    promptSource: { type: "inline", content: `You review and fix code as the ${name}.` }, tools,
    memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
  };
}

/** A workspace with a Coder → Reviewer workflow, and the fake core's scenario. */
function workspace(replies: Record<string, string[]>, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(dir, "review.harness.yaml"), stringify({
    meta: { name: "Code Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: [agent("Coder", "worker", ["bash"]), agent("Reviewer", "critic")],
    connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
    executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  }));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ replies, ...extra }));
  return dir;
}

function harnessRun(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [
    join(root, "cli", "harness.mjs"), "run", join(dir, "review.harness.yaml"),
    "--workspace", dir, "--core", fakeCore, ...args,
  ], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env, FAKE_CORE_SCENARIO: join(dir, "scenario.json"), FAKE_CORE_LOG: join(dir, "core.log"),
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "",
    },
  });
  const log = join(dir, "core.log");
  const requests = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cmd: string; args: Record<string, unknown> })
    : [];
  return { ...result, requests };
}

const bashCall = '<tool_call>{"name":"bash","args":{"command":"npm test"}}</tool_call>';

describe("harness run", () => {
  it("runs a workflow, printing each agent and a summary, and exits 0", () => {
    const run = harnessRun(workspace({ Coder: ["wrote the fix"], Reviewer: ["Looks good."] }), ["--task", "Fix the bug"]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("▶ Coder started (qwen2.5-coder:7b via ollama)");
    expect(run.stdout).toMatch(/✓ Coder done \(\d+\.\d s\)/);
    expect(run.stdout).toContain("Final output — Reviewer:\n  Looks good.");
    const coder = run.requests.find((r) => r.cmd === "call_ollama_api" && String(r.args.system).startsWith("You are Coder"));
    expect(coder?.args.userMessage).toContain("USER TASK:\nFix the bug");
  });

  it("prints only JSON events with --json", () => {
    const run = harnessRun(workspace({ Coder: ["done"], Reviewer: ["fine"] }), ["--task", "t", "--json"]);

    expect(run.status, run.stderr).toBe(0);
    const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    // Only the provider preflight's audit entries come before the run exists.
    expect(events.find((e) => e.type !== "audit")?.type).toBe("run_started");
    expect(events.filter((e) => e.type === "node_finished").map((e) => [e.agent, e.status]))
      .toEqual([["Coder", "done"], ["Reviewer", "done"]]);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "done", outputs: { "agent-1": "fine" } });
  });

  it("denies an agent's command unless it was allowed exactly with --allow-command", () => {
    const replies = { Coder: [bashCall, "tested"], Reviewer: ["ok"] };

    const denied = harnessRun(workspace(replies), ["--task", "t"]);
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stdout).toContain("$ Coder: command denied (not in --allow-command): npm test");
    expect(denied.requests.some((r) => r.cmd === "execute_command")).toBe(false);

    const allowed = harnessRun(workspace(replies), ["--task", "t", "--allow-command", "npm test"]);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toMatch(/\$ Coder ran: npm test \(allowed by --allow-command; exit 0/);
    expect(allowed.requests.find((r) => r.cmd === "execute_command")?.args)
      .toMatchObject({ command: "npm test", consentGranted: true });
  });

  it("exits 1 when an agent fails", () => {
    const run = harnessRun(workspace({ Coder: ["done"], Reviewer: ["ERROR: model crashed"] }), ["--task", "t"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("✗ Reviewer failed: model crashed");
  });

  it("exits 2 for bad usage or an invalid workflow, without starting harness-core", () => {
    const dir = workspace({});
    expect(harnessRun(dir, []).status).toBe(2); // no task

    writeFileSync(join(dir, "review.harness.yaml"), "meta:\n  name: broken\n");
    const invalid = harnessRun(dir, ["--task", "t"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("is not a valid workflow");
    expect(invalid.requests).toEqual([]);
  });

  it("exits 3 when harness-core is missing or the provider preflight fails", () => {
    const dir = workspace({}, { healthFails: true });

    const missing = harnessRun(dir, ["--task", "t", "--core", join(dir, "no-such-core")]);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("harness-core not found");

    const preflight = harnessRun(dir, ["--task", "t"]);
    expect(preflight.status).toBe(3);
    expect(preflight.stderr).toContain("Ollama is not running");
  });
});
