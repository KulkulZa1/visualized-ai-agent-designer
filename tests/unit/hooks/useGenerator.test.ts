import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerator } from "@/hooks/useGenerator";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

let writes: string[] = [];

beforeEach(() => {
  writes = [];
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useWorkflowStore.getState().reset();
  useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
  mockInvokeHandler("write_workspace_file", (args) => {
    writes.push((args as { relativePath: string }).relativePath);
    return undefined;
  });
});

async function generateClaudeMd(confirmOverwrite?: (path: string) => boolean) {
  const { result } = renderHook(() => useGenerator());
  let out!: Awaited<ReturnType<typeof result.current.generate>>;
  await act(async () => { out = await result.current.generate("claude_md", { confirmOverwrite }); });
  return out;
}

describe("useGenerator", () => {
  it("does not overwrite an existing hand-written file unless the user confirms", async () => {
    mockInvokeHandler("read_workspace_file", () => "# my hand-written CLAUDE.md");
    const confirm = vi.fn(() => false);

    const out = await generateClaudeMd(confirm);

    expect(confirm).toHaveBeenCalledWith("CLAUDE.md");
    expect(writes).toEqual([]);
    expect(out.written).toBe(false);
  });

  it("overwrites an existing file once confirmed", async () => {
    mockInvokeHandler("read_workspace_file", () => "# old");

    const out = await generateClaudeMd(() => true);

    expect(writes).toEqual(["CLAUDE.md"]);
    expect(out.written).toBe(true);
  });

  it("writes a new file without asking", async () => {
    mockInvokeHandler("read_workspace_file", () => Promise.reject(new Error("not found")));
    const confirm = vi.fn(() => false);

    const out = await generateClaudeMd(confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(writes).toEqual(["CLAUDE.md"]);
    expect(out.written).toBe(true);
  });
});
