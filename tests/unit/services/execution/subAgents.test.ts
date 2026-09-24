import { describe, it, expect, vi } from "vitest";
import {
  createSubAgentRunner,
  MAX_SUBAGENTS_PER_NODE,
  type SubAgentRun,
} from "@/services/execution/subAgents";
import type { AgentLoopResult } from "@/services/execution/agentLoop";

function setup(runLoop?: (child: SubAgentRun) => Promise<AgentLoopResult>) {
  const loop = vi.fn(runLoop ?? (async (child: SubAgentRun): Promise<AgentLoopResult> => ({
    text: `did: ${child.userMessage}`, toolCalls: 0, mode: "native", nativeRefused: false, tokenEstimate: 10,
  })));
  const events: string[] = [];
  const subAgents = createSubAgentRunner({
    parentName: "Lead",
    workflowName: "W",
    parentTools: ["read_file", "fs.write", "subagent_dispatch", "web_search"],
    runLoop: loop,
    onEvent: (message) => events.push(message),
  });
  return { subAgents, loop, events };
}

describe("createSubAgentRunner", () => {
  it("runs a helper with a fresh context and returns its report", async () => {
    const { subAgents, loop, events } = setup();

    const out = await subAgents.dispatch({ task: "Summarize a.md", name: "Reader" });

    expect(out).toBe("Report from Reader:\ndid: Summarize a.md");
    const child = loop.mock.calls[0][0];
    expect(child.name).toBe("Reader");
    expect(child.userMessage).toBe("Summarize a.md");
    expect(child.system).toMatch(/^You are Reader, a worker agent in the W workflow\./);
    expect(child.system).toContain("started by Lead");
    expect(events.length).toBe(2); // started, finished
  });

  it("gives a helper only tools its parent has, and never subagent_dispatch", async () => {
    const { subAgents, loop } = setup();
    await subAgents.dispatch({ task: "t", tools: ["read_file", "bash", "subagent_dispatch", "web_search"] });
    await subAgents.dispatch({ task: "t" });
    expect(loop.mock.calls[0][0].tools).toEqual(["read_file"]);
    expect(loop.mock.calls[1][0].tools).toEqual(["read_file", "fs.write"]);
  });

  it(`refuses more than ${MAX_SUBAGENTS_PER_NODE} helpers per node run`, async () => {
    const { subAgents, loop } = setup();
    for (let i = 0; i < MAX_SUBAGENTS_PER_NODE; i++) await subAgents.dispatch({ task: `t${i}` });
    const out = await subAgents.dispatch({ task: "one more" });
    expect(out).toMatch(/^\[error\].*limit/);
    expect(loop).toHaveBeenCalledTimes(MAX_SUBAGENTS_PER_NODE);
  });

  it("rejects a dispatch without a task", async () => {
    const { subAgents, loop } = setup();
    expect(await subAgents.dispatch({ name: "x" })).toMatch(/^\[error\].*task/);
    expect(loop).not.toHaveBeenCalled();
  });

  it("returns a failed helper as a tool error and adds up the helpers' tokens", async () => {
    const { subAgents } = setup(async (child) => {
      if (child.userMessage === "bad") throw new Error("boom");
      return { text: "ok", toolCalls: 0, mode: "native", nativeRefused: false, tokenEstimate: 7 };
    });
    expect(await subAgents.dispatch({ task: "bad", name: "B" })).toBe("[error] Sub-agent B failed: Error: boom");
    await subAgents.dispatch({ task: "good" });
    await subAgents.dispatch({ task: "good" });
    expect(subAgents.tokenEstimate()).toBe(14);
  });
});
