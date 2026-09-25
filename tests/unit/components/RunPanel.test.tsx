import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "@/components/execution/RunPanel";
import { useExecutionStore } from "@/store/executionStore";

vi.mock("@/components/editor/monacoLocal", () => ({ default: () => null, DiffEditor: () => null }));

beforeEach(() => {
  useExecutionStore.setState({
    currentRun: {
      id: "run-1", workflowName: "W", startedAt: 0, status: "done", agents: {},
      changes: [{ path: "a.ts", before: "1", after: "2", agents: ["A"], edits: 1 }],
    },
    isRunning: false,
  });
});

describe("RunPanel", () => {
  it("opens the Changes dialog from the changed-file count", () => {
    render(<RunPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    expect(screen.getByRole("dialog", { name: /Changes/ })).toBeTruthy();
  });
});
