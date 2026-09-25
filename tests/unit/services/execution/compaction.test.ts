import { describe, it, expect, vi } from "vitest";
import {
  compactNative, compactText, needsCompaction, truncateMiddle,
} from "@/services/execution/compaction";
import type { ChatMessage } from "@/services/model-providers/providerAdapter";

const call = (id: string) => ({ id, name: "read_file", args: { path: `${id}.md` } });
const result = (id: string, content: string) => ({ id, name: "read_file", content, isError: false });

/** user task, then `turns` tool exchanges. */
function history(turns: number, content = "file text"): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", text: "Fix the bug." }];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: "assistant", text: `step ${i}`, toolCalls: [call(`c${i}`)] });
    messages.push({ role: "tool", toolResults: [result(`c${i}`, `${content} ${i}`)] });
  }
  return messages;
}

describe("needsCompaction", () => {
  it("starts past 75% of the budget, and never without one", () => {
    expect(needsCompaction(7500, 10000)).toBe(false);
    expect(needsCompaction(7501, 10000)).toBe(true);
    expect(needsCompaction(99999, 0)).toBe(false);
  });
});

describe("truncateMiddle", () => {
  it("keeps the start and the end", () => {
    const cut = truncateMiddle(`${"a".repeat(500)}${"b".repeat(500)}`, 200);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("bbb")).toBe(true);
    expect(cut).toMatch(/characters cut/);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(truncateMiddle("short", 200)).toBe("short");
  });
});

describe("compactNative", () => {
  it("replaces the older steps with a note and keeps the newest exchange verbatim", async () => {
    const summarize = vi.fn(async (_text: string) => "Read c1 and c2; the bug is in c2.");
    const messages = history(3);

    const { messages: compacted, steps } = await compactNative(messages, 100_000, summarize);

    expect(steps).toBe(2);
    expect(compacted).toHaveLength(3);
    expect(compacted[0]).toEqual({
      role: "user",
      text: "Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nRead c1 and c2; the bug is in c2.",
    });
    expect(compacted.slice(1)).toEqual(messages.slice(-2));
    const input = summarize.mock.calls[0][0] as string;
    expect(input).toContain("Fix the bug.");
    expect(input).toContain("CALLED read_file");
    expect(input).toContain("file text 2");
    expect(input).not.toContain("file text 3");
  });

  it("replaces an earlier note instead of stacking notes", async () => {
    const first = await compactNative(history(3), 100_000, async () => "note one");
    const again = [...first.messages, ...history(2).slice(1)];

    const { messages } = await compactNative(again, 100_000, async () => "note two");

    expect((messages[0] as { text: string }).text).toBe(
      "Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nnote two");
  });

  it("leaves a conversation with one exchange as it is", async () => {
    const summarize = vi.fn(async () => "x");
    const messages = history(1);
    expect(await compactNative(messages, 100, summarize)).toEqual({ messages, steps: 0 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("cuts kept tool results that alone are too big", async () => {
    const { messages } = await compactNative(history(2, "x".repeat(50_000)), 1000, async () => "note");
    const kept = messages[2] as { role: "tool"; toolResults: Array<{ content: string }> };
    expect(kept.toolResults[0].content.length).toBeLessThan(2000);
    expect(kept.toolResults[0].content).toMatch(/characters cut/);
  });
});

describe("compactText", () => {
  it("keeps the task, a new note and the newest step", async () => {
    const summarize = vi.fn(async () => "note");
    const text = await compactText("Fix the bug.", "Fix the bug.\n\n[Step 1…]\n\n[Step 2…]", "[Step 2…]", summarize);
    expect(text).toBe("Fix the bug.\n\nPROGRESS SO FAR (summary of earlier steps):\nnote\n\n[Step 2…]");
  });
});
