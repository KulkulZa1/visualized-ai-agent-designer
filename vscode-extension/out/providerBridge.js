"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.callOllamaApi = callOllamaApi;
exports.callOpenAIApi = callOpenAIApi;
exports.callClaudeApi = callClaudeApi;
exports.checkOllamaHealth = checkOllamaHealth;
// ── Ollama (local or remote) ─────────────────────────────────────────────────
async function callOllamaApi(args) {
    const { model, system, userMessage, baseUrl, apiKey, maxTokens } = args;
    // Normalize the base URL to the Ollama /api/chat endpoint
    const base = baseUrl.trim().replace(/\/+$/, "");
    const endpoint = base.endsWith("/api")
        ? `${base}/chat`
        : `${base}/api/chat`;
    const body = {
        model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
        ],
        stream: false,
        options: { num_predict: maxTokens },
    };
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    if (apiKey)
        headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`Ollama API error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    return data.message?.content ?? "";
}
// ── OpenAI ───────────────────────────────────────────────────────────────────
async function callOpenAIApi(args) {
    const { model, system, userMessage, apiKey, maxTokens, baseUrl, reasoningEffort } = args;
    const endpoint = baseUrl
        ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
        : "https://api.openai.com/v1/chat/completions";
    const body = {
        model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
        ],
        max_tokens: maxTokens,
    };
    if (reasoningEffort)
        body["reasoning_effort"] = reasoningEffort;
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
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
}
// ── Anthropic (Claude) ───────────────────────────────────────────────────────
async function callClaudeApi(args) {
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
    const data = await response.json();
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text ?? "";
}
// ── Provider health check ────────────────────────────────────────────────────
async function checkOllamaHealth(baseUrl, model, apiKey = "") {
    try {
        const base = baseUrl.trim().replace(/\/+$/, "");
        const tagsUrl = base.endsWith("/api")
            ? `${base}/tags`
            : `${base}/api/tags`;
        const headers = { "Accept": "application/json" };
        if (apiKey)
            headers["Authorization"] = `Bearer ${apiKey}`;
        const res = await fetch(tagsUrl, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const installed = (data.models ?? []).map((m) => m.name.toLowerCase());
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
    }
    catch (e) {
        return {
            ok: false,
            message: `Ollama not reachable at ${baseUrl}: ${String(e)}`,
            model_available: false,
            pull_command: `ollama pull ${model}`,
        };
    }
}
