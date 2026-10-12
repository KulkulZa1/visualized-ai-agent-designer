// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  ADDABLE_TOOLS, applyProposal, checkBudget, checkReservedSlot, classify, diffFile, editComponent, lineDiff, opComponent, parseProposal,
  renderChange, type ApplyContext, type EditOp, type Proposal, type ProposedEdit,
} from "@/evolve/edits";
import type { EditRecord } from "@/evolve/selection";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";

// ── a workflow to edit ────────────────────────────────────────────────────────

/** Five agents with comments, a flow list and a block list, a one-line prompt, a memory agent and a prompt that is a file. */
const FIXTURE = `# Fixture workflow for the edit tests.
meta:
  name: Edit Fixture
  version: "1.0.0"
  description: A small workflow
  projectRoot: ""
  createdAt: "2026-10-11T00:00:00Z"
  updatedAt: "2026-10-11T00:00:00Z"

agents:
  # agent-0: the planner
  - name: Planner
    role: orchestrator
    model: big-model
    temperature: 0.5
    maxTokens: 1000   # the token limit
    maxSteps: 3
    timeoutSeconds: 100
    description: Plans the work.
    promptSource:
      type: inline
      content: |
        You plan the work.
        Split it into steps.
        Be brief.
    tools: [read_file]   # a flow list, with a comment
    memoryRead: []
    memoryWrite: [plan]
    tokens: { used: 0, budget: 0 }
    status: idle

  # agent-1: the writer
  - name: Writer
    role: worker
    model: big-model
    temperature: 0.7
    maxTokens: 2000
    maxSteps: 4
    timeoutSeconds: 200
    promptSource:
      type: inline
      content: Write the answer.
    tools:
      - list_files
      - grep
    memoryRead: [plan]
    memoryWrite: []
    tokens: { used: 0, budget: 0 }
    status: idle

  # agent-2: the checker
  - name: Checker
    role: critic
    model: small-model
    temperature: 0.3
    maxTokens: 1500
    maxSteps: 2
    timeoutSeconds: 150
    thinkDepth: low
    promptSource:
      type: inline
      content: |
        Check the answer.
    tools: []
    memoryRead: [plan]
    memoryWrite: [verdict]
    tokens: { used: 0, budget: 0 }
    status: idle

  # agent-3: the notes, a memory agent that has no model
  - name: Notes
    role: memory
    model: ""
    temperature: 0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 30
    promptSource:
      type: inline
      content: ""
    tools: [fs.append, fs.read]
    memoryRead: []
    memoryWrite: [plan, verdict]
    tokens: { used: 0, budget: 0 }
    status: idle

  # agent-4: the reporter, whose prompt is a file
  - name: Reporter
    role: aggregator
    model: big-model
    temperature: 0.4
    maxTokens: 2500
    maxSteps: 3
    timeoutSeconds: 120
    promptSource:
      type: file
      path: prompts/report.md
    tools: [fs.read]
    memoryRead: [plan, verdict]
    memoryWrite: [report]
    tokens: { used: 0, budget: 0 }
    status: idle

connections:
  # the plan goes to the writer
  - id: plan-to-write
    sourceAgentId: agent-0
    targetAgentId: agent-1
    edgeKind: dataflow

  - id: write-to-check
    sourceAgentId: agent-1
    targetAgentId: agent-2
    label: draft
    edgeKind: dataflow

  - id: check-to-notes
    sourceAgentId: agent-2
    targetAgentId: agent-3
    edgeKind: memory

  - id: notes-to-report
    sourceAgentId: agent-3
    targetAgentId: agent-4
    label: notes
    edgeKind: memory

  # the checker also reports directly
  - id: check-to-report
    sourceAgentId: agent-2
    targetAgentId: agent-4
    edgeKind: dataflow

executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0

nodePositions:
  agent-0: { x: 0, y: 100 }
  agent-1: { x: 250, y: 100 }
  agent-2: { x: 500, y: 100 }
  agent-3: { x: 750, y: 100 }
  agent-4: { x: 1000, y: 100 }
`;

const EXAMPLE = readFileSync(resolve("examples/research-synthesis.harness.yaml"), "utf8");

/** A small workflow of these agents (any field can be overridden) and edges, written by the yaml package. */
function workflow(agents: Array<Record<string, unknown>>, edges: Array<[number, number]>, positions = true): string {
  return stringify({
    meta: { name: "W", version: "1.0.0", description: "d", projectRoot: "", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" },
    agents: agents.map((a, i) => ({
      name: `Agent ${i}`, role: "worker", model: "m1", temperature: 0.5, maxTokens: 1000, maxSteps: 3, timeoutSeconds: 100,
      promptSource: { type: "inline", content: `You are agent ${i}.` }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 },
      status: "idle", ...a,
    })),
    connections: edges.map(([a, b], i) => ({ id: `e${i}`, sourceAgentId: `agent-${a}`, targetAgentId: `agent-${b}`, edgeKind: "dataflow" })),
    executionSettings: { maxParallel: 1, timeoutSeconds: 600, retryOnFailure: false, maxRetries: 0 },
    nodePositions: positions ? Object.fromEntries(agents.map((_, i) => [`agent-${i}`, { x: i * 100, y: 50 }])) : {},
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

const load = (text: string): WorkflowDef => workflowDefSchema.parse(parse(text)) as WorkflowDef;
const ctx = (protectedAgents: Record<string, string> = {}): ApplyContext => ({ protectedAgents: new Map(Object.entries(protectedAgents)) });
const edit = (id: string, ...ops: EditOp[]): ProposedEdit => ({ id, component: "prompt", hypothesis: `why ${id}`, ops });

/** The edits applied to `incumbent`, which must work; the text is loaded again with the app's schema. */
function applied(incumbent: string, ...edits: ProposedEdit[]) {
  const result = applyProposal(incumbent, { edits }, ctx());
  if ("errors" in result) throw new Error(`the edits did not apply:\n${result.errors.join("\n")}`);
  return { text: result.text, def: load(result.text), edits: result.edits };
}

/** The errors of applying the edits to `incumbent`, which must fail. */
function errorsOf(incumbent: string, edits: ProposedEdit[], protectedAgents: Record<string, string> = {}): string[] {
  const result = applyProposal(incumbent, { edits }, ctx(protectedAgents));
  if (!("errors" in result)) throw new Error("expected the edits to fail, but they applied");
  return result.errors;
}

/** `incumbent` as a definition with `change` made by hand: what applying the edit that does the same must give. */
function byHand(incumbent: string, change: (def: WorkflowDef) => void): WorkflowDef {
  const def = load(incumbent);
  change(def);
  return def;
}

const agentOf = (def: WorkflowDef, name: string) => def.agents.find((a) => a.name === name) as WorkflowDef["agents"][number];

/** The edges as names: "A → B (kind)". */
const edgesOf = (def: WorkflowDef): string[] =>
  def.connections.map((c) => `${def.agents[Number(c.sourceAgentId.slice(6))].name} → ${def.agents[Number(c.targetAgentId.slice(6))].name} (${c.edgeKind ?? "dataflow"})`);

const commentsOf = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("#"));

// ── parseProposal ─────────────────────────────────────────────────────────────

const GOOD = {
  summary: "one line",
  edits: [{
    id: "C1", component: "prompt", hypothesis: "why", targets_mode: "mode", predicted_affected: ["task-a"], retroactive_check: "check",
    why_not_lower_lever: "none lower", trigger_condition: "always", regression_risk: "low",
    ops: [{ op: "replace_text", agent: "A", field: "prompt", old: "x", new: "y" }],
  }],
};
const fenced = (o: unknown) => `I looked at the traces.\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\nThat is my proposal.`;
const parseError = (o: unknown): string => {
  const result = parseProposal(fenced(o));
  if (!("error" in result)) throw new Error("expected a parse error");
  return result.error;
};
/** GOOD with this op in place of its operation. */
const withOp = (op: unknown) => ({ edits: [{ id: "C1", component: "prompt", hypothesis: "h", ops: [op] }] });

describe("parseProposal: reading the output", () => {
  it("reads a fenced proposal, and keeps the optional fields", () => {
    expect(parseProposal(fenced(GOOD))).toEqual({ proposal: GOOD });
  });

  it("reads a bare proposal among prose", () => {
    expect(parseProposal(`My answer: ${JSON.stringify(GOOD)} Thanks.`)).toEqual({ proposal: GOOD });
  });

  it("takes the last object that has an edits array", () => {
    const draft = { summary: "draft", edits: [{ id: "D1", component: "prompt", hypothesis: "h", ops: [{ op: "remove_agent", agent: "X" }] }] };
    const text = `${fenced(draft)}\nOn second thought:\n${fenced(GOOD)}\nAnd a note: {"remark": "no edits here"}`;
    expect(parseProposal(text)).toEqual({ proposal: GOOD });
  });

  it("takes the last object with an edits array even when it is the one that is wrong", () => {
    const text = `${fenced(GOOD)}\n${fenced({ edits: [{ id: "C1" }] })}`;
    expect("error" in parseProposal(text)).toBe(true);
  });

  it("says so when there is no object with an edits array", () => {
    const message = 'no JSON object with an "edits" array in the output';
    expect(parseProposal("I have no changes to propose.")).toEqual({ error: message });
    expect(parseProposal(fenced({ summary: "no edits" }))).toEqual({ error: message });
    expect(parseProposal(fenced({ edits: "not an array" }))).toEqual({ error: message });
    expect(parseProposal("")).toEqual({ error: message });
  });
});

describe("parseProposal: what the schema rejects", () => {
  it("names the path of an unknown key in an operation, and the keys it takes", () => {
    const error = parseError(withOp({ op: "replace_text", agnet: "A", agent: "A", field: "prompt", old: "x", new: "y" }));
    expect(error).toBe('edits[0].ops[0]: unknown key "agnet" (the keys here are: op, agent, field, old, new)');
  });

  it("gives a line per problem: the misspelled key, and the field that is missing as a result", () => {
    const error = parseError(withOp({ op: "add_tool", agnet: "A", tool: "grep" }));
    expect(error.split("\n")).toHaveLength(2);
    expect(error).toContain('edits[0].ops[0]: unknown key "agnet" (the keys here are: op, agent, tool)');
    expect(error).toContain("edits[0].ops[0].agent: Invalid input: expected string, received undefined");
  });

  it("names an unknown key of an edit, and of the proposal", () => {
    const error = parseError({ oops: 1, edits: [{ id: "C1", component: "prompt", hypothesis: "h", extra: true, ops: [{ op: "remove_agent", agent: "A" }] }] });
    expect(error.split("\n").sort()).toEqual([
      '(the proposal): unknown key "oops" (the keys here are: summary, edits)',
      'edits[0]: unknown key "extra" (the keys here are: id, component, hypothesis, ops, targets_mode, retroactive_check, why_not_lower_lever, trigger_condition, regression_risk, predicted_affected)',
    ]);
  });

  it("names a required field that is missing, in an edit and in an operation", () => {
    expect(parseError({ edits: [{ id: "C1", component: "prompt", ops: [{ op: "remove_agent", agent: "A" }] }] })).toBe(
      "edits[0].hypothesis: Invalid input: expected string, received undefined",
    );
    for (const field of ["agent", "field", "old", "new"]) {
      const op: Record<string, unknown> = { op: "replace_text", agent: "A", field: "prompt", old: "x", new: "y" };
      delete op[field];
      expect(parseError(withOp(op))).toContain(`edits[0].ops[0].${field}: `);
    }
    expect(parseError({ edits: [{ component: "prompt", hypothesis: "h", ops: [{ op: "remove_agent", agent: "A" }] }] })).toContain("edits[0].id: ");
  });

  it("rejects a duplicate edit id, naming the edit that has it first", () => {
    const one = { id: "C1", component: "prompt", hypothesis: "h", ops: [{ op: "remove_agent", agent: "A" }] };
    expect(parseError({ edits: [one, { ...one, id: "C2" }, { ...one }, { ...one, id: "C2" }] }).split("\n")).toEqual([
      'edits[2].id: "C1" is already the id of edits[0]; give each edit its own id',
      'edits[3].id: "C2" is already the id of edits[1]; give each edit its own id',
    ]);
  });

  it("rejects no edits and an edit with no operations", () => {
    expect(parseError({ edits: [] })).toBe("edits: Too small: expected array to have >=1 items");
    expect(parseError({ edits: [{ id: "C1", component: "prompt", hypothesis: "h", ops: [] }] })).toBe(
      "edits[0].ops: Too small: expected array to have >=1 items",
    );
  });

  it("accepts any non-empty word as the component, and rejects an empty one", () => {
    const edits = (component: string) => ({ edits: [{ id: "C1", component, hypothesis: "h", ops: [{ op: "remove_agent", agent: "A" }] }] });
    expect("proposal" in parseProposal(fenced(edits("banana")))).toBe(true);
    expect("proposal" in parseProposal(fenced(edits("Prompt")))).toBe(true);
    expect(parseError(edits(""))).toContain("edits[0].component: ");
  });

  it("rejects an operation that is not one, and says which are", () => {
    expect(parseError(withOp({ op: "rewrite_prompt", agent: "A" }))).toBe(
      'edits[0].ops[0].op: unknown op "rewrite_prompt"; the operations are: replace_text, set_text, set, set_role, add_tool, remove_tool, ' +
      "add_memory_read, remove_memory_read, add_memory_write, remove_memory_write, add_agent, remove_agent, connect, disconnect",
    );
    expect(parseError(withOp({ agent: "A" }))).toContain('edits[0].ops[0].op: the "op" field is missing; the operations are: ');
    expect(parseError(withOp("remove_agent"))).toContain("edits[0].ops[0]: ");
  });

  it("rejects adding a tool that is not addable, bash among them, and takes any tool to remove", () => {
    for (const tool of ["bash", "web_search", "git", "test", "puppeteer", "nonsense"]) {
      expect(parseError(withOp({ op: "add_tool", agent: "A", tool }))).toContain("edits[0].ops[0].tool: Invalid option");
    }
    for (const tool of ADDABLE_TOOLS) expect("proposal" in parseProposal(fenced(withOp({ op: "add_tool", agent: "A", tool })))).toBe(true);
    for (const tool of Object.values(ToolPermission)) expect("proposal" in parseProposal(fenced(withOp({ op: "remove_tool", agent: "A", tool })))).toBe(true);
    expect(parseError(withOp({ op: "remove_tool", agent: "A", tool: "nonsense" }))).toContain("edits[0].ops[0].tool: Invalid option");
  });

  it("accepts every role but hook, for set_role and add_agent", () => {
    for (const role of Object.values(AgentRole)) {
      const accepted = role !== AgentRole.Hook;
      expect("proposal" in parseProposal(fenced(withOp({ op: "set_role", agent: "A", value: role })))).toBe(accepted);
      expect("proposal" in parseProposal(fenced(withOp({ op: "add_agent", name: "N", role, prompt: "p" })))).toBe(accepted);
    }
    expect(parseError(withOp({ op: "set_role", agent: "A", value: "hook" }))).toContain("edits[0].ops[0].value: Invalid option");
    expect(parseError(withOp({ op: "add_agent", name: "N", role: "hook", prompt: "p" }))).toContain("edits[0].ops[0].role: Invalid option");
  });

  it("holds each field of set to the bounds of the app's schema", () => {
    const set = (field: string, value: unknown) => fenced(withOp({ op: "set", agent: "A", field, value }));
    for (const [field, value] of [
      ["maxTokens", 0], ["maxTokens", 200000], ["maxSteps", 1], ["maxSteps", 1000], ["timeoutSeconds", 1], ["timeoutSeconds", 86400],
      ["thinkDepth", "none"], ["thinkDepth", "low"], ["thinkDepth", "medium"], ["thinkDepth", "high"],
    ] as const) expect("proposal" in parseProposal(set(field, value))).toBe(true);
    for (const [field, value] of [
      ["maxTokens", -1], ["maxTokens", 200001], ["maxTokens", 1.5], ["maxTokens", "3000"], ["maxSteps", 0], ["maxSteps", 1001],
      ["timeoutSeconds", 0], ["timeoutSeconds", 86401], ["thinkDepth", "extreme"], ["thinkDepth", 3],
    ] as const) expect("error" in parseProposal(set(field, value))).toBe(true);
    expect(parseError(withOp({ op: "set", agent: "A", field: "maxTokens", value: 200001 }))).toBe(
      "edits[0].ops[0].value: Too big: expected number to be <=200000",
    );
  });

  it("names an unknown key of a set operation, and the keys it takes", () => {
    const error = parseError(withOp({ op: "set", agent: "A", field: "maxTokens", valu: 5 }));
    expect(error).toContain('edits[0].ops[0]: unknown key "valu" (the keys here are: op, agent, field, value)');
    expect(error).toContain("edits[0].ops[0].value: Invalid input: expected number, received undefined");
  });

  it("says which fields set takes", () => {
    expect(parseError(withOp({ op: "set", agent: "A", field: "temperature", value: 0.1 }))).toBe(
      "edits[0].ops[0].field: field must be one of maxTokens, maxSteps, timeoutSeconds, thinkDepth",
    );
  });

  it("rejects empty names and keys, an empty old, and a name over 64 characters", () => {
    for (const op of [
      { op: "remove_agent", agent: "" }, { op: "add_memory_read", agent: "A", key: "" }, { op: "connect", from: "", to: "B" },
      { op: "replace_text", agent: "A", field: "prompt", old: "", new: "y" }, { op: "add_agent", name: "", role: "worker", prompt: "p" },
      { op: "add_agent", name: "n".repeat(65), role: "worker", prompt: "p" },
    ]) expect("error" in parseProposal(fenced(withOp(op)))).toBe(true);
    expect("proposal" in parseProposal(fenced(withOp({ op: "add_agent", name: "n".repeat(64), role: "worker", prompt: "" })))).toBe(true);
  });

  it("accepts every field of add_agent, and of connect", () => {
    const add = { op: "add_agent", name: "N", role: "worker", prompt: "p", description: "d", tools: ["grep"], memoryRead: ["a"], memoryWrite: ["b"], maxTokens: 1, maxSteps: 2, timeoutSeconds: 3, thinkDepth: "low" };
    expect(parseProposal(fenced(withOp(add)))).toEqual({ proposal: withOp(add) });
    for (const kind of ["dataflow", "memory", "feedback", "control"]) {
      expect("proposal" in parseProposal(fenced(withOp({ op: "connect", from: "A", to: "B", kind, label: "l" })))).toBe(true);
    }
    expect(parseError(withOp({ op: "connect", from: "A", to: "B", kind: "other" }))).toContain("edits[0].ops[0].kind: Invalid option");
    expect(parseError(withOp({ ...add, tools: ["bash"] }))).toContain("edits[0].ops[0].tools[0]: Invalid option");
  });

  it("gives at most 20 lines, the last saying how many problems were left out", () => {
    const ops = Array.from({ length: 30 }, () => ({ op: "remove_agent", agnet: "A" }));
    const lines = parseError({ edits: [{ id: "C1", component: "prompt", hypothesis: "h", ops }] }).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("edits[0].ops[");
    expect(lines[19]).toMatch(/^\.\.\. and \d+ more problems$/);
  });

  it("gives every line when there are 20 or fewer", () => {
    const ops = Array.from({ length: 5 }, () => ({ op: "remove_agent", agnet: "A" }));
    expect(parseError({ edits: [{ id: "C1", component: "prompt", hypothesis: "h", ops }] }).split("\n")).toHaveLength(10); // an unknown key and a missing agent, 5 times
  });
});

// ── classifying ───────────────────────────────────────────────────────────────

describe("opComponent, editComponent and classify", () => {
  const ops: Array<[EditOp, string]> = [
    [{ op: "replace_text", agent: "A", field: "prompt", old: "x", new: "y" }, "prompt"],
    [{ op: "set_text", agent: "A", field: "description", value: "v" }, "prompt"],
    [{ op: "set", agent: "A", field: "maxTokens", value: 1 }, "config"],
    [{ op: "set", agent: "A", field: "thinkDepth", value: "low" }, "config"],
    [{ op: "set_role", agent: "A", value: AgentRole.Critic }, "control_flow"],
    [{ op: "connect", from: "A", to: "B" }, "control_flow"],
    [{ op: "disconnect", from: "A", to: "B" }, "control_flow"],
    [{ op: "add_memory_read", agent: "A", key: "k" }, "context_mgmt"],
    [{ op: "remove_memory_read", agent: "A", key: "k" }, "context_mgmt"],
    [{ op: "add_memory_write", agent: "A", key: "k" }, "memory"],
    [{ op: "remove_memory_write", agent: "A", key: "k" }, "memory"],
    [{ op: "add_tool", agent: "A", tool: ToolPermission.Grep }, "client_tool"],
    [{ op: "remove_tool", agent: "A", tool: ToolPermission.Bash }, "client_tool"],
    [{ op: "add_agent", name: "N", role: AgentRole.Worker, prompt: "p" }, "subagent"],
    [{ op: "remove_agent", agent: "A" }, "subagent"],
  ];

  it.each(ops)("gives %j the component %s", (op, component) => {
    expect(opComponent(op)).toBe(component);
  });

  it("gives the most structural component among an edit's operations", () => {
    const [prompt, , config, , role, connect, , memoryRead, , memoryWrite, , tool, , addAgent] = ops.map(([op]) => op);
    expect(editComponent({ ops: [prompt] })).toBe("prompt");
    expect(editComponent({ ops: [prompt, config] })).toBe("config");
    expect(editComponent({ ops: [config, memoryRead, prompt] })).toBe("context_mgmt");
    expect(editComponent({ ops: [role, config] })).toBe("control_flow");
    expect(editComponent({ ops: [memoryRead, role] })).toBe("control_flow");
    expect(editComponent({ ops: [tool, role, prompt] })).toBe("client_tool");
    expect(editComponent({ ops: [memoryWrite, tool, connect] })).toBe("memory");
    expect(editComponent({ ops: [addAgent, connect] })).toBe("subagent");
    expect(editComponent({ ops: [prompt, memoryWrite, tool, addAgent] })).toBe("subagent");
  });

  it("refuses an edit with no operations", () => {
    expect(() => editComponent({ ops: [] })).toThrow("at least one operation");
  });

  it("classifies add_agent plus connect as subagent, and add_tool plus replace_text as client_tool", () => {
    const proposal: Proposal = {
      edits: [
        { id: "C1", component: "prompt", hypothesis: "h", ops: [
          { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Checker", to: "V" },
        ] },
        { id: "C2", component: "prompt", hypothesis: "h", ops: [
          { op: "add_tool", agent: "Writer", tool: ToolPermission.ReadFile }, { op: "replace_text", agent: "Writer", field: "prompt", old: "a", new: "b" },
        ] },
      ],
    };
    const [first, second] = classify(proposal);
    expect(first).toMatchObject({ id: "C1", component: "subagent", declared: "prompt", retagged: true });
    expect(second).toMatchObject({ id: "C2", component: "client_tool", declared: "prompt", retagged: true });
  });

  it("does not re-tag an edit whose declared word is its component, and re-tags any other word", () => {
    const op: EditOp = { op: "set", agent: "A", field: "maxSteps", value: 2 };
    const make = (component: string): Proposal => ({ edits: [{ id: "C1", component, hypothesis: "h", ops: [op] }] });
    expect(classify(make("config"))[0]).toMatchObject({ component: "config", declared: "config", retagged: false });
    expect(classify(make("skill"))[0]).toMatchObject({ component: "config", declared: "skill", retagged: true });
  });

  it("keeps the rest of the edit, and can be used as an EditRecord", () => {
    const proposal: Proposal = { edits: [{ ...edit("C7", { op: "remove_agent", agent: "A" }), targets_mode: "mode", predicted_affected: ["t1"] }] };
    const records: EditRecord[] = classify(proposal);
    expect(records[0]).toMatchObject({ id: "C7", component: "subagent", hypothesis: "why C7", targets_mode: "mode", predicted_affected: ["t1"] });
    expect(classify(proposal)[0].ops).toEqual(proposal.edits[0].ops);
  });
});

// ── applying: every operation ─────────────────────────────────────────────────

describe("applyProposal: text operations", () => {
  it("replaces text in an inline prompt, keeping every comment and changing nothing else", () => {
    const result = applied(FIXTURE, edit("C1", { op: "replace_text", agent: "Planner", field: "prompt", old: "Be brief.", new: "Be brief and concrete." }));
    for (const comment of commentsOf(FIXTURE)) expect(result.text).toContain(comment);
    expect(result.text).toContain("maxTokens: 1000 # the token limit");
    expect(result.text).toContain("        Be brief and concrete.\n");
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[0].promptSource = { type: "inline", content: "You plan the work.\nSplit it into steps.\nBe brief and concrete.\n" };
    }));
  });

  it("replaces text in a description, and the new text may have several lines", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "replace_text", agent: "Planner", field: "description", old: "Plans", new: "Plans and splits" }),
      edit("C2", { op: "replace_text", agent: "Writer", field: "prompt", old: "answer", new: "answer.\nCite the sources" }),
    );
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[0].description = "Plans and splits the work.";
      d.agents[1].promptSource = { type: "inline", content: "Write the answer.\nCite the sources." };
    }));
    expect(result.text).toMatch(/content: \|-?\n {8}Write the answer\.\n {8}Cite the sources\./); // a block scalar
  });

  it("replaces a piece of text with nothing", () => {
    const result = applied(FIXTURE, edit("C1", { op: "replace_text", agent: "Planner", field: "prompt", old: "Split it into steps.\n", new: "" }));
    expect(agentOf(result.def, "Planner").promptSource).toEqual({ type: "inline", content: "You plan the work.\nBe brief.\n" });
  });

  it("sets the whole prompt and the whole description", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "set_text", agent: "Planner", field: "prompt", value: "Plan in three steps.\nThen stop.\n" }, { op: "set_text", agent: "Planner", field: "description", value: "Plans." }),
    );
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[0].promptSource = { type: "inline", content: "Plan in three steps.\nThen stop.\n" };
      d.agents[0].description = "Plans.";
    }));
    for (const comment of commentsOf(FIXTURE)) expect(result.text).toContain(comment);
  });

  it("gives an agent a description it had none of, as one line or as a block", () => {
    const one = applied(FIXTURE, edit("C1", { op: "set_text", agent: "Writer", field: "description", value: "Writes the answer." }));
    expect(agentOf(one.def, "Writer").description).toBe("Writes the answer.");
    const many = applied(FIXTURE, edit("C1", { op: "set_text", agent: "Writer", field: "description", value: "Writes.\nBriefly." }));
    expect(agentOf(many.def, "Writer").description).toBe("Writes.\nBriefly.");
    expect(many.text).toMatch(/description: \|-?\n {6}Writes\.\n {6}Briefly\./);
  });

  it("sets an empty prompt on a memory agent, and a text into an empty one", () => {
    const result = applied(FIXTURE, edit("C1", { op: "set_text", agent: "Notes", field: "prompt", value: "Keep the notes short." }));
    expect(agentOf(result.def, "Notes").promptSource).toEqual({ type: "inline", content: "Keep the notes short." });
  });

  it("writes text that a YAML writer must quote or escape, and reads it back whole", () => {
    const tricky = "key: value # not a comment\n- not a list\n\"quoted\" 'single' {braces} [brackets]\n  indented\ttab\ntrailing  ";
    const result = applied(FIXTURE, edit("C1", { op: "set_text", agent: "Writer", field: "prompt", value: tricky }, { op: "set_text", agent: "Writer", field: "description", value: "---" }));
    expect(agentOf(result.def, "Writer").promptSource).toEqual({ type: "inline", content: tricky });
    expect(agentOf(result.def, "Writer").description).toBe("---");
  });
});

describe("applyProposal: set and set_role", () => {
  it("sets maxTokens, maxSteps and timeoutSeconds, keeping the comment on the line", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "set", agent: "Planner", field: "maxTokens", value: 1500 }, { op: "set", agent: "Planner", field: "maxSteps", value: 6 }, { op: "set", agent: "Writer", field: "timeoutSeconds", value: 400 }),
    );
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[0].maxTokens = 1500;
      d.agents[0].maxSteps = 6;
      d.agents[1].timeoutSeconds = 400;
    }));
    expect(result.text).toContain("maxTokens: 1500 # the token limit");
  });

  it("sets thinkDepth where the agent has one, and adds it where it has none", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "set", agent: "Checker", field: "thinkDepth", value: "high" }, { op: "set", agent: "Planner", field: "thinkDepth", value: "none" }),
    );
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[2].thinkDepth = "high";
      d.agents[0].thinkDepth = "none";
    }));
  });

  it("sets thinkDepth twice in a row, the second time on the value the first one wrote", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "set", agent: "Planner", field: "thinkDepth", value: "low" }, { op: "set", agent: "Planner", field: "thinkDepth", value: "high" }),
    );
    expect(agentOf(result.def, "Planner").thinkDepth).toBe("high");
  });

  it("sets the role", () => {
    const result = applied(FIXTURE, edit("C1", { op: "set_role", agent: "Writer", value: AgentRole.Aggregator }));
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[1].role = AgentRole.Aggregator;
    }));
  });
});

describe("applyProposal: tools and memory keys", () => {
  it("adds a tool to a flow list and keeps it a flow list, with its comment", () => {
    const result = applied(FIXTURE, edit("C1", { op: "add_tool", agent: "Planner", tool: ToolPermission.Grep }));
    expect(result.text).toMatch(/tools: \[ ?read_file, grep ?\] # a flow list, with a comment/);
    expect(agentOf(result.def, "Planner").tools).toEqual(["read_file", "grep"]);
  });

  it("adds a tool to a block list and keeps it a block list", () => {
    const result = applied(FIXTURE, edit("C1", { op: "add_tool", agent: "Writer", tool: ToolPermission.ReadFile }));
    expect(result.text).toContain("    tools:\n      - list_files\n      - grep\n      - read_file\n");
    expect(agentOf(result.def, "Writer").tools).toEqual(["list_files", "grep", "read_file"]);
  });

  it("adds a tool to an empty list, and removes the last one from a list", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "add_tool", agent: "Checker", tool: ToolPermission.SubagentDispatch }, { op: "remove_tool", agent: "Planner", tool: ToolPermission.ReadFile }),
    );
    expect(agentOf(result.def, "Checker").tools).toEqual(["subagent_dispatch"]);
    expect(agentOf(result.def, "Planner").tools).toEqual([]);
    expect(result.text).toMatch(/tools: \[ ?subagent_dispatch ?\]/);
    expect(result.text).toMatch(/tools: \[\] # a flow list, with a comment/);
  });

  it("removes a tool from the middle of a block list, and can remove bash-like tools the agent has", () => {
    const result = applied(FIXTURE, edit("C1", { op: "remove_tool", agent: "Writer", tool: ToolPermission.ListFiles }));
    expect(agentOf(result.def, "Writer").tools).toEqual(["grep"]);
    const bash = applied(workflow([{ tools: ["bash", "grep"] }, {}], [[0, 1]]), edit("C1", { op: "remove_tool", agent: "Agent 0", tool: ToolPermission.Bash }));
    expect(agentOf(bash.def, "Agent 0").tools).toEqual(["grep"]);
  });

  it("adds and removes memory keys to read and to write", () => {
    const result = applied(
      FIXTURE,
      edit(
        "C1",
        { op: "add_memory_read", agent: "Planner", key: "notes" }, { op: "remove_memory_read", agent: "Writer", key: "plan" },
        { op: "add_memory_write", agent: "Writer", key: "draft" }, { op: "remove_memory_write", agent: "Checker", key: "verdict" },
      ),
    );
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents[0].memoryRead = ["notes"];
      d.agents[1].memoryRead = [];
      d.agents[1].memoryWrite = ["draft"];
      d.agents[2].memoryWrite = [];
    }));
    expect(result.text).toMatch(/memoryRead: \[ ?notes ?\]/);
    for (const comment of commentsOf(FIXTURE)) expect(result.text).toContain(comment);
  });
});

describe("applyProposal: add_agent", () => {
  it("adds an agent with the defaults, connects it in the same edit, and puts it to the right of the others", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "Check the facts." }, { op: "connect", from: "Checker", to: "Verifier" }),
    );
    expect(agentOf(result.def, "Verifier")).toEqual({
      name: "Verifier", role: "worker", model: "big-model", temperature: 0.5, maxTokens: 2048, maxSteps: 5, timeoutSeconds: 300,
      promptSource: { type: "inline", content: "Check the facts." }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    });
    expect(result.def.agents.map((a) => a.name)).toEqual(["Planner", "Writer", "Checker", "Notes", "Reporter", "Verifier"]);
    expect(result.def.nodePositions["agent-5"]).toEqual({ x: 1260, y: 120 });
    expect(result.def.connections[5]).toEqual({ id: "evolve-2-5", sourceAgentId: "agent-2", targetAgentId: "agent-5", edgeKind: "dataflow" });
    expect(result.def).toEqual(byHand(FIXTURE, (d) => {
      d.agents.push(agentOf(result.def, "Verifier"));
      d.nodePositions["agent-5"] = { x: 1260, y: 120 };
      d.connections.push(result.def.connections[5]);
    }));
    for (const comment of commentsOf(FIXTURE)) expect(result.text).toContain(comment);
  });

  it("writes the new agent like the ones there: flow lists as in the first agent, a blank line before it, a block prompt", () => {
    const result = applied(FIXTURE, edit("C1", { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "Line one.\nLine two.", tools: [ToolPermission.ReadFile], memoryWrite: ["out"] }, { op: "connect", from: "Checker", to: "V" }));
    expect(result.text).toMatch(/status: idle\n\n {2}- name: V\n/);
    expect(result.text).toMatch(/ {4}tools: \[ ?read_file ?\]\n {4}memoryRead: \[\]\n {4}memoryWrite: \[ ?out ?\]\n {4}tokens: \{ ?used: 0, budget: 0 ?\}\n {4}status: idle\n/);
    expect(result.text).toMatch(/content: \|-\n {8}Line one\.\n {8}Line two\./);
  });

  it("writes the new agent with block lists when the first agent has block lists", () => {
    const text = workflow([{ tools: ["grep"] }, {}], [[0, 1]]);
    const result = applied(text, edit("C1", { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "p", tools: [ToolPermission.ReadFile] }, { op: "connect", from: "Agent 1", to: "V" }));
    expect(result.text).toContain("    tools:\n      - read_file\n    memoryRead: []\n");
  });

  it("takes every optional field it is given", () => {
    const result = applied(
      FIXTURE,
      edit(
        "C1",
        {
          op: "add_agent", name: "Scribe", role: AgentRole.Memory, prompt: "", description: "Keeps notes.\nShort ones.", tools: [ToolPermission.FsAppend, ToolPermission.FsRead],
          memoryRead: ["plan"], memoryWrite: ["scribe-notes"], maxTokens: 0, maxSteps: 1, timeoutSeconds: 30, thinkDepth: "none",
        },
        { op: "connect", from: "Writer", to: "Scribe", kind: "memory", label: "notes out" },
      ),
    );
    expect(agentOf(result.def, "Scribe")).toEqual({
      name: "Scribe", role: "memory", model: "big-model", temperature: 0.5, maxTokens: 0, maxSteps: 1, timeoutSeconds: 30, description: "Keeps notes.\nShort ones.",
      promptSource: { type: "inline", content: "" }, tools: ["fs.append", "fs.read"], memoryRead: ["plan"], memoryWrite: ["scribe-notes"],
      tokens: { used: 0, budget: 0 }, status: "idle", thinkDepth: "none",
    });
    expect(result.def.connections[5]).toEqual({ id: "evolve-1-5", sourceAgentId: "agent-1", targetAgentId: "agent-5", edgeKind: "memory", label: "notes out" });
  });

  it("gives the model most agents use, the first agent's temperature, and counts an agent with no model for nothing", () => {
    const modelOf = (models: string[], extra: Array<Record<string, unknown>> = [], role: Exclude<AgentRole, AgentRole.Hook> = AgentRole.Worker) => {
      const agents = models.map((model, i) => ({ model, ...(extra[i] ?? {}) }));
      const edges: Array<[number, number]> = agents.slice(1).map((_, i) => [0, i + 1]);
      const result = applied(workflow(agents, edges), edit("C1", { op: "add_agent", name: "New", role, prompt: "p" }, { op: "connect", from: "Agent 0", to: "New" }));
      return agentOf(result.def, "New");
    };
    expect(modelOf(["m1", "m2", "m2"]).model).toBe("m2"); // the most common
    expect(modelOf(["m1", "m2"]).model).toBe("m1"); // a tie: the first agent's
    expect(modelOf(["m2", "m1", "m1", "m2"]).model).toBe("m2"); // a tie: the one that comes first
    expect(modelOf(["m3", "m1", "m1", "m2", "m2"]).model).toBe("m1"); // a tie that does not include the first agent: the first of them
    expect(modelOf(["", "", "m3"], [{ role: "memory" }, { role: "memory" }]).model).toBe("m3"); // memory agents have none
    expect(modelOf(["", ""], [{ role: "memory" }, { role: "memory" }], AgentRole.Memory).model).toBe(""); // nobody has one
    expect(modelOf(["m1"], [{ temperature: 1.25 }]).temperature).toBe(1.25);
  });

  it("puts the position at x 0 when there are no positions", () => {
    const text = workflow([{}, {}], [[0, 1]], false);
    const result = applied(text, edit("C1", { op: "add_agent", name: "New", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Agent 1", to: "New" }));
    expect(result.def.nodePositions).toEqual({ "agent-2": { x: 0, y: 120 } });
  });

  it("puts the position 260 to the right of the rightmost one, wherever it is", () => {
    const text = workflow([{}, {}, {}], [[0, 1], [1, 2]]).replace("agent-1:\n    x: 100", "agent-1:\n    x: 5000");
    const result = applied(text, edit("C1", { op: "add_agent", name: "New", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Agent 2", to: "New" }));
    expect(result.def.nodePositions["agent-3"]).toEqual({ x: 5260, y: 120 });
  });

  it("lets a later edit work on an agent that an earlier edit added", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Checker", to: "Verifier" }),
      edit("C2", { op: "set", agent: "Verifier", field: "maxTokens", value: 777 }, { op: "add_tool", agent: "Verifier", tool: ToolPermission.Grep }),
    );
    expect(agentOf(result.def, "Verifier")).toMatchObject({ maxTokens: 777, tools: ["grep"] });
  });
});

describe("applyProposal: names and ids", () => {
  it("adds an agent whose name a YAML writer must quote, and finds it by that name again", () => {
    const name = 'Verifier: "strict" # v2';
    const result = applied(
      FIXTURE,
      edit("C1", { op: "add_agent", name, role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Checker", to: name }),
      edit("C2", { op: "set", agent: name, field: "maxSteps", value: 8 }),
    );
    expect(agentOf(result.def, name)).toMatchObject({ name, maxSteps: 8 });
  });

  it("shifts ids of 10 and over correctly when an agent is removed", () => {
    const agents = Array.from({ length: 12 }, () => ({}));
    const chain: Array<[number, number]> = Array.from({ length: 11 }, (_, i) => [i, i + 1]);
    const text = workflow(agents, chain);
    const result = applied(text, edit("C1", { op: "remove_agent", agent: "Agent 3" }, { op: "connect", from: "Agent 2", to: "Agent 4" }));
    expect(result.def.agents.map((a) => a.name)).toEqual(["Agent 0", "Agent 1", "Agent 2", "Agent 4", "Agent 5", "Agent 6", "Agent 7", "Agent 8", "Agent 9", "Agent 10", "Agent 11"]);
    expect(edgesOf(result.def).sort()).toEqual(
      [...Array.from({ length: 11 }, (_, i) => i).filter((i) => i !== 2 && i !== 3).map((i) => `Agent ${i} → Agent ${i + 1} (dataflow)`), "Agent 2 → Agent 4 (dataflow)"].sort(),
    );
    expect(Object.keys(result.def.nodePositions)).toEqual(Array.from({ length: 11 }, (_, i) => `agent-${i}`));
    expect(result.def.nodePositions["agent-10"]).toEqual({ x: 1100, y: 50 }); // Agent 11
    expect(result.def.nodePositions["agent-3"]).toEqual({ x: 400, y: 50 }); // Agent 4
  });
});

describe("applyProposal: remove_agent", () => {
  const removeWriter = edit("C1", { op: "remove_agent", agent: "Writer" }, { op: "connect", from: "Planner", to: "Checker" });

  it("removes an agent in the middle with its edges, and the ids of the later agents shift down", () => {
    const result = applied(FIXTURE, removeWriter);
    expect(result.def.agents.map((a) => a.name)).toEqual(["Planner", "Checker", "Notes", "Reporter"]);
    expect(edgesOf(result.def).sort()).toEqual([
      "Checker → Notes (memory)", "Checker → Reporter (dataflow)", "Notes → Reporter (memory)", "Planner → Checker (dataflow)",
    ]);
    expect(result.def.nodePositions).toEqual({
      "agent-0": { x: 0, y: 100 }, "agent-1": { x: 500, y: 100 }, "agent-2": { x: 750, y: 100 }, "agent-3": { x: 1000, y: 100 },
    });
  });

  it("keeps an edge between two later agents joining the same two agents, with its id, kind and label", () => {
    const result = applied(FIXTURE, removeWriter);
    expect(result.def.connections.find((c) => c.id === "notes-to-report")).toEqual({
      id: "notes-to-report", sourceAgentId: "agent-2", targetAgentId: "agent-3", label: "notes", edgeKind: "memory",
    });
    expect(result.def.connections.find((c) => c.id === "check-to-report")).toEqual({
      id: "check-to-report", sourceAgentId: "agent-1", targetAgentId: "agent-3", edgeKind: "dataflow",
    });
    expect(result.def.connections.some((c) => c.id === "plan-to-write" || c.id === "write-to-check")).toBe(false);
  });

  it("keeps the comments of what is left, and drops the agent's own", () => {
    const result = applied(FIXTURE, removeWriter);
    expect(result.text).not.toContain("# agent-1: the writer");
    for (const comment of ["# Fixture workflow for the edit tests.", "# agent-0: the planner", "# agent-2: the checker", "# the checker also reports directly"]) {
      expect(result.text).toContain(comment);
    }
  });

  it("removes the first and the last agent as well", () => {
    const first = applied(FIXTURE, edit("C1", { op: "remove_agent", agent: "Planner" }));
    expect(first.def.agents.map((a) => a.name)).toEqual(["Writer", "Checker", "Notes", "Reporter"]);
    expect(edgesOf(first.def)).toEqual(["Writer → Checker (dataflow)", "Checker → Notes (memory)", "Notes → Reporter (memory)", "Checker → Reporter (dataflow)"]);
    expect(Object.keys(first.def.nodePositions)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3"]);
    const last = applied(FIXTURE, edit("C1", { op: "remove_agent", agent: "Reporter" }));
    expect(last.def.agents.map((a) => a.name)).toEqual(["Planner", "Writer", "Checker", "Notes"]);
    expect(edgesOf(last.def)).toEqual(["Planner → Writer (dataflow)", "Writer → Checker (dataflow)", "Checker → Notes (memory)"]);
    expect(Object.keys(last.def.nodePositions)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3"]);
  });

  it("removes an agent that an earlier edit added, and shifts ids twice", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "add_agent", name: "Temp", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Writer", to: "Temp" }),
      edit("C2", { op: "remove_agent", agent: "Writer" }, { op: "connect", from: "Planner", to: "Checker" }, { op: "connect", from: "Planner", to: "Temp" }),
      edit("C3", { op: "remove_agent", agent: "Planner" }, { op: "connect", from: "Checker", to: "Temp" }),
    );
    expect(result.def.agents.map((a) => a.name)).toEqual(["Checker", "Notes", "Reporter", "Temp"]);
    expect(edgesOf(result.def).sort()).toEqual([
      "Checker → Notes (memory)", "Checker → Reporter (dataflow)", "Checker → Temp (dataflow)", "Notes → Reporter (memory)",
    ]);
    expect(Object.keys(result.def.nodePositions)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3"]);
  });
});

describe("applyProposal: connect and disconnect", () => {
  it("connects with the default kind, and with a kind and a label", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "connect", from: "Planner", to: "Checker" }, { op: "connect", from: "Planner", to: "Reporter", kind: "control", label: "go" }),
    );
    expect(result.def.connections.slice(5)).toEqual([
      { id: "evolve-0-2", sourceAgentId: "agent-0", targetAgentId: "agent-2", edgeKind: "dataflow" },
      { id: "evolve-0-4", sourceAgentId: "agent-0", targetAgentId: "agent-4", edgeKind: "control", label: "go" },
    ]);
    expect(result.def.connections.slice(0, 5)).toEqual(load(FIXTURE).connections);
  });

  it("numbers an id that is taken", () => {
    const result = applied(
      FIXTURE,
      edit(
        "C1", { op: "connect", from: "Planner", to: "Checker" }, { op: "connect", from: "Planner", to: "Checker", kind: "memory" },
        { op: "connect", from: "Planner", to: "Checker", kind: "feedback" },
      ),
    );
    expect(result.def.connections.slice(5).map((c) => [c.id, c.edgeKind])).toEqual([
      ["evolve-0-2", "dataflow"], ["evolve-0-2-2", "memory"], ["evolve-0-2-3", "feedback"],
    ]);
  });

  it("connects in the other direction of an edge that exists, and with another kind of an edge that exists", () => {
    const result = applied(FIXTURE, edit("C1", { op: "connect", from: "Writer", to: "Planner", kind: "feedback" }, { op: "connect", from: "Writer", to: "Checker", kind: "memory" }));
    expect(edgesOf(result.def).slice(5)).toEqual(["Writer → Planner (feedback)", "Writer → Checker (memory)"]);
  });

  it("disconnects an edge, keeping the others, and can leave the agents connected through others", () => {
    const result = applied(FIXTURE, edit("C1", { op: "disconnect", from: "Checker", to: "Reporter" }));
    expect(result.def.connections.map((c) => c.id)).toEqual(["plan-to-write", "write-to-check", "check-to-notes", "notes-to-report"]);
  });

  it("disconnects every edge from one agent to the other, of every kind", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "connect", from: "Checker", to: "Reporter", kind: "memory" }, { op: "connect", from: "Checker", to: "Reporter", kind: "feedback" }),
      edit("C2", { op: "disconnect", from: "Checker", to: "Reporter" }),
    );
    expect(result.def.connections.map((c) => c.id)).toEqual(["plan-to-write", "write-to-check", "check-to-notes", "notes-to-report"]);
  });

  it("disconnects an edge that an earlier op of the edit connected", () => {
    const result = applied(FIXTURE, edit("C1", { op: "connect", from: "Planner", to: "Reporter" }, { op: "disconnect", from: "Planner", to: "Reporter" }, { op: "set", agent: "Planner", field: "maxSteps", value: 9 }));
    expect(result.def.connections).toEqual(load(FIXTURE).connections);
  });
});

describe("applyProposal: the example workflow", () => {
  const edits = [
    edit(
      "C1",
      { op: "replace_text", agent: "Critic", field: "prompt", old: "4. Issue a verdict.", new: "4. Issue a verdict, and say which analyst you trust more." },
      { op: "add_tool", agent: "Pro Analyst", tool: ToolPermission.Grep },
      { op: "set", agent: "Final Check", field: "maxTokens", value: 3000 },
      { op: "replace_text", agent: "Final Check", field: "description", old: "produces the final Markdown report", new: "writes the final Markdown report" },
    ),
    edit(
      "C2",
      { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "Check the report against the notes.\nBe strict.", tools: [ToolPermission.ReadFile] },
      { op: "connect", from: "Final Check", to: "Verifier", label: "report" },
      { op: "add_memory_read", agent: "Verifier", key: "final-report" },
    ),
  ];

  it("keeps every comment, and changes exactly what the edits say", () => {
    const result = applied(EXAMPLE, ...edits);
    for (const comment of commentsOf(EXAMPLE)) expect(result.text).toContain(comment);
    const before = load(EXAMPLE);
    expect(result.def.agents.slice(0, 6).map((a) => a.name)).toEqual(before.agents.map((a) => a.name));
    const after = result.def;
    expect(agentOf(after, "Critic").promptSource).toEqual({
      type: "inline", content: (agentOf(before, "Critic").promptSource as { content: string }).content.replace("4. Issue a verdict.", "4. Issue a verdict, and say which analyst you trust more."),
    });
    expect(agentOf(after, "Pro Analyst").tools).toEqual(["read_file", "list_files", "grep"]);
    expect(agentOf(after, "Final Check")).toMatchObject({ maxTokens: 3000, description: "Reads all findings from memory and upstream chain, writes the final Markdown report." });
    expect(agentOf(after, "Verifier")).toMatchObject({ model: "qwen2.5-coder:7b", temperature: 0.6, tools: ["read_file"], memoryRead: ["final-report"] });
    expect(after.nodePositions["agent-6"]).toEqual({ x: 1360, y: 120 });
    expect(after.connections).toEqual([...before.connections, { id: "evolve-5-6", sourceAgentId: "agent-5", targetAgentId: "agent-6", edgeKind: "dataflow", label: "report" }]);
    expect(after.meta).toEqual(before.meta);
    expect(after.executionSettings).toEqual(before.executionSettings);
  });

  it("edits a description that the example writes as a folded block", () => {
    const result = applied(EXAMPLE, edit("C1", { op: "replace_text", agent: "Findings Log", field: "description", old: "and persists them", new: "and keeps them" }));
    expect(agentOf(result.def, "Findings Log").description).toBe(
      "Aggregates all upstream outputs (Pro analysis, Con analysis, Critic verdict) and keeps them for the Final Check agent.\n",
    );
    for (const comment of commentsOf(EXAMPLE)) expect(result.text).toContain(comment);
  });

  it("removes an agent of the example and moves the rest, and the comments of what stays are kept", () => {
    const result = applied(
      EXAMPLE,
      edit("C1", { op: "remove_agent", agent: "Findings Log" }, { op: "connect", from: "Critic", to: "Final Check", kind: "memory", label: "verdict" }),
    );
    expect(result.def.agents.map((a) => a.name)).toEqual(["Orchestrator", "Pro Analyst", "Con Analyst", "Critic", "Final Check"]);
    expect(edgesOf(result.def)).toEqual([
      "Orchestrator → Pro Analyst (dataflow)", "Orchestrator → Con Analyst (dataflow)", "Pro Analyst → Critic (dataflow)",
      "Con Analyst → Critic (dataflow)", "Critic → Final Check (memory)",
    ]);
    expect(Object.keys(result.def.nodePositions)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(result.def.nodePositions["agent-4"]).toEqual({ x: 1100, y: 240 });
    for (const comment of ["# Pattern: Orchestrator → parallel Workers → Critic → Memory → Final Check", "# ── agent-3: Critic ──────────────────────────────────────────────────────────"]) {
      expect(result.text).toContain(comment);
    }
  });
});

// ── applying: errors ──────────────────────────────────────────────────────────

describe("applyProposal: an operation that cannot be applied", () => {
  const agents = '"Planner", "Writer", "Checker", "Notes", "Reporter"';
  const cases: Array<[string, EditOp, string]> = [
    ["an unknown agent (replace_text)", { op: "replace_text", agent: "Nobody", field: "prompt", old: "x", new: "y" }, `no agent is named "Nobody"; the agents are: ${agents}`],
    ["an unknown agent (set_text)", { op: "set_text", agent: "planner", field: "prompt", value: "y" }, `no agent is named "planner"; the agents are: ${agents}`],
    ["an unknown agent (set)", { op: "set", agent: "Nobody", field: "maxSteps", value: 2 }, 'no agent is named "Nobody"'],
    ["an unknown agent (set_role)", { op: "set_role", agent: "Nobody", value: AgentRole.Critic }, 'no agent is named "Nobody"'],
    ["an unknown agent (add_tool)", { op: "add_tool", agent: "Nobody", tool: ToolPermission.Grep }, 'no agent is named "Nobody"'],
    ["an unknown agent (remove_memory_write)", { op: "remove_memory_write", agent: "Nobody", key: "k" }, 'no agent is named "Nobody"'],
    ["an unknown agent (remove_agent)", { op: "remove_agent", agent: "Nobody" }, 'no agent is named "Nobody"'],
    ["an unknown agent in from", { op: "connect", from: "Nobody", to: "Writer" }, 'no agent is named "Nobody" (in `from`)'],
    ["an unknown agent in to", { op: "connect", from: "Writer", to: "Nobody" }, 'no agent is named "Nobody" (in `to`)'],
    ["an unknown agent in disconnect", { op: "disconnect", from: "Writer", to: "Nobody" }, 'no agent is named "Nobody" (in `to`)'],
    ["old that is not there", { op: "replace_text", agent: "Planner", field: "prompt", old: "Be very brief.", new: "y" }, '`old` ("Be very brief.") was not found in the prompt of agent "Planner"; copy it exactly'],
    ["old that is not in the description", { op: "replace_text", agent: "Planner", field: "description", old: "Plans the fork", new: "y" }, "was not found in the description of agent \"Planner\""],
    ["old for a description that is missing", { op: "replace_text", agent: "Writer", field: "description", old: "x", new: "y" }, 'was not found in the description of agent "Writer"'],
    ["old that occurs twice", { op: "replace_text", agent: "Planner", field: "prompt", old: "it", new: "y" }, '`old` ("it") occurs 2 times in the prompt of agent "Planner"; add more of the text around it'],
    ["old that occurs three times", { op: "replace_text", agent: "Planner", field: "prompt", old: ".", new: "!" }, "occurs 3 times"],
    ["new equal to old", { op: "replace_text", agent: "Planner", field: "prompt", old: "Be brief.", new: "Be brief." }, "`new` is the same as `old`"],
    ["a set_text with the same text", { op: "set_text", agent: "Writer", field: "prompt", value: "Write the answer." }, 'the prompt of agent "Writer" already has this text'],
    ["a set_text of the same description", { op: "set_text", agent: "Planner", field: "description", value: "Plans the work." }, 'the description of agent "Planner" already has this text'],
    ["a set_text of an empty description to an agent with none", { op: "set_text", agent: "Writer", field: "description", value: "" }, 'the description of agent "Writer" already has this text'],
    ["a file prompt (replace_text)", { op: "replace_text", agent: "Reporter", field: "prompt", old: "x", new: "y" }, 'agent "Reporter" reads its prompt from the file prompts/report.md; only an inline prompt (promptSource type inline) can be edited'],
    ["a file prompt (set_text)", { op: "set_text", agent: "Reporter", field: "prompt", value: "y" }, "reads its prompt from the file prompts/report.md"],
    ["set to the value it has", { op: "set", agent: "Planner", field: "maxTokens", value: 1000 }, 'agent "Planner" already has maxTokens 1000'],
    ["set of thinkDepth to the value it has", { op: "set", agent: "Checker", field: "thinkDepth", value: "low" }, 'agent "Checker" already has thinkDepth low'],
    ["set_role to the role it has", { op: "set_role", agent: "Writer", value: AgentRole.Worker }, 'agent "Writer" already has the role worker'],
    ["a tool it has (flow list)", { op: "add_tool", agent: "Planner", tool: ToolPermission.ReadFile }, 'agent "Planner" already has "read_file" in tools'],
    ["a tool it has (block list)", { op: "add_tool", agent: "Writer", tool: ToolPermission.Grep }, 'agent "Writer" already has "grep" in tools'],
    ["a tool it does not have", { op: "remove_tool", agent: "Writer", tool: ToolPermission.Bash }, 'agent "Writer" does not have "bash" in tools (it has: list_files, grep)'],
    ["a tool from an empty list", { op: "remove_tool", agent: "Checker", tool: ToolPermission.Grep }, "(it has: nothing)"],
    ["a memory key to read it has", { op: "add_memory_read", agent: "Writer", key: "plan" }, 'agent "Writer" already has "plan" in memoryRead'],
    ["a memory key to read it lacks", { op: "remove_memory_read", agent: "Writer", key: "verdict" }, 'agent "Writer" does not have "verdict" in memoryRead (it has: plan)'],
    ["a memory key to write it has", { op: "add_memory_write", agent: "Planner", key: "plan" }, 'agent "Planner" already has "plan" in memoryWrite'],
    ["a memory key to write it lacks", { op: "remove_memory_write", agent: "Planner", key: "other" }, 'agent "Planner" does not have "other" in memoryWrite (it has: plan)'],
    ["an agent whose name is taken", { op: "add_agent", name: "Writer", role: AgentRole.Worker, prompt: "p" }, 'an agent named "Writer" already exists; give the new agent a name that no agent has'],
    ["an edge that exists", { op: "connect", from: "Planner", to: "Writer" }, "the edge Planner → Writer (dataflow) already exists, so the edit changes nothing"],
    ["an edge of a kind that exists", { op: "connect", from: "Checker", to: "Notes", kind: "memory" }, "the edge Checker → Notes (memory) already exists"],
    ["an edge from an agent to itself", { op: "connect", from: "Writer", to: "Writer" }, "`from` and `to` are both agent \"Writer\"; an agent cannot be connected to itself"],
    ["a disconnect with no edge", { op: "disconnect", from: "Planner", to: "Checker" }, 'there is no edge from "Planner" to "Checker"; the edges from "Planner" go to: Writer'],
    ["a disconnect from an agent with no edge out", { op: "disconnect", from: "Reporter", to: "Planner" }, '"Reporter" has no edge going out'],
    ["a disconnect in the wrong direction", { op: "disconnect", from: "Writer", to: "Planner" }, 'the edges from "Writer" go to: Checker'],
  ];

  it.each(cases)("%s", (_name, op, reason) => {
    const errors = errorsOf(FIXTURE, [edit("C1", op)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`edit C1, op 1 (${op.op}): `)).toBe(true);
    expect(errors[0]).toContain(reason);
  });

  it("counts an old that overlaps itself as more than one place", () => {
    const text = workflow([{ promptSource: { type: "inline", content: "aaa" } }], []);
    expect(errorsOf(text, [edit("C1", { op: "replace_text", agent: "Agent 0", field: "prompt", old: "aa", new: "b" })])[0]).toContain("occurs 2 times");
  });

  it("cannot remove an agent the task set protects, and says why", () => {
    const reason = "scorer names-the-winner of task laptop names it (node:)";
    expect(errorsOf(FIXTURE, [edit("C1", { op: "remove_agent", agent: "Checker" })], { Checker: reason })).toEqual([
      `edit C1, op 1 (remove_agent): agent "Checker" cannot be removed: ${reason}`,
    ]);
  });

  it("removes an agent that is not protected, though others are", () => {
    const result = applyProposal(FIXTURE, { edits: [edit("C1", { op: "remove_agent", agent: "Notes" })] }, ctx({ Checker: "named by a scorer" }));
    expect("text" in result).toBe(true);
  });

  it("cannot remove the only agent", () => {
    const text = workflow([{}], []);
    expect(errorsOf(text, [edit("C1", { op: "remove_agent", agent: "Agent 0" })])).toEqual([
      'edit C1, op 1 (remove_agent): agent "Agent 0" is the only agent, and a workflow needs at least one',
    ]);
  });

  it("cannot remove the second-to-last agent and then the last", () => {
    const text = workflow([{}, {}], [[0, 1]]);
    expect(errorsOf(text, [edit("C1", { op: "remove_agent", agent: "Agent 0" }, { op: "remove_agent", agent: "Agent 1" })])).toEqual([
      'edit C1, op 2 (remove_agent): agent "Agent 1" is the only agent, and a workflow needs at least one',
    ]);
  });

  it("names the edit, the number of the operation (from 1) and its name", () => {
    const errors = errorsOf(FIXTURE, [edit("C7", { op: "set", agent: "Planner", field: "maxSteps", value: 9 }, { op: "add_tool", agent: "Writer", tool: ToolPermission.Grep })]);
    expect(errors).toEqual(['edit C7, op 2 (add_tool): agent "Writer" already has "grep" in tools, so the edit changes nothing']);
  });
});

describe("applyProposal: the edited workflow must load as harness eval loads it", () => {
  const addVerifier = (prompt = "Check it."): EditOp => ({ op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt });

  it("reports an agent that is added and not connected, and says how to fix it", () => {
    expect(errorsOf(FIXTURE, [edit("C1", addVerifier())])).toEqual([
      'the edited workflow is invalid: "Verifier" is not connected to any other node. Every agent needs an edge: add a connect op for it, in the same edit as the change that left it alone.',
    ]);
  });

  it("reports an agent that a removal leaves alone", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", { op: "remove_agent", agent: "Writer" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"Planner" is not connected to any other node.');
  });

  it("reports every agent that is left alone", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", addVerifier(), { op: "add_agent", name: "Other", role: AgentRole.Worker, prompt: "p" })]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"Verifier" is not connected');
    expect(errors[1]).toContain('"Other" is not connected');
  });

  it("reports a cycle, and says what a loop must be", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", { op: "connect", from: "Checker", to: "Planner" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Workflow contains a cycle (non-feedback loop).");
    expect(errors[0]).toContain('kind "feedback"');
  });

  it("accepts a loop that is a feedback edge", () => {
    expect("text" in applyProposal(FIXTURE, { edits: [edit("C1", { op: "connect", from: "Checker", to: "Planner", kind: "feedback" })] }, ctx())).toBe(true);
  });

  it("reports a prompt that is empty on an agent that needs one", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", addVerifier(""), { op: "connect", from: "Checker", to: "Verifier" })]);
    expect(errors).toEqual(['the edited workflow is invalid: "Verifier" has no system prompt. Give it a non-empty prompt.']);
  });

  it("reports a prompt that was emptied", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", { op: "set_text", agent: "Writer", field: "prompt", value: "  \n" })]);
    expect(errors).toEqual(['the edited workflow is invalid: "Writer" has no system prompt. Give it a non-empty prompt.']);
  });

  it("reports a connection that names an agent that does not exist", () => {
    const broken = FIXTURE.replace("targetAgentId: agent-4\n    label: notes", "targetAgentId: agent-9\n    label: notes");
    const errors = errorsOf(broken, [edit("C1", { op: "set", agent: "Planner", field: "maxSteps", value: 9 })]);
    expect(errors).toContain("the edited workflow is invalid: connection notes-to-report has target agent-9, which is not one of its 5 agents (agent-0 to agent-4)");
  });

  it("reports a protected agent that is not in the workflow", () => {
    const errors = errorsOf(FIXTURE, [edit("C1", { op: "set", agent: "Planner", field: "maxSteps", value: 9 })], { Ghost: "a scorer names it" });
    expect(errors).toEqual(['the edited workflow is invalid: agent "Ghost" must still exist exactly once (a scorer names it), and it is gone']);
  });

  it("is checked once, after every edit, so a later edit can mend what an earlier one left", () => {
    const result = applyProposal(FIXTURE, {
      edits: [edit("C1", addVerifier()), edit("C2", { op: "connect", from: "Checker", to: "Verifier" })],
    }, ctx());
    expect("text" in result).toBe(true);
  });
});

describe("applyProposal: the incumbent", () => {
  const proposal = { edits: [edit("C1", { op: "set", agent: "Planner", field: "maxSteps", value: 9 })] };

  it("refuses text that is not YAML", () => {
    const result = applyProposal("agents: [unclosed\n  - a: b: c", proposal, ctx());
    expect("errors" in result && result.errors).toHaveLength(1);
    expect("errors" in result && result.errors[0]).toMatch(/^the incumbent workflow is not valid YAML: /);
  });

  it("refuses a file that is not a workflow, naming the path", () => {
    const result = applyProposal(FIXTURE.replace("maxTokens: 1500", "maxTokens: lots"), proposal, ctx());
    expect("errors" in result && result.errors).toEqual(['the incumbent workflow is not valid: agents.2.maxTokens: Invalid input: expected number, received string']);
    const notAWorkflow = applyProposal("hello: world\n", proposal, ctx());
    expect("errors" in notAWorkflow && notAWorkflow.errors[0]).toMatch(/^the incumbent workflow is not valid: meta: /);
  });

  it("refuses a file with no agents", () => {
    const result = applyProposal(workflow([], []), proposal, ctx());
    expect(result).toEqual({ errors: ["the incumbent workflow has no agents, so there is nothing to edit"] });
  });

  it("refuses agents with the same name, naming both", () => {
    const result = applyProposal(FIXTURE.replace("name: Checker", "name: Writer"), proposal, ctx());
    expect(result).toEqual({
      errors: ['the incumbent workflow has two agents named "Writer" (agents[1] and agents[2]); edits name agents, so the names must be unique'],
    });
  });

  it("does not read a proposal's operations when the incumbent is invalid", () => {
    const result = applyProposal(FIXTURE.replace("name: Checker", "name: Writer"), { edits: [edit("C1", { op: "remove_agent", agent: "Nobody" })] }, ctx());
    expect("errors" in result && result.errors[0]).toContain("the incumbent workflow");
  });
});

describe("applyProposal: several edits", () => {
  const good = edit("C1", { op: "set", agent: "Planner", field: "maxSteps", value: 9 });
  const fails = (id: string) => edit(id, { op: "set", agent: "Writer", field: "maxSteps", value: 2 }, { op: "set", agent: "Nobody", field: "maxSteps", value: 2 }, { op: "add_tool", agent: "Nobody", tool: ToolPermission.Grep });

  it("gives only the error list when one edit fails, and only the first error of that edit", () => {
    expect(errorsOf(FIXTURE, [good, fails("C2")])).toEqual([
      `edit C2, op 2 (set): no agent is named "Nobody"; the agents are: "Planner", "Writer", "Checker", "Notes", "Reporter"`,
    ]);
  });

  it("gives the first error of every edit that fails", () => {
    const errors = errorsOf(FIXTURE, [fails("C1"), { ...good, id: "C2" }, fails("C3")]);
    expect(errors.map((e) => e.slice(0, 22))).toEqual(["edit C1, op 2 (set): n", "edit C3, op 2 (set): n"]);
  });

  it("tries the next edit on the state before a failing one, whose changes are dropped", () => {
    // C1 adds Verifier and then fails; C2 adds an agent of the same name, which only works if C1's agent is gone.
    const withVerifier = (id: string, ...rest: EditOp[]) => edit(id, { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "p" }, ...rest);
    const result = applyProposal(FIXTURE, {
      edits: [
        withVerifier("C1", { op: "remove_agent", agent: "Nobody" }),
        withVerifier("C2", { op: "connect", from: "Checker", to: "Verifier" }),
      ],
    }, ctx());
    expect(result).toEqual({ errors: [`edit C1, op 2 (remove_agent): no agent is named "Nobody"; the agents are: "Planner", "Writer", "Checker", "Notes", "Reporter", "Verifier"`] });
  });

  it("applies the edits in order, each on the result of the one before", () => {
    const result = applied(
      FIXTURE,
      edit("C1", { op: "set", agent: "Planner", field: "maxSteps", value: 9 }),
      edit("C2", { op: "replace_text", agent: "Planner", field: "prompt", old: "Be brief.", new: "Be brief!" }),
      edit("C3", { op: "replace_text", agent: "Planner", field: "prompt", old: "Be brief!", new: "Be brief?" }),
    );
    expect(agentOf(result.def, "Planner")).toMatchObject({ maxSteps: 9, promptSource: { type: "inline", content: "You plan the work.\nSplit it into steps.\nBe brief?\n" } });
  });

  it("fails an edit that needs what a failed edit would have added, since the failed edit is dropped whole", () => {
    const errors = errorsOf(FIXTURE, [
      edit("C1", { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "p" }, { op: "remove_agent", agent: "Nobody" }),
      edit("C2", { op: "set", agent: "Verifier", field: "maxSteps", value: 2 }),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0].startsWith('edit C1, op 2 (remove_agent): no agent is named "Nobody"')).toBe(true);
    expect(errors[1].startsWith('edit C2, op 1 (set): no agent is named "Verifier"')).toBe(true);
  });

  it("returns an error, and does not throw, for a proposal with no edits or an edit with no operations", () => {
    expect(applyProposal(FIXTURE, { edits: [] }, ctx())).toEqual({ errors: ["the proposal has no edits; it needs at least one"] });
    expect(errorsOf(FIXTURE, [{ id: "C1", component: "prompt", hypothesis: "h", ops: [] }, good])).toEqual(["edit C1 has no operations; give it at least one"]);
  });

  it("returns the classified edits with the text", () => {
    const result = applied(FIXTURE, good, edit("C2", { op: "add_tool", agent: "Writer", tool: ToolPermission.ReadFile }));
    expect(result.edits.map((e) => [e.id, e.component, e.declared, e.retagged])).toEqual([["C1", "config", "prompt", true], ["C2", "client_tool", "prompt", true]]);
  });

  it("does not change the incumbent text it was given, or the proposal", () => {
    const proposal: Proposal = { edits: [good, edit("C2", { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Writer", to: "V" })] };
    const copy = JSON.parse(JSON.stringify(proposal));
    const text = `${FIXTURE}`;
    applyProposal(text, proposal, ctx());
    expect(text).toBe(FIXTURE);
    expect(proposal).toEqual(copy);
  });

  it("gives the same result when it is run again", () => {
    const proposal: Proposal = { edits: [good, edit("C2", { op: "remove_agent", agent: "Writer" }, { op: "connect", from: "Planner", to: "Checker" })] };
    expect(applyProposal(FIXTURE, proposal, ctx())).toEqual(applyProposal(FIXTURE, proposal, ctx()));
  });
});

// ── the checks for the loop ───────────────────────────────────────────────────

describe("checkBudget", () => {
  const edits = (n: number): Proposal => ({ edits: Array.from({ length: n }, (_, i) => edit(`C${i + 1}`, { op: "remove_agent", agent: "A" })) });

  it("is undefined within the budget, and at it", () => {
    expect(checkBudget(edits(1), 1)).toBeUndefined();
    expect(checkBudget(edits(2), 4)).toBeUndefined();
    expect(checkBudget(edits(4), 4)).toBeUndefined();
  });

  it("says how many edits exceed which budget", () => {
    expect(checkBudget(edits(3), 2)).toBe("3 edits exceed the budget b_t = 2");
    expect(checkBudget(edits(5), 1)).toBe("5 edits exceed the budget b_t = 1");
  });
});

describe("checkReservedSlot", () => {
  const edits = (...components: string[]) => components.map((component, i) => ({ id: `C${i + 1}`, component }));

  it("is undefined when nothing is untried", () => {
    expect(checkReservedSlot(edits("prompt"), [])).toBeUndefined();
  });

  it("is undefined when some edit is on an untried component", () => {
    expect(checkReservedSlot(edits("prompt", "subagent"), ["config", "subagent"])).toBeUndefined();
    expect(checkReservedSlot(edits("config"), ["config"])).toBeUndefined();
  });

  it("says that the slot is reserved, which components are untried, and what the edits are on", () => {
    expect(checkReservedSlot(edits("prompt", "control_flow"), ["config", "subagent"])).toBe(
      'this variant holds a reserved exploration slot: at least one edit must be on a never-exercised component from ["config","subagent"] ' +
      "(judged by its operations), and none is. The edits are on: C1 = prompt, C2 = control_flow.",
    );
  });

  it("judges by the classified component, not the declared one", () => {
    const proposal: Proposal = { edits: [{ id: "C1", component: "subagent", hypothesis: "h", ops: [{ op: "replace_text", agent: "A", field: "prompt", old: "x", new: "y" }] }] };
    expect(checkReservedSlot(classify(proposal), ["subagent"])).toContain("C1 = prompt");
  });
});

// ── showing a change ──────────────────────────────────────────────────────────

describe("renderChange", () => {
  const proposal: Proposal = {
    edits: [
      {
        id: "C1", component: "prompt", hypothesis: "Name the risks.\nThe checker skips them.", ops: [
          { op: "replace_text", agent: "Planner", field: "prompt", old: "Be brief.", new: "Be brief.\nName the risks." },
          { op: "add_tool", agent: "Writer", tool: ToolPermission.ReadFile },
          { op: "remove_tool", agent: "Writer", tool: ToolPermission.Grep },
        ],
      },
      {
        id: "C2", component: "subagent", hypothesis: "A verifier", ops: [
          { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "Check the facts.\nCite sources.", tools: [ToolPermission.ReadFile] },
          { op: "connect", from: "Checker", to: "Verifier" },
          { op: "add_memory_read", agent: "Checker", key: "notes-key" },
          { op: "remove_memory_write", agent: "Checker", key: "verdict" },
          { op: "set", agent: "Checker", field: "maxTokens", value: 3000 },
          { op: "set", agent: "Planner", field: "thinkDepth", value: "high" },
          { op: "set_role", agent: "Writer", value: AgentRole.Aggregator },
        ],
      },
      {
        id: "C3", component: "subagent", hypothesis: "Drop the notes", ops: [
          { op: "remove_agent", agent: "Notes" },
          { op: "set_text", agent: "Writer", field: "description", value: "Writes." },
          { op: "disconnect", from: "Checker", to: "Reporter" },
          { op: "add_memory_write", agent: "Writer", key: "draft" },
          { op: "connect", from: "Writer", to: "Reporter", kind: "feedback", label: "late" },
        ],
      },
    ],
  };

  it("shows each edit with its header and one line or block per operation", () => {
    expect(renderChange(FIXTURE, classify(proposal))).toBe([
      "C1 [client_tool] (declared prompt) — Name the risks. The checker skips them.",
      "  Planner · prompt: replace",
      "    - Be brief.",
      "    + Be brief.",
      "    + Name the risks.",
      "  Writer · tools: + read_file",
      "  Writer · tools: − grep",
      "",
      "C2 [subagent] — A verifier",
      '  + agent "Verifier" (worker), tools [read_file]',
      "      Check the facts.",
      "      Cite sources.",
      "  edge: + Checker → Verifier (dataflow)",
      "  Checker · memoryRead: + notes-key",
      "  Checker · memoryWrite: − verdict",
      "  Checker · maxTokens: 1500 → 3000",
      "  Planner · thinkDepth: (not set) → high",
      "  Writer · role: worker → aggregator",
      "",
      "C3 [subagent] — Drop the notes",
      '  − agent "Notes"',
      "  Writer · description: set",
      "    @@ -0,0 +1,1 @@",
      "    +Writes.",
      "  edge: − Checker → Reporter (dataflow)",
      "  Writer · memoryWrite: + draft",
      '  edge: + Writer → Reporter (feedback, "late")',
    ].join("\n"));
  });

  it("shows the declared component only for an edit that was re-tagged", () => {
    const text = renderChange(FIXTURE, classify(proposal));
    expect(text).toContain("C1 [client_tool] (declared prompt) — ");
    expect(text).toContain("C2 [subagent] — A verifier");
    expect(text).not.toContain("(declared subagent)");
  });

  it("shows the old value of a setting as the operations reach it", () => {
    const twice: Proposal = { edits: [
      { id: "C1", component: "config", hypothesis: "h", ops: [{ op: "set", agent: "Planner", field: "maxSteps", value: 5 }] },
      { id: "C2", component: "config", hypothesis: "h", ops: [{ op: "set", agent: "Planner", field: "maxSteps", value: 8 }, { op: "set", agent: "Planner", field: "maxSteps", value: 2 }] },
    ] };
    const lines = renderChange(FIXTURE, classify(twice)).split("\n").filter((l) => l.includes("maxSteps"));
    expect(lines).toEqual(["  Planner · maxSteps: 3 → 5", "  Planner · maxSteps: 5 → 8", "  Planner · maxSteps: 8 → 2"]);
  });

  it("shows an agent that an earlier edit added", () => {
    const chained: Proposal = { edits: [
      edit("C1", { op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "p" }, { op: "connect", from: "Checker", to: "Verifier" }),
      edit("C2", { op: "set", agent: "Verifier", field: "maxTokens", value: 99 }),
    ] };
    expect(renderChange(FIXTURE, classify(chained))).toContain("  Verifier · maxTokens: 2048 → 99");
  });

  it("shows the text of a replacement that removes or adds whole lines", () => {
    const lines = renderChange(FIXTURE, classify({ edits: [
      edit("C1", { op: "replace_text", agent: "Planner", field: "prompt", old: "Split it into steps.\n", new: "" }, { op: "replace_text", agent: "Planner", field: "description", old: "Plans", new: "Plans\nand splits" }),
    ] })).split("\n");
    expect(lines).toEqual([
      "C1 [prompt] — why C1",
      "  Planner · prompt: replace",
      "    - Split it into steps.",
      "    - ", // the line break that goes with it
      "  Planner · description: replace",
      "    - Plans",
      "    + Plans",
      "    + and splits",
    ]);
  });

  it("shows the description and the other settings of an added agent", () => {
    const lines = renderChange(FIXTURE, classify({ edits: [
      edit("C1", {
        op: "add_agent", name: "Scribe", role: AgentRole.Memory, prompt: "", description: "Keeps notes.", memoryRead: ["a"], memoryWrite: ["b", "c"],
        maxTokens: 10, maxSteps: 2, timeoutSeconds: 30, thinkDepth: "low",
      }),
    ] })).split("\n");
    expect(lines).toEqual([
      "C1 [subagent] (declared prompt) — why C1",
      '  + agent "Scribe" (memory), tools [], memoryRead [a], memoryWrite [b, c], maxTokens 10, maxSteps 2, timeoutSeconds 30, thinkDepth low',
      "    description: Keeps notes.",
    ]);
  });

  it("keeps a description and a label of several lines on one line", () => {
    const lines = renderChange(FIXTURE, classify({ edits: [
      edit(
        "C1", { op: "add_agent", name: "Scribe", role: AgentRole.Worker, prompt: "p", description: "Keeps notes.\n  Short ones." },
        { op: "connect", from: "Checker", to: "Scribe", label: 'two\nlines "quoted"' },
      ),
    ] })).split("\n");
    expect(lines).toEqual([
      "C1 [subagent] (declared prompt) — why C1",
      '  + agent "Scribe" (worker), tools []',
      "    description: Keeps notes. Short ones.",
      "      p",
      '  edge: + Checker → Scribe (dataflow, "two\\nlines \\"quoted\\"")',
    ]);
  });

  it("shows every edge that a disconnect removes", () => {
    const lines = renderChange(FIXTURE, classify({ edits: [
      edit("C1", { op: "connect", from: "Writer", to: "Checker", kind: "memory" }, { op: "disconnect", from: "Writer", to: "Checker" }),
    ] })).split("\n");
    expect(lines.slice(2)).toEqual(["  edge: − Writer → Checker (dataflow)", "  edge: − Writer → Checker (memory)"]);
  });

  it("gives nothing for no edits", () => {
    expect(renderChange(FIXTURE, [])).toBe("");
  });

  it("refuses edits that do not apply to the workflow it is given", () => {
    expect(() => renderChange(FIXTURE, classify({ edits: [edit("C4", { op: "remove_agent", agent: "Nobody" })] }))).toThrow(
      'renderChange: edit C4, op 1 (remove_agent) does not apply to this workflow: no agent is named "Nobody"',
    );
  });

  it("shows what applyProposal applied", () => {
    const result = applyProposal(EXAMPLE, { edits: [edit("C1", { op: "remove_agent", agent: "Findings Log" }, { op: "connect", from: "Pro Analyst", to: "Final Check" })] }, ctx());
    if (!("edits" in result)) throw new Error(result.errors.join("\n"));
    expect(renderChange(EXAMPLE, result.edits)).toBe([
      "C1 [subagent] (declared prompt) — why C1",
      '  − agent "Findings Log"',
      "  edge: + Pro Analyst → Final Check (dataflow)",
    ].join("\n"));
  });
});

describe("renderChange: set_text shows the line diff", () => {
  it("shows the old and the new text of a prompt as hunks", () => {
    const value = "You plan the work.\nSplit it into small steps.\nBe brief.\n";
    const lines = renderChange(FIXTURE, classify({ edits: [edit("C1", { op: "set_text", agent: "Planner", field: "prompt", value })] })).split("\n");
    expect(lines).toEqual([
      "C1 [prompt] — why C1",
      "  Planner · prompt: set",
      "    @@ -1,3 +1,3 @@",
      "     You plan the work.",
      "    -Split it into steps.",
      "    +Split it into small steps.",
      "     Be brief.",
    ]);
  });
});

// ── the line diff ─────────────────────────────────────────────────────────────

const numbered = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("lineDiff", () => {
  it("gives nothing for equal texts", () => {
    expect(lineDiff("", "")).toBe("");
    expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(lineDiff(FIXTURE, FIXTURE)).toBe("");
  });

  it("gives one hunk with 3 lines of context for one change", () => {
    expect(lineDiff(numbered(10), numbered(10, { 5: "five" }))).toBe([
      "@@ -2,7 +2,7 @@", " line 2", " line 3", " line 4", "-line 5", "+five", " line 6", " line 7", " line 8",
    ].join("\n"));
  });

  it("cuts the context at the start and the end of the text", () => {
    expect(lineDiff(numbered(4), numbered(4, { 1: "one" }))).toBe(["@@ -1,4 +1,4 @@", "-line 1", "+one", " line 2", " line 3", " line 4"].join("\n"));
    expect(lineDiff(numbered(4), numbered(4, { 4: "four" }))).toBe(["@@ -1,4 +1,4 @@", " line 1", " line 2", " line 3", "-line 4", "+four"].join("\n"));
  });

  it("gives two hunks for changes far apart, and one when their context touches", () => {
    const far = lineDiff(numbered(20), numbered(20, { 3: "three", 18: "eighteen" }));
    expect(far.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,6 +1,6 @@", "@@ -15,6 +15,6 @@"]);
    // changes at lines 5 and 12 have 6 lines between them: 3 + 3 of context meet, so one hunk
    const near = lineDiff(numbered(16), numbered(16, { 5: "five", 12: "twelve" }));
    expect(near.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -2,14 +2,14 @@"]);
    // with 7 lines between them they do not
    const apart = lineDiff(numbered(17), numbered(17, { 5: "five", 13: "thirteen" }));
    expect(apart.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -2,7 +2,7 @@", "@@ -10,7 +10,7 @@"]);
  });

  it("counts the lines of both texts in the header when lines are added and removed", () => {
    expect(lineDiff("b\nc\n", "a\nb\nc\n")).toBe(["@@ -1,2 +1,3 @@", "+a", " b", " c"].join("\n"));
    expect(lineDiff("a\nb\nc\n", "b\nc\n")).toBe(["@@ -1,3 +1,2 @@", "-a", " b", " c"].join("\n"));
    expect(lineDiff("a\nb\n", "a\nb\nc\nd\n")).toBe(["@@ -1,2 +1,4 @@", " a", " b", "+c", "+d"].join("\n"));
  });

  it("writes an empty range as diff does", () => {
    expect(lineDiff("", "x\ny\n")).toBe(["@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"));
    expect(lineDiff("x\ny\n", "")).toBe(["@@ -1,2 +0,0 @@", "-x", "-y"].join("\n"));
  });

  it("puts the removed lines before the lines that replace them", () => {
    expect(lineDiff("a\nb\nc\n", "a\nX\nY\nc\n")).toBe(["@@ -1,3 +1,4 @@", " a", "-b", "+X", "+Y", " c"].join("\n"));
  });

  it("finds the smallest change when lines repeat", () => {
    const diff = lineDiff("x\ny\nx\ny\nx\n", "x\ny\nx\nx\n");
    expect(diff.split("\n").filter((l) => l.startsWith("-") || l.startsWith("+"))).toEqual(["-y"]);
  });

  it("takes a context of any size, and 0", () => {
    const a = numbered(10);
    const b = numbered(10, { 5: "five" });
    expect(lineDiff(a, b, 0)).toBe(["@@ -5,1 +5,1 @@", "-line 5", "+five"].join("\n"));
    expect(lineDiff(a, b, 1)).toBe(["@@ -4,3 +4,3 @@", " line 4", "-line 5", "+five", " line 6"].join("\n"));
    expect(lineDiff(a, b, 100)).toBe(lineDiff(a, b, 10));
    expect(lineDiff(a, b, -5)).toBe(lineDiff(a, b, 0));
  });

  it("treats a line break at the end as the end of the last line", () => {
    expect(lineDiff("a\nb", "a\nB")).toBe(["@@ -1,2 +1,2 @@", " a", "-b", "+B"].join("\n"));
    expect(lineDiff("a\nb\n", "a\nB\n")).toBe(["@@ -1,2 +1,2 @@", " a", "-b", "+B"].join("\n"));
    expect(lineDiff("a\nb\n", "a\nb\n\n")).toBe(["@@ -1,2 +1,3 @@", " a", " b", "+"].join("\n"));
  });

  it("does not report texts that differ only in their line breaks as equal", () => {
    expect(lineDiff("a\nb\n", "a\nb")).toBe("(the texts differ only in their line breaks)");
    expect(lineDiff("a\r\nb\r\n", "a\nb\n")).toBe("(the texts differ only in their line breaks)");
  });

  it("reads CRLF and LF line breaks alike, so a file written on Windows does not differ on every line", () => {
    expect(lineDiff(numbered(10).replace(/\n/g, "\r\n"), numbered(10, { 5: "five" }))).toBe(lineDiff(numbered(10), numbered(10, { 5: "five" })));
  });

  it("compares lines exactly, spaces included", () => {
    expect(lineDiff("a\n b\n", "a\nb\n")).toBe(["@@ -1,2 +1,2 @@", " a", "- b", "+b"].join("\n"));
  });

  it("gives up on texts of more than 4 000 000 pairs of lines, and says how long they are", () => {
    const a = "x\n".repeat(2001);
    const b = "y\n".repeat(2001);
    expect(lineDiff(a, b)).toBe("(too large to diff: 2001 and 2001 lines)");
    expect(lineDiff("x\n".repeat(4001), "y\n".repeat(1000))).toBe("(too large to diff: 4001 and 1000 lines)");
    expect(lineDiff("x\n".repeat(1000), "y\n".repeat(4001))).toBe("(too large to diff: 1000 and 4001 lines)");
  });

  it("does diff texts of exactly 4 000 000 pairs of lines", () => {
    const diff = lineDiff("x\n".repeat(2000), "y\n".repeat(2000), 0);
    expect(diff.startsWith("@@ -1,2000 +1,2000 @@\n-x\n")).toBe(true);
    expect(diff.split("\n")).toHaveLength(4001);
  });

  it("diffs long texts that are mostly the same, whatever the guard", () => {
    const a = numbered(500);
    const diff = lineDiff(a, numbered(500, { 250: "changed" }));
    expect(diff).toBe(["@@ -247,7 +247,7 @@", " line 247", " line 248", " line 249", "-line 250", "+changed", " line 251", " line 252", " line 253"].join("\n"));
  });
});

describe("diffFile", () => {
  it("puts the --- incumbent and +++ candidate headers on the diff", () => {
    expect(diffFile("a\nb\n", "a\nc\n")).toBe("--- incumbent\n+++ candidate\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
  });

  it("gives nothing for equal files", () => {
    expect(diffFile(FIXTURE, FIXTURE)).toBe("");
  });

  it("shows an applied proposal as only what it changed, for a file written the way the app writes it", () => {
    const written = workflow([{}, { tools: ["grep"] }, {}], [[0, 1], [1, 2]]);
    const result = applied(written, edit("C1", { op: "set", agent: "Agent 1", field: "maxSteps", value: 9 }));
    expect(diffFile(written, result.text)).toBe([
      "--- incumbent", "+++ candidate", "@@ -28,7 +28,7 @@", "     model: m1", "     temperature: 0.5", "     maxTokens: 1000",
      "-    maxSteps: 3", "+    maxSteps: 9", "     timeoutSeconds: 100", "     promptSource:", "       type: inline", "",
    ].join("\n"));
  });

  it("carries the too-large message under its headers", () => {
    expect(diffFile("x\n".repeat(2001), "y\n".repeat(2001))).toBe("--- incumbent\n+++ candidate\n(too large to diff: 2001 and 2001 lines)\n");
  });
});

describe("parseProposal: optional fields written as null", () => {
  it("reads null as absent, for the summary and each optional field of an edit", () => {
    const nulls = {
      summary: null,
      edits: [{
        ...GOOD.edits[0], targets_mode: null, predicted_affected: null, retroactive_check: null, why_not_lower_lever: null,
        trigger_condition: null, regression_risk: null,
      }],
    };
    const result = parseProposal(fenced(nulls));
    if (!("proposal" in result)) throw new Error(result.error);
    expect(result.proposal.summary).toBeUndefined();
    const [e] = result.proposal.edits;
    for (const key of ["targets_mode", "predicted_affected", "retroactive_check", "why_not_lower_lever", "trigger_condition", "regression_risk"]) {
      expect(key in e).toBe(false);
    }
  });

  it("still rejects null where a value is required, and in an operation", () => {
    expect(parseError({ edits: [{ ...GOOD.edits[0], hypothesis: null }] })).toMatch(/^edits\[0\]\.hypothesis: /);
    expect(parseError(withOp({ op: "replace_text", agent: "A", field: "prompt", old: "x", new: null }))).toMatch(/^edits\[0\]\.ops\[0\]\.new: /);
  });
});

describe("applyProposal: agents that run scripts", () => {
  const HOOKED = workflow(
    [
      { name: "Lead" },
      { name: "Gate", role: "hook", preHook: { path: "hooks/check.sh", requireConsent: true } },
      { name: "Doer", postHook: { path: "hooks/after.sh", requireConsent: true } },
      { name: "Tail" },
    ],
    [[0, 1], [1, 2], [2, 3]],
  );

  it("does not touch a hook agent: its text, its fields, its removal or its edges", () => {
    const ops: EditOp[] = [
      { op: "set_text", agent: "Gate", field: "prompt", value: "Skip the check." },
      { op: "set", agent: "Gate", field: "maxSteps", value: 9 },
      { op: "remove_agent", agent: "Gate" },
      { op: "disconnect", from: "Lead", to: "Gate" },
      { op: "connect", from: "Gate", to: "Tail" },
    ];
    for (const op of ops) {
      const [error] = errorsOf(HOOKED, [edit("C1", op)]);
      expect(error).toBe(`edit C1, op 1 (${op.op}): agent "Gate" is a hook agent: it runs a script, so an edit cannot change it or its edges`);
    }
  });

  it("keeps an agent with a pre- or post-hook in its place and its role", () => {
    for (const op of [{ op: "remove_agent", agent: "Doer" }, { op: "set_role", agent: "Doer", value: AgentRole.Critic }] as EditOp[]) {
      expect(errorsOf(HOOKED, [edit("C1", op)])).toEqual([
        `edit C1, op 1 (${op.op}): agent "Doer" runs a hook script (preHook or postHook), so an edit cannot remove it or change its role`,
      ]);
    }
  });

  it("still edits the other fields of an agent with a hook", () => {
    const { def } = applied(HOOKED, edit("C1", { op: "set_text", agent: "Doer", field: "prompt", value: "Do it well." }));
    expect(agentOf(def, "Doer").promptSource).toEqual({ type: "inline", content: "Do it well." });
    expect(agentOf(def, "Doer").postHook).toEqual({ path: "hooks/after.sh", requireConsent: true });
  });
});
