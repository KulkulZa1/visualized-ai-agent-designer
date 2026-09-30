import { describe, it, expect, beforeEach, vi } from "vitest";
import { useExecutionStore } from "@/store/executionStore";

beforeEach(() => {
  // Reset by re-setting relevant fields to defaults
  useExecutionStore.setState({ continueOnError: true, currentRun: null, isRunning: false });
});

describe("executionStore — continueOnError", () => {
  it("initializes continueOnError to true", () => {
    expect(useExecutionStore.getState().continueOnError).toBe(true);
  });

  it("setContinueOnError sets to false", () => {
    useExecutionStore.getState().setContinueOnError(false);
    expect(useExecutionStore.getState().continueOnError).toBe(false);
  });

  it("setContinueOnError can be toggled back to true", () => {
    useExecutionStore.getState().setContinueOnError(false);
    useExecutionStore.getState().setContinueOnError(true);
    expect(useExecutionStore.getState().continueOnError).toBe(true);
  });
});

describe("executionStore — file changes", () => {
  it("records changes on the current run and forgets reverted files", () => {
    useExecutionStore.getState().startRun("W");
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    useExecutionStore.getState().recordFileChange("b.ts", null, "new", "Coder");
    useExecutionStore.getState().forgetFileChange("a.ts");
    expect(useExecutionStore.getState().currentRun?.changes).toEqual([
      { path: "b.ts", before: null, after: "new", agents: ["Coder"], edits: 1 },
    ]);
  });

  it("ignores changes when there is no run", () => {
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    expect(useExecutionStore.getState().currentRun).toBeNull();
  });
});

describe("executionStore — runs", () => {
  it("starts a run under the id the engine gave it", () => {
    const id = useExecutionStore.getState().startRun("W", "run-42");

    expect(id).toBe("run-42");
    expect(useExecutionStore.getState().currentRun).toMatchObject({ id: "run-42", workflowName: "W", status: "running" });
  });

  // The run's changes are paths relative to this folder: Revert only writes there.
  it("records the workspace folder the run works in, and none when it was not given one", () => {
    useExecutionStore.getState().startRun("W", "run-1", "/ws-x");
    expect(useExecutionStore.getState().currentRun?.workspacePath).toBe("/ws-x");

    useExecutionStore.getState().startRun("W", "run-2");
    expect(useExecutionStore.getState().currentRun).not.toHaveProperty("workspacePath");
  });

  it("keeps the workspace folder when the run finishes or is stopped", () => {
    useExecutionStore.getState().startRun("W", "run-1", "/ws-x");
    useExecutionStore.getState().finishRun("done");
    expect(useExecutionStore.getState().currentRun?.workspacePath).toBe("/ws-x");

    useExecutionStore.getState().startRun("W", "run-2", "/ws-x");
    useExecutionStore.getState().cancelRun();
    expect(useExecutionStore.getState().currentRun?.workspacePath).toBe("/ws-x");
  });
});

describe("executionStore — clearRun", () => {
  const startCoderRun = () => {
    const store = useExecutionStore.getState();
    store.startRun("Fix the sum bug", "run-1", "/ws-x");
    store.updateAgent("agent-0", { agentName: "Coder", status: "done", output: "fixed sum.mjs" });
    store.recordFileChange("src/sum.mjs", "a", "b", "Coder");
  };
  const currentRun = () => useExecutionStore.getState().currentRun;

  it("drops the per-agent results of a finished run and keeps the run: its workflow, status, timing, workspace folder and changes", () => {
    startCoderRun();
    useExecutionStore.getState().finishRun("done");
    const finished = currentRun()!;

    useExecutionStore.getState().clearRun();

    expect(currentRun()?.agents).toEqual({});
    expect(currentRun()).toMatchObject({
      id: "run-1", workflowName: "Fix the sum bug", status: "done", workspacePath: "/ws-x",
      startedAt: finished.startedAt, finishedAt: finished.finishedAt,
    });
    expect(currentRun()?.changes).toEqual([
      { path: "src/sum.mjs", before: "a", after: "b", agents: ["Coder"], edits: 1 },
    ]);
    expect(useExecutionStore.getState().isRunning).toBe(false);
  });

  it("keeps a stopped run's status and changes too", () => {
    startCoderRun();
    useExecutionStore.getState().cancelRun();

    useExecutionStore.getState().clearRun();

    expect(currentRun()).toMatchObject({ id: "run-1", status: "cancelled" });
    expect(currentRun()?.agents).toEqual({});
    expect(currentRun()?.changes).toHaveLength(1);
  });

  it("leaves a run that is still going as it is", () => {
    startCoderRun();
    const before = currentRun();

    useExecutionStore.getState().clearRun();

    expect(currentRun()).toBe(before);
    expect(currentRun()?.agents["agent-0"]?.output).toBe("fixed sum.mjs");
  });

  it("does nothing without a run, and again on a run that is already cleared", () => {
    useExecutionStore.getState().clearRun();
    expect(currentRun()).toBeNull();

    startCoderRun();
    useExecutionStore.getState().finishRun("done");
    useExecutionStore.getState().clearRun();
    const cleared = currentRun();
    useExecutionStore.getState().clearRun();

    expect(currentRun()).toBe(cleared);
  });

  // Stop ends the run at once, but an agent still working finishes late and reports "stopped".
  it("does not let a late update of the cleared run bring its results back", () => {
    startCoderRun();
    useExecutionStore.getState().cancelRun();
    useExecutionStore.getState().clearRun();

    useExecutionStore.getState().updateAgent("agent-0", { status: "stopped", output: "stale" });
    useExecutionStore.getState().updateAgent("agent-1", { status: "stopped" });

    expect(currentRun()?.agents).toEqual({});
  });

  it("still records a file that a stopped agent writes after the run was cleared: it is on disk and must stay revertible", () => {
    startCoderRun();
    useExecutionStore.getState().cancelRun();
    useExecutionStore.getState().clearRun();

    useExecutionStore.getState().recordFileChange("src/late.mjs", null, "x", "Coder");

    expect(currentRun()?.changes?.map((c) => c.path)).toEqual(["src/sum.mjs", "src/late.mjs"]);
  });

  it("gives the next run a clean start: its agents update again", () => {
    startCoderRun();
    useExecutionStore.getState().finishRun("done");
    useExecutionStore.getState().clearRun();

    useExecutionStore.getState().startRun("Next", "run-2");
    useExecutionStore.getState().updateAgent("agent-0", { status: "running" });

    expect(currentRun()).toMatchObject({ id: "run-2", workflowName: "Next" });
    expect(currentRun()?.agentsCleared).toBeUndefined();
    expect(currentRun()?.agents["agent-0"]?.status).toBe("running");
  });
});

describe("executionStore — the local model server settings", () => {
  // The store reads localStorage when it is created: a fresh copy of it shows what a new session starts with.
  async function freshStore() {
    vi.resetModules();
    return (await import("@/store/executionStore")).useExecutionStore;
  }
  beforeEach(() => localStorage.clear());

  it("starts with no Custom model name, a 16384-token Ollama context window and a 600 s model call timeout", async () => {
    const store = await freshStore();

    expect(store.getState()).toMatchObject({ customApiModel: "", ollamaNumCtx: 16384, requestTimeoutSecs: 600 });
  });

  it("keeps a blank Custom model name blank: no hosted model's name is filled in", async () => {
    const store = await freshStore();

    store.getState().setCustomApiModel("");

    expect(store.getState().customApiModel).toBe("");
    expect((await freshStore()).getState().customApiModel).toBe("");
  });

  it("saves the context window and the timeout, and a new session starts with them", async () => {
    const store = await freshStore();

    store.getState().setOllamaNumCtx(32768);
    store.getState().setRequestTimeoutSecs(3600);

    expect(store.getState()).toMatchObject({ ollamaNumCtx: 32768, requestTimeoutSecs: 3600 });
    expect((await freshStore()).getState()).toMatchObject({ ollamaNumCtx: 32768, requestTimeoutSecs: 3600 });
  });

  it("saves 0 as a context window: the server's own default, asked for, and not the default", async () => {
    const store = await freshStore();

    store.getState().setOllamaNumCtx(0);

    expect(store.getState().ollamaNumCtx).toBe(0);
    expect((await freshStore()).getState().ollamaNumCtx).toBe(0);
  });

  it("ignores a context window or timeout that is not a whole number in range, and saves nothing", async () => {
    const store = await freshStore();

    for (const tokens of [-1, 4.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32]) store.getState().setOllamaNumCtx(tokens);
    for (const secs of [0, 29, 86401, 60.5, Number.NaN]) store.getState().setRequestTimeoutSecs(secs);

    expect(store.getState()).toMatchObject({ ollamaNumCtx: 16384, requestTimeoutSecs: 600 });
    expect(localStorage.getItem("harness_ollama_num_ctx")).toBeNull();
    expect(localStorage.getItem("harness_request_timeout_secs")).toBeNull();
  });

  it("takes the default for a saved value that is not valid", async () => {
    for (const [saved, timeout] of [["abc", "abc"], ["-5", "10"], ["", ""], ["12.5", "86401"]]) {
      localStorage.setItem("harness_ollama_num_ctx", saved);
      localStorage.setItem("harness_request_timeout_secs", timeout);

      expect((await freshStore()).getState()).toMatchObject({ ollamaNumCtx: 16384, requestTimeoutSecs: 600 });
    }
  });
});
