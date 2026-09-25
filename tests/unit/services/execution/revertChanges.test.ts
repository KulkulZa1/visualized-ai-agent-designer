import { describe, it, expect, vi } from "vitest";
import { revertChange } from "@/services/execution/revertChanges";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

function disk(files: Record<string, string>): InvokeFn {
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.relativePath as string;
    if (cmd === "read_workspace_file") {
      if (path in files) return files[path];
      throw new Error("IO error: not found (os error 2)");
    }
    if (cmd === "write_workspace_file") { files[path] = args?.content as string; return undefined; }
    if (cmd === "delete_workspace_file") { delete files[path]; return undefined; }
    throw new Error(`Unexpected: ${cmd}`);
  }) as unknown as InvokeFn;
}

describe("revertChange", () => {
  it("restores a modified file", async () => {
    const files = { "a.ts": "new" };
    const outcome = await revertChange(
      { path: "a.ts", before: "old", after: "new", agents: ["A"], edits: 1 }, "/w", disk(files));
    expect(outcome).toBe("reverted");
    expect(files).toEqual({ "a.ts": "old" });
  });

  it("deletes a file the run created", async () => {
    const files: Record<string, string> = { "new.ts": "x" };
    await revertChange({ path: "new.ts", before: null, after: "x", agents: ["A"], edits: 1 }, "/w", disk(files));
    expect(files).toEqual({});
  });

  it("does not overwrite a file that changed since, unless forced", async () => {
    const files = { "a.ts": "edited by you" };
    const change = { path: "a.ts", before: "old", after: "new", agents: ["A"], edits: 1 };
    expect(await revertChange(change, "/w", disk(files))).toBe("changed-since");
    expect(files["a.ts"]).toBe("edited by you");
    expect(await revertChange(change, "/w", disk(files), true)).toBe("reverted");
    expect(files["a.ts"]).toBe("old");
  });
});
