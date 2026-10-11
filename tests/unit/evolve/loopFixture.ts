// Shared by the tests of the loop (loop.test.ts). Not a test file.
//
// A fake `Children`: an eval writes the folder and report.json that `harness eval` writes (built with buildReport), with rewards and
// tokens scripted by the text of the workflow it is given; a run returns a scripted final output per role, round, variant and attempt.
// Nothing here starts a process.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildReport, writeReport, type ReportHeader, type TaskTrials } from "@/cli/evalReport";
import type { TaskDef, TaskSet } from "@/cli/taskSet";
import type { TrialResult } from "@/cli/trial";
import { configFromJson, type EvolveConfig } from "@/evolve/config";
import type { HistoryRecord } from "@/evolve/history";
import { History } from "@/evolve/history";
import type { Children, EvalReply, EvalRequest, EvolveContext, RunReply, RunRequest } from "@/evolve/loop";
import { leakagePatterns } from "@/evolve/precheck";
import { sha256, type Frontier, type Pins } from "@/evolve/state";

// ── The workflow and the task set ─────────────────────────────────────────────

/** Two agents, Writer then Checker. The text "be excellent" in a prompt is what the fake policy answers well to. */
export const WORKFLOW = `# The workflow of the loop tests.
meta:
  name: Loop Fixture
  version: "1.0.0"
  description: A small workflow
  projectRoot: ""
  createdAt: "2026-10-11T00:00:00Z"
  updatedAt: "2026-10-11T00:00:00Z"

agents:
  # agent-0: writes
  - name: Writer
    role: worker
    model: big-model
    temperature: 0.5
    maxTokens: 1000
    maxSteps: 3
    timeoutSeconds: 100
    promptSource:
      type: inline
      content: Write the answer.
    tools: [read_file]
    memoryRead: []
    memoryWrite: []
    tokens: { used: 0, budget: 0 }
    status: idle

  # agent-1: checks
  - name: Checker
    role: critic
    model: big-model
    temperature: 0.3
    maxTokens: 1500
    maxSteps: 2
    timeoutSeconds: 150
    promptSource:
      type: inline
      content: |
        Check the answer.
        Be brief.
    tools: []
    memoryRead: []
    memoryWrite: []
    tokens: { used: 0, budget: 0 }
    status: idle

connections:
  - id: write-to-check
    sourceAgentId: agent-0
    targetAgentId: agent-1
    edgeKind: dataflow

executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0

nodePositions:
  agent-0: { x: 0, y: 100 }
  agent-1: { x: 250, y: 100 }
`;

const task = (id: string, split: "evolve" | "heldout", smoke: boolean): TaskDef => ({
  id, split, smoke, weight: 1, task: `Do the ${id} task.`,
  // "ok" is under 4 characters, so the precheck does not take it for a pattern
  scorers: [{ kind: "output", name: "says-ok", weight: 1, contains: ["ok"], notContains: [], matches: [] }],
});

/** task-alpha, task-beta and task-gamma on the evolve split (task-alpha is the smoke task, when there is one), and held-delta held out. */
export function makeTaskSet(smoke: boolean, heldout: boolean): TaskSet {
  const tasks = [task("task-alpha", "evolve", smoke), task("task-beta", "evolve", false), task("task-gamma", "evolve", false)];
  if (heldout) tasks.push(task("held-delta", "heldout", false));
  return { name: "loop-demo", path: "/ts/loop.tasks.yaml", hash: "taskset-hash-1", dir: "/ts", tasks };
}

// ── The fake policy ───────────────────────────────────────────────────────────

/** What the workflow's text does to a trial. */
export interface Behaviour {
  reward(text: string, task: string, trial: number, split: string): number;
  /** The tokens of a trial. */
  tokens(text: string): number;
  /** How the trial goes: "done", "error" (the run ended in error) or "missing" (it never ran). */
  trial(text: string, task: string, trial: number, split: string): "done" | "error" | "missing";
  /** Wall-clock minutes of an evolve eval. */
  minutes: number;
}

/** Rewards of the base workflow: S = 0.5 on the evolve split, 0 on the held-out one. Any workflow with "be excellent" gets 1. */
const BASE_REWARDS: Record<string, number[]> = { "task-alpha": [1, 0], "task-beta": [0, 0], "task-gamma": [1, 1], "held-delta": [0, 0] };

export const defaultBehaviour: Behaviour = {
  reward: (text, id, trial) => (text.includes("be excellent") ? 1 : (BASE_REWARDS[id]?.[trial] ?? 0)),
  tokens: (text) => (text.includes("be verbose") ? 5000 : 1000),
  trial: () => "done",
  minutes: 9,
};

// ── Proposals and verdicts ────────────────────────────────────────────────────

export const fenced = (value: unknown): string => `Here it is.\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

/** One edit of a proposal. */
export function edit(id: string, ops: object[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, component: "prompt", hypothesis: `why ${id}`, targets_mode: "a failure in the traces", predicted_affected: ["task-beta"],
    retroactive_check: "it transfers", ops, ...extra,
  };
}

export const proposal = (...edits: Array<Record<string, unknown>>): string => fenced({ summary: "a candidate", edits });

/** The edit the fake policy answers to. */
export const EXCELLENT = edit("C1", [{ op: "replace_text", agent: "Writer", field: "prompt", old: "Write the answer.", new: "Write the answer and be excellent." }]);

/** An edit that changes nothing the fake policy reads: a description, different for every round and variant. */
export const tweak = (t: number, variant: string): Record<string, unknown> =>
  edit("C1", [{ op: "set_text", agent: "Checker", field: "description", value: `tweak ${t}${variant}` }]);

export const ACCEPT = fenced({ verdict: "accept", reasons: [], risk_notes: [] });
export const reject = (reasons: string[], riskNotes: string[] = []): string => fenced({ verdict: "reject", reasons, risk_notes: riskNotes });

// ── The fake children ─────────────────────────────────────────────────────────

/** Where an eval is, relative to the run's folder. */
export interface EvalInfo {
  dir: string;
  split: string;
  text: string;
  /** How many evals have been asked for so far, this one included. */
  n: number;
}

export interface RunInfo {
  role: "proposer" | "critic";
  t: number;
  variant: string;
  attempt: number;
  /** The critic's run number within the attempt; 0 for the proposer. */
  critic: number;
  /** The brief or the review the run was given. */
  task: string;
  /** The workflow in the proposer's workspace. */
  workflow: string;
  /** How many runs of this role have been asked for so far, this one included. */
  n: number;
}

const unix = (path: string): string => path.split("\\").join("/");

const provider = {
  llmProvider: "ollama", ollamaBaseUrl: "http://localhost:11434", ollamaModel: "fake-model", customApiUrl: "", customApiModel: "", ollamaNumCtx: 16384,
} as const;

export class FakeChildren implements Children {
  readonly evals: EvalRequest[] = [];
  readonly runs: RunRequest[] = [];
  behaviour: Behaviour = { ...defaultBehaviour };
  /** The proposer's final output. */
  proposer: (info: RunInfo) => string | undefined = (info) => proposal(info.t === 0 && info.variant === "A" ? EXCELLENT : tweak(info.t, info.variant));
  critic: (info: RunInfo) => string | undefined = () => ACCEPT;
  /** Takes over an eval (return its reply) or lets the fake do it (return undefined). May throw, as a crashed child does. */
  onEval?: (request: EvalRequest, info: EvalInfo) => EvalReply | undefined;
  onRun?: (request: RunRequest, info: RunInfo) => RunReply | undefined;
  private proposerCalls = 0;
  private criticCalls = 0;

  constructor(private readonly outDir: string, private readonly taskSet: TaskSet) {}

  /** A path of a request, relative to the run's folder. */
  rel(path: string): string {
    return unix(relative(this.outDir, path));
  }

  evalDirs(): string[] {
    return this.evals.map((request) => this.rel(request.out));
  }

  async eval(request: EvalRequest): Promise<EvalReply> {
    this.evals.push(request);
    const text = readFileSync(request.workflow, "utf8");
    const info: EvalInfo = { dir: this.rel(request.out), split: request.split, text, n: this.evals.length };
    const taken = this.onEval?.(request, info);
    if (taken !== undefined) return taken;
    // `harness eval` refuses a folder that is not empty (exit 2)
    if (existsSync(request.out) && readdirSync(request.out).length > 0) return { code: 2 };
    mkdirSync(request.out, { recursive: true });
    const header: ReportHeader = {
      evalId: `eval-${this.evals.length}`, taskSet: { name: this.taskSet.name, path: this.taskSet.path, hash: this.taskSet.hash },
      workflow: { name: "Loop Fixture", path: request.workflow, hash: sha256(text) }, split: request.split, k: request.k, provider,
      startedAt: "2026-10-11T10:00:00.000Z",
    };
    const minutes = request.split === "evolve" ? this.behaviour.minutes : 1;
    const finishedAt = new Date(Date.parse(header.startedAt) + minutes * 60000).toISOString();
    const report = buildReport(header, this.trialsOf(request, text), "done", { finishedAt });
    writeReport(join(request.out, "report.json"), report);
    return { code: 0, report: JSON.parse(readFileSync(join(request.out, "report.json"), "utf8")) };
  }

  /** The reply of an eval that crashed: exit 3 and a report with status "error". */
  crash(request: EvalRequest, error: string): EvalReply {
    mkdirSync(request.out, { recursive: true });
    const text = readFileSync(request.workflow, "utf8");
    const header: ReportHeader = {
      evalId: "eval-crashed", taskSet: { name: this.taskSet.name, path: this.taskSet.path, hash: this.taskSet.hash },
      workflow: { name: "Loop Fixture", path: request.workflow, hash: sha256(text) }, split: request.split, k: request.k, provider,
      startedAt: "2026-10-11T10:00:00.000Z",
    };
    writeReport(join(request.out, "report.json"), buildReport(header, [], "error", { finishedAt: "2026-10-11T10:00:01.000Z", error }));
    return { code: 3, report: JSON.parse(readFileSync(join(request.out, "report.json"), "utf8")) };
  }

  private tasksFor(split: EvalRequest["split"]): TaskDef[] {
    return this.taskSet.tasks.filter((t) => (split === "smoke" ? t.smoke : t.split === split));
  }

  private trialsOf(request: EvalRequest, text: string): TaskTrials[] {
    return this.tasksFor(request.split).map((def) => ({
      id: def.id, weight: def.weight,
      trials: Array.from({ length: request.k }, (_, i) => this.trialOf(request, text, def, i)),
    }));
  }

  /** One trial: its result, and the files `harness eval` keeps of it under trials/<task>/t<i>/. */
  private trialOf(request: EvalRequest, text: string, def: TaskDef, i: number): TrialResult {
    const how = this.behaviour.trial(text, def.id, i, request.split);
    const reward = how === "missing" ? 0 : this.behaviour.reward(text, def.id, i, request.split);
    const total = this.behaviour.tokens(text);
    const missing = how === "missing";
    const error = missing ? "the run did not start" : how === "error" ? "the Writer failed" : undefined;
    const result: TrialResult = {
      trial: i, reward, missing, ...(error === undefined ? {} : { error }), runStatus: missing ? "not_started" : how === "error" ? "error" : "done",
      runMs: 1000, scoreMs: 10, tokens: missing ? null : { input: total - total / 5, output: total / 5 }, tokenEstimate: missing ? null : total,
      scorers: missing ? [] : [{ name: "says-ok", kind: "output", passed: reward >= 1, weight: 1, ms: 1 }],
    };
    const dir = join(request.out, "trials", def.id, `t${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "outcome.json"), `${JSON.stringify({
      task: def.id, trial: i, runId: null, runStatus: result.runStatus, missing, error: error ?? null, reward, runMs: 1000, scoreMs: 10,
      tokens: result.tokens, tokenEstimate: result.tokenEstimate,
      agents: { "agent-0": { agent: "Writer", status: "done" }, "agent-1": { agent: "Checker", status: "done" } },
      outputs: missing ? {} : { "agent-1": `the answer to ${def.id}, trial ${i}${reward >= 1 ? ": ok" : ""}` },
    }, null, 2)}\n`);
    writeFileSync(join(dir, "scorers.json"), `${JSON.stringify(result.scorers.map((s) => ({ ...s, ...(s.passed ? {} : { detail: "no \"ok\" in the output" }) })), null, 2)}\n`);
    writeFileSync(join(dir, "run.log"), `✓ Writer done (0.5 s)\n✓ Checker done (0.5 s)\n`);
    return result;
  }

  async run(request: RunRequest): Promise<RunReply> {
    const path = this.rel(request.workspace);
    const proposer = /^r(\d+)\/([A-H])\/a(\d+)\/proposer$/.exec(path);
    const critic = /^r(\d+)\/([A-H])\/a(\d+)\/critic-(\d+)$/.exec(path);
    const match = proposer ?? critic;
    if (match === null) throw new Error(`the fake does not know the workspace ${path}`);
    const info: RunInfo = {
      role: request.role, t: Number(match[1]), variant: match[2], attempt: Number(match[3]), critic: critic === null ? 0 : Number(critic[4]),
      task: readFileSync(request.taskFile, "utf8"), workflow: proposer === null ? "" : readFileSync(join(request.workspace, "workflow.harness.yaml"), "utf8"),
      n: request.role === "proposer" ? ++this.proposerCalls : ++this.criticCalls,
    };
    this.runs.push(request);
    const taken = this.onRun?.(request, info);
    if (taken !== undefined) return taken;
    const finalOutput = request.role === "proposer" ? this.proposer(info) : this.critic(info);
    return { code: 0, finalOutput, tokens: { input: 100, output: 50 } };
  }

  /** The workspaces of the runs of a role, relative to the run's folder, in order. */
  workspaces(role: "proposer" | "critic"): string[] {
    return this.runs.filter((r) => r.role === role).map((r) => this.rel(r.workspace));
  }
}

// ── A world: a folder, a context, the fake ────────────────────────────────────

export interface WorldOptions {
  cfg?: Partial<EvolveConfig>;
  smoke?: boolean;
  heldout?: boolean;
}

export interface World {
  outDir: string;
  taskSet: TaskSet;
  children: FakeChildren;
  ctx: EvolveContext;
  /** Everything the loop said. */
  lines: string[];
  cfg: EvolveConfig;
  /** Set to make the loop see Ctrl+C. */
  state: { interrupted: boolean };
  read(path: string): string;
  json(path: string): any;
  exists(path: string): boolean;
  frontier(): Frontier;
  history(): HistoryRecord[];
}

const made: string[] = [];

/** Deletes the folders the worlds made; for an `afterEach`. */
export function cleanupWorlds(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeWorld(options: WorldOptions = {}): World {
  const outDir = mkdtempSync(join(tmpdir(), "evolve-loop-"));
  made.push(outDir);
  const checked = configFromJson({}, { T: 2, k: 2, m: 2, w: 1, repair_rounds: 1, n_fail_traces: 2, n_success_traces: 1, ...options.cfg });
  if ("error" in checked) throw new Error(checked.error);
  const cfg = checked.config;
  const taskSet = makeTaskSet(options.smoke ?? false, options.heldout ?? false);
  const children = new FakeChildren(outDir, taskSet);
  const lines: string[] = [];
  const state = { interrupted: false };
  const pins: Pins = {
    taskSet: { path: taskSet.path, hash: taskSet.hash }, workflow: { path: "/user/workflow.harness.yaml", hash: sha256(WORKFLOW) },
    provider: { llmProvider: "ollama", baseUrl: "http://localhost:11434", model: "fake-model", numCtx: 16384 }, k: cfg.k, config: cfg,
  };
  const ctx: EvolveContext = {
    outDir, taskSet, hasSmoke: options.smoke ?? false, hasHeldout: options.heldout ?? false, patterns: leakagePatterns(taskSet),
    protectedAgents: new Map(), workflowText: WORKFLOW, cfg, pins,
    proposerFile: "/search/proposer.harness.yaml", criticFile: "/search/critic.harness.yaml", children,
    out: (line) => lines.push(line), interrupted: () => state.interrupted,
  };
  const read = (path: string): string => readFileSync(join(outDir, path), "utf8");
  return {
    outDir, taskSet, children, ctx, lines, cfg, state, read, json: (path) => JSON.parse(read(path)), exists: (path) => existsSync(join(outDir, path)),
    frontier: () => JSON.parse(read("frontier.json")) as Frontier, history: () => new History(join(outDir, "history.jsonl")).records(),
  };
}
