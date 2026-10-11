/**
 * The report of `harness eval` (report.json), shaped the way RRSI's selection reads an
 * evaluation (rrsi/evaluate.py, `aggregate`): a pooled score S, a cost C, and per task the
 * rewards, the tokens and the missing trials. The aggregation is pure; the report is written
 * after every trial, atomically.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { RunRecord } from "@/engine/runRecord";
import type { EvalSplit } from "@/cli/evalArgs";
import type { TrialResult } from "@/cli/trial";

/** A task and the trials of it that have finished so far. */
export interface TaskTrials {
  id: string;
  /** The task's weight: each of its trials counts this much in S. */
  weight: number;
  trials: TrialResult[];
}

export interface TaskReport {
  weight: number;
  /** The mean reward of the task's finished trials; null before the first. */
  mean: number | null;
  rewards: number[];
  /** Each trial's tokens, input plus output; null for a trial with no count. */
  tokens: Array<number | null>;
  missing: number;
  trials: TrialResult[];
}

export interface Aggregate {
  /** The pooled score: sum of weight x reward over all trials, over the sum of the weights. A missing
   *  trial counts as 0 with its full weight, so no run can look better by losing the trials it finds hard.
   *  null before any trial has finished. */
  S: number | null;
  /** The mean of the trials' token totals, over the trials that have one (more than 0); null when none has. */
  C: number | null;
  /** The trials the eval plans: tasks x k. */
  n_expected: number;
  /** The trials that have finished, missing ones included. S and C cover these. */
  n_done: number;
  missing: number;
  per_task: Record<string, TaskReport>;
}

const tokenTotal = (trial: TrialResult): number | null => (trial.tokens ? trial.tokens.input + trial.tokens.output : null);

/** Folds the finished trials into S and C, as RRSI's `aggregate` does. `k` is the trials planned per task. */
export function aggregate(tasks: TaskTrials[], k: number): Aggregate {
  let weighted = 0;
  let weights = 0;
  let done = 0;
  let missing = 0;
  const counted: number[] = [];
  const perTask: Record<string, TaskReport> = {};
  for (const task of tasks) {
    const rewards = task.trials.map((t) => t.reward);
    const tokens = task.trials.map(tokenTotal);
    for (const reward of rewards) {
      weighted += task.weight * reward;
      weights += task.weight;
    }
    for (const total of tokens) if (total !== null && total > 0) counted.push(total);
    const taskMissing = task.trials.filter((t) => t.missing).length;
    done += task.trials.length;
    missing += taskMissing;
    perTask[task.id] = {
      weight: task.weight,
      mean: rewards.length > 0 ? rewards.reduce((sum, r) => sum + r, 0) / rewards.length : null,
      rewards, tokens, missing: taskMissing, trials: task.trials,
    };
  }
  return {
    S: weights > 0 ? weighted / weights : null,
    C: counted.length > 0 ? counted.reduce((sum, t) => sum + t, 0) / counted.length : null,
    n_expected: tasks.length * k, n_done: done, missing, per_task: perTask,
  };
}

export type EvalStatus = "running" | "done" | "cancelled" | "error";

/** What stays the same through the eval. */
export interface ReportHeader {
  evalId: string;
  taskSet: { name: string; path: string; hash: string };
  workflow: { name: string; path: string; hash: string };
  split: EvalSplit;
  /** Trials per task. */
  k: number;
  /** As in a run record: the run's provider settings, without keys. */
  provider: RunRecord["provider"];
  startedAt: string;
}

export interface EvalReport extends Aggregate, ReportHeader {
  version: 1;
  status: EvalStatus;
  finishedAt?: string;
  /** Why the eval stopped early, when status is "error". */
  error?: string;
}

/** report.json for the trials finished so far. `running` until the last write, which is `done`,
 *  `cancelled` or `error`; with an unfinished eval S and C cover only the trials that finished (`n_done`). */
export function buildReport(
  header: ReportHeader, tasks: TaskTrials[], status: EvalStatus, end: { finishedAt?: string; error?: string } = {},
): EvalReport {
  const a = aggregate(tasks, header.k);
  return {
    version: 1, evalId: header.evalId, status, taskSet: header.taskSet, workflow: header.workflow, split: header.split,
    k: header.k, provider: header.provider, startedAt: header.startedAt,
    ...(end.finishedAt === undefined ? {} : { finishedAt: end.finishedAt }),
    S: a.S, C: a.C, n_expected: a.n_expected, n_done: a.n_done, missing: a.missing, per_task: a.per_task,
    ...(end.error === undefined ? {} : { error: end.error }),
  };
}

/** The report's JSON text, as written to report.json and printed by --json. */
export const reportText = (report: EvalReport): string => `${JSON.stringify(report, null, 2)}\n`;

/** Writes the report atomically: a temporary file in the same folder, then a rename, so a reader (or a
 *  crash) never sees half of it. */
export function writeReport(file: string, report: EvalReport): void {
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, reportText(report));
    renameSync(temp, file);
  } catch (e) {
    try {
      rmSync(temp, { force: true }); // no half of a report is left in the folder
    } catch {
      // the first error is the one to report
    }
    throw e;
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const num = (n: number | null, digits: number) => (n === null ? "n/a" : n.toFixed(digits));

/** `text` on one line: a provider's error can have a line break in it ("…try again.\nRun: ollama pull …"), which would split
 *  the line of a trial in two. The report and the trial's files keep the text as it was. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The line printed when a trial finishes. An error text on it is put on one line. */
export function trialLine(done: number, total: number, task: string, trial: TrialResult): string {
  const head = `[${done}/${total}] ${task} t${trial.trial}:`;
  const timing = `run ${seconds(trial.runMs)}${trial.scorers.length > 0 ? `, scoring ${seconds(trial.scoreMs)}` : ""}`;
  const scorers = trial.scorers.map((s) => `${s.name} ${s.passed ? "✓" : "✗"}${s.timedOut ? " (timed out)" : ""}`).join(", ");
  if (trial.missing) return `${head} missing (${oneLine(trial.error ?? "no reason given")}) · ${timing}`;
  return `${head} reward ${trial.reward.toFixed(2)} (${scorers}) · ${timing}${trial.error ? ` · ${trial.runStatus}: ${oneLine(trial.error)}` : ""}`;
}

/** The lines printed at the end: the score and the cost, and each task's rewards. */
export function summaryLines(report: EvalReport): string[] {
  const lines = [
    "",
    `Eval ${report.evalId}: ${report.taskSet.name} · split ${report.split} · ${Object.keys(report.per_task).length} task${
      Object.keys(report.per_task).length === 1 ? "" : "s"} × ${report.k} trial${report.k === 1 ? "" : "s"} · ${report.status}`,
  ];
  for (const [id, task] of Object.entries(report.per_task)) {
    lines.push(`  ${id}: mean ${num(task.mean, 2)} · rewards ${task.rewards.map((r) => r.toFixed(2)).join(" ") || "none yet"}${
      task.missing > 0 ? ` · ${task.missing} missing` : ""}`);
  }
  lines.push(`S ${num(report.S, 3)} · C ${report.C === null ? "n/a" : `${Math.round(report.C)} tokens`} · ${report.n_done} of ${report.n_expected} trials, ${report.missing} missing`);
  return lines;
}
