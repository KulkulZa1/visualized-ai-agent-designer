// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate, buildReport, reportText, summaryLines, trialLine, writeReport, type ReportHeader, type TaskTrials } from "@/cli/evalReport";
import type { TrialResult } from "@/cli/trial";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trial(index: number, reward: number, extra: Partial<TrialResult> = {}): TrialResult {
  return {
    trial: index, reward, missing: false, runStatus: "done", runMs: 1000, scoreMs: 100, tokens: null, tokenEstimate: 100, scorers: [],
    ...extra,
  };
}
const missing = (index: number, error = "the run did not start"): TrialResult =>
  trial(index, 0, { missing: true, runStatus: "not_started", error, tokenEstimate: null });
const withTokens = (index: number, reward: number, input: number, output: number) => trial(index, reward, { tokens: { input, output } });

/** Tasks of weight 1 (or `weights[id]`) whose trials have these rewards. */
function tasksOf(rewards: Record<string, number[]>, weights: Record<string, number> = {}): TaskTrials[] {
  return Object.entries(rewards).map(([id, list]) => ({ id, weight: weights[id] ?? 1, trials: list.map((r, i) => trial(i, r)) }));
}

describe("aggregate: the cases of rrsi's own tests/test_core.py", () => {
  it("pools all the trials: {a: [1, 0], b: [1, 1]} gives S = 0.75", () => {
    const a = aggregate(tasksOf({ a: [1, 0], b: [1, 1] }), 2);

    expect(a.S).toBeCloseTo(0.75, 9);
    expect(a.n_expected).toBe(4);
    expect(a.n_done).toBe(4);
    expect(a.missing).toBe(0);
  });

  it("weights each trial by its task's weight: 15/200, the criteria-weighted fraction", () => {
    // rrsi: a = rewards [0.5, 1.0] with weight 10, b = rewards [0, 0] with weight 90.
    const a = aggregate(tasksOf({ a: [0.5, 1.0], b: [0, 0] }, { a: 10, b: 90 }), 2);

    expect(a.S).toBeCloseTo(15 / 200, 9);
    expect(a.per_task.a).toMatchObject({ weight: 10, mean: 0.75 });
    expect(a.per_task.b).toMatchObject({ weight: 90, mean: 0 });
  });

  it("is neither the mean of the task means nor weight-blind: the weighted case tells them apart", () => {
    const a = aggregate(tasksOf({ a: [0.5, 1.0], b: [0, 0] }, { a: 10, b: 90 }), 2);

    expect(a.S).not.toBeCloseTo(0.375, 3); // (0.75 + 0) / 2, or (0.5 + 1 + 0 + 0) / 4
  });

  it("counts a missing trial as 0 and keeps it in the denominator, and counts it as missing", () => {
    const tasks: TaskTrials[] = [{ id: "a", weight: 1, trials: [trial(0, 1), missing(1)] }, { id: "b", weight: 1, trials: [trial(0, 1), trial(1, 1)] }];

    const a = aggregate(tasks, 2);

    expect(a.S).toBeCloseTo(0.75, 9); // (1 + 0 + 1 + 1) / 4, not 3 / 3
    expect(a.missing).toBe(1);
    expect(a.n_done).toBe(4);
    expect(a.per_task.a).toMatchObject({ missing: 1, rewards: [1, 0], mean: 0.5 });
    expect(a.per_task.b.missing).toBe(0);
  });

  it("weights a missing trial in the denominator by its task's weight", () => {
    const tasks: TaskTrials[] = [{ id: "a", weight: 3, trials: [missing(0)] }, { id: "b", weight: 1, trials: [trial(0, 1)] }];

    expect(aggregate(tasks, 1).S).toBeCloseTo(1 / 4, 9);
  });

  it("gives no cost when no trial has a token count", () => {
    expect(aggregate(tasksOf({ a: [1, 0], b: [1, 1] }), 2).C).toBeNull();
  });

  it("gives the mean of the token totals (input + output) over the trials that have one", () => {
    const tasks: TaskTrials[] = [
      { id: "a", weight: 1, trials: [withTokens(0, 1, 3500, 600), withTokens(1, 0, 3000, 900), trial(2, 1)] },
      { id: "b", weight: 1, trials: [missing(0), withTokens(1, 1, 1000, 500)] },
    ];

    const a = aggregate(tasks, 3);

    expect(a.C).toBeCloseTo((4100 + 3900 + 1500) / 3, 9);
    expect(a.per_task.a.tokens).toEqual([4100, 3900, null]);
    expect(a.per_task.b.tokens).toEqual([null, 1500]);
  });

  it("leaves a total of 0 out of the cost, as rrsi does: no usage was reported, not a free run", () => {
    const tasks: TaskTrials[] = [{ id: "a", weight: 1, trials: [withTokens(0, 1, 0, 0), withTokens(1, 1, 1000, 0)] }];

    const a = aggregate(tasks, 2);

    expect(a.C).toBe(1000);
    expect(a.per_task.a.tokens).toEqual([0, 1000]); // the list says what was reported
  });
});

describe("aggregate: a report in progress", () => {
  it("pools the finished trials: a task with more finished trials counts more than the mean of the task means says", () => {
    // a finished 2 trials (1, 1), b has finished 1 (0): pooled 2/3; the mean of the task means is 1/2.
    const a = aggregate(tasksOf({ a: [1, 1], b: [0] }), 2);

    expect(a.S).toBeCloseTo(2 / 3, 9);
    expect(a.n_expected).toBe(4);
    expect(a.n_done).toBe(3);
  });

  it("has no score, no cost and no mean before the first trial finishes, and lists the task", () => {
    const a = aggregate([{ id: "a", weight: 1, trials: [] }], 3);

    expect(a).toMatchObject({ S: null, C: null, n_expected: 3, n_done: 0, missing: 0 });
    expect(a.per_task.a).toEqual({ weight: 1, mean: null, rewards: [], tokens: [], missing: 0, trials: [] });
  });

  it("expects tasks x k trials", () => {
    expect(aggregate(tasksOf({ a: [], b: [], c: [] }), 4).n_expected).toBe(12);
  });
});

const header: ReportHeader = {
  evalId: "eval-1", taskSet: { name: "purchasing", path: "/p/t.yaml", hash: "h1" }, workflow: { name: "W", path: "/p/w.yaml", hash: "h2" },
  split: "evolve", k: 2, provider: { llmProvider: "auto", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "", ollamaNumCtx: 16384 },
  startedAt: "2026-10-01T00:00:00.000Z",
};

describe("buildReport", () => {
  it("has the shape of the design's report, key by key and in its order", () => {
    const report = buildReport(header, tasksOf({ laptop: [1, 0] }), "done", { finishedAt: "2026-10-01T00:05:00.000Z" });

    expect(Object.keys(report)).toEqual([
      "version", "evalId", "status", "taskSet", "workflow", "split", "k", "provider", "startedAt", "finishedAt",
      "S", "C", "n_expected", "n_done", "missing", "per_task",
    ]);
    expect(report).toMatchObject({
      version: 1, evalId: "eval-1", status: "done", split: "evolve", k: 2, S: 0.5, C: null, n_expected: 2, n_done: 2, missing: 0,
      taskSet: { name: "purchasing", path: "/p/t.yaml", hash: "h1" }, workflow: { name: "W", path: "/p/w.yaml", hash: "h2" },
    });
    expect(Object.keys(report.per_task.laptop)).toEqual(["weight", "mean", "rewards", "tokens", "missing", "trials"]);
    expect(Object.keys(report.per_task.laptop.trials[0])).toEqual(
      ["trial", "reward", "missing", "runStatus", "runMs", "scoreMs", "tokens", "tokenEstimate", "scorers"]);
  });

  it("has no finishedAt and no error while the eval runs, and says why it stopped when it stopped early", () => {
    const running = buildReport(header, tasksOf({ a: [] }), "running");
    expect(running.status).toBe("running");
    expect(running).not.toHaveProperty("finishedAt");
    expect(running).not.toHaveProperty("error");

    const stopped = buildReport(header, tasksOf({ a: [] }), "error", { finishedAt: "t", error: "harness-core stopped during the eval" });
    expect(stopped).toMatchObject({ status: "error", finishedAt: "t", error: "harness-core stopped during the eval" });
  });

  it("holds no key: the provider is the run record's, with no key in it", () => {
    expect(JSON.stringify(buildReport(header, tasksOf({ a: [1] }), "done"))).not.toMatch(/apiKey|api_key|ApiKey/);
  });
});

describe("writeReport", () => {
  it("writes the report as JSON, replaces it on the next write, and leaves no temporary file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-report-"));
    scratch.push(dir);
    const file = join(dir, "report.json");

    writeReport(file, buildReport(header, tasksOf({ a: [] }), "running"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "running", S: null });

    const done = buildReport(header, tasksOf({ a: [1, 1] }), "done");
    writeReport(file, done);

    expect(readFileSync(file, "utf8")).toBe(reportText(done));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "done", S: 1 });
    expect(readdirSync(dir)).toEqual(["report.json"]);
  });

  it("ends the file with a newline", () => {
    expect(reportText(buildReport(header, tasksOf({ a: [1] }), "done")).endsWith("}\n")).toBe(true);
  });

  it("throws, and leaves no temporary file, when the report cannot be put in place: the folder has only what it had", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-report-"));
    scratch.push(dir);
    mkdirSync(join(dir, "report.json")); // a folder is where the report should go
    writeFileSync(join(dir, "report.json", "kept.txt"), "x");

    expect(() => writeReport(join(dir, "report.json"), buildReport(header, tasksOf({ a: [1] }), "done"))).toThrow();

    expect(readdirSync(dir)).toEqual(["report.json"]); // no report.json.tmp
    expect(readdirSync(join(dir, "report.json"))).toEqual(["kept.txt"]);
  });
});

describe("trialLine and summaryLines", () => {
  const scored = trial(0, 2 / 3, {
    runMs: 45_210, scoreMs: 3120,
    scorers: [
      { name: "tests", kind: "command", passed: true, weight: 1, exitCode: 0, ms: 3050 },
      { name: "slow", kind: "command", passed: false, weight: 1, timedOut: true, ms: 100 },
      { name: "names-the-winner", kind: "output", passed: false, weight: 1, detail: 'does not contain "SUP-A"', ms: 1 },
    ],
  });

  it("says a trial's reward, its scorers and the times", () => {
    expect(trialLine(1, 4, "laptop", scored)).toBe(
      "[1/4] laptop t0: reward 0.67 (tests ✓, slow ✗ (timed out), names-the-winner ✗) · run 45.2 s, scoring 3.1 s");
  });

  it("says why a trial is missing, and what went wrong in the run of one that was scored", () => {
    expect(trialLine(2, 4, "laptop", missing(1, "the run did not start: Ollama is not running")))
      .toBe("[2/4] laptop t1: missing (the run did not start: Ollama is not running) · run 1.0 s");
    expect(trialLine(3, 4, "phone", trial(0, 1, { runStatus: "error", error: "Reviewer failed: model crashed", scorers: [
      { name: "answer", kind: "output", passed: true, weight: 1, ms: 0 }] })))
      .toBe("[3/4] phone t0: reward 1.00 (answer ✓) · run 1.0 s, scoring 0.1 s · error: Reviewer failed: model crashed");
  });

  it("keeps a line to one line: an error with line breaks in it is shown on one line, and is kept as it was in the data", () => {
    const text = "Ollama is not running\nRun: ollama pull qwen3:8b\r\n\n  then try again.";
    const lost = missing(1, text);
    const failed = trial(0, 1, { runStatus: "error", error: "Reviewer failed: bad\nreply", scorers: [{ name: "answer", kind: "output", passed: true, weight: 1, ms: 0 }] });

    expect(trialLine(2, 4, "laptop", lost)).toBe("[2/4] laptop t1: missing (Ollama is not running Run: ollama pull qwen3:8b then try again.) · run 1.0 s");
    expect(trialLine(3, 4, "phone", failed)).toBe("[3/4] phone t0: reward 1.00 (answer ✓) · run 1.0 s, scoring 0.1 s · error: Reviewer failed: bad reply");
    for (const line of [trialLine(2, 4, "laptop", lost), trialLine(3, 4, "phone", failed)]) expect(line).not.toMatch(/[\r\n]/);
    // The report and the trial's files have the whole text.
    expect(lost.error).toBe(text);
    const report = JSON.parse(reportText(buildReport(header, [{ id: "laptop", weight: 1, trials: [lost] }], "done")));
    expect(report.per_task.laptop.trials[0].error).toBe(text);
  });

  it("sums up the eval: each task's rewards, then S, C and the trials", () => {
    const report = buildReport(header, [
      { id: "laptop", weight: 1, trials: [trial(0, 1), missing(1)] }, { id: "phone", weight: 1, trials: [trial(0, 1), trial(1, 1)] },
    ], "done");

    expect(summaryLines(report)).toEqual([
      "",
      "Eval eval-1: purchasing · split evolve · 2 tasks × 2 trials · done",
      "  laptop: mean 0.50 · rewards 1.00 0.00 · 1 missing",
      "  phone: mean 1.00 · rewards 1.00 1.00",
      "S 0.750 · C n/a · 4 of 4 trials, 1 missing",
    ]);
  });

  it("says the cost in tokens when there is one, and that a task has no trial yet", () => {
    const report = buildReport({ ...header, k: 1 }, [
      { id: "a", weight: 1, trials: [withTokens(0, 1, 1000, 234)] }, { id: "b", weight: 1, trials: [] },
    ], "running");

    expect(summaryLines(report)).toEqual([
      "",
      "Eval eval-1: purchasing · split evolve · 2 tasks × 1 trial · running",
      "  a: mean 1.00 · rewards 1.00",
      "  b: mean n/a · rewards none yet",
      "S 1.000 · C 1234 tokens · 1 of 2 trials, 0 missing",
    ]);
  });
});
