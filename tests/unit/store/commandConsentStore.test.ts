import { describe, it, expect, beforeEach } from "vitest";
import { useCommandConsentStore } from "@/store/commandConsentStore";
import { useExecutionStore } from "@/store/executionStore";

const ask = (runId: string, command: string) =>
  useCommandConsentStore.getState().request({ runId, agentName: "Tester", command, workspacePath: "/ws" });

beforeEach(() => {
  useCommandConsentStore.setState({ queue: [], grants: {} });
  useExecutionStore.setState({ currentRun: null, isRunning: false });
});

describe("commandConsentStore", () => {
  it("queues requests in order and resolves each with the user's answer", async () => {
    const first = ask("run-1", "npm test");
    const second = ask("run-1", "cargo test");
    const queue = useCommandConsentStore.getState().queue;
    expect(queue.map((r) => r.command)).toEqual(["npm test", "cargo test"]);

    useCommandConsentStore.getState().answer(queue[0].id, "allow");
    useCommandConsentStore.getState().answer(queue[1].id, "deny");

    await expect(first).resolves.toBe("allow");
    await expect(second).resolves.toBe("deny");
    expect(useCommandConsentStore.getState().queue).toEqual([]);
  });

  it("denies only the pending requests of the given run", async () => {
    const stale = ask("run-1", "npm test");
    ask("run-2", "cargo test");

    useCommandConsentStore.getState().denyRun("run-1");

    await expect(stale).resolves.toBe("deny");
    expect(useCommandConsentStore.getState().queue.map((r) => r.runId)).toEqual(["run-2"]);
  });

  it("denies the run's pending commands when the run is stopped", async () => {
    useExecutionStore.setState({
      currentRun: { id: "run-1", workflowName: "w", status: "running", startedAt: 0, agents: {} },
      isRunning: true,
    });
    const pending = ask("run-1", "npm test");

    useExecutionStore.getState().cancelRun();

    await expect(pending).resolves.toBe("deny");
    expect(useCommandConsentStore.getState().queue).toEqual([]);
  });

  it("runs a command allowed for this run again without asking, until the run ends", async () => {
    const first = ask("run-1", "npm test");
    useCommandConsentStore.getState().answer(useCommandConsentStore.getState().queue[0].id, "allow-run");
    await expect(first).resolves.toBe("allow-run");

    await expect(ask("run-1", "npm test")).resolves.toBe("granted");
    const other = ask("run-1", "npm test -- --watch");
    expect(useCommandConsentStore.getState().queue.map((r) => r.command)).toEqual(["npm test -- --watch"]);

    useCommandConsentStore.getState().denyRun("run-1");
    await expect(other).resolves.toBe("deny");
    void ask("run-1", "npm test");
    expect(useCommandConsentStore.getState().queue.map((r) => r.command)).toEqual(["npm test"]);
  });

  it("also runs the same command waiting from another agent once it is allowed for the run", async () => {
    const a = ask("run-1", "npm test");
    const b = ask("run-1", "npm test");
    useCommandConsentStore.getState().answer(useCommandConsentStore.getState().queue[0].id, "allow-run");
    await expect(a).resolves.toBe("allow-run");
    await expect(b).resolves.toBe("granted");
    expect(useCommandConsentStore.getState().queue).toEqual([]);
  });
});
