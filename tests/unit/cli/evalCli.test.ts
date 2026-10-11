// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { evalExitCode } from "@/cli/evalCli";
import { createInterrupt, EXIT } from "@/cli/shared";

describe("evalExitCode", () => {
  it("is 0 when the eval finished, whatever the score, and with no --min-score", () => {
    expect(evalExitCode({ status: "done", S: 0 }, undefined)).toBe(0);
    expect(evalExitCode({ status: "done", S: 0.2 }, undefined)).toBe(0);
    expect(evalExitCode({ status: "done", S: 1 }, undefined)).toBe(0);
  });

  it("is 1 when --min-score was given and S is below it", () => {
    expect(evalExitCode({ status: "done", S: 0.59 }, 0.6)).toBe(1);
    expect(evalExitCode({ status: "done", S: 0 }, 0.01)).toBe(1);
  });

  it("is 0 when S reaches --min-score, and counts a sum that rounds a hair under as reaching it", () => {
    expect(evalExitCode({ status: "done", S: 0.6 }, 0.6)).toBe(0);
    expect(evalExitCode({ status: "done", S: 0.75 }, 0.5)).toBe(0);
    expect(evalExitCode({ status: "done", S: 0.7 - 1e-12 }, 0.7)).toBe(0);
    expect(evalExitCode({ status: "done", S: 0.7 - 1e-6 }, 0.7)).toBe(1);
  });

  it("is 130 when interrupted, and 3 when it stopped early, whatever --min-score says", () => {
    expect(evalExitCode({ status: "cancelled", S: 0.9 }, 0.5)).toBe(130);
    expect(evalExitCode({ status: "cancelled", S: 0 }, 0.5)).toBe(130);
    expect(evalExitCode({ status: "error", S: 0 }, 0.5)).toBe(3);
    expect(evalExitCode({ status: "error", S: null }, undefined)).toBe(3);
  });

  it("uses the exit codes of harness run", () => {
    expect(EXIT).toEqual({ done: 0, failed: 1, usage: 2, notStarted: 3, interrupted: 130 });
  });
});

describe("createInterrupt, for the eval", () => {
  it("says it is stopping the eval, and exits on the second Ctrl+C, as harness run does for a run", () => {
    const messages: string[] = [];
    const exit = vi.fn();
    const stop = createInterrupt((line) => messages.push(line), exit, "eval");

    stop.onInterrupt();
    expect(stop.interrupted()).toBe(true);
    expect(messages).toEqual(["Stopping the eval… (press Ctrl+C again to exit now)"]);
    expect(exit).not.toHaveBeenCalled();

    stop.onInterrupt();
    expect(exit).toHaveBeenCalledWith(130);
  });
});
