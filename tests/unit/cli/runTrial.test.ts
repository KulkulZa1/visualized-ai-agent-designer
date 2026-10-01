// @vitest-environment node
/**
 * runTrial, a trial's whole life, against the fake harness-core: what the eval keeps of a trial when something
 * moves the trial's folder under it. (trial.test.ts has the scorers, with a stand-in for harness-core.)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import { AgentRole } from "@/types/agent";
import { startCore } from "@/cli/coreClient";
import { parseEvalArgs, type EvalArgs } from "@/cli/evalArgs";
import { providerSettings } from "@/cli/runArgs";
import type { TaskDef } from "@/cli/taskSet";
import { copyTree, runTrial, type TrialEnv } from "@/cli/trial";

const fakeCore = resolve(__dirname, "../../fixtures/fake-core.mjs");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const canLink = process.platform !== "win32";

function folder(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "harness-runtrial-")));
  scratch.push(dir);
  return dir;
}

/** One agent, whose model answers "ok". */
const graph: WorkflowGraph = {
  nodes: [{
    id: "agent-0", type: "agent", position: { x: 0, y: 0 },
    data: {
      name: "Coder", role: AgentRole.Worker, model: "m", temperature: 0.7, maxTokens: 1024, maxSteps: 3, timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    },
  }],
  edges: [],
  meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
  executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
};

/** A trial of one task (a fixture with one file; the answer must hold "ok"), in a folder of its own; `swap` is called when the run
 *  record is first written, with the trial's folder: whatever it does to the folder happens in the middle of the run. */
async function trial(swap?: (trialDir: string, base: string) => void) {
  const base = folder();
  mkdirSync(join(base, "fixture"));
  writeFileSync(join(base, "fixture", "readme.md"), "# fixture\n");
  const tempDir = join(base, "temp");
  const outDir = join(base, "out");
  mkdirSync(tempDir);
  mkdirSync(outDir);
  const trialDir = join(tempDir, "laptop-t0");
  const task: TaskDef = {
    id: "laptop", split: "evolve", smoke: false, weight: 1, task: "Say ok.", workspace: join(base, "fixture"),
    scorers: [{ kind: "output", name: "answer", weight: 1, contains: ["ok"], notContains: [], matches: [] }],
  };
  const core = startCore(process.execPath, [fakeCore]);
  let swapped = false;
  const invoke = (async (cmd: string, args: Record<string, unknown> = {}) => {
    const result = await core.invoke(cmd, args);
    if (swap && !swapped && cmd === "write_workspace_file" && String(args.relativePath).endsWith("/run.json")) {
      swapped = true;
      swap(trialDir, base);
    }
    return result;
  }) as InvokeFn;
  const parsed = parseEvalArgs(["t.yaml"], {});
  const env: TrialEnv = {
    invoke, graph, workflow: { path: "wf.harness.yaml", hash: "h" }, provider: providerSettings((parsed as { args: EvalArgs }).args, {}),
    allowCommands: new Set(), allowScorers: new Set(), tempDir, outDir, evalId: "eval-1", keepWorkspaces: false,
    isCancelled: () => false, coreStopped: core.stopped, activeCommands: new Set(), onWarning: () => {},
  };
  try {
    const result = await runTrial(env, task, 0);
    const kept = join(outDir, "trials", "laptop", "t0");
    return { result, kept, base, swapped, files: readdirSync(kept).sort(), outcome: JSON.parse(readFileSync(join(kept, "outcome.json"), "utf8")) };
  } finally {
    await core.close();
  }
}

describe("runTrial keeps the run record of the trial's own folder", () => {
  it("copies it, with the outcome, the scorers' results and the log", async () => {
    const run = await trial();

    expect(run.result).toMatchObject({ missing: false, reward: 1, runStatus: "done" });
    expect(run.files).toEqual(["outcome.json", "run.json", "run.log", "scorers.json"]);
    expect(JSON.parse(readFileSync(join(run.kept, "run.json"), "utf8"))).toMatchObject({ runId: run.outcome.runId, status: "done" });
  });

  it.skipIf(!canLink)("keeps none when a link has taken the place of the trial's folder during the run, to a folder that has one: the trial's folder is the one recorded when it was made", async () => {
    let decoy = "";
    const run = await trial((trialDir, base) => {
      // As an agent's background process could: a folder of its own with a copy of the run record in it, which takes the trial's place.
      decoy = join(base, "decoy");
      copyTree(join(trialDir, ".harness"), join(decoy, ".harness"));
      renameSync(trialDir, `${trialDir}-moved`);
      symlinkSync(decoy, trialDir);
    });

    expect(run.swapped).toBe(true);
    expect(run.result).toMatchObject({ missing: false, reward: 1 }); // the run was scored all the same
    // The decoy does have a run.json where the run's own is kept: following the link would have found it.
    expect(existsSync(join(decoy, ".harness", "runs", run.outcome.runId, "run.json"))).toBe(true);
    expect(run.files).toEqual(["outcome.json", "run.log", "scorers.json"]); // no run.json: what the link leads to is not the trial's
  });
});
