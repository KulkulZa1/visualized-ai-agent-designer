// @vitest-environment node
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { calibrate } from "@/evolve/calibrate";
import type { HistoryRecord } from "@/evolve/history";
import { readJsonl } from "@/evolve/jsonl";
import { drive, parseVerdict, smokeProblem } from "@/evolve/loop";
import { fromReport } from "@/evolve/measure";
import { sha256 } from "@/evolve/state";
import {
  ACCEPT, EXCELLENT, WORKFLOW, cleanupWorlds, defaultBehaviour, edit, fenced, makeWorld, proposal, reject, tweak, type World, type WorldOptions,
} from "./loopFixture";

afterEach(cleanupWorlds);

/** What the history says of each candidate: `0A:ACCEPTED`. */
const outcomes = (w: World): string[] => w.history().map((r) => `${r.t}${r.variant}:${r.outcome}`);

/** One variant, one round, a fixed band: the smallest world in which a gate can be tested. */
const single = (cfg: WorldOptions["cfg"] = {}, options: Omit<WorldOptions, "cfg"> = {}): World =>
  makeWorld({ ...options, cfg: { T: 1, m: 1, repair_rounds: 0, delta: 0.1, ...cfg } });

/** The first record of the history that is about `variant` of round `t`. */
const record = (w: World, t: number, variant: string): HistoryRecord => {
  const found = w.history().find((r) => r.t === t && r.variant === variant);
  if (found === undefined) throw new Error(`no history record for ${t}${variant}`);
  return found;
};

// ── A full run ────────────────────────────────────────────────────────────────

describe("drive: a full run (T = 2, m = 2)", () => {
  it("plays the baseline, the band, two rounds and the held-out check, and prints the summary", async () => {
    const w = makeWorld({ smoke: true, heldout: true });

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 0 });
    expect(w.lines).toContain("baseline: S 0.500 C 1000 (6 runs, 9 min)");
    expect(w.lines).toContain("measuring a candidate takes about 9 min; a round about 2 × that, plus the proposer's and critic's runs");
    expect(w.lines.some((l) => /^noise band δ 0\.3\d\d \(bootstrap over the baseline's runs, z 2\) — a candidate must reach S\* − δ$/.test(l))).toBe(true);
    expect(w.lines).toContain("round 0/2: budget 4, stalled no, untried [prompt, config, control_flow, context_mgmt, memory, client_tool, subagent], prune []");
    expect(w.lines).toContain("  A: proposal 1 edit [prompt] → critic accept");
    expect(w.lines.find((l) => l.startsWith("  A: S 1.000 dS +0.500 dC +0.000 ν 0 → ACCEPTED: admissible: gain +0.5000 > delta"))).toBeDefined();
    expect(w.lines.find((l) => l.startsWith("  B: S 0.500 dS +0.000 dC +0.000 ν 0 → REJECTED: cost rule failed"))).toBeDefined();
    expect(w.lines).toContain("round 0: accepted A; S 1.000 C 1000, S* 1.000");
    expect(w.lines).toContain("round 1/2: budget 3, stalled no, untried [config, control_flow, context_mgmt, memory, client_tool, subagent], prune []");
    expect(w.lines).toContain("round 1: no admissible candidate; the incumbent stays (S 1.000 C 1000)");
    expect(w.lines).toContain("held-out: base S 0.000 C 1000; final S 1.000 C 1000");
    expect(w.lines.slice(w.lines.indexOf("summary:"))).toEqual([
      "summary:",
      "  base: S 0.500 C 1000",
      "  final: S 1.000 C 1000 (reached after 1 round)",
      "  best S* 1.000; 1 of 2 rounds accepted a candidate",
      "  held-out: base S 0.000 C 1000; final S 1.000 C 1000",
      `  result: ${join(w.outDir, "incumbent.harness.yaml")} — to use it, copy it over /user/workflow.harness.yaml`,
    ]);
  });

  it("asks the children in the order of the spec, with the folders and logs the plan names", async () => {
    const w = makeWorld({ smoke: true, heldout: true });

    await drive(w.ctx);

    const asked = w.children.evals.map((r) => `${w.children.rel(r.out)} ${r.split} k${r.k}`);
    expect(asked).toEqual([
      "base-smoke smoke k1", "base evolve k2",
      "r0/A/smoke smoke k1", "r0/B/smoke smoke k1", "r0/A/eval evolve k2", "r0/B/eval evolve k2",
      "r1/A/smoke smoke k1", "r1/B/smoke smoke k1", "r1/A/eval evolve k2", "r1/B/eval evolve k2",
      "heldout/base heldout k2", "heldout/final heldout k2",
    ]);
    expect(w.children.evals.every((r) => r.log === `${r.out}.log`)).toBe(true);
    expect(w.children.evals[1].workflow).toBe(join(w.outDir, "base.harness.yaml"));
    expect(w.children.evals[4].workflow).toBe(join(w.outDir, "r0", "A", "candidate.harness.yaml"));
    expect(w.children.workspaces("proposer")).toEqual(["r0/A/a0/proposer", "r0/B/a0/proposer", "r1/A/a0/proposer", "r1/B/a0/proposer"]);
    expect(w.children.workspaces("critic")).toEqual(["r0/A/a0/critic-0", "r0/B/a0/critic-0", "r1/A/a0/critic-0", "r1/B/a0/critic-0"]);
    const proposerRun = w.children.runs[0];
    expect(proposerRun).toMatchObject({ role: "proposer", workflow: "/search/proposer.harness.yaml" });
    expect(proposerRun.taskFile).toBe(join(w.outDir, "r0", "A", "a0", "proposer", "brief.md"));
    expect(proposerRun.log).toBe(join(w.outDir, "r0", "A", "a0", "proposer.log"));
    expect(w.children.runs[1]).toMatchObject({ role: "critic", workflow: "/search/critic.harness.yaml", log: join(w.outDir, "r0", "A", "a0", "critic-0.log") });
  });

  it("writes the frontier, the history, the attribution, the decisions and the convenience copy", async () => {
    const w = makeWorld({ smoke: true, heldout: true });
    await drive(w.ctx);

    const base = parseDocument(WORKFLOW).toString({ lineWidth: 0 });
    expect(w.read("base.harness.yaml")).toBe(base);
    const candidate = w.read("r0/A/candidate.harness.yaml");
    expect(candidate).toContain("content: Write the answer and be excellent.");

    const fr = w.frontier();
    expect(fr).toMatchObject({
      version: 1, S_star: 1, infra_streak: 0,
      base: { hash: sha256(base), S: 0.5, C: 1000 },
      incumbent: { t: 1, file: "r0/A/candidate.harness.yaml", hash: sha256(candidate), eval_dir: "r0/A/eval", S: 1, C: 1000, variant: "A" },
      heldout: { base: { S: 0, C: 1000 }, final: { S: 1, C: 1000, hash: sha256(candidate) } },
    });
    expect(fr.pins).toEqual(w.ctx.pins);
    expect(fr.trajectory).toEqual([
      { t: 0, S: 0.5, C: 1000, hash: sha256(base), eval_dir: "base" },
      { t: 1, S: 1, C: 1000, hash: sha256(candidate), eval_dir: "r0/A/eval" },
      { t: 2, S: 1, C: 1000, hash: sha256(candidate), eval_dir: "r0/A/eval" },
    ]);
    expect(w.read("incumbent.harness.yaml")).toBe(candidate);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED", "0B:REJECTED", "1A:REJECTED", "1B:REJECTED"]);
    expect(record(w, 0, "-")).toMatchObject({ edit_id: null, component: null, hypothesis: "H_0 baseline", S: 0.5, C: 1000, accepted: true, bundle: 0 });
    expect(record(w, 0, "A")).toMatchObject({
      edit_id: "C1", component: "prompt", targets_mode: "a failure in the traces", predicted_affected: ["task-beta"], diff: "r0/A/diff.txt",
      delta_S: 0.5, delta_C: 0, accepted: true, S: 1, C: 1000, bundle: 1,
    });
    expect(record(w, 0, "B")).toMatchObject({ accepted: false, delta_S: 0, S: 0.5, diff: "r0/B/diff.txt" });
    expect(record(w, 0, "B").detail).toContain("cost rule failed");

    const rows = readJsonl(join(w.outDir, "attribution.jsonl")) as Array<Record<string, unknown>>;
    expect(rows.map((r) => `${r.t}${r.variant}`)).toEqual(["0A", "0B", "1A", "1B"]);
    expect(rows[0]).toMatchObject({ edit_id: "C1", component: "prompt", n_predicted: 1, predicted_hit: ["task-beta"], hit_rate: 1, unpredicted_regressions: [] });
    expect(rows[1]).toMatchObject({ predicted_hit: [], hit_rate: 0 });

    const round0 = w.json("r0/decisions.json");
    expect(round0.winner).toBe("A");
    expect(round0.decisions.map((d: { variant: string; admissible: boolean }) => [d.variant, d.admissible])).toEqual([["A", true], ["B", false]]);
    expect(w.json("r1/decisions.json").winner).toBeNull();
  });

  it("keeps each variant's workspace, attempt, candidate and evaluation under its round", async () => {
    const w = makeWorld({ smoke: true });
    await drive(w.ctx);

    expect(w.json("r0/directives.json")).toMatchObject({ t: 0, b_t: 4, sigma_t: 0, tried: [], prune_set: [], S_star: 0.5, explore: { sigma: 0, m_draft: 1 } });
    expect(w.json("r0/directives.json").explore.untried).toContain("subagent");
    expect(w.read("r0/evidence/results.md")).toContain("| task-beta | 0.00 | 0.00 0.00 | says-ok | - |");
    // the worst trial of the two lowest tasks, and the best trial of the highest
    expect(w.exists("r0/evidence/traces/task-beta-t0.md")).toBe(true);
    expect(w.exists("r0/evidence/traces/task-alpha-t1.md")).toBe(true);
    expect(w.exists("r0/evidence/traces/task-gamma-t0.md")).toBe(true);
    expect(w.read("r0/evidence/traces/task-beta-t0.md")).toContain("- reward: 0.00");

    const workspace = "r0/A/a0/proposer";
    expect(w.read(`${workspace}/workflow.harness.yaml`)).toBe(w.read("base.harness.yaml"));
    expect(w.read(`${workspace}/brief.md`)).toContain("You are variant A of round 0. 2 variants are drafted independently");
    expect(w.exists(`${workspace}/evidence/results.md`)).toBe(true);
    expect(w.exists(`${workspace}/evidence/traces/task-beta-t0.md`)).toBe(true);
    expect(w.json(`${workspace}/evidence/history.json`)).toHaveLength(1);
    expect(w.json(`${workspace}/evidence/scoreboard.json`)).toEqual([]);
    expect(w.read("r0/A/a0/critic-0/review.md")).toContain("## The change");

    expect(w.read("r0/A/change.txt")).toContain("C1 [prompt] — why C1");
    expect(w.read("r0/A/diff.txt")).toContain("+      content: Write the answer and be excellent.");
    expect(w.exists("r0/A/smoke/report.json")).toBe(true);
    expect(w.exists("r0/A/eval/report.json")).toBe(true);

    const prep = w.json("r0/A/prep.json");
    expect(prep).toMatchObject({ file: "r0/A/candidate.harness.yaml", hash: sha256(w.read("r0/A/candidate.harness.yaml")), diff: "r0/A/diff.txt", summary: "a candidate" });
    expect(prep.edits).toHaveLength(1);
    expect(prep.edits[0]).toMatchObject({ id: "C1", component: "prompt", declared: "prompt", retagged: false, hypothesis: "why C1" });
    expect(prep.edits[0]).not.toHaveProperty("ops");
    expect(prep.gate_failure).toBeUndefined();

    expect(w.json("r0/A/a0/proposal.json")).toMatchObject({
      attempt: 0, error: null, objections: [], failure: null, critic: { verdict: "accept" },
      tokens: { proposer: { input: 100, output: 50 }, critic: { input: 100, output: 50 } },
    });
    expect(w.json("r0/A/a0/proposal.json").proposal.edits[0].ops[0].op).toBe("replace_text");
  });

  it("runs nothing when a finished run is run again, and prints the summary again", async () => {
    const w = makeWorld({ heldout: true });
    await drive(w.ctx);
    const evals = w.children.evals.length;
    const runs = w.children.runs.length;
    const history = w.read("history.jsonl");
    w.lines.length = 0;

    const again = await drive(w.ctx);

    expect(again).toEqual({ code: 0 });
    expect(w.children.evals.length).toBe(evals);
    expect(w.children.runs.length).toBe(runs);
    expect(w.read("history.jsonl")).toBe(history);
    expect(w.lines.some((l) => l.startsWith("noise band δ") && l.includes("(from calibration.json)"))).toBe(true);
    expect(w.lines).toContain("  final: S 1.000 C 1000 (reached after 1 round)");
    expect(w.lines.every((l) => !l.includes("measuring"))).toBe(true);
  });

  it("rewrites the convenience copy when it is gone", async () => {
    const w = makeWorld();
    await drive(w.ctx);
    rmSync(join(w.outDir, "incumbent.harness.yaml"));

    await drive(w.ctx);

    expect(w.read("incumbent.harness.yaml")).toBe(w.read("r0/A/candidate.harness.yaml"));
  });
});

// ── The noise band ────────────────────────────────────────────────────────────

describe("drive: the noise band", () => {
  it("is measured by a bootstrap over the baseline's runs, and saved in calibration.json", async () => {
    const w = single({ delta: null });
    await drive(w.ctx);

    const raw = w.json("base/report.json");
    const read = fromReport("base", raw);
    if (!("ev" in read)) throw new Error("the base report is not valid");
    const expected = calibrate([read.ev], 2);
    expect(w.json("calibration.json")).toMatchObject({ delta: expected.delta, jobs: ["base"], method: "bootstrap over trials of one base evaluation", n_evals: 1 });
    expect(w.json("r0/directives.json").delta).toBe(expected.delta);
  });

  it("is measured from R evaluations of the base workflow when --calibrate asks for them, each reused on a re-run", async () => {
    const w = single({ delta: null, calibrate: 3 });
    // the repeats of the base workflow score differently: the second is perfect
    w.children.onEval = (_request, info) => {
      w.children.behaviour.reward = info.dir === "calib-1" ? () => 1 : defaultBehaviour.reward;
      return undefined;
    };

    await drive(w.ctx);

    expect(w.children.evalDirs().slice(0, 3)).toEqual(["base", "calib-1", "calib-2"]);
    expect(w.json("calibration.json")).toMatchObject({
      jobs: ["base", "calib-1", "calib-2"], n_evals: 3, method: "repeated base evaluations", S_per_eval: [0.5, 1, 0.5],
    });
    expect(w.lines.some((l) => l.startsWith("noise band δ") && l.includes("(3 evaluations of the baseline, z 2)"))).toBe(true);

    const calls = w.children.evals.length;
    await drive(w.ctx);
    expect(w.children.evals.length).toBe(calls);
  });

  it("is measured again from the evaluations that were finished when a crash cut the calibration short", async () => {
    const w = single({ delta: null, calibrate: 2 });
    let fired = false;
    w.children.onEval = (_request, info) => {
      if (info.dir !== "calib-1" || fired) return undefined;
      fired = true;
      return { code: 130 };
    };

    expect(await drive(w.ctx)).toEqual({ code: 130 });
    expect(w.exists("calibration.json")).toBe(false);
    expect(w.exists("frontier.json")).toBe(true); // the baseline was settled before the band was measured
    expect(await drive(w.ctx)).toEqual({ code: 0 });

    expect(w.children.evalDirs().filter((d) => d === "base")).toHaveLength(1);
    expect(w.children.evalDirs().filter((d) => d === "calib-1")).toHaveLength(2);
    expect(w.json("calibration.json")).toMatchObject({ jobs: ["base", "calib-1"], n_evals: 2 });
    expect(outcomes(w).filter((o) => o.endsWith("BASELINE"))).toHaveLength(1);
  });

  it("is the one --delta gives, and then no calibration is written", async () => {
    const w = single({ delta: 0.25 });
    await drive(w.ctx);

    expect(w.exists("calibration.json")).toBe(false);
    expect(w.lines).toContain("noise band δ 0.250 (set by --delta) — a candidate must reach S* − δ");
    expect(w.json("r0/directives.json").delta).toBe(0.25);
  });

  it("is saved before the rounds, so that a crash in round 0 does not measure it again", async () => {
    const w = single({ delta: null, T: 2 });
    w.children.onRun = (request) => (w.children.rel(request.workspace) === "r1/A/a0/proposer" ? { code: 130, tokens: null } : undefined);
    expect((await drive(w.ctx)).code).toBe(130);
    const calibration = w.read("calibration.json");
    w.children.onRun = undefined;

    expect((await drive(w.ctx)).code).toBe(0);

    expect(w.read("calibration.json")).toBe(calibration);
    expect(w.children.evalDirs().filter((d) => d === "base")).toHaveLength(1);
  });

  it("warns, when no candidate was accepted and the band is wide, that more tasks or trials shrink it", async () => {
    const w = single({ delta: 0.5 });
    w.children.proposer = (info) => proposal(tweak(info.t, info.variant));

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:REJECTED"]);
    expect(w.lines).toContain("warning: no candidate was accepted, and the noise band δ 0.500 is wide: a candidate has to gain more than that. More tasks or more trials per task shrink it.");
  });

  it("does not warn when the band is narrow, or when a candidate was accepted", async () => {
    const narrow = single({ delta: 0.1 });
    narrow.children.proposer = (info) => proposal(tweak(info.t, info.variant));
    const accepted = single({ delta: 0.1 });

    await drive(narrow.ctx);
    await drive(accepted.ctx);

    expect(outcomes(narrow)).toEqual(["0-:BASELINE", "0A:REJECTED"]);
    expect(outcomes(accepted)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(narrow.lines.some((l) => l.startsWith("warning"))).toBe(false);
    expect(accepted.lines.some((l) => l.startsWith("warning"))).toBe(false);
  });
});

// ── The gates ─────────────────────────────────────────────────────────────────

describe("drive: a candidate that fails a gate is recorded and the round goes on", () => {
  it("no_proposal: no output, then garbage", async () => {
    const w = single({ repair_rounds: 1 });
    w.children.proposer = (info) => (info.attempt === 0 ? undefined : "I could not decide on an edit.");

    expect(await drive(w.ctx)).toEqual({ code: 0 });

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:no_proposal"]);
    expect(record(w, 0, "A")).toMatchObject({ edit_id: "C1", component: null, delta_S: null, accepted: false, S: null, diff: null, bundle: 0 });
    expect(record(w, 0, "A").detail).toContain('no JSON object with an "edits" array in the output');
    expect(w.json("r0/A/prep.json")).toMatchObject({ gate_failure: "no_proposal", edits: [], diff: null });
    expect(w.children.workspaces("critic")).toEqual([]);
    // the second attempt is told that there was no output
    const second = w.read("r0/A/a1/proposer/brief.md");
    expect(second).toContain("REPAIR ROUND");
    expect(second).toContain("the proposer produced no final output");
    expect(second).toContain("(no output)");
    expect(w.json("r0/A/a0/proposal.json")).toMatchObject({ proposal: null, failure: "no_proposal", error: "the proposer produced no final output" });
    expect(w.json("r0/A/a1/proposal.json").failure).toBe("no_proposal");
    expect(w.lines).toContain("  A: no proposal (repair 1/1): the proposer produced no final output");
    expect(w.lines.find((l) => l.startsWith("  A: no proposal (no repair left): no JSON object"))).toBeDefined();
  });

  it("no_proposal: says why a run that failed produced no output", async () => {
    const w = single();
    w.children.onRun = () => ({ code: 1, tokens: null, error: "the Writer failed" });

    await drive(w.ctx);

    expect(record(w, 0, "A").detail).toBe("the proposer produced no final output (the Writer failed)");
  });

  it("invalid_proposal: over the budget", async () => {
    const w = single({ b_max: 1 });
    w.children.proposer = () => proposal(EXCELLENT, edit("C2", [{ op: "set", agent: "Checker", field: "maxSteps", value: 4 }], { component: "config" }));

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:invalid_proposal", "0A:invalid_proposal"]);
    expect(record(w, 0, "A").detail).toBe("2 edits exceed the budget b_t = 1");
    const records = w.history().filter((r) => r.variant === "A");
    expect(records.map((r) => [r.edit_id, r.component, r.bundle])).toEqual([["C1", "prompt", 2], ["C2", "config", 2]]); // the edits, classified when they parsed
    expect(w.json("r0/A/prep.json").edits).toHaveLength(2);
    expect(w.children.workspaces("critic")).toEqual([]);
  });

  it("invalid_proposal: an agent that does not exist, and a key the schema does not know", async () => {
    const unknownAgent = single();
    unknownAgent.children.proposer = () => proposal(edit("C1", [{ op: "replace_text", agent: "Nobody", field: "prompt", old: "x", new: "y" }]));
    await drive(unknownAgent.ctx);

    const misspelled = single();
    misspelled.children.proposer = () => proposal(edit("C1", [{ op: "replace_text", agnet: "Writer", field: "prompt", old: "x", new: "y" }]));
    await drive(misspelled.ctx);

    expect(outcomes(unknownAgent)).toEqual(["0-:BASELINE", "0A:invalid_proposal"]);
    expect(record(unknownAgent, 0, "A").detail).toBe('edit C1, op 1 (replace_text): no agent is named "Nobody"; the agents are: "Writer", "Checker"');
    expect(record(unknownAgent, 0, "A").component).toBe("prompt"); // it parsed, so its edits were classified
    expect(outcomes(misspelled)).toEqual(["0-:BASELINE", "0A:invalid_proposal"]);
    expect(record(misspelled, 0, "A").detail).toContain('unknown key "agnet"');
    expect(record(misspelled, 0, "A").component).toBeNull(); // it did not parse
  });

  it("invalid_proposal: cannot remove an agent a scorer reads", async () => {
    const w = single();
    w.ctx.protectedAgents = new Map([["Checker", "the scorer says-ok reads its output (node:)"]]);
    w.children.proposer = () => proposal(edit("C1", [{ op: "remove_agent", agent: "Checker" }], { component: "subagent" }));

    await drive(w.ctx);

    expect(record(w, 0, "A").detail).toContain('agent "Checker" cannot be removed: the scorer says-ok reads its output (node:)');
  });

  it("critic_reject: by the precheck, before the critic is asked", async () => {
    const w = single();
    w.children.proposer = () => proposal(edit("C1", [{ op: "replace_text", agent: "Writer", field: "prompt", old: "Write the answer.", new: "Write the answer, as for task-beta." }]));

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:critic_reject"]);
    expect(record(w, 0, "A").detail).toBe('precheck: task id "task-beta" (task task-beta)');
    expect(w.children.workspaces("critic")).toEqual([]);
    expect(w.json("r0/A/a0/proposal.json")).toMatchObject({ failure: "critic_reject", objections: ['precheck: task id "task-beta" (task task-beta)'], critic: null });
  });

  it("critic_reject: by the critic, with its reasons and its risk notes", async () => {
    const w = single();
    w.children.critic = () => reject(["it names the tasks", "it is too narrow"], ["might break the Checker"]);

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:critic_reject"]);
    expect(record(w, 0, "A").detail).toBe("it names the tasks; it is too narrow; risk: might break the Checker");
    expect(record(w, 0, "A")).toMatchObject({ component: "prompt", edit_id: "C1", delta_S: null });
    expect(w.json("r0/A/a0/proposal.json").critic).toEqual({ verdict: "reject", reasons: ["it names the tasks", "it is too narrow"], risk_notes: ["might break the Checker"] });
    expect(w.exists("r0/A/candidate.harness.yaml")).toBe(false); // nothing was written for a candidate that did not pass
    expect(w.children.evalDirs()).toEqual(["base"]);
  });

  it("critic_reject: by output that cannot be read after 3 critic runs", async () => {
    const w = single();
    w.children.critic = () => "I think the change is fine.";

    await drive(w.ctx);

    expect(record(w, 0, "A").detail).toBe("critic output unparseable after 3 attempts: I think the change is fine.");
    expect(w.children.workspaces("critic")).toEqual(["r0/A/a0/critic-0", "r0/A/a0/critic-1", "r0/A/a0/critic-2"]);
    expect(w.exists("r0/A/a0/critic-2/review.md")).toBe(true);
  });

  it("takes the last verdict of the first critic run that has one, and sums the critic's tokens", async () => {
    const w = single();
    w.children.critic = (info) => (info.critic < 2 ? "hm" : `${reject(["a draft"])}\nOn reflection:\n${ACCEPT}`);

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(w.children.workspaces("critic")).toHaveLength(3);
    expect(w.json("r0/A/a0/proposal.json").tokens.critic).toEqual({ input: 300, output: 150 });
  });

  it("invalid_proposal: by the reserved slot, when a stalled run holds one for a variant, before any critic run", async () => {
    // round 0 changes nothing (S stays 0.5), so round 1 is stalled (w = 1); variant B holds the slot, and its prompt edit does not honour it
    const w = makeWorld({ cfg: { delta: 0.1, repair_rounds: 0 } });
    w.children.proposer = (info) => proposal(tweak(info.t, info.variant));

    await drive(w.ctx);

    expect(w.lines).toContain("round 1/2: budget 3, stalled yes, untried [config, control_flow, context_mgmt, memory, client_tool, subagent], prune [prompt]");
    expect(w.lines).toContain("  B: holds a reserved exploration slot");
    expect(w.lines).not.toContain("  A: holds a reserved exploration slot");
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:REJECTED", "0B:REJECTED", "1A:REJECTED", "1B:invalid_proposal"]);
    expect(w.exists("r1/B/a0/critic-0")).toBe(false); // the slot is checked before the critic
    expect(record(w, 1, "B").detail).toContain("this variant holds a reserved exploration slot");
    expect(record(w, 1, "B").detail).toContain("C1 = prompt");
    expect(w.read("r1/B/a0/proposer/brief.md")).toContain('RESERVED EXPLORATION SLOT: this variant holds one. At least one of your edits MUST be on a never-exercised component from: ["config"');
    expect(w.read("r1/A/a0/proposer/brief.md")).not.toContain("this variant holds one");
    expect(w.json("r1/directives.json")).toMatchObject({ sigma_t: 1, tried: ["prompt"] });
  });

  it("honours the reserved slot after a repair, by the operations", async () => {
    const w = makeWorld({ cfg: { delta: 0.1, repair_rounds: 1 } });
    w.children.proposer = (info) => proposal(info.t === 1 && info.variant === "B" && info.attempt === 1
      ? edit("C1", [{ op: "set", agent: "Checker", field: "maxSteps", value: 4 }], { component: "prompt" }) // declared as a prompt edit: the operations say config
      : tweak(info.t, info.variant));

    await drive(w.ctx);

    expect(outcomes(w)).toContain("1B:REJECTED");
    expect(record(w, 1, "B")).toMatchObject({ component: "config" }); // re-tagged from its operations
    expect(w.read("r1/B/a1/proposer/brief.md")).toContain("this variant holds a reserved exploration slot");
    expect(w.json("r1/B/prep.json").edits[0]).toMatchObject({ component: "config", declared: "prompt", retagged: true });
    expect(w.read("r1/B/a1/critic-0/review.md")).toContain("C1 [config] (declared prompt)");
    expect(w.lines).toContain("  B: edit C1 declared prompt but its operations make it config; re-tagged");
  });

  it("smoke_fail: a candidate whose smoke run ends in error is dropped before its evaluation", async () => {
    const w = single({}, { smoke: true });
    w.children.behaviour.trial = (text, _id, _trial, split) => (split === "smoke" && text.includes("be excellent") ? "error" : "done");

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:smoke_fail"]);
    expect(record(w, 0, "A").detail).toBe("task task-alpha: the Writer failed");
    expect(record(w, 0, "A")).toMatchObject({ component: "prompt", diff: "r0/A/diff.txt", delta_S: null });
    expect(w.children.evalDirs()).toEqual(["base-smoke", "base", "r0/A/smoke"]);
    expect(w.json("r0/A/prep.json")).toMatchObject({ gate_failure: "smoke_fail", detail: "task task-alpha: the Writer failed" });
    expect(w.exists("r0/A/candidate.harness.yaml")).toBe(true);
    expect(w.lines).toContain("  A: smoke check failed: task task-alpha: the Writer failed");
  });

  it("smoke_fail: also when the smoke evaluation itself is invalid", async () => {
    const w = single({}, { smoke: true });
    w.children.onEval = (request, info) => (info.dir === "r0/A/smoke" ? w.children.crash(request, "harness-core stopped") : undefined);

    await drive(w.ctx);

    expect(record(w, 0, "A").outcome).toBe("smoke_fail");
    expect(record(w, 0, "A").detail).toBe("the smoke evaluation ended error: harness-core stopped");
  });

  it("eval_invalid: an evaluation that crashed is not run again", async () => {
    const w = single();
    w.children.onEval = (request, info) => (info.dir === "r0/A/eval" ? w.children.crash(request, "harness-core stopped") : undefined);

    expect(await drive(w.ctx)).toEqual({ code: 0 });

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:eval_invalid"]);
    expect(record(w, 0, "A").detail).toBe("evaluation crashed: harness-core stopped");
    expect(record(w, 0, "A")).toMatchObject({ component: "prompt", diff: "r0/A/diff.txt", delta_S: null, S: null });
    expect(w.children.evalDirs()).toEqual(["base", "r0/A/eval"]);
    expect(w.json("r0/decisions.json").decisions[0]).toMatchObject({ variant: "A", admissible: false, reason: "eval_invalid" });
    expect(w.frontier().infra_streak).toBe(1);
    expect(readJsonl(join(w.outDir, "attribution.jsonl"))).toEqual([]);
  });

  it("eval_invalid: too many missing trials after one more try, the first kept in eval-failed/", async () => {
    const w = single();
    w.children.behaviour.trial = (text) => (text.includes("be excellent") ? "missing" : "done");

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:eval_invalid"]);
    expect(record(w, 0, "A").detail).toBe("6/6 trials missing (infrastructure) after a retry");
    expect(w.children.evalDirs()).toEqual(["base", "r0/A/eval", "r0/A/eval"]);
    expect(w.exists("r0/A/eval-failed/report.json")).toBe(true);
    expect(w.exists("r0/A/eval/report.json")).toBe(true);
    expect(w.lines).toContain("  A: 6 of 6 trials are missing (infrastructure); measuring once more");
  });

  it("measures a candidate normally when the retry has few enough missing trials", async () => {
    const w = single();
    let tries = 0;
    w.children.onEval = (_request, info) => {
      if (info.dir === "r0/A/eval") w.children.behaviour.trial = ++tries === 1 ? () => "missing" : () => "done"; // the first try loses every trial, the second none
      return undefined;
    };

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(w.children.evalDirs()).toEqual(["base", "r0/A/eval", "r0/A/eval"]);
    expect(w.json("r0/A/eval-failed/report.json").missing).toBe(6);
    expect(w.json("r0/A/eval/report.json").missing).toBe(0);
  });

  it("lets a trial or two go missing: that is not invalid below the fraction", async () => {
    const w = single({ invalid_missing_frac: 0.2 });
    w.children.behaviour.trial = (text, id, trial) => (text.includes("be excellent") && id === "task-beta" && trial === 0 ? "missing" : "done");

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]); // 1 of 6 missing is under 20%
    expect(w.children.evalDirs()).toEqual(["base", "r0/A/eval"]);
  });

  it("goes on when one variant fails a gate and another does not", async () => {
    const w = makeWorld({ cfg: { delta: 0.1, repair_rounds: 0, T: 1 } });
    w.children.proposer = (info) => (info.variant === "A" ? undefined : proposal(EXCELLENT));

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:no_proposal", "0B:ACCEPTED"]);
    expect(w.frontier().incumbent).toMatchObject({ t: 1, variant: "B", file: "r0/B/candidate.harness.yaml" });
    expect(w.frontier().infra_streak).toBe(0);
    expect(w.json("r0/decisions.json").winner).toBe("B");
  });

  it("calls a candidate LOST when it is admissible but another has the higher S", async () => {
    const w = makeWorld({ cfg: { delta: 0.1, repair_rounds: 0, T: 1 } });
    w.children.behaviour.reward = (text, id, trial) => (text.includes("be excellent") ? 1 : text.includes("be fine") ? 0.8 : (id === "task-gamma" ? 1 : trial === 0 && id === "task-alpha" ? 1 : 0));
    w.children.proposer = (info) => proposal(info.variant === "A"
      ? edit("C1", [{ op: "replace_text", agent: "Writer", field: "prompt", old: "Write the answer.", new: "Write the answer and be fine." }])
      : EXCELLENT);

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:LOST", "0B:ACCEPTED"]);
    expect(w.frontier().incumbent.variant).toBe("B");
  });
});

// ── Repair ────────────────────────────────────────────────────────────────────

describe("drive: repair", () => {
  it("sends the objections and the previous proposal with the second attempt, and accepts the repaired one", async () => {
    const w = single({ repair_rounds: 1, b_max: 1 });
    w.children.proposer = (info) => (info.attempt === 0
      ? proposal(edit("C1", [{ op: "set", agent: "Checker", field: "maxSteps", value: 5 }], { hypothesis: "a distinctive first hypothesis" }), edit("C2", [{ op: "set", agent: "Checker", field: "maxTokens", value: 900 }]))
      : proposal(EXCELLENT));

    await drive(w.ctx);

    const first = w.read("r0/A/a0/proposer/brief.md");
    const second = w.read("r0/A/a1/proposer/brief.md");
    expect(first).not.toContain("REPAIR ROUND");
    expect(second).toContain("REPAIR ROUND: your previous proposal is below; the objections follow. Send the whole corrected proposal; it is applied to the current workflow from scratch.");
    expect(second).toContain("### Objections\n\n- 2 edits exceed the budget b_t = 1");
    expect(second).toContain("a distinctive first hypothesis");
    expect(second).toContain('"id": "C2"');
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(w.json("r0/A/a0/proposal.json")).toMatchObject({ failure: "invalid_proposal", objections: ["2 edits exceed the budget b_t = 1"] });
    expect(w.json("r0/A/a1/proposal.json")).toMatchObject({ failure: null, objections: [] });
    expect(w.lines).toContain("  A: proposal 2 edits [config, config] → invalid (repair 1/1): 2 edits exceed the budget b_t = 1");
    expect(w.lines).toContain("  A: proposal 1 edit [prompt] → critic accept");
    // a repaired proposal is applied to the incumbent from scratch
    expect(w.read("r0/A/candidate.harness.yaml")).not.toContain("maxSteps: 5");
  });

  it("carries the critic's reasons and risk notes into the repair brief", async () => {
    const w = single({ repair_rounds: 1 });
    w.children.critic = (info) => (info.attempt === 0 ? reject(["too specific"], ["may hurt the Checker"]) : ACCEPT);

    await drive(w.ctx);

    const second = w.read("r0/A/a1/proposer/brief.md");
    expect(second).toContain("- too specific");
    expect(second).toContain("- risk: may hurt the Checker");
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(w.json("r0/A/a0/proposal.json").failure).toBe("critic_reject");
    expect(w.lines).toContain("  A: proposal 1 edit [prompt] → critic reject (repair 1/1): too specific");
  });

  it("shows the first 2000 characters of an output that was not a proposal", async () => {
    const w = single({ repair_rounds: 1 });
    w.children.proposer = (info) => (info.attempt === 0 ? `${"x".repeat(1999)}YZ and more` : proposal(EXCELLENT));

    await drive(w.ctx);

    const second = w.read("r0/A/a1/proposer/brief.md");
    expect(second).toContain("### Your previous output (it could not be read as a proposal; the first 2000 characters)");
    expect(second).toContain(`${"x".repeat(1999)}Y`);
    expect(second).not.toContain("YZ");
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
  });

  it("gives the last failure kind when the attempts run out", async () => {
    const w = single({ repair_rounds: 2 });
    w.children.proposer = (info) => (info.attempt === 0 ? undefined : info.attempt === 1 ? proposal(edit("C1", [{ op: "replace_text", agent: "Nobody", field: "prompt", old: "x", new: "y" }])) : proposal(EXCELLENT));
    w.children.critic = () => reject(["no"]);

    await drive(w.ctx);

    expect(w.json("r0/A/a0/proposal.json").failure).toBe("no_proposal");
    expect(w.json("r0/A/a1/proposal.json").failure).toBe("invalid_proposal");
    expect(w.json("r0/A/a2/proposal.json").failure).toBe("critic_reject");
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:critic_reject"]);
    expect(record(w, 0, "A").detail).toBe("no");
    expect(w.children.workspaces("proposer")).toHaveLength(3);
  });

  it("cuts the detail of a gate failure to 600 characters", async () => {
    const w = single();
    w.children.critic = () => reject(["r".repeat(1000)]);

    await drive(w.ctx);

    expect(w.json("r0/A/prep.json").detail).toHaveLength(600);
    expect(record(w, 0, "A").detail).toHaveLength(600);
  });
});

// ── Resume ────────────────────────────────────────────────────────────────────

/** Everything a run leaves that two runs of the same inputs must agree on (history timestamps aside). */
function snapshot(w: World) {
  const withoutTime = ({ ts, ...rest }: HistoryRecord) => rest;
  return {
    frontier: w.frontier(),
    history: w.history().map(withoutTime),
    attribution: readJsonl(join(w.outDir, "attribution.jsonl")),
    decisions: ["r0", "r1"].map((r) => w.json(`${r}/decisions.json`)),
    incumbent: w.read("incumbent.harness.yaml"),
    base: w.read("base.harness.yaml"),
  };
}

const fullWorld = (): World => makeWorld({ smoke: true, heldout: true });

/** A step of the run, and the folder it works in: only the calls under `scope` may be made twice. */
const POINTS = [
  { name: "the baseline", kind: "eval", match: "base", scope: "base" },
  { name: "the base workflow's smoke check", kind: "eval", match: "base-smoke", scope: "base-smoke" },
  { name: "a proposer run", kind: "run", match: "r0/B/a0/proposer", scope: "r0/B" },
  { name: "a critic run", kind: "run", match: "r0/B/a0/critic-0", scope: "r0/B" },
  { name: "a candidate's smoke check", kind: "eval", match: "r0/B/smoke", scope: "r0/B" },
  { name: "a candidate's evaluation", kind: "eval", match: "r0/B/eval", scope: "r0/B/eval" },
  { name: "a proposer run of the next round", kind: "run", match: "r1/A/a0/proposer", scope: "r1/A" },
  { name: "the held-out evaluation of the base workflow", kind: "eval", match: "heldout/base", scope: "heldout/base" },
  { name: "the held-out evaluation of the final workflow", kind: "eval", match: "heldout/final", scope: "heldout/final" },
] as const;

describe("drive: resume after a crash or Ctrl+C at each step", () => {
  let reference: ReturnType<typeof snapshot>;
  beforeAll(async () => {
    const w = fullWorld();
    await drive(w.ctx);
    reference = snapshot(w);
  });

  describe.each(POINTS)("at $name", (point) => {
    it.each(["throws", "exits with 130"] as const)("when the child %s, the next drive finishes as an uninterrupted run does, and redoes only that step", async (how) => {
      const w = fullWorld();
      let fired = false;
      const hit = (): boolean => {
        if (fired) return false;
        fired = true;
        if (how === "throws") throw new Error("the child crashed");
        return true;
      };
      w.children.onEval = (_request, info) => (info.dir === point.match && point.kind === "eval" && hit() ? { code: 130 } : undefined);
      w.children.onRun = (request) => (w.children.rel(request.workspace) === point.match && point.kind === "run" && hit() ? { code: 130, tokens: null } : undefined);

      const first = await drive(w.ctx);

      expect(fired).toBe(true);
      if (how === "throws") expect(first).toEqual({ code: 3, error: "unexpected error: the child crashed" });
      else expect(first).toEqual({ code: 130 });

      w.children.onEval = undefined;
      w.children.onRun = undefined;
      expect(await drive(w.ctx)).toEqual({ code: 0 });

      expect(snapshot(w)).toEqual(reference);
      // no history record twice, and nothing run again except the step that was cut short (and what it drafts)
      const keys = w.history().map((r) => `${r.t}${r.variant}${r.edit_id}`);
      expect(new Set(keys).size).toBe(keys.length);
      const calls = new Map<string, number>();
      for (const key of [...w.children.evalDirs(), ...w.children.workspaces("proposer"), ...w.children.workspaces("critic")]) calls.set(key, (calls.get(key) ?? 0) + 1);
      for (const [key, n] of calls) {
        if (key === point.scope || key.startsWith(`${point.scope}/`)) expect(n, key).toBeLessThanOrEqual(2);
        else expect(n, key).toBe(1);
      }
      expect(calls.get(point.match)).toBe(2);
    }, 30000);
  });

  it("stops before the next child when Ctrl+C was pressed during the last one, and resumes", async () => {
    const w = fullWorld();
    w.children.onEval = (_request, info) => {
      if (info.dir === "r0/A/smoke") w.state.interrupted = true;
      return undefined;
    };

    expect(await drive(w.ctx)).toEqual({ code: 130 });

    expect(w.children.workspaces("proposer")).toEqual(["r0/A/a0/proposer"]); // variant B was not started
    expect(w.exists("r0/A/prep.json")).toBe(true);
    expect(w.exists("r0/B/prep.json")).toBe(false);
    w.state.interrupted = false;
    w.children.onEval = undefined;
    expect(await drive(w.ctx)).toEqual({ code: 0 });
    expect(snapshot(w)).toEqual(reference);
    expect(w.children.workspaces("proposer").filter((p) => p === "r0/A/a0/proposer")).toHaveLength(1); // A's drafted candidate was kept
  });

  it("makes no call at all when Ctrl+C was pressed before the first", async () => {
    const w = fullWorld();
    w.state.interrupted = true;

    expect(await drive(w.ctx)).toEqual({ code: 130 });

    expect(w.children.evals).toEqual([]);
    expect(w.exists("frontier.json")).toBe(false);
    w.state.interrupted = false;
    expect(await drive(w.ctx)).toEqual({ code: 0 });
    expect(snapshot(w)).toEqual(reference);
  });

  it("drafts a variant again from an empty folder when it has no prep.json", async () => {
    const w = fullWorld();
    w.children.onRun = (request) => (w.children.rel(request.workspace) === "r0/B/a0/critic-0" ? { code: 130, tokens: null } : undefined);
    await drive(w.ctx);
    writeFileSync(join(w.outDir, "r0", "B", "stale.txt"), "left by the draft that was cut short");
    expect(w.exists("r0/B/a0/proposal.json")).toBe(false); // the attempt did not get so far
    w.children.onRun = undefined;

    await drive(w.ctx);

    expect(w.exists("r0/B/stale.txt")).toBe(false);
    expect(snapshot(w)).toEqual(reference);
  });

  it("uses a candidate that was drafted before the crash as it was, and measures it", async () => {
    const w = fullWorld();
    w.children.onRun = (request) => (w.children.rel(request.workspace) === "r0/B/a0/proposer" ? { code: 130, tokens: null } : undefined);
    await drive(w.ctx);
    const prep = w.read("r0/A/prep.json");
    const candidate = w.read("r0/A/candidate.harness.yaml");
    w.children.onRun = undefined;

    await drive(w.ctx);

    expect(w.read("r0/A/prep.json")).toBe(prep);
    expect(w.read("r0/A/candidate.harness.yaml")).toBe(candidate);
    expect(w.lines).toContain("  A: drafted before");
  });

  it("drafts a variant again when its candidate file is not the one prep.json hashed", async () => {
    const w = fullWorld();
    w.children.onRun = (request) => (w.children.rel(request.workspace) === "r0/B/a0/proposer" ? { code: 130, tokens: null } : undefined);
    await drive(w.ctx);
    appendFileSync(join(w.outDir, "r0", "A", "candidate.harness.yaml"), "# edited by hand\n");
    w.children.onRun = undefined;

    await drive(w.ctx);

    expect(w.children.workspaces("proposer").filter((p) => p === "r0/A/a0/proposer")).toHaveLength(2);
    expect(snapshot(w)).toEqual(reference);
  });

  it("does not use a finished report of another workflow, task set or setting", async () => {
    // a run that stopped before its frontier: the folder holds base-smoke/ and base/ of a workflow that has since been edited
    const first = makeWorld({ smoke: true });
    await drive(first.ctx);
    for (const name of ["frontier.json", "history.jsonl", "attribution.jsonl", "calibration.json", "incumbent.harness.yaml", "r0", "r1"]) {
      rmSync(join(first.outDir, name), { recursive: true, force: true });
    }
    const edited = WORKFLOW.replace("Write the answer.", "Write the answer carefully.");
    const evalsBefore = first.children.evals.length;
    first.ctx.workflowText = edited;
    first.ctx.pins = { ...first.ctx.pins, workflow: { ...first.ctx.pins.workflow, hash: sha256(edited) } };

    await drive(first.ctx);

    const asked = first.children.evalDirs().slice(evalsBefore);
    expect(asked.slice(0, 2)).toEqual(["base-smoke", "base"]); // both measured again
    expect(first.read("base.harness.yaml")).toContain("Write the answer carefully.");
    expect(first.lines.some((l) => l.includes("its report is of another workflow, task set or setting; measuring again"))).toBe(true);
  });

  it("uses the finished reports of a baseline that was cut short before its frontier, when nothing changed", async () => {
    const first = makeWorld({ smoke: true });
    await drive(first.ctx);
    for (const name of ["frontier.json", "history.jsonl", "attribution.jsonl", "calibration.json", "incumbent.harness.yaml", "r0", "r1"]) {
      rmSync(join(first.outDir, name), { recursive: true, force: true });
    }
    const evalsBefore = first.children.evals.length;

    await drive(first.ctx);

    const asked = first.children.evalDirs().slice(evalsBefore);
    expect(asked).not.toContain("base");
    expect(asked).not.toContain("base-smoke");
    expect(outcomes(first)[0]).toBe("0-:BASELINE");
  });
});

describe("drive: a round whose records were written but not its frontier", () => {
  /** A finished one-round run in which A is accepted only because it is novel: it adds a tool, which changes nothing the fake policy reads. */
  async function novelWinner(): Promise<World> {
    const w = single({ delta: 0.1 });
    w.children.proposer = () => proposal(edit("C1", [{ op: "add_tool", agent: "Checker", tool: "list_files" }], { component: "client_tool" }));
    await drive(w.ctx);
    return w;
  }

  /** The frontier as it was before the round settled. */
  function unsettle(w: World): void {
    const fr = w.frontier();
    const base = fr.trajectory[0];
    writeFileSync(join(w.outDir, "frontier.json"), JSON.stringify({
      ...fr, S_star: base.S, trajectory: [base], incumbent: { t: 0, file: "base.harness.yaml", hash: base.hash, eval_dir: "base", S: base.S, C: base.C },
    }));
  }

  it("settles on the winner it recorded: this round's own records do not change the novelty term", async () => {
    const w = await novelWinner();
    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(record(w, 0, "A").detail).toContain("nu=1"); // admissible by novelty alone
    const before = snapshot2(w);
    unsettle(w);

    expect(await drive(w.ctx)).toEqual({ code: 0 });

    expect(snapshot2(w)).toEqual(before);
    expect(w.children.evalDirs()).toEqual(["base", "r0/A/eval"]); // nothing measured again
    expect(w.children.workspaces("proposer")).toHaveLength(1);
  });

  it("adds a history record once: the attribution rows are not written twice when only the history record is missing", async () => {
    const w = await novelWinner();
    const lines = w.read("history.jsonl").trimEnd().split("\n");
    writeFileSync(join(w.outDir, "history.jsonl"), `${lines.slice(0, -1).join("\n")}\n`); // the crash came before the candidate's record
    unsettle(w);

    await drive(w.ctx);

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(readJsonl(join(w.outDir, "attribution.jsonl"))).toHaveLength(1);
  });

  it("writes the baseline record when a crash came between the frontier and it", async () => {
    const w = single();
    await drive(w.ctx);
    const lines = w.read("history.jsonl").trimEnd().split("\n");
    writeFileSync(join(w.outDir, "history.jsonl"), `${lines.slice(1).join("\n")}\n`); // without the BASELINE record

    await drive(w.ctx);

    expect(outcomes(w).filter((o) => o.endsWith("BASELINE"))).toEqual(["0-:BASELINE"]);
  });

  function snapshot2(w: World) {
    const withoutTime = ({ ts, ...rest }: HistoryRecord) => rest;
    return {
      frontier: w.frontier(), history: w.history().map(withoutTime), attribution: readJsonl(join(w.outDir, "attribution.jsonl")),
      decisions: w.json("r0/decisions.json"), incumbent: w.read("incumbent.harness.yaml"),
    };
  }
});

// ── The pins and the files of the run ─────────────────────────────────────────

describe("drive: a folder that holds a run", () => {
  it("stops with exit 2, saying what differs, when the settings are not the run's", async () => {
    const w = single();
    await drive(w.ctx);
    const calls = w.children.evals.length;
    const other = {
      ...w.ctx,
      pins: {
        ...w.ctx.pins,
        taskSet: { ...w.ctx.pins.taskSet, hash: "another-hash" },
        provider: { ...w.ctx.pins.provider, model: "bigger-model" },
        config: { ...w.ctx.pins.config, beta1: 12.5 },
      },
    };

    const result = await drive(other);

    expect(result).toEqual({
      code: 2,
      error: "this folder holds a run with different settings: task set (hash); model (fake-model → bigger-model); config: beta1 (40 → 12.5); use a new --out",
    });
    expect(w.children.evals.length).toBe(calls);
  });

  it("stops with exit 2 when the incumbent's file was changed", async () => {
    const w = single();
    await drive(w.ctx);
    appendFileSync(join(w.outDir, "r0", "A", "candidate.harness.yaml"), "# a hand edit\n");

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 2, error: "r0/A/candidate.harness.yaml changed since round 0 accepted it; restore it or use a new --out" });
  });

  it("stops with exit 2 before the held-out check when the baseline file was changed", async () => {
    const w = single({ delta: 0.1 }, { heldout: true });
    await drive(w.ctx);
    rmSync(join(w.outDir, "heldout"), { recursive: true });
    writeFileSync(join(w.outDir, "frontier.json"), JSON.stringify({ ...w.frontier(), heldout: undefined })); // the check has not run
    appendFileSync(join(w.outDir, "base.harness.yaml"), "# a hand edit\n");

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 2, error: "base.harness.yaml changed since the baseline; restore it or use a new --out" });
    expect(w.children.evalDirs().filter((d) => d.startsWith("heldout"))).toEqual(["heldout/base", "heldout/final"]); // only the first run's
  });

  it("stops with exit 2 before measuring the band again when the baseline file was changed", async () => {
    const w = single({ delta: null });
    await drive(w.ctx);
    rmSync(join(w.outDir, "calibration.json"));
    appendFileSync(join(w.outDir, "base.harness.yaml"), "# a hand edit\n");
    const calls = w.children.evals.length;

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 2, error: "base.harness.yaml changed since the baseline; restore it or use a new --out" });
    expect(w.children.evals.length).toBe(calls); // base/ was not measured over
  });

  it("stops with exit 2 when the incumbent's file is gone", async () => {
    const w = single();
    await drive(w.ctx);
    rmSync(join(w.outDir, "r0", "A", "candidate.harness.yaml"));

    expect(await drive(w.ctx)).toEqual({ code: 2, error: "r0/A/candidate.harness.yaml is missing; restore it or use a new --out" });
  });

  it("stops with exit 2 when a stored path leads out of the run's folder, and reads nothing there", async () => {
    const w = single();
    await drive(w.ctx);
    const outside = join(w.outDir, "..", "evolve-outside.yaml");
    writeFileSync(outside, w.read("r0/A/candidate.harness.yaml")); // the same text, so that its hash would match
    try {
      const fr = w.frontier();
      writeFileSync(join(w.outDir, "frontier.json"), JSON.stringify({ ...fr, incumbent: { ...fr.incumbent, file: "../evolve-outside.yaml" } }));

      const result = await drive(w.ctx);

      expect(result.code).toBe(2);
      expect(result.error).toContain("../evolve-outside.yaml leads out of the run's folder");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("stops with exit 2 when the frontier is not one", async () => {
    const w = single();
    await drive(w.ctx);
    writeFileSync(join(w.outDir, "frontier.json"), "{ not json");

    const result = await drive(w.ctx);

    expect(result.code).toBe(2);
    expect(result.error).toContain("is not JSON");
    expect(result.error).toContain("use a new --out");
  });

  it("stops with exit 2 when the incumbent's evaluation is gone", async () => {
    const w = single({ T: 2 });
    w.children.onRun = (request) => (w.children.rel(request.workspace) === "r1/A/a0/proposer" ? { code: 130, tokens: null } : undefined);
    expect((await drive(w.ctx)).code).toBe(130); // round 0 is settled, round 1 is not
    rmSync(join(w.outDir, "r0", "A", "eval", "report.json"));

    const result = await drive(w.ctx);

    expect(result.code).toBe(2);
    expect(result.error).toContain("the evaluation of the incumbent (r0/A/eval) cannot be used");
  });
});

// ── Exit 3, and the exit codes of the children ────────────────────────────────

describe("drive: exit codes", () => {
  it("3 for a baseline that crashed, and no frontier is written", async () => {
    const w = single();
    w.children.onEval = (request) => w.children.crash(request, "harness-core is gone");

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 3, error: "the baseline is invalid: evaluation crashed: harness-core is gone" });
    expect(w.exists("frontier.json")).toBe(false);
  });

  it("3 for a baseline with too many missing trials", async () => {
    const w = single();
    w.children.behaviour.trial = () => "missing";

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 3, error: "the baseline is invalid: 6 of 6 trials are missing, more than the 15% that invalid_missing_frac allows" });
  });

  it("3 for a base workflow that fails its own smoke tasks", async () => {
    const w = single({}, { smoke: true });
    w.children.behaviour.trial = (_text, _id, _trial, split) => (split === "smoke" ? "error" : "done");

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 3, error: "the workflow fails its own smoke tasks: task task-alpha: the Writer failed" });
    expect(w.children.evalDirs()).toEqual(["base-smoke"]);
  });

  it("3 for a proposer run that did not start, and 3 for a critic run that did not", async () => {
    const proposer = single();
    proposer.children.onRun = () => ({ code: 3, tokens: null, error: "ollama is not running" });
    const critic = single();
    critic.children.onRun = (request) => (request.role === "critic" ? { code: 3, tokens: null, error: "no such model" } : undefined);

    expect(await drive(proposer.ctx)).toEqual({ code: 3, error: "the proposer run did not start: ollama is not running" });
    expect(await drive(critic.ctx)).toEqual({ code: 3, error: "the critic run did not start: no such model" });
    expect(proposer.history().map((r) => r.outcome)).toEqual(["BASELINE"]); // nothing of the round was recorded
  });

  it("3 after three rounds in a row in which every candidate's evaluation was invalid, and a re-run goes on", async () => {
    const w = makeWorld({ cfg: { T: 5, m: 2, delta: 0.1, repair_rounds: 0 } });
    w.children.onEval = (request, info) => (/^r\d\/[AB]\/eval$/.test(info.dir) ? w.children.crash(request, "the model server is down") : undefined);

    const result = await drive(w.ctx);

    expect(result).toEqual({ code: 3, error: "three rounds in a row ended with every candidate's evaluation invalid; check the model server" });
    expect(w.frontier().infra_streak).toBe(3);
    expect(w.frontier().trajectory).toHaveLength(4);
    expect(w.exists("r3")).toBe(false);
    expect(outcomes(w).filter((o) => o.endsWith("eval_invalid"))).toHaveLength(6);

    w.children.onEval = undefined; // the server is back
    expect(await drive(w.ctx)).toEqual({ code: 0 });
    expect(w.frontier().infra_streak).toBe(0);
    expect(w.frontier().trajectory).toHaveLength(6);
  });

  it("resets the streak when some candidate was not invalid", async () => {
    const w = makeWorld({ cfg: { T: 4, m: 2, delta: 0.1, repair_rounds: 0 } });
    w.children.onEval = (request, info) => (/^r[0-2]\/A\/eval$/.test(info.dir) ? w.children.crash(request, "down") : undefined);
    w.children.proposer = (info) => proposal(tweak(info.t, info.variant));

    expect(await drive(w.ctx)).toEqual({ code: 0 }); // B of each round is measured, so no round has them all invalid
    expect(w.frontier().infra_streak).toBe(0);
  });

  it("2 when a child exits 2, whichever child", async () => {
    const eval2 = single();
    eval2.children.onEval = () => ({ code: 2 });
    const run2 = single();
    run2.children.onRun = () => ({ code: 2, tokens: null, error: "a usage problem" });

    const evalResult = await drive(eval2.ctx);
    const runResult = await drive(run2.ctx);

    expect(evalResult.code).toBe(2);
    expect(evalResult.error).toContain("harness eval exited with code 2");
    expect(runResult.code).toBe(2);
    expect(runResult.error).toContain("the proposer run exited with code 2");
    expect(runResult.error).toContain("a usage problem");
  });

  it("3 when an eval exits 3 and left no report, for example when harness-core is missing", async () => {
    const w = single();
    w.children.onEval = () => ({ code: 3 });

    const result = await drive(w.ctx);

    expect(result.code).toBe(3);
    expect(result.error).toContain("harness eval left no report (exit code 3)");
    expect(result.error).toContain("base.log");
  });

  it("takes a run whose agent failed (exit 1) as a normal attempt, whose output may still parse", async () => {
    const w = single();
    w.children.onRun = (request) => (request.role === "proposer" ? { code: 1, finalOutput: proposal(EXCELLENT), tokens: null, error: "the Checker failed" } : undefined);

    expect(await drive(w.ctx)).toEqual({ code: 0 });

    expect(outcomes(w)).toEqual(["0-:BASELINE", "0A:ACCEPTED"]);
    expect(w.json("r0/A/a0/proposal.json").tokens.proposer).toBeNull();
  });

  it("3, naming the error, when something unexpected goes wrong", async () => {
    const w = single();
    w.children.onEval = () => {
      throw new Error("boom");
    };

    expect(await drive(w.ctx)).toEqual({ code: 3, error: "unexpected error: boom" });
  });
});

// ── The helpers, on their own ─────────────────────────────────────────────────

describe("smokeProblem", () => {
  const report = (perTask: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ status: "done", per_task: perTask, ...extra });
  const trials = (...list: Array<Record<string, unknown>>) => ({ trials: list });

  it("is undefined for a finished smoke evaluation whose trials all ran", () => {
    expect(smokeProblem(report({ a: trials({ missing: false, runStatus: "done" }), b: trials({ missing: false, runStatus: "done" }) }))).toBeUndefined();
  });

  it("says how a smoke evaluation that did not finish ended", () => {
    expect(smokeProblem({ status: "error", error: "harness-core stopped" })).toBe("the smoke evaluation ended error: harness-core stopped");
    expect(smokeProblem({ status: "cancelled" })).toBe("the smoke evaluation ended cancelled: no reason given");
  });

  it("names the first task with a missing trial or a run that ended in error, and why", () => {
    expect(smokeProblem(report({ a: trials({ runStatus: "done" }), b: trials({ runStatus: "done" }, { runStatus: "error", error: "the Writer\nfailed" }), c: trials({ missing: true }) })))
      .toBe("task b: the Writer failed");
    expect(smokeProblem(report({ a: trials({ missing: true, error: "no model" }) }))).toBe("task a: no model");
    expect(smokeProblem(report({ a: trials({ missing: true }) }))).toBe("task a: the trial is missing");
    expect(smokeProblem(report({ a: trials({ runStatus: "error" }) }))).toBe("task a: the run ended in error");
  });

  it("reports what is not a report", () => {
    expect(smokeProblem(undefined)).toBe("the smoke evaluation left no report");
    expect(smokeProblem([1, 2])).toBe("the smoke evaluation left no report");
  });
});

describe("parseVerdict", () => {
  it("reads a fenced verdict, with its reasons and risk notes", () => {
    expect(parseVerdict(fenced({ verdict: "reject", reasons: ["a", "b"], risk_notes: ["c"] }))).toEqual({ verdict: "reject", reasons: ["a", "b"], risk_notes: ["c"] });
  });

  it("takes the last object that has a verdict of accept or reject", () => {
    const text = `${fenced({ verdict: "reject", reasons: ["draft"] })}\n${fenced({ note: "not a verdict" })}\n${fenced({ verdict: "maybe" })}\n${fenced({ verdict: "accept" })}`;
    expect(parseVerdict(text)).toEqual({ verdict: "accept", reasons: [], risk_notes: [] });
  });

  it("makes the reasons and risk notes lists of strings", () => {
    expect(parseVerdict('{"verdict": "reject", "reasons": "only one", "risk_notes": [1, "two", {"k": 3}, ""]}')).toEqual({
      verdict: "reject", reasons: ["only one"], risk_notes: ["1", "two", '{"k":3}'],
    });
    expect(parseVerdict('{"verdict": "accept", "reasons": null}')).toEqual({ verdict: "accept", reasons: [], risk_notes: [] });
  });

  it("is undefined when there is no verdict", () => {
    expect(parseVerdict("")).toBeUndefined();
    expect(parseVerdict("I accept this change.")).toBeUndefined();
    expect(parseVerdict(fenced({ verdict: "ok" }))).toBeUndefined();
  });
});
