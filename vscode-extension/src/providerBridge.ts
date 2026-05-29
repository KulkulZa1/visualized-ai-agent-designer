/**
 * providerBridge.ts — Node.js fetch()-based provider calls for the VS Code extension.
 *
 * These replace the Rust commands (call_openai_api, call_claude_api, call_ollama_api)
 * that are not available outside the Tauri runtime. Uses the same request shapes
 * so the existing providerAdapter.ts logic works unchanged.
 *
 * Air-gapped machine note:
 *   Ollama local is the primary target. call_ollama_api requires only
 *   http://localhost:11434 — no internet connection needed.
 */

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  options?: { num_predict?: number; temperature?: number };
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
}

// ── Ollama (local or remote) ─────────────────────────────────────────────────

export async function callOllamaApi(args: {
  model: string;
  system: string;
  userMessage: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
}): Promise<string> {
  const { model, system, userMessage, baseUrl, apiKey, maxTokens } = args;

  // Normalize the base URL to the Ollama /api/chat endpoint
  const base = baseUrl.trim().replace(/\/+$/, "");
  const endpoint = base.endsWith("/api")
    ? `${base}/chat`
    : `${base}/api/chat`;

  const body: OllamaChatRequest = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: userMessage },
    ],
    stream: false,
    options: { num_predict: maxTokens },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Ollama API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as OllamaChatResponse;
  return data.message?.content ?? "";
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

export async function callOpenAIApi(args: {
  model: string;
  system: string;
  userMessage: string;
  apiKey: string;
  maxTokens: number;
  baseUrl: string | null;
  reasoningEffort: string | null;
}): Promise<string> {
  const { model, system, userMessage, apiKey, maxTokens, baseUrl, reasoningEffort } = args;

  const endpoint = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: userMessage },
    ],
    max_tokens: maxTokens,
  };
  if (reasoningEffort) body["reasoning_effort"] = reasoningEffort;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  interface OpenAIResponse {
    choices: Array<{ message: { content: string } }>;
  }
  const data = await response.json() as OpenAIResponse;
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Anthropic (Claude) ───────────────────────────────────────────────────────

export async function callClaudeApi(args: {
  model: string;
  system: string;
  userMessage: string;
  apiKey: string;
  maxTokens: number;
}): Promise<string> {
  const { model, system, userMessage, apiKey, maxTokens } = args;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  interface AnthropicResponse {
    content: Array<{ type: string; text: string }>;
  }
  const data = await response.json() as AnthropicResponse;
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

// ── Provider health check ────────────────────────────────────────────────────

export async function checkOllamaHealth(
  baseUrl: string,
  model: string,
  apiKey = "",
): Promise<{ ok: boolean; message: string; model_available: boolean; pull_command: string | null }> {
  try {
    const base = baseUrl.trim().replace(/\/+$/, "");
    const tagsUrl = base.endsWith("/api")
      ? `${base}/tags`
      : `${base}/api/tags`;

    const headers: Record<string, string> = { "Accept": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(tagsUrl, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    interface TagsResponse { models: Array<{ name: string }> }
    const data = await res.json() as TagsResponse;
    const installed = (data.models ?? []).map((m: { name: string }) => m.name.toLowerCase());

    // Cloud on-demand models (":cloud" suffix) are always "available" even if not in /tags
    const isCloud = model.includes(":cloud");
    const modelAvailable = isCloud || installed.some((n) => n === model.toLowerCase() || n.startsWith(model.toLowerCase().split(":")[0]));

    return {
      ok: true,
      message: modelAvailable
        ? `Ollama is reachable; ${model} ${isCloud ? "will stream on-demand" : "is installed"}`
        : `Ollama reachable but ${model} is not installed`,
      model_available: modelAvailable,
      pull_command: !modelAvailable && !isCloud ? `ollama pull ${model}` : null,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Ollama not reachable at ${baseUrl}: ${String(e)}`,
      model_available: false,
      pull_command: `ollama pull ${model}`,
    };
  }
}
