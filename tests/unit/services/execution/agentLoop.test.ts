import { describe, it, expect, vi } from "vitest";
import { beforeDeadline, runAgentLoop, type AgentLoopOptions } from "@/services/execution/agentLoop";
import type { ChatReply } from "@/services/model-providers/providerAdapter";

const reply = (over: Partial<ChatReply> = {}): ChatReply => ({
  text: "", toolCalls: [], finishReason: "stop", nativeToolsSupported: true, ...over,
});

function options(over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  const deadline = Date.now() + 60_000;
  return {
    system: "You are A.",
    userMessage: "Do the task.",
    tools: ["read_file", "fs.write"],
    maxSteps: 5,
    deadline: () => deadline,
    timeoutMessage: "A timed out after 60s",
    isCancelled: () => false,
    callTurn: vi.fn(async () => reply({ text: "done" })),
    callText: vi.fn(async () => "text answer"),
    runTool: vi.fn(async (call) => `R:${call.name}`),
    ...over,
  };
}

describe("runAgentLoop — native tool calls", () => {
  it("answers every tool call of a turn in one tool message, then returns the final text", async () => {
    const callTurn = vi.fn()
      .mockResolvedValueOnce(reply({
        finishReason: "tool_calls",
        toolCalls: [
          { id: "a", name: "read_file", args: { path: "x" } },
          { id: "b", name: "fs_write", args: { path: "y", content: "z" } },
        ],
      }))
      .mockResolvedValueOnce(reply({ text: "done" }));
    const opts = options({ callTurn });

    const result = await runAgentLoop(opts);

    expect(result).toMatchObject({ text: "done", toolCalls: 2, mode: "native", nativeRefused: false });
    expect(callTurn.mock.calls[0][2].map((t: { name: string }) => t.name)).toEqual(["read_file", "fs_write", "edit_file"]);
    expect(opts.runTool).toHaveBeenNthCalledWith(1, { name: "read_file", args: { path: "x" } });
    expect(opts.runTool).toHaveBeenNthCalledWith(2, { name: "fs.write", args: { path: "y", content: "z" } });
    expect(callTurn.mock.calls[1][1]).toEqual([
      { role: "user", text: "Do the task." },
      { role: "assistant", text: "", toolCalls: [
        { id: "a", name: "read_file", args: { path: "x" } },
        { id: "b", name: "fs_write", args: { path: "y", content: "z" } },
      ] },
      { role: "tool", toolResults: [
        { id: "a", name: "read_file", content: "R:read_file", isError: false },
        { id: "b", name: "fs_write", content: "R:fs.write", isError: false },
      ] },
    ]);
  });

  it("refuses a tool that was not offered, and flags tool errors", async () => {
    const callTurn = vi.fn()
      .mockResolvedValueOnce(reply({ toolCalls: [
        { id: "a", name: "fs_append", args: { path: "x" } },
        { id: "b", name: "read_file", args: {} },
      ] }))
      .mockResolvedValueOnce(reply({ text: "done" }));
    const runTool = vi.fn(async () => "[error] read_file requires a 'path' argument.");

    await runAgentLoop(options({ callTurn, runTool }));

    expect(runTool).toHaveBeenCalledTimes(1);
    const results = callTurn.mock.calls[1][1][2].toolResults;
    expect(results[0]).toMatchObject({ id: "a", isError: true });
    expect(results[0].content).toMatch(/not available/);
    expect(results[1]).toMatchObject({ id: "b", isError: true });
  });

  it("does not run tool calls cut off by Max tokens", async () => {
    const opts = options({ callTurn: vi.fn(async () => reply({
      finishReason: "max_tokens", toolCalls: [{ id: "a", name: "fs_write", args: { path: "x" } }],
    })) });
    await expect(runAgentLoop(opts)).rejects.toThrow(/Max tokens/);
    expect(opts.runTool).not.toHaveBeenCalled();
  });

  it("stops after maxSteps model calls and says so", async () => {
    const opts = options({
      maxSteps: 2,
      callTurn: vi.fn(async () => reply({ toolCalls: [{ id: "a", name: "read_file", args: { path: "x" } }] })),
    });
    const result = await runAgentLoop(opts);
    expect(opts.callTurn).toHaveBeenCalledTimes(2);
    expect(result.text).toMatch(/^\[Reached max steps \(2\)/);
  });
});

describe("runAgentLoop — text protocol", () => {
  it("falls back to the text protocol when the provider refuses tools", async () => {
    const opts = options({ callTurn: vi.fn(async () => reply({ nativeToolsSupported: false })) });
    const result = await runAgentLoop(opts);
    expect(result).toMatchObject({ text: "text answer", mode: "text", nativeRefused: true });
    expect(vi.mocked(opts.callText).mock.calls[0][0]).toContain("## Tool Usage");
  });

  it("falls back after a first-call error the caller accepts (billing), not after others", async () => {
    const billing = options({
      callTurn: vi.fn(async () => { throw new Error("quota exceeded"); }),
      fallbackOnError: (e) => String(e).includes("quota"),
    });
    await expect(runAgentLoop(billing)).resolves.toMatchObject({ mode: "text", nativeRefused: false });

    const other = options({ callTurn: vi.fn(async () => { throw new Error("boom"); }), fallbackOnError: () => false });
    await expect(runAgentLoop(other)).rejects.toThrow("boom");
  });

  it("runs one tool per step and feeds the result back (preferText)", async () => {
    const callText = vi.fn()
      .mockResolvedValueOnce(`Reading.\n<tool_call>{"name":"read_file","args":{"path":"a"}}</tool_call>`)
      .mockResolvedValueOnce("final");
    const opts = options({ preferText: true, callText });

    const result = await runAgentLoop(opts);

    expect(opts.callTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: "final", toolCalls: 1, mode: "text" });
    expect(callText.mock.calls[1][1]).toContain("<tool_result>R:read_file</tool_result>");
  });

  it("makes one plain call when the node has no runnable tools", async () => {
    const opts = options({ tools: ["web_search"] });
    const result = await runAgentLoop(opts);
    expect(opts.callTurn).not.toHaveBeenCalled();
    expect(opts.callText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(opts.callText).mock.calls[0][0]).toBe("You are A.");
    expect(result.text).toBe("text answer");
  });
});

describe("runAgentLoop — deadline and Stop", () => {
  it("throws the timeout message once the deadline has passed", async () => {
    const passed = Date.now() - 1;
    await expect(runAgentLoop(options({ deadline: () => passed }))).rejects.toThrow("A timed out after 60s");
  });

  it("does not time out an agent whose tool moved the deadline later (time spent waiting for the user)", async () => {
    let deadline = Date.now() + 40;
    const callTurn = vi.fn()
      .mockResolvedValueOnce(reply({ toolCalls: [{ id: "a", name: "read_file", args: { path: "x" } }] }))
      .mockResolvedValueOnce(reply({ text: "done" }));
    const runTool = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      deadline += 80;
      return "ok";
    });

    const result = await runAgentLoop(options({ deadline: () => deadline, callTurn, runTool }));

    expect(result.text).toBe("done");
  });

  it("runs no tool after Stop", async () => {
    let stopped = false;
    const opts = options({
      isCancelled: () => stopped,
      callTurn: vi.fn(async () => {
        stopped = true;
        return reply({ toolCalls: [{ id: "a", name: "fs_write", args: { path: "x", content: "y" } }] });
      }),
    });
    await expect(runAgentLoop(opts)).rejects.toThrow("Run stopped");
    expect(opts.runTool).not.toHaveBeenCalled();
  });
});

describe("beforeDeadline", () => {
  it("keeps waiting when the deadline moves later while the work runs", async () => {
    let deadline = Date.now() + 40;
    setTimeout(() => { deadline += 200; }, 10);
    const work = new Promise((resolve) => setTimeout(() => resolve("finished"), 100));

    await expect(beforeDeadline(work, () => deadline, "late", () => false)).resolves.toBe("finished");
  });

  it("rejects at a fixed deadline", async () => {
    await expect(beforeDeadline(new Promise(() => {}), Date.now() + 20, "late", () => false)).rejects.toThrow("late");
  });
});

describe("runAgentLoop — concurrent tools", () => {
  const tracked = () => {
    const state = { running: 0, peak: 0 };
    const runTool = vi.fn(async (call: { args: Record<string, unknown> }) => {
      state.running++;
      state.peak = Math.max(state.peak, state.running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.running--;
      return `R:${String(call.args.task ?? call.args.path)}`;
    });
    return { state, runTool };
  };

  it("runs concurrent tools in parallel up to the limit and keeps result order", async () => {
    const { state, runTool } = tracked();
    const calls = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: "subagent_dispatch", args: { task: `t${i}` } }));
    const callTurn = vi.fn()
      .mockResolvedValueOnce(reply({ toolCalls: calls }))
      .mockResolvedValueOnce(reply({ text: "done" }));

    await runAgentLoop(options({
      tools: ["subagent_dispatch"], callTurn, runTool, concurrentTools: ["subagent_dispatch"], maxConcurrent: 3,
    }));

    expect(state.peak).toBe(3);
    expect(callTurn.mock.calls[1][1][2].toolResults.map((r: { content: string }) => r.content))
      .toEqual(["R:t1", "R:t2", "R:t3", "R:t4"]);
  });

  it("still runs other tools one at a time", async () => {
    const { state, runTool } = tracked();
    const calls = [1, 2, 3].map((i) => ({ id: `c${i}`, name: "read_file", args: { path: `p${i}` } }));
    const callTurn = vi.fn()
      .mockResolvedValueOnce(reply({ toolCalls: calls }))
      .mockResolvedValueOnce(reply({ text: "done" }));

    await runAgentLoop(options({ callTurn, runTool, concurrentTools: ["subagent_dispatch"], maxConcurrent: 3 }));

    expect(state.peak).toBe(1);
  });
});

describe("runAgentLoop — compaction", () => {
  const big = "x".repeat(4000);

  it("summarizes older steps once the conversation passes the budget, then carries on", async () => {
    let turn = 0;
    const callTurn = vi.fn(async (_system: string, _messages: unknown[]) => (++turn < 4
      ? reply({ toolCalls: [{ id: `c${turn}`, name: "read_file", args: { path: `${turn}.md` } }] })
      : reply({ text: "done" })));
    const summarize = vi.fn(async () => "note");
    const onCompacted = vi.fn();

    const result = await runAgentLoop(options({
      callTurn, runTool: vi.fn(async () => big),
      compaction: { budget: 3000, summarize, onCompacted },
    }));

    expect(result.text).toBe("done");
    expect(summarize).toHaveBeenCalled();
    expect(onCompacted).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.any(Number));
    const lastMessages = callTurn.mock.calls.at(-1)![1] as Array<{ role: string; text?: string }>;
    expect(lastMessages).toHaveLength(3);
    expect(lastMessages[0].text).toContain("PROGRESS SO FAR");
  });

  it("carries on uncompacted when the summary call fails", async () => {
    let turn = 0;
    const callTurn = vi.fn(async () => (++turn < 3
      ? reply({ toolCalls: [{ id: `c${turn}`, name: "read_file", args: { path: "a.md" } }] })
      : reply({ text: "done" })));
    const onFailed = vi.fn();

    const result = await runAgentLoop(options({
      callTurn, runTool: vi.fn(async () => big),
      compaction: { budget: 1000, summarize: vi.fn(async () => { throw new Error("busy"); }), onFailed },
    }));

    expect(result.text).toBe("done");
    expect(onFailed).toHaveBeenCalled();
  });

  it("compacts the text protocol too", async () => {
    let step = 0;
    const callText = vi.fn(async (_system: string, _message: string) => (++step < 4
      ? `<tool_call>{"name":"read_file","args":{"path":"${step}.md"}}</tool_call>`
      : "done"));
    const summarize = vi.fn(async () => "note");

    const result = await runAgentLoop(options({
      preferText: true, callText, runTool: vi.fn(async () => big),
      compaction: { budget: 3000, summarize },
    }));

    expect(result.text).toBe("done");
    expect(summarize).toHaveBeenCalled();
    expect(callText.mock.calls.at(-1)![1]).toContain("PROGRESS SO FAR");
  });
});
