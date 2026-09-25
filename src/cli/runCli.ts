/**
 * harness run: runs a workflow without the app, for CI (docs/HEADLESS.md). The
 * engine is the app's (src/engine/runWorkflow.ts); the Rust commands come from
 * harness-core over its pipes. Bundled by `npm run build:cli` into
 * cli/dist/harness-run.mjs, which `node cli/harness.mjs run` loads.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runWorkflow, type RunHost, type RunOutcome } from "@/engine/runWorkflow";
import { defToGraph } from "@/engine/workflowGraph";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import type { WorkflowDef } from "@/types/workflow";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { startCore } from "@/cli/coreClient";
import { createReporter, type Write } from "@/cli/report";
import { parseRunArgs, providerSettings, RUN_USAGE } from "@/cli/runArgs";

export const EXIT = { done: 0, failed: 1, usage: 2, notStarted: 3, interrupted: 130 } as const;

/** The exit code for a run's outcome. harness-core stopping during the run counts as not starting. */
export function exitCode(outcome: RunOutcome, coreStopped: boolean): number {
  if (!outcome.started || coreStopped) return EXIT.notStarted;
  if (outcome.run.status === "done") return EXIT.done;
  return outcome.run.status === "cancelled" ? EXIT.interrupted : EXIT.failed;
}

/** Ctrl+C once stops the run, like the app's Stop; twice exits at once. */
export function createInterrupt(err: Write, exit: (code: number) => void) {
  let interrupted = false;
  return {
    interrupted: () => interrupted,
    onInterrupt: () => {
      if (interrupted) exit(EXIT.interrupted);
      interrupted = true;
      err("Stopping the run… (press Ctrl+C again to exit now)");
    },
  };
}

/** harness-core: --core, then HARNESS_CORE, then this repo's release build. */
export function corePath(flag: string | undefined, env: Record<string, string | undefined>, platform: string): string {
  if (flag) return resolve(flag);
  if (env.HARNESS_CORE) return resolve(env.HARNESS_CORE);
  const exe = platform === "win32" ? "harness-core.exe" : "harness-core";
  return fileURLToPath(new URL(`../../src-tauri/target/release/${exe}`, import.meta.url).href);
}

/** The workflow file, checked with the app's schema; or what is wrong with it. */
function loadWorkflow(file: string): { def: WorkflowDef } | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `cannot read ${file}: ${String(e)}` };
  }
  const checked = workflowDefSchema.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    return { error: `${file} is not a valid workflow:\n${issues}` };
  }
  return { def: checked.data as WorkflowDef };
}

/** `harness run <workflow> …`; returns the exit code. */
export async function runHarness(argv: string[]): Promise<number> {
  const out: Write = (line) => { process.stdout.write(`${line}\n`); };
  const err: Write = (line) => { process.stderr.write(`${line}\n`); };
  if (argv.includes("--help") || argv.includes("-h")) {
    out(RUN_USAGE);
    return EXIT.done;
  }
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) {
    err(`harness run: ${parsed.error}\n\n${RUN_USAGE}`);
    return EXIT.usage;
  }
  const args = parsed.args;
  const loaded = loadWorkflow(args.workflow);
  if ("error" in loaded) {
    err(`harness run: ${loaded.error}`);
    return EXIT.usage;
  }
  let task: string;
  try {
    task = args.task ?? readFileSync(args.taskFile ?? "", "utf8");
  } catch (e) {
    err(`harness run: cannot read the task file: ${String(e)}`);
    return EXIT.usage;
  }
  const workspacePath = resolve(args.workspace ?? ".");
  if (!existsSync(workspacePath)) {
    err(`harness run: the workspace ${workspacePath} does not exist`);
    return EXIT.usage;
  }
  const graph = defToGraph(loaded.def);
  if (args.maxParallel) graph.executionSettings = { ...graph.executionSettings, maxParallel: args.maxParallel };
  const validation = validateWorkflow(graph.nodes, graph.edges);
  for (const warning of validation.warnings) err(`warning: ${warning.message}`);
  if (!validation.valid) {
    for (const problem of validation.errors) err(`harness run: ${problem.message}`);
    return EXIT.usage;
  }

  const coreFile = corePath(args.core, process.env, process.platform);
  if (!existsSync(coreFile)) {
    err(`harness run: harness-core not found at ${coreFile}. Build it with npm run build:core, or pass --core <path>.`);
    return EXIT.notStarted;
  }
  // A JavaScript core (the tests' fake) runs with node.
  const core = /\.[cm]?js$/.test(coreFile) ? startCore(process.execPath, [coreFile]) : startCore(coreFile);
  try {
    await core.invoke("get_provider_defaults");
  } catch (e) {
    err(`harness run: harness-core did not answer: ${String(e)}`);
    await core.close(1000);
    return EXIT.notStarted;
  }

  const stop = createInterrupt(err, (code) => process.exit(code));
  process.on("SIGINT", stop.onInterrupt);
  const reporter = createReporter(graph, args.json, out, err);
  const allowed = new Set(args.allowCommands);
  const host: RunHost = {
    invoke: core.invoke,
    events: reporter.events,
    // The user allowed these exact commands up front; every other command is denied.
    askCommand: async ({ command }) => (allowed.has(command.trim()) ? "granted" : "deny"),
    commandPolicy: "--allow-command",
    isCancelled: stop.interrupted,
    revealOutput: false,
  };
  const started = Date.now();
  try {
    const outcome = await runWorkflow({
      graph,
      config: { userInput: task, contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
      provider: providerSettings(args, process.env),
      workspacePath,
      continueOnError: args.continueOnError,
    }, host);
    reporter.summary(outcome, Date.now() - started);
    if (core.stopped()) err("harness run: harness-core stopped during the run.");
    return exitCode(outcome, core.stopped());
  } finally {
    process.off("SIGINT", stop.onInterrupt);
    await core.close();
  }
}
