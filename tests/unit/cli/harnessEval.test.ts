// @vitest-environment node
/**
 * harness eval end to end: the built bundle (npm run build:cli) through cli/harness.mjs, against the fake
 * harness-core with canned model replies and scripted commands. The bundle is built into a private copy of
 * the CLI under outputs/: harnessRun.test.ts builds cli/dist at the same time, and two builds that empty one
 * folder would race.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const root = resolve(__dirname, "../../..");
/** A run of the CLI that takes longer than this is hung: a synchronous spawn would block the test for good. */
const SPAWN_TIMEOUT_MS = 50_000;
const fakeCore = join(root, "tests", "fixtures", "fake-core.mjs");
let privateCli = "";
let cli = "";

beforeAll(() => {
  mkdirSync(join(root, "outputs"), { recursive: true });
  privateCli = mkdtempSync(join(root, "outputs", "eval-cli-"));
  mkdirSync(join(privateCli, "cli", "dist"), { recursive: true });
  copyFileSync(join(root, "cli", "harness.mjs"), join(privateCli, "cli", "harness.mjs"));
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [
    vite, "build", "--config", "vite.cli.config.ts", "--logLevel", "error", "--outDir", join(privateCli, "cli", "dist"),
  ], { cwd: root, encoding: "utf8", timeout: 100_000 });
  expect(build.status, build.stderr).toBe(0);
  cli = join(privateCli, "cli", "harness.mjs");
}, 120_000);

afterAll(() => {
  if (privateCli) rmSync(privateCli, { recursive: true, force: true });
});

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(name: string, role: string, tools: string[] = []) {
  return {
    name, role, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 8, timeoutSeconds: 60,
    promptSource: { type: "inline", content: `You work as the ${name}.` }, tools,
    memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const PRISTINE_TEST = "// pristine a\n";
const PRISTINE_PACKAGE = '{"scripts":{"test":"node --test test"}}\n';
const HIDDEN_TEST = "// the real hidden test\n";
const REPORT_MD = "## Ranking\n1. SUP-A\n";

const tests = {
  name: "tests", command: "npm test --silent", restore: ["test", "package.json"],
  inject: [{ from: "grader/hidden.test.js", to: "test/hidden.test.js" }],
};
const laptop = (extra: Record<string, unknown> = {}) => ({
  id: "laptop", task: "Rank the three offers for 40 laptops.", workspace: "fixtures/laptop", weight: 2,
  scorers: [
    tests,
    { name: "names-the-winner", output: { contains: ["SUP-A"], notContains: ["SUP-C"], node: "Reviewer" } },
    { name: "wrote-the-report", file: { path: "report.md", contains: ["## Ranking"] } },
  ],
  ...extra,
});
const phone = (extra: Record<string, unknown> = {}) => ({
  id: "phone", task: "Pick a phone.", workspace: "fixtures/phone", scorers: [{ name: "answer", output: { matches: ["SUP-[AB]"] } }], ...extra,
});

interface Options {
  tasks?: unknown[];
  taskSet?: Record<string, unknown>;
  replies?: Record<string, string[]>;
  commands?: Record<string, unknown>;
  scenario?: Record<string, unknown>;
  files?: Record<string, string>;
  agents?: ReturnType<typeof agent>[];
}

/** A folder with a Coder → Reviewer workflow, a task set (laptop and phone, two trials each), their fixtures and the fake core's scenario. */
function project(options: Options = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-eval-e2e-"));
  scratch.push(dir);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("wf.harness.yaml", stringify({
    meta: { name: "Code Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: options.agents ?? [agent("Coder", "worker", ["fs.write", "bash"]), agent("Reviewer", "critic")],
    connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
    executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  }));
  put("tasks.yaml", stringify({
    version: 1, name: "purchasing", workflow: "wf.harness.yaml", trials: 2, tasks: options.tasks ?? [laptop(), phone()], ...options.taskSet,
  }));
  put("fixtures/laptop/package.json", PRISTINE_PACKAGE);
  put("fixtures/laptop/test/a.test.js", PRISTINE_TEST);
  put("fixtures/laptop/report.md", REPORT_MD);
  put("fixtures/phone/readme.md", "# phone\n");
  put("grader/hidden.test.js", HIDDEN_TEST);
  for (const [path, text] of Object.entries(options.files ?? {})) put(path, text);
  put("scenario.json", JSON.stringify({
    replies: { Coder: ["wrote it"], Reviewer: ["Winner: SUP-A"], ...options.replies },
    // The tests' scorer fails; every other scorer of the default tasks passes.
    commands: { "npm test --silent": { exitCode: 1, stdout: "1 failed" }, ...options.commands },
    ...options.scenario,
  }));
  return dir;
}

type Request = { cmd: string; args: Record<string, unknown> };
const environment = (dir: string, env: Record<string, string> = {}) => ({
  ...process.env, FAKE_CORE_SCENARIO: join(dir, "scenario.json"), FAKE_CORE_LOG: join(dir, "core.log"),
  OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "", HARNESS_OLLAMA_NUM_CTX: "", HARNESS_REQUEST_TIMEOUT_SECS: "",
  HARNESS_CUSTOM_BASE_URL: "", HARNESS_CUSTOM_MODEL: "", HARNESS_CUSTOM_API_KEY: "", ...env,
});
/** What the fake core was asked, in order. A line still being written (the file is read while the core runs) is not there yet. */
const requestsOf = (dir: string): Request[] => existsSync(join(dir, "core.log"))
  ? readFileSync(join(dir, "core.log"), "utf8").split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Request] : [];
    } catch {
      return [];
    }
  })
  : [];
const out = (dir: string) => join(dir, "out");
/** A report, read field by field in the tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = any;
const reportOf = (dir: string, folder = out(dir)): Report =>
  existsSync(join(folder, "report.json")) && statSync(join(folder, "report.json")).isFile()
    ? JSON.parse(readFileSync(join(folder, "report.json"), "utf8")) : undefined;
const onWindows = process.platform === "win32";
const approve = ["--allow-scorer", "npm test --silent"];

/** `harness eval <dir>/tasks.yaml`, with the fake core and an output folder in `dir`; `args` follow. */
function harnessEval(dir: string, args: string[] = approve, env: Record<string, string> = {}, taskSet = "tasks.yaml") {
  const result = spawnSync(process.execPath, [
    cli, "eval", join(dir, taskSet), "--core", fakeCore, "--out", out(dir), ...args,
  ], { cwd: dir, encoding: "utf8", env: environment(dir, env), timeout: SPAWN_TIMEOUT_MS });
  return { ...result, requests: requestsOf(dir), report: reportOf(dir) };
}
const readIn = (dir: string, ...path: string[]) => readFileSync(join(dir, ...path), "utf8");
const jsonIn = (dir: string, ...path: string[]) => JSON.parse(readIn(dir, ...path)) as Report;

const write = (path: string, content: string) => `<tool_call>${JSON.stringify({ name: "fs.write", args: { path, content } })}</tool_call>`;

// Each test runs the CLI a few times in a row, synchronously: under a full parallel suite that can pass vitest's 5 s default.
describe("harness eval", { timeout: 60_000 }, () => {
  it("runs each task k times, scores every trial and reports S, C and, per task, the rewards, tokens and missing trials", () => {
    const dir = project();

    const run = harnessEval(dir);

    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toMatch(/^\[1\/4\] laptop t0: reward 0\.67 \(tests ✗, names-the-winner ✓, wrote-the-report ✓\) · run \d+\.\d s, scoring \d+\.\d s$/);
    expect(lines[3]).toMatch(/^\[4\/4\] phone t1: reward 1\.00 \(answer ✓\) · run /);
    expect(run.stdout).toContain("2 tasks × 2 trials · done");
    expect(run.stdout).toContain("  laptop: mean 0.67 · rewards 0.67 0.67");
    expect(run.stdout).toContain("S 0.778 · C n/a · 4 of 4 trials, 0 missing");
    expect(run.stdout).toContain(`Report: ${join(out(dir), "report.json")}`);

    const report = run.report;
    expect(report).toMatchObject({
      version: 1, status: "done", split: "evolve", k: 2, C: null, n_expected: 4, n_done: 4, missing: 0,
      taskSet: { name: "purchasing", path: join(dir, "tasks.yaml"), hash: sha256(readIn(dir, "tasks.yaml")) },
      workflow: { name: "Code Review", path: join(dir, "wf.harness.yaml"), hash: sha256(readIn(dir, "wf.harness.yaml")) },
      provider: { llmProvider: "auto", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "", ollamaNumCtx: 16384 },
    });
    expect(report.evalId).toMatch(/^eval-\d+$/);
    expect(Date.parse(report.startedAt)).not.toBeNaN();
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    // Pooled: laptop's trials weigh 2, phone's 1: (2 x 2/3 + 2 x 2/3 + 1 + 1) / 6.
    expect(report.S).toBeCloseTo(7 / 9, 9);
    expect(Object.keys(report.per_task)).toEqual(["laptop", "phone"]);
    expect(report.per_task.laptop).toMatchObject({ weight: 2, missing: 0, tokens: [null, null] });
    expect(report.per_task.laptop.mean).toBeCloseTo(2 / 3, 9);
    expect(report.per_task.laptop.rewards).toEqual([2 / 3, 2 / 3]);
    expect(report.per_task.phone).toMatchObject({ weight: 1, mean: 1, rewards: [1, 1], missing: 0 });
    const first = report.per_task.laptop.trials[0];
    expect(first).toMatchObject({ trial: 0, missing: false, runStatus: "done", tokens: null });
    expect(first.tokenEstimate).toBeGreaterThan(0);
    expect(first.runMs).toBeGreaterThanOrEqual(0);
    expect(first.scoreMs).toBeGreaterThanOrEqual(0);
    expect(first.scorers.map((s: Report) => [s.name, s.kind, s.passed, s.weight])).toEqual([
      ["tests", "command", false, 1], ["names-the-winner", "output", true, 1], ["wrote-the-report", "file", true, 1],
    ]);
    expect(Object.keys(first.scorers[0])).toEqual(["name", "kind", "passed", "weight", "exitCode", "timedOut", "ms"]); // the design's sample, in its order
    expect(first.scorers[0]).toMatchObject({ name: "tests", kind: "command", passed: false, weight: 1, exitCode: 1, timedOut: false });
    expect(first.scorers[0].ms).toBeGreaterThanOrEqual(0);
    expect(first.scorers[0]).not.toHaveProperty("stdout"); // the report stays small: the output is kept in the trial's own files
  });

  it("keeps each trial's outcome, scorer results, log and run record under trials/<task>/t<i>/", () => {
    const dir = project();

    const run = harnessEval(dir);

    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(join(out(dir), "trials", "laptop")).sort()).toEqual(["t0", "t1"]);
    const trial = join(out(dir), "trials", "laptop", "t0");
    expect(readdirSync(trial).sort()).toEqual(["outcome.json", "run.json", "run.log", "scorers.json"]);
    const outcome = jsonIn(trial, "outcome.json");
    expect(outcome).toMatchObject({
      task: "laptop", trial: 0, runStatus: "done", missing: false, error: null, tokens: null,
      agents: { "agent-0": { agent: "Coder", status: "done" }, "agent-1": { agent: "Reviewer", status: "done" } },
      outputs: { "agent-1": "Winner: SUP-A" },
    });
    expect(outcome.reward).toBeCloseTo(2 / 3, 9);
    expect(jsonIn(trial, "scorers.json")[0]).toMatchObject({
      name: "tests", kind: "command", passed: false, exitCode: 1, command: "npm test --silent", stdout: "1 failed", stderr: "",
    });
    expect(readIn(trial, "run.log")).toContain("▶ Coder started (qwen2.5-coder:7b via ollama)");
    expect(readIn(trial, "run.log")).toContain("Final output — Reviewer:\n  Winner: SUP-A");
    expect(jsonIn(trial, "run.json")).toMatchObject({ version: 1, runId: outcome.runId, status: "done", task: "Rank the three offers for 40 laptops." });
  });

  it("puts the files back before a command scorer runs: what an agent overwrote and what it added are undone", () => {
    const dir = project({
      tasks: [laptop({ weight: 1, scorers: [{ ...tests, name: "inspect" }] })],
      taskSet: { trials: 1 },
      replies: {
        Coder: [
          write("test/hidden.test.js", "// the agent's own hidden test\n"), write("test/a.test.js", "// the agent weakened this test\n"),
          write("test/extra.test.js", "// a test the agent added\n"), write("package.json", '{"scripts":{"test":"echo ok"}}\n'),
          write("notes.txt", "the agent's notes\n"), "done",
        ],
      },
      commands: { "npm test --silent": { snapshot: true } },
    });

    const run = harnessEval(dir);

    expect(run.status, run.stderr).toBe(0);
    const trial = join(out(dir), "trials", "laptop", "t0");
    // The agent did all of that: the copy of the run record has the changes.
    expect(jsonIn(trial, "run.json").changes.map((c: Report) => c.path).sort())
      .toEqual(["notes.txt", "package.json", "test/a.test.js", "test/extra.test.js", "test/hidden.test.js"]);
    // And this is what the scorer's command found.
    const found = JSON.parse(jsonIn(trial, "scorers.json")[0].stdout) as Record<string, string>;
    expect(found["test/a.test.js"]).toBe(PRISTINE_TEST);
    expect(found["package.json"]).toBe(PRISTINE_PACKAGE);
    expect(found["test/hidden.test.js"]).toBe(HIDDEN_TEST);
    expect(found).not.toHaveProperty("test/extra.test.js");
    expect(found["notes.txt"]).toBe("the agent's notes\n"); // not listed in restore: the agent's own to keep
    // The originals were never in the trial's folder.
    expect(readIn(dir, "fixtures", "laptop", "test", "a.test.js")).toBe(PRISTINE_TEST);
    expect(readIn(dir, "grader", "hidden.test.js")).toBe(HIDDEN_TEST);
    expect(requestsOf(dir).find((r) => r.cmd === "execute_command")?.args.workspacePath).not.toContain(dir);
  });

  it("reads what the agents left before the command scorers put files back: a file check written after a restore grades the agents' file, and the results keep the order written", () => {
    // The agent breaks package.json, so that `npm test` passes whatever the code does. The restore of the scorer
    // before the file check would put the real one back for the check to read.
    const dir = project({
      tasks: [laptop({ weight: 1, scorers: [
        { name: "tests", command: "npm test --silent", restore: ["package.json"] },
        { name: "has-the-test-script", file: { path: "package.json", contains: ["node --test"] } },
      ] })],
      taskSet: { trials: 1 },
      replies: { Coder: [write("package.json", '{"scripts":{"test":"echo ok"}}\n'), "done"] },
      commands: { "npm test --silent": { exitCode: 0 } },
    });

    const run = harnessEval(dir);

    expect(run.status, run.stderr).toBe(0);
    const trial = run.report.per_task.laptop.trials[0];
    expect(trial.scorers.map((s: Report) => [s.name, s.passed])).toEqual([["tests", true], ["has-the-test-script", false]]);
    expect(trial.reward).toBe(0.5);
    expect(run.report.S).toBe(0.5);
    expect(jsonIn(out(dir), "trials", "laptop", "t0", "scorers.json").map((s: Report) => s.name)).toEqual(["tests", "has-the-test-script"]);
    expect(run.stdout).toContain("(tests ✓, has-the-test-script ✗)");
  });

  // (child.kill("SIGINT") ends the process on Windows: there is no Ctrl+C to send to it.)
  it.skipIf(onWindows)("writes report.json before the first trial and after each one, and stops on Ctrl+C: cancelled, exit 130, the running scorer command cancelled", async () => {
    const dir = project({
      tasks: [
        { id: "fast", task: "t", scorers: [{ name: "quick", command: "quick cmd" }] },
        { id: "slow", task: "t", scorers: [{ name: "stuck", command: "slow cmd" }] },
        { id: "never", task: "t", scorers: [{ name: "late", command: "quick cmd" }] },
      ],
      taskSet: { trials: 1 },
      commands: { "quick cmd": { exitCode: 0 }, "slow cmd": { exitCode: 0, delayMs: 60_000 } },
    });
    const child = spawn(process.execPath, [
      cli, "eval", join(dir, "tasks.yaml"), "--core", fakeCore, "--out", out(dir), "--allow-scorer", "quick cmd", "--allow-scorer", "slow cmd",
    ], { cwd: dir, env: environment(dir), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((done) => { child.on("close", (code: number | null) => done(code)); });
    const slowStarted = async () => {
      for (let waited = 0; waited < 30_000; waited += 50) {
        if (requestsOf(dir).some((r) => r.cmd === "execute_command" && r.args.command === "slow cmd")) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`the slow command never started: ${stderr}`);
    };
    try {
      await slowStarted();

      // The first trial is in the report, which says the eval is still running.
      expect(reportOf(dir)).toMatchObject({ status: "running", n_expected: 3, n_done: 1, S: 1 });
      expect(reportOf(dir).per_task.fast.trials).toHaveLength(1);

      const stopped = Date.now();
      child.kill("SIGINT");
      expect(await closed).toBe(130);

      expect(Date.now() - stopped).toBeLessThan(20_000); // the 60 s command was cancelled, not waited for
      expect(stderr).toContain("Stopping the eval… (press Ctrl+C again to exit now)");
      const slow = requestsOf(dir).find((r) => r.cmd === "execute_command" && r.args.command === "slow cmd");
      expect(requestsOf(dir)).toContainEqual({ cmd: "cancel_command", args: { commandId: slow?.args.commandId } });
      const report = reportOf(dir);
      expect(report).toMatchObject({ status: "cancelled", n_expected: 3, n_done: 1, missing: 0 });
      expect(report.finishedAt).toBeDefined();
      expect(report.per_task.slow.trials).toEqual([]); // the interrupted trial counts for nothing
      expect(report.per_task.never.trials).toEqual([]); // and no trial was started after it
      expect(requestsOf(dir).filter((r) => r.cmd === "check_provider_health")).toHaveLength(2);
    } finally {
      child.kill("SIGKILL"); // not left running if the test failed before the Ctrl+C
    }
  });

  describe("what is not a clean score", () => {
    it("scores a scorer that ran out of time as failed, with timedOut, and the trial is not missing", () => {
      const dir = project({
        tasks: [phone({ scorers: [
          { name: "slow-tests", command: "slow cmd", timeoutSecs: 30 }, { name: "answer", output: { contains: ["SUP-A"] } },
        ] })],
        taskSet: { trials: 1 },
        commands: { "slow cmd": { timeout: true } },
      });

      const run = harnessEval(dir, ["--allow-scorer", "slow cmd"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report).toMatchObject({ status: "done", missing: 0, S: 0.5 });
      const trial = run.report.per_task.phone.trials[0];
      expect(trial).toMatchObject({ missing: false, reward: 0.5 });
      expect(trial.scorers[0]).toMatchObject({ name: "slow-tests", passed: false, timedOut: true, detail: "Command timed out after 30 s" });
      expect(trial.scorers[0]).not.toHaveProperty("exitCode");
      expect(run.stdout).toContain("slow-tests ✗ (timed out)");
    });

    it("makes a trial missing when its scorer command cannot start: reward 0, counted in the denominator", () => {
      const dir = project({
        tasks: [phone(), { id: "broken", task: "t", scorers: [{ name: "build", command: "no-such-tool" }] }],
        taskSet: { trials: 1 },
        commands: { "no-such-tool": { fail: "No such file or directory (os error 2)" } },
      });

      const run = harnessEval(dir, ["--allow-scorer", "no-such-tool"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report).toMatchObject({ status: "done", n_expected: 2, n_done: 2, missing: 1, S: 0.5 });
      expect(run.report.per_task.broken).toMatchObject({ rewards: [0], missing: 1, mean: 0 });
      expect(run.report.per_task.broken.trials[0]).toMatchObject({
        missing: true, reward: 0, runStatus: "done", error: "scorer build: Could not start the command: No such file or directory (os error 2)",
      });
      expect(run.stdout).toContain("[2/2] broken t0: missing (scorer build: Could not start the command: No such file or directory (os error 2))");
    });

    it("makes a later trial missing, not the end of the eval, when its provider check fails", () => {
      // Checks 1 and 2 are laptop's trials; the third, phone's first, fails.
      const dir = project({ scenario: { healthFailsOn: [3] } });

      const run = harnessEval(dir);

      expect(run.status, run.stderr).toBe(0); // the eval finished
      expect(run.report).toMatchObject({ status: "done", n_done: 4, missing: 1 });
      expect(run.report.per_task.phone.rewards).toEqual([0, 1]);
      expect(run.report.per_task.phone.trials[0]).toMatchObject({
        missing: true, reward: 0, runStatus: "not_started", tokenEstimate: null, scorers: [],
        error: "Ollama is not running",
      });
      // (2 x 2/3 + 2 x 2/3 + 0 + 1) / 6
      expect(run.report.S).toBeCloseTo(11 / 18, 9);
      expect(run.requests.filter((r) => r.cmd === "check_provider_health")).toHaveLength(4); // every trial checks
    });

    it("scores a trial whose agent failed as usual, and shows the failure: it is not a missing trial", () => {
      const dir = project({ replies: { Reviewer: ["ERROR: model crashed"] } });

      const run = harnessEval(dir);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report.missing).toBe(0);
      const trial = run.report.per_task.laptop.trials[0];
      expect(trial).toMatchObject({ missing: false, runStatus: "error", error: "Reviewer failed: model crashed" });
      // The output scorer has no output to check: failed. The file scorer passed, the command scorer failed.
      expect(trial.scorers.map((s: Report) => s.passed)).toEqual([false, false, true]);
      expect(trial.scorers[1].detail).toBe("Reviewer has no output");
      expect(trial.reward).toBeCloseTo(1 / 3, 9);
      expect(run.stdout).toContain("· error: Reviewer failed: model crashed");
    });
  });

  describe("the exit codes", () => {
    it("is 0 whatever the score, and 1 when --min-score was given and S is below it", () => {
      const reached = harnessEval(project(), [...approve, "--min-score", "0.7"]);
      expect(reached.status, reached.stderr).toBe(0);

      const below = harnessEval(project(), [...approve, "--min-score", "0.9"]);

      expect(below.status).toBe(1);
      expect(below.stderr).toContain("harness eval: S 0.778 is below --min-score 0.9");
      expect(below.report).toMatchObject({ status: "done" }); // the report is the same: the threshold only sets the exit code
      expect(below.report.S).toBeCloseTo(7 / 9, 9);
    });

    it("is 3 when the first trial's run does not start, with the report saying why and no other trial tried", () => {
      const dir = project({ scenario: { healthFails: true } });

      const run = harnessEval(dir);

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("harness eval: the first trial's run did not start: Ollama is not running");
      expect(run.report).toMatchObject({
        status: "error", n_expected: 4, n_done: 1, missing: 1, S: 0,
        error: expect.stringContaining("the first trial's run did not start"),
      });
      expect(run.report.per_task.laptop.trials[0]).toMatchObject({ missing: true, runStatus: "not_started" });
      expect(run.requests.filter((r) => r.cmd === "check_provider_health")).toHaveLength(1);
    });

    it("is 3 when harness-core stops during the eval: that trial is missing, no other starts, and the report says why", () => {
      const dir = project({
        tasks: [
          { id: "fast", task: "t", scorers: [{ name: "quick", command: "quick cmd" }] },
          { id: "crash", task: "t", scorers: [{ name: "boom", command: "crash cmd" }] },
          { id: "never", task: "t", scorers: [{ name: "late", command: "quick cmd" }] },
        ],
        taskSet: { trials: 1 },
        commands: { "quick cmd": { exitCode: 0 }, "crash cmd": { die: true } },
      });

      const run = harnessEval(dir, ["--allow-scorer", "quick cmd", "--allow-scorer", "crash cmd"]);

      expect(run.status, run.stderr).toBe(3);
      expect(run.stderr).toContain("harness eval: harness-core stopped during the eval");
      expect(run.report).toMatchObject({ status: "error", error: "harness-core stopped during the eval", n_expected: 3, n_done: 2, missing: 1 });
      expect(run.report.per_task.crash.trials[0]).toMatchObject({ missing: true, reward: 0, error: "scorer boom: harness-core stopped" });
      expect(run.report.per_task.never.trials).toEqual([]);
      expect(run.report.per_task.fast.rewards).toEqual([1]);
    });

    it("is 3 when harness-core is missing, before anything is written", () => {
      const dir = project();

      const run = harnessEval(dir, [...approve, "--core", join(dir, "no-such-core")]);

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("harness eval: harness-core not found");
      expect(existsSync(out(dir))).toBe(false);
    });

    it("is 2 for a scorer command that was not approved, listing it, with nothing started and nothing written", () => {
      const dir = project();

      const run = harnessEval(dir, []);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("this scorer command is not approved");
      expect(run.stderr).toContain('--allow-scorer "<command>"');
      expect(run.stderr).toContain("  npm test --silent    (laptop/tests)");
      expect(run.requests).toEqual([]); // harness-core was never started
      expect(existsSync(out(dir))).toBe(false);
    });

    it("is 2 for a scorer command that was passed only with --allow-command: what agents may run is not what scorers may run", () => {
      const dir = project();

      const run = harnessEval(dir, ["--allow-command", "npm test --silent"]);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("this scorer command is not approved");
      expect(run.stderr).toContain("  npm test --silent    (laptop/tests)");
      expect(run.requests).toEqual([]);
      expect(existsSync(out(dir))).toBe(false);
    });

    it("lists every command that is not approved, once, and only those", () => {
      const dir = project({
        tasks: [laptop(), phone({ scorers: [{ name: "lint", command: "npm run lint" }, { name: "tests", command: "npm test --silent" }] })],
      });

      const run = harnessEval(dir, ["--allow-scorer", "npm run lint"]);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("  npm test --silent    (laptop/tests, phone/tests)");
      expect(run.stderr).not.toMatch(/ {2}npm run lint/);
    });

    it("does not ask for the commands of tasks that are not selected", () => {
      const dir = project({ tasks: [laptop(), phone({ split: "heldout", scorers: [{ name: "x", command: "secret grader" }] })], taskSet: { trials: 1 } });

      const run = harnessEval(dir);

      expect(run.status, run.stderr).toBe(0);
      expect(Object.keys(run.report.per_task)).toEqual(["laptop"]);
    });

    it("is 2 for an invalid task set: an unknown key is named, and nothing starts", () => {
      const dir = project({ taskSet: { colour: "red" } });

      const run = harnessEval(dir);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("is not a valid task set");
      expect(run.stderr).toContain('Unrecognized key: "colour"');
      expect(run.requests).toEqual([]);
    });

    it.skipIf(onWindows)("is 2 for a fixture with a link in it that is absolute or leads out of the fixture, naming the link", () => {
      const absolute = project();
      symlinkSync(join(absolute, "fixtures", "laptop", "package.json"), join(absolute, "fixtures", "laptop", "alias.js"));
      const refusedAbsolute = harnessEval(absolute);
      expect(refusedAbsolute.status).toBe(2);
      expect(refusedAbsolute.stderr).toContain("fixtures/laptop/alias.js is a link with an absolute target");
      expect(refusedAbsolute.requests).toEqual([]);

      const leaving = project();
      symlinkSync("../phone/readme.md", join(leaving, "fixtures", "laptop", "other.md"));
      const refusedLeaving = harnessEval(leaving);
      expect(refusedLeaving.status).toBe(2);
      expect(refusedLeaving.stderr).toContain('fixtures/laptop/other.md is a link whose target ("../phone/readme.md") climbs out of the fixture');
      expect(refusedLeaving.requests).toEqual([]);
    });

    it("is 2 for a path that leaves the task set's folder", () => {
      const leaving = harnessEval(project({ tasks: [laptop({ workspace: "../elsewhere" })] }));

      expect(leaving.status).toBe(2);
      expect(leaving.stderr).toContain("workspace ../elsewhere leaves the task set's folder");
    });

    it("is 2 when an output scorer's node names no agent of the workflow, and when there is no workflow", () => {
      const noNode = harnessEval(project({ tasks: [laptop({ scorers: [{ name: "o", output: { contains: ["x"], node: "Judge" } }] })] }));
      expect(noNode.status).toBe(2);
      expect(noNode.stderr).toContain('task laptop, scorer o: node "Judge" is not an agent of the workflow');
      expect(noNode.requests).toEqual([]);

      const dir = project();
      writeFileSync(join(dir, "wf.harness.yaml"), "meta:\n  name: broken\n");
      const invalid = harnessEval(dir);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("is not a valid workflow");

      const none = project({ taskSet: { workflow: undefined } });
      const missingWorkflow = harnessEval(none);
      expect(missingWorkflow.status).toBe(2);
      expect(missingWorkflow.stderr).toContain("no workflow to run: pass --workflow");
    });

    it("is 2 for a --workflow that cannot be read", () => {
      const run = harnessEval(project(), [...approve, "--workflow", "no-such-workflow.harness.yaml"]);

      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/harness eval: cannot read .*no-such-workflow\.harness\.yaml/);
      expect(run.requests).toEqual([]);
    });

    it("is 2 for a workflow with a graph error, in harness eval's own name, and says what a bash agent may run", () => {
      const lone = project({ agents: [agent("Coder", "worker", ["bash"]), agent("Reviewer", "critic"), agent("Lonely", "worker")] });

      const run = harnessEval(lone);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain('warning: "Coder" can run shell commands (bash): only the commands passed with --allow-command run.');
      expect(run.stderr).toContain('harness eval: "Lonely" is not connected to any other node.');
      expect(run.requests).toEqual([]);
    });

    it("is 2 for an --out that is not empty, and takes one that is empty", () => {
      const dir = project();
      mkdirSync(out(dir));
      writeFileSync(join(out(dir), "old.txt"), "an earlier eval\n");

      const full = harnessEval(dir);
      expect(full.status).toBe(2);
      expect(full.stderr).toContain("is not empty");
      expect(readdirSync(out(dir))).toEqual(["old.txt"]);

      rmSync(join(out(dir), "old.txt"));
      expect(harnessEval(dir).status).toBe(0);
    });

    it("is 2 for an --out that is a file", () => {
      const dir = project();
      writeFileSync(out(dir), "not a folder\n");

      const run = harnessEval(dir);

      expect(run.status).toBe(2);
      expect(run.stderr).toContain("exists and is not a folder");
      expect(run.requests).toEqual([]);
    });

    describe("an --out, or a folder for the trials, that is inside what the trials copy: every trial would find the results of the ones before it", () => {
      const refused = (run: { status: number | null; stderr: string; requests: Request[] }, text: string) => {
        expect(run.status, run.stderr).toBe(2);
        expect(run.stderr).toContain(text);
        expect(run.requests).toEqual([]); // harness-core was never started
      };

      it("is 2 for an --out inside the workspace of a task that runs, and makes no folder there", () => {
        const dir = project();

        const run = harnessEval(dir, [...approve, "--out", join(dir, "fixtures", "laptop", "results")]);

        refused(run, "is inside the workspace of task laptop");
        expect(existsSync(join(dir, "fixtures", "laptop", "results"))).toBe(false);
      });

      it("is 2 for the default output folder when the current folder is inside such a workspace", () => {
        const dir = project();
        const here = join(dir, "fixtures", "laptop");

        const run = spawnSync(process.execPath, [cli, "eval", join(dir, "tasks.yaml"), "--core", fakeCore, ...approve], {
          cwd: here, encoding: "utf8", env: environment(dir), timeout: SPAWN_TIMEOUT_MS,
        });

        refused({ ...run, requests: requestsOf(dir) }, "(the default; --out puts it elsewhere) is inside the workspace of task laptop");
        expect(existsSync(join(here, ".harness"))).toBe(false);
      });

      it.skipIf(onWindows)("is 2 for an --out that reaches the workspace through a link", () => {
        const dir = project();
        symlinkSync(join(dir, "fixtures", "laptop"), join(dir, "shortcut"));

        const run = harnessEval(dir, [...approve, "--out", join(dir, "shortcut", "results")]);

        refused(run, "is inside the workspace of task laptop");
        expect(existsSync(join(dir, "fixtures", "laptop", "results"))).toBe(false);
      });

      /** The grader files of the scorer are a folder, which every trial gets a copy of. */
      const withGraderFolder = () => project({
        tasks: [laptop({ scorers: [{ name: "tests", command: "npm test --silent", inject: [{ from: "grader/suite", to: "test/suite" }] }] })],
        files: { "grader/suite/one.test.js": "// one\n" },
      });

      it("is 2 for an --out inside the grader files a scorer injects, which are copied into the trials as well", () => {
        const dir = withGraderFolder();

        const run = harnessEval(dir, [...approve, "--out", join(dir, "grader", "suite", "results")]);

        refused(run, "is inside the grader files of task laptop, scorer tests");
        expect(existsSync(join(dir, "grader", "suite", "results"))).toBe(false);
      });

      it.skipIf(onWindows)("is 2 when the folder for the trials (TMPDIR) is inside a workspace or the grader files", () => {
        const dir = withGraderFolder();

        refused(harnessEval(dir, approve, { TMPDIR: join(dir, "fixtures", "laptop") }), "is inside the workspace of task laptop");
        refused(harnessEval(dir, approve, { TMPDIR: join(dir, "grader", "suite") }), "is inside the grader files of task laptop");
      });

      it("takes an --out beside the grader files, in the same folder", () => {
        const dir = withGraderFolder();

        const run = harnessEval(dir, [...approve, "-k", "1", "--out", join(dir, "grader", "results")]);

        expect(run.status, run.stderr).toBe(0);
        expect(reportOf(dir, join(dir, "grader", "results"))).toMatchObject({ status: "done" });
      });

      it("looks only at the tasks that run: an --out inside the workspace of a task that does not is fine", () => {
        const dir = project({ tasks: [laptop(), phone({ split: "heldout" })], taskSet: { trials: 1 } });
        const results = join(dir, "fixtures", "phone", "results");

        const run = harnessEval(dir, [...approve, "--out", results]);

        expect(run.status, run.stderr).toBe(0);
        expect(reportOf(dir, results)).toMatchObject({ status: "done" });
      });
    });

    describe("when something nobody planned for happens: never exit code 1, which says the score was below --min-score", () => {
      /** The environment of a run in which a scorer command can reach the output folder, and the trials' folders are the test's own. */
      const sabotage = (dir: string) => {
        const tmp = join(dir, "trial-folders");
        mkdirSync(tmp);
        return { tmp, env: { OUT_DIR: out(dir), TMPDIR: tmp } };
      };

      it.skipIf(onWindows)("is 3, with the reason, when the folder for the trials cannot be made, and leaves no output folder", () => {
        const dir = project();

        const run = harnessEval(dir, approve, { TMPDIR: join(dir, "no-such-folder") });

        expect(run.status).toBe(3);
        expect(run.stderr).toContain(`harness eval: cannot make a folder for the trials in ${join(dir, "no-such-folder")}: ENOENT`);
        expect(run.stderr).not.toContain("unexpected error");
        expect(existsSync(out(dir))).toBe(false);
      });

      it.skipIf(onWindows)("is 3, and the report says error, when what a trial leaves cannot be kept: the eval broke, no other trial starts, nothing is left in the trials' folder", () => {
        const wreck = 'rm -rf "$OUT_DIR/trials" && touch "$OUT_DIR/trials"'; // a file where the trials' results go
        const dir = project({
          tasks: [
            { id: "first", task: "t", scorers: [{ name: "wreck", command: wreck }] },
            { id: "never", task: "t", scorers: [{ name: "late", output: { contains: ["SUP-A"] } }] },
          ],
          taskSet: { trials: 1 },
          commands: { [wreck]: { run: true } },
        });
        const { tmp, env } = sabotage(dir);

        const run = harnessEval(dir, ["--allow-scorer", wreck, "--min-score", "0.5"], env);

        expect(run.status, run.stderr).toBe(3); // not 1: nothing here says the score is below 0.5
        expect(run.stderr).toMatch(/harness eval: the eval broke: ENOTDIR/);
        expect(run.report).toMatchObject({ status: "error", error: expect.stringContaining("the eval broke"), n_done: 0 });
        expect(run.report.per_task.never.trials).toEqual([]);
        expect(readdirSync(tmp)).toEqual([]); // the trial's folder was deleted all the same
      });

      it.skipIf(onWindows)("is 3 when the report cannot be written after a trial, and still prints the results of what ran", () => {
        const wreck = 'rm -f "$OUT_DIR/report.json" && mkdir "$OUT_DIR/report.json" && touch "$OUT_DIR/report.json/x"'; // a folder where the report goes
        const dir = project({
          tasks: [{ id: "first", task: "t", scorers: [{ name: "wreck", command: wreck }] }],
          taskSet: { trials: 1 },
          commands: { [wreck]: { run: true } },
        });
        const { tmp, env } = sabotage(dir);

        const run = harnessEval(dir, ["--allow-scorer", wreck], env);

        expect(run.status, run.stderr).toBe(3);
        expect(run.stderr).toMatch(/harness eval: cannot write .*report\.json: /);
        expect(run.stdout).toContain("[1/1] first t0: reward 1.00 (wreck ✓)");
        expect(run.stdout).toContain("S 1.000 · C n/a · 1 of 1 trials, 0 missing");
        expect(readdirSync(out(dir)).sort()).toEqual(["report.json", "trials"]); // and no report.json.tmp
        expect(readdirSync(tmp)).toEqual([]);
      });
    });

    it("is 3 and says to build the bundle when cli/dist/harness-run.mjs is not there", () => {
      const bare = mkdtempSync(join(root, "outputs", "eval-bare-"));
      scratch.push(bare);
      mkdirSync(join(bare, "cli"));
      copyFileSync(join(root, "cli", "harness.mjs"), join(bare, "cli", "harness.mjs"));

      const run = spawnSync(process.execPath, [join(bare, "cli", "harness.mjs"), "eval", "tasks.yaml"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("harness eval: build it first with npm run build:cli");
    });

    it("is 3, never 1, when the bundle cannot be loaded: a broken build is not a score below --min-score", () => {
      const broken = mkdtempSync(join(root, "outputs", "eval-broken-"));
      scratch.push(broken);
      mkdirSync(join(broken, "cli", "dist"), { recursive: true });
      copyFileSync(join(root, "cli", "harness.mjs"), join(broken, "cli", "harness.mjs"));
      writeFileSync(join(broken, "cli", "dist", "harness-run.mjs"), 'throw new Error("the bundle is broken");\n');

      const run = spawnSync(process.execPath, [join(broken, "cli", "harness.mjs"), "eval", "tasks.yaml", "--min-score", "0.5"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });

      expect(run.status).toBe(3);
      expect(run.stderr).toContain("harness eval: the bundle is broken");
    });

    it("is 2 for bad usage, and prints the usage with --help", () => {
      const dir = project();
      expect(harnessEval(dir, ["--trials", "0"]).status).toBe(2);
      expect(harnessEval(dir, ["--bogus"]).stderr).toContain("Unknown option: --bogus");

      const help = spawnSync(process.execPath, [cli, "eval", "--help"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: harness eval <tasks.yaml> [options]");
    });
  });

  describe("choosing what runs", () => {
    const tasks = [laptop(), phone(), phone({ id: "holdout", split: "heldout" }), phone({ id: "quick", smoke: true, split: "heldout" })];

    it("runs the evolve split by default, the others on request, and -k and --only narrow it", () => {
      const dir = project({ tasks });
      const ids = (args: string[]) => {
        const run = harnessEval(dir, [...approve, "-k", "1", ...args]);
        expect(run.status, run.stderr).toBe(0);
        const found = Object.keys(run.report.per_task);
        rmSync(out(dir), { recursive: true, force: true });
        return found;
      };

      expect(ids([])).toEqual(["laptop", "phone"]);
      expect(ids(["--split", "heldout"])).toEqual(["holdout", "quick"]);
      expect(ids(["--split", "smoke"])).toEqual(["quick"]);
      expect(ids(["--split", "all"])).toEqual(["laptop", "phone", "holdout", "quick"]);
      expect(ids(["--only", "phone"])).toEqual(["phone"]);
    });

    it("takes the number of trials from -k, then --trials, then the task set", () => {
      const dir = project();
      expect(harnessEval(dir, [...approve, "-k", "1"]).report).toMatchObject({ k: 1, n_expected: 2 });
      rmSync(out(dir), { recursive: true });
      expect(harnessEval(dir, [...approve, "--trials", "3"]).report).toMatchObject({ k: 3, n_expected: 6 });
      rmSync(out(dir), { recursive: true });
      expect(harnessEval(dir).report).toMatchObject({ k: 2, n_expected: 4 });
    });

    it("is 2 for an --only that names no task, or one outside the split", () => {
      const dir = project({ tasks });

      const unknown = harnessEval(dir, [...approve, "--only", "nope"]);
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toContain("--only nope: the task set has no such task (its tasks: laptop, phone, holdout, quick)");
      const outside = harnessEval(dir, [...approve, "--only", "holdout"]);
      expect(outside.status).toBe(2);
      expect(outside.stderr).toContain("use --split heldout (or --split all)");
    });

    it("runs the workflow --workflow names instead of the task set's, and reports that one", () => {
      const dir = project();
      writeFileSync(join(dir, "other.harness.yaml"), stringify({
        meta: { name: "Other Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
        agents: [agent("Coder", "worker"), agent("Reviewer", "critic")],
        connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
        executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
        nodePositions: {},
      }));

      // A path given on the command line is relative to the current folder, which is `dir` here.
      const run = harnessEval(dir, [...approve, "-k", "1", "--workflow", "other.harness.yaml"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report.workflow).toMatchObject({ name: "Other Review", path: join(dir, "other.harness.yaml") });
      expect(run.report.workflow.hash).toBe(sha256(readIn(dir, "other.harness.yaml")));
      expect(jsonIn(out(dir), "trials", "laptop", "t0", "run.json").workflow).toMatchObject({ name: "Other Review" });
    });

    it("can run trials in parallel, with the same report", () => {
      const dir = project();

      const run = harnessEval(dir, [...approve, "--max-parallel-trials", "3"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report).toMatchObject({ status: "done", n_done: 4, missing: 0 });
      expect(run.report.S).toBeCloseTo(7 / 9, 9);
      expect(run.report.per_task.laptop.trials.map((t: Report) => t.trial)).toEqual([0, 1]);
      expect(run.report.per_task.phone.rewards).toEqual([1, 1]);
    });
  });

  describe("where things go", () => {
    it("prints the report alone on stdout with --json, and the progress on stderr", () => {
      const dir = project();

      const run = harnessEval(dir, [...approve, "--json"]);

      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(run.report); // the file's own text
      expect(run.stdout).toBe(readIn(out(dir), "report.json").trimEnd() + "\n");
      expect(run.stderr).toMatch(/\[1\/4\] laptop t0: reward 0\.67/);
      expect(run.stderr).toContain("S 0.778 · C n/a");
      expect(run.stderr).toContain(`Report: ${join(out(dir), "report.json")}`);
    });

    it("keeps each trial's folder with --keep-workspaces, and deletes it otherwise", () => {
      const options = { taskSet: { trials: 1 }, tasks: [phone()] };
      /** Where the engine was told to work: the run record is saved there. */
      const workspaceOf = (run: { requests: Request[] }) =>
        String(run.requests.find((r) => r.cmd === "write_workspace_file")?.args.workspacePath);

      const kept = harnessEval(project(options), [...approve, "--keep-workspaces"]);
      const dropped = harnessEval(project(options));

      expect(kept.status, kept.stderr).toBe(0);
      const where = /Trial folders kept in (.+)/.exec(kept.stdout)?.[1] ?? "";
      scratch.push(where);
      expect(workspaceOf(kept)).toBe(join(where, "phone-t0"));
      expect(readIn(where, "phone-t0", "readme.md")).toBe("# phone\n"); // a copy of the fixture, with the run's work in it
      expect(readdirSync(join(where, "phone-t0", ".harness", "runs"))).toHaveLength(1);

      expect(dropped.status, dropped.stderr).toBe(0);
      expect(dropped.stdout).not.toContain("Trial folders kept");
      expect(workspaceOf(dropped)).toMatch(/harness-eval-[^/\\]+[/\\]phone-t0$/);
      expect(existsSync(workspaceOf(dropped))).toBe(false);
      expect(existsSync(dirname(workspaceOf(dropped)))).toBe(false); // the folder of all the trials went too
    });

    it("keeps the trial's folder as it is after scoring: what a command scorer restored is back, and its grader files are in", () => {
      const dir = project({
        tasks: [laptop({ weight: 1, scorers: [tests] })],
        taskSet: { trials: 1 },
        replies: { Coder: [write("package.json", '{"scripts":{"test":"echo ok"}}\n'), write("test/hidden.test.js", "// the agent's own\n"), "done"] },
      });

      const run = harnessEval(dir, [...approve, "--keep-workspaces"]);

      expect(run.status, run.stderr).toBe(0);
      const where = /Trial folders kept in (.+)/.exec(run.stdout)?.[1] ?? "";
      scratch.push(where);
      expect(readIn(where, "laptop-t0", "package.json")).toBe(PRISTINE_PACKAGE);
      expect(readIn(where, "laptop-t0", "test", "hidden.test.js")).toBe(HIDDEN_TEST);
    });

    it("shows an error that has line breaks in it on one line of progress, and keeps its text whole in the report and the trial's files", () => {
      const dir = project({ scenario: { healthFails: true, healthPull: "ollama pull qwen2.5-coder:7b" } });

      const run = harnessEval(dir);

      expect(run.status).toBe(3);
      expect(run.stdout.split("\n")[0]).toMatch(/^\[1\/4\] laptop t0: missing \(Ollama is not running Run: ollama pull qwen2\.5-coder:7b\) · run /);
      const whole = "Ollama is not running\nRun: ollama pull qwen2.5-coder:7b";
      expect(run.report.per_task.laptop.trials[0].error).toBe(whole);
      expect(jsonIn(out(dir), "trials", "laptop", "t0", "outcome.json").error).toBe(whole);
    });

    it("writes to .harness/evals/<evalId>/ in the current folder when --out is not given", () => {
      const dir = project({ taskSet: { trials: 1 }, tasks: [phone()] });

      const run = spawnSync(process.execPath, [cli, "eval", join(dir, "tasks.yaml"), "--core", fakeCore], {
        cwd: dir, encoding: "utf8", env: environment(dir), timeout: SPAWN_TIMEOUT_MS,
      });

      expect(run.status, run.stderr).toBe(0);
      const [evalId] = readdirSync(join(dir, ".harness", "evals"));
      expect(evalId).toMatch(/^eval-\d+$/);
      expect(reportOf(dir, join(dir, ".harness", "evals", evalId))).toMatchObject({ evalId, status: "done" });
      expect(run.stdout).toContain(`Report: ${join(dir, ".harness", "evals", evalId, "report.json")}`);
    });

    it("says a warning of the runs once on stderr, though every trial has it in its log", () => {
      const dir = project({ taskSet: { trials: 2 }, tasks: [phone({ task: "x".repeat(10_000) })] });

      const run = harnessEval(dir, [...approve, "--num-ctx", "2048"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr.split("\n").filter((line) => line.startsWith("warning: Coder:"))).toHaveLength(1);
      expect(run.stdout).not.toContain("warning:");
      for (const t of ["t0", "t1"]) expect(readIn(out(dir), "trials", "phone", t, "run.log")).toContain("warning: Coder:");
    });
  });

  describe("commands", () => {
    const bash = '<tool_call>{"name":"bash","args":{"command":"npm test --silent"}}</tool_call>';

    it("does not let an agent run a command that was approved for the scorers only; --allow-command does", () => {
      const options = { replies: { Coder: [bash, "tested"] }, taskSet: { trials: 1 }, tasks: [laptop()] };
      const dir = project(options);

      const denied = harnessEval(dir);

      expect(denied.status, denied.stderr).toBe(0);
      expect(readIn(out(dir), "trials", "laptop", "t0", "run.log")).toContain("$ Coder: command denied (not in --allow-command): npm test --silent");
      // The only execute_command of the eval is the scorer's own, under an id of the eval's.
      const ran = denied.requests.filter((r) => r.cmd === "execute_command");
      expect(ran).toHaveLength(1);
      expect(String(ran[0].args.commandId)).toMatch(/^eval-\d+-laptop-t0-score-0$/);

      const other = project(options);
      const allowed = harnessEval(other, [...approve, "--allow-command", "npm test --silent"]);
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(readIn(out(other), "trials", "laptop", "t0", "run.log")).toMatch(/\$ Coder ran: npm test --silent \(allowed by --allow-command; exit 1/);
      expect(allowed.requests.filter((r) => r.cmd === "execute_command")).toHaveLength(2); // the agent's, then the scorer's
    });

    it.skipIf(onWindows)("copies a fixture's relative links as they are, and a scorer command can run through one: an npm install's node_modules/.bin", () => {
      const tool = "node_modules/.bin/greet";
      const dir = project({
        tasks: [laptop({ weight: 1, scorers: [{ name: "run-the-tool", command: tool }] })],
        taskSet: { trials: 1 },
        files: { "fixtures/laptop/node_modules/greet-pkg/bin/greet.sh": '#!/bin/sh\necho "greetings from $(basename "$(pwd -P)")"\n' },
        commands: { [tool]: { run: true } }, // really runs, in the trial's folder
      });
      chmodSync(join(dir, "fixtures/laptop/node_modules/greet-pkg/bin/greet.sh"), 0o755);
      mkdirSync(join(dir, "fixtures/laptop/node_modules/.bin"));
      symlinkSync("../greet-pkg/bin/greet.sh", join(dir, "fixtures/laptop/node_modules/.bin/greet"));

      const run = harnessEval(dir, ["--allow-scorer", tool, "--keep-workspaces"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.report).toMatchObject({ status: "done", S: 1, missing: 0 });
      expect(jsonIn(out(dir), "trials", "laptop", "t0", "scorers.json")[0])
        .toMatchObject({ name: "run-the-tool", passed: true, exitCode: 0, stdout: "greetings from laptop-t0\n" }); // the trial's folder, not the fixture
      const where = /Trial folders kept in (.+)/.exec(run.stdout)?.[1] ?? "";
      scratch.push(where);
      expect(readlinkSync(join(where, "laptop-t0", "node_modules", ".bin", "greet"))).toBe("../greet-pkg/bin/greet.sh"); // a link, as it was
    });

    it.skipIf(onWindows)("keeps a link an agent retargets out of the trial's folder from taking a restore with it: the trial is missing, and nothing outside is deleted", () => {
      const outside = (dir: string) => join(dir, "precious");
      const retarget = 'ln -sfn "$PRECIOUS" deps';
      const dir = project({
        tasks: [laptop({ weight: 1, scorers: [{ name: "tests", command: "npm test --silent", restore: ["deps/index.js"] }] })],
        taskSet: { trials: 1 },
        files: { "fixtures/laptop/vendor/lib/index.js": "// lib\n", "precious/index.js": "// precious\n" },
        replies: { Coder: [`<tool_call>${JSON.stringify({ name: "bash", args: { command: retarget } })}</tool_call>`, "done"] },
        commands: { [retarget]: { run: true }, "npm test --silent": { exitCode: 0 } },
      });
      symlinkSync("vendor/lib", join(dir, "fixtures/laptop/deps")); // a link of the fixture: allowed, copied as it is

      // The agent runs a command that points the link at a folder outside the trial.
      const run = harnessEval(dir, [...approve, "--allow-command", retarget], { PRECIOUS: outside(dir) });

      expect(run.status, run.stderr).toBe(0);
      expect(run.report.per_task.laptop.trials[0]).toMatchObject({
        missing: true, error: expect.stringContaining("scorer tests: deps/index.js leads out of the trial's folder through a link"),
      });
      expect(readIn(dir, "precious", "index.js")).toBe("// precious\n");
      expect(run.requests.filter((r) => r.cmd === "execute_command" && r.args.command === "npm test --silent")).toEqual([]); // the scorer's command did not run
    });

    it("runs a scorer command in the trial's folder, with consent and its time limit", () => {
      const dir = project({ taskSet: { trials: 1 }, tasks: [laptop({ scorers: [{ ...tests, timeoutSecs: 90 }] })] });

      const run = harnessEval(dir);

      expect(run.status, run.stderr).toBe(0);
      const call = run.requests.find((r) => r.cmd === "execute_command");
      expect(call?.args).toMatchObject({ command: "npm test --silent", consentGranted: true, timeoutSecs: 90 });
      expect(String(call?.args.workspacePath)).toMatch(/harness-eval-[^/\\]+[/\\]laptop-t0$/);
    });
  });
});
