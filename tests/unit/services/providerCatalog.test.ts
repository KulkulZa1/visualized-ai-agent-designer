import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CATALOG } from "@/services/model-providers/providerCatalog";
import type { ProviderConfig, ProviderType } from "@/types/modelProvider";

function hasOwnApiKeyProperty(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "apiKey")) return true;
  return Object.values(value).some((child) => {
    if (Array.isArray(child)) return child.some(hasOwnApiKeyProperty);
    return hasOwnApiKeyProperty(child);
  });
}

describe("provider catalog", () => {
  it("contains the required provider types for the first planning slice", () => {
    const types = new Set(DEFAULT_PROVIDER_CATALOG.map((provider) => provider.type));
    const required: ProviderType[] = [
      "openai",
      "openai-compatible",
      "ollama",
      "ollama-remote",
      "cloud",
      "kilo",
      "anthropic",
      "gemini",
    ];

    for (const type of required) {
      expect(types.has(type)).toBe(true);
    }
  });

  it("uses credential references rather than raw API key fields", () => {
    for (const provider of DEFAULT_PROVIDER_CATALOG) {
      expect(hasOwnApiKeyProperty(provider)).toBe(false);
      if (!provider.isLocal && provider.type !== "cloud") {
        expect(provider.apiKeyRef).toMatch(/^(env|secure):/);
      }
    }
  });

  it("does not include raw key-like secrets in provider defaults", () => {
    const serialized = JSON.stringify(DEFAULT_PROVIDER_CATALOG);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
  });

  it("defines Ollama Cloud as an enabled hosted Ollama endpoint using a credential reference", () => {
    const cloud = DEFAULT_PROVIDER_CATALOG.find((provider) => provider.id === "ollama-cloud");

    expect(cloud).toEqual(expect.objectContaining({
      name: "Ollama Cloud",
      type: "ollama-remote",
      baseUrl: "https://ollama.com/api",
      apiKeyRef: "env:OLLAMA_API_KEY",
      defaultModel: "gemma4:31b-cloud",
      isLocal: false,
      enabled: true,
      securityLevel: "hosted",
    }));
  });

  it("describes capability flags and health status for each provider", () => {
    for (const provider of DEFAULT_PROVIDER_CATALOG as ProviderConfig[]) {
      expect(provider.capabilities).toEqual(
        expect.objectContaining({
          streaming: expect.any(Boolean),
          toolCalling: expect.any(Boolean),
          modelListing: expect.any(Boolean),
          tokenCostEstimate: expect.any(Boolean),
        })
      );
      expect(["unknown", "ok", "degraded", "error", "not_configured"]).toContain(
        provider.healthStatus
      );
    }
  });
});
