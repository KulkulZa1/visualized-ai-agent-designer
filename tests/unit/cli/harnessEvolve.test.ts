// @vitest-environment node
/**
 * harness evolve end to end: the built bundle (npm run build:cli) through cli/harness.mjs, against the fake harness-core with canned
 * model replies. Evolve starts this CLI again for every evaluation and every proposer or critic run, so the whole path runs: the
 * checks, the children, the loop and the files. The bundle is built into a private copy of the CLI under outputs/, as
 * harnessEval.test.ts does (two builds that empty one folder would race). The copy of harness.mjs there also writes the arguments of
 * each of its runs to $ARGV_LOG, so that the tests can see what every child was started with.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { defToGraph } from "@/engine/workflowGraph";
import { checkWorkflowGraph, loadWorkflow } from "@/cli/shared";

const root = resolve(__dirname, "../../..");
/** A run of the CLI that takes longer than this is hung: a synchronous spawn would block the test for good. */
const SPAWN_TIMEOUT_MS = 100_000;
const fakeCore = join(root, "tests", "fixtures", "fake-core.mjs");
const PROPOSER = join(root, "examples", "evolve", "proposer.harness.yaml");
const CRITIC = join(root, "examples", "evolve", "critic.harness.yaml");
let privateCli = "";
let cli = "";

/** Runs first in the private copy of harness.mjs (after the shebang): every run of the CLI, evolve and each child, logs its arguments. */
const SPY = [
  'import { appendFileSync as spyAppend } from "node:fs";',
  'if (process.env.ARGV_LOG) spyAppend(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
].join(" ");

beforeAll(() => {
  mkdirSync(join(root, "outputs"), { recursive: true });
  privateCli = mkdtempSync(join(root, "outputs", "evolve-cli-"));
  mkdirSync(join(privateCli, "cli", "dist"), { recursive: true });
  const [shebang, ...rest] = readFileSync(join(root, "cli", "harness.mjs"), "utf8").split("\n");
  writeFileSync(join(privateCli, "cli", "harness.mjs"), [shebang, SPY, ...rest].join("\n"));
  // The proposer and the critic that ship with the CLI are found next to it: examples/evolve/ beside cli/, as in the repository.
  mkdirSync(join(privateCli, "examples", "evolve"), { recursive: true });
  for (const file of [PROPOSER, CRITIC]) copyFileSync(file, join(privateCli, "examples", "evolve", basename(file)));
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

// ── The project: a one-agent workflow, a task set and the fake core's scenario ───────────────────────────────────────

const WRITER_PROMPT = "Write an answer.";
const writer = () => ({
  name: "Writer", role: "worker", model: "qwen2.5-coder:7b", temperature: 0.5, maxTokens: 512, maxSteps: 3, timeoutSeconds: 60,
  promptSource: { type: "inline", content: WRITER_PROMPT }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
});
/** What the fake policy answers well to: the word "excellent" in the answer, which its prompt must ask for ("be excellent"). */
const quality = { name: "quality", output: { matches: ["\\bexcellent\\b"] } };
const tasks = () => [
  { id: "essay-a", smoke: true, task: "Write about rivers.", scorers: [quality] },
  { id: "essay-b", task: "Write about mountains.", scorers: [quality] },
  { id: "essay-held", split: "heldout", task: "Write about deserts.", scorers: [quality] },
];

const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
/** The proposer's one edit: ask the writer to be excellent. */
const proposal = {
  summary: "ask for excellence",
  edits: [{
    id: "C1", component: "prompt", hypothesis: "a prompt that asks for it makes the model write its best", targets_mode: "plain answers",
    predicted_affected: ["essay-a", "essay-b"], retroactive_check: "both failing tasks would have passed; nothing that passes can break",
    ops: [{ op: "replace_text", agent: "Writer", field: "prompt", old: WRITER_PROMPT, new: `${WRITER_PROMPT} Always be excellent.` }],
  }],
};
const accept = fenced({ verdict: "accept", reasons: [], risk_notes: [] });

interface Options {
  /** More keys of the task-set file (trials, ...). */
  taskSet?: Record<string, unknown>;
  agents?: unknown[];
  connections?: unknown[];
  tasks?: unknown[];
  replies?: Record<string, string[]>;
  files?: Record<string, string>;
}

/** A folder with the workflow, the task set (essays.tasks.yaml), their fixtures and the fake core's scenario. */
function project(options: Options = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-evolve-e2e-"));
  scratch.push(dir);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("wf.harness.yaml", stringify({
    meta: { name: "Essays", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: options.agents ?? [writer()],
    connections: options.connections ?? [],
    executionSettings: { maxParallel: 1, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  }));
  put("essays.tasks.yaml", stringify({ version: 1, name: "essays", workflow: "wf.harness.yaml", tasks: options.tasks ?? tasks(), ...options.taskSet }));
  for (const [path, text] of Object.entries(options.files ?? {})) put(path, text);
  put("scenario.json", JSON.stringify({
    replies: {
      Writer: ["a plain answer"], "Harness Engineer": [fenced(proposal)], "Harness Critic": [accept], ...options.replies,
    },
    when: { Writer: [{ contains: "be excellent", text: "an excellent answer" }] },
  }));
  return dir;
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────────────────────────────

const environment = (dir: string, env: Record<string, string> = {}) => ({
  ...process.env, FAKE_CORE_SCENARIO: join(dir, "scenario.json"), FAKE_CORE_LOG: join(dir, "core.log"), ARGV_LOG: join(dir, "argv.log"),
  HARNESS_CORE: fakeCore, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "", HARNESS_OLLAMA_NUM_CTX: "", HARNESS_REQUEST_TIMEOUT_SECS: "",
  HARNESS_CUSTOM_BASE_URL: "", HARNESS_CUSTOM_MODEL: "", HARNESS_CUSTOM_API_KEY: "", ...env,
});
const out = (dir: string) => join(dir, "out");
/** One round and one candidate; the noise band given, so there is no calibration. A later flag wins. */
const MODEL_OPTIONS = ["--provider", "ollama", "--model", "fake", "--rounds", "1", "--candidates", "1", "--delta", "0.1"];
const BASE_OPTIONS = [...MODEL_OPTIONS, "--proposer", PROPOSER, "--critic", CRITIC];
const OPTIONS = [...BASE_OPTIONS, "-k", "1"];

/** `harness evolve <dir>/essays.tasks.yaml`, with the fake core; `args` follow the usual options and `--out <dir>/out`. */
function evolve(dir: string, args: string[] = [], env: Record<string, string> = {}, folder: string[] = ["--out", out(dir)], options = OPTIONS) {
  return spawnSync(process.execPath, [cli, "evolve", join(dir, "essays.tasks.yaml"), ...options, ...folder, ...args], {
    cwd: dir, encoding: "utf8", env: environment(dir, env), timeout: SPAWN_TIMEOUT_MS,
  });
}
const run = (dir: string, argv: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...argv], {
  cwd: dir, encoding: "utf8", env: environment(dir, env), timeout: SPAWN_TIMEOUT_MS,
});

/** The arguments of every run of the CLI so far, evolve first and then each child, in the order they started. */
const argvLog = (dir: string): string[][] => (existsSync(join(dir, "argv.log"))
  ? readFileSync(join(dir, "argv.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);
const children = (dir: string, command: "eval" | "run") => argvLog(dir).filter((argv) => argv[0] === command);
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const has = (argv: string[], flag: string, value: string) => argv.some((arg, i) => arg === flag && argv[i + 1] === value);
const coreRequests = (dir: string) => (existsSync(join(dir, "core.log")) ? readFileSync(join(dir, "core.log"), "utf8").split("\n").filter(Boolean).length : 0);

const readIn = (dir: string, ...path: string[]) => readFileSync(join(dir, ...path), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonIn = (dir: string, ...path: string[]): any => JSON.parse(readIn(dir, ...path));
const historyIn = (dir: string) => readIn(out(dir), "history.jsonl").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

// ── The shipped workflows ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the proposer and the critic that ship with harness evolve", () => {
  const load = (file: string) => {
    const loaded = loadWorkflow(file);
    if ("error" in loaded) throw new Error(loaded.error);
    const warnings: string[] = [];
    expect(checkWorkflowGraph(defToGraph(loaded.def), "test", (line) => warnings.push(line)), warnings.join("\n")).toBe(true);
    expect(warnings).toEqual([]);
    expect(loaded.def.agents).toHaveLength(1);
    expect(loaded.def.connections).toEqual([]);
    return loaded.def.agents[0];
  };
  const promptOf = (agent: ReturnType<typeof load>) => (agent.promptSource.type === "inline" ? agent.promptSource.content : "");

  it("has a read-only Harness Engineer, whose prompt keeps the operations to the brief", () => {
    const agent = load(PROPOSER);
    expect(agent).toMatchObject({ name: "Harness Engineer", role: "worker", tools: ["read_file", "list_files", "grep"], maxTokens: 4096, maxSteps: 12, timeoutSeconds: 1800 });
    expect(agent.model).toBe("qwen2.5-coder:7b");
    const prompt = promptOf(agent);
    for (const rule of ["DIFFERENT model", "ITS side", "ONLY thing you can change is the workflow file", "NO abort", "ONE independent", "RESERVED EXPLORATION SLOT", "Pruning is legitimate",
      "REAL task ids", "No task-specific names", "runs unattended", "FINAL reply"]) expect(prompt, rule).toContain(rule);
    // The operation table is the brief's (src/evolve/brief.ts), so that it cannot fall out of step with the code.
    for (const op of ["replace_text", "set_text", "set_role", "add_tool", "remove_tool", "add_memory_read", "add_memory_write", "add_agent", "remove_agent", "disconnect"]) {
      expect(prompt, op).not.toContain(op);
    }
  });

  it("has a Harness Critic with no tools, whose prompt has the six rules to reject by", () => {
    const agent = load(CRITIC);
    expect(agent).toMatchObject({ name: "Harness Critic", role: "critic", tools: [], maxTokens: 2048, maxSteps: 1, timeoutSeconds: 900 });
    const prompt = promptOf(agent);
    for (const rule of ["LEAKAGE / TASK-SPECIALIZATION", "DEGENERATE", "GRADER GAMING", "UNDECLARED BUNDLING", "RUNTIME MEMORY LEAKAGE", "UNBOUNDED WORK",
      "Litmus test", "Runtime correctness is NOT your job", '"verdict": "accept" | "reject"']) expect(prompt, rule).toContain(rule);
  });
});

// ── The command ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Each test runs the CLI a few times in a row, synchronously: under a full parallel suite that can pass vitest's 5 s default.
describe("harness evolve", { timeout: 120_000 }, () => {
  describe("a run, and a run again in its folder", () => {
    let dir = "";
    let first: ReturnType<typeof evolve>;
    let userWorkflow = "";
    beforeAll(() => {
      dir = project();
      userWorkflow = readIn(dir, "wf.harness.yaml");
      first = evolve(dir, ["--proposer-model", "prop-model", "--critic-model", "critic-model", "--allow-scorer", "node check.js", "--allow-command", "npm test"]);
    }, 120_000);

    it("accepts the proposer's edit, saves it as the incumbent and checks it on the held-out task", () => {
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain(`Run folder: ${out(dir)}`);
      expect(first.stdout).toContain("ACCEPTED");
      expect(first.stdout).toContain("round 0: accepted A; S 1.000 C n/a, S* 1.000");
      expect(first.stdout).toContain("held-out: base S 0.000 C n/a; final S 1.000 C n/a");
      expect(first.stdout).toContain("final: S 1.000 C n/a (reached after 1 round)");
      expect(first.stdout).toContain(`result: ${join(out(dir), "incumbent.harness.yaml")} — to use it, copy it over `);

      const frontier = jsonIn(out(dir), "frontier.json");
      expect(frontier.trajectory.map((entry: { S: number }) => entry.S)).toEqual([0, 1]);
      expect(frontier).toMatchObject({
        pins: { provider: { llmProvider: "ollama", baseUrl: "", model: "fake", numCtx: 16384 }, k: 1, config: { T: 1, m: 1, k: 1, delta: 0.1 } },
        incumbent: { t: 1, S: 1, variant: "A" }, base: { S: 0 }, heldout: { base: { S: 0 }, final: { S: 1 } },
      });
      expect(readIn(out(dir), "incumbent.harness.yaml")).toContain("Write an answer. Always be excellent.");
      expect(readIn(out(dir), "base.harness.yaml")).not.toContain("be excellent");
      expect(readIn(dir, "wf.harness.yaml")).toBe(userWorkflow); // the user's file is never written
      expect(historyIn(dir).map((record) => record.outcome)).toEqual(["BASELINE", "ACCEPTED"]);
      expect(existsSync(join(out(dir), "evolve.lock"))).toBe(false);
      expect(readIn(out(dir), "r0", "A", "diff.txt")).toContain("be excellent");
    });

    it("shows each evaluation's progress indented, keeps every child's output in a log, and shows nothing of the proposer's and the critic's runs", () => {
      expect(first.stdout).toMatch(/^ {4}\[1\/2\] essay-a t0: reward 0\.00 \(quality ✗\)/m); // the baseline: both tasks fail
      expect(first.stdout).toMatch(/^ {4}\[2\/2\] essay-b t0: reward 1\.00 \(quality ✓\)/m); // the candidate: both tasks pass
      expect(first.stdout).not.toContain("Harness Engineer started");
      expect(first.stdout).not.toContain("Harness Critic started");
      expect(readIn(out(dir), "base.log")).toMatch(/^\[1\/2\] essay-a t0: reward 0\.00/m); // as the eval wrote it: not indented
      expect(readIn(out(dir), "r0", "A", "a0", "proposer.log")).toContain("▶ Harness Engineer started");
      expect(readIn(out(dir), "r0", "A", "a0", "critic-0.log")).toContain("▶ Harness Critic started");
      // Each run saved its record in its own folder: where the loop reads the output from.
      const runs = join(out(dir), "r0", "A", "a0", "proposer", ".harness", "runs");
      expect(readdirSync(runs)).toHaveLength(1);
      expect(jsonIn(runs, readdirSync(runs)[0], "run.json").nodes["agent-0"]).toMatchObject({ agent: "Harness Engineer", status: "done" });
    });

    it("starts this CLI for every measurement and run, with the options, the approvals and the models where they belong", () => {
      const log = argvLog(dir);
      expect(log[0][0]).toBe("evolve");
      const evals = children(dir, "eval");
      // base-smoke, base, A's smoke check, A's evaluation, then the held-out base and final.
      expect(evals.map((argv) => valueOf(argv, "--split"))).toEqual(["smoke", "evolve", "smoke", "evolve", "heldout", "heldout"]);
      expect(evals.map((argv) => valueOf(argv, "-k"))).toEqual(["1", "1", "1", "1", "1", "1"]);
      for (const argv of evals) {
        expect(argv[1]).toBe(join(dir, "essays.tasks.yaml"));
        expect(has(argv, "--allow-scorer", "node check.js"), argv.join(" ")).toBe(true);
        expect(has(argv, "--allow-command", "npm test"), argv.join(" ")).toBe(true);
        expect(has(argv, "--provider", "ollama")).toBe(true);
        expect(has(argv, "--model", "fake")).toBe(true); // the evaluated workflow's model, not the proposer's
      }
      expect(valueOf(evals[1], "--workflow")).toBe(join(out(dir), "base.harness.yaml"));
      expect(valueOf(evals[3], "--workflow")).toBe(join(out(dir), "r0", "A", "candidate.harness.yaml"));
      expect(valueOf(evals[3], "--out")).toBe(join(out(dir), "r0", "A", "eval"));

      const runs = children(dir, "run");
      expect(runs).toHaveLength(2);
      expect(runs[0][1]).toBe(PROPOSER);
      expect(runs[1][1]).toBe(CRITIC);
      expect(has(runs[0], "--model", "prop-model")).toBe(true);
      expect(has(runs[1], "--model", "critic-model")).toBe(true);
      expect(valueOf(runs[0], "--task-file")).toBe(join(out(dir), "r0", "A", "a0", "proposer", "brief.md"));
      expect(valueOf(runs[0], "--workspace")).toBe(join(out(dir), "r0", "A", "a0", "proposer"));
      for (const argv of runs) {
        expect(argv, "no approved command for the proposer or the critic").not.toContain("--allow-command");
        expect(argv).not.toContain("--allow-scorer");
        expect(has(argv, "--provider", "ollama")).toBe(true);
      }
    });

    it("resumes as settled when it is run again: the summary again, and no child, no evaluation, no model call", () => {
      const before = { argv: argvLog(dir).length, core: coreRequests(dir), top: readdirSync(out(dir)).sort(), r0: readdirSync(join(out(dir), "r0", "A")).sort() };

      const again = evolve(dir, ["--proposer-model", "prop-model", "--critic-model", "critic-model", "--allow-scorer", "node check.js", "--allow-command", "npm test"]);

      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toContain("summary:");
      expect(again.stdout).toContain("final: S 1.000 C n/a (reached after 1 round)");
      expect(again.stdout).not.toMatch(/measuring|baseline:/);
      expect(argvLog(dir)).toHaveLength(before.argv + 1); // evolve itself
      expect(coreRequests(dir)).toBe(before.core);
      expect(readdirSync(out(dir)).sort()).toEqual(before.top);
      expect(readdirSync(join(out(dir), "r0", "A")).sort()).toEqual(before.r0);
    });

    it("is 2 when the model changed since the run began, naming it, and starts nothing", () => {
      const before = { argv: argvLog(dir).length, frontier: readIn(out(dir), "frontier.json") };

      const changed = evolve(dir, ["--model", "another-model"]);

      expect(changed.status).toBe(2);
      expect(changed.stderr).toContain("harness evolve: this folder holds a run with different settings: model (fake → another-model); use a new --out");
      expect(argvLog(dir)).toHaveLength(before.argv + 1);
      expect(readIn(out(dir), "frontier.json")).toBe(before.frontier);
      expect(existsSync(join(out(dir), "evolve.lock"))).toBe(false); // given up even when the run is refused
    });
  });

  // (child.kill("SIGINT") ends the process on Windows: there is no Ctrl+C to send to it.)
  it.skipIf(process.platform === "win32")("stops on Ctrl+C with exit 130 once the step in progress is over, gives up the lock, and a run again goes on from what is settled", async () => {
    const dir = project();
    // Only this process gets the signal, not its children (a terminal's Ctrl+C reaches them too): the eval in progress runs to its end.
    const child = spawn(process.execPath, [cli, "evolve", join(dir, "essays.tasks.yaml"), ...OPTIONS, "--out", out(dir)], {
      cwd: dir, env: environment(dir), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((done) => { child.on("close", (code: number | null) => done(code)); });
    try {
      for (let waited = 0; children(dir, "eval").length === 0; waited += 20) { // the first child is running
        if (waited > 30_000) throw new Error(`no child was started: ${stderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      child.kill("SIGINT");
      expect(await closed).toBe(130);
    } finally {
      child.kill("SIGKILL"); // not left running if the test failed before the Ctrl+C
    }
    expect(stderr).toContain("Stopping the evolve… (press Ctrl+C again to exit now)");
    expect(stderr).toContain(`harness evolve: stopped; what is settled is saved. Run it again with --out ${out(dir)} to continue.`);
    expect(stdout).not.toContain("summary:");
    expect(existsSync(join(out(dir), "evolve.lock"))).toBe(false);
    expect(existsSync(join(out(dir), "r0"))).toBe(false); // it stopped before the first round

    const again = evolve(dir);

    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("ACCEPTED");
    expect(jsonIn(out(dir), "frontier.json").trajectory.map((entry: { S: number }) => entry.S)).toEqual([0, 1]);
    expect(children(dir, "eval")).toHaveLength(6); // base-smoke, base, A's smoke check and evaluation, held-out base and final: each once, whatever finished before the Ctrl+C
  });

  it("drops a candidate the critic rejects, with the reasons, and keeps the incumbent; --config and --core reach the children", () => {
    const dir = project({ replies: { "Harness Critic": [fenced({ verdict: "reject", reasons: ["too specific"], risk_notes: ["none"] })] } });
    writeFileSync(join(dir, "method.json"), JSON.stringify({ repair_rounds: 0 }));

    // HARNESS_CORE names no file: only the --core that is passed on to every child finds the fake.
    const result = evolve(dir, ["--config", join(dir, "method.json"), "--core", fakeCore], { HARNESS_CORE: join(dir, "no-such-core") });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("critic reject");
    expect(historyIn(dir).map((record) => record.outcome)).toEqual(["BASELINE", "critic_reject"]);
    const attempt = jsonIn(out(dir), "r0", "A", "a0", "proposal.json");
    expect(attempt).toMatchObject({ failure: "critic_reject", critic: { verdict: "reject", reasons: ["too specific"] } });
    const frontier = jsonIn(out(dir), "frontier.json");
    expect(frontier.pins.config.repair_rounds).toBe(0);
    expect(frontier.trajectory.map((entry: { S: number }) => entry.S)).toEqual([0, 0]);
    expect(frontier.incumbent).toMatchObject({ t: 0, hash: frontier.base.hash }); // still the base workflow: the round is settled by the trajectory's second entry
    expect(readIn(out(dir), "incumbent.harness.yaml")).toBe(readIn(out(dir), "base.harness.yaml"));
    expect(existsSync(join(out(dir), "r0", "A", "eval"))).toBe(false); // never measured
    expect(existsSync(join(out(dir), "heldout", "final"))).toBe(false); // nothing was accepted: the base is the final workflow
    expect(children(dir, "run")).toHaveLength(2); // one proposer run and one critic run: no repair
    for (const argv of children(dir, "eval")) expect(has(argv, "--core", fakeCore), argv.join(" ")).toBe(true);
  });

  it("makes a proposer whose agent failed a round with no proposal, and says why", () => {
    const dir = project({ replies: { "Harness Engineer": ["ERROR: model crashed"] } });
    writeFileSync(join(dir, "method.json"), JSON.stringify({ repair_rounds: 0 }));

    const result = evolve(dir, ["--config", join(dir, "method.json")]);

    expect(result.status, result.stderr).toBe(0); // the rounds are done, whatever the gain
    expect(result.stdout).toMatch(/A: no proposal \(no repair left\): the proposer produced no final output \(Harness Engineer failed: .*model crashed/);
    expect(result.stdout).toContain("round 0: no admissible candidate; the incumbent stays");
    expect(historyIn(dir).map((record) => record.outcome)).toEqual(["BASELINE", "no_proposal"]);
    expect(children(dir, "run")).toHaveLength(1);
  });

  describe("the checks before anything runs", () => {
    /** Runs evolve and expects exit 2, a message, and that no child was started and nothing was made. */
    function refuses(dir: string, args: string[], message: string | RegExp, folder?: string[]) {
      const before = argvLog(dir).length;
      const result = evolve(dir, args, {}, folder);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      if (typeof message === "string") expect(result.stderr).toContain(message);
      else expect(result.stderr).toMatch(message);
      expect(argvLog(dir)).toHaveLength(before + 1); // evolve itself
      expect(existsSync(out(dir))).toBe(false);
      return result;
    }

    it("is 2 for a scorer command nobody approved, even one of the held-out task: nothing runs, not even the baseline", () => {
      const command = { name: "tests", command: "npm test --silent" };
      const dir = project({ tasks: [...tasks().slice(0, 2), { id: "essay-held", split: "heldout", task: "t", scorers: [quality, command] }] });

      const result = refuses(dir, [], "harness evolve: this scorer command is not approved");

      expect(result.stderr).toContain('--allow-scorer "<command>"');
      expect(result.stderr).toContain("  npm test --silent    (essay-held/tests)");
      expect(existsSync(join(out(dir), "base"))).toBe(false);
      expect(coreRequests(dir)).toBe(0);
      // Approved, the command passes this check; the next one (the settings) stops this run, which is only to see that.
      const approved = evolve(dir, ["--allow-scorer", "npm test --silent", "-k", "0"]);
      expect(approved.stderr).not.toContain("not approved");
      expect(approved.stderr).toContain("the settings are not valid");
    });

    it("is 2 for a task set with nothing to evolve on, a workflow that is not named or not valid, and agents that share a name", () => {
      refuses(project({ tasks: [{ id: "only-held", split: "heldout", task: "t", scorers: [quality] }] }), [], "has no task in the evolve split");

      const noWorkflow = project();
      writeFileSync(join(noWorkflow, "essays.tasks.yaml"), stringify({ version: 1, name: "essays", tasks: tasks() }));
      refuses(noWorkflow, [], "no workflow to improve: pass --workflow, or name one in the task set (workflow:)");
      refuses(noWorkflow, ["--workflow", join(noWorkflow, "missing.harness.yaml")], "cannot read");

      const twins = project({ agents: [writer(), writer()], connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }] });
      refuses(twins, [], 'has agents with the same name: "Writer"');
    });

    it("is 2 for an output scorer that names an agent the workflow does not have", () => {
      const named = { name: "by-name", output: { contains: ["x"], node: "Editor" } };
      const dir = project({ tasks: [{ id: "essay-a", task: "t", scorers: [named] }] });

      const result = refuses(dir, [], 'task essay-a, scorer by-name: node "Editor" is not an agent of the workflow');

      expect(result.stderr).toContain("harness evolve: the task set does not fit the workflow");
    });

    it("is 2 for a proposer or critic workflow that is missing or not valid", () => {
      const dir = project();
      writeFileSync(join(dir, "broken.harness.yaml"), "meta: {}\nagents: []\n");

      refuses(dir, ["--proposer", join(dir, "nope.harness.yaml")], /the proposer workflow: cannot read .*nope\.harness\.yaml/);
      refuses(dir, ["--critic", join(dir, "broken.harness.yaml")], /the critic workflow: .*broken\.harness\.yaml is not a valid workflow/);
    });

    it("finds the proposer and the critic that ship with it, next to the CLI, when they are not given", () => {
      const dir = project();

      // With -k 0 the run stops at the settings, which are checked after the two workflows: so these were found and valid.
      const result = evolve(dir, ["-k", "0"], {}, undefined, MODEL_OPTIONS);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("the settings are not valid");
      expect(result.stderr).not.toMatch(/the (proposer|critic) workflow/);
    });

    it("is 2 for settings that are not valid, naming the keys, from the options or the --config file", () => {
      const dir = project();
      writeFileSync(join(dir, "typo.json"), JSON.stringify({ repair_round: 1 }));
      writeFileSync(join(dir, "lax.json"), '{ "m": 2, }');
      writeFileSync(join(dir, "array.json"), "[]");
      writeFileSync(join(dir, "conflict.json"), JSON.stringify({ b_min: 5, b_max: 2 }));

      refuses(dir, ["-k", "0"], /the settings are not valid:\n {2}k: .*\n {2}\(T is --rounds, k is --trials, m is --candidates/);
      refuses(dir, ["--candidates", "9"], /m: /);
      refuses(dir, ["--config", join(dir, "typo.json")], 'unknown key "repair_round"');
      refuses(dir, ["--config", join(dir, "lax.json")], /--config .*lax\.json is not valid JSON/);
      refuses(dir, ["--config", join(dir, "array.json")], "the config must be a JSON object");
      refuses(dir, ["--config", join(dir, "conflict.json")], "b_min (5) must not be above b_max (2)");
      refuses(dir, ["--config", join(dir, "missing.json")], /--config .*missing\.json cannot be read/);
    });

    it("takes k from -k, else from the --config file, else from the task set's trials, else 2", () => {
      // No smoke task and no harness-core: the first child is the baseline's evaluation, which fails at once, and its arguments say k.
      const kOf = (dir: string, args: string[]) => {
        const result = evolve(dir, args, { HARNESS_CORE: join(dir, "no-such-core") }, undefined, BASE_OPTIONS);
        expect(result.status, result.stderr).toBe(3);
        return valueOf(children(dir, "eval").at(-1) ?? [], "-k");
      };
      const only = [{ id: "essay-b", task: "t", scorers: [quality] }];
      const dir = project({ tasks: only, taskSet: { trials: 3 } });
      writeFileSync(join(dir, "k4.json"), JSON.stringify({ k: 4 }));

      expect(kOf(dir, [])).toBe("3");
      expect(kOf(dir, ["--config", join(dir, "k4.json")])).toBe("4");
      expect(kOf(dir, ["--config", join(dir, "k4.json"), "-k", "5"])).toBe("5");
      expect(kOf(project({ tasks: only }), [])).toBe("2");
    });

    it("is 2 for --out inside what every trial copies, and for --out that is a file", () => {
      const dir = project({
        tasks: [{ id: "essay-a", task: "t", workspace: "fixtures/essay", scorers: [quality] }], files: { "fixtures/essay/readme.md": "# essay\n" },
      });
      const inside = join(dir, "fixtures", "essay", "evolve-out");

      const result = refuses(dir, [], `--out ${inside} is inside the workspace of task essay-a`, ["--out", inside]);

      expect(result.stderr).toContain("Use a folder outside it");
      expect(existsSync(inside)).toBe(false);
      refuses(dir, [], "exists and is not a folder", ["--out", join(dir, "essays.tasks.yaml")]);
    });

    it("notes the agents that read their prompts from files, which the loop cannot change", () => {
      const filePrompt = (name: string) => ({ ...writer(), name, promptSource: { type: "file", path: `prompts/${name}.md` } });
      const dir = project({
        agents: [writer(), filePrompt("Editor"), filePrompt("Reviewer")],
        connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }, { id: "c2", sourceAgentId: "agent-1", targetAgentId: "agent-2" }],
      });

      const result = evolve(dir, ["-k", "0"]); // stops at the settings, after the note

      expect(result.status).toBe(2);
      expect(result.stdout).toContain("note: agents Editor, Reviewer read their prompts from files; the loop cannot change those prompts");
    });
  });

  describe("the command", () => {
    it("prints the usage with --help, and with a usage error", () => {
      const dir = project();

      const help = run(dir, ["evolve", "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: harness evolve <tasks.yaml> [options]");
      expect(help.stdout).toContain("--proposer-model <name>");

      const bad = run(dir, ["evolve", "essays.tasks.yaml", "--bogus"]);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain("harness evolve: Unknown option: --bogus");
      expect(bad.stderr).toContain("Usage: harness evolve <tasks.yaml> [options]");

      const top = run(dir, []);
      expect(top.status).toBe(1);
      expect(top.stderr).toMatch(/evolve <tasks\.yaml> +Improve a workflow on a task set \(evolve --help for options\)/);
    });

    it("is 2 when the folder is in use by a process that is running; the default folder is .harness/evolve/<task set name>", () => {
      const dir = project();
      const folder = join(dir, ".harness", "evolve", "essays"); // essays.tasks.yaml: without .yaml and .tasks
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "evolve.lock"), `${process.pid}\n`); // this test's own process: it is running

      const result = evolve(dir, [], {}, []);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${join(".harness", "evolve", "essays", "evolve.lock")} is in use by process ${process.pid}`);
      expect(readdirSync(folder)).toEqual(["evolve.lock"]); // the other run's lock is left alone, and nothing was started
      expect(argvLog(dir)).toHaveLength(1);
    });

    it("is 3 when harness-core is missing, with the child's reason in its log; a lock whose process is gone is taken over and given up", () => {
      const dir = project();
      mkdirSync(out(dir), { recursive: true });
      writeFileSync(join(out(dir), "evolve.lock"), "999999999\n"); // no such process

      const result = evolve(dir, [], { HARNESS_CORE: join(dir, "no-such-core") });

      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/harness evolve: harness eval left no report \(exit code 3\); see .*base-smoke\.log/);
      expect(readIn(out(dir), "base-smoke.log")).toContain("harness eval: harness-core not found at");
      expect(children(dir, "eval")).toHaveLength(1); // the first child failed: no other was started
      expect(existsSync(join(out(dir), "evolve.lock"))).toBe(false);
    });

    it("is 3 and says to build the bundle when cli/dist/harness-run.mjs is not there, and 3 when it cannot be loaded", () => {
      const bare = mkdtempSync(join(root, "outputs", "evolve-bare-"));
      scratch.push(bare);
      mkdirSync(join(bare, "cli"));
      copyFileSync(join(root, "cli", "harness.mjs"), join(bare, "cli", "harness.mjs"));
      const missing = spawnSync(process.execPath, [join(bare, "cli", "harness.mjs"), "evolve", "tasks.yaml"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      expect(missing.status).toBe(3);
      expect(missing.stderr).toContain("harness evolve: build it first with npm run build:cli");

      mkdirSync(join(bare, "cli", "dist"));
      writeFileSync(join(bare, "cli", "dist", "harness-run.mjs"), 'throw new Error("the bundle is broken");\n');
      const broken = spawnSync(process.execPath, [join(bare, "cli", "harness.mjs"), "evolve", "tasks.yaml"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
      expect(broken.status).toBe(3);
      expect(broken.stderr).toContain("harness evolve: the bundle is broken");
    });
  });
});
