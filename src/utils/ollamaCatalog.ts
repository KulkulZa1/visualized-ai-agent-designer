/**
 * Curated Ollama model catalog.
 * These are offered as "Available to pull / run" when the user has not yet
 * installed a model, or as a discovery list for cloud endpoints.
 *
 * Format: { id, label, family, size, tags }
 * `id` is the exact model name passed to `ollama pull` / used in API calls.
 */
export interface OllamaModelEntry {
  id: string;
  label: string;
  family: string;
  /** Size hint shown in the chip, e.g. "7B" */
  size: string;
  /** "code" | "chat" | "embed" | "vision" */
  tags: string[];
  /** True = small/free-tier candidate for Ollama Cloud; direct cloud API still requires an API key. */
  free?: boolean;
}

/** Official Ollama Cloud API base URL. */
/** Ollama Cloud API base URL — matches DEFAULT_OLLAMA_CLOUD_BASE_URL in providerConfig.ts */
export const OLLAMA_CLOUD_API_URL = "https://ollama.com/api";

export const OLLAMA_CATALOG: OllamaModelEntry[] = [
  // ── Google Gemma ─────────────────────────────────────────────────────────
  { id: "gemma4:31b-cloud", label: "Gemma 4 31B Cloud", family: "gemma4", size: "31B", tags: ["chat"], free: true },
  { id: "gemma3:1b",      label: "Gemma 3 1B",     family: "gemma3",  size: "1B",   tags: ["chat"], free: true  },
  { id: "gemma3:4b",      label: "Gemma 3 4B",     family: "gemma3",  size: "4B",   tags: ["chat"], free: true  },
  { id: "gemma3:12b",     label: "Gemma 3 12B",    family: "gemma3",  size: "12B",  tags: ["chat"]              },
  { id: "gemma3:27b",     label: "Gemma 3 27B",    family: "gemma3",  size: "27B",  tags: ["chat"]              },
  { id: "gemma2:2b",      label: "Gemma 2 2B",     family: "gemma2",  size: "2B",   tags: ["chat"], free: true  },
  { id: "gemma2:9b",      label: "Gemma 2 9B",     family: "gemma2",  size: "9B",   tags: ["chat"]              },
  { id: "gemma2:27b",     label: "Gemma 2 27B",    family: "gemma2",  size: "27B",  tags: ["chat"]              },

  // ── Meta Llama ───────────────────────────────────────────────────────────
  { id: "llama3.3",       label: "Llama 3.3 70B",  family: "llama3",  size: "70B",  tags: ["chat"]              },
  { id: "llama3.2:1b",    label: "Llama 3.2 1B",   family: "llama3",  size: "1B",   tags: ["chat"], free: true  },
  { id: "llama3.2:3b",    label: "Llama 3.2 3B",   family: "llama3",  size: "3B",   tags: ["chat"], free: true  },
  { id: "llama3.1:8b",    label: "Llama 3.1 8B",   family: "llama3",  size: "8B",   tags: ["chat"]              },
  { id: "llama3.1:70b",   label: "Llama 3.1 70B",  family: "llama3",  size: "70B",  tags: ["chat"]              },
  { id: "llama3.1:405b",  label: "Llama 3.1 405B", family: "llama3",  size: "405B", tags: ["chat"]              },

  // ── Qwen ─────────────────────────────────────────────────────────────────
  { id: "qwen3:0.6b",         label: "Qwen 3 0.6B",       family: "qwen3",   size: "0.6B",  tags: ["chat"], free: true },
  { id: "qwen3:1.7b",         label: "Qwen 3 1.7B",       family: "qwen3",   size: "1.7B",  tags: ["chat"], free: true },
  { id: "qwen3:4b",           label: "Qwen 3 4B",         family: "qwen3",   size: "4B",    tags: ["chat"], free: true },
  { id: "qwen3:8b",           label: "Qwen 3 8B",         family: "qwen3",   size: "8B",    tags: ["chat"]             },
  { id: "qwen3:14b",          label: "Qwen 3 14B",        family: "qwen3",   size: "14B",   tags: ["chat"]             },
  { id: "qwen3:30b-a3b",      label: "Qwen 3 30B MoE",   family: "qwen3",   size: "30B",   tags: ["chat"]             },
  { id: "qwen3:32b",          label: "Qwen 3 32B",        family: "qwen3",   size: "32B",   tags: ["chat"]             },
  { id: "qwen3:235b-a22b",    label: "Qwen 3 235B MoE",  family: "qwen3",   size: "235B",  tags: ["chat"]             },
  { id: "qwen2.5-coder:7b",   label: "Qwen2.5 Coder 7B", family: "qwen2.5", size: "7B",    tags: ["code"]             },
  { id: "qwen2.5-coder:14b",  label: "Qwen2.5 Coder 14B",family: "qwen2.5", size: "14B",   tags: ["code"]             },
  { id: "qwen2.5-coder:32b",  label: "Qwen2.5 Coder 32B",family: "qwen2.5", size: "32B",   tags: ["code"]             },
  { id: "qwq",                label: "QwQ 32B",           family: "qwen",    size: "32B",   tags: ["chat", "reason"]   },

  // ── Mistral ──────────────────────────────────────────────────────────────
  { id: "mistral",               label: "Mistral 7B",       family: "mistral", size: "7B",   tags: ["chat"] },
  { id: "mistral-nemo",          label: "Mistral Nemo 12B", family: "mistral", size: "12B",  tags: ["chat"] },
  { id: "mistral-small:22b",     label: "Mistral Small 22B",family: "mistral", size: "22B",  tags: ["chat"] },
  { id: "mixtral:8x7b",          label: "Mixtral 8×7B",     family: "mixtral", size: "47B",  tags: ["chat"] },
  { id: "mixtral:8x22b",         label: "Mixtral 8×22B",    family: "mixtral", size: "141B", tags: ["chat"] },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  { id: "deepseek-r1:7b",    label: "DeepSeek R1 7B",    family: "deepseek", size: "7B",   tags: ["reason"] },
  { id: "deepseek-r1:14b",   label: "DeepSeek R1 14B",   family: "deepseek", size: "14B",  tags: ["reason"] },
  { id: "deepseek-r1:32b",   label: "DeepSeek R1 32B",   family: "deepseek", size: "32B",  tags: ["reason"] },
  { id: "deepseek-r1:70b",   label: "DeepSeek R1 70B",   family: "deepseek", size: "70B",  tags: ["reason"] },
  { id: "deepseek-coder-v2", label: "DeepSeek Coder V2", family: "deepseek", size: "16B",  tags: ["code"] },

  // ── Microsoft Phi ────────────────────────────────────────────────────────
  { id: "phi4",              label: "Phi-4 14B",      family: "phi",   size: "14B",  tags: ["chat", "code"] },
  { id: "phi4-mini",         label: "Phi-4 Mini 4B",  family: "phi",   size: "4B",   tags: ["chat", "code"] },
  { id: "phi3.5",            label: "Phi-3.5 3.8B",   family: "phi",   size: "3.8B", tags: ["chat", "code"] },

  // ── Code specialist ──────────────────────────────────────────────────────
  { id: "codellama:7b",      label: "CodeLlama 7B",   family: "codellama", size: "7B",  tags: ["code"] },
  { id: "codellama:13b",     label: "CodeLlama 13B",  family: "codellama", size: "13B", tags: ["code"] },
  { id: "codellama:34b",     label: "CodeLlama 34B",  family: "codellama", size: "34B", tags: ["code"] },
  { id: "starcoder2:7b",     label: "StarCoder2 7B",  family: "starcoder", size: "7B",  tags: ["code"] },
  { id: "starcoder2:15b",    label: "StarCoder2 15B", family: "starcoder", size: "15B", tags: ["code"] },

  // ── Embed ─────────────────────────────────────────────────────────────────
  { id: "nomic-embed-text",  label: "Nomic Embed",    family: "embed", size: "137M", tags: ["embed"] },
  { id: "mxbai-embed-large", label: "MxBai Embed",   family: "embed", size: "335M", tags: ["embed"] },
];

/** Families in display order for grouping. */
export const OLLAMA_FAMILIES = [
  "gemma4", "gemma3", "gemma2", "llama3", "qwen3", "qwen2.5", "qwen",
  "deepseek", "mistral", "mixtral", "phi", "codellama", "starcoder", "embed",
];

/** Returns catalog models that are NOT in the installed list. */
export function catalogOnly(installed: string[]): OllamaModelEntry[] {
  const installedBare = new Set(installed.map((m) => m.toLowerCase()));
  return OLLAMA_CATALOG.filter(
    (m) => !installedBare.has(m.id.toLowerCase()) && !installedBare.has(m.id.toLowerCase().split(":")[0])
  );
}
