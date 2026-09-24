/**
 * Tests for providerAdapter.ts — the framework-agnostic provider call service.
 *
 * All tests use a mock InvokeFn so no Tauri runtime or network is required.
 * This was impossible before the extraction — the logic was inside a React hook.
 */
import { describe, it, expect, vi } from "vitest";
import {
  callProvider,
  buildSystemMessage,
  resolveModel,
  estimateTokens,
  MODEL_ALIASES,
  REASONING_EFFORT,
  type ProviderCallParams,
  type InvokeFn,
} from "@/services/model-providers/providerAdapter";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<ProviderCallParams> = {}): ProviderCallParams {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    rawModel: "gpt-4o-mini",
    systemMsg: "You are a test agent.",
    userMsg: "Hello",
    maxTokens: 256,
    apiKey: "sk-test",
    requiresKey: true,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "qwen2.5-coder:7b",
    reasoningEffort: null,
    ...overrides,
  };
}

function mockInvoke(responses: Record<string, unknown>): InvokeFn {
  return <T>(cmd: string, _args?: Record<string, unknown>) => {
    if (cmd in responses) {
      const val = responses[cmd];
      if (val instanceof Error) return Promise.reject(val) as Promise<T>;
      return Promise.resolve(val as T);
    }
    return Promise.reject(new Error(`Unexpected invoke: ${cmd}`)) as Promise<T>;
  };
}

// ── resolveModel ─────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("maps gpt-5.5-xhigh to gpt-5.5", () => {
    expect(resolveModel("gpt-5.5-xhigh")).toBe("gpt-5.5");
  });
  it("maps gpt-5.5-mid to gpt-5.4-mini", () => {
    expect(resolveModel("gpt-5.5-mid")).toBe("gpt-5.4-mini");
  });
  it("passes through unknown model IDs unchanged", () => {
    expect(resolveModel("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(resolveModel("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
  it("normalizes the legacy Gemma Cloud model alias", () => {
    expect(resolveModel("gemma4-31b:cloud")).toBe("gemma4:31b-cloud");
  });
  it("MODEL_ALIASES contains expected entries", () => {
    expect(Object.keys(MODEL_ALIASES).length).toBeGreaterThan(0);
  });
  it("REASONING_EFFORT maps xhigh to high", () => {
    expect(REASONING_EFFORT["gpt-5.5-xhigh"]).toBe("high");
    expect(REASONING_EFFORT["gpt-5.5-high"]).toBe("medium");
  });
});

// ── buildSystemMessage ────────────────────────────────────────────────────────

describe("buildSystemMessage", () => {
  it("includes agent name and workflow name", () => {
    const msg = buildSystemMessage({
      agentName: "Spec Writer",
      role: "orchestrator",
      workflowName: "Purchasing Demo",
      description: "Writes specs.",
      tools: ["read_file", "fs.write"],
      memoryRead: ["task-plan"],
      memoryWrite: ["spec-path"],
      promptContent: "You write specs.",
    });
    expect(msg).toContain("Spec Writer");
    expect(msg).toContain("Purchasing Demo");
    expect(msg).toContain("orchestrator");
    expect(msg).toContain("Writes specs.");
    expect(msg).toContain("read_file");
    expect(msg).toContain("task-plan");
    expect(msg).toContain("spec-path");
    expect(msg).toContain("You write specs.");
  });

  it("handles empty tools and memory gracefully", () => {
    const msg = buildSystemMessage({
      agentName: "A", role: "worker", workflowName: "W",
      tools: [], memoryRead: [], memoryWrite: [], promptContent: "",
    });
    expect(msg).toContain("Allowed tools: none");
    expect(msg).toContain("Memory keys to read: none");
    expect(msg).toContain("Memory keys to write: none");
  });

  it("omits description line when description is undefined", () => {
    const msg = buildSystemMessage({
      agentName: "A", role: "worker", workflowName: "W",
      tools: [], memoryRead: [], memoryWrite: [], promptContent: "",
    });
    expect(msg).not.toContain("Your role:");
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates 100 chars as 25 tokens", () => {
    const s = "a".repeat(100);
    expect(estimateTokens(s, "", "")).toBe(25);
  });
  it("sums all three parts", () => {
    expect(estimateTokens("a".repeat(40), "a".repeat(40), "a".repeat(40))).toBe(30);
  });
  it("rounds up (ceil)", () => {
    expect(estimateTokens("a", "", "")).toBe(1);
    expect(estimateTokens("ab", "", "")).toBe(1);
    expect(estimateTokens("abcde", "", "")).toBe(2);
  });
});

// ── callProvider ─────────────────────────────────────────────────────────────

describe("callProvider — openai success path", () => {
  it("calls call_openai_api and returns text", async () => {
    const invokeFn = mockInvoke({ call_openai_api: "OpenAI response" });
    const res = await callProvider(makeParams(), invokeFn);
    expect(res.text).toBe("OpenAI response");
    expect(res.usedOllamaFallback).toBe(false);
  });

  it("passes reasoningEffort when provided", async () => {
    const spy = vi.fn().mockResolvedValue("response");
    await callProvider(makeParams({ reasoningEffort: "high" }), spy as unknown as InvokeFn);
    expect(spy).toHaveBeenCalledWith("call_openai_api", expect.objectContaining({ reasoningEffort: "high" }));
  });
});

describe("callProvider — anthropic success path", () => {
  it("calls call_claude_api for anthropic provider", async () => {
    const spy = vi.fn().mockResolvedValue("Claude response");
    const res = await callProvider(
      makeParams({ provider: "anthropic", model: "claude-haiku-4.5" }),
      spy as unknown as InvokeFn,
    );
    expect(res.text).toBe("Claude response");
    // The UI/YAML use dotted display versions; the Anthropic API only accepts hyphenated IDs.
    expect(spy).toHaveBeenCalledWith("call_claude_api", expect.objectContaining({ model: "claude-haiku-4-5" }));
  });

  it("sends already-valid Anthropic model IDs unchanged", async () => {
    const spy = vi.fn().mockResolvedValue("Claude response");
    await callProvider(
      makeParams({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      spy as unknown as InvokeFn,
    );
    expect(spy).toHaveBeenCalledWith("call_claude_api", expect.objectContaining({ model: "claude-sonnet-4-6" }));
  });
});

describe("callProvider — ollama path", () => {
  it("calls call_ollama_api directly (no fallback flag)", async () => {
    const spy = vi.fn().mockResolvedValue("Ollama response");
    const res = await callProvider(
      makeParams({ provider: "ollama", apiKey: "", requiresKey: false }),
      spy as unknown as InvokeFn,
    );
    expect(res.text).toBe("Ollama response");
    expect(res.usedOllamaFallback).toBe(false);
    expect(spy).toHaveBeenCalledWith("call_ollama_api", expect.anything());
  });

  it("routes Ollama Cloud through call_ollama_api with base URL and API key metadata", async () => {
    const spy = vi.fn().mockResolvedValue("Ollama Cloud response");
    const res = await callProvider(
      makeParams({
        provider: "ollama-cloud",
        apiKey: "",
        requiresKey: false,
        ollamaBaseUrl: "https://ollama.com/api",
        ollamaModel: "gemma4-31b:cloud",
        ollamaApiKey: "ollama-test-key",
      }),
      spy as unknown as InvokeFn,
    );

    expect(res.text).toBe("Ollama Cloud response");
    expect(res.usedOllamaFallback).toBe(false);
    expect(spy).toHaveBeenCalledWith("call_ollama_api", expect.objectContaining({
      baseUrl: "https://ollama.com/api",
      model: "gemma4:31b-cloud",
      apiKey: "ollama-test-key",
    }));
  });
});

describe("callProvider — billing fallback", () => {
  it("falls back to Ollama and sets usedOllamaFallback=true on billing error", async () => {
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error("billing: insufficient quota"))
      .mockResolvedValueOnce("Ollama fallback response");
    const res = await callProvider(makeParams(), spy as unknown as InvokeFn);
    expect(res.usedOllamaFallback).toBe(true);
    expect(res.text).toContain("Ollama fallback response");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-billing errors without fallback", async () => {
    const err = new Error("Network timeout");
    const spy = vi.fn().mockRejectedValue(err);
    await expect(callProvider(makeParams(), spy as unknown as InvokeFn)).rejects.toThrow("Network timeout");
  });

  it("never silently re-sends the prompt to a remote/cloud Ollama endpoint", async () => {
    const spy = vi.fn().mockRejectedValue(new Error("billing: insufficient quota"));
    await expect(
      callProvider(makeParams({ ollamaBaseUrl: "https://ollama.com/api" }), spy as unknown as InvokeFn),
    ).rejects.toThrow("insufficient quota");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("callProvider — missing API key", () => {
  it("throws immediately if requiresKey=true and apiKey is empty", async () => {
    const spy = vi.fn();
    await expect(
      callProvider(makeParams({ apiKey: "", requiresKey: true }), spy as unknown as InvokeFn)
    ).rejects.toThrow("No openai API key");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not throw when requiresKey=false and apiKey is empty (ollama)", async () => {
    const spy = vi.fn().mockResolvedValue("ok");
    await expect(
      callProvider(makeParams({ provider: "ollama", apiKey: "", requiresKey: false }), spy as unknown as InvokeFn)
    ).resolves.not.toThrow();
  });
});
