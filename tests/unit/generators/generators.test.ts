import { describe, it, expect } from "vitest";
import { generateClaudeMd } from "@/utils/generators/claudeMd";
import { generateAgentsMd } from "@/utils/generators/agentsMd";
import { generateLangGraph } from "@/utils/generators/langGraph";
import { generateCrewAi }   from "@/utils/generators/crewAi";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";

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
});
