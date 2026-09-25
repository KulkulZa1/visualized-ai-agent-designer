import { describe, it, expect, vi } from "vitest";
import { callChatTurn, type ChatTurnParams, type InvokeFn } from "@/services/model-providers/providerAdapter";

const params: ChatTurnParams = {
  provider: "ollama", model: "llama3", rawModel: "llama3", maxTokens: 256, apiKey: "",
  requiresKey: false, systemMsg: "sys", messages: [{ role: "user", text: "hi" }], tools: [],
  ollamaBaseUrl: "http://localhost:11434", ollamaModel: "llama3", reasoningEffort: null,
};

const reply = { text: "Hello", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };

describe("callChatTurn streaming", () => {
  it("passes a channel whose messages reach onDelta", async () => {
    const pieces: string[] = [];
    const invoke = vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
      const channel = args.onDelta as { onmessage: (d: { text: string }) => void };
      channel.onmessage({ text: "He" });
      channel.onmessage({ text: "llo" });
      return reply;
    }) as unknown as InvokeFn;

    const result = await callChatTurn(params, invoke, (text) => pieces.push(text));

    expect(pieces).toEqual(["He", "llo"]);
    expect(result.text).toBe("Hello");
  });

  it("sends no channel without onDelta", async () => {
    const invoke = vi.fn(async () => reply);
    await callChatTurn(params, invoke as unknown as InvokeFn);
    expect((invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].onDelta).toBeNull();
  });
});
