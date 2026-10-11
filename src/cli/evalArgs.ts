/**
 * `harness eval`'s command line: the task set and the options. Pure, so the parsing is
 * tested without a process. The provider options are `harness run`'s (runArgs.ts).
 */
import {
  finishProviderArgs, parseProviderFlag, PROVIDER_ENV_USAGE, PROVIDER_FLAGS, PROVIDER_OPTIONS_USAGE,
  type ProviderArgs,
} from "@/cli/runArgs";

type Env = Record<string, string | undefined>;

export const EVAL_SPLITS = ["evolve", "heldout", "smoke", "all"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export interface EvalArgs extends ProviderArgs {
  /** The task-set file. */
  taskSet: string;
  /** --workflow; else the task set's own `workflow`. */
  workflow?: string;
  split: EvalSplit;
  /** --only: run just these tasks, which must be in the split. */
  only: string[];
  /** Trials per task: --trials or -k; else the task set's `trials`, else 1. */
  trials?: number;
  /** Trials running at once. */
  maxParallelTrials: number;
  /** Where the report and the trials' records go; else .harness/evals/<evalId>/ in the current folder. */
  out?: string;
  keepWorkspaces: boolean;
  /** Exit 1 when the score S is below it. */
  minScore?: number;
  json: boolean;
  /** Exact command lines scorers may run; a scorer command not in the list stops the eval before it starts. */
  allowScorers: string[];
  /** Exact command lines agents may run; every other command is denied. */
  allowCommands: string[];
  core?: string;
}

export const EVAL_USAGE = `Usage: harness eval <tasks.yaml> [options]

Runs a workflow on each task of a task set k times, each time in a fresh copy of the task's workspace,
scores every trial with the task's scorers, and writes report.json after each trial. Output and file scorers
read the trial before any command scorer runs, so they see what the agent left, and a file scorer cannot
check what a scorer command builds.

  --workflow <file>          The workflow to run (default: the task set's \`workflow\`)
  --split <name>             The tasks to run: evolve (default), heldout, smoke or all
  --only <task-id>           Run only this task (repeatable); it must be in the split
  --trials <n>               Trials per task, 1 to 1000, also -k <n> (default: the task set's \`trials\`, else 1)
  --max-parallel-trials <n>  Trials running at once (default 1: a local model server answers one request at a time)
  --out <dir>                Where the report and the trials' records go (default: .harness/evals/<evalId>/); new or empty,
                             and not inside a task's workspace or grader files, which every trial copies
  --keep-workspaces          Keep each trial's folder, as it is after scoring: restored files back, grader files in (default: deleted after the trial)
  --min-score <x>            Exit 1 when the score S is below x, 0 to 1
  --allow-scorer "<cmd>"     Let scorers run this exact command (repeatable); an eval with any other scorer command does not start
  --allow-command "<cmd>"    Let agents run this exact command (repeatable); every other command is denied
${PROVIDER_OPTIONS_USAGE}
  --json                     The report as JSON alone on stdout; progress goes to stderr
  --core <path>              The harness-core binary (default: HARNESS_CORE, then src-tauri/target/release)

Every trial checks the provider first, as harness run does: for a Custom endpoint that is a one-token
completion, which can take up to 120 s while the model loads.

${PROVIDER_ENV_USAGE}
Exit codes: 0 the eval finished, 1 --min-score was given and S is below it, 2 bad usage, task set or workflow,
an unapproved scorer command or an --out that is not empty or is inside a workspace, 3 the eval could not run
to its end (harness-core missing or stopped, the first trial's run did not start, a folder or the report that
could not be written, an unexpected error), 130 interrupted.`;

/** A task's id: it names a folder of the eval's output, so it has no path in it. */
export const TASK_ID = /^[A-Za-z0-9_-]+$/;

/** The most trials per task: --trials, -k and the task set's `trials`. */
export const MAX_TRIALS = 1000;

const TAKES_VALUE = new Set([
  "--workflow", "--split", "--only", "--trials", "-k", "--max-parallel-trials", "--out", "--min-score",
  "--allow-scorer", "--allow-command", "--core", ...PROVIDER_FLAGS,
]);

/** A whole number from `min` to `max`, or null. */
function wholeNumber(value: string, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** `env` is where the provider options that can also come from the environment are read; a flag wins. */
export function parseEvalArgs(argv: string[], env: Env = {}): { args: EvalArgs } | { error: string } {
  const args: EvalArgs = {
    taskSet: "", provider: "auto", split: "evolve", only: [], maxParallelTrials: 1, keepWorkspaces: false,
    json: false, allowScorers: [], allowCommands: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { args.json = true; continue; }
    if (flag === "--keep-workspaces") { args.keepWorkspaces = true; continue; }
    if (!flag.startsWith("-")) { positionals.push(flag); continue; }
    if (!TAKES_VALUE.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    if (PROVIDER_FLAGS.has(flag)) {
      const problem = parseProviderFlag(args, flag, value);
      if (problem) return { error: problem };
      continue;
    }
    switch (flag) {
      case "--workflow":
        if (!value.trim()) return { error: "--workflow needs a file" };
        args.workflow = value;
        break;
      case "--out":
        if (!value.trim()) return { error: "--out needs a folder" };
        args.out = value;
        break;
      case "--core": args.core = value; break;
      case "--split":
        if (!EVAL_SPLITS.includes(value as EvalSplit)) return { error: `--split must be one of: ${EVAL_SPLITS.join(", ")}` };
        args.split = value as EvalSplit;
        break;
      case "--only":
        if (!TASK_ID.test(value)) return { error: `--only ${value}: a task id has letters, digits, - and _ only` };
        if (!args.only.includes(value)) args.only.push(value);
        break;
      case "--trials":
      case "-k": {
        const n = wholeNumber(value, 1, MAX_TRIALS);
        if (n === null) return { error: `${flag} must be a whole number from 1 to ${MAX_TRIALS}` };
        args.trials = n;
        break;
      }
      case "--max-parallel-trials": {
        const n = wholeNumber(value, 1, Number.MAX_SAFE_INTEGER);
        if (n === null) return { error: "--max-parallel-trials must be a whole number of at least 1" };
        args.maxParallelTrials = n;
        break;
      }
      case "--min-score": {
        const n = value.trim() === "" ? NaN : Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 1) return { error: "--min-score must be a number from 0 to 1" };
        args.minScore = n;
        break;
      }
      case "--allow-scorer":
        if (!value.trim()) return { error: "--allow-scorer needs a command" };
        args.allowScorers.push(value.trim());
        break;
      case "--allow-command":
        if (!value.trim()) return { error: "--allow-command needs a command" };
        args.allowCommands.push(value.trim());
        break;
    }
  }
  if (positionals.length !== 1) return { error: "Give exactly one task-set file." };
  args.taskSet = positionals[0];
  const problem = finishProviderArgs(args, env);
  if (problem) return { error: problem };
  return { args };
}
