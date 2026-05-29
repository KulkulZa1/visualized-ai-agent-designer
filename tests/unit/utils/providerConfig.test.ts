import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CREDIT_MESSAGE,
  OPENAI_QUOTA_MESSAGE,
  OPENAI_RATE_LIMIT_MESSAGE,
  defaultProviderConfig,
  hasOllamaCredentialForEndpoint,
  isOllamaCloudUrl,
  isRemoteOllamaUrl,
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

  it("reads Ollama Cloud env config without exposing key values", () => {
    const config = defaultProviderConfig({
      LLM_PROVIDER: "ollama-cloud",
      OLLAMA_API_KEY: "ollama-secret-test-value",
    });

    expect(config.provider).toBe("ollama-cloud");
    expect(config.ollamaBaseUrl).toBe("https://ollama.com/api");
    expect(config.ollamaModel).toBe("gemma4:31b-cloud");
    expect(config.hasOllamaApiKey).toBe(true);
  });

  it("scopes Ollama credentials to the endpoint class", () => {
    expect(hasOllamaCredentialForEndpoint({
      OLLAMA_API_KEY: "cloud-key",
      OLLAMA_REMOTE_API_KEY: "",
    }, "https://ollama.com/api")).toBe(true);
    expect(hasOllamaCredentialForEndpoint({
      OLLAMA_API_KEY: "cloud-key",
      OLLAMA_REMOTE_API_KEY: "",
    }, "https://private-ollama.example.com")).toBe(false);
    expect(hasOllamaCredentialForEndpoint({
      OLLAMA_API_KEY: "",
      OLLAMA_REMOTE_API_KEY: "remote-key",
    }, "https://private-ollama.example.com")).toBe(true);
    expect(hasOllamaCredentialForEndpoint({
      OLLAMA_API_KEY: "cloud-key",
      OLLAMA_REMOTE_API_KEY: "remote-key",
    }, "http://localhost:11434")).toBe(false);
  });

  it("detects non-local Ollama URLs as remote", () => {
    expect(isOllamaCloudUrl("https://ollama.com:443/api")).toBe(true);
    expect(isRemoteOllamaUrl("https://ollama.com/api")).toBe(true);
    expect(isRemoteOllamaUrl("https://private-ollama.example.com")).toBe(true);
    expect(isRemoteOllamaUrl("http://localhost:11434")).toBe(false);
    expect(isRemoteOllamaUrl("http://127.0.0.1:11434")).toBe(false);
  });

  it("selects Ollama Cloud override while preserving the configured model", () => {
    const selected = selectProviderForModel({
      mode: "ollama-cloud",
      model: "claude-sonnet-4.6",
      hasOpenAIKey: false,
      hasAnthropicKey: false,
      ollamaModel: "gpt-oss:120b",
    });

    expect(selected.provider).toBe("ollama-cloud");
    expect(selected.model).toBe("gpt-oss:120b");
    expect(selected.requiresKey).toBe(false);
  });

  it("falls back to Ollama for billing failures but not rate limits", () => {
    expect(shouldFallbackToOllama(OPENAI_QUOTA_MESSAGE)).toBe(true);
    expect(shouldFallbackToOllama(ANTHROPIC_CREDIT_MESSAGE)).toBe(true);
    expect(shouldFallbackToOllama(OPENAI_RATE_LIMIT_MESSAGE)).toBe(false);
  });
});
