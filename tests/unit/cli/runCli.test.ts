// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { corePath, createInterrupt, exitCode, EXIT } from "@/cli/runCli";
import type { WorkflowRun } from "@/types/execution";

const finished = (status: WorkflowRun["status"]) =>
  ({ started: true as const, run: { id: "r", workflowName: "W", startedAt: 0, status, agents: {} } });

describe("exitCode", () => {
  it("is 0 when done, 1 when an agent failed, 130 when stopped and 3 when the run could not start", () => {
    expect(exitCode(finished("done"), false)).toBe(0);
    expect(exitCode(finished("error"), false)).toBe(1);
    expect(exitCode(finished("cancelled"), false)).toBe(130);
    expect(exitCode({ started: false, error: "Ollama is not running" }, false)).toBe(3);
    expect(exitCode(finished("error"), true)).toBe(3); // harness-core stopped during the run
  });
});

describe("createInterrupt", () => {
  it("stops the run on the first Ctrl+C and exits on the second", () => {
    const messages: string[] = [];
    const exit = vi.fn();
    const stop = createInterrupt((line) => messages.push(line), exit);

    stop.onInterrupt();
    expect(stop.interrupted()).toBe(true);
    expect(messages).toEqual(["Stopping the run… (press Ctrl+C again to exit now)"]);
    expect(exit).not.toHaveBeenCalled();

    stop.onInterrupt();
    expect(exit).toHaveBeenCalledWith(EXIT.interrupted);
  });
});

describe("corePath", () => {
  it("takes --core, then HARNESS_CORE, then this repo's release build", () => {
    expect(corePath("bin/core", { HARNESS_CORE: "/opt/core" }, "linux")).toMatch(/bin[\\/]core$/);
    expect(corePath(undefined, { HARNESS_CORE: "/opt/core" }, "linux")).toMatch(/opt[\\/]core$/);
    expect(corePath(undefined, {}, "win32")).toMatch(/src-tauri[\\/]target[\\/]release[\\/]harness-core\.exe$/);
    expect(corePath(undefined, {}, "linux")).toMatch(/src-tauri[\\/]target[\\/]release[\\/]harness-core$/);
  });
});
