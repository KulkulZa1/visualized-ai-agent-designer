export type LlmProvider = "openai" | "anthropic" | "ollama" | "auto";
export type RuntimeProvider = "openai" | "anthropic" | "ollama";

export const OPENAI_QUOTA_MESSAGE =
  "OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.";

export const OPENAI_RATE_LIMIT_MESSAGE =
  "OpenAI API rate limit reached. The application will retry with exponential backoff.";

export const ANTHROPIC_CREDIT_MESSAGE =
  "Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.";

export const OLLAMA_UNAVAILABLE_MESSAGE =
  "Ollama is selected, but the local Ollama server is not reachable at http://localhost:11434. Please start Ollama and try again.";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b";

export const SUGGESTED_OLLAMA_MODELS = [
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

export function defaultProviderConfig(
  env: Record<string, string | undefined>
): ProviderRuntimeConfig {
  const rawProvider = (env.LLM_PROVIDER ?? "auto").toLowerCase();
  const provider: LlmProvider =
    rawProvider === "openai" ||
    rawProvider === "anthropic" ||
    rawProvider === "ollama" ||
    rawProvider === "auto"
      ? rawProvider
      : "auto";

  return {
    provider,
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
    hasOpenAIKey: Boolean(env.OPENAI_API_KEY?.trim()),
    hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
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
    return { provider: "ollama", model: ollamaModel, requiresKey: false };
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
