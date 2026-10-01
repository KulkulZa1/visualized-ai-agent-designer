// @vitest-environment node
/**
 * harness eval when the file system refuses: a folder that cannot be read, a file that cannot be copied, a
 * folder that cannot be deleted, a report that cannot be written. The faults are made by wrapping node:fs
 * (the tests run as root here, and as a user on a CI machine: a permission would stop only one of them).
 * What matters is that none of it ends as an exception, and that none of it ends as exit code 1, which
 * means "S is below --min-score": a task-set problem is a 2, and the eval that cannot run to its end is a 3.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { ProviderSettings } from "@/engine/runWorkflow";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import { runEval } from "@/cli/evalCli";
import { loadTaskSet, type TaskDef } from "@/cli/taskSet";
import { runTrial, type TrialEnv } from "@/cli/trial";

interface Fault {
  fn: string;
  match: (path: string) => boolean;
  code: string;
  /** How many matching calls go through before the faults begin. */
  after: number;
  /** How many calls fail. */
  times: number;
  seen: number;
  failed: number;
}
const faults = vi.hoisted(() => ({ active: [] as Fault[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guard = (fn: string, original: unknown) => (...args: unknown[]) => {
    const fault = faults.active.find((f) => f.fn === fn && f.match(String(args[0])));
    if (fault && ++fault.seen > fault.after && fault.failed < fault.times) {
      fault.failed++;
      throw Object.assign(new Error(`${fault.code}: simulated, ${fn} '${String(args[0])}'`), { code: fault.code });
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return {
    ...actual,
    readdirSync: guard("readdirSync", actual.readdirSync),
    rmSync: guard("rmSync", actual.rmSync),
    copyFileSync: guard("copyFileSync", actual.copyFileSync),
    writeFileSync: guard("writeFileSync", actual.writeFileSync),
  };
});

const slashes = (path: string) => path.split("\\").join("/");

/** From now on, `fn` fails with `code` for the paths `match` says (a string: the path ends with it). */
function refuse(fn: "readdirSync" | "rmSync" | "copyFileSync" | "writeFileSync", match: string | RegExp, code = "EACCES", when: { after?: number; times?: number } = {}): Fault {
  const fault: Fault = {
    fn, code, after: when.after ?? 0, times: when.times ?? Infinity, seen: 0, failed: 0,
    match: (path) => (typeof match === "string" ? slashes(path).endsWith(slashes(match)) : match.test(path)),
  };
  faults.active.push(fault);
  return fault;
}

/** Where os.tmpdir() looks: TMPDIR on POSIX, TEMP and TMP on Windows, which ignores TMPDIR. */
const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"];
const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ["FAKE_CORE_SCENARIO", "FAKE_CORE_LOG", ...TEMP_VARIABLES]) savedEnv[name] = process.env[name];
});
afterEach(() => {
  faults.active.length = 0; // before the cleanup, which uses the same functions
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(prefix = "harness-fs-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
function put(base: string, path: string, text: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), text);
}

const agent = (name: string) => ({
  name, role: name === "Coder" ? "worker" : "critic", model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 8, timeoutSeconds: 60,
  promptSource: { type: "inline", content: `You work as the ${name}.` }, tools: [],
  memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
});

/** A task set with one task (phone, with a fixture), its workflow (Coder → Reviewer), and the fake core's scenario. */
function project() {
  const dir = folder("harness-eval-fs-");
  put(dir, "wf.harness.yaml", stringify({
    meta: { name: "Code Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: [agent("Coder"), agent("Reviewer")],
    connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
    executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  }));
  put(dir, "tasks.yaml", stringify({
    version: 1, name: "phones", workflow: "wf.harness.yaml",
    tasks: [{ id: "phone", task: "Pick a phone.", workspace: "fixtures/phone", scorers: [{ name: "answer", output: { contains: ["SUP-A"] } }] }],
  }));
  put(dir, "fixtures/phone/readme.md", "# phone\n");
  put(dir, "fixtures/phone/private/notes.txt", "notes\n");
  put(dir, "scenario.json", JSON.stringify({ replies: { Coder: ["wrote it"], Reviewer: ["Winner: SUP-A"] } }));
  process.env.FAKE_CORE_SCENARIO = join(dir, "scenario.json");
  process.env.FAKE_CORE_LOG = join(dir, "core.log");
  const asked = () => (existsSync(join(dir, "core.log")) ? readFileSync(join(dir, "core.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).cmd as string) : []);
  return { dir, tasks: join(dir, "tasks.yaml"), out: join(dir, "out"), asked };
}

// ── The task set ──────────────────────────────────────────────────────────────

describe("loadTaskSet, when a folder of a fixture cannot be read", () => {
  it("lists it as a problem of the task set, and does not throw", () => {
    const { tasks } = project();
    refuse("readdirSync", "/fixtures/phone/private");

    const result = loadTaskSet(tasks);

    expect(result).toEqual({ errors: ["task phone: workspace: fixtures/phone/private cannot be read (EACCES)"] });
  });
});

// ── One trial ─────────────────────────────────────────────────────────────────

describe("runTrial, when the file system refuses", () => {
  const graph = { nodes: [{ id: "agent-0", data: { name: "Coder" } }], edges: [], meta: {}, executionSettings: {} } as unknown as WorkflowGraph;

  function rig(keepWorkspaces = false) {
    const base = folder();
    const fixture = join(base, "fixture");
    put(base, "fixture/a.txt", "a");
    put(base, "fixture/b.txt", "b");
    const task: TaskDef = { id: "laptop", split: "evolve", smoke: false, weight: 1, task: "t", workspace: fixture, scorers: [] };
    const tempDir = join(base, "temp");
    const outDir = join(base, "out");
    mkdirSync(tempDir);
    mkdirSync(outDir);
    const warnings: string[] = [];
    const env: TrialEnv = {
      invoke: (async () => { throw new Error("no harness-core in this test: nothing may start"); }) as InvokeFn,
      graph, workflow: { path: "wf.harness.yaml", hash: "h" }, provider: {} as ProviderSettings,
      allowCommands: new Set(), allowScorers: new Set(), tempDir, outDir, evalId: "eval-1", keepWorkspaces,
      isCancelled: () => false, coreStopped: () => false, activeCommands: new Set(), onWarning: (line) => { warnings.push(line); },
    };
    return { base, fixture, task, env, warnings, trialDir: join(tempDir, "laptop-t0"), kept: join(outDir, "trials", "laptop", "t0") };
  }

  it("makes the trial missing, with the reason, when a file of the fixture cannot be copied: the trial is kept, and its folder is deleted", async () => {
    const r = rig();
    refuse("copyFileSync", "/fixture/b.txt");

    const result = await runTrial(r.env, r.task, 0);

    expect(result).toMatchObject({
      trial: 0, reward: 0, missing: true, runStatus: "not_started", tokenEstimate: null, tokens: null, scorers: [],
      error: expect.stringMatching(/^a file could not be copied: EACCES: simulated, copyFileSync '.*b\.txt'$/),
    });
    expect(JSON.parse(readFileSync(join(r.kept, "outcome.json"), "utf8"))).toMatchObject({ task: "laptop", missing: true, reward: 0 });
    expect(existsSync(r.trialDir)).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("makes the trial missing when the fixture is not the place the task set recorded: a link has taken its place", async () => {
    const r = rig();
    const decoy = folder("harness-decoy-");
    put(decoy, "a.txt", "decoy");
    rmSync(r.fixture, { recursive: true });
    symlinkSync(decoy, r.fixture);

    const result = await runTrial(r.env, r.task, 0);

    expect(result).toMatchObject({ missing: true, error: expect.stringContaining("is not the place it was when the task set was read") });
    expect(existsSync(join(r.trialDir, "a.txt"))).toBe(false); // nothing of the decoy was copied
  });

  it("says so when it cannot delete the trial's folder, and the trial counts as it did", async () => {
    const r = rig();
    refuse("copyFileSync", "/fixture/b.txt");
    refuse("rmSync", r.trialDir, "EBUSY");

    const result = await runTrial(r.env, r.task, 0);

    expect(result).toMatchObject({ missing: true, error: expect.stringContaining("a file could not be copied") });
    expect(r.warnings).toEqual([expect.stringMatching(new RegExp(`^warning: could not delete the trial folder ${r.trialDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}: EBUSY: simulated`))]);
    expect(existsSync(r.trialDir)).toBe(true); // it is still there, and the warning says where
    expect(existsSync(join(r.kept, "outcome.json"))).toBe(true);
  });

  it("does not delete the trial's folder when the eval keeps the workspaces", async () => {
    const r = rig(true);
    refuse("copyFileSync", "/fixture/b.txt");
    const deleting = refuse("rmSync", r.trialDir, "EBUSY");

    const result = await runTrial(r.env, r.task, 0);

    expect(result).toMatchObject({ missing: true });
    expect(deleting.seen).toBe(0); // it was not tried
    expect(r.warnings).toEqual([]);
    expect(existsSync(r.trialDir)).toBe(true);
  });
});

// ── The eval ──────────────────────────────────────────────────────────────────

describe("runEval, when the file system refuses", () => {
  /** `harness eval` in this process: its exit code, what it wrote to stdout and stderr, and how many Ctrl+C handlers the
   *  process had before it, the most while it wrote a line of progress, and after it. However the eval ends, it gives back
   *  the handler it took (the process that runs it is not one that ends with it, as a test's is not). */
  async function run(tasks: string, out: string, extra: string[] = []) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const before = process.listenerCount("SIGINT");
    let during = before;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      during = Math.max(during, process.listenerCount("SIGINT"));
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    const code = await runEval([tasks, "--core", resolve(__dirname, "../../fixtures/fake-core.mjs"), "--out", out, ...extra]);
    const after = process.listenerCount("SIGINT");
    vi.restoreAllMocks();
    expect(after, "the Ctrl+C handler of the eval is still there").toBe(before);
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), sigint: { before, during, after } };
  }
  const reportIn = (out: string) => JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  /** A folder for the trials that is the test's own, so that what is left in it can be told: the one variable os.tmpdir() reads on
   *  each platform is set (all three are, as the platform is not asked). */
  function privateTemp() {
    const temp = folder("harness-temp-");
    for (const name of TEMP_VARIABLES) process.env[name] = temp;
    return temp;
  }

  it("takes a Ctrl+C handler while it runs and gives it back when it ends, whether the eval finished or not", async () => {
    const finished = project();

    const done = await run(finished.tasks, finished.out);

    expect(done.code).toBe(0);
    expect(done.sigint.during).toBe(done.sigint.before + 1); // there while the trial's line was written
    expect(done.sigint.after).toBe(done.sigint.before);

    const failing = project();
    refuse("writeFileSync", "report.json.tmp");
    const failed = await run(failing.tasks, failing.out); // the handler was taken, and the eval ended before any trial

    expect(failed.code).toBe(3);
    expect(failed.sigint.after).toBe(failed.sigint.before);
  });

  it("is 2, and says why, when a folder of a fixture cannot be read: it is a problem of the task set, and nothing starts", async () => {
    const p = project();
    refuse("readdirSync", "/fixtures/phone/private");

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is not a valid task set");
    expect(result.stderr).toContain("fixtures/phone/private cannot be read (EACCES)");
    expect(p.asked()).toEqual([]); // harness-core was never started
    expect(existsSync(p.out)).toBe(false);
  });

  it("is 2, and says why, when the output folder cannot be looked at", async () => {
    const p = project();
    mkdirSync(p.out);
    refuse("readdirSync", p.out);

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/harness eval: --out .*out cannot be looked at: EACCES: simulated/);
    expect(p.asked()).toEqual([]);
  });

  it("is 3, and says why, when the first report cannot be written: no trial starts, and the output folder it made is not left", async () => {
    const p = project();
    const temp = privateTemp();
    refuse("writeFileSync", "report.json.tmp");

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/harness eval: cannot write .*report\.json: EACCES: simulated/);
    expect(p.asked()).not.toContain("check_provider_health"); // no trial was tried
    expect(existsSync(p.out)).toBe(false);
    expect(readdirSync(temp)).toEqual([]); // and no folder of trials
  });

  it("removes every folder it made for a nested --out when it ends before it wrote anything, and no folder that was there", async () => {
    const p = project();
    refuse("writeFileSync", "report.json.tmp");
    mkdirSync(join(p.dir, "kept"));
    writeFileSync(join(p.dir, "kept", "keep.txt"), "mine\n");
    mkdirSync(join(p.dir, "empty")); // there, and empty: still not the eval's to remove

    const underKept = await run(p.tasks, join(p.dir, "kept", "x", "y", "z"));
    const underEmpty = await run(p.tasks, join(p.dir, "empty", "inner"));
    const allNew = await run(p.tasks, join(p.dir, "a", "b", "c"));

    expect([underKept.code, underEmpty.code, allNew.code]).toEqual([3, 3, 3]);
    expect(readdirSync(join(p.dir, "kept"))).toEqual(["keep.txt"]);
    expect(readdirSync(join(p.dir, "empty"))).toEqual([]);
    expect(existsSync(join(p.dir, "a"))).toBe(false);
  });

  it("is 3 when the last report cannot be written, and still prints the results; the report is tried once more, as an error", async () => {
    const p = project();
    refuse("writeFileSync", "report.json.tmp", "ENOSPC", { after: 2, times: 1 }); // the first write, and the one after the trial, go through

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(3);
    expect(result.stdout).toContain("[1/1] phone t0: reward 1.00 (answer ✓)");
    expect(result.stdout).toMatch(/S 1\.000 · C n\/a · 1 of 1 trials, 0 missing/);
    expect(result.stderr).toMatch(/harness eval: cannot write .*report\.json: ENOSPC: simulated/);
    expect(reportIn(p.out)).toMatchObject({ status: "error", n_done: 1, error: expect.stringContaining("cannot write") });
  });

  it("is 3 when no report can be written any more: the one on disk is the last good one, and no half of a report is left", async () => {
    const p = project();
    refuse("writeFileSync", "report.json.tmp", "ENOSPC", { after: 2 });

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(3);
    expect(result.stdout).toContain("1 of 1 trials, 0 missing"); // the summary is printed from memory
    expect(reportIn(p.out)).toMatchObject({ status: "running", n_done: 1 });
    expect(readdirSync(p.out).sort()).toEqual(["report.json", "trials"]); // no report.json.tmp
  });

  it("is 3, and the report says error, when what is kept of a trial cannot be written: the eval broke", async () => {
    const p = project();
    refuse("writeFileSync", "outcome.json");

    const result = await run(p.tasks, p.out);

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/harness eval: the eval broke: EACCES: simulated, writeFileSync '.*outcome\.json'/);
    expect(reportIn(p.out)).toMatchObject({ status: "error", n_done: 0, error: expect.stringContaining("the eval broke") });
  });

  it("is 3, never 1, for what nobody foresaw: the error is said, the report is written as an error, and the folders are cleaned up", async () => {
    const p = project();
    const temp = privateTemp();
    // stdout is gone (a closed pipe, a full disk): the first line of progress throws.
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => { throw new Error("stdout is gone"); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });

    const code = await runEval([p.tasks, "--core", resolve(__dirname, "../../fixtures/fake-core.mjs"), "--out", p.out]);
    vi.restoreAllMocks();

    expect(code).toBe(3); // not an exception, and not 1: that is what a process exits with when an exception is not caught
    expect(lines.join("")).toContain("harness eval: unexpected error: stdout is gone");
    expect(reportIn(p.out)).toMatchObject({ status: "error", error: expect.stringContaining("stdout is gone") });
    expect(readdirSync(temp)).toEqual([]); // the folder of the trials is gone
  });
});
