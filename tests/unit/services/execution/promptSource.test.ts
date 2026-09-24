import { describe, it, expect, vi } from "vitest";
import { resolvePromptContent } from "@/services/execution/promptSource";

describe("resolvePromptContent", () => {
  it("returns inline prompt content without touching the filesystem", async () => {
    const readFile = vi.fn();
    await expect(
      resolvePromptContent({ type: "inline", content: "Be concise." }, "/ws", readFile),
    ).resolves.toBe("Be concise.");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reads file prompts from the workspace instead of sending a placeholder", async () => {
    const readFile = vi.fn().mockResolvedValue("# Status\nShip it.");
    await expect(
      resolvePromptContent({ type: "file", path: "docs/PROJECT_STATUS.md" }, "/ws", readFile),
    ).resolves.toBe("# Status\nShip it.");
    expect(readFile).toHaveBeenCalledWith("/ws", "docs/PROJECT_STATUS.md");
  });

  it("fails clearly when a file prompt is used without an open workspace", async () => {
    await expect(
      resolvePromptContent({ type: "file", path: "docs/PROJECT_STATUS.md" }, null, vi.fn()),
    ).rejects.toThrow(/docs\/PROJECT_STATUS\.md.*no workspace/i);
  });

  it("fails clearly when the prompt file cannot be read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("File not found"));
    await expect(
      resolvePromptContent({ type: "file", path: "missing.md" }, "/ws", readFile),
    ).rejects.toThrow(/missing\.md.*File not found/);
  });
});
