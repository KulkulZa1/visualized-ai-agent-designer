export type ProviderType =
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "ollama-remote"
  | "cloud"
  | "kilo"
  | "anthropic"
  | "gemini"
  | "custom";

export type ProviderSecurityLevel = "local" | "byok" | "hosted" | "enterprise" | "unknown";
export type ProviderHealthStatus = "unknown" | "ok" | "degraded" | "error" | "not_configured";

export interface ModelCapabilityFlags {
  streaming: boolean;
  toolCalling: boolean;
  modelListing: boolean;
  tokenCostEstimate: boolean;
}

export interface ProviderModelInfo {
  id: string;
  label: string;
  contextWindowTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  supportsStreaming?: boolean;
  supportsToolCalling?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyRef?: string;
  defaultModel?: string;
  availableModels: ProviderModelInfo[];
  capabilities: ModelCapabilityFlags;
  contextWindowTokens?: number;
  isLocal: boolean;
  enabled: boolean;
  securityLevel: ProviderSecurityLevel;
  healthStatus: ProviderHealthStatus;
  notes?: string;
}
