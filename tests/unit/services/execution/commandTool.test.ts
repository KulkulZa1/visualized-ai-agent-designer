import { describe, it, expect, vi } from "vitest";
import { runCommandTool, type CommandToolOptions } from "@/services/execution/commandTool";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { HookResult } from "@/types/hookResult";

const result = (over: Partial<HookResult> = {}): HookResult => ({
  exitCode: 0, stdout: "", stderr: "", durationMs: 1200, ...over,
});

function options(over: Partial<CommandToolOptions> = {}) {
  let deadline = Date.now() + 90_000;
  const audit: Array<{ details: string; success: boolean }> = [];
  const opts: CommandToolOptions = {
    agentName: "Tester",
    workspacePath: "/ws",
    invoke: vi.fn(async () => result({ stdout: "2 passed" })) as unknown as InvokeFn,
    askUser: vi.fn(async () => "allow" as const),
    deadline: () => deadline,
    extendDeadline: (ms) => { deadline += ms; },
    isCancelled: () => false,
    onAudit: (details, success) => audit.push({ details, success }),
    ...over,
  };
  return { opts, audit, deadline: () => deadline };
}

describe("runCommandTool", () => {
  it("runs an approved command in the workspace with the node's remaining time", async () => {
    const { opts, audit } = options();

    const text = await runCommandTool({ command: "npm test" }, opts);

    expect(opts.askUser).toHaveBeenCalledWith("npm test");
    expect(opts.invoke).toHaveBeenCalledWith("execute_command", {
      workspacePath: "/ws", command: "npm test", consentGranted: true, timeoutSecs: 90,
    });
    expect(text).toContain("exit code 0");
    expect(text).toContain("2 passed");
    expect(text.startsWith("[error]")).toBe(false);
    expect(audit).toEqual([{ details: expect.stringContaining("npm test"), success: true }]);
  });

  it("reports a failing command as an error, with its output", async () => {
    const invoke = vi.fn(async () => result({ exitCode: 1, stdout: "1 failed", stderr: "AssertionError" }));
    const { opts, audit } = options({ invoke: invoke as unknown as InvokeFn });

    const text = await runCommandTool({ command: "npm test" }, opts);

    expect(text.startsWith("[error]")).toBe(true);
    expect(text).toContain("exit code 1");
    expect(text).toContain("1 failed");
    expect(text).toContain("AssertionError");
    expect(audit[0].success).toBe(false);
  });

  it("keeps the end of long output, where test runners print their summary", async () => {
    const invoke = vi.fn(async () => result({ stdout: `${"x".repeat(50_000)}\nTests 3 passed` }));
    const { opts } = options({ invoke: invoke as unknown as InvokeFn });

    const text = await runCommandTool({ command: "npm test" }, opts);

    expect(text).toContain("Tests 3 passed");
    expect(text).toMatch(/earlier characters omitted/);
    expect(text.length).toBeLessThan(10_000);
  });

  it("does not run a command the user denied", async () => {
    const { opts, audit } = options({ askUser: vi.fn(async () => "deny" as const) });

    const text = await runCommandTool({ command: "rm -rf build" }, opts);

    expect(opts.invoke).not.toHaveBeenCalled();
    expect(text.startsWith("[error]")).toBe(true);
    expect(text).toContain("denied");
    expect(audit).toEqual([{ details: expect.stringContaining("denied"), success: false }]);
  });

  // What the dialog shows must be what runs: no bidi overrides or zero-width characters.
  it.each([
    ["no command", {}, "requires a 'command'"],
    ["a line break", { command: "npm install\nnpm test" }, "one command line"],
    ["a bidi override", { command: "npm test ‮& del /q *" }, "invisible"],
    ["a zero-width space", { command: "npm​ test" }, "invisible"],
    ["an overlong command", { command: `npm test ${"x".repeat(2000)}` }, "too long"],
  ])("does not ask about a command with %s", async (_label, args, message) => {
    const { opts } = options();

    const text = await runCommandTool(args, opts);

    expect(text).toContain(message);
    expect(opts.askUser).not.toHaveBeenCalled();
  });

  it("does not ask without an open workspace", async () => {
    const { opts } = options({ workspacePath: null });

    expect(await runCommandTool({ command: "npm test" }, opts)).toContain("No workspace open");
    expect(opts.askUser).not.toHaveBeenCalled();
  });

  it("does not count the time spent waiting for the user", async () => {
    const { opts, deadline } = options({
      askUser: () => new Promise((resolve) => setTimeout(() => resolve("allow"), 60)),
    });
    const before = deadline();

    await runCommandTool({ command: "npm test" }, opts);

    expect(deadline() - before).toBeGreaterThanOrEqual(50);
  });

  it("runs nothing once the run is stopped while waiting for the user", async () => {
    let stopped = false;
    const { opts } = options({
      askUser: async () => { stopped = true; return "deny"; },
      isCancelled: () => stopped,
    });

    await expect(runCommandTool({ command: "npm test" }, opts)).rejects.toThrow("Run stopped");
    expect(opts.invoke).not.toHaveBeenCalled();
  });
});
