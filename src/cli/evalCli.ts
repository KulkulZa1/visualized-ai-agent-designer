/**
 * harness eval: runs a workflow on each task of a task set k times, each time in a fresh copy of the
 * task's workspace, scores every trial and writes report.json after each one. It measures a workflow
 * so that it can be improved offline (docs/superpowers/specs/2026-10-01-harness-eval-design.md). It
 * runs in the process of the `harness run` bundle: the same engine, and one harness-core for the whole
 * eval. Bundled by `npm run build:cli` (src/cli/runCli.ts re-exports `runEval`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defToGraph } from "@/engine/workflowGraph";
import { EVAL_USAGE, parseEvalArgs } from "@/cli/evalArgs";
import {
  buildReport, reportText, summaryLines, trialLine, writeReport, type EvalReport, type EvalStatus, type TaskTrials,
} from "@/cli/evalReport";
import type { Write } from "@/cli/report";
import { providerSettings } from "@/cli/runArgs";
import { checkWorkflowGraph, createInterrupt, EXIT, loadWorkflow, openCore } from "@/cli/shared";
import { kindOf, loadTaskSet, nodeProblems, selectTasks, unapprovedScorerCommands } from "@/cli/taskSet";
import { runTrial, type TrialEnv, type TrialResult } from "@/cli/trial";

/** The exit code of a finished eval: 130 interrupted, 3 stopped early (harness-core stopped, or the first
 *  trial's run did not start), 1 when --min-score was given and S is below it, else 0. */
export function evalExitCode(report: Pick<EvalReport, "status" | "S">, minScore: number | undefined): number {
  if (report.status === "cancelled") return EXIT.interrupted;
  if (report.status === "error") return EXIT.notStarted;
  // Slack for the rounding of a sum of weights: 0.7 asked for, 0.6999999999999999 got.
  return minScore !== undefined && report.S !== null && report.S < minScore - 1e-9 ? EXIT.failed : EXIT.done;
}

/** Why `--out` cannot be used, or undefined: it may be new, or an empty folder. */
function outDirProblem(dir: string): string | undefined {
  const kind = kindOf(dir);
  if (kind === "missing") return undefined;
  if (kind !== "folder") return `--out ${dir} exists and is not a folder`;
  return readdirSync(dir).length > 0 ? `--out ${dir} is not empty: give a new or an empty folder` : undefined;
}

/** Runs `work` on each item in order, up to `limit` at once, and starts no new item once `stopped()`. */
async function runPool<T>(items: T[], limit: number, stopped: () => boolean, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopped() && next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** `harness eval <tasks.yaml> …`; returns the exit code. */
export async function runEval(argv: string[]): Promise<number> {
  const out: Write = (line) => { process.stdout.write(`${line}\n`); };
  const err: Write = (line) => { process.stderr.write(`${line}\n`); };
  if (argv.includes("--help") || argv.includes("-h")) {
    out(EVAL_USAGE);
    return EXIT.done;
  }
  const parsed = parseEvalArgs(argv, process.env);
  if ("error" in parsed) {
    err(`harness eval: ${parsed.error}\n\n${EVAL_USAGE}`);
    return EXIT.usage;
  }
  const args = parsed.args;

  // Everything is checked before any trial: the task set and its paths, the workflow, which tasks
  // run, the output folder, and that every scorer command was approved.
  const loadedSet = loadTaskSet(args.taskSet);
  if ("errors" in loadedSet) {
    err(`harness eval: ${args.taskSet} is not a valid task set:\n${loadedSet.errors.map((e) => `  ${e}`).join("\n")}`);
    return EXIT.usage;
  }
  const taskSet = loadedSet.taskSet;
  const workflowFile = args.workflow !== undefined ? resolve(args.workflow) : taskSet.workflow;
  if (workflowFile === undefined) {
    err("harness eval: no workflow to run: pass --workflow, or name one in the task set (workflow:)");
    return EXIT.usage;
  }
  const loaded = loadWorkflow(workflowFile);
  if ("error" in loaded) {
    err(`harness eval: ${loaded.error}`);
    return EXIT.usage;
  }
  const graph = defToGraph(loaded.def);
  if (!checkWorkflowGraph(graph, "harness eval", err)) return EXIT.usage;

  const selection = selectTasks(taskSet.tasks, args.split, args.only);
  if ("error" in selection) {
    err(`harness eval: ${selection.error}`);
    return EXIT.usage;
  }
  const tasks = selection.tasks;
  const nodeIssues = nodeProblems(tasks, graph);
  if (nodeIssues.length > 0) {
    err(`harness eval: the task set does not fit the workflow ${workflowFile}:\n${nodeIssues.map((p) => `  ${p}`).join("\n")}`);
    return EXIT.usage;
  }
  const allowScorers = new Set(args.allowScorers);
  const unapproved = unapprovedScorerCommands(tasks, allowScorers);
  if (unapproved.length > 0) {
    err(`harness eval: ${unapproved.length === 1 ? "this scorer command is" : "these scorer commands are"} not approved. ` +
      "A scorer command runs only when it is passed exactly with --allow-scorer \"<command>\":\n" +
      unapproved.map((u) => `  ${u.command}    (${u.scorers.join(", ")})`).join("\n"));
    return EXIT.usage;
  }
  const k = args.trials ?? taskSet.trials ?? 1;
  const evalId = `eval-${Date.now()}`;
  const outDir = args.out !== undefined ? resolve(args.out) : join(process.cwd(), ".harness", "evals", evalId);
  const outProblem = outDirProblem(outDir);
  if (outProblem) {
    err(`harness eval: ${outProblem}`);
    return EXIT.usage;
  }

  const core = await openCore(args.core, "harness eval", err);
  if (!core) return EXIT.notStarted;
  const stop = createInterrupt(err, (code) => process.exit(code), "eval");
  const activeCommands = new Set<string>();
  // Ctrl+C stops the runs as Stop does, and the scorer commands that are running.
  const onSigint = () => {
    stop.onInterrupt();
    for (const commandId of activeCommands) core.invoke("cancel_command", { commandId }).catch(() => {});
  };
  process.on("SIGINT", onSigint);
  let tempDir: string | undefined;
  try {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      err(`harness eval: cannot make the output folder ${outDir}: ${String(e)}`);
      return EXIT.usage;
    }
    tempDir = mkdtempSync(join(tmpdir(), "harness-eval-"));
    // Progress goes to stdout, or with --json to stderr, which leaves stdout to the report.
    const progress: Write = args.json ? err : out;
    const warned = new Set<string>();
    const settings = providerSettings(args, process.env);
    const workflowRef = { name: loaded.def.meta.name, path: workflowFile, hash: createHash("sha256").update(loaded.text).digest("hex") };
    const header = {
      evalId, taskSet: { name: taskSet.name, path: taskSet.path, hash: taskSet.hash }, workflow: workflowRef,
      split: args.split, k, startedAt: new Date().toISOString(),
      provider: {
        llmProvider: settings.llmProvider, ollamaBaseUrl: settings.ollamaBaseUrl, ollamaModel: settings.ollamaModel,
        customApiUrl: settings.customApiUrl, customApiModel: settings.customApiModel, ollamaNumCtx: settings.ollamaNumCtx,
      },
    };
    const env: TrialEnv = {
      invoke: core.invoke, graph, workflow: { path: workflowRef.path, hash: workflowRef.hash }, provider: settings,
      allowCommands: new Set(args.allowCommands), allowScorers, tempDir, outDir, evalId, keepWorkspaces: args.keepWorkspaces,
      isCancelled: stop.interrupted, coreStopped: core.stopped, activeCommands,
      // A warning of a run (the context window) matters to the whole eval: said once on the console.
      onWarning: (line) => {
        if (warned.has(line)) return;
        warned.add(line);
        err(line);
      },
    };

    const finished = new Map<string, TrialResult[]>(tasks.map((t) => [t.id, []]));
    const taskTrials = (): TaskTrials[] => tasks.map((t) => ({
      id: t.id, weight: t.weight, trials: [...(finished.get(t.id) ?? [])].sort((a, b) => a.trial - b.trial),
    }));
    const reportFile = join(outDir, "report.json");
    const write = (status: EvalStatus, end: { finishedAt?: string; error?: string } = {}): EvalReport => {
      const report = buildReport(header, taskTrials(), status, end);
      writeReport(reportFile, report);
      return report;
    };
    write("running");

    // The trials, in task order and then trial order.
    const planned = tasks.flatMap((task) => Array.from({ length: k }, (_, trial) => ({ task, trial })));
    let done = 0;
    let stoppedEarly: string | undefined;
    await runPool(planned, args.maxParallelTrials, () => stop.interrupted() || stoppedEarly !== undefined, async ({ task, trial }, index) => {
      try {
        const result = await runTrial(env, task, trial);
        if (result === undefined) return; // interrupted: this trial counts for nothing
        finished.get(task.id)?.push(result);
        progress(trialLine(++done, planned.length, task.id, result));
        write("running");
        // The first trial's run not starting means nothing will: say so now. A later one is a missing trial.
        if (index === 0 && result.runStatus === "not_started") {
          stoppedEarly = `the first trial's run did not start: ${result.error ?? "no reason given"}`;
        } else if (core.stopped()) {
          stoppedEarly = "harness-core stopped during the eval";
        }
      } catch (e) {
        stoppedEarly ??= `the eval broke: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const status: EvalStatus = stop.interrupted() && done < planned.length ? "cancelled" : stoppedEarly !== undefined ? "error" : "done";
    const report = write(status, { finishedAt: new Date().toISOString(), error: stoppedEarly });
    for (const line of summaryLines(report)) progress(line);
    progress(`Report: ${reportFile}`);
    if (args.keepWorkspaces) progress(`Trial folders kept in ${tempDir}`);
    if (args.json) out(reportText(report).trimEnd());
    if (status === "error" && stoppedEarly) err(`harness eval: ${stoppedEarly}`);
    const code = evalExitCode(report, args.minScore);
    if (code === EXIT.failed) err(`harness eval: S ${report.S?.toFixed(3)} is below --min-score ${args.minScore}`);
    return code;
  } finally {
    process.off("SIGINT", onSigint);
    await core.close();
    if (tempDir !== undefined && !args.keepWorkspaces) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        err(`warning: could not delete ${tempDir}: ${String(e)}`);
      }
    }
  }
}
