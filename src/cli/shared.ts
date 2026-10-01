/**
 * What `harness run` and `harness eval` share: the exit codes, the interrupt, finding and
 * starting harness-core, and loading and checking a workflow file (docs/HEADLESS.md). Both
 * commands are bundled by `npm run build:cli` into cli/dist/harness-run.mjs.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import type { WorkflowDef } from "@/types/workflow";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { startCore, type CoreClient } from "@/cli/coreClient";
import type { Write } from "@/cli/report";

export const EXIT = { done: 0, failed: 1, usage: 2, notStarted: 3, interrupted: 130 } as const;

/** Ctrl+C once stops the run (or the eval: `what`), like the app's Stop; twice exits at once. */
export function createInterrupt(err: Write, exit: (code: number) => void, what = "run") {
  let interrupted = false;
  return {
    interrupted: () => interrupted,
    onInterrupt: () => {
      if (interrupted) exit(EXIT.interrupted);
      interrupted = true;
      err(`Stopping the ${what}… (press Ctrl+C again to exit now)`);
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

/** The workflow file and its text, checked with the app's schema; or what is wrong with it. */
export function loadWorkflow(file: string): { def: WorkflowDef; text: string } | { error: string } {
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(file, "utf8");
    raw = parseYaml(text);
  } catch (e) {
    return { error: `cannot read ${file}: ${String(e)}` };
  }
  const checked = workflowDefSchema.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    return { error: `${file} is not a valid workflow:\n${issues}` };
  }
  return { def: checked.data as WorkflowDef, text };
}

/** Checks the workflow's graph as the app does. Warnings go to `err`; false means it has errors,
 *  which are written to `err` too. `command` names the command in the messages. */
export function checkWorkflowGraph(graph: WorkflowGraph, command: string, err: Write): boolean {
  const validation = validateWorkflow(graph.nodes, graph.edges);
  for (const warning of validation.warnings) {
    // The app's bash warning is about its approval dialog; here commands need --allow-command.
    const name = graph.nodes.find((n) => n.id === warning.nodeId)?.data.name;
    err(`warning: ${warning.kind === "no_hooks_on_bash" && name
      ? `"${name}" can run shell commands (bash): only the commands passed with --allow-command run.`
      : warning.message}`);
  }
  if (!validation.valid) {
    for (const problem of validation.errors) err(`${command}: ${problem.message}`);
    return false;
  }
  return true;
}

/** Starts harness-core (--core, HARNESS_CORE or the release build) and checks that it answers.
 *  undefined when it cannot: the reason is written to `err`, named after `command`. */
export async function openCore(flag: string | undefined, command: string, err: Write): Promise<CoreClient | undefined> {
  const coreFile = corePath(flag, process.env, process.platform);
  if (!existsSync(coreFile)) {
    err(`${command}: harness-core not found at ${coreFile}. Build it with npm run build:core, or pass --core <path>.`);
    return undefined;
  }
  // A JavaScript core (the tests' fake) runs with node.
  const core = /\.[cm]?js$/.test(coreFile) ? startCore(process.execPath, [coreFile]) : startCore(coreFile);
  try {
    await core.invoke("get_provider_defaults");
  } catch (e) {
    err(`${command}: harness-core did not answer: ${String(e)}`);
    await core.close(1000);
    return undefined;
  }
  return core;
}
