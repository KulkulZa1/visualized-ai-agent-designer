/**
 * providerAdapter.ts — framework-agnostic provider call service.
 *
 * Nothing here imports React, Zustand, or Tauri directly.
 * The Tauri `invoke` function is injected as a parameter so this module
 * can be reused from the CLI, MCP server, VS Code extension, or tests.
 *
 * See docs/VS_CODE_EXTENSION_PLAN.md §1 for the extraction rationale.
 */

import { Channel } from "@tauri-apps/api/core";
import type { RuntimeProvider } from "@/utils/providerConfig";
import { isRemoteOllamaUrl, shouldFallbackToOllama } from "@/utils/providerConfig";
import type { ToolSpec } from "@/services/execution/toolExecutor";

// ── Public types ─────────────────────────────────────────────────────────────

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface ProviderCallParams {
  provider: RuntimeProvider;
  /** Final resolved model ID (e.g. "gpt-5.5" not "gpt-5.5-xhigh"). */
  model: string;
  /** Original model string from node data — used for alias logging. */
  rawModel: string;
  systemMsg: string;
  userMsg: string;
  maxTokens: number;
  apiKey: string;
  requiresKey: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Optional credential for Ollama Cloud or authenticated remote Ollama gateways. */
  ollamaApiKey?: string;
  /** Base URL override for openai-compatible custom endpoints (e.g. "https://myserver.com/v1"). */
  customBaseUrl?: string;
  /** Pass "high" / "medium" / "low" for o-series and GPT-5.5 models. */
  reasoningEffort: string | null;
}

export interface ProviderCallResult {
  text: string;
  /** True when the primary hosted call failed with a billing error and
   *  the response came from the Ollama fallback. */
  usedOllamaFallback: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  latency_ms: number;
  message: string;
  model_available: boolean;
  pull_command: string | null;
}

// ── Model alias resolution ────────────────────────────────────────────────────

/**
 * Internal tier names used in the UI ("gpt-5.5-xhigh") map to real API IDs.
 * [KEEP-IN-SYNC] with cli/harness.mjs if you add entries.
 */
export const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.5-xhigh": "gpt-5.5",
  "gpt-5.5-high":  "gpt-5.5",
  "gpt-5.5-mid":   "gpt-5.4-mini",
  "gpt-4o-high":   "gpt-4o",
  "gpt-4o-mini":   "gpt-4o-mini",
  "gemma4-31b:cloud": "gemma4:31b-cloud",
};

export const REASONING_EFFORT: Record<string, string> = {
  "gpt-5.5-xhigh": "high",
  "gpt-5.5-high":  "medium",
  "gpt-5.5-mid":   "medium",
};

/** OpenAI models that accept a reasoning effort (non-reasoning models reject it). */
export function isReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5.5") || model.startsWith("o3") ||
         model.startsWith("o4") || model.startsWith("o1");
}

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

/**
 * Workflows and the model picker use dotted display versions ("claude-sonnet-4.6"),
 * but Anthropic API model IDs are hyphenated ("claude-sonnet-4-6") and a dotted ID
 * is rejected with a 404. Mirrored in Rust as normalize_anthropic_model().
 */
export function toAnthropicModelId(model: string): string {
  const id = model.trim();
  return id.startsWith("claude-") ? id.replace(/\./g, "-") : id;
}

// ── System message builder ────────────────────────────────────────────────────

export interface SystemMessageParams {
  agentName: string;
  role: string;
  workflowName: string;
  description?: string;
  tools: string[];
  memoryRead: string[];
  memoryWrite: string[];
  promptContent: string;
}

export function buildSystemMessage(p: SystemMessageParams): string {
  return [
    `You are ${p.agentName}, a ${p.role} agent in the ${p.workflowName} workflow.`,
    p.description ? `\nYour role: ${p.description}` : "",
    `\nAllowed tools: ${p.tools.join(", ") || "none"}`,
    `\nMemory keys to read: ${p.memoryRead.join(", ") || "none"}`,
    `\nMemory keys to write: ${p.memoryWrite.join(", ") || "none"}`,
    p.promptContent ? `\n\n${p.promptContent}` : "",
  ].join("");
}

// ── Core provider call ────────────────────────────────────────────────────────

/**
 * Call the provider for a single agent turn.
 *
 * @param params     Provider and message params.
 * @param invokeFn   Tauri `invoke` (or a compatible mock for tests / CLI / VS Code).
 * @returns          The raw text response and a fallback flag.
 * @throws           When the call fails and no Ollama fallback is available.
 */
export async function callProvider(
  params: ProviderCallParams,
  invokeFn: InvokeFn,
): Promise<ProviderCallResult> {
  const {
    provider, model, apiKey, requiresKey,
    systemMsg, userMsg, maxTokens,
    ollamaBaseUrl, ollamaModel, ollamaApiKey, customBaseUrl, reasoningEffort,
  } = params;

  // Ollama call — uses ollamaModel, which is the Ollama-specific model param.
  // For gemma4:31b-cloud, the caller sets ollamaModel = "gemma4-31b:cloud" (or "gemma4:31b-cloud");
  // resolveModel normalises the dash-form alias to the canonical colon-form.
  // The Rust normalize_ollama_model() applies the same normalisation as a second gate.
  const callOllama = (): Promise<string> =>
    invokeFn<string>("call_ollama_api", {
      model: resolveModel(ollamaModel),
      system: systemMsg,
      userMessage: userMsg,
      baseUrl: ollamaBaseUrl,
      apiKey: ollamaApiKey ?? "",
      maxTokens,
    });

  if (provider === "ollama" || provider === "ollama-cloud") {
    const text = await callOllama();
    return { text, usedOllamaFallback: false };
  }

  // Custom OpenAI-compatible endpoint — use OpenAI wire format with a different base URL
  if (provider === "openai-compatible") {
    if (!customBaseUrl?.trim()) {
      throw new Error("Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint.");
    }
    const text = await invokeFn<string>("call_openai_api", {
      model,
      system: systemMsg,
      userMessage: userMsg,
      apiKey: apiKey || "",   // empty string OK — some local endpoints don't need auth
      maxTokens,
      baseUrl: customBaseUrl.trim(),
      reasoningEffort: null,
    });
    return { text, usedOllamaFallback: false };
  }

  if (!apiKey && requiresKey) {
    throw new Error(
      `No ${provider} API key. Add it in Settings or set the provider key in the environment.`
    );
  }

  try {
    const text = await invokeFn<string>(
      provider === "openai" ? "call_openai_api" : "call_claude_api",
      {
        model: provider === "anthropic" ? toAnthropicModelId(model) : model,
        system: systemMsg,
        userMessage: userMsg,
        apiKey,
        maxTokens,
        ...(provider === "openai" ? { reasoningEffort, baseUrl: null } : {}),
      }
    );
    return { text, usedOllamaFallback: false };
  } catch (primaryErr) {
    const errStr = String(primaryErr);
    // Only fall back to a *local* Ollama server: silently re-sending the prompt to a
    // remote/cloud endpoint the user did not choose for this call would be a hidden
    // cloud call.
    if (shouldFallbackToOllama(errStr) && ollamaBaseUrl && !isRemoteOllamaUrl(ollamaBaseUrl)) {
      const text = (await callOllama()) + "\n[ran on Ollama fallback]";
      return { text, usedOllamaFallback: true };
    }
    throw primaryErr;
  }
}

// ── Native tool calling (one model turn) ──────────────────────────────────────

export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface NativeToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Provider-neutral history; the Rust `chat_turn` command serializes it per provider. */
export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: NativeToolCall[] }
  | { role: "tool"; toolResults: NativeToolResult[] };

export interface ChatReply {
  text: string;
  toolCalls: NativeToolCall[];
  finishReason: string;
  /** False when the model or server refused the tool definitions. */
  nativeToolsSupported: boolean;
}

export interface ChatTurnParams extends Omit<ProviderCallParams, "userMsg"> {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/** One model turn with native tool calling — same provider mapping as `callProvider`. */
/** A piece of the model's text as it streams in (chat_turn's channel). */
export interface ChatDelta {
  text: string;
}

/** A channel for streamed text, or null where Tauri IPC is missing (the VS Code webview). */
function deltaChannel(onDelta: (text: string) => void): Channel<ChatDelta> | null {
  try {
    const channel = new Channel<ChatDelta>();
    channel.onmessage = (delta) => onDelta(delta.text);
    return channel;
  } catch {
    return null;
  }
}

/** One model turn with native tool calling; with `onDelta`, the reply's text streams to it. */
export async function callChatTurn(
  params: ChatTurnParams, invokeFn: InvokeFn, onDelta?: (text: string) => void,
): Promise<ChatReply> {
  const {
    provider, model, apiKey, requiresKey, systemMsg, messages, tools, maxTokens,
    ollamaBaseUrl, ollamaModel, ollamaApiKey, customBaseUrl, reasoningEffort,
  } = params;
  const channel = onDelta ? deltaChannel(onDelta) : null;
  const turn = (args: Record<string, unknown>) => invokeFn<ChatReply>("chat_turn", {
    system: systemMsg, messages, tools, maxTokens, reasoningEffort: null, baseUrl: null, onDelta: channel, ...args,
  });

  if (provider === "ollama" || provider === "ollama-cloud") {
    return turn({ provider, model: resolveModel(ollamaModel), apiKey: ollamaApiKey ?? "", baseUrl: ollamaBaseUrl });
  }
  if (provider === "openai-compatible") {
    if (!customBaseUrl?.trim()) {
      throw new Error("Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint.");
    }
    return turn({ provider, model, apiKey: apiKey || "", baseUrl: customBaseUrl.trim() });
  }
  if (!apiKey && requiresKey) {
    throw new Error(`No ${provider} API key. Add it in Settings or set the provider key in the environment.`);
  }
  return turn({
    provider,
    model: provider === "anthropic" ? toAnthropicModelId(model) : model,
    apiKey,
    ...(provider === "openai" ? { reasoningEffort } : {}),
  });
}

// ── Token estimator ───────────────────────────────────────────────────────────

/** Cheap character-count token estimate (same formula as execution engine). */
export function estimateTokens(systemMsg: string, userMsg: string, response: string): number {
  return Math.ceil((systemMsg.length + userMsg.length + response.length) / 4);
}
