/**
 * Tests for providerAdapter.ts — the framework-agnostic provider call service.
 *
 * All tests use a mock InvokeFn so no Tauri runtime or network is required.
 * This was impossible before the extraction — the logic was inside a React hook.
 */
import { describe, it, expect, vi } from "vitest";
import {
  callProvider,
  callChatTurn,
  type ChatMessage,
  type ChatTurnParams,
  buildSystemMessage,
  resolveModel,
  estimateTokens,
  MODEL_ALIASES,
  REASONING_EFFORT,
  readProviderUsage,
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

  it("adds the project's instructions when given", () => {
    const msg = buildSystemMessage({
      agentName: "A", role: "worker", workflowName: "W", tools: [], memoryRead: [], memoryWrite: [],
      promptContent: "Do it.", projectInstructions: "Use pnpm.",
    });
    expect(msg.endsWith("\n\nPROJECT INSTRUCTIONS (AGENTS.md):\nUse pnpm.")).toBe(true);
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

// ── callChatTurn (native tool calling) ────────────────────────────────────────

describe("callChatTurn", () => {
  const reply = { text: "ok", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
  const history: ChatMessage[] = [{ role: "user", text: "hi" }];
  const turn = (overrides: Partial<ChatTurnParams> = {}): ChatTurnParams => {
    const { userMsg: _unused, ...base } = makeParams();
    return { ...base, messages: history, tools: [], ...overrides };
  };

  it("sends the history and tools to chat_turn with the provider's API model ID", async () => {
    const spy = vi.fn(async () => reply);
    const res = await callChatTurn(
      turn({ provider: "anthropic", model: "claude-sonnet-4.6", apiKey: "k" }), spy as unknown as InvokeFn,
    );
    expect(res).toEqual(reply);
    expect(spy).toHaveBeenCalledWith("chat_turn", expect.objectContaining({
      provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k",
      system: "You are a test agent.", messages: history, tools: [], maxTokens: 256,
    }));
  });

  it("uses the Ollama model, base URL and key for Ollama", async () => {
    const spy = vi.fn(async () => reply);
    await callChatTurn(
      turn({ provider: "ollama-cloud", ollamaModel: "gemma4-31b:cloud", ollamaBaseUrl: "https://ollama.com/api", ollamaApiKey: "ok" }),
      spy as unknown as InvokeFn,
    );
    expect(spy).toHaveBeenCalledWith("chat_turn", expect.objectContaining({
      provider: "ollama-cloud", model: "gemma4:31b-cloud", baseUrl: "https://ollama.com/api", apiKey: "ok",
    }));
  });

  it("sends a keyless custom endpoint its URL and no reasoning effort", async () => {
    const spy = vi.fn(async () => reply);
    await callChatTurn(
      turn({ provider: "openai-compatible", model: "openai", apiKey: "", customBaseUrl: " https://x/v1 ", reasoningEffort: "high" }),
      spy as unknown as InvokeFn,
    );
    expect(spy).toHaveBeenCalledWith("chat_turn", expect.objectContaining({
      provider: "openai-compatible", baseUrl: "https://x/v1", apiKey: "", reasoningEffort: null,
    }));
  });

  it("refuses a missing custom URL or a missing required key before calling", async () => {
    const spy = vi.fn(async () => reply);
    await expect(callChatTurn(turn({ provider: "openai-compatible" }), spy as unknown as InvokeFn))
      .rejects.toThrow(/Custom endpoint URL/);
    await expect(callChatTurn(turn({ apiKey: "", requiresKey: true }), spy as unknown as InvokeFn))
      .rejects.toThrow(/API key/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Ollama's context window and the model call timeout ─────────────────────────

describe("Ollama's context window and the model call timeout", () => {
  const reply = { text: "ok", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
  const turnParams = (overrides: Partial<ChatTurnParams> = {}): ChatTurnParams => {
    const { userMsg: _unused, ...base } = makeParams();
    return { ...base, messages: [{ role: "user", text: "hi" }], tools: [], ...overrides };
  };
  /** The arguments the one invoke got. */
  const argsOf = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[0][1] as Record<string, unknown>;

  it("sends an Ollama text call the window and the timeout", async () => {
    const spy = vi.fn().mockResolvedValue("ok");
    await callProvider(
      makeParams({ provider: "ollama", apiKey: "", requiresKey: false, ollamaNumCtx: 8192, requestTimeoutSecs: 1800 }),
      spy as unknown as InvokeFn,
    );
    expect(spy).toHaveBeenCalledWith("call_ollama_api", expect.objectContaining({ numCtx: 8192, requestTimeoutSecs: 1800 }));
  });

  it("sends 0 as it is, and sends neither when the caller has none (the commands' defaults apply)", async () => {
    const zero = vi.fn().mockResolvedValue("ok");
    await callProvider(makeParams({ provider: "ollama", ollamaNumCtx: 0 }), zero as unknown as InvokeFn);
    expect(argsOf(zero).numCtx).toBe(0);

    const none = vi.fn().mockResolvedValue("ok");
    await callProvider(makeParams({ provider: "ollama" }), none as unknown as InvokeFn);
    expect(argsOf(none)).not.toHaveProperty("numCtx");
    expect(argsOf(none)).not.toHaveProperty("requestTimeoutSecs");
  });

  it("sends the window to Ollama Cloud's command too: the backend leaves it out for ollama.com by the host", async () => {
    const spy = vi.fn().mockResolvedValue("ok");
    await callProvider(
      makeParams({ provider: "ollama-cloud", ollamaBaseUrl: "http://192.168.1.20:11434", ollamaNumCtx: 4096 }),
      spy as unknown as InvokeFn,
    );
    expect(argsOf(spy)).toMatchObject({ baseUrl: "http://192.168.1.20:11434", numCtx: 4096 });
  });

  it("sends the timeout, and no window, to a Custom endpoint, OpenAI and Anthropic", async () => {
    for (const [provider, command, extra] of [
      ["openai-compatible", "call_openai_api", { customBaseUrl: "http://localhost:8080/v1" }],
      ["openai", "call_openai_api", {}],
      ["anthropic", "call_claude_api", { model: "claude-haiku-4.5" }],
    ] as const) {
      const spy = vi.fn().mockResolvedValue("ok");
      await callProvider(makeParams({ provider, ollamaNumCtx: 8192, requestTimeoutSecs: 900, ...extra }), spy as unknown as InvokeFn);
      expect(spy).toHaveBeenCalledWith(command, expect.objectContaining({ requestTimeoutSecs: 900 }));
      expect(argsOf(spy), provider).not.toHaveProperty("numCtx");
    }
  });

  it("gives the billing fallback to local Ollama the window and the timeout", async () => {
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error("billing: insufficient quota"))
      .mockResolvedValueOnce("fallback");
    await callProvider(makeParams({ ollamaNumCtx: 6000, requestTimeoutSecs: 1200 }), spy as unknown as InvokeFn);
    expect(spy).toHaveBeenLastCalledWith("call_ollama_api", expect.objectContaining({ numCtx: 6000, requestTimeoutSecs: 1200 }));
  });

  it("sends an Ollama turn the window and the timeout", async () => {
    const spy = vi.fn(async () => reply);
    await callChatTurn(
      turnParams({ provider: "ollama", ollamaNumCtx: 8192, requestTimeoutSecs: 1800 }), spy as unknown as InvokeFn,
    );
    expect(spy).toHaveBeenCalledWith("chat_turn", expect.objectContaining({ numCtx: 8192, requestTimeoutSecs: 1800 }));
  });

  it("sends a turn 0, or nothing, as the caller has it", async () => {
    const zero = vi.fn(async () => reply);
    await callChatTurn(turnParams({ provider: "ollama-cloud", ollamaNumCtx: 0 }), zero as unknown as InvokeFn);
    expect((zero.mock.calls[0] as unknown[])[1]).toMatchObject({ numCtx: 0 });

    const none = vi.fn(async () => reply);
    await callChatTurn(turnParams({ provider: "ollama" }), none as unknown as InvokeFn);
    const args = (none.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("numCtx");
    expect(args).not.toHaveProperty("requestTimeoutSecs");
  });

  it("sends the timeout, and no window, with the turn of a Custom endpoint, OpenAI and Anthropic", async () => {
    for (const overrides of [
      { provider: "openai-compatible", customBaseUrl: "http://localhost:8080/v1", apiKey: "" },
      { provider: "openai" },
      { provider: "anthropic", model: "claude-haiku-4.5" },
    ] as const) {
      const spy = vi.fn(async () => reply);
      await callChatTurn(turnParams({ ...overrides, ollamaNumCtx: 8192, requestTimeoutSecs: 900 }), spy as unknown as InvokeFn);
      const args = (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(args.requestTimeoutSecs, overrides.provider).toBe(900);
      expect(args, overrides.provider).not.toHaveProperty("numCtx");
    }
  });
});

// ── Token usage ───────────────────────────────────────────────────────────────

describe("readProviderUsage", () => {
  it("reads a pair of whole token counts, 0 included", () => {
    expect(readProviderUsage({ input: 120, output: 30 })).toEqual({ input: 120, output: 30 });
    expect(readProviderUsage({ input: 0, output: 0 })).toEqual({ input: 0, output: 0 });
    // Only the two counts: anything else the object holds is not carried on.
    expect(readProviderUsage({ input: 1, output: 2, total: 3 })).toEqual({ input: 1, output: 2 });
  });

  it("is null for anything else: nothing, a missing count, a count that is not a whole number or is negative", () => {
    for (const value of [
      undefined, null, 5, "120", [], [120, 30], {}, { input: 120 }, { output: 30 }, { input: "120", output: 30 },
      { input: 120.5, output: 30 }, { input: -1, output: 30 }, { input: 120, output: null }, { input: NaN, output: 30 },
      { input: Infinity, output: 30 }, { input: 2 ** 60, output: 30 },
    ]) {
      expect(readProviderUsage(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("callProvider — token usage", () => {
  const usage = { input: 120, output: 30 };
  const paths = [
    ["openai", "call_openai_api", {}],
    ["anthropic", "call_claude_api", { model: "claude-haiku-4.5" }],
    ["ollama", "call_ollama_api", {}],
    ["ollama-cloud", "call_ollama_api", { ollamaBaseUrl: "http://192.168.1.20:11434" }],
    ["openai-compatible", "call_openai_api", { customBaseUrl: "http://localhost:8080/v1" }],
  ] as const;

  it("takes the text and the usage from the object a current harness-core or app answers, on every path", async () => {
    for (const [provider, command, extra] of paths) {
      const spy = vi.fn().mockResolvedValue({ text: `from ${provider}`, usage });

      const res = await callProvider(makeParams({ provider, ...extra }), spy as unknown as InvokeFn);

      expect(res, provider).toEqual({ text: `from ${provider}`, usage, usedOllamaFallback: false });
      expect(spy).toHaveBeenCalledWith(command, expect.anything());
    }
  });

  it("takes a plain string as a reply with no usage: that is what an older harness-core, the VS Code extension's invoke and test mocks answer", async () => {
    for (const [provider, , extra] of paths) {
      const spy = vi.fn().mockResolvedValue(`from ${provider}`);

      const res = await callProvider(makeParams({ provider, ...extra }), spy as unknown as InvokeFn);

      expect(res, provider).toEqual({ text: `from ${provider}`, usage: null, usedOllamaFallback: false });
    }
  });

  it("has no usage for an object reply that leaves it out or whose usage is not a pair of token counts, and still has the text", async () => {
    for (const reply of [
      { text: "hi" }, { text: "hi", usage: null }, { text: "hi", usage: {} }, { text: "hi", usage: { input: 12 } },
      { text: "hi", usage: { input: "12", output: 3 } }, { text: "hi", usage: { input: -12, output: 3 } },
    ]) {
      const spy = vi.fn().mockResolvedValue(reply);

      const res = await callProvider(makeParams({ provider: "ollama" }), spy as unknown as InvokeFn);

      expect(res, JSON.stringify(reply)).toEqual({ text: "hi", usage: null, usedOllamaFallback: false });
    }
  });

  it("passes the arguments of the call on as it did: the command names and the arguments do not change", async () => {
    const spy = vi.fn().mockResolvedValue({ text: "hi", usage });
    await callProvider(makeParams({ reasoningEffort: "high", requestTimeoutSecs: 900 }), spy as unknown as InvokeFn);
    expect(spy).toHaveBeenCalledWith("call_openai_api", {
      model: "gpt-4o-mini", system: "You are a test agent.", userMessage: "Hello", apiKey: "sk-test", maxTokens: 256,
      reasoningEffort: "high", baseUrl: null, requestTimeoutSecs: 900,
    });
  });

  describe("after a billing error", () => {
    const billing = new Error("billing: insufficient quota");

    it("is the fallback call's usage: the call that failed had none, and the fallback is a model call of its own", async () => {
      const spy = vi.fn().mockRejectedValueOnce(billing).mockResolvedValueOnce({ text: "from Ollama", usage });

      const res = await callProvider(makeParams(), spy as unknown as InvokeFn);

      expect(res).toEqual({ text: "from Ollama\n[ran on Ollama fallback]", usage, usedOllamaFallback: true });
      expect(spy).toHaveBeenLastCalledWith("call_ollama_api", expect.anything());
    });

    it("is none when the fallback's reply is a plain string", async () => {
      const spy = vi.fn().mockRejectedValueOnce(billing).mockResolvedValueOnce("from Ollama");

      const res = await callProvider(makeParams(), spy as unknown as InvokeFn);

      expect(res).toEqual({ text: "from Ollama\n[ran on Ollama fallback]", usage: null, usedOllamaFallback: true });
    });

    it("is not asked of a hosted call that fails for another reason: the error stands, with no usage to count", async () => {
      const spy = vi.fn().mockRejectedValue(new Error("Network timeout"));
      await expect(callProvider(makeParams(), spy as unknown as InvokeFn)).rejects.toThrow("Network timeout");
    });
  });
});

describe("callChatTurn — token usage", () => {
  const turnParams = (): ChatTurnParams => {
    const { userMsg: _unused, ...base } = makeParams();
    return { ...base, messages: [{ role: "user", text: "hi" }], tools: [] };
  };

  it("hands the reply's usage on as chat_turn sent it", async () => {
    const reply = { text: "ok", toolCalls: [], finishReason: "stop", nativeToolsSupported: true, usage: { input: 120, output: 30 } };
    const spy = vi.fn(async () => reply);

    expect(await callChatTurn(turnParams(), spy as unknown as InvokeFn)).toEqual(reply);
  });

  it("has none for a reply from an older harness-core or a server that sent no counts", async () => {
    const reply = { text: "ok", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    const spy = vi.fn(async () => reply);

    const res = await callChatTurn(turnParams(), spy as unknown as InvokeFn);

    expect(res.usage).toBeUndefined();
  });
});
