import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CREDIT_MESSAGE,
  OPENAI_QUOTA_MESSAGE,
  OPENAI_RATE_LIMIT_MESSAGE,
  defaultProviderConfig,
  maskApiKey,
  selectProviderForModel,
  shouldFallbackToOllama,
} from "@/utils/providerConfig";

describe("providerConfig", () => {
  it("masks API keys without exposing the full value", () => {
    expect(maskApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("sk-p****wxyz");
    expect(maskApiKey("")).toBe("<empty>");
    expect(maskApiKey("short")).toBe("****");
  });

  it("reads local fallback defaults from LLM_PROVIDER style env config", () => {
    const config = defaultProviderConfig({
      LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "qwen2.5-coder:7b",
      OPENAI_API_KEY: "sk-proj-test",
      ANTHROPIC_API_KEY: "",
    });

    expect(config.provider).toBe("ollama");
    expect(config.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(config.ollamaModel).toBe("qwen2.5-coder:7b");
    expect(config.hasOpenAIKey).toBe(true);
    expect(config.hasAnthropicKey).toBe(false);
  });

  it("selects Ollama override without requiring hosted provider keys", () => {
    const selected = selectProviderForModel({
      mode: "ollama",
      model: "claude-sonnet-4.6",
      hasOpenAIKey: false,
      hasAnthropicKey: false,
      ollamaModel: "qwen2.5-coder:7b",
    });

    expect(selected.provider).toBe("ollama");
    expect(selected.model).toBe("qwen2.5-coder:7b");
    expect(selected.requiresKey).toBe(false);
  });

  it("falls back to Ollama for billing failures but not rate limits", () => {
    expect(shouldFallbackToOllama(OPENAI_QUOTA_MESSAGE)).toBe(true);
    expect(shouldFallbackToOllama(ANTHROPIC_CREDIT_MESSAGE)).toBe(true);
    expect(shouldFallbackToOllama(OPENAI_RATE_LIMIT_MESSAGE)).toBe(false);
  });
});
