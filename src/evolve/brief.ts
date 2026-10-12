// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * What the proposer and the critic read (spec §4.2, §5, §8). The loop writes the evidence to files and the rest into a brief; the
 * shipped proposer and critic workflows only carry the role's general rules, so everything that must match the code lives here: the
 * operation table, the output contract, the budget, the reserved slot, the components. Pure text, apart from `renderTrace`, which
 * reads one trial's files from an evaluation's folder.
 *
 * The wording of the sections is RRSI's (rrsi/propose.py, rrsi/critic.py, adapted to workflows); the choice of the traces is
 * `build_traces` of rrsi/loop.py.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TaskDef } from "@/cli/taskSet";
import type { AttributionRow } from "@/evolve/attribution";
import { K, K_STR, PRECEDENCE, type Component } from "@/evolve/components";
import { ADDABLE_TOOLS, type EditOp } from "@/evolve/edits";
import type { Exploration, PruneEntry, RenderedRecord } from "@/evolve/history";
import { fixed, taskMean, type EvalResult } from "@/evolve/measure";
import { AgentRole } from "@/types/agent";

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// ── Markdown pieces ───────────────────────────────────────────────────────────

/** A fenced block that its text cannot close: the fence is longer than any run of backticks inside. */
function fence(text: string, lang = ""): string {
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

const section = (title: string, ...body: string[]): string => `## ${title}\n\n${body.join("\n\n")}`;

/** A table cell: `|` and line breaks would break the row. */
const cell = (value: unknown): string => String(value).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function table(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const line = (cells: readonly unknown[]): string => `| ${cells.map(cell).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The first `n` characters of `text`, without half of a surrogate pair at the cut. */
function head(text: string, n: number): string {
  const cut = text.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The last `n` characters of `text`, without half of a surrogate pair at the cut. */
function tail(text: string, n: number): string {
  if (n <= 0) return "";
  const cut = text.slice(Math.max(0, text.length - n));
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

// ── A trial's trace ───────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The largest n in [0, max] for which `fits(n)` holds, when `fits` only gets harder as n grows; undefined when not even 0 fits. */
function largestFitting(max: number, fits: (n: number) => boolean): number | undefined {
  if (!fits(0)) return undefined;
  let low = 0;
  let high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** How much of a scorer's command output a trace shows, per stream. */
const SCORER_OUTPUT_CHARS = 1500;

/**
 * One trial as Markdown, for the proposer: the task and the trial, its reward and run status, the task's text, the scorers (name,
 * kind, whether it passed, the exit code, and the end of the output of a failed command), the final outputs and the run log. It reads
 * `outcome.json`, `scorers.json` and `run.log` from `trialDir` (an evaluation's `trials/<task>/t<i>/`); a file that is missing is
 * said so. Over `cap` characters it cuts the run log first, keeping its end, and then each final output, keeping its start; the
 * text is never longer than `cap`.
 */
export function renderTrace(task: Pick<TaskDef, "id" | "task">, trialDir: string, cap = 12000): string {
  const outcomeRaw = readJson(join(trialDir, "outcome.json"));
  const outcome = isRecord(outcomeRaw) ? outcomeRaw : undefined;
  const scorersRaw = readJson(join(trialDir, "scorers.json"));
  const scorers = (Array.isArray(scorersRaw) ? scorersRaw : []).filter(isRecord);
  const log = readText(join(trialDir, "run.log"));
  const fromDir = /^t(\d+)$/.exec(basename(trialDir))?.[1];
  const trial = typeof outcome?.trial === "number" ? outcome.trial : (fromDir ?? "?");

  const summary = [`# Trace: task ${task.id}, trial ${trial}`, ""];
  if (outcome === undefined) {
    summary.push("- outcome.json is missing or unreadable: the trial left no record of its result");
  } else {
    summary.push(`- reward: ${typeof outcome.reward === "number" ? fixed(outcome.reward, 2) : "unknown"}`, `- run status: ${String(outcome.runStatus ?? "unknown")}`);
    if (outcome.missing === true) summary.push("- missing: yes (the trial counts as a reward of 0)");
    if (typeof outcome.error === "string" && outcome.error !== "") summary.push(`- error: ${oneLine(outcome.error)}`);
  }

  const taskText = section("The task", task.task === "" ? "(no task text)" : fence(task.task));

  const scorerLines = scorers.map((s) => {
    const passed = s.passed === true;
    const exit = typeof s.exitCode === "number" ? `, exit code ${s.exitCode}` : "";
    const timedOut = s.timedOut === true ? ", timed out" : "";
    const lines = [`- **${String(s.name)}** (${String(s.kind)}): ${passed ? "passed" : "FAILED"}${exit}${timedOut}`];
    if (typeof s.detail === "string" && s.detail !== "") lines.push(`  - detail: ${oneLine(s.detail)}`);
    if (!passed) {
      for (const stream of ["stdout", "stderr"] as const) {
        const out = s[stream];
        if (typeof out === "string" && out.trim() !== "") lines.push(`  - ${stream}, the end:`, ...fence(tail(out.trimEnd(), SCORER_OUTPUT_CHARS), "text").split("\n").map((l) => `    ${l}`));
      }
    }
    return lines.join("\n");
  });
  const scorerText = section("Scorers", scorerLines.length > 0 ? scorerLines.join("\n") : "(no scorer record)");

  const outputs = isRecord(outcome?.outputs) ? Object.entries(outcome.outputs).map(([id, text]): [string, string] => [id, String(text)]) : [];
  const agents = isRecord(outcome?.agents) ? outcome.agents : {};
  const named = (id: string): string => {
    const agent = agents[id];
    return isRecord(agent) && typeof agent.agent === "string" ? `${agent.agent} (${id})` : id;
  };

  const logText = log ?? "";
  const build = (logKeep: number, outputKeep: number): string => {
    const outputBlocks = outputs.map(([id, text]) => {
      const shown = text.length > outputKeep ? `${head(text, outputKeep)}\n[... ${text.length - head(text, outputKeep).length} more characters cut]` : text;
      return `### ${named(id)}\n\n${fence(shown)}`;
    });
    const outputText = section("Final outputs", outputBlocks.length > 0 ? outputBlocks.join("\n\n") : "(the run produced no final output)");
    let logBody: string;
    if (log === undefined) logBody = "(run.log is missing)";
    else if (logText === "") logBody = "(empty)";
    else if (logKeep >= logText.length) logBody = fence(logText);
    else if (logKeep <= 0) logBody = `(the run log, ${logText.length} characters, is left out to fit in ${cap} characters)`;
    else logBody = fence(`[... ${logText.length - tail(logText, logKeep).length} characters cut from the start of the log]\n${tail(logText, logKeep)}`);
    return [summary.join("\n"), taskText, scorerText, outputText, section("Run log", logBody)].join("\n\n") + "\n";
  };

  let text = build(Infinity, Infinity);
  if (text.length > cap) {
    const logKeep = largestFitting(logText.length, (n) => build(n, Infinity).length <= cap);
    if (logKeep !== undefined) {
      text = build(logKeep, Infinity);
    } else {
      const longest = outputs.reduce((most, [, out]) => Math.max(most, out.length), 0);
      text = build(0, largestFitting(longest, (n) => build(0, n).length <= cap) ?? 0);
    }
  }
  if (text.length <= cap) return text;
  const note = "\n[... the trace is cut to fit]\n"; // the task and the scorers alone are over the cap
  return cap > note.length * 2 ? head(text, cap - note.length) + note : head(text, cap);
}

// ── Which traces ──────────────────────────────────────────────────────────────

export interface TracePick {
  task: string;
  /** The trial's number, from 0. */
  trial: number;
  kind: "fail" | "success";
}

/**
 * RRSI's `build_traces` choice: the tasks ranked by their mean reward, lowest first; the `n_fail` lowest are the failures and the
 * `n_success` highest, leaving out the failures, the successes. Of a failure the first worst trial is shown, of a success the first
 * best one. Failures come first. (RRSI's `ranked[-0:]` would list every task for `n_success = 0`; here that is none.)
 */
export function pickTraces(ev: EvalResult, n_fail: number, n_success: number): TracePick[] {
  const ranked = Object.entries(ev.per_task).sort(([, a], [, b]) => taskMean(a) - taskMean(b));
  const fails = ranked.slice(0, Math.max(0, n_fail)).map(([id]) => id);
  const wins = n_success > 0 ? ranked.slice(-n_success).map(([id]) => id).filter((id) => !fails.includes(id)) : [];
  const picks: TracePick[] = [];
  for (const [kind, ids] of [["fail", fails], ["success", wins]] as const) {
    for (const task of ids) {
      const { rewards } = ev.per_task[task];
      if (rewards.length === 0) continue;
      const wanted = kind === "fail" ? Math.min(...rewards) : Math.max(...rewards);
      picks.push({ task, trial: rewards.indexOf(wanted), kind });
    }
  }
  return picks;
}

// ── Tables ────────────────────────────────────────────────────────────────────

/**
 * The results of an evaluation as a Markdown table: per task its mean, its rewards, the names of the scorers that failed in any
 * trial, and the first error of a trial. `report` is the parsed report.json (its trials say which scorers failed and why); a report
 * without them gives dashes.
 */
export function resultsTable(report: unknown, ev: EvalResult): string {
  const perTask = isRecord(report) && isRecord(report.per_task) ? report.per_task : {};
  const rows = Object.entries(ev.per_task).map(([id, tr]) => {
    const entry = Object.hasOwn(perTask, id) ? perTask[id] : undefined;
    const trials = (isRecord(entry) && Array.isArray(entry.trials) ? entry.trials : []).filter(isRecord);
    const failed: string[] = [];
    for (const trial of trials) {
      for (const scorer of Array.isArray(trial.scorers) ? trial.scorers.filter(isRecord) : []) {
        if (scorer.passed === false && typeof scorer.name === "string" && !failed.includes(scorer.name)) failed.push(scorer.name);
      }
    }
    const error = trials.map((trial) => trial.error).find((e): e is string => typeof e === "string" && e !== "");
    const shown = error === undefined ? "-" : oneLine(error).length > 120 ? `${oneLine(error).slice(0, 119)}…` : oneLine(error);
    return [id, fixed(taskMean(tr), 2), tr.rewards.map((r) => fixed(r, 2)).join(" ") || "-", failed.join(", ") || "-", shown];
  });
  return table(["task", "mean", "rewards", "failed scorers", "first error"], rows);
}

/**
 * The agents of a workflow as a Markdown table, for the proposer and the critic: name, role, tools, memory keys read and written,
 * limits, whether the prompt is inline, and the agents it gets input from and sends output to (by name; an edge that is not a plain
 * dataflow edge says its kind). An agent whose prompt is a file is marked: only an inline prompt can be edited.
 */
export function agentsTable(workflowText: string): string {
  let def: unknown;
  try {
    def = parseYaml(workflowText);
  } catch {
    return "(the workflow could not be read)";
  }
  const agents = (isRecord(def) && Array.isArray(def.agents) ? def.agents : []).map((a): Record<string, unknown> => (isRecord(a) ? a : {}));
  const connections = (isRecord(def) && Array.isArray(def.connections) ? def.connections : []).filter(isRecord);
  const nameOf = (id: unknown): string => {
    const at = /^agent-(\d+)$/.exec(String(id));
    const agent = at === null ? undefined : agents[Number(at[1])];
    return agent === undefined ? String(id) : String(agent.name);
  };
  const edge = (other: unknown, c: Record<string, unknown>): string => {
    const kind = typeof c.edgeKind === "string" && c.edgeKind !== "dataflow" ? ` (${c.edgeKind})` : "";
    return `${nameOf(other)}${kind}`;
  };
  const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.join(", ") : "-");
  const rows = agents.map((agent, i) => {
    const id = `agent-${i}`;
    const source = isRecord(agent.promptSource) ? agent.promptSource : {};
    return [
      agent.name, agent.role, list(agent.tools), list(agent.memoryRead), list(agent.memoryWrite), agent.maxTokens, agent.maxSteps,
      agent.timeoutSeconds, source.type === "file" ? "prompt file: cannot be edited" : "inline",
      connections.filter((c) => c.targetAgentId === id).map((c) => edge(c.sourceAgentId, c)).join(", ") || "-",
      connections.filter((c) => c.sourceAgentId === id).map((c) => edge(c.targetAgentId, c)).join(", ") || "-",
    ];
  });
  return table(
    ["agent", "role", "tools", "memory read", "memory write", "maxTokens", "maxSteps", "timeoutSeconds", "prompt", "gets input from", "sends output to"], rows,
  );
}

// ── The operations, the components ────────────────────────────────────────────

const ROLES = Object.values(AgentRole).filter((role) => role !== AgentRole.Hook).join(", ");
const TOOLS = ADDABLE_TOOLS.join(", ");

/** Every operation of the proposal schema, its fields and its rule (spec §3.2). Typed by the schema's own names, so that an
 *  operation added to the schema cannot be left out here. */
const OPERATIONS: Record<EditOp["op"], { fields: string; rule: string }> = {
  replace_text: {
    fields: "`agent`, `field` (`prompt` or `description`), `old`, `new`",
    rule: "`old` occurs exactly once in that text (copy it exactly, spaces and line breaks included), and `new` differs from it",
  },
  set_text: {
    fields: "`agent`, `field` (`prompt` or `description`), `value`",
    rule: "replaces the whole text; `value` differs from the current text",
  },
  set: {
    fields: "`agent`, `field`, `value`",
    rule: "`field` is `maxTokens` (0 to 200000), `maxSteps` (1 to 1000), `timeoutSeconds` (1 to 86400) or `thinkDepth` (`none`, `low`, `medium`, `high`); `value` differs from the current one",
  },
  set_role: {
    fields: "`agent`, `value`",
    rule: `\`value\` is one of ${ROLES}, never \`hook\`; an agent that runs a hook script keeps its role`,
  },
  add_tool: {
    fields: "`agent`, `tool`",
    rule: `\`tool\` is one of ${TOOLS}, and the agent does not have it yet; \`bash\` cannot be added`,
  },
  remove_tool: { fields: "`agent`, `tool`", rule: "any tool the agent has" },
  add_memory_read: { fields: "`agent`, `key`", rule: "a memory key the agent does not read yet" },
  remove_memory_read: { fields: "`agent`, `key`", rule: "a memory key the agent reads" },
  add_memory_write: { fields: "`agent`, `key`", rule: "a memory key the agent does not write yet" },
  remove_memory_write: { fields: "`agent`, `key`", rule: "a memory key the agent writes" },
  add_agent: {
    fields: "`name`, `role`, `prompt`, and optionally `description`, `tools`, `memoryRead`, `memoryWrite`, `maxTokens`, `maxSteps`, `timeoutSeconds`, `thinkDepth`",
    rule: "`name` is new (1 to 64 characters) and `role` is as for `set_role`; the new agent has the model most agents have, `maxTokens` 2048, `maxSteps` 5, `timeoutSeconds` 300, and no tools and no memory keys unless you give them. " +
      "Connect it in the same edit, or the workflow is invalid (an agent with no edge)",
  },
  remove_agent: {
    fields: "`agent`",
    rule: "not the only agent, and not one that a scorer reads by name (the error says which); its edges go with it",
  },
  connect: {
    fields: "`from`, `to`, and optionally `kind` (`dataflow`, the default, `memory`, `feedback` or `control`) and `label`",
    rule: "no edge from an agent to itself and no edge that exists already; an edge that closes a loop must be a `feedback` edge",
  },
  disconnect: { fields: "`from`, `to`", rule: "removes every edge from → to; there must be one" },
};

/** The operation table and what cannot be edited, as the proposer reads it. */
export const OPERATIONS_HELP = [
  "Agents are named by their `name`, which is unique in the workflow. Operations apply in order, edit by edit, to the current workflow. " +
    "An operation that changes nothing is an error (a value it already has, a tool the agent has, `old` equal to `new`).",
  "",
  table(["Operation", "Fields", "Rule"], Object.entries(OPERATIONS).map(([op, { fields, rule }]) => [`\`${op}\``, fields, rule])),
  "",
  "Cannot be edited, whatever you write: `model`, `fallback`, `temperature`, `condition` and the execution settings; hook agents and " +
    "`preHook`/`postHook` scripts; tools that need approval (`bash`) or never run (`web_search`, `web_fetch`, `git`, `test`, and the like); " +
    "an agent whose prompt is a file (only an inline prompt can be edited); and the workflow's name, positions and statuses.",
].join("\n");

/** What each component covers, for the brief. Typed by K, so that a component added to K cannot be left out here. */
const COMPONENT_COVERS: Record<Component, string> = {
  prompt: "the text of an agent's prompt or description (`replace_text`, `set_text`)",
  config: "an agent's `maxTokens`, `maxSteps`, `timeoutSeconds` or `thinkDepth` (`set`)",
  control_flow: "who talks to whom, and what an agent is (`connect`, `disconnect`, `set_role`)",
  context_mgmt: "which memory keys an agent reads (`add_memory_read`, `remove_memory_read`)",
  memory: "which memory keys an agent writes (`add_memory_write`, `remove_memory_write`)",
  client_tool: "which tools an agent has (`add_tool`, `remove_tool`)",
  subagent: "which agents the workflow has (`add_agent`, `remove_agent`)",
};

const componentsHelp = (): string => [
  "Every edit has a `component`, one of these (the structural ones add machinery instead of changing text or a number):",
  "",
  ...K.map((c) => `- \`${c}\`${K_STR.includes(c) ? " (structural)" : ""}: ${COMPONENT_COVERS[c]}`),
  "",
  `The loop re-tags an edit from its operations, so declare the one that fits: an edit's component is the most structural one among ` +
    `its operations, in this order: ${PRECEDENCE.map((c) => `\`${c}\``).join(" > ")}.`,
].join("\n");

// ── The proposer's brief ──────────────────────────────────────────────────────

const TRACE_KINDS: Record<TracePick["kind"], string> = {
  fail: "the worst trial of one of the lowest-scoring tasks",
  success: "the best trial of one of the highest-scoring tasks",
};

/** A trace file the loop wrote for the proposer. */
export interface TraceFile {
  /** Relative to the proposer's workspace: `evidence/traces/<task>-t<i>.md`. */
  file: string;
  task: string;
  trial: number;
  reward: number;
  kind: TracePick["kind"];
}

/** What the proposer is told when a proposal was refused. */
export interface Repair {
  /** The previous proposal, when it could be read as one. */
  proposal?: unknown;
  /** The previous output, shown when there is no proposal: the first 2000 characters. */
  rawOutput?: string;
  objections: readonly string[];
}

export interface ProposerBriefInput {
  /** The round and this variant's label; `m` variants are drafted. */
  t: number;
  variant: string;
  m: number;
  /** The incumbent workflow, whole. */
  workflowText: string;
  /** The incumbent's score and cost, and the trials per task. */
  S: number;
  C: number | null;
  k: number;
  /** `resultsTable` of the incumbent's evaluation. */
  results: string;
  traces: readonly TraceFile[];
  /** The last records of the history (`history.render()`); the files in `evidence/` hold all of them. */
  history: readonly RenderedRecord[];
  /** The last rows of the scoreboard. */
  scoreboard: readonly AttributionRow[];
  exploration: Exploration;
  /** Whether this variant holds a reserved exploration slot. */
  reserved: boolean;
  prune: readonly PruneEntry[];
  /** b_t: the most edits this proposal may have. */
  budget: number;
  /** Set from the second attempt on. */
  repair?: Repair;
}

const RAW_OUTPUT_CHARS = 2000;

/** The first agent's name, for the example; any agent will do. */
function firstAgentName(workflowText: string): string {
  try {
    const def: unknown = parseYaml(workflowText);
    const first = isRecord(def) && Array.isArray(def.agents) ? def.agents[0] : undefined;
    return isRecord(first) && typeof first.name === "string" ? first.name : "AgentName";
  } catch {
    return "AgentName";
  }
}

/** The answer's shape, as a full example. A test parses it with the loop's own `parseProposal`. */
export function exampleProposal(agent: string): string {
  return JSON.stringify({
    summary: "one line: what this candidate changes, and why",
    edits: [{
      id: "C1",
      component: "prompt",
      hypothesis: "the mechanism, and why it should move the score",
      targets_mode: "the failure it targets",
      predicted_affected: ["<a task id from the traces>"],
      retroactive_check: "which failing tasks would have moved, which passing ones it could break, and why it transfers to other tasks",
      ops: [{ op: "replace_text", agent, field: "prompt", old: "<text copied exactly from the agent's current prompt>", new: "<the replacement>" }],
    }],
  }, null, 2);
}

function repairText(repair: Repair): string {
  const previous = repair.proposal !== undefined
    ? ["### Your previous proposal", fence(JSON.stringify(repair.proposal, null, 2), "json")]
    : [
      `### Your previous output (it could not be read as a proposal; the first ${RAW_OUTPUT_CHARS} characters)`,
      (repair.rawOutput ?? "").trim() === "" ? "(no output)" : fence(head(repair.rawOutput ?? "", RAW_OUTPUT_CHARS)),
    ];
  return [
    "REPAIR ROUND: your previous proposal is below; the objections follow. Send the whole corrected proposal; it is applied to the " +
      "current workflow from scratch.",
    ...previous,
    "### Objections",
    repair.objections.length > 0 ? repair.objections.map((o) => `- ${o}`).join("\n") : "- (none were given)",
  ].join("\n\n");
}

const scoreText = (S: number, C: number | null): string => `S ${fixed(S, 3)}, C ${C === null ? "n/a" : `${Math.round(C)} tokens per trial`}`;

/**
 * The proposer's task text (brief.md), in sections: the variant, the workflow, the results, the edit history, the attribution
 * scoreboard, the exploration directive (with the reserved-slot paragraph for a variant that holds the slot), the components to
 * prune, the edit budget, how to answer, and the task. From the second attempt on, the task is a repair round.
 */
export function proposerBrief(input: ProposerBriefInput): string {
  const { t, variant, m, exploration, budget } = input;
  const reserved = input.reserved && exploration.untried.length > 0
    ? `RESERVED EXPLORATION SLOT: this variant holds one. At least one of your edits MUST be on a never-exercised component from: ${JSON.stringify(exploration.untried)}.`
    : undefined;
  const sections = [
    section(
      "This variant",
      `You are variant ${variant} of round ${t}. ${m === 1 ? "1 variant is" : `${m} variants are`} drafted independently from the same workflow this round; each is measured on the whole ` +
        "evolve split; the best admissible one becomes the new workflow.",
      `Your workspace holds this brief (\`brief.md\`), the workflow (\`workflow.harness.yaml\`) and the evidence (\`evidence/\`). You can read them; you cannot change the workflow ` +
        "yourself: you send a proposal, and the loop applies it.",
    ),
    section("The workflow", fence(input.workflowText, "yaml"), "Its agents:", agentsTable(input.workflowText)),
    section(
      "The results",
      `The workflow above scored ${scoreText(input.S, input.C)}, over k = ${input.k} trials per task. S is the pooled score in [0, 1]; C is the mean of the tokens the ` +
        "workflow's model used in a trial.",
      input.results,
      input.traces.length > 0
        ? ["Traces, one per file (read them with `read_file`); the results table is also in `evidence/results.md`:",
          ...input.traces.map((f) => `- \`${f.file}\`: task ${f.task}, trial ${f.trial}, reward ${fixed(f.reward, 2)} (${TRACE_KINDS[f.kind]})`)].join("\n")
        : "No trace files were written.",
    ),
    section(
      "The edit history",
      "Every measured edit: component, hypothesis, ΔS, ΔC, accepted. A rejected mechanism is negative evidence; do not redraw it unchanged. An accepted one carries the " +
        "gain it produced; refine what has known credit, not what merely preceded a rise. The most recent records are shown; `evidence/history.json` has all of them.",
      fence(JSON.stringify(input.history, null, 2), "json"),
    ),
    section(
      "The attribution scoreboard",
      "How past edits' predictions fared; `unpredicted_regressions` are tasks an edit likely broke. The last 20 rows are shown; `evidence/scoreboard.json` has all of them.",
      fence(JSON.stringify(input.scoreboard.slice(-20), null, 2), "json"),
    ),
    section("Exploration", ...(reserved === undefined ? [exploration.text] : [exploration.text, reserved])),
    section(
      "The components to prune",
      "Components that were exercised but had no strictly improving edit in the recent window. Remove the accepted machinery listed: it has stopped earning its place.",
      input.prune.length > 0 ? fence(JSON.stringify(input.prune, null, 2), "json") : "(none)",
    ),
    section(
      "The edit budget",
      `You may ship at most b_t = ${budget} independent edit${budget === 1 ? "" : "s"} in this candidate (the budget anneals over the run: early rounds explore, ` +
        "late rounds make single attributable changes). Ship fewer if the evidence supports fewer.",
    ),
    section(
      "How to answer",
      "### The operations",
      OPERATIONS_HELP,
      "### The components",
      componentsHelp(),
      "### The answer",
      "Reply with ONE JSON object, in a fenced block, as the last thing you write. The last JSON object with an `edits` array is your proposal. Each edit needs " +
        "`id`, `component`, `hypothesis` and `ops` (at least one); `targets_mode`, `predicted_affected`, `retroactive_check`, `why_not_lower_lever`, `trigger_condition` " +
        "and `regression_risk` are optional but make the edit easier to judge. A key that is not in this contract is an error, so a misspelled key is not ignored.",
      fence(exampleProposal(firstAgentName(input.workflowText)), "json"),
      "### The rules",
      [
        "An edit is ONE independent, attributable change (it works on its own and can answer \"which tasks will it move\" by itself). Dependent parts are ONE edit. Send at most the budget, never more.",
        "Every edit names its `component`. The loop checks the tag against the operations and re-tags a mislabelled edit.",
        "If a RESERVED EXPLORATION SLOT applies to you, at least one edit must be on one of the never-exercised components listed under Exploration.",
        "If COMPONENTS TO PRUNE lists accepted machinery, an edit that removes it is a legitimate edit (component = the pruned component, hypothesis = \"prune: ...\"). Prefer it when the evidence says the machinery stopped earning its place.",
        "`predicted_affected` lists CONCRETE task ids from the traces. Predictions are checked against the evaluation, and your hit and miss record (the scoreboard) is shown back to you; over-claiming counts against you.",
        "There is no way to decline: send a proposal. A round that sends nothing tests nothing. If your best idea breaks a rule, build a different one, preferably on a component the history shows was never exercised.",
        "No task-specific names, values or answers anywhere in a prompt, a memory key or an agent. Every edit targets a failure, a gap or a habit seen in the traces, and must still make sense on an unfamiliar task of the same kind. A proposal that does not is rejected before it is measured.",
        "The model that runs this workflow is frozen and is a different model from you: improve the workflow from ITS side, using the traces as evidence of how it behaves.",
        "The workflow runs unattended on every task: an edit that makes it fail or loop with no way out sinks the whole candidate.",
      ].map((rule) => `- ${rule}`).join("\n"),
    ),
    section(
      "The task",
      input.repair === undefined
        ? "Address the highest-impact failures within your edit budget. Read the traces you need, then answer with the JSON object described under \"How to answer\"."
        : repairText(input.repair),
    ),
  ];
  return `# Round ${t}, variant ${variant}\n\n${sections.join("\n\n")}\n`;
}

// ── The critic's review ───────────────────────────────────────────────────────

export interface CriticReviewInput {
  taskSetName: string;
  /** The proposal's summary, and the failures its edits target. */
  summary: string;
  targets: string;
  /** The declared edits: what the proposer said of each, without its operations (the change shows those). */
  edits: readonly object[];
  /** `renderChange` of the edits. */
  change: string;
  /** The workflow the change applies to. */
  workflowText: string;
}

/**
 * The critic's task text (review.md): the task set's name, the candidate's summary and targets, the declared edits, the rendered
 * change, the workflow's agents, and the shape of the answer.
 */
export function criticReview(input: CriticReviewInput): string {
  return [
    "# Review of a candidate change",
    section(
      "The task set",
      `The workflow is being improved against the task set "${input.taskSetName}", and measured on the same tasks it is improved on, so the change must not encode them.`,
    ),
    section("The candidate", `Summary: ${input.summary === "" ? "(none given)" : oneLine(input.summary)}`, `Targets: ${input.targets === "" ? "(none given)" : oneLine(input.targets)}`),
    section("The declared edits", "The independent changes this candidate says it makes:", fence(JSON.stringify(input.edits, null, 2), "json")),
    section("The change", "What each edit does to the workflow, operation by operation:", fence(input.change, "text")),
    section("The workflow's agents", "Before the change.", agentsTable(input.workflowText)),
    section(
      "How to answer",
      "Reply with ONE JSON object, in a fenced block, as the last thing you write:",
      fence('{"verdict": "accept" | "reject", "reasons": ["..."], "risk_notes": ["..."]}'),
      "`reasons` says why, and for a reject what to change; `risk_notes` lists risks you accept the change with.",
    ),
  ].join("\n\n") + "\n";
}
