import { describe, it, expect, vi } from "vitest";
import {
  createSubAgentRunner,
  MAX_SUBAGENTS_PER_NODE,
  type SubAgentRun,
} from "@/services/execution/subAgents";
import type { AgentLoopResult } from "@/services/execution/agentLoop";
import type { SubAgentRecord } from "@/types/execution";

function setup(
  runLoop?: (child: SubAgentRun) => Promise<AgentLoopResult>,
  onUpdate?: (record: SubAgentRecord) => void,
  isCancelled?: () => boolean,
) {
  const loop = vi.fn(runLoop ?? (async (child: SubAgentRun): Promise<AgentLoopResult> => ({
    text: `did: ${child.userMessage}`, toolCalls: 0, mode: "native", nativeRefused: false, tokenEstimate: 10,
  })));
  const events: string[] = [];
  const subAgents = createSubAgentRunner({
    parentName: "Lead",
    workflowName: "W",
    parentTools: ["read_file", "fs.write", "subagent_dispatch", "web_search", "bash"],
    runLoop: loop,
    onEvent: (message) => events.push(message),
    onUpdate,
    isCancelled,
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

  it("gives a helper only tools its parent has, and never subagent_dispatch or bash", async () => {
    // Only the workflow's own agents ask the user to approve commands.
    const { subAgents, loop } = setup();
    await subAgents.dispatch({ task: "t", tools: ["read_file", "bash", "subagent_dispatch", "web_search"] });
    await subAgents.dispatch({ task: "t" });
    expect(loop.mock.calls[0][0].tools).toEqual(["read_file"]);
    expect(loop.mock.calls[1][0].tools).toEqual(["read_file", "fs.write"]);
  });

  it("accepts the native tool names the model sees (fs_write for fs.write)", async () => {
    const { subAgents, loop } = setup();
    await subAgents.dispatch({ task: "t", tools: ["fs_write", "read_file"] });
    expect(loop.mock.calls[0][0].tools).toEqual(["read_file", "fs.write"]);
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

  it("reports each helper's progress for the activity panel", async () => {
    const updates: SubAgentRecord[] = [];
    const { subAgents } = setup(async (child) => {
      if (child.userMessage === "bad") throw new Error("boom");
      return { text: "the report", toolCalls: 2, mode: "native", nativeRefused: false, tokenEstimate: 1 };
    }, (record) => updates.push(record));

    await subAgents.dispatch({ task: "good", name: "Reader", tools: ["read_file"] });
    await subAgents.dispatch({ task: "bad", name: "Broken" });

    expect(updates.map((u) => [u.id, u.name, u.status])).toEqual([
      ["sub-1", "Reader", "running"], ["sub-1", "Reader", "done"],
      ["sub-2", "Broken", "running"], ["sub-2", "Broken", "error"],
    ]);
    expect(updates[1]).toMatchObject({
      task: "good", tools: ["read_file"], output: "the report", toolCalls: 2,
    });
    expect(updates[1].finishedAt).toBeGreaterThanOrEqual(updates[1].startedAt);
    expect(updates[3]).toMatchObject({ error: "Error: boom" });
  });

  it("marks a helper stopped, not failed, when the run is stopped", async () => {
    const updates: SubAgentRecord[] = [];
    let stopped = false;
    const { subAgents, events } = setup(async () => {
      stopped = true; // Stop pressed while the helper worked
      throw new Error("Run stopped");
    }, (record) => updates.push(record), () => stopped);

    const out = await subAgents.dispatch({ task: "t", name: "H" });

    expect(updates.map((u) => u.status)).toEqual(["running", "stopped"]);
    expect(updates[1].error).toBeUndefined();
    expect(updates[1].finishedAt).toBeGreaterThanOrEqual(updates[1].startedAt);
    expect(out).toBe("[error] Sub-agent H was stopped.");
    expect(events[1]).toMatch(/stopped/);
  });
});
