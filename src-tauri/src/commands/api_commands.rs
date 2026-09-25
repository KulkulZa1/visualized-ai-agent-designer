use serde::{Deserialize, Serialize};
use std::env;
use std::time::{Duration, Instant};

const OPENAI_QUOTA_MESSAGE: &str =
    "OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.";
const OPENAI_RATE_LIMIT_MESSAGE: &str =
    "OpenAI API rate limit reached. The application will retry with exponential backoff.";
const ANTHROPIC_CREDIT_MESSAGE: &str =
    "Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.";
pub(crate) const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
const DEFAULT_OLLAMA_CLOUD_BASE_URL: &str = "https://ollama.com/api";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5-coder:7b";
const DEFAULT_OLLAMA_CLOUD_MODEL: &str = "gemma4:31b-cloud";

// ── Error classification ──────────────────────────────────────────────────────

enum ApiErrorKind {
    Billing,
    RateLimit,
    /// Overloaded (529) or server-side (5xx) failure: worth retrying.
    Transient,
    Other,
}

fn is_transient_status(status: u16) -> bool {
    status == 529 || (500..=599).contains(&status)
}

struct NormalizedProviderError {
    message: String,
    retryable: bool,
    billing_related: bool,
}

// ── Shared JSON types ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessageOut,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIMessageOut {
    #[serde(default)]
    content: Option<String>,
    // Servers that parse the model's tool intent themselves (e.g. gpt-oss behind
    // vLLM) return it here, with no `content`, even though no `tools` were sent.
    #[serde(default)]
    tool_calls: Option<Vec<OpenAIToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIToolCall {
    function: OpenAIFunctionCall,
}

#[derive(Debug, Deserialize)]
struct OpenAIFunctionCall {
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

/// The reply as text. A native tool call is rendered in the run loop's
/// `<tool_call>` text protocol (first call only: the loop runs one tool per step).
fn openai_reply_text(choice: OpenAIChoice) -> Result<String, String> {
    let content = choice.message.content.unwrap_or_default();
    let Some(call) = choice.message.tool_calls.and_then(|calls| calls.into_iter().next()) else {
        if content.trim().is_empty() {
            return Err(format!(
                "The model returned no text (finish_reason: {}). If it is \"length\", raise Max tokens.",
                choice.finish_reason.as_deref().unwrap_or("unknown")
            ));
        }
        return Ok(content);
    };
    // `arguments` is a JSON string per the OpenAI spec; some servers send an object.
    let args = match call.function.arguments {
        serde_json::Value::String(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        other => other,
    };
    let args = if args.is_object() { args } else { serde_json::json!({}) };
    let tag = format!(
        "<tool_call>{}</tool_call>",
        serde_json::json!({ "name": call.function.name, "args": args })
    );
    Ok(if content.trim().is_empty() {
        tag
    } else {
        format!("{}\n{tag}", content.trim_end())
    })
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaChatMessage,
}

#[derive(Debug, Deserialize)]
struct OllamaChatMessage {
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderHealth {
    pub ok: bool,
    pub provider: String,
    pub latency_ms: u64,
    pub message: String,
    pub model_available: bool,
    pub pull_command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderDefaults {
    pub llm_provider: String,
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub openai_api_key_configured: bool,
    pub anthropic_api_key_configured: bool,
    pub ollama_api_key_configured: bool,
    pub suggested_ollama_models: Vec<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// HTTP client for generation calls. Without explicit timeouts reqwest waits
/// forever, hanging the whole workflow if an endpoint accepts the connection
/// but never responds. Connect fails fast; the response timeout is generous
/// so slow local CPU models still finish.
pub(crate) fn generation_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &key[..4], &key[key.len() - 4..])
}

/// A custom endpoint URL may carry a key in its query string (`?api-key=…`);
/// never echo that part in error messages, which reach the UI and audit log.
fn without_query(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

pub(crate) fn resolve_api_key(provided: &str, env_name: &str) -> Result<String, String> {
    let trimmed = provided.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }

    env::var(env_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("{env_name} is not configured. Save a key in Settings or set {env_name}.")
        })
}

fn classify_openai_error(status: u16, body: &str) -> ApiErrorKind {
    if status == 429 {
        let lower = body.to_lowercase();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            let err_type = v["error"]["type"].as_str().unwrap_or("");
            if err_type == "insufficient_quota" {
                return ApiErrorKind::Billing;
            }
        }
        if lower.contains("exceeded your current quota")
            || lower.contains("billing")
            || lower.contains("quota")
        {
            return ApiErrorKind::Billing;
        }
        return ApiErrorKind::RateLimit;
    }
    if matches!(status, 402 | 403) {
        let lower = body.to_lowercase();
        if lower.contains("billing") || lower.contains("quota") {
            return ApiErrorKind::Billing;
        }
    }
    if is_transient_status(status) {
        return ApiErrorKind::Transient;
    }
    ApiErrorKind::Other
}

fn classify_anthropic_error(status: u16, body: &str) -> ApiErrorKind {
    let lower = body.to_lowercase();
    if matches!(status, 400 | 402 | 403)
        && (lower.contains("credit balance")
            || lower.contains("insufficient")
            || lower.contains("plans & billing")
            || lower.contains("billing"))
    {
        return ApiErrorKind::Billing;
    }
    if status == 429 {
        return ApiErrorKind::RateLimit;
    }
    if is_transient_status(status) {
        return ApiErrorKind::Transient;
    }
    ApiErrorKind::Other
}

fn openai_message_from_body(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = v["error"]["message"].as_str() {
            return msg.to_string();
        }
    }
    body.to_string()
}

fn normalize_provider_error(provider: &str, status: u16, body: &str) -> NormalizedProviderError {
    let kind = match provider {
        "openai" => classify_openai_error(status, body),
        "anthropic" => classify_anthropic_error(status, body),
        _ => ApiErrorKind::Other,
    };

    match (provider, kind) {
        ("openai", ApiErrorKind::Billing) => NormalizedProviderError {
            message: OPENAI_QUOTA_MESSAGE.to_string(),
            retryable: false,
            billing_related: true,
        },
        ("openai", ApiErrorKind::RateLimit) => NormalizedProviderError {
            message: OPENAI_RATE_LIMIT_MESSAGE.to_string(),
            retryable: true,
            billing_related: false,
        },
        ("anthropic", ApiErrorKind::Billing) => NormalizedProviderError {
            message: ANTHROPIC_CREDIT_MESSAGE.to_string(),
            retryable: false,
            billing_related: true,
        },
        ("anthropic", ApiErrorKind::RateLimit) => NormalizedProviderError {
            message: "Anthropic API rate limit reached. The application will retry with exponential backoff."
                .to_string(),
            retryable: true,
            billing_related: false,
        },
        ("openai", ApiErrorKind::Transient) => NormalizedProviderError {
            message: format!("OpenAI {status} (temporary server error): {}", openai_message_from_body(body)),
            retryable: true,
            billing_related: false,
        },
        ("anthropic", ApiErrorKind::Transient) => NormalizedProviderError {
            message: format!("Anthropic {status} (temporary server error): {}", anthropic_message_from_body(body)),
            retryable: true,
            billing_related: false,
        },
        ("openai", ApiErrorKind::Other) => NormalizedProviderError {
            message: format!("OpenAI {status}: {}", openai_message_from_body(body)),
            retryable: false,
            billing_related: false,
        },
        ("anthropic", ApiErrorKind::Other) => NormalizedProviderError {
            message: format!("Anthropic {status}: {}", anthropic_message_from_body(body)),
            retryable: false,
            billing_related: false,
        },
        _ => NormalizedProviderError {
            message: body.to_string(),
            retryable: false,
            billing_related: false,
        },
    }
}

fn anthropic_message_from_body(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = v["error"]["message"].as_str() {
            return msg.to_string();
        }
    }
    body.to_string()
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

fn redact_secret(text: &str, secret: Option<&str>) -> String {
    let Some(secret) = secret.map(str::trim).filter(|secret| !secret.is_empty()) else {
        return text.to_string();
    };
    text.replace(secret, "[redacted]")
}

/// Chat Completions request body. The official API takes `max_completion_tokens`
/// (reasoning models reject `max_tokens`) and `reasoning_effort`; custom
/// OpenAI-compatible servers keep the widely supported `max_tokens`.
fn openai_chat_body(
    model: &str,
    system: &str,
    user_message: &str,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    custom_endpoint: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message}
        ],
    });
    let max_tokens_field = if custom_endpoint { "max_tokens" } else { "max_completion_tokens" };
    body[max_tokens_field] = serde_json::json!(max_tokens);
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    body
}

#[tauri::command]
pub async fn call_openai_api(
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
    // Optional base URL for custom OpenAI-compatible endpoints.
    // When None or empty, defaults to https://api.openai.com/v1
    base_url: Option<String>,
) -> Result<String, String> {
    let client = generation_client()?;

    // Build the endpoint URL — use custom base URL if provided, otherwise OpenAI default
    let endpoint = base_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|u| format!("{}/chat/completions", u.trim_end_matches('/')))
        .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());

    // Resolve API key — for custom endpoints, key may be optional
    let is_custom = base_url
        .as_deref()
        .map(|u| !u.trim().is_empty())
        .unwrap_or(false);
    let api_key = if is_custom && api_key.trim().is_empty() {
        // Custom endpoint with no key — skip auth header
        String::new()
    } else {
        resolve_api_key(&api_key, "OPENAI_API_KEY")?
    };

    let body = openai_chat_body(
        &model,
        &system,
        &user_message,
        max_tokens,
        reasoning_effort.as_deref(),
        is_custom,
    );

    let value = post_openai(&client, &endpoint, &api_key, &body)
        .await
        .map_err(|f| f.message)?;
    let parsed: OpenAIResponse = serde_json::from_value(value)
        .map_err(|e| format!("Failed to parse OpenAI response: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "No content in OpenAI response".to_string())
        .and_then(openai_reply_text)
}

/// A failed provider request; `status` is None when no HTTP response arrived.
#[derive(Debug)]
pub(crate) struct HttpFailure {
    pub status: Option<u16>,
    pub message: String,
}

/// Send a Chat Completions request, retrying rate limits and temporary server
/// errors (after 1 s, 2 s, 4 s). Returns the successful response with its body unread.
pub(crate) async fn send_openai(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, HttpFailure> {
    let delays = [1u64, 2, 4];
    let mut last_err = String::new();

    for attempt in 0..=3usize {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(delays[attempt - 1])).await;
        }

        let mut req = client
            .post(endpoint)
            .header("Content-Type", "application/json");
        if !api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }
        let response = req.json(body).send().await.map_err(|e| HttpFailure {
            status: None,
            message: format!("Network error: {}", e.without_url()),
        })?;

        let status = response.status().as_u16();
        let fail = |message: String| HttpFailure { status: Some(status), message };

        if response.status().is_success() {
            return Ok(response);
        }

        let text = response.text().await.unwrap_or_default();
        let normalized = normalize_provider_error("openai", status, &text);
        if normalized.billing_related {
            return Err(fail(normalized.message));
        }
        if normalized.retryable {
            if attempt == 3 {
                return Err(fail(format!(
                    "{} Retried 3 times without success.",
                    normalized.message
                )));
            }
            last_err = format!("OpenAI rate limit: retrying... (attempt {})", attempt + 1);
            eprintln!("{last_err}");
            continue;
        }
        return Err(fail(normalized.message));
    }

    Err(HttpFailure { status: None, message: last_err })
}

/// POST a Chat Completions request (send_openai) and parse the JSON body.
pub(crate) async fn post_openai(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, HttpFailure> {
    let response = send_openai(client, endpoint, api_key, body).await?;
    let status = response.status().as_u16();
    response.json().await.map_err(|e| HttpFailure {
        status: Some(status),
        message: format!("Failed to parse OpenAI response: {}", e.without_url()),
    })
}

// ── Anthropic / Claude ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ClaudeRequest {
    model: String,
    max_tokens: u32,
    system: String,
    messages: Vec<ClaudeMessage>,
}

#[derive(Debug, Serialize)]
struct ClaudeMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeResponse {
    content: Vec<ContentBlock>,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

async fn anthropic_call_inner(
    client: &reqwest::Client,
    model: &str,
    system: &str,
    user_message: &str,
    api_key: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let api_key = resolve_api_key(api_key, "ANTHROPIC_API_KEY")?;
    let body = ClaudeRequest {
        model: normalize_anthropic_model(model),
        max_tokens,
        system: system.to_string(),
        messages: vec![ClaudeMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        }],
    };
    let body = serde_json::to_value(&body).map_err(|e| e.to_string())?;

    let value = post_anthropic(client, &api_key, &body)
        .await
        .map_err(|f| f.message)?;
    let parsed: ClaudeResponse = serde_json::from_value(value)
        .map_err(|e| format!("Failed to parse Anthropic response: {e}"))?;
    parsed
        .content
        .into_iter()
        .find(|b| b.kind == "text")
        .and_then(|b| b.text)
        .ok_or_else(|| "No text content in Anthropic response".to_string())
}

/// Send a Messages API request, retrying rate limits and temporary server errors
/// (after 1 s, 2 s, 4 s). Returns the successful response with its body unread.
pub(crate) async fn send_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, HttpFailure> {
    let delays = [1u64, 2, 4];
    let mut last_err = String::new();

    for attempt in 0..=3usize {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(delays[attempt - 1])).await;
        }

        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| HttpFailure {
                status: None,
                message: format!("Anthropic network error: {e}"),
            })?;

        let status = response.status().as_u16();
        let fail = |message: String| HttpFailure { status: Some(status), message };

        if response.status().is_success() {
            return Ok(response);
        }

        let text = response.text().await.unwrap_or_default();
        let normalized = normalize_provider_error("anthropic", status, &text);
        if normalized.billing_related {
            return Err(fail(normalized.message));
        }
        if normalized.retryable {
            if attempt == 3 {
                return Err(fail(format!(
                    "{} Retried 3 times without success.",
                    normalized.message
                )));
            }
            last_err = format!(
                "Anthropic rate limit: retrying... (attempt {})",
                attempt + 1
            );
            eprintln!("{last_err}");
            continue;
        }
        return Err(fail(normalized.message));
    }

    Err(HttpFailure { status: None, message: last_err })
}

/// POST a Messages API request (send_anthropic) and parse the JSON body.
pub(crate) async fn post_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, HttpFailure> {
    let response = send_anthropic(client, api_key, body).await?;
    let status = response.status().as_u16();
    response.json().await.map_err(|e| HttpFailure {
        status: Some(status),
        message: format!("Failed to parse Anthropic response: {e}"),
    })
}

#[tauri::command]
pub async fn call_anthropic_api(
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
) -> Result<String, String> {
    let client = generation_client()?;
    anthropic_call_inner(
        &client,
        &model,
        &system,
        &user_message,
        &api_key,
        max_tokens,
    )
    .await
}

/// Backward-compatible alias for call_anthropic_api
#[tauri::command]
pub async fn call_claude_api(
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
) -> Result<String, String> {
    let client = generation_client()?;
    anthropic_call_inner(
        &client,
        &model,
        &system,
        &user_message,
        &api_key,
        max_tokens,
    )
    .await
}

// ── Ollama ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn call_ollama_api(
    model: String,
    system: String,
    user_message: String,
    base_url: String,
    api_key: Option<String>,
    max_tokens: u32,
) -> Result<String, String> {
    let client = generation_client()?;
    let base_url = if base_url.trim().is_empty() {
        DEFAULT_OLLAMA_BASE_URL.to_string()
    } else {
        base_url.trim().to_string()
    };
    let api_key = resolve_ollama_api_key_for_endpoint(
        api_key.as_deref().unwrap_or(""),
        &base_url,
        ollama_requires_api_key(&base_url),
    )?;
    let model = normalize_ollama_model(&model);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message}
        ],
        "stream": false,
        "options": {
            "num_predict": max_tokens
        },
    });

    let value = post_ollama(&client, &base_url, api_key.as_deref(), &body, &model)
        .await
        .map_err(|f| f.message)?;
    let parsed: OllamaChatResponse = serde_json::from_value(value)
        .map_err(|e| format!("Failed to parse Ollama response: {e}"))?;

    if parsed.message.content.trim().is_empty() {
        Err("No content in Ollama response".to_string())
    } else {
        Ok(parsed.message.content)
    }
}

/// POST an /api/chat request (send_ollama) and parse the JSON body.
pub(crate) async fn post_ollama(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    body: &serde_json::Value,
    model: &str,
) -> Result<serde_json::Value, HttpFailure> {
    let response = send_ollama(client, base_url, api_key, body, model).await?;
    let status = response.status().as_u16();
    response.json().await.map_err(|e| HttpFailure {
        status: Some(status),
        message: format!("Failed to parse Ollama response: {e}"),
    })
}

/// Send Ollama's `/api/chat` request (no retries). Returns the successful
/// response with its body unread.
pub(crate) async fn send_ollama(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    body: &serde_json::Value,
    model: &str,
) -> Result<reqwest::Response, HttpFailure> {
    let url = ollama_api_endpoint(base_url, "chat");
    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(body);

    if let Some(api_key) = api_key {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = request.send().await.map_err(|_| HttpFailure {
        status: None,
        message: ollama_unavailable_message(base_url),
    })?;

    let status = response.status();
    let fail = |message: String| HttpFailure { status: Some(status.as_u16()), message };
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(fail(format!(
                "Ollama endpoint returned {status}. If this is Ollama Cloud or an authenticated remote endpoint, set OLLAMA_API_KEY or OLLAMA_REMOTE_API_KEY."
            )));
        }
        // Ollama answers a missing model with 404 / "model '…' not found". Other
        // errors that merely mention "model" (e.g. out of memory) are reported as-is.
        if status.as_u16() == 404 || text.to_lowercase().contains("not found") {
            return Err(fail(format!(
                "Ollama model {model} is not installed. Run: ollama pull {model}"
            )));
        }
        let safe_text = redact_secret(&text, api_key);
        return Err(fail(format!("Ollama {status}: {safe_text}")));
    }

    Ok(response)
}

// ── Provider health check ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

fn ollama_unavailable_message(base_url: &str) -> String {
    if ollama_requires_api_key(base_url) {
        return format!(
            "Ollama Cloud is selected, but the endpoint is not reachable at {base_url}. Please check network access and try again."
        );
    }
    format!(
        "Ollama is selected, but the local Ollama server is not reachable at {base_url}. Please start Ollama and try again."
    )
}

fn ollama_missing_api_key_message() -> String {
    "Ollama Cloud is selected, but no API key is configured. Set OLLAMA_API_KEY for ollama.com, or OLLAMA_REMOTE_API_KEY for an authenticated remote endpoint.".to_string()
}

pub(crate) fn ollama_requires_api_key(base_url: &str) -> bool {
    let host = ollama_host(base_url);
    host == "ollama.com" || host.ends_with(".ollama.com")
}

fn ollama_host(base_url: &str) -> String {
    let lower = base_url.trim().to_lowercase();
    let without_protocol = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    if let Some(rest) = without_protocol.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_string();
    }
    without_protocol
        .split(|c| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string()
}

fn ollama_is_remote_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return false;
    }
    let host = ollama_host(base_url);
    !host.is_empty() && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
}

fn ollama_env_key_names(base_url: &str) -> &'static [&'static str] {
    if ollama_requires_api_key(base_url) {
        &["OLLAMA_API_KEY"]
    } else if ollama_is_remote_url(base_url) {
        &["OLLAMA_REMOTE_API_KEY"]
    } else {
        &[]
    }
}

fn ollama_api_endpoint(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let path = path.trim().trim_start_matches('/');
    if base.ends_with("/api") {
        format!("{base}/{path}")
    } else {
        format!("{base}/api/{path}")
    }
}

/// Known model IDs, used only when the key may not list models (403/404). Any other
/// failure (e.g. 401 for a bad key) is reported, not masked as a successful list.
fn anthropic_models_fallback(status: u16) -> Option<Vec<String>> {
    if !matches!(status, 403 | 404) {
        return None;
    }
    Some(
        [
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ]
        .iter()
        .map(|id| id.to_string())
        .collect(),
    )
}

/// Workflows use dotted display versions ("claude-sonnet-4.6"); the Anthropic API
/// only accepts hyphenated IDs ("claude-sonnet-4-6") and 404s on the dotted form.
/// Mirrors toAnthropicModelId() in providerAdapter.ts.
pub(crate) fn normalize_anthropic_model(model: &str) -> String {
    let model = model.trim();
    if model.starts_with("claude-") {
        model.replace('.', "-")
    } else {
        model.to_string()
    }
}

pub(crate) fn normalize_ollama_model(model: &str) -> String {
    match model.trim() {
        "gemma4-31b:cloud" => "gemma4:31b-cloud".to_string(),
        value => value.to_string(),
    }
}

pub(crate) fn resolve_ollama_api_key_for_endpoint(
    provided: &str,
    base_url: &str,
    required: bool,
) -> Result<Option<String>, String> {
    let trimmed = provided.trim();
    if !trimmed.is_empty() {
        return Ok(Some(trimmed.to_string()));
    }

    for env_name in ollama_env_key_names(base_url) {
        if let Some(value) = env::var(env_name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(Some(value));
        }
    }

    if required {
        Err(ollama_missing_api_key_message())
    } else {
        Ok(None)
    }
}

fn ollama_has_model(tags: &OllamaTagsResponse, model: &str) -> bool {
    // Ollama resolves an untagged name to ":latest" ("deepseek-coder-v2" means
    // "deepseek-coder-v2:latest"); a tagged name must match exactly — another tag
    // of the same model (llama3.1:8b vs llama3.1:70b) is a different model.
    let wanted = if model.contains(':') {
        model.to_string()
    } else {
        format!("{model}:latest")
    };
    tags.models.iter().any(|m| m.name == wanted || m.name == model)
}

// ── Model listing ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelEntry>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelEntry {
    id: String,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModelEntry>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelEntry {
    id: String,
}

/// Returns true for OpenAI model IDs that support chat completions.
fn is_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    // Exclude embeddings, audio, image, fine-tune bases, and deprecated models.
    let exclude = [
        "embedding",
        "tts",
        "whisper",
        "dall-e",
        "davinci-002",
        "babbage",
        "ada",
        "curie",
        "moderation",
        "realtime",
        "instruct",
        "preview-2023",
        "preview-2024",
    ];
    if exclude.iter().any(|e| id.contains(e)) {
        return false;
    }
    // Include known chat families.
    id.starts_with("gpt-")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
        || id.starts_with("chatgpt-")
        || id.starts_with("gpt4")
}

/// List models available for the given provider and credentials.
/// Returns a sorted Vec<String> of model IDs on success.
#[tauri::command]
pub async fn list_provider_models(
    provider: String,
    api_key: String,
    base_url: String,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    match provider.as_str() {
        "ollama" | "ollama-cloud" => {
            let url_base = if base_url.trim().is_empty() {
                if provider == "ollama-cloud" {
                    DEFAULT_OLLAMA_CLOUD_BASE_URL.to_string()
                } else {
                    DEFAULT_OLLAMA_BASE_URL.to_string()
                }
            } else {
                base_url.trim().to_string()
            };
            // For BOTH local and remote Ollama, pass auth key when present.
            // Remote servers behind a reverse proxy need it even if they're
            // not ollama.com (e.g. https://myserver.com:11434).
            let auth_key = resolve_ollama_api_key_for_endpoint(
                &api_key,
                &url_base,
                provider == "ollama-cloud" && ollama_requires_api_key(&url_base),
            )?;
            let tags_url = ollama_api_endpoint(&url_base, "tags");
            let mut req = client.get(&tags_url);
            if let Some(key) = &auth_key {
                req = req.header("Authorization", format!("Bearer {key}"));
            }
            let resp = req.send().await
                .map_err(|_| format!("Cannot reach Ollama at {url_base}. Check the URL and that the server is running."))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                if status == 401 || status == 403 {
                    return Err(
                        "Authentication required. Add an auth token for this endpoint.".to_string(),
                    );
                }
                return Err(format!("Ollama endpoint returned HTTP {status}"));
            }
            let tags: OllamaTagsResponse = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse model list: {}", e.without_url()))?;
            let mut models: Vec<String> = tags.models.into_iter().map(|m| m.name).collect();
            models.sort();
            Ok(models)
        }

        "openai" => {
            let key = resolve_api_key(&api_key, "OPENAI_API_KEY")?;
            let resp = client
                .get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {key}"))
                .send()
                .await
                .map_err(|e| format!("OpenAI network error: {e}"))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(normalize_provider_error("openai", status, &body).message);
            }
            let data: OpenAIModelsResponse = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse models: {e}"))?;
            let mut models: Vec<String> = data
                .data
                .into_iter()
                .map(|m| m.id)
                .filter(|id| is_chat_model(id))
                .collect();
            models.sort();
            Ok(models)
        }

        "anthropic" => {
            let key = resolve_api_key(&api_key, "ANTHROPIC_API_KEY")?;
            let resp = client
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| format!("Anthropic network error: {e}"))?;
            if resp.status().is_success() {
                let data: AnthropicModelsResponse = resp
                    .json()
                    .await
                    .map_err(|e| format!("Failed to parse models: {e}"))?;
                let mut models: Vec<String> = data.data.into_iter().map(|m| m.id).collect();
                models.sort_by(|a, b| b.cmp(a)); // newest first
                Ok(models)
            } else {
                let status = resp.status().as_u16();
                match anthropic_models_fallback(status) {
                    Some(models) => Ok(models),
                    None => {
                        let text = resp.text().await.unwrap_or_default();
                        Err(normalize_provider_error("anthropic", status, &text).message)
                    }
                }
            }
        }

        // OpenAI-compatible custom endpoint: use provided base_url
        "openai-compatible" => {
            let effective_base = if base_url.trim().is_empty() {
                return Err("Base URL is required for OpenAI-compatible endpoints.".to_string());
            } else {
                base_url.trim().to_string()
            };
            let models_url = format!("{}/models", effective_base.trim_end_matches('/'));
            let mut req = client.get(&models_url);
            if !api_key.trim().is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key.trim()));
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("Cannot reach {}: {}", without_query(&effective_base), e.without_url()))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                if status == 401 || status == 403 {
                    return Err("Authentication required. Check your API key.".to_string());
                }
                return Err(format!("Endpoint returned HTTP {status}"));
            }
            let data: OpenAIModelsResponse = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse model list: {}", e.without_url()))?;
            let mut models: Vec<String> = data.data.into_iter().map(|m| m.id).collect();
            models.sort();
            Ok(models)
        }

        other => Err(format!("Model listing not supported for provider: {other}")),
    }
}

#[tauri::command]
pub fn get_provider_defaults() -> ProviderDefaults {
    let llm_provider = env::var("LLM_PROVIDER").unwrap_or_else(|_| "auto".to_string());
    let ollama_base_url = env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| {
        if llm_provider.trim().eq_ignore_ascii_case("ollama-cloud") {
            DEFAULT_OLLAMA_CLOUD_BASE_URL.to_string()
        } else {
            DEFAULT_OLLAMA_BASE_URL.to_string()
        }
    });
    let ollama_model = env::var("OLLAMA_MODEL").unwrap_or_else(|_| {
        if llm_provider.trim().eq_ignore_ascii_case("ollama-cloud") {
            DEFAULT_OLLAMA_CLOUD_MODEL.to_string()
        } else {
            DEFAULT_OLLAMA_MODEL.to_string()
        }
    });
    let ollama_model = normalize_ollama_model(&ollama_model);
    let ollama_api_key_configured =
        resolve_ollama_api_key_for_endpoint("", &ollama_base_url, false)
            .map(|key| key.is_some())
            .unwrap_or(false);

    ProviderDefaults {
        llm_provider,
        ollama_base_url,
        ollama_model,
        openai_api_key_configured: resolve_api_key("", "OPENAI_API_KEY").is_ok(),
        anthropic_api_key_configured: resolve_api_key("", "ANTHROPIC_API_KEY").is_ok(),
        ollama_api_key_configured,
        suggested_ollama_models: vec![
            "gemma4:31b-cloud".to_string(),
            "qwen2.5-coder:7b".to_string(),
            "qwen2.5-coder:14b".to_string(),
            "llama3.1:8b".to_string(),
            "deepseek-coder".to_string(),
            "codellama".to_string(),
        ],
    }
}

#[tauri::command]
pub async fn check_provider_health(
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
) -> Result<ProviderHealth, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let start = Instant::now();

    match provider.as_str() {
        "openai" => {
            let api_key = match resolve_api_key(&api_key, "OPENAI_API_KEY") {
                Ok(key) => key,
                Err(message) => {
                    return Ok(ProviderHealth {
                        ok: false,
                        provider: "openai".into(),
                        latency_ms: 0,
                        message,
                        model_available: false,
                        pull_command: None,
                    });
                }
            };
            let body = serde_json::json!({
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "ok"}],
                "max_tokens": 1,
            });
            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await;

            let latency_ms = start.elapsed().as_millis() as u64;
            match resp {
                Err(e) => Ok(ProviderHealth {
                    ok: false,
                    provider: "openai".into(),
                    latency_ms,
                    message: format!("Network error: {e}"),
                    model_available: false,
                    pull_command: None,
                }),
                Ok(r) => {
                    let status = r.status().as_u16();
                    let ok = r.status().is_success();
                    let text = r.text().await.unwrap_or_default();
                    let message = if ok {
                        format!("OpenAI OK ({}ms)", latency_ms)
                    } else {
                        normalize_provider_error("openai", status, &text).message
                    };
                    Ok(ProviderHealth {
                        ok,
                        provider: "openai".into(),
                        latency_ms,
                        message,
                        model_available: ok,
                        pull_command: None,
                    })
                }
            }
        }

        "anthropic" => {
            let api_key = match resolve_api_key(&api_key, "ANTHROPIC_API_KEY") {
                Ok(key) => key,
                Err(message) => {
                    return Ok(ProviderHealth {
                        ok: false,
                        provider: "anthropic".into(),
                        latency_ms: 0,
                        message,
                        model_available: false,
                        pull_command: None,
                    });
                }
            };
            let body = ClaudeRequest {
                model: "claude-haiku-4-5".into(),
                max_tokens: 1,
                system: String::new(),
                messages: vec![ClaudeMessage {
                    role: "user".into(),
                    content: "ok".into(),
                }],
            };
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await;

            let latency_ms = start.elapsed().as_millis() as u64;
            match resp {
                Err(e) => Ok(ProviderHealth {
                    ok: false,
                    provider: "anthropic".into(),
                    latency_ms,
                    message: format!("Network error: {e}"),
                    model_available: false,
                    pull_command: None,
                }),
                Ok(r) => {
                    let status = r.status().as_u16();
                    let ok = r.status().is_success();
                    let text = r.text().await.unwrap_or_default();
                    let message = if ok {
                        format!("Anthropic OK ({}ms)", latency_ms)
                    } else {
                        normalize_provider_error("anthropic", status, &text).message
                    };
                    Ok(ProviderHealth {
                        ok,
                        provider: "anthropic".into(),
                        latency_ms,
                        message,
                        model_available: ok,
                        pull_command: None,
                    })
                }
            }
        }

        "ollama" => {
            let base_url = if base_url.trim().is_empty() {
                DEFAULT_OLLAMA_BASE_URL.to_string()
            } else {
                base_url.trim().to_string()
            };
            let model = if model.trim().is_empty() {
                DEFAULT_OLLAMA_MODEL.to_string()
            } else {
                normalize_ollama_model(&model)
            };
            let tags_url = ollama_api_endpoint(&base_url, "tags");
            let resp = client.get(&tags_url).send().await;
            let latency_ms = start.elapsed().as_millis() as u64;

            match resp {
                Err(_) => Ok(ProviderHealth {
                    ok: false,
                    provider: "ollama".into(),
                    latency_ms,
                    message: ollama_unavailable_message(&base_url),
                    model_available: false,
                    pull_command: Some(format!("ollama pull {model}")),
                }),
                Ok(r) if !r.status().is_success() => Ok(ProviderHealth {
                    ok: false,
                    provider: "ollama".into(),
                    latency_ms,
                    message: format!("Ollama returned status {}", r.status()),
                    model_available: false,
                    pull_command: Some(format!("ollama pull {model}")),
                }),
                Ok(r) => {
                    let tags: OllamaTagsResponse = r
                        .json()
                        .await
                        .unwrap_or(OllamaTagsResponse { models: vec![] });
                    let model_available = ollama_has_model(&tags, &model);
                    let pull_command = if model_available {
                        None
                    } else {
                        Some(format!("ollama pull {model}"))
                    };
                    let message = if model_available {
                        format!("Ollama OK ({}ms) — model {model} available", latency_ms)
                    } else {
                        format!("Ollama connected ({}ms) — model {model} not found. Run: ollama pull {model}", latency_ms)
                    };
                    Ok(ProviderHealth {
                        ok: model_available,
                        provider: "ollama".into(),
                        latency_ms,
                        message,
                        model_available,
                        pull_command,
                    })
                }
            }
        }

        // Ollama Cloud — same /api/tags probe but with optional Bearer auth
        "ollama-cloud" => {
            let base_url = if base_url.trim().is_empty() {
                DEFAULT_OLLAMA_CLOUD_BASE_URL.to_string()
            } else {
                base_url.trim().to_string()
            };
            let model = if model.trim().is_empty() {
                DEFAULT_OLLAMA_CLOUD_MODEL.to_string()
            } else {
                normalize_ollama_model(&model)
            };
            let auth_key = resolve_ollama_api_key_for_endpoint(
                &api_key,
                &base_url,
                ollama_requires_api_key(&base_url),
            )?;
            let tags_url = ollama_api_endpoint(&base_url, "tags");
            let mut req = client.get(&tags_url);
            if let Some(key) = &auth_key {
                req = req.header("Authorization", format!("Bearer {key}"));
            }
            let resp = req.send().await;
            let latency_ms = start.elapsed().as_millis() as u64;

            match resp {
                Err(_) => Ok(ProviderHealth {
                    ok: false,
                    provider: "ollama-cloud".into(),
                    latency_ms,
                    message: ollama_unavailable_message(&base_url),
                    model_available: false,
                    pull_command: None,
                }),
                Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => {
                    Ok(ProviderHealth {
                        ok: false,
                        provider: "ollama-cloud".into(),
                        latency_ms,
                        message: ollama_missing_api_key_message(),
                        model_available: false,
                        pull_command: None,
                    })
                }
                Ok(r) if !r.status().is_success() => Ok(ProviderHealth {
                    ok: false,
                    provider: "ollama-cloud".into(),
                    latency_ms,
                    message: format!("Ollama Cloud returned status {}", r.status()),
                    model_available: false,
                    pull_command: None,
                }),
                Ok(r) => {
                    let tags: OllamaTagsResponse = r
                        .json()
                        .await
                        .unwrap_or(OllamaTagsResponse { models: vec![] });
                    let in_tags = ollama_has_model(&tags, &model);

                    // Cloud models with ":cloud" suffix (e.g. gemma4:31b-cloud) stream on-demand
                    // from Ollama Cloud — they don't need to be "installed" in /api/tags.
                    // If the endpoint is reachable, the model is considered available.
                    let is_cloud_model = model.ends_with("-cloud")
                        || model.contains(":cloud")
                        || ollama_requires_api_key(&base_url); // ollama.com direct API

                    let model_available = in_tags || is_cloud_model;
                    let message = if in_tags {
                        format!("Ollama Cloud OK ({}ms) — {model} ready", latency_ms)
                    } else if is_cloud_model {
                        format!(
                            "Ollama Cloud connected ({}ms) — {model} will stream on-demand",
                            latency_ms
                        )
                    } else {
                        format!(
                            "Ollama Cloud connected ({}ms) — {model} not listed (may still work)",
                            latency_ms
                        )
                    };
                    Ok(ProviderHealth {
                        ok: model_available,
                        provider: "ollama-cloud".into(),
                        latency_ms,
                        message,
                        model_available,
                        pull_command: None,
                    })
                }
            }
        }

        // OpenAI-compatible custom endpoint health check
        "openai-compatible" => {
            if base_url.trim().is_empty() {
                return Ok(ProviderHealth {
                    ok: false,
                    provider: "openai-compatible".into(),
                    latency_ms: 0,
                    message: "Custom endpoint URL is not configured.".into(),
                    model_available: false,
                    pull_command: None,
                });
            }
            let endpoint = format!(
                "{}/chat/completions",
                base_url.trim().trim_end_matches('/')
            );
            let probe_model = if model.trim().is_empty() { "gpt-4o-mini" } else { model.trim() };
            let body = serde_json::json!({
                "model": probe_model,
                "messages": [{"role": "user", "content": "ok"}],
                "max_tokens": 1,
            });
            let mut req = client
                .post(&endpoint)
                .header("Content-Type", "application/json")
                .json(&body);
            if !api_key.trim().is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key.trim()));
            }
            let resp = req.send().await;
            let latency_ms = start.elapsed().as_millis() as u64;
            match resp {
                Err(e) => Ok(ProviderHealth {
                    ok: false,
                    provider: "openai-compatible".into(),
                    latency_ms,
                    message: format!("Cannot reach {}: {}", without_query(base_url.trim()), e.without_url()),
                    model_available: false,
                    pull_command: None,
                }),
                Ok(r) => {
                    let status = r.status().as_u16();
                    let ok = r.status().is_success();
                    let text = r.text().await.unwrap_or_default();
                    let message = if ok {
                        format!("Custom endpoint OK ({}ms)", latency_ms)
                    } else if status == 401 || status == 403 {
                        "Authentication failed — check your API key.".into()
                    } else if status == 404 {
                        format!(
                            "HTTP 404 at {endpoint} — check that the base URL includes the API prefix (most servers use /v1, e.g. http://host:port/v1)."
                        )
                    } else {
                        format!("HTTP {status}: {text}")
                    };
                    Ok(ProviderHealth {
                        ok,
                        provider: "openai-compatible".into(),
                        latency_ms,
                        message,
                        model_available: ok,
                        pull_command: None,
                    })
                }
            }
        }

        other => Err(format!("Unknown provider: {other}")),
    }
}

// Suppress unused warning for mask_key — used in debug builds
#[allow(dead_code)]
fn _use_mask_key(key: &str) -> String {
    mask_key(key)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    fn request_complete(bytes: &[u8]) -> bool {
        let request = String::from_utf8_lossy(bytes);
        let Some(header_end) = request.find("\r\n\r\n") else {
            return false;
        };
        let content_length = request[..header_end]
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        bytes.len() >= header_end + 4 + content_length
    }

    pub(crate) fn spawn_mock_ollama_server(status: u16, body: &'static str) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !request_complete(&bytes) {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8_lossy(&bytes).to_string();
            tx.send(request).unwrap();
            let status_text = if status == 200 {
                "OK"
            } else {
                "Internal Server Error"
            };
            let response = format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        (format!("http://{addr}"), rx)
    }

    #[test]
    fn openai_quota_error_is_billing_and_not_retryable() {
        let body = r#"{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}"#;
        let normalized = normalize_provider_error("openai", 429, body);

        assert_eq!(normalized.message, OPENAI_QUOTA_MESSAGE);
        assert!(!normalized.retryable);
        assert!(normalized.billing_related);
    }

    #[test]
    fn openai_rate_limit_error_is_retryable() {
        let body = r#"{"error":{"message":"Too many requests","type":"rate_limit_exceeded"}}"#;
        let normalized = normalize_provider_error("openai", 429, body);

        assert_eq!(normalized.message, OPENAI_RATE_LIMIT_MESSAGE);
        assert!(normalized.retryable);
        assert!(!normalized.billing_related);
    }

    #[test]
    fn anthropic_low_credit_error_is_billing_and_not_retryable() {
        let body = r#"{"error":{"message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing."}}"#;
        let normalized = normalize_provider_error("anthropic", 400, body);

        assert_eq!(normalized.message, ANTHROPIC_CREDIT_MESSAGE);
        assert!(!normalized.retryable);
        assert!(normalized.billing_related);
    }

    #[test]
    fn ollama_model_lookup_requires_exact_installed_model() {
        let tags = OllamaTagsResponse {
            models: vec![OllamaModel {
                name: "llama3.1:8b".to_string(),
            }],
        };

        assert!(ollama_has_model(&tags, "llama3.1:8b"));
        assert!(!ollama_has_model(&tags, "qwen2.5-coder:7b"));
        // A different tag of the same model is not installed (preflight would pass,
        // then every node would fail).
        assert!(!ollama_has_model(&tags, "llama3.1:70b"));
        // Ollama resolves an untagged name to ":latest".
        assert!(!ollama_has_model(&tags, "llama3.1"));
        let latest = OllamaTagsResponse {
            models: vec![OllamaModel {
                name: "deepseek-coder-v2:latest".to_string(),
            }],
        };
        assert!(ollama_has_model(&latest, "deepseek-coder-v2"));
    }

    #[test]
    fn ollama_cloud_base_url_requires_api_key() {
        assert!(ollama_requires_api_key("https://ollama.com"));
        assert!(ollama_requires_api_key("https://ollama.com/api"));
        assert!(ollama_is_remote_url("https://ollama.com/api"));
        assert!(ollama_is_remote_url("https://my-ollama.example.com"));
        assert!(!ollama_requires_api_key("http://localhost:11434"));
        assert!(!ollama_is_remote_url("http://localhost:11434"));
    }

    #[test]
    fn ollama_env_keys_are_scoped_to_endpoint_type() {
        assert_eq!(
            ollama_env_key_names("https://ollama.com/api"),
            &["OLLAMA_API_KEY"]
        );
        assert_eq!(
            ollama_env_key_names("https://my-ollama.example.com"),
            &["OLLAMA_REMOTE_API_KEY"]
        );
        assert!(ollama_env_key_names("http://localhost:11434").is_empty());
    }

    #[test]
    fn ollama_api_endpoint_accepts_host_or_api_base_url() {
        assert_eq!(
            ollama_api_endpoint("https://ollama.com", "chat"),
            "https://ollama.com/api/chat"
        );
        assert_eq!(
            ollama_api_endpoint("https://ollama.com/api", "chat"),
            "https://ollama.com/api/chat"
        );
        assert_eq!(
            ollama_api_endpoint("http://localhost:11434/", "/tags"),
            "http://localhost:11434/api/tags"
        );
    }

    #[test]
    fn ollama_model_alias_is_normalized() {
        assert_eq!(
            normalize_ollama_model("gemma4-31b:cloud"),
            "gemma4:31b-cloud"
        );
        assert_eq!(
            normalize_ollama_model("gemma4:31b-cloud"),
            "gemma4:31b-cloud"
        );
    }

    #[test]
    fn official_openai_body_uses_chat_completions_parameter_names() {
        // Chat Completions takes `reasoning_effort` (not the Responses-API `reasoning`
        // object) and reasoning models reject `max_tokens` in favour of
        // `max_completion_tokens`.
        let body = openai_chat_body("gpt-5.5", "sys", "hi", 1000, Some("high"), false);
        assert_eq!(body["max_completion_tokens"], 1000);
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn custom_openai_compatible_body_keeps_max_tokens() {
        // Local OpenAI-compatible servers (llama.cpp, vLLM, LM Studio) expect max_tokens.
        let body = openai_chat_body("local-model", "sys", "hi", 128, None, true);
        assert_eq!(body["max_tokens"], 128);
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn overloaded_and_server_errors_are_retryable() {
        let overloaded = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert!(normalize_provider_error("anthropic", 529, overloaded).retryable);
        assert!(normalize_provider_error("anthropic", 503, "").retryable);
        assert!(normalize_provider_error("openai", 502, "").retryable);
        // Client errors are not retried.
        assert!(!normalize_provider_error("anthropic", 400, r#"{"error":{"message":"bad"}}"#).retryable);
    }

    #[test]
    fn anthropic_model_list_falls_back_only_when_listing_is_not_permitted() {
        // A bad key (401) must surface as an error, not as a "successful" list.
        assert!(anthropic_models_fallback(401).is_none());
        assert!(anthropic_models_fallback(500).is_none());
        let fallback = anthropic_models_fallback(403).unwrap();
        assert!(anthropic_models_fallback(404).is_some());
        // Only current, valid API IDs (hyphenated, no retired Claude 3.x models).
        assert!(fallback.contains(&"claude-sonnet-4-6".to_string()));
        assert!(fallback.iter().all(|id| !id.contains('.') && !id.starts_with("claude-3")));
    }

    #[test]
    fn anthropic_dotted_display_model_ids_are_sent_hyphenated() {
        assert_eq!(normalize_anthropic_model("claude-sonnet-4.6"), "claude-sonnet-4-6");
        assert_eq!(normalize_anthropic_model(" claude-haiku-4.5 "), "claude-haiku-4-5");
        assert_eq!(normalize_anthropic_model("claude-opus-4-6"), "claude-opus-4-6");
    }

    #[test]
    fn ollama_cloud_missing_key_message_mentions_env_not_secret_value() {
        let message = ollama_missing_api_key_message();

        assert!(message.contains("OLLAMA_API_KEY"));
        assert!(message.contains("OLLAMA_REMOTE_API_KEY"));
        assert!(!message.contains("sk-"));
    }

    #[test]
    fn resolve_ollama_api_key_returns_provided_value_when_non_empty() {
        let key =
            resolve_ollama_api_key_for_endpoint("my-test-key", "https://ollama.com/api", false)
                .unwrap();
        assert_eq!(key, Some("my-test-key".to_string()));
    }

    #[test]
    fn resolve_ollama_api_key_returns_none_when_empty_and_not_required() {
        let key = resolve_ollama_api_key_for_endpoint("", "http://localhost:11434", false);
        assert!(key.is_ok(), "should not error when key not required");
        assert_eq!(key.unwrap(), None);
    }

    #[test]
    fn ollama_unavailable_message_differs_for_cloud_vs_local() {
        let cloud_msg = ollama_unavailable_message("https://ollama.com");
        let local_msg = ollama_unavailable_message("http://localhost:11434");

        assert!(cloud_msg.contains("Ollama Cloud"));
        assert!(local_msg.contains("local Ollama server"));
        assert!(!cloud_msg.contains("local"));
    }

    #[tokio::test]
    async fn call_ollama_api_sends_auth_to_remote_endpoint_and_parses_response() {
        let (base_url, request_rx) =
            spawn_mock_ollama_server(200, r#"{"message":{"content":"remote ok"}}"#);

        let text = call_ollama_api(
            "gemma4-31b:cloud".to_string(),
            "system".to_string(),
            "hello".to_string(),
            base_url,
            Some("test-remote-token".to_string()),
            128,
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let request_lower = request.to_lowercase();
        assert_eq!(text, "remote ok");
        assert!(request.starts_with("POST /api/chat "));
        assert!(request_lower.contains("authorization: bearer test-remote-token"));
        assert!(request.contains(r#""model":"gemma4:31b-cloud""#));
        assert!(!request.contains("gemma4-31b:cloud"));
    }

    #[tokio::test]
    async fn call_ollama_api_does_not_send_auth_to_local_endpoint_without_token() {
        let (base_url, request_rx) =
            spawn_mock_ollama_server(200, r#"{"message":{"content":"local ok"}}"#);

        let text = call_ollama_api(
            "qwen2.5-coder:7b".to_string(),
            "system".to_string(),
            "hello".to_string(),
            base_url,
            None,
            128,
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(text, "local ok");
        assert!(!request.to_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn network_errors_do_not_echo_credentials_embedded_in_the_endpoint_url() {
        // Some gateways take the key as a query parameter. reqwest's error text
        // includes the full request URL; port 9 (discard) refuses immediately.
        let error = call_openai_api(
            "local-model".to_string(),
            "system".to_string(),
            "hello".to_string(),
            String::new(),
            16,
            None,
            Some("http://127.0.0.1:9/v1?api-key=hunter2-secret".to_string()),
        )
        .await
        .unwrap_err();

        assert!(!error.contains("hunter2-secret"), "{error}");

        let health = check_provider_health(
            "openai-compatible".to_string(),
            String::new(),
            "http://127.0.0.1:9/v1?api-key=hunter2-secret".to_string(),
            "local-model".to_string(),
        )
        .await
        .unwrap();
        assert!(!health.message.contains("hunter2-secret"), "{}", health.message);
    }

    #[tokio::test]
    async fn call_ollama_api_reports_the_real_error_when_the_model_is_installed() {
        // An out-of-memory error mentions "model" but is not "model not installed".
        let (base_url, _request_rx) = spawn_mock_ollama_server(
            500,
            r#"{"error":"model requires more system memory (8.0 GiB) than is available (4.0 GiB)"}"#,
        );

        let error = call_ollama_api(
            "llama3.1:8b".to_string(),
            "system".to_string(),
            "hello".to_string(),
            base_url,
            None,
            128,
        )
        .await
        .unwrap_err();

        assert!(!error.contains("not installed"), "{error}");
        assert!(error.contains("more system memory"), "{error}");
    }

    #[tokio::test]
    async fn call_ollama_api_redacts_token_from_error_body() {
        let (base_url, _request_rx) = spawn_mock_ollama_server(
            500,
            r#"{"error":"upstream echoed test-remote-token by mistake"}"#,
        );

        let error = call_ollama_api(
            "gemma4:31b-cloud".to_string(),
            "system".to_string(),
            "hello".to_string(),
            base_url,
            Some("test-remote-token".to_string()),
            128,
        )
        .await
        .unwrap_err();

        assert!(error.contains("[redacted]"));
        assert!(!error.contains("test-remote-token"));
    }

    #[tokio::test]
    async fn ollama_cloud_health_sends_auth_and_accepts_model_alias() {
        let (base_url, request_rx) = spawn_mock_ollama_server(200, r#"{"models":[]}"#);

        let health = check_provider_health(
            "ollama-cloud".to_string(),
            "health-token".to_string(),
            base_url,
            "gemma4-31b:cloud".to_string(),
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(request.starts_with("GET /api/tags "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer health-token"));
        assert!(health.ok);
        assert!(health.model_available);
        assert_eq!(health.provider, "ollama-cloud");
        assert!(health.message.contains("gemma4:31b-cloud"));
        assert!(!health.message.contains("gemma4-31b:cloud"));
        assert!(health.pull_command.is_none());
    }

    #[tokio::test]
    async fn list_provider_models_sends_auth_to_remote_ollama_endpoint() {
        let (base_url, request_rx) = spawn_mock_ollama_server(
            200,
            r#"{"models":[{"name":"gemma4:31b-cloud"},{"name":"qwen2.5-coder:7b"}]}"#,
        );

        let models = list_provider_models(
            "ollama-cloud".to_string(),
            "models-token".to_string(),
            base_url,
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(request.starts_with("GET /api/tags "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer models-token"));
        assert_eq!(
            models,
            vec![
                "gemma4:31b-cloud".to_string(),
                "qwen2.5-coder:7b".to_string()
            ]
        );
    }

    // ── OpenAI-compatible custom endpoint (air-gapped local server) ────────────

    #[tokio::test]
    async fn call_openai_api_uses_custom_base_url_and_omits_auth_when_key_empty() {
        // Air-gapped case: a local OpenAI-compatible server that needs no auth.
        // The request must go to the custom base URL with NO Authorization header.
        let (base_url, request_rx) = spawn_mock_ollama_server(
            200,
            r#"{"choices":[{"message":{"content":"air-gapped ok"}}]}"#,
        );

        let text = call_openai_api(
            "local-model".to_string(),
            "system".to_string(),
            "hello".to_string(),
            String::new(), // no API key
            128,
            None,             // no reasoning effort
            Some(base_url),   // custom endpoint base URL
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(text, "air-gapped ok");
        assert!(request.starts_with("POST /chat/completions "));
        assert!(!request.to_lowercase().contains("authorization:"));
        assert!(request.contains(r#""model":"local-model""#));
    }

    async fn custom_endpoint_reply(body: &'static str) -> Result<String, String> {
        let (base_url, _request_rx) = spawn_mock_ollama_server(200, body);
        call_openai_api(
            "openai".to_string(),
            "system".to_string(),
            "hello".to_string(),
            String::new(),
            128,
            None,
            Some(base_url),
        )
        .await
    }

    fn tool_call_json(text: &str) -> serde_json::Value {
        let inner = text
            .strip_prefix("<tool_call>")
            .and_then(|t| t.strip_suffix("</tool_call>"))
            .unwrap_or_else(|| panic!("not a <tool_call> tag: {text}"));
        serde_json::from_str(inner).unwrap()
    }

    #[tokio::test]
    async fn native_tool_call_reply_is_rendered_as_a_run_loop_tool_call() {
        // Reply captured from a keyless OpenAI-compatible endpoint serving gpt-oss:
        // the server parses the model's tool intent into `tool_calls`, no `content`.
        let text = custom_endpoint_reply(
            r#"{"choices":[{"index":0,"message":{"role":"assistant","reasoning":"Use read_file tool.","tool_calls":[{"id":"chatcmpl-tool-1","type":"function","function":{"name":"read_file","arguments":"{\"path\": \".harness/inputs/requirements.yaml\"}"}}]},"finish_reason":"tool_calls"}]}"#,
        )
        .await
        .unwrap();

        assert_eq!(
            tool_call_json(&text),
            serde_json::json!({ "name": "read_file", "args": { "path": ".harness/inputs/requirements.yaml" } })
        );
    }

    #[tokio::test]
    async fn text_before_a_native_tool_call_is_kept() {
        let text = custom_endpoint_reply(
            r#"{"choices":[{"message":{"content":"Reading the file.","tool_calls":[{"function":{"name":"fs.read","arguments":"{\"path\":\"a.md\"}"}}]},"finish_reason":"tool_calls"}]}"#,
        )
        .await
        .unwrap();

        let (before, tag) = text.split_once('\n').unwrap();
        assert_eq!(before, "Reading the file.");
        assert_eq!(tool_call_json(tag)["name"], "fs.read");
    }

    #[tokio::test]
    async fn reply_without_text_says_so_instead_of_a_parse_error() {
        for body in [
            r#"{"choices":[{"message":{"content":null,"tool_calls":null},"finish_reason":"length"}]}"#,
            r#"{"choices":[{"message":{"content":""},"finish_reason":"length"}]}"#,
        ] {
            let error = custom_endpoint_reply(body).await.unwrap_err();
            assert!(error.contains("no text") && error.contains("length"), "{error}");
        }
    }

    #[tokio::test]
    async fn only_the_first_native_tool_call_is_rendered_and_bad_arguments_become_empty() {
        // The run loop runs one tool per step. Arguments that are not valid JSON
        // become {} so the tool reports what is missing and the model can retry.
        let text = custom_endpoint_reply(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"fs.write","arguments":"{path: a.md}"}},{"function":{"name":"read_file","arguments":"{\"path\":\"b.md\"}"}}]},"finish_reason":"tool_calls"}]}"#,
        )
        .await
        .unwrap();

        assert_eq!(
            tool_call_json(&text),
            serde_json::json!({ "name": "fs.write", "args": {} })
        );
    }

    #[tokio::test]
    async fn null_tool_calls_with_text_is_a_plain_reply() {
        let text = custom_endpoint_reply(r#"{"choices":[{"message":{"content":"hi","tool_calls":null}}]}"#)
            .await
            .unwrap();
        assert_eq!(text, "hi");
    }

    #[tokio::test]
    async fn openai_compatible_health_404_suggests_v1_prefix() {
        // Most common misconfiguration: base URL missing the /v1 prefix.
        // The health check must say so instead of dumping a bare 404 body.
        let (base_url, _request_rx) =
            spawn_mock_ollama_server(404, r#"{"detail":"Not Found"}"#);

        let health = check_provider_health(
            "openai-compatible".to_string(),
            String::new(),
            base_url,
            "local-model".to_string(),
        )
        .await
        .unwrap();

        assert!(!health.ok);
        assert!(health.message.contains("/v1"));
        assert!(health.message.contains("404"));
    }

    #[tokio::test]
    async fn call_openai_api_sends_bearer_to_custom_base_url_when_key_present() {
        // Air-gapped case with an authenticated local gateway: the provided key
        // must be sent as a Bearer token to the custom base URL.
        let (base_url, request_rx) = spawn_mock_ollama_server(
            200,
            r#"{"choices":[{"message":{"content":"authed ok"}}]}"#,
        );

        let text = call_openai_api(
            "local-model".to_string(),
            "system".to_string(),
            "hello".to_string(),
            "local-token".to_string(),
            128,
            None,
            Some(base_url),
        )
        .await
        .unwrap();

        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(text, "authed ok");
        assert!(request.starts_with("POST /chat/completions "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer local-token"));
    }
}
