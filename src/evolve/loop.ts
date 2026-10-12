// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The loop of `harness evolve` (spec §4.2 to §6; rrsi/loop.py and rrsi/driver.py): the baseline, the noise band, the rounds and the
 * held-out check. Every measurement is a `harness eval` and every proposer or critic run a `harness run`, both behind the injected
 * `Children`, so the loop starts no process and calls no model; the only files it touches are in the run's folder. It does not take
 * the folder's lock: the command does (`acquireLock` and `releaseLock` of state.ts), around `drive`.
 *
 * Crash and resume. A step writes its result once, whole, as its last act, and a re-run redoes whatever has no result:
 * - `prep.json` (a variant's drafted candidate, or the gate it failed), `decisions.json` and `frontier.json` are written atomically, so a
 *   step that was cut short leaves nothing half-done. The frontier comes last in a round and is what settles it.
 * - A variant with no `prep.json` is drafted again from an empty folder.
 * - A finished evaluation (`done`) is used as it is, when its report is of the same workflow, task set, split and k; any other
 *   folder is deleted and measured again.
 * - History and attribution rows already written for a round are skipped, so a resumed round adds each once.
 * - Ctrl+C (`interrupted()`, or a child that exits 130) stops before the next step and records nothing for the step in progress.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { TaskSet } from "@/cli/taskSet";
import { attribute, type AttributionRow } from "@/evolve/attribution";
import { criticReview, pickTraces, proposerBrief, renderTrace, resultsTable, type Repair, type TraceFile } from "@/evolve/brief";
import { calibrate } from "@/evolve/calibrate";
import { isComponent, type Component } from "@/evolve/components";
import type { EvolveConfig } from "@/evolve/config";
import {
  applyProposal, checkBudget, checkReservedSlot, classify, diffFile, parseProposal, renderChange, type ClassifiedEdit, type Proposal,
} from "@/evolve/edits";
import { exploration, History, stallFlag, type Exploration, type PruneEntry, type RenderedRecord } from "@/evolve/history";
import { jsonObjectsIn } from "@/evolve/jsonText";
import { appendJsonl, readJsonl } from "@/evolve/jsonl";
import { fixed, fromReport, roundTo, tooManyMissing, type EvalResult } from "@/evolve/measure";
import { precheck, type LeakagePattern } from "@/evolve/precheck";
import { editBudget } from "@/evolve/schedule";
import { selectRound, type Candidate, type Decision, type EditRecord } from "@/evolve/selection";
import { pinDiff, readFrontier, sha256, writeFileAtomic, writeFrontier, type Frontier, type Pins } from "@/evolve/state";

// ── The children ──────────────────────────────────────────────────────────────

export interface EvalRequest {
  /** The workflow file to evaluate. */
  workflow: string;
  split: "evolve" | "smoke" | "heldout";
  /** Trials per task. */
  k: number;
  /** The eval's folder: missing or empty, as `harness eval` requires. */
  out: string;
  log: string;
}

export interface EvalReply {
  /** `harness eval`'s exit code: 0, 1, 2, 3 or 130. */
  code: number;
  /** `<out>/report.json`, parsed, when the eval wrote one. */
  report?: unknown;
}

export interface RunRequest {
  role: "proposer" | "critic";
  /** The proposer's or critic's workflow file. */
  workflow: string;
  /** The task text for the run: brief.md or review.md. */
  taskFile: string;
  /** The folder the run works in. */
  workspace: string;
  log: string;
}

export interface RunReply {
  /** `harness run`'s exit code: 0, 1 (an agent failed), 2, 3 or 130. */
  code: number;
  /** The output of the agents nothing follows. */
  finalOutput?: string;
  tokens: { input: number; output: number } | null;
  error?: string;
}

export interface Children {
  eval(request: EvalRequest): Promise<EvalReply>;
  run(request: RunRequest): Promise<RunReply>;
}

// ── The context ───────────────────────────────────────────────────────────────

/** What the command builds and the loop reads. */
export interface EvolveContext {
  /** The run's folder, absolute: the paths handed to the children are made from it. */
  outDir: string;
  taskSet: TaskSet;
  hasSmoke: boolean;
  hasHeldout: boolean;
  patterns: readonly LeakagePattern[];
  /** The agents an `output` scorer names with `node:`, each with why it cannot be removed. */
  protectedAgents: ReadonlyMap<string, string>;
  /** The starting workflow, as the user's file (its hash is in `pins`). */
  workflowText: string;
  cfg: EvolveConfig;
  pins: Pins;
  proposerFile: string;
  criticFile: string;
  children: Children;
  /** Progress, one line at a time. */
  out(line: string): void;
  /** Whether Ctrl+C was pressed. */
  interrupted(): boolean;
}

export interface DriveResult {
  code: 0 | 2 | 3 | 130;
  error?: string;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const BASE_FILE = "base.harness.yaml";
const INCUMBENT_COPY = "incumbent.harness.yaml";
const CALIBRATION_FILE = "calibration.json";
const ATTRIBUTION_FILE = "attribution.jsonl";
const VARIANT_LABELS = "ABCDEFGH";
/** Critic runs for one verdict, as RRSI's `review`. */
const MAX_CRITIC_RUNS = 3;
/** Rounds in a row with every candidate's evaluation invalid, after which the run stops. */
const MAX_INFRA_STREAK = 3;
const SCOREBOARD_ROWS = 20;
const DETAIL_CHARS = 600;

/** The loop stops here: the exit code, and why. Thrown from any depth, caught by `drive`. */
class Halt extends Error {
  constructor(readonly code: 2 | 3 | 130, message = "") {
    super(message);
  }
}

interface Run {
  ctx: EvolveContext;
  history: History;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const say = (run: Run, line: string): void => run.ctx.out(line);

/** A path inside the run's folder, as it is stored in the frontier and the records: relative, written with "/". */
const rel = (...parts: Array<string | number>): string => parts.join("/");

/** The full path of a stored one. The frontier and prep.json are read back from disk, so a path that leads out of the folder is refused. */
function at(run: Run, relative: string): string {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(relative)) throw new Halt(2, `${relative} leads out of the run's folder; restore the file it is in or use a new --out`);
  return join(run.ctx.outDir, ...relative.split("/"));
}

function writeText(run: Run, relative: string, text: string): void {
  const file = at(run, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const writeJson = (run: Run, relative: string, value: unknown): void => writeFileAtomic(at(run, relative), `${JSON.stringify(value, null, 2)}\n`);

/** Copies a folder with everything in it (the project's minimal Node typings have no `cpSync`). */
function copyFolder(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (statSync(join(from, name)).isDirectory()) copyFolder(join(from, name), join(to, name));
    else copyFileSync(join(from, name), join(to, name));
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** At most `n` characters, counted by code points so that no emoji is cut in half. */
const cut = (text: string, n: number): string => (text.length <= n ? text : [...text].slice(0, n).join(""));
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** A text for a progress line: on one line, and short. */
const shorten = (text: string, n = 160): string => {
  const line = oneLine(text);
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const signed = (x: number, digits: number): string => `${x < 0 ? "-" : "+"}${fixed(Math.abs(x), digits)}`;
const scoreText = (S: number, C: number | null): string => `S ${fixed(S, 3)} C ${C === null ? "n/a" : Math.round(C)}`;

function checkNotInterrupted(run: Run): void {
  if (run.ctx.interrupted()) throw new Halt(130);
}

// ── Running the children ──────────────────────────────────────────────────────

/** One `harness eval`. Ctrl+C, a usage problem and an eval that left no report end the loop; anything else returns the report. */
async function evalChild(run: Run, request: EvalRequest): Promise<{ code: number; report: unknown }> {
  checkNotInterrupted(run);
  mkdirSync(dirname(request.log), { recursive: true });
  const reply = await run.ctx.children.eval(request);
  if (reply.code === 130) throw new Halt(130);
  if (reply.code === 2) {
    throw new Halt(2, `harness eval exited with code 2, a usage problem that the checks before the run should have caught (see ${request.log})`);
  }
  if (reply.report === undefined) throw new Halt(3, `harness eval left no report (exit code ${reply.code}); see ${request.log}`);
  return { code: reply.code, report: reply.report };
}

/** One `harness run` of the proposer or the critic. Ctrl+C, a usage problem and a run that did not start end the loop; a run whose
 *  agent failed (exit 1) is returned, its output may still parse. */
async function runChild(run: Run, request: RunRequest): Promise<RunReply> {
  checkNotInterrupted(run);
  mkdirSync(dirname(request.log), { recursive: true });
  const reply = await run.ctx.children.run(request);
  if (reply.code === 130) throw new Halt(130);
  const why = reply.error ?? `see ${request.log}`;
  if (reply.code === 2) throw new Halt(2, `the ${request.role} run exited with code 2, a usage problem that the checks before the run should have caught: ${why}`);
  if (reply.code === 3) throw new Halt(3, `the ${request.role} run did not start: ${why}`);
  return reply;
}

// ── Evaluations ───────────────────────────────────────────────────────────────

/** An evaluation that ran: its result and its report, parsed; or why it is invalid (its report, parsed, when it left one). */
type Measured = { ev: EvalResult; raw: unknown } | { invalid: string; raw: unknown };

/** A finished report of this very evaluation: `done`, for the same split and k, of this task set and this workflow's text. */
function isFinishedReportOf(raw: unknown, want: { split: string; k: number; taskSetHash: string; workflowHash: string }): boolean {
  if (!isRecord(raw) || raw.status !== "done" || raw.split !== want.split || raw.k !== want.k) return false;
  const hashOf = (x: unknown): unknown => (isRecord(x) ? x.hash : undefined);
  return hashOf(raw.taskSet) === want.taskSetHash && hashOf(raw.workflow) === want.workflowHash;
}

/** Why an eval stopped early, when its report says it ended in error. */
function crashReason(report: unknown): string | undefined {
  return isRecord(report) && report.status === "error" && typeof report.error === "string" && report.error !== "" ? report.error : undefined;
}

/**
 * `harness eval` of the workflow file `workflow` into `dir` (both relative to the run's folder). A finished report in `dir` is used
 * as it is; any other state of `dir` is deleted and the evaluation run again, since `harness eval` refuses a folder that is not
 * empty. The child's log goes to `<dir>.log`. An eval that crashed (exit 3 with a report) is invalid.
 */
async function evaluateInto(run: Run, dir: string, workflow: string, split: EvalRequest["split"], k: number): Promise<Measured> {
  const folder = at(run, dir);
  const file = at(run, workflow);
  const want = { split, k, taskSetHash: run.ctx.taskSet.hash, workflowHash: sha256(readFileSync(file, "utf8")) };
  const kept = readJsonFile(join(folder, "report.json"));
  if (isFinishedReportOf(kept, want)) {
    const read = fromReport(dir, kept);
    if ("ev" in read) {
      say(run, `  ${dir}: using the finished evaluation`);
      return { ev: read.ev, raw: kept };
    }
  } else if (isRecord(kept) && kept.status === "done") {
    say(run, `  ${dir}: its report is of another workflow, task set or setting; measuring again`);
  }
  say(run, `  ${dir}: measuring (split ${split}, k ${k})`);
  rmSync(folder, { recursive: true, force: true });
  rmSync(`${folder}.log`, { force: true });
  const reply = await evalChild(run, { workflow: file, split, k, out: folder, log: `${folder}.log` });
  const read = fromReport(dir, reply.report);
  if ("ev" in read) return { ev: read.ev, raw: reply.report };
  const crash = crashReason(reply.report);
  return { invalid: crash === undefined ? read.invalid : `evaluation crashed: ${crash}`, raw: reply.report };
}

const missingText = (ev: EvalResult): string => `${ev.missing} of ${ev.n_expected} trials are missing`;

/** The evaluation of the baseline, a calibration run or the held-out check: invalid is the end of the run (exit 3). */
function requireValid(run: Run, measured: Measured, what: string): EvalResult {
  if ("invalid" in measured) throw new Halt(3, `${what} is invalid: ${measured.invalid}`);
  const frac = run.ctx.cfg.invalid_missing_frac;
  if (tooManyMissing(measured.ev, frac)) {
    throw new Halt(3, `${what} is invalid: ${missingText(measured.ev)}, more than the ${roundTo(frac * 100, 1)}% that invalid_missing_frac allows`);
  }
  return measured.ev;
}

/** Why a smoke evaluation shows the workflow does not run, or undefined: it did not finish, or a trial is missing or ended in error. */
export function smokeProblem(report: unknown): string | undefined {
  if (!isRecord(report)) return "the smoke evaluation left no report";
  if (report.status !== "done") {
    return `the smoke evaluation ended ${String(report.status)}: ${typeof report.error === "string" && report.error !== "" ? report.error : "no reason given"}`;
  }
  const perTask = isRecord(report.per_task) ? report.per_task : {};
  for (const [id, task] of Object.entries(perTask)) {
    const trials = (isRecord(task) && Array.isArray(task.trials) ? task.trials : []).filter(isRecord);
    const bad = trials.find((trial) => trial.missing === true || trial.runStatus === "error");
    if (bad !== undefined) {
      const fallback = bad.missing === true ? "the trial is missing" : "the run ended in error";
      return `task ${id}: ${typeof bad.error === "string" && bad.error !== "" ? oneLine(bad.error) : fallback}`;
    }
  }
  return undefined;
}

/** Why a smoke evaluation fails: what `smokeProblem` finds, else the reason it is invalid. */
const smokeFailure = (measured: Measured): string | undefined =>
  smokeProblem(measured.raw) ?? ("invalid" in measured ? measured.invalid : undefined);

/** Wall-clock minutes an evaluation took, from its report: start to finish, else the trials' own times added. */
function evalMinutes(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const start = Date.parse(String(raw.startedAt));
  const end = Date.parse(String(raw.finishedAt));
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return (end - start) / 60000;
  let ms = 0;
  for (const task of Object.values(isRecord(raw.per_task) ? raw.per_task : {})) {
    for (const trial of (isRecord(task) && Array.isArray(task.trials) ? task.trials : []).filter(isRecord)) {
      ms += (typeof trial.runMs === "number" ? trial.runMs : 0) + (typeof trial.scoreMs === "number" ? trial.scoreMs : 0);
    }
  }
  return ms > 0 ? ms / 60000 : undefined;
}

const minutesText = (minutes: number): string => (minutes < 1 ? "under 1 min" : `${Math.round(minutes)} min`);

// ── A workflow file of the run ────────────────────────────────────────────────

/** The text of a workflow file of the run, which must still be what the frontier says; exit 2 when it is gone or was changed. */
function readVerified(run: Run, file: string, hash: string, since: string): string {
  const path = at(run, file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Halt(2, `${file} is missing; restore it or use a new --out`);
  }
  if (sha256(text) !== hash) throw new Halt(2, `${file} changed since ${since}; restore it or use a new --out`);
  return text;
}

const incumbentText = (run: Run, fr: Frontier): string =>
  readVerified(run, fr.incumbent.file, fr.incumbent.hash, fr.incumbent.t === 0 ? "the baseline" : `round ${fr.incumbent.t - 1} accepted it`);

// ── Start, and the baseline ───────────────────────────────────────────────────

/** The first record of the history: the baseline. Written once, even when a crash came between the frontier and this record. */
function ensureBaselineRecord(run: Run, fr: Frontier): void {
  if (run.history.has(0, "-")) return;
  run.history.append({
    t: 0, variant: "-", edit_id: null, component: null, hypothesis: "H_0 baseline", outcome: "BASELINE",
    S: roundTo(fr.base.S, 6), C: fr.base.C === null ? null : roundTo(fr.base.C, 1), accepted: true, delta_S: null, delta_C: null, bundle: 0,
  });
}

/** The baseline (spec §6.1): the base workflow must pass its own smoke tasks, and is measured on the evolve split. Its frontier is
 *  written last. */
async function baseline(run: Run): Promise<Frontier> {
  const { ctx } = run;
  const text = parseDocument(ctx.workflowText).toString({ lineWidth: 0 }); // the layout `applyProposal` writes, so a diff shows only an edit
  writeFileAtomic(at(run, BASE_FILE), text);
  const hash = sha256(text);

  if (ctx.hasSmoke) {
    const problem = smokeFailure(await evaluateInto(run, "base-smoke", BASE_FILE, "smoke", 1));
    if (problem !== undefined) throw new Halt(3, `the workflow fails its own smoke tasks: ${problem}`);
  }
  const measured = await evaluateInto(run, "base", BASE_FILE, "evolve", ctx.cfg.k);
  const ev = requireValid(run, measured, "the baseline");

  const fr: Frontier = {
    version: 1, pins: ctx.pins, base: { hash, S: ev.S, C: ev.C },
    incumbent: { t: 0, file: BASE_FILE, hash, eval_dir: "base", S: ev.S, C: ev.C },
    S_star: ev.S, trajectory: [{ t: 0, S: ev.S, C: ev.C, hash, eval_dir: "base" }], infra_streak: 0,
  };
  writeFrontier(ctx.outDir, fr);
  const minutes = evalMinutes(measured.raw);
  say(run, `baseline: ${scoreText(ev.S, ev.C)} (${ev.n_expected} runs${minutes === undefined ? "" : `, ${minutesText(minutes)}`})`);
  if (minutes !== undefined) {
    say(run, `measuring a candidate takes ${minutes < 1 ? "under a minute" : `about ${minutesText(minutes)}`}; a round about ${ctx.cfg.m} × that, plus the proposer's and critic's runs`);
  }
  return fr;
}

/** Resumes the run in the folder, or starts it with the baseline. The settings must be the ones the run began with, and the
 *  incumbent's file must be unchanged. */
async function start(run: Run): Promise<Frontier> {
  const { ctx } = run;
  let kept: Frontier | undefined;
  try {
    kept = readFrontier(ctx.outDir);
  } catch (e) {
    throw new Halt(2, `${messageOf(e)}; restore it or use a new --out`);
  }
  if (kept !== undefined) {
    const differs = pinDiff(kept.pins, ctx.pins);
    if (differs.length > 0) throw new Halt(2, `this folder holds a run with different settings: ${differs.join("; ")}; use a new --out`);
  }
  const fr = kept ?? await baseline(run);
  writeFileAtomic(at(run, INCUMBENT_COPY), incumbentText(run, fr));
  ensureBaselineRecord(run, fr);
  return fr;
}

// ── The noise band ────────────────────────────────────────────────────────────

const calibrationSchema = z.object({ delta: z.number().min(0) });

/** δ: from the settings, else from `calibration.json`, else measured now (spec §1.3). */
async function noiseBand(run: Run, fr: Frontier): Promise<number> {
  const { cfg } = run.ctx;
  const reach = "a candidate must reach S* − δ";
  if (cfg.delta !== null) {
    say(run, `noise band δ ${fixed(cfg.delta, 3)} (set by --delta) — ${reach}`);
    return cfg.delta;
  }
  const stored = calibrationSchema.safeParse(readJsonFile(at(run, CALIBRATION_FILE)));
  if (stored.success) {
    say(run, `noise band δ ${fixed(stored.data.delta, 3)} (from ${CALIBRATION_FILE}) — ${reach}`);
    return stored.data.delta;
  }
  readVerified(run, BASE_FILE, fr.base.hash, "the baseline"); // `base/` is measured again if the file is not the one it was measured with
  const jobs = ["base", ...Array.from({ length: cfg.calibrate - 1 }, (_, i) => `calib-${i + 1}`)];
  const evals: EvalResult[] = [];
  for (const job of jobs) {
    const measured = await evaluateInto(run, job, BASE_FILE, "evolve", cfg.k);
    evals.push(requireValid(run, measured, job === "base" ? "the baseline" : `the calibration evaluation ${job}`));
  }
  const cal = calibrate(evals, cfg.delta_z);
  writeJson(run, CALIBRATION_FILE, { ...cal, jobs });
  const how = cal.n_evals >= 2 ? `${cal.n_evals} evaluations of the baseline` : "bootstrap over the baseline's runs";
  say(run, `noise band δ ${fixed(cal.delta, 3)} (${how}, z ${cal.z}) — ${reach}`);
  return cal.delta;
}

// ── A round: the evidence and the directives ──────────────────────────────────

/** What a round knows before it drafts: the incumbent and its evaluation, and the directives. */
interface RoundData {
  t: number;
  /** `r<t>`, the round's folder. */
  rdir: string;
  incText: string;
  incEv: EvalResult;
  budget: number;
  explore: Exploration;
  prune: PruneEntry[];
  /** `history.render()`, and the whole render. */
  historyRows: RenderedRecord[];
  historyAll: RenderedRecord[];
  /** Every row of the scoreboard; the brief shows the last 20. */
  scoreboard: AttributionRow[];
  traces: TraceFile[];
  results: string;
}

function prepareRound(run: Run, fr: Frontier, t: number, delta: number): RoundData {
  const { ctx, history } = run;
  const { cfg } = ctx;
  const rdir = `r${t}`;

  // 1. the incumbent and its evaluation
  const incText = incumbentText(run, fr);
  const incRaw = readJsonFile(at(run, rel(fr.incumbent.eval_dir, "report.json")));
  const read = incRaw === undefined ? { invalid: "its report.json is missing or not JSON" } : fromReport(fr.incumbent.eval_dir, incRaw);
  if ("invalid" in read) {
    throw new Halt(2, `the evaluation of the incumbent (${fr.incumbent.eval_dir}) cannot be used: ${read.invalid}; restore it or use a new --out`);
  }
  const incEv = read.ev;

  // 2. the evidence: the worst trials of the lowest tasks and the best of the highest, and the results
  const traces: TraceFile[] = pickTraces(incEv, cfg.n_fail_traces, cfg.n_success_traces).map((pick) => {
    const task = ctx.taskSet.tasks.find((candidate) => candidate.id === pick.task) ?? { id: pick.task, task: "" };
    const trialDir = at(run, rel(fr.incumbent.eval_dir, "trials", pick.task, `t${pick.trial}`));
    const file = rel("evidence", "traces", `${pick.task}-t${pick.trial}.md`);
    writeText(run, rel(rdir, file), renderTrace(task, trialDir));
    return { file, task: pick.task, trial: pick.trial, reward: incEv.per_task[pick.task].rewards[pick.trial], kind: pick.kind };
  });
  const results = resultsTable(incRaw, incEv);
  writeText(run, rel(rdir, "evidence", "results.md"), `# Results of the incumbent\n\n${scoreText(incEv.S, incEv.C)}, k = ${incEv.k}\n\n${results}\n`);

  // 3. the directives
  const budget = editBudget(t, cfg.T, cfg.b_min, cfg.b_max);
  const sigma = stallFlag(fr.trajectory.map((entry) => entry.S), t, cfg.w, delta);
  const tried = history.tried();
  const explore = exploration(t, sigma, tried, cfg.m_draft);
  const prune = history.pruneSet(t, cfg.n_prune);
  const directives = at(run, rel(rdir, "directives.json"));
  if (!existsSync(directives)) { // a resumed round keeps what its proposers were shown, even if this round's records are in the history by now
    writeJson(run, rel(rdir, "directives.json"), {
      t, b_t: budget, sigma_t: sigma, tried: [...tried].sort(), explore, prune_set: prune, delta, S_star: fr.S_star,
    });
  }
  say(run, `round ${t}/${cfg.T}: budget ${budget}, stalled ${sigma === 1 ? "yes" : "no"}, untried [${explore.untried.join(", ")}], prune [${prune.map((p) => p.component).join(", ")}]`);
  return {
    t, rdir, incText, incEv, budget, explore, prune, historyRows: history.render(), historyAll: history.render(Number.POSITIVE_INFINITY),
    scoreboard: readJsonl(at(run, ATTRIBUTION_FILE)) as AttributionRow[], traces, results,
  };
}

// ── Drafting a variant ────────────────────────────────────────────────────────

type Failure = "no_proposal" | "invalid_proposal" | "critic_reject";
/** An edit as the history, the attribution and prep.json keep it: classified, without its operations. */
type StoredEdit = Omit<ClassifiedEdit, "ops">;

function storedEdit(edit: ClassifiedEdit): StoredEdit {
  const { ops, ...rest } = edit;
  return rest;
}

interface Tokens {
  input: number;
  output: number;
}

const addTokens = (a: Tokens | null, b: Tokens | null): Tokens | null =>
  a === null ? b : b === null ? a : { input: a.input + b.input, output: a.output + b.output };

interface Verdict {
  verdict: "accept" | "reject";
  reasons: string[];
  risk_notes: string[];
}

/** The strings of a list a model wrote; a single string counts as a list of one. */
function strings(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return items.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).filter((text) => text.trim() !== "");
}

/** The critic's verdict: the last JSON object of its output whose `verdict` is `accept` or `reject`. */
export function parseVerdict(text: string): Verdict | undefined {
  const found = jsonObjectsIn(text).filter((o): o is Record<string, unknown> => isRecord(o) && (o.verdict === "accept" || o.verdict === "reject")).at(-1);
  return found === undefined ? undefined : { verdict: found.verdict as Verdict["verdict"], reasons: strings(found.reasons), risk_notes: strings(found.risk_notes) };
}

/** A candidate of the round: what the selection reads, and the path of its diff for the history. */
interface Drafted extends Candidate {
  diff: string | null;
}

/** What prep.json holds: a candidate that is ready, or the gate it failed. */
const prepSchema = z.object({
  gate_failure: z.string().optional(),
  detail: z.string().optional(),
  edits: z.array(z.record(z.string(), z.unknown())),
  diff: z.string().nullable(),
  file: z.string().optional(),
  hash: z.string().optional(),
  summary: z.string().optional(),
});
type Prep = z.infer<typeof prepSchema>;

/** Writes prep.json, the record that a variant is drafted; the candidate it describes. */
function writePrep(run: Run, vdir: string, variant: string, prep: Prep): Drafted {
  writeJson(run, rel(vdir, "prep.json"), prep);
  return draftedFrom(variant, prep);
}

function draftedFrom(variant: string, prep: Prep): Drafted {
  const edits = prep.edits as EditRecord[];
  if (prep.gate_failure !== undefined) return { variant, edits, gate_failure: prep.gate_failure, detail: prep.detail ?? "", diff: prep.diff };
  return { variant, edits, file: prep.file, hash: prep.hash, diff: prep.diff };
}

/** The candidate a variant's prep.json records, when the variant was drafted in full: a gate failure, or a ready candidate whose
 *  file is still the one that was hashed. */
function readPrep(run: Run, vdir: string, variant: string): Drafted | undefined {
  const parsed = prepSchema.safeParse(readJsonFile(at(run, rel(vdir, "prep.json"))));
  if (!parsed.success) return undefined;
  const prep = parsed.data;
  if (prep.gate_failure !== undefined) return draftedFrom(variant, prep);
  if (prep.file === undefined || prep.hash === undefined) return undefined;
  const file = at(run, prep.file);
  try {
    if (sha256(readFileSync(file, "utf8")) !== prep.hash) return undefined;
  } catch {
    return undefined;
  }
  return draftedFrom(variant, prep);
}

/** What a proposer attempt leaves in `a<n>/proposal.json`. */
interface AttemptRecord {
  attempt: number;
  proposal: Proposal | null;
  /** Why nothing was read as a proposal. */
  error: string | null;
  objections: string[];
  failure: Failure | null;
  critic: Verdict | null;
  tokens: { proposer: Tokens | null; critic: Tokens | null };
}

type Attempt =
  | { ok: true; label: string; text: string; edits: ClassifiedEdit[]; change: string; summary: string }
  | { ok: false; label: string; kind: Failure; objections: string[]; edits: StoredEdit[]; proposal?: Proposal; raw: string };

/** The proposer's workspace: the brief, the incumbent's text, and the evidence. */
function prepareWorkspace(run: Run, rd: RoundData, workspace: string, variant: string, reserved: boolean, repair: Repair | undefined): void {
  const { ctx } = run;
  mkdirSync(at(run, workspace), { recursive: true });
  copyFolder(at(run, rel(rd.rdir, "evidence")), at(run, rel(workspace, "evidence")));
  writeText(run, rel(workspace, "evidence", "history.json"), `${JSON.stringify(rd.historyAll, null, 2)}\n`);
  writeText(run, rel(workspace, "evidence", "scoreboard.json"), `${JSON.stringify(rd.scoreboard, null, 2)}\n`);
  writeText(run, rel(workspace, "workflow.harness.yaml"), rd.incText);
  writeText(run, rel(workspace, "brief.md"), proposerBrief({
    t: rd.t, variant, m: ctx.cfg.m, workflowText: rd.incText, S: rd.incEv.S, C: rd.incEv.C, k: rd.incEv.k, results: rd.results, traces: rd.traces,
    history: rd.historyRows, scoreboard: rd.scoreboard.slice(-SCOREBOARD_ROWS), exploration: rd.explore, reserved, prune: rd.prune,
    budget: rd.budget, repair,
  }));
}

/** The critic's verdict on a change: up to 3 runs, and the last verdict in the first output that has one. An output that
 *  never has one is a reject. */
async function askCritic(run: Run, adir: string, review: string): Promise<{ verdict: Verdict; tokens: Tokens | null }> {
  let tokens: Tokens | null = null;
  let last = "";
  for (let i = 0; i < MAX_CRITIC_RUNS; i++) {
    const cdir = rel(adir, `critic-${i}`);
    writeText(run, rel(cdir, "review.md"), review);
    const reply = await runChild(run, {
      role: "critic", workflow: run.ctx.criticFile, taskFile: at(run, rel(cdir, "review.md")), workspace: at(run, cdir), log: at(run, rel(adir, `critic-${i}.log`)),
    });
    tokens = addTokens(tokens, reply.tokens);
    last = reply.finalOutput ?? "";
    const verdict = parseVerdict(last);
    if (verdict !== undefined) return { verdict, tokens };
  }
  const shown = last.trim() === "" ? "(no output)" : last.slice(0, 200);
  return { verdict: { verdict: "reject", reasons: [`critic output unparseable after ${MAX_CRITIC_RUNS} attempts: ${shown}`], risk_notes: [] }, tokens };
}

/**
 * One proposer attempt for a variant (spec §4.3): the proposer, then the checks in order (read, budget and apply, reserved slot,
 * precheck, critic), the first of which that fails gives the objections. Everything it learns goes to `a<n>/proposal.json`.
 */
async function attemptProposal(run: Run, rd: RoundData, variant: string, a: number, reserved: boolean, repair: Repair | undefined): Promise<Attempt> {
  const { ctx } = run;
  const adir = rel(rd.rdir, variant, `a${a}`);
  const workspace = rel(adir, "proposer");
  prepareWorkspace(run, rd, workspace, variant, reserved, repair);
  const reply = await runChild(run, {
    role: "proposer", workflow: ctx.proposerFile, taskFile: at(run, rel(workspace, "brief.md")), workspace: at(run, workspace), log: at(run, rel(adir, "proposer.log")),
  });
  const raw = reply.finalOutput ?? "";

  const record: AttemptRecord = { attempt: a, proposal: null, error: null, objections: [], failure: null, critic: null, tokens: { proposer: reply.tokens, critic: null } };
  /** Ends the attempt with a failure: records it. */
  const fail = (kind: Failure, label: string, objections: string[], edits: StoredEdit[] = [], proposal?: Proposal): Attempt => {
    record.failure = kind;
    record.objections = objections;
    writeJson(run, rel(adir, "proposal.json"), record);
    return { ok: false, label, kind, objections, edits, proposal, raw };
  };

  // read the proposal
  if (raw.trim() === "") {
    const why = `the proposer produced no final output${reply.error ? ` (${reply.error})` : ""}`;
    record.error = why;
    return fail("no_proposal", "no proposal", [why]);
  }
  const parsed = parseProposal(raw);
  if ("error" in parsed) {
    record.error = parsed.error;
    const anObject = jsonObjectsIn(raw).some((o) => isRecord(o) && Array.isArray(o.edits));
    if (!anObject) return fail("no_proposal", "no proposal", [`${parsed.error}; end your answer with the JSON proposal described under "How to answer"`]);
    return fail("invalid_proposal", "invalid proposal", parsed.error.split("\n"));
  }
  const { proposal } = parsed;
  record.proposal = proposal;
  const stored = classify(proposal).map(storedEdit);
  const what = `proposal ${stored.length} edit${stored.length === 1 ? "" : "s"} [${stored.map((e) => e.component).join(", ")}]`;

  // the checks that need no model: the budget, and applying the edits to the incumbent
  const over = checkBudget(proposal, rd.budget);
  const applied = applyProposal(rd.incText, proposal, { protectedAgents: ctx.protectedAgents });
  if (over !== undefined || "errors" in applied) {
    const problems = [...(over === undefined ? [] : [over]), ...("errors" in applied ? applied.errors : [])];
    return fail("invalid_proposal", `${what} → invalid`, problems, stored, proposal);
  }
  // the reserved slot, judged by the operations: known before any model reads the change
  const slot = reserved ? checkReservedSlot(applied.edits, rd.explore.untried) : undefined;
  if (slot !== undefined) return fail("invalid_proposal", `${what} → reserved slot not honoured`, [slot], stored, proposal);
  const hits = precheck(proposal, rd.incText, ctx.patterns);
  if (hits.length > 0) return fail("critic_reject", `${what} → precheck reject`, hits, stored, proposal);

  // the critic
  const change = renderChange(rd.incText, applied.edits);
  const summary = proposal.summary ?? cut(proposal.edits.map((e) => e.hypothesis).join("; "), 200);
  const review = criticReview({
    taskSetName: ctx.taskSet.name, summary, targets: cut(applied.edits.map((e) => e.targets_mode).filter((s): s is string => !!s).join(", "), 200),
    edits: stored, change, workflowText: rd.incText,
  });
  const critic = await askCritic(run, adir, review);
  record.critic = critic.verdict;
  record.tokens.critic = critic.tokens;
  if (critic.verdict.verdict === "reject") {
    const reasons = critic.verdict.reasons.length > 0 ? critic.verdict.reasons : ["the critic rejected the change without giving a reason"];
    return fail("critic_reject", `${what} → critic reject`, [...reasons, ...critic.verdict.risk_notes.map((note) => `risk: ${note}`)], stored, proposal);
  }

  writeJson(run, rel(adir, "proposal.json"), record);
  return { ok: true, label: `${what} → critic accept`, text: applied.text, edits: applied.edits, change, summary };
}

/** The candidate of an attempt that passed: its files, its smoke check, and prep.json. */
async function finishCandidate(run: Run, rd: RoundData, variant: string, attempt: Extract<Attempt, { ok: true }>): Promise<Drafted> {
  const vdir = rel(rd.rdir, variant);
  const file = rel(vdir, "candidate.harness.yaml");
  const diff = rel(vdir, "diff.txt");
  writeText(run, file, attempt.text);
  writeText(run, diff, diffFile(rd.incText, attempt.text));
  writeText(run, rel(vdir, "change.txt"), `${attempt.change}\n`);
  const edits = attempt.edits.map(storedEdit);
  if (run.ctx.hasSmoke) {
    const problem = smokeFailure(await evaluateInto(run, rel(vdir, "smoke"), file, "smoke", 1));
    if (problem !== undefined) {
      say(run, `  ${variant}: smoke check failed: ${shorten(problem)}`);
      return writePrep(run, vdir, variant, { gate_failure: "smoke_fail", detail: cut(problem, DETAIL_CHARS), edits, diff });
    }
  }
  return writePrep(run, vdir, variant, { file, hash: sha256(attempt.text), edits, diff, summary: attempt.summary });
}

/** Drafts variant `v` of the round (spec §7): proposer, checks and critic with up to `repair_rounds` repairs, then the candidate's
 *  files and smoke check. A variant that was drafted before a crash is returned as it was recorded. */
async function draftVariant(run: Run, rd: RoundData, v: number): Promise<Drafted> {
  const { cfg } = run.ctx;
  const variant = VARIANT_LABELS[v];
  const vdir = rel(rd.rdir, variant);
  const kept = readPrep(run, vdir, variant);
  if (kept !== undefined) {
    say(run, `  ${variant}: drafted before${kept.gate_failure === undefined ? "" : `, dropped as ${kept.gate_failure}`}`);
    return kept;
  }
  rmSync(at(run, vdir), { recursive: true, force: true });
  mkdirSync(at(run, vdir), { recursive: true });
  const reserved = rd.explore.sigma === 1 && rd.explore.untried.length > 0 && v >= cfg.m - cfg.m_draft;
  if (reserved) say(run, `  ${variant}: holds a reserved exploration slot`);

  let repair: Repair | undefined;
  let last: Extract<Attempt, { ok: false }> | undefined;
  for (let a = 0; a <= cfg.repair_rounds; a++) {
    const attempt = await attemptProposal(run, rd, variant, a, reserved, repair);
    if (attempt.ok) {
      say(run, `  ${variant}: ${attempt.label}`);
      for (const e of attempt.edits) {
        if (e.retagged) say(run, `  ${variant}: edit ${e.id} declared ${e.declared} but its operations make it ${e.component}; re-tagged`);
      }
      return finishCandidate(run, rd, variant, attempt);
    }
    const next = a < cfg.repair_rounds ? `repair ${a + 1}/${cfg.repair_rounds}` : "no repair left";
    say(run, `  ${variant}: ${attempt.label} (${next}): ${shorten(attempt.objections[0] ?? "")}`);
    last = attempt;
    repair = attempt.proposal !== undefined
      ? { proposal: attempt.proposal, objections: attempt.objections }
      : { rawOutput: attempt.raw, objections: attempt.objections };
  }
  if (last === undefined) throw new Error("no proposer attempt was made"); // not reached: the loop runs at least once
  return writePrep(run, vdir, variant, { gate_failure: last.kind, detail: cut(last.objections.join("; "), DETAIL_CHARS), edits: last.edits, diff: null });
}

// ── Measuring the candidates ──────────────────────────────────────────────────

/** A drafted candidate that passed every gate: it has a file. */
function readyFile(c: Drafted): { file: string; hash: string } {
  if (c.file === undefined || c.hash === undefined) throw new Error(`candidate ${c.variant} has neither a file nor a gate failure`);
  return { file: c.file, hash: c.hash };
}

/**
 * Measures a candidate on the evolve split. An evaluation with too many missing trials is run once more, the first one moved to
 * `eval-failed/`; the folder's presence tells a resumed round that the retry is spent. Sets `ev`, or `eval_invalid` and why.
 */
async function measureCandidate(run: Run, rd: RoundData, c: Drafted): Promise<void> {
  const { cfg } = run.ctx;
  const { file } = readyFile(c);
  const dir = rel(rd.rdir, c.variant, "eval");
  const failedDir = rel(rd.rdir, c.variant, "eval-failed");
  let measured = await evaluateInto(run, dir, file, "evolve", cfg.k);
  if ("ev" in measured && tooManyMissing(measured.ev, cfg.invalid_missing_frac)) {
    if (!existsSync(at(run, failedDir))) {
      say(run, `  ${c.variant}: ${missingText(measured.ev)} (infrastructure); measuring once more`);
      renameSync(at(run, dir), at(run, failedDir));
      measured = await evaluateInto(run, dir, file, "evolve", cfg.k);
    }
    if ("ev" in measured && tooManyMissing(measured.ev, cfg.invalid_missing_frac)) {
      c.gate_failure = "eval_invalid";
      c.detail = `${measured.ev.missing}/${measured.ev.n_expected} trials missing (infrastructure) after a retry`;
      say(run, `  ${c.variant}: eval_invalid: ${c.detail}`);
      return;
    }
  }
  if ("ev" in measured) {
    c.ev = measured.ev;
    return;
  }
  c.gate_failure = "eval_invalid";
  c.detail = cut(measured.invalid, DETAIL_CHARS);
  say(run, `  ${c.variant}: eval_invalid: ${shorten(c.detail)}`);
}

// ── Selecting, recording, settling ────────────────────────────────────────────

/** The accepted edits per component before round `t`. (`History.incumbentComponentCounts` counts the whole file, which on a
 *  resumed round includes this round's own records and would change the novelty term, and so the decisions, after a crash.) */
function acceptedBefore(history: History, t: number): Partial<Record<Component, number>> {
  const counts: Partial<Record<Component, number>> = {};
  for (const r of history.records()) {
    if (r.accepted && r.t < t && isComponent(r.component)) counts[r.component] = (counts[r.component] ?? 0) + 1;
  }
  return counts;
}

/** Records one candidate of the round: attribution rows, history records, and the progress line. A candidate the history already
 *  has was recorded before a crash, and is left alone. Attribution goes first, so that a crash between the two loses nothing. */
function recordCandidate(run: Run, rd: RoundData, c: Drafted, decision: Decision, won: boolean): void {
  const { history } = run;
  if (history.has(rd.t, c.variant)) return;
  if (c.ev === undefined) {
    history.appendCandidate(rd.t, c.variant, c.edits, c.gate_failure ?? "not_evaluated", null, null, false, null, null, c.diff, c.detail ?? "");
    return;
  }
  const outcome = won ? "ACCEPTED" : decision.admissible ? "LOST" : "REJECTED";
  const known = readJsonl(at(run, ATTRIBUTION_FILE)) as Array<Partial<AttributionRow>>;
  if (!known.some((row) => row.t === rd.t && row.variant === c.variant)) {
    appendJsonl(at(run, ATTRIBUTION_FILE), attribute(rd.t, c.variant, c.edits, rd.incEv, c.ev, run.ctx.cfg.k));
  }
  history.appendCandidate(rd.t, c.variant, c.edits, outcome, decision.delta_S, decision.delta_C, won, decision.S, decision.C, c.diff, decision.reason);
  say(run, `  ${c.variant}: S ${fixed(c.ev.S, 3)} dS ${signed(decision.delta_S ?? 0, 3)} dC ${signed(decision.delta_C ?? 0, 3)} ν ${decision.novelty} → ${outcome}: ${decision.reason}`);
}

/** Algorithm 2 on the round's candidates, then the records, then the frontier (the round is settled once it is written). */
function settleRound(run: Run, fr: Frontier, rd: RoundData, cands: Drafted[], delta: number): Frontier {
  const { cfg } = run.ctx;
  const { t } = rd;
  const selection = selectRound(cands, rd.incEv, fr.S_star, delta, cfg, acceptedBefore(run.history, t));
  const winner = cands.find((c) => c === selection.winner);
  const { decisions } = selection;
  writeJson(run, rel(rd.rdir, "decisions.json"), { winner: winner?.variant ?? null, decisions }); // the winner's label, and every candidate's Decision
  cands.forEach((c, i) => recordCandidate(run, rd, c, decisions[i], c === winner));

  let next: Frontier;
  if (winner?.ev !== undefined) {
    const { file, hash } = readyFile(winner);
    next = {
      ...fr, S_star: Math.max(fr.S_star, winner.ev.S),
      incumbent: { t: t + 1, file, hash, eval_dir: rel(rd.rdir, winner.variant, "eval"), S: winner.ev.S, C: winner.ev.C, variant: winner.variant },
    };
    say(run, `round ${t}: accepted ${winner.variant}; ${scoreText(winner.ev.S, winner.ev.C)}, S* ${fixed(next.S_star, 3)}`);
  } else {
    next = { ...fr };
    say(run, `round ${t}: no admissible candidate; the incumbent stays (${scoreText(rd.incEv.S, rd.incEv.C)})`);
  }
  const everyInvalid = cands.length > 0 && cands.every((c) => c.gate_failure === "eval_invalid");
  next.infra_streak = everyInvalid ? fr.infra_streak + 1 : 0;
  next.trajectory = [
    ...fr.trajectory.filter((entry) => entry.t <= t),
    { t: t + 1, S: next.incumbent.S, C: next.incumbent.C, hash: next.incumbent.hash, eval_dir: next.incumbent.eval_dir },
  ];
  writeFrontier(run.ctx.outDir, next);
  writeFileAtomic(at(run, INCUMBENT_COPY), incumbentText(run, next));
  return next;
}

/** Round `t` (spec §5): the evidence and directives, every variant drafted and measured in turn, then the selection. */
async function playRound(run: Run, fr: Frontier, t: number, delta: number): Promise<Frontier> {
  const rd = prepareRound(run, fr, t, delta);
  const cands: Drafted[] = [];
  for (let v = 0; v < run.ctx.cfg.m; v++) cands.push(await draftVariant(run, rd, v));
  for (const c of cands) if (c.gate_failure === undefined) await measureCandidate(run, rd, c);
  return settleRound(run, fr, rd, cands, delta);
}

/** The rounds from the first one that is not settled up to T − 1. */
async function playRounds(run: Run, start: Frontier, delta: number): Promise<Frontier> {
  let fr = start;
  for (let t = fr.trajectory.length - 1; t < run.ctx.cfg.T; t++) {
    fr = await playRound(run, fr, t, delta);
    if (fr.infra_streak >= MAX_INFRA_STREAK) {
      throw new Halt(3, "three rounds in a row ended with every candidate's evaluation invalid; check the model server");
    }
  }
  return fr;
}

// ── The held-out check, the summary ───────────────────────────────────────────

/** The base workflow and the final incumbent on the held-out tasks, once for this incumbent. It never enters selection. */
async function heldoutCheck(run: Run, fr: Frontier): Promise<Frontier> {
  const { ctx } = run;
  if (!ctx.hasHeldout || (fr.heldout !== undefined && fr.heldout.final.hash === fr.incumbent.hash)) return fr;
  readVerified(run, BASE_FILE, fr.base.hash, "the baseline");
  const base = requireValid(run, await evaluateInto(run, "heldout/base", BASE_FILE, "heldout", ctx.cfg.k), "the held-out evaluation of the base workflow");
  let final = base; // an incumbent that is the base workflow is measured once
  if (fr.incumbent.hash !== fr.base.hash) {
    final = requireValid(run, await evaluateInto(run, "heldout/final", fr.incumbent.file, "heldout", ctx.cfg.k), "the held-out evaluation of the final workflow");
  }
  const next: Frontier = { ...fr, heldout: { base: { S: base.S, C: base.C }, final: { S: final.S, C: final.C, hash: fr.incumbent.hash } } };
  writeFrontier(ctx.outDir, next);
  say(run, `held-out: base ${scoreText(base.S, base.C)}; final ${scoreText(final.S, final.C)}`);
  return next;
}

/** Printed when the run ends, and again when a finished run is run once more. */
function summarize(run: Run, fr: Frontier, delta: number): void {
  const { ctx, history } = run;
  const rounds = fr.trajectory.length - 1;
  const accepted = new Set(history.records().filter((r) => r.outcome === "ACCEPTED").map((r) => r.t)).size;
  say(run, "summary:");
  say(run, `  base: ${scoreText(fr.base.S, fr.base.C)}`);
  say(run, `  final: ${scoreText(fr.incumbent.S, fr.incumbent.C)}${fr.incumbent.t === 0 ? " (the base workflow)" : ` (reached after ${fr.incumbent.t} round${fr.incumbent.t === 1 ? "" : "s"})`}`);
  say(run, `  best S* ${fixed(fr.S_star, 3)}; ${accepted} of ${rounds} rounds accepted a candidate`);
  if (fr.heldout !== undefined) say(run, `  held-out: base ${scoreText(fr.heldout.base.S, fr.heldout.base.C)}; final ${scoreText(fr.heldout.final.S, fr.heldout.final.C)}`);
  say(run, `  result: ${at(run, INCUMBENT_COPY)} — to use it, copy it over ${ctx.pins.workflow.path}`);
  if (accepted === 0 && delta > 0.2) {
    say(run, `warning: no candidate was accepted, and the noise band δ ${fixed(delta, 3)} is wide: a candidate has to gain more than that. More tasks or more trials per task shrink it.`);
  }
}

// ── The loop ──────────────────────────────────────────────────────────────────

/**
 * Runs `harness evolve` in `ctx.outDir`: resumes the run there or starts it, finds the noise band, plays the rounds that are not
 * settled, runs the held-out check and prints the summary. 0: the rounds are done, whatever the gain. 2: the folder or a child
 * cannot be used as it is (other settings, a changed incumbent, a usage problem of a child). 3: the run cannot go on (an invalid
 * baseline, a child that did not start, an unexpected error, ...). 130: interrupted; run again to resume.
 */
export async function drive(ctx: EvolveContext): Promise<DriveResult> {
  const run: Run = { ctx, history: new History(join(ctx.outDir, "history.jsonl")) };
  try {
    mkdirSync(ctx.outDir, { recursive: true });
    const begun = await start(run);
    const delta = await noiseBand(run, begun);
    const settled = await playRounds(run, begun, delta);
    const final = await heldoutCheck(run, settled);
    summarize(run, final, delta);
    return { code: 0 };
  } catch (e) {
    if (e instanceof Halt) return e.code === 130 ? { code: 130 } : { code: e.code, error: e.message };
    return { code: 3, error: `unexpected error: ${messageOf(e)}` };
  }
}
