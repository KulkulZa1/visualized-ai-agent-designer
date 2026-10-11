/**
 * harness evolve: improves a workflow against a task set by RRSI's method
 * (docs/superpowers/specs/2026-10-11-harness-evolve-design.md). This is the command: the checks before anything runs, the run's pins
 * and lock, and the real children that the loop (src/evolve/loop.ts) measures and drafts with. Every measurement is a `harness eval`
 * and every proposer or critic run a `harness run`, each started as a child process of this CLI with this process's environment, so
 * the keys come from the same variables. It runs in the process of the `harness run` bundle, built by `npm run build:cli`
 * (src/cli/runCli.ts re-exports `runEvolve`).
 */
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defToGraph, type WorkflowGraph } from "@/engine/workflowGraph";
import { outDirProblem } from "@/cli/evalCli";
import { EVOLVE_USAGE, parseEvolveArgs, type EvolveArgs } from "@/cli/evolveArgs";
import { finalNodes, type Write } from "@/cli/report";
import { providerSettings } from "@/cli/runArgs";
import { checkWorkflowGraph, createInterrupt, EXIT, loadWorkflow } from "@/cli/shared";
import { loadTaskSet, nodeProblems, unapprovedScorerCommands, type TaskDef, type TaskSet } from "@/cli/taskSet";
import { configFromJson, type EvolveConfig } from "@/evolve/config";
import { drive, type Children, type EvalReply, type EvalRequest, type EvolveContext, type RunReply, type RunRequest } from "@/evolve/loop";
import { leakagePatterns } from "@/evolve/precheck";
import { acquireLock, releaseLock, sha256, type Pins } from "@/evolve/state";
import { readNodeUsage } from "@/services/execution/usage";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const indented = (lines: string[]) => lines.map((line) => `  ${line}`).join("\n");

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// ── The real children ─────────────────────────────────────────────────────────

/** Splits a stream into lines: `push` takes a chunk, `end` the last line when it has no line break after it. */
function lineReader(onLine: (line: string) => void) {
  let rest = "";
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: string): void {
      rest += chunk;
      for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
        emit(rest.slice(0, end));
        rest = rest.slice(end + 1);
      }
    },
    end(): void {
      if (rest !== "") emit(rest);
      rest = "";
    },
  };
}

/** The provider options `evolve` was given, which every child gets as they are (`--model` is added per child). */
function providerFlags(args: EvolveArgs): string[] {
  return [
    "--provider", args.provider,
    ...(args.baseUrl === undefined ? [] : ["--base-url", args.baseUrl]),
    ...(args.numCtx === undefined ? [] : ["--num-ctx", String(args.numCtx)]),
    ...(args.requestTimeoutSecs === undefined ? [] : ["--request-timeout", String(args.requestTimeoutSecs)]),
    ...(args.core === undefined ? [] : ["--core", args.core]),
  ];
}

interface Io {
  out: Write;
  err: Write;
  /** Whether Ctrl+C was pressed in this process. */
  interrupted: () => boolean;
}

/**
 * Runs `node <this CLI> <argv>` and waits for it. Each line of its output, from stdout and from stderr, is appended to `log`, and
 * with `show` is also printed, indented by 4 spaces (its stdout lines to this process's stdout, its stderr lines to stderr). The
 * exit code is the child's; one killed by a signal counts as 130 when this process was interrupted, else as 3, as does one that could
 * not be started. `lines` is everything it wrote, in order.
 */
function spawnCli(io: Io, script: string, argv: string[], log: string, show: boolean): Promise<{ code: number; lines: string[] }> {
  return new Promise((done) => {
    const lines: string[] = [];
    let logFailed = false;
    const take = (print: Write) => (line: string) => {
      lines.push(line);
      if (!logFailed) {
        try {
          appendFileSync(log, `${line}\n`);
        } catch (e) {
          logFailed = true; // said once: a log that cannot be written must not stop a run of hours
          io.err(`warning: cannot write ${log}: ${messageOf(e)}`);
        }
      }
      if (show && line.trim() !== "") print(`    ${line}`); // the log keeps the blank lines, the console does not
    };
    const readers = [lineReader(take(io.out)), lineReader(take(io.err))];
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      for (const reader of readers) reader.end();
      done({ code, lines });
    };
    const child = spawn(process.execPath, [script, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => readers[0].push(chunk));
    child.stderr.on("data", (chunk: string) => readers[1].push(chunk));
    child.on("error", (error: Error) => { // it could not be started
      readers[1].push(`harness evolve: cannot start ${process.execPath} ${script}: ${error.message}\n`);
      finish(EXIT.notStarted);
    });
    child.on("close", (code) => finish(code ?? (io.interrupted() ? EXIT.interrupted : EXIT.notStarted)));
  });
}

/** The run record a `harness run` saved in `workspace` (`.harness/runs/<runId>/run.json`): the newest one, if there are several. */
function readRunRecord(workspace: string): Record<string, unknown> | undefined {
  const runs = join(workspace, ".harness", "runs");
  let ids: string[];
  try {
    ids = readdirSync(runs);
  } catch {
    return undefined;
  }
  let newest: { startedAt: number; record: Record<string, unknown> } | undefined;
  for (const id of ids) {
    const record = readJson(join(runs, id, "run.json"));
    if (!isRecord(record)) continue;
    const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
    if (newest === undefined || startedAt >= newest.startedAt) newest = { startedAt, record };
  }
  return newest?.record;
}

/** The last line a `harness run` wrote about an error: an agent's failure (`✗ <agent> failed: …`) or its own message (`harness run: …`),
 *  without those markers. */
function lastErrorLine(lines: readonly string[]): string | undefined {
  const line = [...lines].reverse().find((text) => /^(harness run: |✗ )/.test(text));
  return line?.replace(/^harness run: (the run did not start: )?/, "").replace(/^✗ /, "");
}

/**
 * What the loop reads of a run: the outputs of the workflow's final nodes joined by a blank line (as `harness run` shows them); the
 * tokens of its model calls summed over the nodes, null when no node has a count or a count is partial (a call came back without
 * one); and why it failed, from the record's last failed agent, else from the log.
 */
function outcomeOf(graph: WorkflowGraph, record: Record<string, unknown> | undefined, lines: readonly string[]): Pick<RunReply, "finalOutput" | "tokens" | "error"> {
  const nodes = record !== undefined && isRecord(record.nodes) ? record.nodes : {};
  const nodeOf = (id: string): Record<string, unknown> => {
    const node = nodes[id];
    return isRecord(node) ? node : {};
  };

  const outputs = finalNodes(graph).map((node) => nodeOf(node.id).output).filter((text): text is string => typeof text === "string" && text !== "");

  let input = 0;
  let output = 0;
  let counted = false;
  let partial = false;
  for (const node of graph.nodes) {
    const usage = readNodeUsage(nodeOf(node.id).usage);
    if (usage === undefined) continue;
    counted = true;
    input += usage.input;
    output += usage.output;
    partial ||= usage.callsWithoutUsage > 0;
  }

  const failed = graph.nodes.filter((node) => nodeOf(node.id).status === "error" && typeof nodeOf(node.id).error === "string").at(-1);
  const error = failed === undefined
    ? lastErrorLine(lines)
    : `${failed.data.name} failed: ${String(nodeOf(failed.id).error).replace(/\s+/g, " ").trim()}`;
  return {
    finalOutput: outputs.length > 0 ? outputs.join("\n\n") : undefined,
    tokens: counted && !partial ? { input, output } : null,
    error,
  };
}

/**
 * The loop's children, as processes of this CLI. An eval is `eval <tasks> --workflow … --split … -k … --out …` with every
 * --allow-scorer and --allow-command; a run is `run <workflow> --task-file … --workspace …` with the role's model and no approved
 * command. The provider options and --core go to all of them.
 */
function createChildren(args: EvolveArgs, taskSetFile: string, graphs: Readonly<Record<RunRequest["role"], WorkflowGraph>>, io: Io): Children {
  const script = fileURLToPath(new URL("../harness.mjs", import.meta.url));
  const provider = providerFlags(args);
  const withModel = (model: string | undefined): string[] => (model === undefined ? [] : ["--model", model]);
  return {
    async eval(request: EvalRequest): Promise<EvalReply> {
      const { code } = await spawnCli(io, script, [
        "eval", taskSetFile, "--workflow", request.workflow, "--split", request.split, "-k", String(request.k), "--out", request.out,
        ...args.allowScorers.flatMap((command) => ["--allow-scorer", command]),
        ...args.allowCommands.flatMap((command) => ["--allow-command", command]),
        ...provider, ...withModel(args.model),
      ], request.log, true);
      return { code, report: readJson(join(request.out, "report.json")) };
    },
    async run(request: RunRequest): Promise<RunReply> {
      const model = (request.role === "proposer" ? args.proposerModel : args.criticModel) ?? args.model;
      const { code, lines } = await spawnCli(io, script, [
        "run", request.workflow, "--task-file", request.taskFile, "--workspace", request.workspace, ...provider, ...withModel(model),
      ], request.log, false);
      return { code, ...outcomeOf(graphs[request.role], readRunRecord(request.workspace), lines) };
    },
  };
}

// ── The checks before the run ─────────────────────────────────────────────────

/** The proposer's or the critic's workflow that ships with the CLI: examples/evolve/ at the root of the repository. */
const shipped = (name: string): string => fileURLToPath(new URL(`../../examples/evolve/${name}`, import.meta.url));

/** The proposer's or the critic's workflow, loaded and checked; undefined when it cannot be used (the reason is written to `err`). */
function loadSearchWorkflow(role: RunRequest["role"], file: string, err: Write): WorkflowGraph | undefined {
  const loaded = loadWorkflow(file);
  if ("error" in loaded) {
    err(`harness evolve: the ${role} workflow: ${loaded.error}`);
    return undefined;
  }
  const graph = defToGraph(loaded.def);
  return checkWorkflowGraph(graph, `harness evolve: the ${role} workflow ${file}`, err) ? graph : undefined;
}

/**
 * The method's parameters, lowest source first: the defaults, the --config file, the task set's `trials` for k (unless the file or
 * -k sets it), and the flags --rounds, -k, --candidates, --delta and --calibrate. Undefined when they are not valid (the reason is
 * written to `err`).
 */
function buildConfig(args: EvolveArgs, taskSet: TaskSet, err: Write): EvolveConfig | undefined {
  let raw: unknown = {};
  if (args.config !== undefined) {
    const file = resolve(args.config);
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      err(`harness evolve: --config ${file} ${e instanceof SyntaxError ? `is not valid JSON: ${e.message}` : `cannot be read: ${messageOf(e)}`}`);
      return undefined;
    }
  }
  const fileSetsK = isRecord(raw) && "k" in raw;
  const checked = configFromJson(raw, {
    T: args.rounds, k: args.trials ?? (fileSetsK ? undefined : taskSet.trials), m: args.candidates, delta: args.delta, calibrate: args.calibrate,
  });
  if ("error" in checked) {
    err(`harness evolve: the settings are not valid:\n${indented(checked.error.split("\n"))}\n` +
      "  (T is --rounds, k is --trials, m is --candidates; the other keys are in the --config file)");
    return undefined;
  }
  return checked.config;
}

/** The default folder's name: the task set's file name without `.yaml` or `.yml`, and without a trailing `.tasks`. */
function defaultFolderName(taskSetFile: string): string {
  return basename(taskSetFile).replace(/\.ya?ml$/i, "").replace(/\.tasks$/i, "") || "evolve";
}

/** The agents an `output` scorer names with `node:`, each with why: the loop must not remove them. */
function protectedAgents(tasks: readonly TaskDef[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const task of tasks) {
    for (const scorer of task.scorers) {
      if (scorer.kind === "output" && scorer.node !== undefined && !found.has(scorer.node)) {
        found.set(scorer.node, `scorer ${scorer.name} of task ${task.id} names it (node:)`);
      }
    }
  }
  return found;
}

// ── The command ───────────────────────────────────────────────────────────────

/** `harness evolve <tasks.yaml> …`; returns the exit code. An error nobody foresaw is a 3: the run could not go on. */
export async function runEvolve(argv: string[]): Promise<number> {
  try {
    return await evolve(argv);
  } catch (e) {
    process.stderr.write(`harness evolve: unexpected error: ${messageOf(e)}\n`);
    return EXIT.notStarted;
  }
}

async function evolve(argv: string[]): Promise<number> {
  const out: Write = (line) => { process.stdout.write(`${line}\n`); };
  const err: Write = (line) => { process.stderr.write(`${line}\n`); };
  if (argv.includes("--help") || argv.includes("-h")) {
    out(EVOLVE_USAGE);
    return EXIT.done;
  }
  const parsed = parseEvolveArgs(argv, process.env);
  if ("error" in parsed) {
    err(`harness evolve: ${parsed.error}\n\n${EVOLVE_USAGE}`);
    return EXIT.usage;
  }
  const args = parsed.args;

  // Everything is checked before anything runs, in this order: the task set, the workflow, the proposer and the critic, the
  // settings, and the run's folder.
  const loadedSet = loadTaskSet(args.taskSet);
  if ("errors" in loadedSet) {
    err(`harness evolve: ${args.taskSet} is not a valid task set:\n${indented(loadedSet.errors)}`);
    return EXIT.usage;
  }
  const taskSet = loadedSet.taskSet;
  if (!taskSet.tasks.some((task) => task.split === "evolve")) {
    err(`harness evolve: ${args.taskSet} has no task in the evolve split, so there is nothing to improve the workflow on`);
    return EXIT.usage;
  }
  const unapproved = unapprovedScorerCommands(taskSet.tasks, new Set(args.allowScorers));
  if (unapproved.length > 0) {
    err(`harness evolve: ${unapproved.length === 1 ? "this scorer command is" : "these scorer commands are"} not approved. ` +
      "A scorer command runs only when it is passed exactly with --allow-scorer \"<command>\":\n" +
      unapproved.map((u) => `  ${u.command}    (${u.scorers.join(", ")})`).join("\n"));
    return EXIT.usage;
  }

  const workflowFile = args.workflow !== undefined ? resolve(args.workflow) : taskSet.workflow;
  if (workflowFile === undefined) {
    err("harness evolve: no workflow to improve: pass --workflow, or name one in the task set (workflow:)");
    return EXIT.usage;
  }
  const workflow = loadWorkflow(workflowFile);
  if ("error" in workflow) {
    err(`harness evolve: ${workflow.error}`);
    return EXIT.usage;
  }
  const graph = defToGraph(workflow.def);
  if (!checkWorkflowGraph(graph, "harness evolve", err)) return EXIT.usage;
  // The loop finds an agent by its name.
  const sameName = [...new Set(graph.nodes.map((node) => node.data.name))]
    .filter((name) => graph.nodes.filter((node) => node.data.name === name).length > 1);
  if (sameName.length > 0) {
    err(`harness evolve: the workflow ${workflowFile} has agents with the same name: ${sameName.map((name) => `"${name}"`).join(", ")}. ` +
      "The loop finds an agent by its name, so every name must be unique.");
    return EXIT.usage;
  }
  const nodeIssues = nodeProblems(taskSet.tasks, graph);
  if (nodeIssues.length > 0) {
    err(`harness evolve: the task set does not fit the workflow ${workflowFile}:\n${indented(nodeIssues)}`);
    return EXIT.usage;
  }
  const fromFile = graph.nodes.filter((node) => node.data.promptSource.type === "file").map((node) => node.data.name);
  if (fromFile.length > 0) {
    out(fromFile.length === 1
      ? `note: agent ${fromFile[0]} reads its prompt from a file; the loop cannot change that prompt`
      : `note: agents ${fromFile.join(", ")} read their prompts from files; the loop cannot change those prompts`);
  }

  const proposerFile = args.proposer !== undefined ? resolve(args.proposer) : shipped("proposer.harness.yaml");
  const criticFile = args.critic !== undefined ? resolve(args.critic) : shipped("critic.harness.yaml");
  const proposerGraph = loadSearchWorkflow("proposer", proposerFile, err);
  const criticGraph = loadSearchWorkflow("critic", criticFile, err);
  if (proposerGraph === undefined || criticGraph === undefined) return EXIT.usage;

  const config = buildConfig(args, taskSet, err);
  if (config === undefined) return EXIT.usage;

  // The folder is reused on purpose (a re-run resumes in it), so it need not be empty; it may not be inside what a trial copies.
  const outDir = args.out !== undefined ? resolve(args.out) : join(process.cwd(), ".harness", "evolve", defaultFolderName(args.taskSet));
  const folderProblem = outDirProblem(outDir, args.out !== undefined, taskSet.tasks, true);
  if (folderProblem) {
    err(`harness evolve: ${folderProblem}`);
    return EXIT.usage;
  }

  // What makes the rounds of a run comparable (no keys).
  const settings = providerSettings(args, process.env);
  const pins: Pins = {
    taskSet: { path: taskSet.path, hash: taskSet.hash },
    workflow: { path: workflowFile, hash: sha256(workflow.text) },
    provider: {
      llmProvider: settings.llmProvider, baseUrl: settings.customApiUrl || settings.ollamaBaseUrl,
      model: settings.customApiModel || settings.ollamaModel, numCtx: settings.ollamaNumCtx,
    },
    k: config.k,
    config,
  };

  const lock = acquireLock(outDir);
  if ("error" in lock) {
    err(`harness evolve: ${lock.error}`);
    return EXIT.usage;
  }
  // Ctrl+C reaches the running child as well, which stops as it does on its own; the loop then stops before its next step. A second
  // one exits at once, leaving what is saved and giving up the lock.
  const stop = createInterrupt(err, (code) => { releaseLock(outDir); process.exit(code); }, "evolve");
  process.on("SIGINT", stop.onInterrupt);
  try {
    const children = createChildren(args, taskSet.path, { proposer: proposerGraph, critic: criticGraph }, { out, err, interrupted: stop.interrupted });
    const ctx: EvolveContext = {
      outDir, taskSet, hasSmoke: taskSet.tasks.some((task) => task.smoke), hasHeldout: taskSet.tasks.some((task) => task.split === "heldout"),
      patterns: leakagePatterns(taskSet), protectedAgents: protectedAgents(taskSet.tasks), workflowText: workflow.text, cfg: config, pins,
      proposerFile, criticFile, children, out, interrupted: stop.interrupted,
    };
    out(`Run folder: ${outDir}`);
    const result = await drive(ctx);
    if (result.code === EXIT.interrupted) err(`harness evolve: stopped; what is settled is saved. Run it again with --out ${outDir} to continue.`);
    else if (result.error !== undefined) err(`harness evolve: ${result.error}`);
    return result.code;
  } finally {
    process.off("SIGINT", stop.onInterrupt);
    releaseLock(outDir);
  }
}
