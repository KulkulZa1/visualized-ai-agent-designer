/**
 * `harness evolve`'s command line: the task set and the options. Pure, so the parsing is tested without a process. The provider
 * options are `harness run`'s (runArgs.ts). A number is checked here to be a number; its bounds are those of the method's parameters
 * (src/evolve/config.ts), checked once, with the rest of the configuration, so that the messages come from one place.
 */
import {
  finishProviderArgs, parseProviderFlag, PROVIDER_ENV_USAGE, PROVIDER_FLAGS, PROVIDER_OPTIONS_USAGE, type ProviderArgs,
} from "@/cli/runArgs";

type Env = Record<string, string | undefined>;

export interface EvolveArgs extends ProviderArgs {
  /** The task-set file. */
  taskSet: string;
  /** --workflow; else the task set's own `workflow`. */
  workflow?: string;
  /** The run's folder; else .harness/evolve/<task set name>/ in the current folder. */
  out?: string;
  /** Rounds (T). */
  rounds?: number;
  /** Trials per task in each evaluation (k): --trials or -k. */
  trials?: number;
  /** Candidates per round (m). */
  candidates?: number;
  /** The noise band; else measured from the baseline. */
  delta?: number;
  /** Evaluations of the base workflow to measure the band from. */
  calibrate?: number;
  /** A JSON file with the method's other parameters. */
  config?: string;
  /** The proposer's and the critic's workflows; else the ones next to the CLI. */
  proposer?: string;
  critic?: string;
  /** The model of the proposer's and the critic's runs; else --model. */
  proposerModel?: string;
  criticModel?: string;
  /** Exact command lines scorers may run; a scorer command not in the list stops the run before it starts. */
  allowScorers: string[];
  /** Exact command lines the evaluated workflow's agents may run; every other command is denied. */
  allowCommands: string[];
  core?: string;
}

export const EVOLVE_USAGE = `Usage: harness evolve <tasks.yaml> [options]

Improves a workflow against a task set, by RRSI's method. It measures the workflow with harness eval, then in each round a proposer
workflow drafts changes to it, a critic workflow reviews them, every candidate that passes is measured with harness eval, and the
best admissible one becomes the workflow of the next round. The workflow file itself is never written: the result is
incumbent.harness.yaml in the run's folder, to copy over it when you choose. Run again with the same --out to resume.

  --workflow <file>          The workflow to improve (default: the task set's \`workflow\`)
  --out <dir>                The run's folder (default: .harness/evolve/<task set name>/); run again with the same folder to resume.
                             Not inside a task's workspace or grader files, which every trial copies
  --rounds <T>               Rounds (default 20)
  --trials <n>               Trials per task in each evaluation, also -k <n> (default: the task set's \`trials\`, else 2)
  --candidates <m>           Candidates per round, 1 to 8 (default 2)
  --delta <x>                The noise band (default: measured from the baseline)
  --calibrate <R>            Measure the band from R evaluations of the base workflow, R of 2 or more (default 1: a bootstrap over
                             the baseline's trials)
  --config <file.json>       The method's other parameters, as strict JSON (an unknown key is an error); a flag above wins
  --proposer <file>          The proposer's workflow (default: examples/evolve/proposer.harness.yaml, next to the CLI)
  --critic <file>            The critic's workflow (default: examples/evolve/critic.harness.yaml, next to the CLI)
  --proposer-model <name>    The model of the proposer's runs (default: --model)
  --critic-model <name>      The model of the critic's runs (default: --model)
  --allow-scorer "<cmd>"     Let scorers run this exact command (repeatable); a task set with any other scorer command does not start
  --allow-command "<cmd>"    Let the improved workflow's agents run this exact command (repeatable); the proposer and the critic never
                             run commands
${PROVIDER_OPTIONS_USAGE}
  --core <path>              The harness-core binary (default: HARNESS_CORE, then src-tauri/target/release)

Every measurement is a harness eval and every proposer or critic run a harness run, started as a child process of this CLI with this
process's environment. The provider options and --core are passed on to all of them.

${PROVIDER_ENV_USAGE}
Exit codes: 0 the rounds are done, whatever the gain, 2 bad usage, an invalid task set, workflow, proposer or critic, an unapproved
scorer command, a bad --out, a folder that is in use or holds a run with other settings, or an incumbent file that was changed,
3 the run cannot go on (harness-core missing, an invalid baseline, the base workflow failing its smoke tasks, a proposer or critic run
that did not start, three rounds in a row with every candidate's evaluation invalid, a file that could not be written, an unexpected
error), 130 interrupted (run it again with the same --out to resume).`;

const TAKES_VALUE = new Set([
  "--workflow", "--out", "--rounds", "--trials", "-k", "--candidates", "--delta", "--calibrate", "--config", "--proposer", "--critic",
  "--proposer-model", "--critic-model", "--allow-scorer", "--allow-command", "--core", ...PROVIDER_FLAGS,
]);

/** The options that take a whole number, and the field each sets. */
type CountField = "rounds" | "trials" | "candidates" | "calibrate";
const COUNTS: Readonly<Record<string, CountField>> = {
  "--rounds": "rounds", "--trials": "trials", "-k": "trials", "--candidates": "candidates", "--calibrate": "calibrate",
};

/** A whole number, or null. */
function wholeNumber(value: string): number | null {
  const n = value.trim() === "" ? NaN : Number(value);
  return Number.isInteger(n) ? n : null;
}

/** A finite number, or null. */
function finiteNumber(value: string): number | null {
  const n = value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `env` is where the provider options that can also come from the environment are read; a flag wins. */
export function parseEvolveArgs(argv: string[], env: Env = {}): { args: EvolveArgs } | { error: string } {
  const args: EvolveArgs = { taskSet: "", provider: "auto", allowScorers: [], allowCommands: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("-")) { positionals.push(flag); continue; }
    if (!TAKES_VALUE.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    if (PROVIDER_FLAGS.has(flag)) {
      const problem = parseProviderFlag(args, flag, value);
      if (problem) return { error: problem };
      continue;
    }
    const count: CountField | undefined = COUNTS[flag];
    if (count !== undefined) {
      const n = wholeNumber(value);
      if (n === null) return { error: `${flag} must be a whole number` };
      args[count] = n;
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
      case "--config":
        if (!value.trim()) return { error: "--config needs a file" };
        args.config = value;
        break;
      case "--proposer":
        if (!value.trim()) return { error: "--proposer needs a file" };
        args.proposer = value;
        break;
      case "--critic":
        if (!value.trim()) return { error: "--critic needs a file" };
        args.critic = value;
        break;
      case "--proposer-model":
        if (!value.trim()) return { error: "--proposer-model needs a model name" };
        args.proposerModel = value;
        break;
      case "--critic-model":
        if (!value.trim()) return { error: "--critic-model needs a model name" };
        args.criticModel = value;
        break;
      case "--core": args.core = value; break;
      case "--delta": {
        const n = finiteNumber(value);
        if (n === null) return { error: "--delta must be a number" };
        args.delta = n;
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
  // Like --model: a hosted provider uses each agent's own model.
  if ((args.provider === "openai" || args.provider === "anthropic") && (args.proposerModel || args.criticModel)) {
    return { error: `--proposer-model and --critic-model are for Ollama and OpenAI-compatible endpoints; ${args.provider} uses each agent's model.` };
  }
  return { args };
}
