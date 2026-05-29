export type LlmProvider = "openai" | "anthropic" | "ollama" | "ollama-cloud" | "openai-compatible" | "auto";
export type RuntimeProvider = "openai" | "anthropic" | "ollama" | "ollama-cloud" | "openai-compatible";

export const OPENAI_QUOTA_MESSAGE =
  "OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.";

export const OPENAI_RATE_LIMIT_MESSAGE =
  "OpenAI API rate limit reached. The application will retry with exponential backoff.";

export const ANTHROPIC_CREDIT_MESSAGE =
  "Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.";

export const OLLAMA_UNAVAILABLE_MESSAGE =
  "Ollama is selected, but the local Ollama server is not reachable at http://localhost:11434. Please start Ollama and try again.";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Ollama Cloud API base URL. The Rust command's ollama_api_endpoint() handles the /api suffix. */
export const DEFAULT_OLLAMA_CLOUD_BASE_URL = "https://ollama.com/api";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_OLLAMA_CLOUD_MODEL = "gemma4:31b-cloud";

export const SUGGESTED_OLLAMA_MODELS = [
  "gemma4:31b-cloud",
  "qwen2.5-coder:7b",
  "qwen2.5-coder:14b",
  "llama3.1:8b",
  "deepseek-coder",
  "codellama",
];

export interface ProviderRuntimeConfig {
  provider: LlmProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  hasOllamaApiKey: boolean;
}

export interface ProviderSelection {
  provider: RuntimeProvider;
  model: string;
  requiresKey: boolean;
}

export function maskApiKey(key: string | undefined | null): string {
  const value = key?.trim() ?? "";
  if (!value) return "<empty>";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function isOllamaCloudUrl(baseUrl: string | undefined | null): boolean {
  const value = baseUrl?.trim() ?? "";
  if (!value) return false;
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    const withoutProtocol = value.toLowerCase().replace(/^https?:\/\//, "");
    host = withoutProtocol.split(/[/:?#]/, 1)[0];
  }
  return host === "ollama.com" || host.endsWith(".ollama.com");
}

export function isRemoteOllamaUrl(baseUrl: string | undefined | null): boolean {
  const value = baseUrl?.trim() ?? "";
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);
  } catch {
    const host = value.toLowerCase().replace(/^https?:\/\//, "").split(/[/:?#]/, 1)[0];
    return Boolean(host && !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host));
  }
}

export function hasOllamaCredentialForEndpoint(
  env: Record<string, string | undefined>,
  baseUrl: string,
): boolean {
  if (isOllamaCloudUrl(baseUrl)) return Boolean(env.OLLAMA_API_KEY?.trim());
  if (isRemoteOllamaUrl(baseUrl)) return Boolean(env.OLLAMA_REMOTE_API_KEY?.trim());
  return false;
}

export function defaultProviderConfig(
  env: Record<string, string | undefined>
): ProviderRuntimeConfig {
  const rawProvider = (env.LLM_PROVIDER ?? "auto").toLowerCase();
  const provider: LlmProvider =
    rawProvider === "openai" ||
    rawProvider === "anthropic" ||
    rawProvider === "ollama" ||
    rawProvider === "ollama-cloud" ||
    rawProvider === "auto"
      ? rawProvider
      : "auto";
  const defaultOllamaBaseUrl =
    provider === "ollama-cloud" ? DEFAULT_OLLAMA_CLOUD_BASE_URL : DEFAULT_OLLAMA_BASE_URL;
  const ollamaBaseUrl = env.OLLAMA_BASE_URL?.trim() || defaultOllamaBaseUrl;

  return {
    provider,
    ollamaBaseUrl,
    ollamaModel:
      env.OLLAMA_MODEL?.trim() ||
      (provider === "ollama-cloud" ? DEFAULT_OLLAMA_CLOUD_MODEL : DEFAULT_OLLAMA_MODEL),
    hasOpenAIKey: Boolean(env.OPENAI_API_KEY?.trim()),
    hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    hasOllamaApiKey: hasOllamaCredentialForEndpoint(env, ollamaBaseUrl),
  };
}

function inferProvider(model: string): RuntimeProvider {
  if (model.startsWith("gpt-") || /^o\d/.test(model)) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  return "ollama";
}

export function selectProviderForModel({
  mode,
  model,
  hasOpenAIKey,
  hasAnthropicKey,
  ollamaModel,
}: {
  mode: LlmProvider;
  model: string;
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  ollamaModel: string;
}): ProviderSelection {
  if (mode === "ollama") {
    // Always use the store's configured Ollama model — it's the Ollama-specific default.
    return { provider: "ollama", model: ollamaModel, requiresKey: false };
  }

  if (mode === "ollama-cloud") {
    // Same: use the store's Ollama model (set via Settings → model field).
    // To run gemma4:31b-cloud, set ollamaModel = "gemma4:31b-cloud" in Settings.
    return { provider: "ollama-cloud", model: ollamaModel, requiresKey: false };
  }

  if (mode === "openai-compatible") {
    return { provider: "openai-compatible", model: ollamaModel, requiresKey: false };
  }

  if (mode === "openai") {
    return {
      provider: "openai",
      model: model.startsWith("gpt-") || /^o\d/.test(model) ? model : "gpt-4o-mini",
      requiresKey: true,
    };
  }

  if (mode === "anthropic") {
    return {
      provider: "anthropic",
      model: model.startsWith("claude-") ? model : "claude-haiku-4.5",
      requiresKey: true,
    };
  }

  const inferred = inferProvider(model);
  if (inferred === "openai" && !hasOpenAIKey) {
    return { provider: "ollama", model: ollamaModel, requiresKey: false };
  }
  if (inferred === "anthropic" && !hasAnthropicKey) {
    return { provider: "ollama", model: ollamaModel, requiresKey: false };
  }
  return { provider: inferred, model: inferred === "ollama" ? ollamaModel : model, requiresKey: inferred !== "ollama" };
}

export function isRateLimitError(error: string): boolean {
  return /rate.?limit|429|too many requests/i.test(error);
}

export function isBillingRelatedError(error: string): boolean {
  return /billing|quota|credit|insufficient|exceeded/i.test(error);
}

export function shouldFallbackToOllama(error: string): boolean {
  return isBillingRelatedError(error) && !isRateLimitError(error);
}
