// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildReport, reportText, type EvalStatus, type ReportHeader, type TaskTrials } from "@/cli/evalReport";
import type { TrialResult } from "@/cli/trial";
import {
  aggregate, fixed, fromReport, pooled, relativeCostChange, roundTo, taskMean, tooManyMissing, type EvalResult, type TaskResult,
} from "@/evolve/measure";
import { evalOf } from "./evalFixture";

const task = (rewards: number[], weight = 1, tokens: Array<number | null> = rewards.map(() => null), missing = 0): TaskResult => ({
  rewards, weights: rewards.map(() => weight), tokens, missing,
});

describe("aggregate: rrsi's test_estimator_and_weights", () => {
  it("pools every trial: {a: [1, 0], b: [1, 1]} gives S = 0.75 from 4 expected trials", () => {
    const ev = evalOf("j", { a: [1, 0], b: [1, 1] }, 2);

    expect(ev.S).toBeCloseTo(0.75, 9);
    expect(ev.n_expected).toBe(4);
    expect(ev.missing).toBe(0);
  });

  it("weights the trials: weights 10 and 90 give the criteria-weighted fraction 15/200", () => {
    const per = {
      a: { rewards: [0.5, 1.0], weights: [10, 10], tokens: [null, null], missing: 0 },
      b: { rewards: [0.0, 0.0], weights: [90, 90], tokens: [null, null], missing: 0 },
    };

    expect(aggregate("w", 2, per).S).toBeCloseTo(15 / 200, 9);
  });

  it("is not the mean of the task means, which would be 0.375", () => {
    const per = { a: task([0.5, 1.0], 10), b: task([0, 0], 90) };

    expect(aggregate("w", 2, per).S).not.toBeCloseTo(0.375, 3);
  });

  it("keeps the job and k, and counts tasks × k expected trials whatever the tasks have finished", () => {
    const ev = aggregate("base", 4, { a: task([1]), b: task([]), c: task([1, 0]) });

    expect(ev).toMatchObject({ job: "base", k: 4, n_expected: 12 });
  });

  it("is 0 when there is no weight at all, and for no tasks", () => {
    expect(aggregate("j", 2, {}).S).toBe(0);
    expect(aggregate("j", 2, { a: task([1, 1], 0) }).S).toBe(0);
    expect(aggregate("j", 2, {})).toMatchObject({ C: null, n_expected: 0, missing: 0 });
  });

  it("sums the missing trials over the tasks", () => {
    const ev = aggregate("j", 3, { a: task([1, 0, 0], 1, [null, null, null], 2), b: task([1, 1, 1], 1, [null, null, null], 1), c: task([1]) });

    expect(ev.missing).toBe(3);
  });

  it("counts a missing trial as a reward of 0 with its full weight", () => {
    // a has one real trial (1) and one missing (0), at weight 3; b has one trial (1) at weight 1.
    const ev = aggregate("j", 2, { a: task([1, 0], 3, [null, null], 1), b: task([1], 1) });

    expect(ev.S).toBeCloseTo(4 / 7, 9); // not 4/4
  });

  it("takes the cost as the mean of the token totals that are numbers above 0", () => {
    const ev = aggregate("j", 3, { a: task([1, 0, 1], 1, [4100, null, 0]), b: task([1, 1], 1, [3900, 1500]) });

    expect(ev.C).toBeCloseTo((4100 + 3900 + 1500) / 3, 9);
  });

  it("has no cost when no trial has a count above 0", () => {
    expect(aggregate("j", 2, { a: task([1, 0]) }).C).toBeNull();
    expect(aggregate("j", 2, { a: task([1, 0], 1, [0, 0]) }).C).toBeNull();
  });

  it("round-trips through JSON, as rrsi's test does with to_json and from_json", () => {
    // rrsi: EvalResult.from_json(aggregate("j", 1, {"a": TaskResult(rewards=[1.0])}).to_json()), then S == 1.0.
    const ev = aggregate("j", 1, { a: task([1.0]) });
    const back = JSON.parse(JSON.stringify(ev)) as EvalResult;

    expect(back).toEqual(ev);
    expect(back.S).toBe(1);
    expect(back.C).toBeNull();
  });
});

describe("taskMean", () => {
  it("is the weighted mean of the rewards", () => {
    expect(taskMean({ rewards: [1, 0], weights: [1, 3], tokens: [null, null], missing: 0 })).toBeCloseTo(0.25, 9);
    expect(taskMean(task([1, 0, 1, 1]))).toBeCloseTo(0.75, 9);
  });

  it("is 0 when the weights sum to 0, and for no trials", () => {
    expect(taskMean(task([1, 1], 0))).toBe(0);
    expect(taskMean(task([]))).toBe(0);
  });
});

describe("relativeCostChange", () => {
  it("is (C' − C_t) / C_t", () => {
    expect(relativeCostChange(1100, 1000)).toBeCloseTo(0.1, 9);
    expect(relativeCostChange(900, 1000)).toBeCloseTo(-0.1, 9);
    expect(relativeCostChange(1000, 1000)).toBe(0);
    expect(relativeCostChange(3000, 1000)).toBe(2);
  });

  it("is 0 when either side has no count, or a count of 0", () => {
    expect(relativeCostChange(null, 1000)).toBe(0);
    expect(relativeCostChange(1000, null)).toBe(0);
    expect(relativeCostChange(null, null)).toBe(0);
    expect(relativeCostChange(0, 1000)).toBe(0);
    expect(relativeCostChange(1000, 0)).toBe(0);
  });
});

describe("pooled", () => {
  const first = aggregate("one", 2, { a: task([1, 0], 1, [100, 200], 1), b: task([1, 1], 2, [300, null]) });
  const second = aggregate("two", 3, { a: task([1, 1, 0], 1, [150, 250, 350]), c: task([0, 0, 1], 1, [null, null, null], 2) });

  it("concatenates each task's rewards, weights and tokens, and sums its missing trials", () => {
    const ev = pooled([first, second]);

    expect(ev.per_task.a).toEqual({ rewards: [1, 0, 1, 1, 0], weights: [1, 1, 1, 1, 1], tokens: [100, 200, 150, 250, 350], missing: 1 });
    expect(ev.per_task.b).toEqual(first.per_task.b);
    expect(ev.per_task.c).toEqual(second.per_task.c);
  });

  it("adds up k, and aggregates the pool under the job 'pooled'", () => {
    const ev = pooled([first, second]);

    expect(ev).toMatchObject({ job: "pooled", k: 5, n_expected: 15, missing: 3 });
    expect(Object.keys(ev.per_task).sort()).toEqual(["a", "b", "c"]);
    expect(ev.S).toBeCloseTo((1 + 0 + 2 * 1 + 2 * 1 + 1 + 1 + 0 + 0 + 0 + 1) / (2 + 4 + 3 + 3), 9);
    expect(ev.C).toBeCloseTo((100 + 200 + 300 + 150 + 250 + 350) / 6, 9);
  });

  it("is the evaluation itself, up to the job, for one evaluation", () => {
    const ev = pooled([first]);

    expect(ev).toEqual({ ...first, job: "pooled" });
  });

  it("is an empty evaluation for none", () => {
    expect(pooled([])).toEqual({ job: "pooled", k: 0, per_task: {}, S: 0, C: null, n_expected: 0, missing: 0 });
  });

  it("changes none of its inputs, and shares no array with them", () => {
    const before = JSON.stringify([first, second]);
    const ev = pooled([first, second]);
    ev.per_task.a.rewards.push(9);
    ev.per_task.b.rewards.push(9);
    ev.per_task.c.rewards.push(9);

    expect(JSON.stringify([first, second])).toBe(before);
  });

  it("copes with a task whose id is a name every object has", () => {
    const ev = pooled([aggregate("x", 1, { constructor: task([1]), toString: task([0]) }), aggregate("y", 1, { constructor: task([0]) })]);
    const taskOf = (id: string) => ev.per_task[id]; // a string variable: TypeScript reads `.constructor` as Object's

    expect(taskOf("constructor").rewards).toEqual([1, 0]);
    expect(taskOf("toString").rewards).toEqual([0]);
  });
});

describe("tooManyMissing", () => {
  const ev = aggregate("j", 2, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, task([1, 1])]))); // 20 expected

  it("is true when the missing trials are more than the share of those expected", () => {
    expect(tooManyMissing({ ...ev, missing: 6 }, 0.25)).toBe(true);
  });

  it("is false at the share exactly, and below", () => {
    expect(tooManyMissing({ ...ev, missing: 5 }, 0.25)).toBe(false); // 5 > 0.25 · 20 is false
    expect(tooManyMissing({ ...ev, missing: 0 }, 0.25)).toBe(false);
  });

  it("with a share of 0, allows no missing trial", () => {
    expect(tooManyMissing({ ...ev, missing: 1 }, 0)).toBe(true);
    expect(tooManyMissing({ ...ev, missing: 0 }, 0)).toBe(false);
  });

  it("with the default 0.15 of 20 trials, allows 3", () => {
    expect(tooManyMissing({ ...ev, missing: 3 }, 0.15)).toBe(false);
    expect(tooManyMissing({ ...ev, missing: 4 }, 0.15)).toBe(true);
  });
});

describe("fixed", () => {
  // Every expected text is Python's format(x, f".{digits}f").
  const cases: Array<[number, number, string]> = [
    [0.28125, 4, "0.2812"], [-0.28125, 4, "-0.2812"], [0.84375, 4, "0.8438"], [0.0078125, 6, "0.007812"], [0.5703125, 6, "0.570312"],
    [0.5, 0, "0"], [1.5, 0, "2"], [2.5, 0, "2"], [-0.5, 0, "-0"], [0.125, 2, "0.12"], [0.375, 2, "0.38"], [0.625, 2, "0.62"],
    [0.875, 2, "0.88"], [0.03125, 4, "0.0312"], [0.09375, 4, "0.0938"], [0.15625, 4, "0.1562"],
    [2.675, 2, "2.67"], [1.005, 2, "1.00"], [0.1234565, 6, "0.123456"], [0.30000000000000004, 6, "0.300000"], [1234.56789, 1, "1234.6"],
    [0.25, 1, "0.2"], [0.75, 1, "0.8"], [0.35, 1, "0.3"], [5e-7, 6, "0.000000"], [1e-7, 6, "0.000000"],
  ];

  it("writes an exact half to the even digit, as Python does, where toFixed writes it up", () => {
    for (const [x, digits, expected] of cases) expect(fixed(x, digits), `format(${x}, ".${digits}f")`).toBe(expected);
    expect((0.28125).toFixed(4)).toBe("0.2813"); // what the plain call gives
  });

  it("rounds a value that is not an exact half by its exact binary value", () => {
    expect(fixed(2.675, 2)).toBe("2.67"); // 2.67499999999999982…
    expect(fixed(0.35, 1)).toBe("0.3"); // 0.34999999999999997…
    expect(fixed(0.7, 6)).toBe("0.700000");
  });

  it("pads to the places and keeps the integer part", () => {
    expect(fixed(12, 3)).toBe("12.000");
    expect(fixed(-1234.5, 0)).toBe("-1234"); // an exact half again, to the even 1234
    expect(fixed(1e-9, 4)).toBe("0.0000");
  });

  it("leaves what is not a finite number to toFixed", () => {
    expect(fixed(Number.NaN, 4)).toBe("NaN");
    expect(fixed(Infinity, 4)).toBe("Infinity");
    expect(fixed(-Infinity, 4)).toBe("-Infinity");
    expect(fixed(1e21, 2)).toBe((1e21).toFixed(2));
  });
});

describe("roundTo", () => {
  it("writes an exact half to the even digit, as Python's round does", () => {
    expect(roundTo(0.28125, 4)).toBe(0.2812);
    expect(roundTo(0.0078125, 6)).toBe(0.007812);
    expect(roundTo(0.5703125, 6)).toBe(0.570312);
    expect(roundTo(0.84375, 4)).toBe(0.8438);
    expect([0.5, 1.5, 2.5, 3.5].map((x) => roundTo(x, 0))).toEqual([0, 2, 2, 4]);
    expect([0.125, 0.375, 0.625, 0.875].map((x) => roundTo(x, 2))).toEqual([0.12, 0.38, 0.62, 0.88]);
  });

  it("rounds to the places, as Python's round does", () => {
    expect(roundTo(0.1234567891, 6)).toBe(0.123457);
    expect(roundTo(1234.56789, 1)).toBe(1234.6);
    expect(roundTo(-0.0123456, 5)).toBe(-0.01235);
    expect(roundTo(1 / 3, 2)).toBe(0.33);
    expect(roundTo(0.7, 6)).toBe(0.7);
  });

  it("rounds the exact binary value, as Python does, where multiplying by 10 ** digits would round a hair-under-half up", () => {
    // Every expected value is Python's round(x, digits). Math.round(x * 10 ** digits) / 10 ** digits gets 5e-7, 3.5e-6, 5.5e-6,
    // 1.35e-5, 1.75e-5, 2.675 and -1.5e-6 wrong.
    const cases: Array<[number, number, number]> = [
      [5e-7, 6, 0], [1.5e-6, 6, 2e-6], [2.5e-6, 6, 3e-6], [3.5e-6, 6, 3e-6], [4.5e-6, 6, 5e-6], [5.5e-6, 6, 5e-6], [7.5e-6, 6, 8e-6],
      [9.5e-6, 6, 1e-5], [1.35e-5, 6, 1.3e-5], [1.75e-5, 6, 1.7e-5], [2.675, 2, 2.67], [1.005, 2, 1], [-1.5e-6, 6, -2e-6],
    ];
    for (const [x, digits, expected] of cases) expect(roundTo(x, digits), `round(${x}, ${digits})`).toBe(expected);
  });

  it("is never -0", () => {
    expect(Object.is(roundTo(-0.0000004, 6), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 6), 0)).toBe(true);
  });

  it("keeps NaN, so a broken number is not hidden as 0", () => {
    expect(roundTo(Number.NaN, 6)).toBeNaN();
  });
});

// ── fromReport ────────────────────────────────────────────────────────────────

function trial(index: number, reward: number, extra: Partial<TrialResult> = {}): TrialResult {
  return { trial: index, reward, missing: false, runStatus: "done", runMs: 1000, scoreMs: 100, tokens: null, tokenEstimate: 100, scorers: [], ...extra };
}
const withTokens = (index: number, reward: number, input: number, output: number) => trial(index, reward, { tokens: { input, output } });
const missingTrial = (index: number) => trial(index, 0, { missing: true, runStatus: "not_started", error: "the run did not start", tokenEstimate: null });

const header: ReportHeader = {
  evalId: "eval-1", taskSet: { name: "purchasing", path: "/p/t.yaml", hash: "h1" }, workflow: { name: "W", path: "/p/w.yaml", hash: "h2" },
  split: "evolve", k: 2, provider: { llmProvider: "auto", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "", ollamaNumCtx: 16384 },
  startedAt: "2026-10-11T00:00:00.000Z",
};

// S = (2·1 + 2·0 + 1·1 + 1·0 + 3·0.5 + 3·1) / (2·2 + 1·2 + 3·2) = 7.5 / 12 = 0.625, and C = (3500 + 2400 + 1100 + 1000) / 4 = 2000.
const tasks: TaskTrials[] = [
  { id: "laptop", weight: 2, trials: [withTokens(0, 1, 3000, 500), withTokens(1, 0, 2000, 400)] },
  { id: "phone", weight: 1, trials: [trial(0, 1), missingTrial(1)] },
  { id: "tablet", weight: 3, trials: [withTokens(0, 0.5, 1000, 100), withTokens(1, 1, 900, 100)] },
];

/** The report as `harness eval` writes it, parsed the way the loop reads it back. */
const reportOf = (status: EvalStatus = "done", over: TaskTrials[] = tasks): Record<string, unknown> & { S: number; C: number; n_expected: number; per_task: Record<string, Record<string, unknown>> } =>
  JSON.parse(reportText(buildReport(header, over, status, status === "done" ? { finishedAt: "2026-10-11T00:05:00.000Z" } : { error: "the model server stopped" })));

function evOf(raw: unknown): EvalResult {
  const result = fromReport("base", raw);
  if (!("ev" in result)) throw new Error(`expected an evaluation, got invalid: ${result.invalid}`);
  return result.ev;
}

function invalidOf(raw: unknown): string {
  const result = fromReport("base", raw);
  if (!("invalid" in result)) throw new Error("expected invalid, got an evaluation");
  return result.invalid;
}

describe("fromReport: a report built with buildReport", () => {
  it("has the S and C of the report, recomputed from the trials", () => {
    const raw = reportOf();
    const ev = evOf(raw);

    expect(raw.S).toBeCloseTo(0.625, 9); // the report's own S, by hand
    expect(raw.C).toBeCloseTo(2000, 9);
    expect(ev.S).toBeCloseTo(raw.S, 9);
    expect(ev.C).toBeCloseTo(raw.C, 9);
    expect(ev).toMatchObject({ job: "base", k: 2, n_expected: raw.n_expected, missing: raw.missing });
  });

  it("reads the report object as it reads its JSON text", () => {
    const report = buildReport(header, tasks, "done");

    expect(fromReport("j", report)).toEqual(fromReport("j", JSON.parse(reportText(report))));
  });

  it("gives per task the rewards and tokens as they are, the weight once per reward, and the missing count", () => {
    expect(evOf(reportOf()).per_task).toEqual({
      laptop: { rewards: [1, 0], weights: [2, 2], tokens: [3500, 2400], missing: 0 },
      phone: { rewards: [1, 0], weights: [1, 1], tokens: [null, null], missing: 1 },
      tablet: { rewards: [0.5, 1], weights: [3, 3], tokens: [1100, 1000], missing: 0 },
    });
  });

  it("does not trust the report's own S and C: it recomputes them", () => {
    const raw = reportOf();
    raw.S = 0.99;
    raw.C = 1;
    const ev = evOf(raw);

    expect(ev.S).toBeCloseTo(0.625, 9);
    expect(ev.C).toBeCloseTo(2000, 9);
  });

  it("counts a missing trial as a reward of 0 with its weight, as the report does", () => {
    const ev = evOf(reportOf());

    expect(ev.per_task.phone.rewards[1]).toBe(0);
    expect(ev.per_task.phone.weights[1]).toBe(1);
    expect(ev.missing).toBe(1);
  });

  it("has no cost when the report has no token counts", () => {
    const raw = reportOf();
    for (const t of Object.values(raw.per_task)) t.tokens = (t.tokens as unknown[]).map(() => null);

    expect(evOf(raw).C).toBeNull();
  });

  it("reads a report with nothing but the fields it uses", () => {
    const ev = evOf({ status: "done", k: 2, per_task: { a: { weight: 1, rewards: [1, 0], tokens: [10, null], missing: 0 } } });

    expect(ev).toMatchObject({ S: 0.5, C: 10, n_expected: 2, k: 2 });
  });

  it("reads a done report with no task", () => {
    expect(evOf({ status: "done", k: 3, per_task: {} })).toMatchObject({ S: 0, C: null, n_expected: 0 });
  });
});

describe("fromReport: a report that is not done", () => {
  for (const status of ["running", "cancelled", "error"] as const) {
    it(`is invalid when its status is ${status}, and says so`, () => {
      const invalid = invalidOf(reportOf(status));

      expect(invalid).toContain(`"${status}"`);
      expect(invalid).toContain("did not finish");
    });
  }

  it("is invalid for a status that is not one of eval's, naming it", () => {
    const raw = reportOf();
    raw.status = "paused";

    expect(invalidOf(raw)).toContain('"paused"');
  });
});

describe("fromReport: a report that does not list the tasks it expects", () => {
  it("is invalid when it expects more trials than it lists, and says what it expects and what it has", () => {
    const raw = reportOf();
    raw.n_expected = 8;

    expect(invalidOf(raw)).toBe("the report expects 8 trials but lists 3 tasks of 2: a task is missing from per_task");
  });

  it("is invalid when it expects fewer trials than it lists, without saying a task is missing", () => {
    const raw = reportOf();
    raw.n_expected = 4;

    expect(invalidOf(raw)).toBe("the report expects 4 trials but lists 3 tasks of 2");
  });

  it("is invalid when a task is missing from per_task", () => {
    const raw = reportOf();
    Reflect.deleteProperty(raw.per_task, "tablet");

    expect(invalidOf(raw)).toBe("the report expects 6 trials but lists 2 tasks of 2: a task is missing from per_task");
  });

  it("says task, not tasks, for one", () => {
    const raw = reportOf();
    Reflect.deleteProperty(raw.per_task, "tablet");
    Reflect.deleteProperty(raw.per_task, "phone");

    expect(invalidOf(raw)).toContain("but lists 1 task of 2:");
  });

  it("checks the status first: a report that did not finish says so, whatever it lists", () => {
    const raw = reportOf("running");
    raw.n_expected = 99;

    expect(invalidOf(raw)).toContain("did not finish");
  });

  it("is valid with every task listed, whatever the trials: missing ones are still listed", () => {
    expect(evOf(reportOf()).n_expected).toBe(6); // 3 tasks of 2, one trial of which is missing
  });

  it("does not need n_expected: a report without it is read as it lists itself", () => {
    const raw = reportOf();
    Reflect.deleteProperty(raw, "n_expected");

    expect(evOf(raw).n_expected).toBe(6);
  });

  it("never scores a run on fewer tasks than it ran, for a task id that cannot be a key of per_task", () => {
    // A plain object cannot hold the key "__proto__": assigning it sets the prototype, and JSON leaves it out. `harness eval` keys
    // per_task that way, so its report for a task set with such a task counts the trials in S and n_expected but does not list the task.
    const withProto: TaskTrials[] = [...tasks, { id: "__proto__", weight: 1, trials: [trial(0, 0), trial(1, 0)] }];
    const raw = reportOf("done", withProto);
    const listed = Object.keys(raw.per_task).length;

    if (listed === withProto.length) expect(evOf(raw).n_expected).toBe(raw.n_expected); // a report that keeps the key
    else expect(invalidOf(raw)).toContain("a task is missing from per_task"); // the report as it is written today
  });
});

describe("fromReport: a report of the wrong shape", () => {
  /** The reason a report is invalid after the value at `path` is replaced by `value`, or removed when `value` is undefined. */
  function invalidWith(path: string[], value?: unknown): string {
    const raw = reportOf();
    let target: Record<string, unknown> = raw;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const last = path[path.length - 1];
    if (value === undefined) Reflect.deleteProperty(target, last);
    else target[last] = value;
    return invalidOf(raw);
  }

  it("is invalid for what is not an object", () => {
    for (const raw of [null, undefined, [], "report", 5, true]) expect(invalidOf(raw)).toContain("not a harness eval report");
  });

  it("is invalid without the fields it reads, naming the field", () => {
    expect(invalidWith(["status"])).toContain("status");
    expect(invalidWith(["k"])).toContain("k:");
    expect(invalidWith(["per_task"])).toContain("per_task");
    expect(invalidWith(["per_task", "laptop", "rewards"])).toContain("per_task.laptop.rewards");
    expect(invalidWith(["per_task", "laptop", "tokens"])).toContain("per_task.laptop.tokens");
    expect(invalidWith(["per_task", "laptop", "weight"])).toContain("per_task.laptop.weight");
    expect(invalidWith(["per_task", "laptop", "missing"])).toContain("per_task.laptop.missing");
  });

  it("is invalid for fields of the wrong type, naming where", () => {
    expect(invalidWith(["k"], 0)).toContain("k:");
    expect(invalidWith(["k"], 1.5)).toContain("k:");
    expect(invalidWith(["k"], "2")).toContain("k:");
    expect(invalidWith(["per_task"], [])).toContain("per_task");
    expect(invalidWith(["per_task", "laptop", "rewards"], [1, "x"])).toContain("per_task.laptop.rewards.1");
    expect(invalidWith(["per_task", "phone", "tokens"], [1, "x"])).toContain("per_task.phone.tokens.1");
    expect(invalidWith(["per_task", "tablet", "weight"], "3")).toContain("per_task.tablet.weight");
    expect(invalidWith(["per_task", "tablet", "missing"], -1)).toContain("per_task.tablet.missing");
    expect(invalidWith(["per_task", "tablet", "missing"], 0.5)).toContain("per_task.tablet.missing");
  });

  it("checks the shape before the status: a broken report says what is wrong with it", () => {
    const raw = reportOf("running");
    Reflect.deleteProperty(raw, "per_task");

    expect(invalidOf(raw)).toContain("not a harness eval report");
  });

  it("lists the first problems only, and counts the rest", () => {
    const raw = {
      status: "done", k: 2,
      per_task: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, { weight: "w", rewards: [], tokens: [], missing: 0 }])),
    };
    const invalid = invalidOf(raw);

    expect(invalid).toContain("and 15 more");
    expect(invalid.split(";")).toHaveLength(6);
  });
});
