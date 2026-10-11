// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The proposer's changes as data (spec §3). A proposal is a list of edits, each a list of operations on the workflow file, by agent
 * name; the loop applies them itself. This file holds the proposal schema and how it is read from a model's output, the
 * classification of an edit by its operations, applying a proposal to the workflow's YAML (comments and layout kept), the checks the
 * loop runs on a proposal, and how a change is shown: per edit, and as a line diff. Pure functions: nothing here reads a file or
 * starts a process.
 *
 * Every message that ends up in an `error` or `errors` says what is wrong and how to fix it: the proposer reads them in its repair
 * round.
 */
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, Scalar, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { z } from "zod";
import { defToGraph } from "@/engine/workflowGraph";
import { mostStructural, type Component } from "@/evolve/components";
import { jsonObjectsIn } from "@/evolve/jsonText";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";
import { validateWorkflow } from "@/utils/validateWorkflow";

// ── The proposal schema ───────────────────────────────────────────────────────

/** The tools an operation can add: the ones the engine runs (it drops the others, so adding them would change nothing) that need no
 *  approval. `bash` is left out on purpose: an agent's commands run only under the user's --allow-command, and adding `bash` to
 *  another agent would widen that approval. */
export const ADDABLE_TOOLS = [
  ToolPermission.ReadFile, ToolPermission.FsRead, ToolPermission.ListFiles, ToolPermission.Grep,
  ToolPermission.WriteFile, ToolPermission.FsAppend, ToolPermission.SubagentDispatch,
] as const;

/** Every role but `hook`: a hook runs a script. */
const ROLES = [
  AgentRole.Orchestrator, AgentRole.Gateway, AgentRole.Worker, AgentRole.Critic, AgentRole.Memory, AgentRole.Aggregator, AgentRole.ToolCaller,
] as const;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// The bounds are those of the app's agent schema (src/schemas/agentSchema.ts).
const agentName = z.string().min(1);
const memoryKey = z.string().min(1);
const maxTokens = z.number().int().min(0).max(200000);
const maxSteps = z.number().int().min(1).max(1000);
const timeoutSeconds = z.number().int().min(1).max(86400);
const thinkDepth = z.enum(["none", "low", "medium", "high"]);
const textField = z.enum(["prompt", "description"]);

const replaceText = z.strictObject({ op: z.literal("replace_text"), agent: agentName, field: textField, old: z.string().min(1), new: z.string() });
const setText = z.strictObject({ op: z.literal("set_text"), agent: agentName, field: textField, value: z.string() });
const setMaxTokens = z.strictObject({ op: z.literal("set"), agent: agentName, field: z.literal("maxTokens"), value: maxTokens });
const setMaxSteps = z.strictObject({ op: z.literal("set"), agent: agentName, field: z.literal("maxSteps"), value: maxSteps });
const setTimeoutSeconds = z.strictObject({ op: z.literal("set"), agent: agentName, field: z.literal("timeoutSeconds"), value: timeoutSeconds });
const setThinkDepth = z.strictObject({ op: z.literal("set"), agent: agentName, field: z.literal("thinkDepth"), value: thinkDepth });
/** `set` is one schema per field, so that each field has its own bounds. */
const setField = z.discriminatedUnion("field", [setMaxTokens, setMaxSteps, setTimeoutSeconds, setThinkDepth], {
  error: () => "field must be one of maxTokens, maxSteps, timeoutSeconds, thinkDepth",
});
const setRole = z.strictObject({ op: z.literal("set_role"), agent: agentName, value: z.enum(ROLES) });
const addTool = z.strictObject({ op: z.literal("add_tool"), agent: agentName, tool: z.enum(ADDABLE_TOOLS) });
const removeTool = z.strictObject({ op: z.literal("remove_tool"), agent: agentName, tool: z.enum(ToolPermission) });
const addMemoryRead = z.strictObject({ op: z.literal("add_memory_read"), agent: agentName, key: memoryKey });
const removeMemoryRead = z.strictObject({ op: z.literal("remove_memory_read"), agent: agentName, key: memoryKey });
const addMemoryWrite = z.strictObject({ op: z.literal("add_memory_write"), agent: agentName, key: memoryKey });
const removeMemoryWrite = z.strictObject({ op: z.literal("remove_memory_write"), agent: agentName, key: memoryKey });
const addAgent = z.strictObject({
  op: z.literal("add_agent"), name: z.string().min(1).max(64), role: z.enum(ROLES), prompt: z.string(),
  description: z.string().optional(), tools: z.array(z.enum(ADDABLE_TOOLS)).optional(),
  memoryRead: z.array(memoryKey).optional(), memoryWrite: z.array(memoryKey).optional(),
  maxTokens: maxTokens.optional(), maxSteps: maxSteps.optional(), timeoutSeconds: timeoutSeconds.optional(), thinkDepth: thinkDepth.optional(),
});
const removeAgent = z.strictObject({ op: z.literal("remove_agent"), agent: agentName });
const connect = z.strictObject({
  op: z.literal("connect"), from: agentName, to: agentName, kind: z.enum(["dataflow", "memory", "feedback", "control"]).optional(),
  label: z.string().optional(),
});
const disconnect = z.strictObject({ op: z.literal("disconnect"), from: agentName, to: agentName });

/** The keys each operation takes, for the hint on an unknown key. (The four `set` schemas have the same keys.) */
const OP_KEYS = new Map(
  [
    replaceText, setText, setMaxTokens, setRole, addTool, removeTool, addMemoryRead, removeMemoryRead, addMemoryWrite, removeMemoryWrite,
    addAgent, removeAgent, connect, disconnect,
  ].map((schema) => [schema.shape.op.value as string, Object.keys(schema.shape)] as const),
);

export const editOpSchema = z.discriminatedUnion(
  "op",
  [
    replaceText, setText, setField, setRole, addTool, removeTool, addMemoryRead, removeMemoryRead, addMemoryWrite, removeMemoryWrite,
    addAgent, removeAgent, connect, disconnect,
  ],
  {
    error: (issue) => {
      if (issue.code !== "invalid_union") return undefined;
      const op = isRecord(issue.input) ? issue.input.op : undefined;
      return `${typeof op === "string" ? `unknown op "${op}"` : 'the "op" field is missing'}; the operations are: ${[...OP_KEYS.keys()].join(", ")}`;
    },
  },
);

const editSchema = z.strictObject({
  id: z.string().min(1),
  /** Any word: the loop re-tags the edit from its operations. */
  component: z.string().min(1),
  hypothesis: z.string(),
  ops: z.array(editOpSchema).min(1),
  targets_mode: z.string().optional(),
  retroactive_check: z.string().optional(),
  why_not_lower_lever: z.string().optional(),
  trigger_condition: z.string().optional(),
  regression_risk: z.string().optional(),
  predicted_affected: z.array(z.string()).optional(),
});

export const proposalSchema = z.strictObject({ summary: z.string().optional(), edits: z.array(editSchema).min(1) });

/** The optional fields a model may write as null: null reads as absent, so it costs no repair round. */
const NULLABLE_EDIT_KEYS = ["targets_mode", "retroactive_check", "why_not_lower_lever", "trigger_condition", "regression_risk", "predicted_affected"];

/** A copy of a proposal's object without the null values of its optional fields; the operations are left as they are. */
function withoutNulls(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...raw };
  if (copy.summary === null) delete copy.summary;
  if (Array.isArray(copy.edits)) {
    copy.edits = copy.edits.map((edit: unknown) => {
      if (!isRecord(edit)) return edit;
      const cleaned = { ...edit };
      for (const key of NULLABLE_EDIT_KEYS) if (cleaned[key] === null) delete cleaned[key];
      return cleaned;
    });
  }
  return copy;
}

export type EditOp = z.infer<typeof editOpSchema>;
export type ProposedEdit = z.infer<typeof editSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
type Op<K extends EditOp["op"]> = Extract<EditOp, { op: K }>;

// ── Reading a proposal ────────────────────────────────────────────────────────

const MAX_ERROR_LINES = 20;

/** The value at `path` of `root`; undefined when there is none. */
function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let node = root;
  for (const step of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[step];
  }
  return node;
}

/** zod's path as text: edits[0].ops[1].old */
function pathText(path: ReadonlyArray<PropertyKey>): string {
  const text = path.map((step, i) => (typeof step === "number" ? `[${step}]` : `${i === 0 ? "" : "."}${String(step)}`)).join("");
  return text || "(the proposal)";
}

/** The keys allowed in the object at `path` of a proposal, when that is an object of the schema. */
function allowedKeys(path: ReadonlyArray<PropertyKey>, raw: unknown): string[] | undefined {
  if (path.length === 0) return Object.keys(proposalSchema.shape);
  if (path.length === 2 && path[0] === "edits") return Object.keys(editSchema.shape);
  if (path.length === 4 && path[0] === "edits" && path[2] === "ops") {
    const op = valueAt(raw, path);
    return isRecord(op) && typeof op.op === "string" ? OP_KEYS.get(op.op) : undefined;
  }
  return undefined;
}

function issueText(issue: z.core.$ZodIssue, raw: unknown): string {
  if (issue.code !== "unrecognized_keys") return issue.message;
  const allowed = allowedKeys(issue.path, raw);
  return `unknown key ${issue.keys.map((key) => `"${key}"`).join(", ")}${allowed ? ` (the keys here are: ${allowed.join(", ")})` : ""}`;
}

/** At most MAX_ERROR_LINES lines, the last one saying how many more there were. */
function capLines(lines: string[]): string {
  const unique = [...new Set(lines)];
  if (unique.length <= MAX_ERROR_LINES) return unique.join("\n");
  return [...unique.slice(0, MAX_ERROR_LINES - 1), `... and ${unique.length - (MAX_ERROR_LINES - 1)} more problems`].join("\n");
}

/**
 * The proposal in a model's output: the last JSON object with an `edits` array, checked against the schema. A key the schema does not
 * know is an error, so that a misspelled `agnet` is not ignored; an optional field written as null reads as absent. The error is
 * one line per problem, `edits[0].ops[1]: <message>`.
 */
export function parseProposal(text: string): { proposal: Proposal } | { error: string } {
  const found = jsonObjectsIn(text).filter((o): o is Record<string, unknown> => isRecord(o) && Array.isArray(o.edits)).at(-1);
  if (found === undefined) return { error: 'no JSON object with an "edits" array in the output' };
  const raw = withoutNulls(found);
  const checked = proposalSchema.safeParse(raw);
  if (!checked.success) {
    return { error: capLines(checked.error.issues.map((issue) => `${pathText(issue.path)}: ${issueText(issue, raw)}`)) };
  }
  const proposal = checked.data;
  const first = new Map<string, number>();
  const duplicates: string[] = [];
  proposal.edits.forEach((edit, i) => {
    const earlier = first.get(edit.id);
    if (earlier === undefined) first.set(edit.id, i);
    else duplicates.push(`edits[${i}].id: "${edit.id}" is already the id of edits[${earlier}]; give each edit its own id`);
  });
  return duplicates.length > 0 ? { error: capLines(duplicates) } : { proposal };
}

// ── Classifying ───────────────────────────────────────────────────────────────

/** The component of each operation (spec §2). */
const OP_COMPONENT: Record<EditOp["op"], Component> = {
  replace_text: "prompt", set_text: "prompt",
  set: "config",
  set_role: "control_flow", connect: "control_flow", disconnect: "control_flow",
  add_memory_read: "context_mgmt", remove_memory_read: "context_mgmt",
  add_memory_write: "memory", remove_memory_write: "memory",
  add_tool: "client_tool", remove_tool: "client_tool",
  add_agent: "subagent", remove_agent: "subagent",
};

export function opComponent(op: EditOp): Component {
  return OP_COMPONENT[op.op];
}

/** An edit's component: the most structural one among its operations. */
export function editComponent(edit: Pick<ProposedEdit, "ops">): Component {
  const component = mostStructural(edit.ops.map(opComponent));
  if (component === null) throw new Error("an edit needs at least one operation");
  return component;
}

/** An edit with the component its operations give, and what the proposer declared. It can be used as an `EditRecord`. */
export interface ClassifiedEdit extends Omit<ProposedEdit, "component"> {
  component: Component;
  /** The word the proposer gave. */
  declared: string;
  /** Whether `declared` differs from `component`. */
  retagged: boolean;
}

export function classify(proposal: Pick<Proposal, "edits">): ClassifiedEdit[] {
  return proposal.edits.map((edit) => {
    const component = editComponent(edit);
    return { ...edit, component, declared: edit.component, retagged: edit.component !== component };
  });
}

// ── The workflow's YAML ───────────────────────────────────────────────────────

type Doc = Document;

/** A problem with one operation. Its message goes into the error line. */
class OpError extends Error {}

interface Agent {
  index: number;
  name: string;
  map: YAMLMap;
}

/** The child `key` of `parent`, when it is a node of the kind `is` checks. */
function member<T>(parent: YAMLMap, key: string, is: (node: unknown) => node is T, kind: string, what: string): T {
  const node = parent.get(key, true);
  if (!is(node)) throw new OpError(`${what} is not ${kind} in the workflow file, so it cannot be edited`);
  return node;
}

function rootMap(doc: Doc): YAMLMap {
  if (!isMap(doc.contents)) throw new OpError("the workflow file is not a mapping");
  return doc.contents;
}

function agentsOf(doc: Doc): { seq: YAMLSeq; agents: Agent[] } {
  const seq = member(rootMap(doc), "agents", isSeq, "a list", "agents");
  const agents = seq.items.map((item, index): Agent => {
    if (!isMap(item)) throw new OpError(`agents[${index}] is not a mapping in the workflow file`);
    return { index, name: String(item.get("name")), map: item };
  });
  return { seq, agents };
}

/** The agent called `name`; `where` says which field of the operation named it. */
function findAgent(doc: Doc, name: string, where?: string): Agent {
  const { agents } = agentsOf(doc);
  const found = agents.find((agent) => agent.name === name);
  if (!found) {
    throw new OpError(`no agent is named "${name}"${where ? ` (in \`${where}\`)` : ""}; the agents are: ${agents.map((a) => `"${a.name}"`).join(", ")}`);
  }
  return found;
}

const agentId = (agent: Agent): string => `agent-${agent.index}`;

/** The strings of a list. */
const itemsOf = (seq: YAMLSeq): string[] => seq.items.map((item) => String(isScalar(item) ? item.value : item));

/** `agent-<n>` → n. */
const agentNumber = (id: unknown): number | undefined => {
  const match = typeof id === "string" ? /^agent-(\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : undefined;
};

/** The lines of an operation's text, none for an empty text. */
const textLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
/** A text on one line: its white space runs become one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const indent = (lines: string[], by = "  "): string[] => lines.map((line) => (line === "" ? line : by + line));
const preview = (text: string): string => JSON.stringify(text.length > 50 ? `${text.slice(0, 50)}…` : text);

/** Where `needle` occurs in `text`, overlaps counted (an edit that could mean two places is not one place). */
function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** Sets a text scalar's value, keeping its style. A value of several lines becomes a block scalar. */
function writeText(node: Scalar, value: string): void {
  node.value = value;
  if (value.includes("\n") && node.type !== Scalar.BLOCK_LITERAL && node.type !== Scalar.BLOCK_FOLDED) node.type = Scalar.BLOCK_LITERAL;
}

/** The text of an agent's prompt or description, and how to write it. A missing description reads as "". */
function textOf(doc: Doc, agent: Agent, field: "prompt" | "description"): { text: string; write: (value: string) => void } {
  if (field === "description") {
    const node = agent.map.get("description", true);
    if (node === undefined) {
      return {
        text: "",
        write: (value) => {
          const created = new Scalar(value);
          writeText(created, value);
          agent.map.items.push(doc.createPair("description", created));
        },
      };
    }
    if (!isScalar(node)) throw new OpError(`the description of agent "${agent.name}" is not a text in the workflow file, so it cannot be edited`);
    return { text: String(node.value), write: (value) => writeText(node, value) };
  }
  const source = member(agent.map, "promptSource", isMap, "a mapping", `the prompt of agent "${agent.name}"`);
  if (source.get("type") === "file") {
    throw new OpError(
      `agent "${agent.name}" reads its prompt from the file ${String(source.get("path"))}; only an inline prompt (promptSource type inline) can be edited`,
    );
  }
  const content = member(source, "content", isScalar, "a text", `the prompt of agent "${agent.name}"`);
  return { text: String(content.value), write: (value) => writeText(content, value) };
}

// ── The operations ────────────────────────────────────────────────────────────
// Each applies itself to `doc`, or throws an OpError before it changes anything (for a file of the app's schema), and returns how it is
// shown (see renderChange).

function applyReplaceText(doc: Doc, op: Op<"replace_text">): string[] {
  const agent = findAgent(doc, op.agent);
  if (op.new === op.old) throw new OpError("`new` is the same as `old`, so the edit changes nothing");
  const target = textOf(doc, agent, op.field);
  const at = occurrences(target.text, op.old);
  if (at.length === 0) {
    throw new OpError(
      `\`old\` (${preview(op.old)}) was not found in the ${op.field} of agent "${agent.name}"; copy it exactly from the current ${op.field}, spaces and line breaks included`,
    );
  }
  if (at.length > 1) {
    throw new OpError(
      `\`old\` (${preview(op.old)}) occurs ${at.length} times in the ${op.field} of agent "${agent.name}"; add more of the text around it so that it occurs exactly once`,
    );
  }
  target.write(target.text.slice(0, at[0]) + op.new + target.text.slice(at[0] + op.old.length));
  return [`${agent.name} · ${op.field}: replace`, ...indent([...textLines(op.old).map((l) => `- ${l}`), ...textLines(op.new).map((l) => `+ ${l}`)])];
}

function applySetText(doc: Doc, op: Op<"set_text">): string[] {
  const agent = findAgent(doc, op.agent);
  const target = textOf(doc, agent, op.field);
  if (op.value === target.text) throw new OpError(`the ${op.field} of agent "${agent.name}" already has this text, so the edit changes nothing`);
  target.write(op.value);
  return [`${agent.name} · ${op.field}: set`, ...indent(lineDiff(target.text, op.value).split("\n"))];
}

function applySet(doc: Doc, op: Op<"set">): string[] {
  const agent = findAgent(doc, op.agent);
  const current = agent.map.get(op.field, true);
  if (current === undefined) {
    // Only thinkDepth can be missing: the schema requires the others.
    agent.map.items.push(doc.createPair(op.field, op.value));
    return [`${agent.name} · ${op.field}: (not set) → ${op.value}`];
  }
  if (!isScalar(current)) throw new OpError(`${op.field} of agent "${agent.name}" is not a plain value in the workflow file, so it cannot be edited`);
  if (current.value === op.value) throw new OpError(`agent "${agent.name}" already has ${op.field} ${op.value}, so the edit changes nothing`);
  const before = current.value;
  current.value = op.value;
  return [`${agent.name} · ${op.field}: ${String(before)} → ${op.value}`];
}

function applySetRole(doc: Doc, op: Op<"set_role">): string[] {
  const agent = findAgent(doc, op.agent);
  const current = member(agent.map, "role", isScalar, "a plain value", `the role of agent "${agent.name}"`);
  if (current.value === op.value) throw new OpError(`agent "${agent.name}" already has the role ${op.value}, so the edit changes nothing`);
  const before = current.value;
  current.value = op.value;
  return [`${agent.name} · role: ${String(before)} → ${op.value}`];
}

type ListField = "tools" | "memoryRead" | "memoryWrite";

function addToList(doc: Doc, name: string, field: ListField, value: string): string[] {
  const agent = findAgent(doc, name);
  const list = member(agent.map, field, isSeq, "a list", `${field} of agent "${agent.name}"`);
  if (itemsOf(list).includes(value)) throw new OpError(`agent "${agent.name}" already has "${value}" in ${field}, so the edit changes nothing`);
  list.add(doc.createNode(value));
  return [`${agent.name} · ${field}: + ${value}`];
}

function removeFromList(doc: Doc, name: string, field: ListField, value: string): string[] {
  const agent = findAgent(doc, name);
  const list = member(agent.map, field, isSeq, "a list", `${field} of agent "${agent.name}"`);
  const items = itemsOf(list);
  const at = items.indexOf(value);
  if (at < 0) {
    throw new OpError(`agent "${agent.name}" does not have "${value}" in ${field} (it has: ${items.length > 0 ? items.join(", ") : "nothing"})`);
  }
  list.delete(at);
  return [`${agent.name} · ${field}: − ${value}`];
}

/** The model most agents use, leaving out the agents with none (a memory agent has ""); on a tie, the one that appears first. */
function commonModel(agents: Agent[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const model = String(agent.map.get("model") ?? "");
    if (model !== "") counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  let best = "";
  let most = 0;
  for (const [model, count] of counts) {
    if (count > most) {
      best = model;
      most = count;
    }
  }
  return best || String(agents[0].map.get("model") ?? "");
}

/** Gives a new item the blank line that the last item of the list has before it, if it has one. */
function matchSpacing(list: YAMLSeq, item: YAMLMap): void {
  const last = list.items[list.items.length - 1];
  if (isMap(last) && last.spaceBefore) item.spaceBefore = true;
}

function applyAddAgent(doc: Doc, op: Op<"add_agent">): string[] {
  const { seq, agents } = agentsOf(doc);
  if (agents.some((agent) => agent.name === op.name)) {
    throw new OpError(`an agent named "${op.name}" already exists; give the new agent a name that no agent has`);
  }
  const first = agents[0];
  const positions = member(rootMap(doc), "nodePositions", isMap, "a mapping", "nodePositions");
  const node = doc.createNode({
    name: op.name,
    role: op.role,
    model: commonModel(agents),
    temperature: first.map.get("temperature") ?? 0,
    maxTokens: op.maxTokens ?? 2048,
    maxSteps: op.maxSteps ?? 5,
    timeoutSeconds: op.timeoutSeconds ?? 300,
    ...(op.description === undefined ? {} : { description: op.description }),
    promptSource: { type: "inline", content: op.prompt },
    tools: op.tools ?? [],
    memoryRead: op.memoryRead ?? [],
    memoryWrite: op.memoryWrite ?? [],
    tokens: { used: 0, budget: 0 },
    status: "idle",
    ...(op.thinkDepth === undefined ? {} : { thinkDepth: op.thinkDepth }),
  }) as YAMLMap;
  // Look like the agents already there: block text for several lines, flow lists where the first agent has them.
  for (const text of [node.get("description", true), member(node, "promptSource", isMap, "a mapping", "promptSource").get("content", true)]) {
    if (isScalar(text)) writeText(text, String(text.value));
  }
  for (const key of ["tools", "memoryRead", "memoryWrite", "tokens"]) {
    const like = first.map.get(key, true);
    const mine = node.get(key, true);
    if ((isSeq(like) || isMap(like)) && (isSeq(mine) || isMap(mine))) mine.flow = like.flow;
  }
  matchSpacing(seq, node);
  seq.add(node);

  // Its position: to the right of the rightmost agent.
  const placed = Object.values(positions.toJS(doc) as Record<string, { x?: number }>).map((p) => p?.x ?? 0);
  const place = doc.createNode({ x: placed.length > 0 ? Math.max(...placed) + 260 : 0, y: 120 }) as YAMLMap;
  place.flow = true;
  positions.items.push(doc.createPair(`agent-${agents.length}`, place));

  const details = [`tools [${(op.tools ?? []).join(", ")}]`];
  if (op.memoryRead?.length) details.push(`memoryRead [${op.memoryRead.join(", ")}]`);
  if (op.memoryWrite?.length) details.push(`memoryWrite [${op.memoryWrite.join(", ")}]`);
  for (const key of ["maxTokens", "maxSteps", "timeoutSeconds", "thinkDepth"] as const) if (op[key] !== undefined) details.push(`${key} ${op[key]}`);
  return [
    `+ agent "${op.name}" (${op.role}), ${details.join(", ")}`,
    ...indent(op.description === undefined ? [] : [`description: ${oneLine(op.description)}`]),
    ...indent(textLines(op.prompt), "    "),
  ];
}

function applyRemoveAgent(doc: Doc, op: Op<"remove_agent">, protectedAgents: ReadonlyMap<string, string>): string[] {
  const { seq, agents } = agentsOf(doc);
  const agent = findAgent(doc, op.agent);
  const reason = protectedAgents.get(agent.name);
  if (reason !== undefined) throw new OpError(`agent "${agent.name}" cannot be removed: ${reason}`);
  if (agents.length === 1) throw new OpError(`agent "${agent.name}" is the only agent, and a workflow needs at least one`);
  const connections = member(rootMap(doc), "connections", isSeq, "a list", "connections");
  const positions = member(rootMap(doc), "nodePositions", isMap, "a mapping", "nodePositions");
  seq.items.splice(agent.index, 1);

  // The ids are positions: the edges of the agent go, and every agent after it moves up one place.
  const gone = agentId(agent);
  const shift = (id: unknown): void => {
    const n = agentNumber(isScalar(id) ? id.value : id);
    if (isScalar(id) && n !== undefined && n > agent.index) id.value = `agent-${n - 1}`;
  };
  connections.items = connections.items.filter((c) => !(isMap(c) && (c.get("sourceAgentId") === gone || c.get("targetAgentId") === gone)));
  for (const c of connections.items) {
    if (!isMap(c)) continue;
    shift(c.get("sourceAgentId", true));
    shift(c.get("targetAgentId", true));
  }
  const keyOf = (pair: { key: unknown }): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);
  positions.items = positions.items.filter((pair) => keyOf(pair) !== gone);
  for (const pair of positions.items) shift(pair.key);
  return [`− agent "${agent.name}"`];
}

function applyConnect(doc: Doc, op: Op<"connect">): string[] {
  const from = findAgent(doc, op.from, "from");
  const to = findAgent(doc, op.to, "to");
  if (from.index === to.index) throw new OpError(`\`from\` and \`to\` are both agent "${from.name}"; an agent cannot be connected to itself`);
  const kind = op.kind ?? "dataflow";
  const connections = member(rootMap(doc), "connections", isSeq, "a list", "connections");
  const edges = connections.items.filter(isMap);
  const edgeKind = (edge: YAMLMap): string => String(edge.get("edgeKind") ?? "dataflow");
  if (edges.some((e) => e.get("sourceAgentId") === agentId(from) && e.get("targetAgentId") === agentId(to) && edgeKind(e) === kind)) {
    throw new OpError(`the edge ${from.name} → ${to.name} (${kind}) already exists, so the edit changes nothing`);
  }
  const taken = new Set(edges.map((e) => String(e.get("id"))));
  const stem = `evolve-${from.index}-${to.index}`;
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  const edge = doc.createNode({
    id, sourceAgentId: agentId(from), targetAgentId: agentId(to), edgeKind: kind, ...(op.label ? { label: op.label } : {}),
  }) as YAMLMap;
  matchSpacing(connections, edge);
  connections.add(edge);
  return [`edge: + ${from.name} → ${to.name} (${kind}${op.label ? `, ${JSON.stringify(op.label)}` : ""})`];
}

function applyDisconnect(doc: Doc, op: Op<"disconnect">): string[] {
  const { agents } = agentsOf(doc);
  const from = findAgent(doc, op.from, "from");
  const to = findAgent(doc, op.to, "to");
  const connections = member(rootMap(doc), "connections", isSeq, "a list", "connections");
  const edges = connections.items.filter(isMap);
  const removed = edges.filter((e) => e.get("sourceAgentId") === agentId(from) && e.get("targetAgentId") === agentId(to));
  if (removed.length === 0) {
    const names = new Map(agents.map((agent) => [agentId(agent), agent.name]));
    const targets = edges.filter((e) => e.get("sourceAgentId") === agentId(from)).map((e) => names.get(String(e.get("targetAgentId"))) ?? "?");
    throw new OpError(
      `there is no edge from "${from.name}" to "${to.name}"; ${targets.length > 0 ? `the edges from "${from.name}" go to: ${targets.join(", ")}` : `"${from.name}" has no edge going out`}`,
    );
  }
  connections.items = connections.items.filter((c) => !(isMap(c) && removed.includes(c)));
  return removed.map((e) => `edge: − ${from.name} → ${to.name} (${String(e.get("edgeKind") ?? "dataflow")})`);
}

/** The agents an operation names, with the field that names them; a new agent is not one. */
function namedAgents(op: EditOp): Array<[name: string, where: string | undefined]> {
  switch (op.op) {
    case "add_agent": return [];
    case "connect":
    case "disconnect": return [[op.from, "from"], [op.to, "to"]];
    default: return [[op.agent, undefined]];
  }
}

/** Agents that run scripts stay as they are (spec §3.3): a hook agent is not touched, nor are its edges; an agent with a preHook or
 *  postHook keeps its place and its role. Its other fields can change: the hook runs whatever its prompt says. */
function checkHooks(doc: Doc, op: EditOp): void {
  for (const [name, where] of namedAgents(op)) {
    const agent = findAgent(doc, name, where);
    if (agent.map.get("role") === AgentRole.Hook) {
      throw new OpError(`agent "${agent.name}" is a hook agent: it runs a script, so an edit cannot change it or its edges`);
    }
    if ((op.op === "remove_agent" || op.op === "set_role") && (agent.map.has("preHook") || agent.map.has("postHook"))) {
      throw new OpError(`agent "${agent.name}" runs a hook script (preHook or postHook), so an edit cannot remove it or change its role`);
    }
  }
}

/** Applies one operation to `doc`; its lines for renderChange. */
function applyOp(doc: Doc, op: EditOp, protectedAgents: ReadonlyMap<string, string>): string[] {
  checkHooks(doc, op);
  switch (op.op) {
    case "replace_text": return applyReplaceText(doc, op);
    case "set_text": return applySetText(doc, op);
    case "set": return applySet(doc, op);
    case "set_role": return applySetRole(doc, op);
    case "add_tool": return addToList(doc, op.agent, "tools", op.tool);
    case "remove_tool": return removeFromList(doc, op.agent, "tools", op.tool);
    case "add_memory_read": return addToList(doc, op.agent, "memoryRead", op.key);
    case "remove_memory_read": return removeFromList(doc, op.agent, "memoryRead", op.key);
    case "add_memory_write": return addToList(doc, op.agent, "memoryWrite", op.key);
    case "remove_memory_write": return removeFromList(doc, op.agent, "memoryWrite", op.key);
    case "add_agent": return applyAddAgent(doc, op);
    case "remove_agent": return applyRemoveAgent(doc, op, protectedAgents);
    case "connect": return applyConnect(doc, op);
    case "disconnect": return applyDisconnect(doc, op);
  }
}

const reasonOf = (e: unknown): string => (e instanceof OpError ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`);

// ── Applying a proposal ───────────────────────────────────────────────────────

export interface ApplyContext {
  /** Agents that cannot be removed, each with the reason (for example, a scorer that names it with `node:`). */
  protectedAgents: ReadonlyMap<string, string>;
}

export type ApplyResult = { text: string; edits: ClassifiedEdit[] } | { errors: string[] };

const MAX_SCHEMA_ISSUES = 5;

/** The workflow in `text` as a YAML document, or what is wrong with it: it must be a workflow of the app's schema with at least one agent,
 *  and the agents must have different names, because edits name them. */
function loadIncumbent(text: string): { doc: Doc } | { errors: string[] } {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return { errors: [`the incumbent workflow is not valid YAML: ${doc.errors[0].message}`] };
    const checked = workflowDefSchema.safeParse(doc.toJS());
    if (!checked.success) {
      return {
        errors: checked.error.issues.slice(0, MAX_SCHEMA_ISSUES).map((i) => `the incumbent workflow is not valid: ${i.path.join(".") || "(the file)"}: ${i.message}`),
      };
    }
    const agents = checked.data.agents;
    if (agents.length === 0) return { errors: ["the incumbent workflow has no agents, so there is nothing to edit"] };
    const errors: string[] = [];
    agents.forEach((agent, i) => {
      const earlier = agents.findIndex((other) => other.name === agent.name);
      if (earlier < i) errors.push(`the incumbent workflow has two agents named "${agent.name}" (agents[${earlier}] and agents[${i}]); edits name agents, so the names must be unique`);
    });
    return errors.length > 0 ? { errors } : { doc };
  } catch (e) {
    return { errors: [`the incumbent workflow cannot be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/** The text of the edited workflow loaded as `harness eval` loads it: the YAML, the app's schema, the graph. What is wrong with it. */
function loadProblems(text: string, protectedAgents: ReadonlyMap<string, string>): string[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return [`the edited workflow is not valid YAML: ${e instanceof Error ? e.message : String(e)}`];
  }
  const checked = workflowDefSchema.safeParse(raw);
  if (!checked.success) {
    return checked.error.issues.slice(0, MAX_SCHEMA_ISSUES).map((i) => `the edited workflow is not valid: ${i.path.join(".") || "(the file)"}: ${i.message}`);
  }
  const def = checked.data as WorkflowDef;
  const problems: string[] = [];
  const count = def.agents.length;
  for (const connection of def.connections) {
    for (const [side, id] of [["source", connection.sourceAgentId], ["target", connection.targetAgentId]] as const) {
      const n = agentNumber(id);
      if (n === undefined || n >= count) {
        problems.push(`the edited workflow is invalid: connection ${connection.id} has ${side} ${id}, which is not one of its ${count} agents (agent-0 to agent-${count - 1})`);
      }
    }
  }
  const graph = defToGraph(def);
  const hints: Record<string, string> = {
    disconnected: " Every agent needs an edge: add a connect op for it, in the same edit as the change that left it alone.",
    cycle: ' Make the edge that closes the loop a "feedback" edge (a connect op with kind "feedback"), or leave it out.',
    missing_prompt: " Give it a non-empty prompt.",
  };
  for (const problem of validateWorkflow(graph.nodes, graph.edges).errors) {
    problems.push(`the edited workflow is invalid: ${problem.message}${hints[problem.kind] ?? ""}`);
  }
  for (const [name, reason] of protectedAgents) {
    const n = def.agents.filter((agent) => agent.name === name).length;
    if (n !== 1) problems.push(`the edited workflow is invalid: agent "${name}" must still exist exactly once (${reason}), and ${n === 0 ? "it is gone" : `it is there ${n} times`}`);
  }
  return problems;
}

/** Runs the operations of one edit on `doc`; the first problem as an error line, or undefined when all applied. */
function tryEdit(doc: Doc, edit: ProposedEdit, protectedAgents: ReadonlyMap<string, string>): string | undefined {
  for (let j = 0; j < edit.ops.length; j++) {
    try {
      applyOp(doc, edit.ops[j], protectedAgents);
    } catch (e) {
      return `edit ${edit.id}, op ${j + 1} (${edit.ops[j].op}): ${reasonOf(e)}`;
    }
  }
  return undefined;
}

/**
 * Applies a proposal to the workflow in `incumbentText`: its edits in order, each on a copy of the document that is kept only when
 * all its operations apply, so that a failing edit changes nothing and the next one is tried on the state before it. The result is
 * `{ errors }` when any edit failed (the first problem of each, `edit C1, op 2 (replace_text): …`; op numbers count from 1), or when
 * the edited workflow does not load as `harness eval` loads it. Comments and layout are kept: the file is edited as a YAML document.
 */
export function applyProposal(incumbentText: string, proposal: Proposal, ctx: ApplyContext): ApplyResult {
  const loaded = loadIncumbent(incumbentText);
  if ("errors" in loaded) return loaded;
  if (proposal.edits.length === 0) return { errors: ["the proposal has no edits; it needs at least one"] };
  let doc = loaded.doc;
  const errors: string[] = [];
  for (const edit of proposal.edits) {
    if (edit.ops.length === 0) {
      errors.push(`edit ${edit.id} has no operations; give it at least one`);
      continue;
    }
    const work = doc.clone();
    const failure = tryEdit(work, edit, ctx.protectedAgents);
    if (failure === undefined) doc = work;
    else errors.push(failure);
  }
  if (errors.length > 0) return { errors };
  const text = doc.toString({ lineWidth: 0 });
  const problems = loadProblems(text, ctx.protectedAgents);
  return problems.length > 0 ? { errors: problems } : { text, edits: classify(proposal) };
}

// ── Checks for the loop ───────────────────────────────────────────────────────

/** A proposal over the edit budget b_t; undefined when it is within it. The budget counts declared edits. */
export function checkBudget(proposal: Pick<Proposal, "edits">, b_t: number): string | undefined {
  const n = proposal.edits.length;
  return n > b_t ? `${n} edits exceed the budget b_t = ${b_t}` : undefined;
}

/** For a variant that holds a reserved exploration slot: some edit must be on a component the run has never exercised. Judged by
 *  the classified components, that is by the operations. undefined when `untried` is empty or one edit is on one of them. */
export function checkReservedSlot(edits: readonly { id: string; component: string }[], untried: readonly string[]): string | undefined {
  if (untried.length === 0 || edits.some((edit) => untried.includes(edit.component))) return undefined;
  return `this variant holds a reserved exploration slot: at least one edit must be on a never-exercised component from ${JSON.stringify(untried)} ` +
    `(judged by its operations), and none is. The edits are on: ${edits.map((edit) => `${edit.id} = ${edit.component}`).join(", ")}.`;
}

// ── Showing a change ──────────────────────────────────────────────────────────

/**
 * The text the critic and the history read: per edit a header, `C1 [client_tool] (declared prompt) — <hypothesis>` (the declared
 * part only when the edit was re-tagged), and under it one line or block per operation, naming the agent and what changed. The
 * old values are read from the workflow as the operations reach them, so `incumbentText` must be the workflow the edits apply to.
 */
export function renderChange(incumbentText: string, edits: readonly ClassifiedEdit[]): string {
  const doc = parseDocument(incumbentText);
  const unprotected = new Map<string, string>();
  return edits
    .map((edit) => {
      const declared = edit.retagged ? ` (declared ${edit.declared})` : "";
      const lines = [`${edit.id} [${edit.component}]${declared} — ${oneLine(edit.hypothesis)}`];
      edit.ops.forEach((op, j) => {
        try {
          lines.push(...indent(applyOp(doc, op, unprotected)));
        } catch (e) {
          throw new Error(`renderChange: edit ${edit.id}, op ${j + 1} (${op.op}) does not apply to this workflow: ${reasonOf(e)}`);
        }
      });
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── The line diff ─────────────────────────────────────────────────────────────

/** The longest pair of texts, in lines multiplied, that lineDiff will compare. */
const MAX_DIFF_CELLS = 4_000_000;

/** The lines of a text, CRLF or LF (the edited file is written with LF, whatever the incumbent has); a line break at its end ends
 *  the last line instead of starting another. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

type Step = readonly [mark: " " | "-" | "+", line: string];

/** How `a` becomes `b`: the common head and tail are cut off, and a table of longest common subsequences of the lines between them
 *  says which stay. Removed lines come before the added lines that replace them. */
function editScript(a: string[], b: string[]): Step[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const width = m + 1;
  // lcs[i * width + j]: the length of the longest common subsequence of a[head + i ..] and b[head + j ..] (tails left out)
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[head + i] === b[head + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const steps: Step[] = a.slice(0, head).map((line) => [" ", line]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      steps.push([" ", a[head + i]]);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      steps.push(["-", a[head + i++]]);
    } else {
      steps.push(["+", b[head + j++]]);
    }
  }
  while (i < n) steps.push(["-", a[head + i++]]);
  while (j < m) steps.push(["+", b[head + j++]]);
  for (const line of a.slice(a.length - tail)) steps.push([" ", line]);
  return steps;
}

/**
 * The difference between two texts as unified hunks: `@@ -l,s +l,s @@`, then the lines, each with ` `, `-` or `+` in front, and
 * `context` unchanged lines around every change. "" for equal texts. Over 4 000 000 pairs of lines (lines of `a` times lines of `b`)
 * it gives up with `(too large to diff: <n> and <m> lines)` instead of building the table.
 */
export function lineDiff(a: string, b: string, context = 3): string {
  if (a === b) return "";
  const x = splitLines(a);
  const y = splitLines(b);
  if (x.length * y.length > MAX_DIFF_CELLS) return `(too large to diff: ${x.length} and ${y.length} lines)`;
  const steps = editScript(x, y);
  const changed = steps.flatMap(([mark], k) => (mark === " " ? [] : [k]));
  if (changed.length === 0) return "(the texts differ only in their line breaks)";

  // Each change claims `context` steps on either side; claims that touch make one hunk.
  const spread = Math.max(0, context);
  const hunks: Array<[from: number, to: number]> = [];
  for (const k of changed) {
    const from = Math.max(0, k - spread);
    const to = Math.min(steps.length - 1, k + spread);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = to;
    else hunks.push([from, to]);
  }
  // How many lines of `a` and of `b` come before each step.
  const aBefore = [0];
  const bBefore = [0];
  for (const [mark] of steps) {
    aBefore.push(aBefore[aBefore.length - 1] + (mark === "+" ? 0 : 1));
    bBefore.push(bBefore[bBefore.length - 1] + (mark === "-" ? 0 : 1));
  }
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const hunk = steps.slice(from, to + 1);
    const aCount = hunk.filter(([mark]) => mark !== "+").length;
    const bCount = hunk.filter(([mark]) => mark !== "-").length;
    // An empty range starts at the line before it, as diff writes it.
    const aStart = aCount === 0 ? aBefore[from] : aBefore[from] + 1;
    const bStart = bCount === 0 ? bBefore[from] : bBefore[from] + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const [mark, line] of hunk) out.push(mark + line);
  }
  return out.join("\n");
}

/** `lineDiff` of two workflow files, with the `--- incumbent` and `+++ candidate` headers; "" when they are equal. */
export function diffFile(incumbentText: string, candidateText: string): string {
  const diff = lineDiff(incumbentText, candidateText);
  return diff === "" ? "" : `--- incumbent\n+++ candidate\n${diff}\n`;
}
