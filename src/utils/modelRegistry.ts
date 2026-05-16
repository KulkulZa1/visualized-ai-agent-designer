/**
 * modelRegistry.ts — Provider definitions and default model lists.
 *
 * Sources:
 *   Anthropic    — hardcoded (no public model list endpoint)
 *   OpenAI       — hardcoded (public endpoint needs auth)
 *   Ollama       — live: http://localhost:11434/api/tags
 *   OpenRouter   — live: https://openrouter.ai/api/v1/models (public, no key)
 *   Kilo         — hardcoded (kilo.codes proxy)
 *   Custom       — user enters any string
 */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "ollama"
  | "openrouter"
  | "kilo"
  | "custom";

export interface ModelInfo {
  id: string;           // the value stored in agent.model
  label: string;        // display name
  contextK: number;     // context window in thousands
  costInPerMtok?: number;
  costOutPerMtok?: number;
  tags?: string[];      // "vision", "code", "fast", "long-ctx"
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  logoColor: string;    // accent color for the provider chip
  apiEndpoint?: string; // live endpoint (Ollama, OpenRouter)
  requiresKey: boolean;
  defaultModels: ModelInfo[];
  modelIdPrefix?: string; // e.g. "openai/" for OpenRouter
}

// ── Hardcoded default model lists ───────────────────────────────────────────

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4.6",   label: "Claude Opus 4.6",   contextK: 200, costInPerMtok: 15,  costOutPerMtok: 75,  tags: ["powerful", "long-ctx"] },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", contextK: 200, costInPerMtok: 3,   costOutPerMtok: 15,  tags: ["balanced"] },
  { id: "claude-haiku-4.5",  label: "Claude Haiku 4.5",  contextK: 200, costInPerMtok: 0.8, costOutPerMtok: 4,   tags: ["fast", "cheap"] },
];

const OPENAI_MODELS: ModelInfo[] = [
  // GPT-5.5 — latest flagship (real API IDs via MODEL_ALIASES in execution engine)
  { id: "gpt-5.5-xhigh", label: "GPT-5.5 xHigh (reasoning:high)",   contextK: 1000, tags: ["powerful", "reasoning", "long-ctx"] },
  { id: "gpt-5.5-high",  label: "GPT-5.5 High (reasoning:medium)",  contextK: 1000, tags: ["balanced", "reasoning"] },
  { id: "gpt-5.5-mid",   label: "GPT-5.5 Mid → gpt-5.4-mini",      contextK: 256,  tags: ["fast", "balanced"] },
  // Real GPT-5.5 ID (direct use)
  { id: "gpt-5.5",       label: "GPT-5.5",         contextK: 1000, tags: ["powerful", "reasoning", "long-ctx"] },
  // GPT-5.4 series
  { id: "gpt-5.4-mini",  label: "GPT-5.4 mini",    contextK: 256,  tags: ["fast", "cheap"] },
  { id: "gpt-5.4-nano",  label: "GPT-5.4 nano",    contextK: 128,  tags: ["fast", "cheap"] },
  // GPT-4.1
  { id: "gpt-4.1",       label: "GPT-4.1",          contextK: 1000, tags: ["balanced", "long-ctx"] },
  // o-series (reasoning)
  { id: "o4-mini",       label: "o4-mini",           contextK: 200,  tags: ["reasoning", "fast"] },
  { id: "o3",            label: "o3",                contextK: 200,  costInPerMtok: 10,  costOutPerMtok: 40,  tags: ["reasoning"] },
  { id: "o3-mini",       label: "o3-mini",           contextK: 128,  costInPerMtok: 1.1, costOutPerMtok: 4.4, tags: ["reasoning", "cheap"] },
  { id: "o3-pro",        label: "o3-pro",            contextK: 200,  tags: ["reasoning", "powerful"] },
  // Previous generation
  { id: "gpt-4o",        label: "GPT-4o",            contextK: 128,  costInPerMtok: 5,   costOutPerMtok: 15,  tags: ["vision", "balanced"] },
  { id: "gpt-4o-mini",   label: "GPT-4o mini",       contextK: 128,  costInPerMtok: 0.15,costOutPerMtok: 0.6, tags: ["fast", "cheap"] },
];

const KILO_MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4.6",     label: "Claude Sonnet 4.6 (Kilo)",  contextK: 200 },
  { id: "claude-opus-4.6",       label: "Claude Opus 4.6 (Kilo)",    contextK: 200 },
  { id: "gpt-4o",                label: "GPT-4o (Kilo)",             contextK: 128 },
  { id: "gemini-2.0-flash",      label: "Gemini 2.0 Flash (Kilo)",   contextK: 1000 },
  { id: "deepseek-r1",           label: "DeepSeek R1 (Kilo)",        contextK: 128 },
];

// ── Provider registry ────────────────────────────────────────────────────────

export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    logoColor: "#d97706",
    requiresKey: true,
    defaultModels: ANTHROPIC_MODELS,
  },
  {
    id: "openai",
    label: "OpenAI",
    logoColor: "#10b981",
    requiresKey: true,
    defaultModels: OPENAI_MODELS,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    logoColor: "#6366f1",
    apiEndpoint: "http://localhost:11434/api/tags",
    requiresKey: false,
    defaultModels: [
      { id: "llama3.2",        label: "Llama 3.2",        contextK: 128 },
      { id: "llama3.1:70b",    label: "Llama 3.1 70B",    contextK: 128 },
      { id: "mistral:7b",      label: "Mistral 7B",       contextK: 32  },
      { id: "qwen2.5:32b",     label: "Qwen 2.5 32B",     contextK: 128 },
      { id: "deepseek-r1:8b",  label: "DeepSeek R1 8B",   contextK: 64  },
      { id: "phi4",            label: "Phi-4",            contextK: 16  },
      { id: "gemma3:9b",       label: "Gemma 3 9B",       contextK: 128 },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    logoColor: "#8b5cf6",
    apiEndpoint: "https://openrouter.ai/api/v1/models",
    requiresKey: false, // listing is free; inference needs a key
    defaultModels: [
      { id: "meta-llama/llama-4-maverick",     label: "Llama 4 Maverick",    contextK: 1000 },
      { id: "google/gemini-2.0-flash-exp:free",label: "Gemini 2.0 Flash (free)", contextK: 1000 },
      { id: "deepseek/deepseek-r1",            label: "DeepSeek R1",         contextK: 163 },
      { id: "anthropic/claude-sonnet-4-5",     label: "Claude Sonnet 4.5",   contextK: 200 },
      { id: "mistralai/mistral-large",         label: "Mistral Large",       contextK: 128 },
    ],
  },
  {
    id: "kilo",
    label: "Kilo",
    logoColor: "#f59e0b",
    requiresKey: true,
    defaultModels: KILO_MODELS,
  },
  {
    id: "custom",
    label: "Custom",
    logoColor: "#94a3b8",
    requiresKey: false,
    defaultModels: [],
  },
];

export const PROVIDER_MAP = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p])
) as Record<ProviderId, ProviderDef>;

/** Infer provider from model ID string. */
export function inferProvider(modelId: string): ProviderId {
  if (!modelId) return "anthropic";
  if (modelId.startsWith("claude-"))   return "anthropic";
  if (modelId.startsWith("gpt-") || /^o\d/.test(modelId)) return "openai";
  if (modelId.includes("/"))           return "openrouter";
  if (modelId.includes(":") || modelId.startsWith("llama") || modelId.startsWith("mistral") || modelId.startsWith("phi") || modelId.startsWith("gemma") || modelId.startsWith("qwen")) return "ollama";
  return "anthropic";
}
