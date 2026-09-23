import { describe, it, expect } from "vitest";
import { generateClaudeMd } from "@/utils/generators/claudeMd";
import { generateAgentsMd } from "@/utils/generators/agentsMd";
import { generateLangGraph } from "@/utils/generators/langGraph";
import { generateCrewAi }   from "@/utils/generators/crewAi";
import { deserializeWorkflow } from "@/utils/yamlSerializer";
import { AgentRole, ToolPermission, type AgentNodeData } from "@/types/agent";
import type { WorkflowConnection, WorkflowDef } from "@/types/workflow";

const testWorkflow: WorkflowDef = {
  meta: {
    name: "Test Harness",
    version: "1.0.0",
    description: "Unit test workflow",
    projectRoot: "/test",
    createdAt: "2026-05-16T00:00:00Z",
    updatedAt: "2026-05-16T00:00:00Z",
  },
  agents: [
    {
      name: "Coordinator",
      role: AgentRole.Orchestrator,
      model: "claude-sonnet-4.6",
      temperature: 0.7,
      maxTokens: 32000,
      maxSteps: 20,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "You are the coordinator." },
      tools: [ToolPermission.ReadFile, ToolPermission.SubagentDispatch],
      memoryRead: [], memoryWrite: ["output"],
      tokens: { used: 0, budget: 32000 },
      status: "idle",
    },
    {
      name: "Web Searcher",
      role: AgentRole.Worker,
      model: "claude-haiku-4.5",
      temperature: 0.5,
      maxTokens: 20000,
      maxSteps: 10,
      timeoutSeconds: 120,
      promptSource: { type: "file", path: ".harness/prompts/web-searcher.md" },
      tools: [ToolPermission.WebSearch, ToolPermission.WebFetch],
      preHook: { path: ".harness/hooks/url_allowlist.py", requireConsent: true },
      memoryRead: [], memoryWrite: ["web-results"],
      tokens: { used: 0, budget: 20000 },
      status: "idle",
    },
  ],
  connections: [
    { id: "e1", sourceAgentId: "agent-0", targetAgentId: "agent-1", label: "query" },
  ],
  executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
  nodePositions: { "agent-0": { x: 0, y: 0 }, "agent-1": { x: 300, y: 0 } },
};

function agent(name: string, role: AgentRole, extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    name, role, model: "claude-haiku-4.5", temperature: 0.5, maxTokens: 1000, maxSteps: 5,
    timeoutSeconds: 60, promptSource: { type: "inline", content: `You are ${name}.` },
    tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 1000 }, status: "idle",
    ...extra,
  };
}

function edge(src: number, tgt: number, extra: Partial<WorkflowConnection> = {}): WorkflowConnection {
  return { id: `e${src}-${tgt}`, sourceAgentId: `agent-${src}`, targetAgentId: `agent-${tgt}`, ...extra };
}

function workflow(agents: AgentNodeData[], connections: WorkflowConnection[], name = "Test Harness"): WorkflowDef {
  return { ...testWorkflow, meta: { ...testWorkflow.meta, name }, agents, connections, nodePositions: {} };
}

/** A single-line, double-quoted Python string literal (what JSON.stringify emits). */
const PY_STR = String.raw`"(?:[^"\\\n]|\\.)*"`;

function expectCrewAiWellFormed(py: string) {
  expect(py).not.toMatch(/=(true|false)\b/);
  const lines = py.split("\n");
  lines.filter((l) => /^\s+(role|goal|backstory|description|expected_output)=/.test(l))
    .forEach((l) => expect(l).toMatch(new RegExp(`^\\s+\\w+=${PY_STR},$`)));
  // Every context=[...] entry is a task defined on an earlier line.
  lines.forEach((line, i) => {
    line.match(/context=\[(.*)\],/)?.[1].split(", ").forEach((task) => {
      const defLine = lines.findIndex((l) => l.startsWith(`${task} = Task(`));
      expect(defLine, `${task} is never defined`).toBeGreaterThanOrEqual(0);
      expect(defLine, `${task} is used before it is defined`).toBeLessThan(i);
    });
  });
  // Top-level assignments bind distinct names.
  const targets = [...py.matchAll(/^(\S+)\s*=/gm)].map((m) => m[1]);
  expect(new Set(targets).size).toBe(targets.length);
}

function expectLangGraphWellFormed(py: string) {
  const nodes = [...py.matchAll(/^\s+g\.add_node\("(\w+)", \w+\)$/gm)].map((m) => m[1]);
  expect(new Set(nodes).size).toBe(nodes.length);
  // LangGraph rejects node names that are also state keys.
  const stateKeys = [...py.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]);
  nodes.forEach((n) => expect(stateKeys).not.toContain(n));
  const edges = [...py.matchAll(/^\s+g\.add_edge\("(\w+)", (?:"(\w+)"|END)\)/gm)];
  expect(edges.length).toBeGreaterThan(0);
  // A reversed feedback edge would duplicate the forward edge it answers.
  const pairs = edges.map(([, src, tgt]) => `${src}->${tgt ?? "END"}`);
  expect(new Set(pairs).size, pairs.join(", ")).toBe(pairs.length);
  edges.forEach(([line, src, tgt]) => {
    expect(nodes, line).toContain(src);
    if (tgt) expect(nodes, line).toContain(tgt);
  });
}

describe("generateClaudeMd", () => {
  it("includes workflow name and agent names", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain("Test Harness");
    expect(md).toContain("Coordinator");
    expect(md).toContain("Web Searcher");
  });

  it("includes model info", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain("claude-sonnet-4.6");
  });

  it("flags high-risk tools in security section", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain("Security");
    expect(md).toContain("subagent_dispatch");
  });

  it("includes execution settings", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain("300s");
    expect(md).toContain("runs independent forward-edge branches concurrently");
  });

  it("names the workflow file the way Save writes it (workspace root, not .harness/)", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain("The workflow is defined in `test-harness.harness.yaml`.");
    expect(md).not.toContain(".harness/test-harness.harness.yaml");
  });

  it("describes hook consent accurately and does not promise an audit log", () => {
    const md = generateClaudeMd(testWorkflow);
    expect(md).toContain(
      "Hook scripts run when a Hook node executes; hooks with `requireConsent: true` are not run automatically — run them manually from the Hooks tab.",
    );
    expect(md).not.toContain("All hook executions require user consent");
    expect(md).not.toContain("audit.log.jsonl");
  });
});

describe("generateAgentsMd", () => {
  it("includes topology overview", () => {
    const md = generateAgentsMd(testWorkflow);
    expect(md).toContain("Topology overview");
    expect(md).toContain("◆"); // orchestrator glyph
    expect(md).toContain("●"); // worker glyph
  });

  it("includes per-agent tables", () => {
    const md = generateAgentsMd(testWorkflow);
    expect(md).toContain("Coordinator");
    expect(md).toContain("Web Searcher");
    expect(md).toContain("url_allowlist.py");
  });
});

describe("generateLangGraph", () => {
  it("generates valid Python with imports", () => {
    const py = generateLangGraph(testWorkflow);
    expect(py).toContain("from langgraph.graph import StateGraph");
    expect(py).toContain("WorkflowState");
  });

  it("includes node function for each agent", () => {
    const py = generateLangGraph(testWorkflow);
    expect(py).toContain("def coordinator(");
    expect(py).toContain("def web_searcher(");
  });

  it("includes graph construction", () => {
    const py = generateLangGraph(testWorkflow);
    expect(py).toContain("build_graph");
    expect(py).toContain("g.add_node");
  });

  it("adds gateway nodes so every edge endpoint exists (2a)", () => {
    const py = generateLangGraph(workflow([
      agent("Coordinator", AgentRole.Orchestrator),
      agent("Router", AgentRole.Gateway, { condition: "route by topic" }),
      agent("Web", AgentRole.Worker),
      agent("Code", AgentRole.Worker),
    ], [edge(0, 1), edge(1, 2, { label: "web?" }), edge(1, 3, { label: "code?" })]));
    expect(py).toContain('g.add_node("router", router)');
    expect(py).toContain('g.add_edge("coordinator", "router")');
    expect(py).toContain('g.add_edge("router", "web")  # route: web?');
    expect(py).toContain('g.add_edge("router", "code")  # route: code?');
    // A graph node must return a state update, not a routing key.
    expect(py).not.toContain("return 'default'");
    expectLangGraphWellFormed(py);
  });

  it("emits feedback edges as a conditional-edge template, never an unconditional back edge (2b)", () => {
    // A plain LangGraph edge always fires: critic → writer would loop until
    // GraphRecursionError. The generated graph must terminate.
    const py = generateLangGraph(workflow([
      agent("Writer", AgentRole.Worker),
      agent("Critic", AgentRole.Critic),
    ], [edge(0, 1), edge(1, 0, { edgeKind: "feedback", label: "revise" })]));
    expect(py).not.toMatch(/^\s*g\.add_edge\("critic", "writer"\)/m);
    expect(py).toMatch(/^\s*# g\.add_conditional_edges\("critic", .*"writer"/m);
    expect(py).toContain('g.add_edge("critic", END)');
  });

  it("keeps prompt text verbatim, including backticks (2c)", () => {
    const prompt = "Run the `diff` command, then `git status`.";
    const py = generateLangGraph(workflow([
      agent("Shell", AgentRole.Worker, { promptSource: { type: "inline", content: prompt } }),
    ], []));
    expect(py).toContain(prompt);
  });

  it("escapes strings and sanitizes/de-duplicates identifiers (2d)", () => {
    const name = 'Flow "A" C:\\Users\\me';
    const prompt = 'Say """hi""" to C:\\Users\\me';
    const py = generateLangGraph(workflow([
      agent("Worker", AgentRole.Worker, {
        model: "4o-mini",
        promptSource: { type: "inline", content: prompt },
        memoryWrite: ["1st-draft", "class", "messages"],
      }),
      agent("Worker", AgentRole.Critic, {
        description: 'multi\nline "doc"',
        promptSource: { type: "file", path: "C:\\prompts\\critic.md" },
      }),
      agent("Revision Log", AgentRole.Memory, { model: "", memoryWrite: ["revision-log"] }),
    ], [edge(0, 1), edge(0, 2, { edgeKind: "memory" })], name));
    expect(py).toContain(`LangGraph export — ${JSON.stringify(name)}`);
    expect(py).toContain(`system_prompt = ${JSON.stringify(prompt)}`);
    expect(py).toContain(`    ${JSON.stringify('Critic: multi\nline "doc"')}`);
    expect(py).toContain(`with open(${JSON.stringify("C:\\prompts\\critic.md")}, encoding="utf-8") as f:`);
    expect(py).toContain(`HumanMessage(content=${JSON.stringify(`Hello from ${name}`)})`);
    expect(py).toContain("key_1st_draft: str  # memory key: 1st-draft");
    expect(py).toContain("key_class: str  # memory key: class");
    expect(py).toContain("messages_2: str  # memory key: messages");
    expect(py).toContain('model_4o_mini = ChatAnthropic(model="4o-mini", temperature=0.7)');
    expect(py).toContain("response = model_4o_mini.invoke(");
    expect(py).toContain("def worker(state");
    expect(py).toContain("def worker_2(state");
    expect(py).toContain('g.add_edge("worker", "worker_2")');
    expect(py).toContain('g.add_node("revision_log", revision_log)');
    expectLangGraphWellFormed(py);
  });

  it("keeps user text inside comments on a single line", () => {
    const py = generateLangGraph(workflow([
      agent("Router", AgentRole.Gateway, { condition: "a > 1\nb < 2" }),
      agent("Gate", AgentRole.Hook, { preHook: { path: "hooks/\ngate.sh", requireConsent: true } }),
    ], [edge(0, 1, { label: "go\nnow" })]));
    expect(py).toContain("# Condition: a > 1 b < 2");
    expect(py).toContain("# Pre-hook: hooks/ gate.sh");
    expect(py).toContain("# route: go now");
    expect(py).not.toMatch(/^(b < 2|gate\.sh|now)/m);
  });
});

describe("generateCrewAi", () => {
  it("generates valid Python with CrewAI imports", () => {
    const py = generateCrewAi(testWorkflow);
    expect(py).toContain("from crewai import Agent, Task, Crew");
  });

  it("includes agent definitions", () => {
    const py = generateCrewAi(testWorkflow);
    expect(py).toContain("coordinator = Agent(");
    expect(py).toContain("web_searcher = Agent(");
  });

  it("includes task definitions", () => {
    const py = generateCrewAi(testWorkflow);
    expect(py).toContain("task_coordinator = Task(");
    expect(py).toContain("task_web_searcher = Task(");
  });

  it("includes crew assembly", () => {
    const py = generateCrewAi(testWorkflow);
    expect(py).toContain("crew = Crew(");
    expect(py).toContain("crew.kickoff(");
  });

  it("emits Python booleans, not JavaScript ones (1a)", () => {
    const py = generateCrewAi(testWorkflow);
    expect(py).toContain("allow_delegation=True,");
    expect(py).toContain("allow_delegation=False,");
    expect(py).not.toMatch(/=(true|false)\b/);
  });

  it("emits descriptions, prompts and names as escaped string literals (1b)", () => {
    const name = 'Flow "A" C:\\Users\\me';
    const description = 'Line one\nSays "hi" from C:\\Users\\me';
    const prompt = 'Use """triple""" quotes and C:\\Users\\me';
    const py = generateCrewAi(workflow([
      agent("Writer", AgentRole.Worker, { description, promptSource: { type: "inline", content: prompt } }),
    ], [], name));
    expect(py).toContain(`CrewAI export — ${JSON.stringify(name)}`);
    expect(py).toContain(`goal=${JSON.stringify(`Writer: ${description}`)},`);
    expect(py).toContain(`backstory=${JSON.stringify(prompt)},`);
    expect(py).toContain(`description=${JSON.stringify(`Writer: ${description}`)},`);
    expect(py).toContain(`expected_output=${JSON.stringify("Structured output from Writer")},`);
    expect(py).toContain(`"query": ${JSON.stringify(`Initial task for ${name}`)}`);
    expectCrewAiWellFormed(py);
  });

  it("sanitizes and de-duplicates Python identifiers (1c)", () => {
    const py = generateCrewAi(workflow([
      agent("1st Reviewer", AgentRole.Worker),
      agent("Pass", AgentRole.Worker),
      agent("리서처", AgentRole.Worker),
      agent("Worker", AgentRole.Worker),
      agent("Worker", AgentRole.Critic),
      agent("Web Search", AgentRole.Worker, { tools: [ToolPermission.WebSearch] }),
    ], []));
    expect(py).toContain("web_search   = WebsiteSearchTool()");
    expect(py).toContain("agents=[agent_1st_reviewer, agent_pass, agent, worker, worker_2, web_search_2],");
    expect(py).toContain(
      "tasks=[task_agent_1st_reviewer, task_agent_pass, task_agent, task_worker, task_worker_2, task_web_search_2],",
    );
    expect(py).toContain("    tools=[web_search],\n");
    expect(py).toContain("    agent=web_search_2,\n");
    expectCrewAiWellFormed(py);
  });

  it("references only defined tasks, in dependency order (1d)", () => {
    // Writer (agent-0) depends on Planner (agent-1); the Hook and Memory nodes have no task.
    const py = generateCrewAi(workflow([
      agent("Writer", AgentRole.Worker),
      agent("Planner", AgentRole.Orchestrator),
      agent("Gate", AgentRole.Hook),
      agent("Log", AgentRole.Memory),
      agent("Critic", AgentRole.Critic),
    ], [
      edge(1, 0), edge(2, 0, { edgeKind: "control" }), edge(3, 0),
      edge(0, 4), edge(4, 0, { edgeKind: "feedback" }),
    ]));
    expect(py).toContain("    context=[task_planner],\n");
    expect(py).toContain("    context=[task_writer],\n");
    expect(py).not.toMatch(/task_gate|task_log/);
    expect(py).toContain("tasks=[task_planner, task_writer, task_critic],");
    expectCrewAiWellFormed(py);
  });
});

// Vite raw imports of the bundled examples (no Node fs needed in jsdom).
const exampleYaml = import.meta.glob<string>("../../../examples/*.harness.yaml", {
  query: "?raw", import: "default", eager: true,
});
const examples = Object.entries(exampleYaml).map(
  ([path, text]) => [path.split("/").pop()!, deserializeWorkflow(text)] as const,
);

describe("generated Python for the bundled examples", () => {
  it("loads every example", () => {
    expect(examples.length).toBeGreaterThanOrEqual(7);
  });

  it.each(examples)("%s → CrewAI literals, booleans and task references are valid", (_, def) => {
    expectCrewAiWellFormed(generateCrewAi(def));
  });

  it.each(examples)("%s → LangGraph nodes and edges are consistent", (_, def) => {
    expectLangGraphWellFormed(generateLangGraph(def));
  });
});
