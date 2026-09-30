import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CREDIT_MESSAGE,
  OPENAI_QUOTA_MESSAGE,
  OPENAI_RATE_LIMIT_MESSAGE,
  defaultProviderConfig,
  hasOllamaCredentialForEndpoint,
  isOllamaCloudUrl,
  isRemoteOllamaUrl,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_REQUEST_TIMEOUT_SECS,
  MAX_REQUEST_TIMEOUT_SECS,
  MIN_REQUEST_TIMEOUT_SECS,
  maskApiKey,
  parseNumCtx,
  parseRequestTimeoutSecs,
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

  it("treats the IPv6 loopback as local although URL reports its host in brackets", () => {
    expect(new URL("http://[::1]:11434").hostname).toBe("[::1]");
    expect(isRemoteOllamaUrl("http://[::1]:11434")).toBe(false);
    expect(isRemoteOllamaUrl("http://[::1]")).toBe(false);
    expect(isRemoteOllamaUrl("https://[::1]:11434/api")).toBe(false);
    expect(isRemoteOllamaUrl(" HTTP://[0:0:0:0:0:0:0:1]:11434 ")).toBe(false); // URL shortens it to [::1]
    expect(isRemoteOllamaUrl("http://[::2]:11434")).toBe(true);
    expect(isRemoteOllamaUrl("http://[2001:db8::1]:11434")).toBe(true);
  });

  it("treats every 127.x.x.x address as local, and only those", () => {
    for (const url of [
      "http://127.0.0.2:11434",
      "http://127.1.2.3",
      "http://127.255.255.254:11434/api",
      "http://127.1:11434", // URL expands it to 127.0.0.1
    ]) {
      expect(isRemoteOllamaUrl(url), url).toBe(false);
    }
    for (const url of [
      "http://128.0.0.1:11434",
      "http://126.255.255.255",
      "http://10.0.0.5:11434",
      "http://127.0.0.1.example.com:11434", // a hostname that only starts like an address
      "http://localhost.example.com:11434",
    ]) {
      expect(isRemoteOllamaUrl(url), url).toBe(true);
    }
  });

  it("classifies loopback hosts the same way when the URL does not parse", () => {
    // A port out of range makes `new URL` throw, so the host is read from the text.
    expect(() => new URL("http://localhost:99999")).toThrow();
    for (const url of [
      "http://localhost:99999",
      "http://127.0.0.1:99999",
      "http://127.0.0.5:99999",
      "http://[::1]:99999",
      "http://[::1]:99999/api",
    ]) {
      expect(isRemoteOllamaUrl(url), url).toBe(false);
    }
    expect(isRemoteOllamaUrl("http://[::2]:99999")).toBe(true);
    expect(isRemoteOllamaUrl("http://example.com:99999")).toBe(true);
  });

  it("does not ask for a remote credential on an IPv6 loopback endpoint", () => {
    expect(hasOllamaCredentialForEndpoint({ OLLAMA_REMOTE_API_KEY: "remote-key" }, "http://[::1]:11434")).toBe(false);
    expect(hasOllamaCredentialForEndpoint({ OLLAMA_REMOTE_API_KEY: "remote-key" }, "http://127.0.0.2:11434")).toBe(false);
    expect(defaultProviderConfig({
      LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://[::1]:11434",
      OLLAMA_REMOTE_API_KEY: "remote-key",
    }).hasOllamaApiKey).toBe(false);
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

describe("the local model server settings", () => {
  it("defaults to a 16384-token context window and a 600 s model call timeout, the backend's own defaults", () => {
    expect(DEFAULT_OLLAMA_NUM_CTX).toBe(16384);
    expect(DEFAULT_REQUEST_TIMEOUT_SECS).toBe(600);
    expect([MIN_REQUEST_TIMEOUT_SECS, MAX_REQUEST_TIMEOUT_SECS]).toEqual([30, 86400]);
  });

  it("reads a context window as a whole number of tokens, 0 included, or null", () => {
    expect(parseNumCtx("16384")).toBe(16384);
    expect(parseNumCtx(" 4096 ")).toBe(4096);
    expect(parseNumCtx("0")).toBe(0);
    expect(parseNumCtx("4294967295")).toBe(4294967295); // the largest the Rust command takes
    for (const bad of ["", " ", "-1", "1.5", "1e3", "+5", "0x10", "16k", "abc", "4294967296", "99999999999999999999"]) {
      expect(parseNumCtx(bad), bad).toBeNull();
    }
  });

  it("reads a model call timeout as whole seconds from 30 to 86400, or null", () => {
    expect(parseRequestTimeoutSecs("600")).toBe(600);
    expect(parseRequestTimeoutSecs("30")).toBe(30);
    expect(parseRequestTimeoutSecs("86400")).toBe(86400);
    for (const bad of ["", "0", "29", "86401", "-30", "60.5", "1e3", "ten"]) {
      expect(parseRequestTimeoutSecs(bad), bad).toBeNull();
    }
  });
});
