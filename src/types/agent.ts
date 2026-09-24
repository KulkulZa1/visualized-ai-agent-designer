/** Role of an agent node in a workflow — matches design system glyph vocabulary. */
export enum AgentRole {
  Orchestrator = "orchestrator", // ◆ amber  — plans + delegates
  Gateway      = "gateway",      // ◇ blue   — routes conditionally
  Worker       = "worker",       // ● green  — executes tasks
  Critic       = "critic",       // ◐ red    — reviews + validates
  Memory       = "memory",       // ▣ purple — persists context
  Hook         = "hook",         // ✕ orange — pre/post execution gates
  Aggregator   = "aggregator",   // ⊕ teal   — merges parallel outputs
  ToolCaller   = "tool_caller",  // ⬡ gray   — specialized tool use
}

export enum ToolPermission {
  ReadFile         = "read_file",
  WriteFile        = "fs.write",
  FsAppend         = "fs.append",
  FsRead           = "fs.read",
  ListFiles        = "list_files",
  Bash             = "bash",
  WebSearch        = "web_search",
  WebFetch         = "web_fetch",
  Grep             = "grep",
  Classify         = "classify",
  VectorSearch     = "vector_search",
  Cite             = "cite",
  Git              = "git",
  TodoWrite        = "todo_write",
  SubagentDispatch = "subagent_dispatch",
  Test             = "test",
  Puppeteer        = "puppeteer",
}

export const TOOL_RISK: Record<ToolPermission, "low" | "medium" | "high"> = {
  [ToolPermission.ReadFile]:         "low",
  [ToolPermission.FsRead]:           "low",
  [ToolPermission.ListFiles]:        "low",
  [ToolPermission.WebSearch]:        "low",
  [ToolPermission.Grep]:             "low",
  [ToolPermission.Classify]:         "low",
  [ToolPermission.VectorSearch]:     "low",
  [ToolPermission.Cite]:             "low",
  [ToolPermission.TodoWrite]:        "low",
  [ToolPermission.WebFetch]:         "medium",
  [ToolPermission.Git]:              "medium",
  [ToolPermission.Test]:             "medium",
  [ToolPermission.WriteFile]:        "medium",
  [ToolPermission.FsAppend]:         "medium",
  [ToolPermission.Puppeteer]:        "medium",
  [ToolPermission.Bash]:             "high",
  [ToolPermission.SubagentDispatch]: "high",
};

export type PromptSource =
  | { type: "inline"; content: string }
  | { type: "file"; path: string };

export interface HookConfig {
  path: string;
  requireConsent: boolean;
  env?: Record<string, string>;
}

export interface TokenBudget {
  used: number;
  budget: number;
}

/**
 * FallbackPolicy — intended: when the primary model hits a rate limit or error,
 * switch to fallback.model. NOT yet applied by the run loop (the only runtime
 * fallback is the billing-error → local Ollama retry in providerAdapter).
 * Displayed as a secondary badge on the canvas node card.
 */
export interface FallbackPolicy {
  model: string;         // e.g. "gpt-5.5-xhigh"
  trigger: "rate_limit" | "error" | "timeout" | "any";
  maxAttempts?: number;  // default 1
}

export interface AgentNodeData extends Record<string, unknown> {
  name: string;
  role: AgentRole;
  model: string;
  /** Optional fallback when primary model is unavailable */
  fallback?: FallbackPolicy;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  timeoutSeconds: number;
  promptSource: PromptSource;
  tools: ToolPermission[];
  preHook?: HookConfig;
  postHook?: HookConfig;
  memoryRead: string[];
  memoryWrite: string[];
  tokens: TokenBudget;
  status: "idle" | "running" | "waiting" | "done" | "error";
  condition?: string;    // gateway only
  description?: string;
  thinkDepth?: "none" | "low" | "medium" | "high";
  comment?: string;
}
