import { describe, it, expect } from "vitest";

// The formula used in useWorkflowExecution after a successful agent response:
// Math.ceil((systemMsg.length + userMsg.length + result.length) / 4)
function estimateTokens(systemMsg: string, userMsg: string, result: string): number {
  return Math.ceil((systemMsg.length + userMsg.length + result.length) / 4);
}

describe("token estimate formula", () => {
  it("returns 1 for a 4-char total", () => {
    expect(estimateTokens("a", "b", "cd")).toBe(1);
  });

  it("rounds up for non-multiples of 4", () => {
    expect(estimateTokens("abc", "", "")).toBe(1);     // 3/4 = 0.75 → ceil = 1
    expect(estimateTokens("abcde", "", "")).toBe(2);   // 5/4 = 1.25 → ceil = 2
  });

  it("handles exact multiples", () => {
    expect(estimateTokens("abcd", "", "")).toBe(1);    // 4/4 = 1
    expect(estimateTokens("abcdefgh", "", "")).toBe(2); // 8/4 = 2
  });

  it("returns 0 for empty strings", () => {
    expect(estimateTokens("", "", "")).toBe(0);
  });

  it("is proportional to a realistic payload size", () => {
    // 400 chars total → ~100 tokens
    const s = "x".repeat(400);
    expect(estimateTokens(s, "", "")).toBe(100);
  });

  it("AgentRun type has providerUsed and modelUsed fields (type check)", () => {
    // This is a compile-time check — if the type is missing these fields, tsc will fail.
    const run: import("@/types/execution").AgentRun = {
      agentId: "test",
      agentName: "Test",
      status: "done",
      providerUsed: "anthropic",
      modelUsed: "claude-haiku-4.5",
      tokenEstimate: 42,
    };
    expect(run.providerUsed).toBe("anthropic");
    expect(run.modelUsed).toBe("claude-haiku-4.5");
    expect(run.tokenEstimate).toBe(42);
  });
});
