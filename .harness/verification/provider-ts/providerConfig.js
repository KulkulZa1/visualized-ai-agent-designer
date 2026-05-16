"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUGGESTED_OLLAMA_MODELS = exports.DEFAULT_OLLAMA_MODEL = exports.DEFAULT_OLLAMA_BASE_URL = exports.OLLAMA_UNAVAILABLE_MESSAGE = exports.ANTHROPIC_CREDIT_MESSAGE = exports.OPENAI_RATE_LIMIT_MESSAGE = exports.OPENAI_QUOTA_MESSAGE = void 0;
exports.maskApiKey = maskApiKey;
exports.defaultProviderConfig = defaultProviderConfig;
exports.selectProviderForModel = selectProviderForModel;
exports.isRateLimitError = isRateLimitError;
exports.isBillingRelatedError = isBillingRelatedError;
exports.shouldFallbackToOllama = shouldFallbackToOllama;
exports.OPENAI_QUOTA_MESSAGE = "OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.";
exports.OPENAI_RATE_LIMIT_MESSAGE = "OpenAI API rate limit reached. The application will retry with exponential backoff.";
exports.ANTHROPIC_CREDIT_MESSAGE = "Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.";
exports.OLLAMA_UNAVAILABLE_MESSAGE = "Ollama is selected, but the local Ollama server is not reachable at http://localhost:11434. Please start Ollama and try again.";
exports.DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
exports.DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:7b";
exports.SUGGESTED_OLLAMA_MODELS = [
    "qwen2.5-coder:7b",
    "qwen2.5-coder:14b",
    "llama3.1:8b",
    "deepseek-coder",
    "codellama",
];
function maskApiKey(key) {
    const value = key?.trim() ?? "";
    if (!value)
        return "<empty>";
    if (value.length <= 8)
        return "****";
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
function defaultProviderConfig(env) {
    const rawProvider = (env.LLM_PROVIDER ?? "auto").toLowerCase();
    const provider = rawProvider === "openai" ||
        rawProvider === "anthropic" ||
        rawProvider === "ollama" ||
        rawProvider === "auto"
        ? rawProvider
        : "auto";
    return {
        provider,
        ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || exports.DEFAULT_OLLAMA_BASE_URL,
        ollamaModel: env.OLLAMA_MODEL?.trim() || exports.DEFAULT_OLLAMA_MODEL,
        hasOpenAIKey: Boolean(env.OPENAI_API_KEY?.trim()),
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    };
}
function inferProvider(model) {
    if (model.startsWith("gpt-") || /^o\d/.test(model))
        return "openai";
    if (model.startsWith("claude-"))
        return "anthropic";
    return "ollama";
}
function selectProviderForModel({ mode, model, hasOpenAIKey, hasAnthropicKey, ollamaModel, }) {
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
function isRateLimitError(error) {
    return /rate.?limit|429|too many requests/i.test(error);
}
function isBillingRelatedError(error) {
    return /billing|quota|credit|insufficient|exceeded/i.test(error);
}
function shouldFallbackToOllama(error) {
    return isBillingRelatedError(error) && !isRateLimitError(error);
}
