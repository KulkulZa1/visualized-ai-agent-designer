/**
 * One trial of `harness eval`: a fresh copy of the task's workspace, one run of the workflow in it
 * (the engine of `harness run`, in this process), the scorers, and what is kept of it. The task
 * set, the fixtures and the grader files are never in the trial's folder: only copies are.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runWorkflow, type ProviderSettings, type RunHost, type RunOutcome } from "@/engine/runWorkflow";
import { runRecordPath, writeRunRecord } from "@/engine/runRecord";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { WorkflowRun } from "@/types/execution";
import type { HookResult } from "@/types/hookResult";
import { createReporter, finalOutputs } from "@/cli/report";
import {
  isInsideDir, kindOf, relativePathProblem, type CommandScorer, type FileScorer, type OutputScorer, type Scorer, type TaskDef,
} from "@/cli/taskSet";

// [KEEP-IN-SYNC] with execute_command in src-tauri/src/commands/process_commands.rs. Its timeout error reads
// "Command timed out after {N} s"; every other error of it ("Could not start the command: …", a workspace folder
// that is gone) means the command did not run. tests/unit/cli/trial.test.ts reads that file and pins both texts.
export const COMMAND_TIMEOUT_PREFIX = "Command timed out after";

/** The end of a command's output that a scorer's record keeps, per stream. */
const OUTPUT_TAIL_CHARS = 4000;
/** A file a `file` scorer reads may be this long, at most (a runaway agent could fill the disk). */
const MAX_FILE_CHECK_BYTES = 4 * 1024 * 1024;

// ── What a trial leaves ───────────────────────────────────────────────────────

export interface ScorerResult {
  name: string;
  kind: "command" | "output" | "file";
  passed: boolean;
  weight: number;
  /** A command's exit code; not set when it timed out. */
  exitCode?: number;
  /** Set for a command scorer: whether the command ran out of time. */
  timedOut?: boolean;
  /** Why a check failed. */
  detail?: string;
  /** The scorer's own time: a command scorer's file preparation and the command. */
  ms: number;
}

/** What the trial's scorers.json keeps of a scorer: the report's entry, the command, and the end of its output. */
export interface ScorerRecord extends ScorerResult {
  command?: string;
  stdout?: string;
  stderr?: string;
}

export interface TrialResult {
  /** The trial's number within its task, from 0. */
  trial: number;
  /** The weighted share of the scorers that passed; 0 for a missing trial. */
  reward: number;
  missing: boolean;
  /** Why the trial is missing; for a scored trial, what went wrong in its run (a failed agent). */
  error?: string;
  runStatus: "done" | "error" | "not_started";
  runMs: number;
  scoreMs: number;
  /** The providers' token counts; null until they are read from the responses. */
  tokens: { input: number; output: number } | null;
  /** chars / 4, summed over the nodes: an estimate, not a count. null when no run started. */
  tokenEstimate: number | null;
  scorers: ScorerResult[];
}

// ── Files ─────────────────────────────────────────────────────────────────────

/** Copies the file or folder at `source` to `target`. A link, or anything that is not a regular file or
 *  folder, is refused: a copy of a link would still point at the original. */
export function copyTree(source: string, target: string): void {
  const kind = kindOf(source);
  if (kind === "folder") {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
  } else if (kind === "file") {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  } else {
    throw new Error(`${source} ${kind === "missing" ? "does not exist" : kind === "link" ? "is a link" : "is not a regular file or folder"}`);
  }
}

/** A path in the trial's folder, checked before anything is deleted or written there: it stays inside
 *  the folder, and no link on the way leads out (an agent with a shell can make one: through it, a
 *  restore would delete files outside). */
function trialPath(trialDir: string, path: string): string {
  const problem = relativePathProblem(path, "the trial's folder");
  if (problem) throw new Error(`${path} ${problem}`);
  const target = resolve(trialDir, path);
  const root = realpathSync(trialDir);
  // The nearest folder that exists on the way to the target decides where it would land.
  let ancestor = dirname(target);
  while (kindOf(ancestor) === "missing" && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!isInsideDir(root, realpathSync(ancestor))) throw new Error(`${path} leads out of the trial's folder through a link`);
  return target;
}

// ── Scorers ───────────────────────────────────────────────────────────────────

export interface ScoreContext {
  invoke: InvokeFn;
  /** The trial's folder, where the scorers' commands run and the file scorers look. */
  trialDir: string;
  /** The task's workspace, which `restore` puts files back from. */
  fixtureDir?: string;
  graph: WorkflowGraph;
  /** The run's result, in memory: an agent with a shell could have changed the run record on disk. */
  run: WorkflowRun;
  /** The scorer commands the user approved (--allow-scorer). The eval checks them all before it starts;
   *  the one place a scorer command is run checks again. */
  allowedCommands: ReadonlySet<string>;
  /** Starts the id of each scorer command, so it is unique in harness-core. */
  commandPrefix: string;
  isCancelled: () => boolean;
  /** The ids of the scorer commands running now, for the Ctrl+C that cancels them. */
  activeCommands: Set<string>;
}

type Verdict = Pick<ScorerRecord, "passed" | "exitCode" | "timedOut" | "detail" | "command" | "stdout" | "stderr">;

export type Scored =
  | { scorers: ScorerRecord[]; reward: number }
  /** A scorer could not run: the trial is missing, with this reason. */
  | { scorers: ScorerRecord[]; missing: string }
  /** The eval was interrupted: the trial counts for nothing. */
  | { cancelled: true };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const quote = (text: string) => JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}…` : text);

/** What is wrong with `text` as the scorer's checks see it; empty when all of them hold. */
function textFailures(text: string, contains: string[], notContains: string[], matches: string[]): string[] {
  const failures: string[] = [];
  for (const needle of contains) if (!text.includes(needle)) failures.push(`does not contain ${quote(needle)}`);
  for (const needle of notContains) if (text.includes(needle)) failures.push(`contains ${quote(needle)}`);
  for (const source of matches) if (!new RegExp(source).test(text)) failures.push(`does not match /${source}/`);
  return failures;
}

const verdict = (failures: string[]): Verdict =>
  failures.length === 0 ? { passed: true } : { passed: false, detail: failures.join("; ") };

/** An output scorer: the run's final output (the joined output of the agents nothing follows), or the
 *  output of the node it names. A run with nothing to check fails it: a crashed run must not earn a
 *  point from a check that only says what the answer must not hold. */
function checkOutput(ctx: ScoreContext, scorer: OutputScorer): Verdict {
  let text: string | undefined;
  if (scorer.node !== undefined) {
    const node = ctx.graph.nodes.find((n) => n.data.name === scorer.node); // one node: checked before any trial
    text = node ? ctx.run.agents[node.id]?.output || undefined : undefined;
  } else {
    const outputs = finalOutputs(ctx.graph, ctx.run);
    text = outputs.length === 0 ? undefined : outputs.map((o) => o.output).join("\n\n");
  }
  if (text === undefined) return { passed: false, detail: scorer.node === undefined ? "the run has no final output" : `${scorer.node} has no output` };
  return verdict(textFailures(text, scorer.contains, scorer.notContains, scorer.matches));
}

/** A file scorer: the file exists in the trial's folder, and its text holds the checks. A link, a pipe or a
 *  file too large to read counts as failing: it is what the agent left. */
function checkFile(ctx: ScoreContext, scorer: FileScorer): Verdict {
  let real: string;
  try {
    real = realpathSync(resolve(ctx.trialDir, scorer.path));
  } catch {
    return { passed: false, detail: `${scorer.path} does not exist` };
  }
  if (!isInsideDir(realpathSync(ctx.trialDir), real)) return { passed: false, detail: `${scorer.path} leads out of the trial's folder` };
  if (kindOf(real) !== "file") return { passed: false, detail: `${scorer.path} is not a file` };
  if (lstatSync(real).size > MAX_FILE_CHECK_BYTES) return { passed: false, detail: `${scorer.path} is over ${MAX_FILE_CHECK_BYTES} bytes` };
  return verdict(textFailures(readFileSync(real, "utf8"), scorer.contains, [], scorer.matches));
}

/** Puts the files of a command scorer in place. Each restore path is deleted, then copied back from the
 *  pristine workspace if it has it; each inject is deleted at its target, then copied in. Replacement, not
 *  overlay: a test file the agent added under a restored folder is gone. */
function prepareFiles(ctx: ScoreContext, scorer: CommandScorer): void {
  for (const path of scorer.restore) {
    const target = trialPath(ctx.trialDir, path);
    rmSync(target, { recursive: true, force: true });
    const source = ctx.fixtureDir === undefined ? undefined : join(ctx.fixtureDir, path);
    if (source !== undefined && kindOf(source) !== "missing") copyTree(source, target);
  }
  for (const { from, to } of scorer.inject) {
    const target = trialPath(ctx.trialDir, to);
    rmSync(target, { recursive: true, force: true });
    copyTree(from, target);
  }
}

const tail = (text: string) =>
  text.length <= OUTPUT_TAIL_CHARS ? text : `[${text.length - OUTPUT_TAIL_CHARS} earlier characters omitted]\n${text.slice(-OUTPUT_TAIL_CHARS)}`;

/** A command scorer: its files are put in place, then the command runs in the trial's folder, through
 *  harness-core. Exit code 0 passes; any other code fails; a timeout fails (`timedOut`); a command that
 *  could not start throws, and the trial is missing. */
async function runCommandScorer(ctx: ScoreContext, scorer: CommandScorer, index: number): Promise<Verdict> {
  // AGENT.md rule 6: no command runs without the user's approval of that exact command.
  if (!ctx.allowedCommands.has(scorer.command)) throw new Error(`the command was not approved with --allow-scorer: ${scorer.command}`);
  prepareFiles(ctx, scorer);
  const commandId = `${ctx.commandPrefix}-score-${index}`;
  ctx.activeCommands.add(commandId);
  try {
    const result = await ctx.invoke<HookResult>("execute_command", {
      workspacePath: ctx.trialDir, command: scorer.command, consentGranted: true, timeoutSecs: scorer.timeoutSecs, commandId,
    });
    return {
      passed: result.exitCode === 0, exitCode: result.exitCode, timedOut: false, command: scorer.command,
      stdout: tail(result.stdout ?? ""), stderr: tail(result.stderr ?? ""),
    };
  } catch (e) {
    // harness-core's errors arrive as plain strings; an Error object reads as its message.
    const message = messageOf(e);
    if (message.startsWith(COMMAND_TIMEOUT_PREFIX)) return { passed: false, timedOut: true, detail: message, command: scorer.command };
    throw e;
  } finally {
    ctx.activeCommands.delete(commandId);
  }
}

/** Runs the scorers in order and gives the trial's reward: the weighted share that passed. */
export async function scoreTrial(ctx: ScoreContext, scorers: Scorer[]): Promise<Scored> {
  const records: ScorerRecord[] = [];
  for (const [index, scorer] of scorers.entries()) {
    if (ctx.isCancelled()) return { cancelled: true };
    const started = Date.now();
    try {
      const checked = scorer.kind === "command" ? await runCommandScorer(ctx, scorer, index)
        : scorer.kind === "output" ? checkOutput(ctx, scorer) : checkFile(ctx, scorer);
      const { passed, ...rest } = checked;
      records.push({ name: scorer.name, kind: scorer.kind, passed, weight: scorer.weight, ...rest, ms: Date.now() - started });
    } catch (e) {
      if (ctx.isCancelled()) return { cancelled: true };
      return { scorers: records, missing: `scorer ${scorer.name}: ${messageOf(e)}` };
    }
  }
  if (ctx.isCancelled()) return { cancelled: true }; // the last command may have been stopped, not failed
  const total = records.reduce((sum, r) => sum + r.weight, 0);
  return { scorers: records, reward: records.reduce((sum, r) => sum + (r.passed ? r.weight : 0), 0) / total };
}

// ── The trial ─────────────────────────────────────────────────────────────────

export interface TrialEnv {
  invoke: InvokeFn;
  graph: WorkflowGraph;
  /** The workflow under test, as the run records name it. */
  workflow: { path: string; hash: string };
  provider: ProviderSettings;
  /** Exact command lines agents may run (--allow-command). Approving a scorer command does not approve it for agents. */
  allowCommands: ReadonlySet<string>;
  /** Exact command lines scorers may run (--allow-scorer). */
  allowScorers: ReadonlySet<string>;
  /** The folder the trials' folders are made in. */
  tempDir: string;
  /** The eval's output folder: a trial is kept in trials/<task>/t<i>/ in it. */
  outDir: string;
  evalId: string;
  keepWorkspaces: boolean;
  isCancelled: () => boolean;
  coreStopped: () => boolean;
  activeCommands: Set<string>;
  /** Told each warning a run writes to stderr, for the console; the trial's run.log has it too. */
  onWarning: (line: string) => void;
}

const MAX_ERROR_CHARS = 300;
const brief = (text: string) => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text);

/** What went wrong in a run that finished: a failed agent, or the run failing as a whole. */
function runProblem(graph: WorkflowGraph, outcome: Extract<RunOutcome, { started: true }>): string | undefined {
  const problems = graph.nodes
    .filter((n) => outcome.run.agents[n.id]?.status === "error")
    .map((n) => `${n.data.name} failed: ${brief(outcome.run.agents[n.id].error ?? "unknown error")}`);
  if (outcome.error) problems.push(brief(outcome.error));
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/** What a trial came to, and what is kept of it. */
interface Attempt {
  result: TrialResult;
  outcome?: RunOutcome;
  scorers: ScorerRecord[];
}

const entryOf = ({ command, stdout, stderr, ...entry }: ScorerRecord): ScorerResult => entry;

/** A missing trial: reward 0, and the reason. */
function missingTrial(trial: number, error: string, outcome?: RunOutcome, runMs = 0, scoreMs = 0, scorers: ScorerRecord[] = []): Attempt {
  return {
    result: {
      trial, reward: 0, missing: true, error: brief(error), runStatus: runStatusOf(outcome), runMs, scoreMs, tokens: null,
      tokenEstimate: tokenEstimateOf(outcome), scorers: scorers.map(entryOf),
    },
    outcome, scorers,
  };
}

function runStatusOf(outcome: RunOutcome | undefined): TrialResult["runStatus"] {
  if (!outcome?.started) return "not_started";
  return outcome.run.status === "done" ? "done" : "error";
}

/** The sum of the nodes' chars / 4 estimates; null when the run never started. */
function tokenEstimateOf(outcome: RunOutcome | undefined): number | null {
  if (!outcome?.started) return null;
  return Object.values(outcome.run.agents).reduce((sum, agent) => sum + (agent.tokenEstimate ?? 0), 0);
}

/** One trial, up to what is kept: a fresh folder with the fixture in it, the run, the scorers.
 *  undefined when the eval was interrupted. */
async function attemptTrial(env: TrialEnv, task: TaskDef, trial: number, dir: string, log: string[]): Promise<Attempt | undefined> {
  try {
    mkdirSync(dir, { recursive: true });
    if (task.workspace !== undefined) copyTree(task.workspace, dir);
  } catch (e) {
    return missingTrial(trial, `a file could not be copied: ${messageOf(e)}`);
  }
  if (env.isCancelled()) return undefined;

  // The lines `harness run` would print go to the trial's run.log; a warning is also the console's.
  const reporter = createReporter(env.graph, false, (line) => { log.push(line); }, (line) => {
    log.push(line);
    if (line.startsWith("warning:")) env.onWarning(line);
  });
  const host: RunHost = {
    invoke: env.invoke,
    events: reporter.events,
    // The user allowed these exact commands up front; every other command is denied.
    askCommand: async ({ command }) => (env.allowCommands.has(command.trim()) ? "granted" : "deny"),
    commandPolicy: "--allow-command",
    isCancelled: env.isCancelled,
    revealOutput: false,
    saveRun: (record) => writeRunRecord(env.invoke, dir, record),
  };
  let outcome: RunOutcome;
  const runStarted = Date.now();
  try {
    outcome = await runWorkflow({
      graph: env.graph,
      config: { userInput: task.task, contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
      provider: env.provider,
      workspacePath: dir,
      continueOnError: false,
      workflowFile: env.workflow,
    }, host);
  } catch (e) {
    return missingTrial(trial, `the run broke: ${messageOf(e)}`, undefined, Date.now() - runStarted);
  }
  const runMs = Date.now() - runStarted;
  reporter.summary(outcome, runMs);
  if (env.isCancelled()) return undefined;
  if (!outcome.started) return missingTrial(trial, outcome.error, outcome, runMs);
  // harness-core stopping during the run counts as the run not starting, as in `harness run`.
  if (env.coreStopped()) return missingTrial(trial, "harness-core stopped during the run", outcome, runMs);

  const scoreStarted = Date.now();
  const scored = await scoreTrial({
    invoke: env.invoke, trialDir: dir, fixtureDir: task.workspace, graph: env.graph, run: outcome.run,
    allowedCommands: env.allowScorers, commandPrefix: `${env.evalId}-${task.id}-t${trial}`, isCancelled: env.isCancelled, activeCommands: env.activeCommands,
  }, task.scorers);
  const scoreMs = Date.now() - scoreStarted;
  if ("cancelled" in scored) return undefined;
  if ("missing" in scored) return missingTrial(trial, scored.missing, outcome, runMs, scoreMs, scored.scorers);
  return {
    result: {
      trial, reward: scored.reward, missing: false, error: runProblem(env.graph, outcome), runStatus: runStatusOf(outcome),
      runMs, scoreMs, tokens: null, tokenEstimate: tokenEstimateOf(outcome), scorers: scored.scorers.map(entryOf),
    },
    outcome, scorers: scored.scorers,
  };
}

/** Keeps the trial under trials/<task>/t<i>/ in the eval's output folder: the outcome, each scorer's
 *  result, run.log and a copy of the run record (only if the agents left it a plain file). */
function keepTrial(env: TrialEnv, task: TaskDef, dir: string, { result, outcome, scorers }: Attempt, log: string[]): void {
  const keep = join(env.outDir, "trials", task.id, `t${result.trial}`);
  mkdirSync(keep, { recursive: true });
  const run = outcome?.started ? outcome.run : undefined;
  const outcomeFile = {
    task: task.id, trial: result.trial, runId: run?.id ?? null, runStatus: result.runStatus, missing: result.missing,
    error: result.error ?? null, reward: result.reward, runMs: result.runMs, scoreMs: result.scoreMs,
    tokens: result.tokens, tokenEstimate: result.tokenEstimate,
    agents: Object.fromEntries(env.graph.nodes.map((n) => [n.id, {
      agent: n.data.name, status: run?.agents[n.id]?.status ?? "idle", error: run?.agents[n.id]?.error,
      tokenEstimate: run?.agents[n.id]?.tokenEstimate,
    }])),
    outputs: run ? Object.fromEntries(finalOutputs(env.graph, run).map((o) => [o.id, o.output])) : {},
  };
  writeFileSync(join(keep, "outcome.json"), `${JSON.stringify(outcomeFile, null, 2)}\n`);
  writeFileSync(join(keep, "scorers.json"), `${JSON.stringify(scorers, null, 2)}\n`);
  writeFileSync(join(keep, "run.log"), log.length > 0 ? `${log.join("\n")}\n` : "");
  if (run) {
    try {
      const record = trialPath(dir, runRecordPath(run.id));
      if (kindOf(record) === "file") copyFileSync(record, join(keep, "run.json"));
    } catch {
      // not there, or not a plain file: the outcome and the log say what happened
    }
  }
}

/** One trial of a task. undefined when the eval was interrupted: the trial counts for nothing. A trial
 *  that cannot be made, run or scored comes back as a missing trial, with the reason. The trial's folder
 *  is deleted afterwards unless the eval keeps the workspaces. */
export async function runTrial(env: TrialEnv, task: TaskDef, trial: number): Promise<TrialResult | undefined> {
  const dir = join(env.tempDir, `${task.id}-t${trial}`);
  const log: string[] = [];
  try {
    const attempt = await attemptTrial(env, task, trial, dir, log);
    if (attempt === undefined) return undefined;
    keepTrial(env, task, dir, attempt, log);
    return attempt.result;
  } finally {
    if (!env.keepWorkspaces) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        env.onWarning(`warning: could not delete the trial folder ${dir}: ${messageOf(e)}`);
      }
    }
  }
}
