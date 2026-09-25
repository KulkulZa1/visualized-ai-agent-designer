import { describe, it, expect } from "vitest";
import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";

describe("loadProjectInstructions", () => {
  it("reads AGENTS.md from the workspace root", async () => {
    const read = async (path: string) => { expect(path).toBe("AGENTS.md"); return "Use pnpm."; };
    expect(await loadProjectInstructions(read)).toBe("Use pnpm.");
  });

  it("is empty when there is no AGENTS.md", async () => {
    expect(await loadProjectInstructions(async () => { throw new Error("(os error 2)"); })).toBe("");
  });

  it("caps a long file at 32 KB", async () => {
    const text = await loadProjectInstructions(async () => "x".repeat(40_000));
    expect(text.length).toBeLessThan(33_000);
    expect(text).toMatch(/truncated at 32 KB/);
  });
});

describe("usesWorkspace", () => {
  it("is true for agents with a workspace tool", () => {
    expect(usesWorkspace(["read_file"])).toBe(true);
    expect(usesWorkspace(["bash"])).toBe(true);
    expect(usesWorkspace(["web_search", "subagent_dispatch"])).toBe(false);
    expect(usesWorkspace([])).toBe(false);
  });
});
