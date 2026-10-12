// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttributionRow } from "@/evolve/attribution";
import {
  OPERATIONS_HELP, agentsTable, criticReview, exampleProposal, pickTraces, proposerBrief, renderTrace, resultsTable,
  type ProposerBriefInput, type TraceFile,
} from "@/evolve/brief";
import { K, K_STR } from "@/evolve/components";
import { ADDABLE_TOOLS, editOpSchema, parseProposal } from "@/evolve/edits";
import { exploration, type RenderedRecord } from "@/evolve/history";
import { AgentRole } from "@/types/agent";
import { evalOf } from "./evalFixture";
import { WORKFLOW } from "./loopFixture";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── pickTraces ────────────────────────────────────────────────────────────────

describe("pickTraces: rrsi's build_traces", () => {
  // means: a 1.0, b 0.25, c 0, d 0.75, e 0.5
  const ev = evalOf("j", { a: [1, 1], b: [0.5, 0], c: [0, 0], d: [1, 0.5], e: [0.25, 0.75] }, 2);

  it("takes the lowest tasks as failures and the highest as successes, failures first", () => {
    expect(pickTraces(ev, 2, 2)).toEqual([
      { task: "c", trial: 0, kind: "fail" },
      { task: "b", trial: 1, kind: "fail" }, // the first worst trial: 0 is the second of [0.5, 0]
      { task: "d", trial: 0, kind: "success" }, // the first best trial: 1 is the first of [1, 0.5]
      { task: "a", trial: 0, kind: "success" },
    ]);
  });

  it("leaves a failure out of the successes when there are few tasks", () => {
    const three = evalOf("j", { x: [0, 0], y: [0.5, 0.5], z: [1, 1] }, 2);

    expect(pickTraces(three, 2, 2)).toEqual([
      { task: "x", trial: 0, kind: "fail" }, { task: "y", trial: 0, kind: "fail" }, { task: "z", trial: 0, kind: "success" },
    ]);
  });

  it("takes every task as a failure when asked for more than there are, and none as a success", () => {
    const two = evalOf("j", { x: [0, 1], y: [1, 1] }, 2);

    expect(pickTraces(two, 5, 5).map((p) => `${p.task}:${p.kind}`)).toEqual(["x:fail", "y:fail"]);
  });

  it("takes none for a count of 0 (rrsi's ranked[-0:] would take them all)", () => {
    expect(pickTraces(ev, 0, 0)).toEqual([]);
    expect(pickTraces(ev, 0, 1)).toEqual([{ task: "a", trial: 0, kind: "success" }]);
    expect(pickTraces(ev, 1, 0)).toEqual([{ task: "c", trial: 0, kind: "fail" }]);
  });

  it("keeps the report's order for tasks with the same mean, and picks the first of equal trials", () => {
    const ties = evalOf("j", { p: [0.5, 0.5], q: [1, 0, 1], r: [0.5, 0.5] }, 3);

    expect(pickTraces(ties, 2, 0)).toEqual([{ task: "p", trial: 0, kind: "fail" }, { task: "r", trial: 0, kind: "fail" }]);
    expect(pickTraces(ties, 0, 1)).toEqual([{ task: "q", trial: 0, kind: "success" }]);
  });

  it("skips a task with no trials", () => {
    const empty = evalOf("j", { gone: [], x: [0, 1] }, 2);

    expect(pickTraces(empty, 2, 0)).toEqual([{ task: "x", trial: 0, kind: "fail" }]);
  });
});

// ── renderTrace ───────────────────────────────────────────────────────────────

/** A trial's folder, `trials/<task>/t<i>/`, with what `keepTrial` writes (any file can be left out). */
function trialFolder(files: { outcome?: unknown; scorers?: unknown; log?: string }, name = "t1"): string {
  const root = mkdtempSync(join(tmpdir(), "evolve-trace-"));
  scratch.push(root);
  const dir = join(root, "trials", "task-one", name);
  mkdirSync(dir, { recursive: true });
  if (files.outcome !== undefined) writeFileSync(join(dir, "outcome.json"), JSON.stringify(files.outcome));
  if (files.scorers !== undefined) writeFileSync(join(dir, "scorers.json"), JSON.stringify(files.scorers));
  if (files.log !== undefined) writeFileSync(join(dir, "run.log"), files.log);
  return dir;
}

const outcome = (over: Record<string, unknown> = {}) => ({
  task: "task-one", trial: 1, runId: "run-1", runStatus: "done", missing: false, error: null, reward: 0.5, runMs: 1000, scoreMs: 10,
  tokens: { input: 80, output: 20 }, tokenEstimate: 100,
  agents: { "agent-0": { agent: "Writer", status: "done" }, "agent-1": { agent: "Checker", status: "done" } },
  outputs: { "agent-1": "The report.\n## Summary\nSome text." }, ...over,
});

const scorers = [
  { name: "says-summary", kind: "output", passed: true, weight: 1, ms: 1, stdout: "this passing scorer's output is not shown" },
  { name: "tests", kind: "command", passed: false, weight: 1, exitCode: 1, ms: 20, command: "npm test", stdout: "1 failing\n  expected 2, got 3", stderr: "boom" },
  { name: "slow", kind: "command", passed: false, weight: 1, timedOut: true, ms: 100, command: "sleep 9", detail: "Command timed out after 5 s" },
];

const task = { id: "task-one", task: "Summarise the notes." };

describe("renderTrace", () => {
  it("shows the task and trial, reward and status, the task, the scorers, the final outputs and the run log", () => {
    const dir = trialFolder({ outcome: outcome(), scorers, log: "✓ Writer done (0.5 s)\n✗ Checker failed: boom\n" });

    const text = renderTrace(task, dir);

    expect(text).toContain("# Trace: task task-one, trial 1");
    expect(text).toContain("- reward: 0.50\n- run status: done");
    expect(text).toContain("## The task\n\n```\nSummarise the notes.\n```");
    expect(text).toContain("- **says-summary** (output): passed\n");
    expect(text).toContain("- **tests** (command): FAILED, exit code 1\n  - stdout, the end:\n    ```text\n    1 failing\n      expected 2, got 3\n    ```");
    expect(text).toContain("  - stderr, the end:\n    ```text\n    boom\n    ```");
    expect(text).toContain("- **slow** (command): FAILED, timed out\n  - detail: Command timed out after 5 s");
    expect(text).not.toContain("this passing scorer's output");
    expect(text).toContain("## Final outputs\n\n### Checker (agent-1)\n\n```\nThe report.\n## Summary\nSome text.\n```");
    expect(text).toContain("## Run log\n\n```\n✓ Writer done (0.5 s)\n✗ Checker failed: boom\n```");
    expect(text.indexOf("## The task")).toBeLessThan(text.indexOf("## Scorers"));
    expect(text.indexOf("## Scorers")).toBeLessThan(text.indexOf("## Final outputs"));
    expect(text.indexOf("## Final outputs")).toBeLessThan(text.indexOf("## Run log"));
  });

  it("says a trial is missing and why", () => {
    const dir = trialFolder({ outcome: outcome({ missing: true, runStatus: "not_started", error: "the run did not start", reward: 0, outputs: {} }), scorers: [], log: "" });

    const text = renderTrace(task, dir);

    expect(text).toContain("- missing: yes (the trial counts as a reward of 0)");
    expect(text).toContain("- error: the run did not start");
    expect(text).toContain("(no scorer record)");
    expect(text).toContain("(the run produced no final output)");
    expect(text).toContain("## Run log\n\n(empty)");
  });

  it("says which files are missing instead of failing", () => {
    const dir = trialFolder({}, "t3");

    const text = renderTrace({ id: "task-one", task: "" }, dir);

    expect(text).toContain("# Trace: task task-one, trial 3");
    expect(text).toContain("outcome.json is missing or unreadable");
    expect(text).toContain("(no task text)");
    expect(text).toContain("(run.log is missing)");
  });

  it("uses a longer fence than any run of backticks in the text it shows", () => {
    const dir = trialFolder({ outcome: outcome({ outputs: { "agent-1": "```js\ncode\n```" } }), scorers: [], log: "````\nfour\n````" });

    const text = renderTrace(task, dir);

    expect(text).toContain("````\n```js\ncode\n```\n````");
    expect(text).toContain("`````\n````\nfour\n````\n`````");
  });

  it("is unchanged under the cap", () => {
    const dir = trialFolder({ outcome: outcome(), scorers, log: "a log\n" });

    expect(renderTrace(task, dir, 12000)).toBe(renderTrace(task, dir, 1e9));
  });

  it("cuts the run log first, keeping its end, to stay under the cap", () => {
    const log = Array.from({ length: 5000 }, (_, i) => `log line ${i}`).join("\n");
    const dir = trialFolder({ outcome: outcome(), scorers, log });

    const text = renderTrace(task, dir);

    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toMatch(/\[\.\.\. \d+ characters cut from the start of the log\]/);
    expect(text).toContain("log line 4999");
    expect(text).not.toContain("log line 0\n");
    expect(text).toContain("The report.\n## Summary\nSome text."); // the outputs are whole
    expect(text).toContain("- **tests** (command): FAILED, exit code 1");
    expect(text.length).toBeGreaterThan(11000); // and as much of the log as fits is kept
  });

  it("cuts the outputs when the log is gone and the text is still over the cap", () => {
    const dir = trialFolder({ outcome: outcome({ outputs: { "agent-1": `START${"o".repeat(20000)}` } }), scorers, log: "a short log" });

    const text = renderTrace(task, dir, 3000);

    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain("START");
    expect(text).toMatch(/\[\.\.\. \d+ more characters cut\]/);
    expect(text).toContain("the run log, 11 characters, is left out to fit in 3000 characters");
  });

  it("does not cut a character in half, whatever the cap, when the text is full of emoji", () => {
    const dir = trialFolder({ outcome: outcome({ outputs: { "agent-1": "😀".repeat(3000) } }), scorers, log: "🎉".repeat(6000) });
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const cap of [301, 777, 1500, 4001, 9000, 12000]) {
      const text = renderTrace({ id: "task-one", task: "😀".repeat(500) }, dir, cap);
      expect(text.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(lone.test(text), `cap ${cap}`).toBe(false);
    }
  });

  it("never exceeds the cap, even when the task and the scorers alone are over it", () => {
    const dir = trialFolder({ outcome: outcome(), scorers, log: "x".repeat(50000) });

    for (const cap of [100, 300, 800, 1500, 2500, 5000]) {
      const text = renderTrace({ id: "task-one", task: "t".repeat(2000) }, dir, cap);
      expect(text.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
    expect(renderTrace({ id: "task-one", task: "t".repeat(2000) }, dir, 1000)).toContain("[... the trace is cut to fit]");
  });
});

// ── resultsTable, agentsTable ─────────────────────────────────────────────────

describe("resultsTable", () => {
  it("lists per task the mean, the rewards, the scorers that failed in any trial, and the first error", () => {
    const ev = evalOf("j", { a: [1, 1], b: [0, 1], c: [0, 0] }, 2);
    const report = {
      per_task: {
        a: { trials: [{ scorers: [{ name: "x", passed: true }] }, { scorers: [{ name: "x", passed: true }] }] },
        b: {
          trials: [
            { error: "the Writer failed | badly", scorers: [{ name: "s1", passed: false }, { name: "s2", passed: true }] },
            { scorers: [{ name: "s1", passed: false }, { name: "s3", passed: false }] },
          ],
        },
        c: { trials: [{ missing: true, error: "e".repeat(300), scorers: [] }, {}] },
      },
    };

    const lines = resultsTable(report, ev).split("\n");

    expect(lines).toEqual([
      "| task | mean | rewards | failed scorers | first error |",
      "| --- | --- | --- | --- | --- |",
      "| a | 1.00 | 1.00 1.00 | - | - |",
      "| b | 0.50 | 0.00 1.00 | s1, s3 | the Writer failed \\| badly |",
      `| c | 0.00 | 0.00 0.00 | - | ${"e".repeat(119)}… |`,
    ]);
  });

  it("gives dashes for a report that has no trials", () => {
    const ev = evalOf("j", { a: [1] }, 1);

    expect(resultsTable(undefined, ev).split("\n")[2]).toBe("| a | 1.00 | 1.00 | - | - |");
    expect(resultsTable({ per_task: { a: {} } }, ev).split("\n")[2]).toBe("| a | 1.00 | 1.00 | - | - |");
  });
});

const FLOW = `agents:
  - { name: A, role: worker, tools: [read_file, grep], memoryRead: [k], memoryWrite: [], maxTokens: 10, maxSteps: 2, timeoutSeconds: 30, promptSource: { type: inline, content: x } }
  - { name: B, role: critic, tools: [], memoryRead: [], memoryWrite: [k2], maxTokens: 20, maxSteps: 3, timeoutSeconds: 40, promptSource: { type: file, path: p.md } }
  - { name: C, role: aggregator, tools: [], memoryRead: [], memoryWrite: [], maxTokens: 30, maxSteps: 4, timeoutSeconds: 50, promptSource: { type: inline, content: y } }
connections:
  - { id: e1, sourceAgentId: agent-0, targetAgentId: agent-1, edgeKind: dataflow }
  - { id: e2, sourceAgentId: agent-1, targetAgentId: agent-2 }
  - { id: e3, sourceAgentId: agent-2, targetAgentId: agent-0, edgeKind: feedback }
`;

describe("agentsTable", () => {
  it("lists each agent's role, tools, memory keys, limits and neighbours, and marks a prompt that is a file", () => {
    expect(agentsTable(FLOW).split("\n")).toEqual([
      "| agent | role | tools | memory read | memory write | maxTokens | maxSteps | timeoutSeconds | prompt | gets input from | sends output to |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| A | worker | read_file, grep | k | - | 10 | 2 | 30 | inline | C (feedback) | B |",
      "| B | critic | - | - | k2 | 20 | 3 | 40 | prompt file: cannot be edited | A | C |",
      "| C | aggregator | - | - | - | 30 | 4 | 50 | inline | B | A (feedback) |",
    ]);
  });

  it("says when the workflow cannot be read", () => {
    expect(agentsTable("agents: [")).toBe("(the workflow could not be read)");
  });
});

// ── OPERATIONS_HELP ───────────────────────────────────────────────────────────

/** Every operation of the schema with the keys it takes: the schema is a union, some of whose members are unions. */
function schemaOps(schema: unknown): Array<{ op: string; keys: string[] }> {
  const s = schema as { options?: unknown[]; shape?: Record<string, { value: string }> };
  if (s.options !== undefined) return s.options.flatMap(schemaOps);
  const shape = s.shape as Record<string, { value: string }>;
  return [{ op: shape.op.value, keys: Object.keys(shape).filter((key) => key !== "op") }];
}

describe("OPERATIONS_HELP", () => {
  const rows = new Map(OPERATIONS_HELP.split("\n").filter((l) => l.startsWith("| `")).map((l) => [l.split("`")[1], l] as const));

  it("lists every operation of the proposal schema, with every field it takes", () => {
    const ops = schemaOps(editOpSchema);

    expect(new Set(ops.map((o) => o.op)).size).toBe(14);
    for (const { op, keys } of ops) {
      const row = rows.get(op);
      expect(row, `a row for ${op}`).toBeDefined();
      for (const key of keys) expect(row, `${op} names its field ${key}`).toContain(`\`${key}\``);
    }
    expect([...rows.keys()].sort()).toEqual([...new Set(ops.map((o) => o.op))].sort());
  });

  it("lists the four fields of `set`, the tools that can be added and the roles that can be set", () => {
    for (const field of ["maxTokens", "maxSteps", "timeoutSeconds", "thinkDepth"]) expect(rows.get("set")).toContain(field);
    for (const tool of ADDABLE_TOOLS) expect(rows.get("add_tool")).toContain(tool);
    expect(rows.get("add_tool")).toContain("`bash` cannot be added");
    for (const role of Object.values(AgentRole).filter((r) => r !== AgentRole.Hook)) expect(rows.get("set_role")).toContain(role);
    expect(rows.get("set_role")).toContain("orchestrator, gateway, worker, critic, memory, aggregator, tool_caller, never `hook`");
  });

  it("says what cannot be edited", () => {
    expect(OPERATIONS_HELP).toContain("An operation that changes nothing is an error");
    expect(OPERATIONS_HELP).toContain("Cannot be edited, whatever you write: `model`");
    expect(OPERATIONS_HELP).toContain("an agent whose prompt is a file");
  });
});

// ── proposerBrief ─────────────────────────────────────────────────────────────

const traces: TraceFile[] = [
  { file: "evidence/traces/task-b-t1.md", task: "task-b", trial: 1, reward: 0, kind: "fail" },
  { file: "evidence/traces/task-c-t0.md", task: "task-c", trial: 0, reward: 1, kind: "success" },
];
const history: RenderedRecord[] = [
  { t: 0, variant: "-", hypothesis: "H_0 baseline", accepted: true, outcome: "BASELINE", bundle: 0 },
  { t: 0, variant: "A", edit_id: "C1", component: "prompt", hypothesis: "a distinctive hypothesis", delta_S: 0.25, delta_C: 0, accepted: true, outcome: "ACCEPTED", bundle: 1 },
];
const row = (n: number): AttributionRow => ({
  t: n, variant: "A", edit_id: `E${n}`, component: "prompt", hypothesis: null, n_predicted: 0, predicted_hit: [], hit_rate: null, unpredicted_regressions: [],
});

function input(over: Partial<ProposerBriefInput> = {}): ProposerBriefInput {
  return {
    t: 2, variant: "B", m: 3, workflowText: WORKFLOW, S: 0.5, C: 4200, k: 2, results: "| task | mean |\n| --- | --- |\n| task-b | 0.00 |", traces, history,
    scoreboard: [], exploration: exploration(2, 0, new Set(["prompt"]), 1), reserved: false, prune: [], budget: 3, ...over,
  };
}

describe("proposerBrief", () => {
  it("has the sections of the plan, each with a title", () => {
    const text = proposerBrief(input());

    expect(text.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## This variant", "## The workflow", "## The results", "## The edit history", "## The attribution scoreboard", "## Exploration",
      "## The components to prune", "## The edit budget", "## How to answer", "## The task",
    ]);
    expect(text.startsWith("# Round 2, variant B\n")).toBe(true);
  });

  it("tells the variant how the round works", () => {
    expect(proposerBrief(input())).toContain(
      "You are variant B of round 2. 3 variants are drafted independently from the same workflow this round; each is measured on the whole evolve split; the best admissible one becomes the new workflow.",
    );
  });

  it("gives the workflow whole in a yaml fence, with a table of its agents", () => {
    const text = proposerBrief(input());

    expect(text).toContain(`\`\`\`yaml\n${WORKFLOW.replace(/\n$/, "")}\n\`\`\``);
    expect(text).toContain("| Writer | worker | read_file | - | - | 1000 | 3 | 100 | inline | - | Checker |");
    expect(text).toContain("| Checker | critic | - | - | - | 1500 | 2 | 150 | inline | Writer | - |");
  });

  it("uses a longer fence when the workflow has a fence in it", () => {
    const text = proposerBrief(input({ workflowText: "agents: []\n# ```\n" }));

    expect(text).toContain("````yaml\nagents: []\n# ```\n````");
  });

  it("marks the agents whose prompt is a file", () => {
    const text = proposerBrief(input({ workflowText: FLOW }));

    expect(text).toContain("| B | critic | - | - | k2 | 20 | 3 | 40 | prompt file: cannot be edited | A | C |");
    expect(text.match(/prompt file: cannot be edited/g)).toHaveLength(1);
  });

  it("gives the score, the results table and the trace files with their task, reward and kind", () => {
    const text = proposerBrief(input());

    expect(text).toContain("scored S 0.500, C 4200 tokens per trial, over k = 2 trials per task");
    expect(text).toContain("| task-b | 0.00 |");
    expect(text).toContain("- `evidence/traces/task-b-t1.md`: task task-b, trial 1, reward 0.00 (the worst trial of one of the lowest-scoring tasks)");
    expect(text).toContain("- `evidence/traces/task-c-t0.md`: task task-c, trial 0, reward 1.00 (the best trial of one of the highest-scoring tasks)");
    expect(proposerBrief(input({ C: null, traces: [] }))).toContain("scored S 0.500, C n/a, over k = 2");
    expect(proposerBrief(input({ traces: [] }))).toContain("No trace files were written.");
  });

  it("gives the edit history as JSON under rrsi's heading, and the last 20 rows of the scoreboard", () => {
    const text = proposerBrief(input({ scoreboard: Array.from({ length: 25 }, (_, i) => row(i)) }));

    expect(text).toContain("A rejected mechanism is negative evidence; do not redraw it unchanged.");
    expect(text).toContain('"hypothesis": "a distinctive hypothesis"');
    expect(text).toContain("`evidence/history.json` has all of them");
    expect(text).toContain("`unpredicted_regressions` are tasks an edit likely broke");
    expect(text).toContain('"edit_id": "E24"');
    expect(text).toContain('"edit_id": "E5"');
    expect(text).not.toContain('"edit_id": "E4"');
    expect(text).toContain("`evidence/scoreboard.json` has all of them");
  });

  it("states the exploration directive, and the reserved-slot paragraph only for a variant that holds the slot", () => {
    const stalled = exploration(2, 1, new Set(["prompt"]), 1);
    const holder = proposerBrief(input({ exploration: stalled, reserved: true }));
    const other = proposerBrief(input({ exploration: stalled, reserved: false }));
    const nothing = proposerBrief(input({ exploration: exploration(2, 1, new Set(K), 1), reserved: true }));

    expect(holder).toContain(stalled.text);
    expect(holder).toContain('RESERVED EXPLORATION SLOT: this variant holds one. At least one of your edits MUST be on a never-exercised component from: ["config","control_flow","context_mgmt","memory","client_tool","subagent"].');
    expect(other).toContain(stalled.text);
    expect(other).not.toContain("this variant holds one");
    expect(nothing).not.toContain("this variant holds one"); // no component is untried: there is nothing to reserve
    expect(nothing).toContain("Every component in K has been exercised at least once.");
  });

  it("lists the components to prune, or says there are none", () => {
    const prune = [{ component: "memory" as const, recent_best_gain: -0.1, accepted_edits_in_incumbent: [{ t: 1, edit_id: "C2", hypothesis: "a memory key", delta_S: 0.1 }] }];

    expect(proposerBrief(input({ prune }))).toContain('"accepted_edits_in_incumbent": [');
    expect(proposerBrief(input({ prune }))).toContain('"hypothesis": "a memory key"');
    expect(proposerBrief(input()).split("## The components to prune")[1].split("## The edit budget")[0]).toContain("(none)");
  });

  it("states the edit budget", () => {
    expect(proposerBrief(input({ budget: 3 }))).toContain("You may ship at most b_t = 3 independent edits in this candidate");
    expect(proposerBrief(input({ budget: 1 }))).toContain("You may ship at most b_t = 1 independent edit in this candidate");
    expect(proposerBrief(input())).toContain("Ship fewer if the evidence supports fewer.");
  });

  it("says how to answer: the operations, the components, the contract with an example, and the rules", () => {
    const text = proposerBrief(input());

    expect(text).toContain(OPERATIONS_HELP);
    for (const c of K) expect(text).toContain(`- \`${c}\`${K_STR.includes(c) ? " (structural)" : ""}: `);
    expect(text).toContain("`subagent` > `memory` > `client_tool` > `control_flow` > `context_mgmt` > `config` > `prompt`");
    expect(text).toContain("A key that is not in this contract is an error, so a misspelled key is not ignored.");
    expect(text).toContain("There is no way to decline: send a proposal.");
    expect(text).toContain("No task-specific names, values or answers");
  });

  it("gives an example that the loop's own parser reads as a proposal", () => {
    const fenceStart = proposerBrief(input()).split("```json\n")[3]; // the history, the scoreboard, then the example
    const example = fenceStart.slice(0, fenceStart.indexOf("\n```"));

    expect(example).toBe(exampleProposal("Writer"));
    const parsed = parseProposal(example);
    expect(parsed).toHaveProperty("proposal");
    expect(exampleProposal("Anyone")).toContain('"agent": "Anyone"');
  });

  it("asks for the highest-impact failures on a first attempt, and has no repair section", () => {
    const text = proposerBrief(input());

    expect(text).toContain("Address the highest-impact failures within your edit budget.");
    expect(text).not.toContain("REPAIR ROUND");
  });

  it("is a repair round from the second attempt: the previous proposal as JSON, and the objections", () => {
    const text = proposerBrief(input({
      repair: { proposal: { summary: "s", edits: [{ id: "C9" }] }, objections: ["3 edits exceed the budget b_t = 2", "risk: may hurt the Checker"] },
    }));

    expect(text).toContain("REPAIR ROUND: your previous proposal is below; the objections follow. Send the whole corrected proposal; it is applied to the current workflow from scratch.");
    expect(text).toContain('### Your previous proposal\n\n```json\n{\n  "summary": "s",');
    expect(text).toContain("### Objections\n\n- 3 edits exceed the budget b_t = 2\n- risk: may hurt the Checker");
    expect(text).not.toContain("Address the highest-impact failures");
  });

  it("shows the first 2000 characters of an output that was not a proposal, and says so", () => {
    const raw = proposerBrief(input({ repair: { rawOutput: `${"a".repeat(2000)}ZZTAILZZ`, objections: ["no JSON"] } }));
    const none = proposerBrief(input({ repair: { rawOutput: "  \n", objections: [] } }));

    expect(raw).toContain("### Your previous output (it could not be read as a proposal; the first 2000 characters)");
    expect(raw).toContain(`\`\`\`\n${"a".repeat(2000)}\n\`\`\``);
    expect(raw).not.toContain("ZZTAILZZ");
    expect(none).toContain("(no output)");
    expect(none).toContain("- (none were given)");
  });
});

// ── criticReview ──────────────────────────────────────────────────────────────

describe("criticReview", () => {
  const review = criticReview({
    taskSetName: "loop-demo", summary: "make the writer\nmore careful", targets: "missing sources",
    edits: [{ id: "C1", component: "prompt", hypothesis: "h", declared: "prompt", retagged: false }],
    change: "C1 [prompt] — h\n  Writer · prompt: replace\n    - old\n    + new", workflowText: FLOW,
  });

  it("has the task set, the candidate, the declared edits, the change, the agents and the answer", () => {
    expect(review.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "# Review of a candidate change", "## The task set", "## The candidate", "## The declared edits", "## The change", "## The workflow's agents", "## How to answer",
    ]);
    expect(review).toContain('the task set "loop-demo"');
    expect(review).toContain("Summary: make the writer more careful");
    expect(review).toContain("Targets: missing sources");
    expect(review).toContain('"id": "C1"');
    expect(review).toContain("```text\nC1 [prompt] — h\n  Writer · prompt: replace\n    - old\n    + new\n```");
    expect(review).toContain("| A | worker | read_file, grep | k | - | 10 | 2 | 30 | inline | C (feedback) | B |");
    expect(review).toContain('{"verdict": "accept" | "reject", "reasons": ["..."], "risk_notes": ["..."]}');
  });

  it("says when there is no summary or no target", () => {
    const bare = criticReview({ taskSetName: "s", summary: "", targets: "", edits: [], change: "", workflowText: FLOW });

    expect(bare).toContain("Summary: (none given)");
    expect(bare).toContain("Targets: (none given)");
  });
});
