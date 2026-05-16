use serde::{Deserialize, Serialize};
use std::env;
use std::time::{Duration, Instant};

const OPENAI_QUOTA_MESSAGE: &str =
    "OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.";
const OPENAI_RATE_LIMIT_MESSAGE: &str =
    "OpenAI API rate limit reached. The application will retry with exponential backoff.";
const ANTHROPIC_CREDIT_MESSAGE: &str =
    "Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5-coder:7b";

// ── Error classification ──────────────────────────────────────────────────────

enum ApiErrorKind {
    Billing,
    RateLimit,
    Other,
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
}

#[derive(Debug, Deserialize)]
struct OpenAIMessageOut {
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
    pub suggested_ollama_models: Vec<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &key[..4], &key[key.len() - 4..])
}

fn resolve_api_key(provided: &str, env_name: &str) -> Result<String, String> {
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

#[tauri::command]
pub async fn call_openai_api(
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let api_key = resolve_api_key(&api_key, "OPENAI_API_KEY")?;

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message}
        ],
        "max_tokens": max_tokens,
    });

    if let Some(ref effort) = reasoning_effort {
        body["reasoning"] = serde_json::json!({"effort": effort});
    }

    let delays = [1u64, 2, 4];
    let mut last_err = String::new();

    for attempt in 0..=3usize {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(delays[attempt - 1])).await;
        }

        let response = client
            .post("https://api.openai.com/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenAI network error: {e}"))?;

        let status = response.status().as_u16();

        if response.status().is_success() {
            let parsed: OpenAIResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse OpenAI response: {e}"))?;
            return parsed
                .choices
                .into_iter()
                .next()
                .map(|c| c.message.content)
                .ok_or_else(|| "No content in OpenAI response".to_string());
        }

        let text = response.text().await.unwrap_or_default();
        let normalized = normalize_provider_error("openai", status, &text);
        if normalized.billing_related {
            return Err(normalized.message);
        }
        if normalized.retryable {
            if attempt == 3 {
                return Err(format!(
                    "{} Retried 3 times without success.",
                    normalized.message
                ));
            }
            last_err = format!("OpenAI rate limit: retrying... (attempt {})", attempt + 1);
            eprintln!("{last_err}");
            continue;
        }
        return Err(normalized.message);
    }

    Err(last_err)
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
        model: model.to_string(),
        max_tokens,
        system: system.to_string(),
        messages: vec![ClaudeMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        }],
    };

    let delays = [1u64, 2, 4];
    let mut last_err = String::new();

    for attempt in 0..=3usize {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(delays[attempt - 1])).await;
        }

        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Anthropic network error: {e}"))?;

        let status = response.status().as_u16();

        if response.status().is_success() {
            let parsed: ClaudeResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Anthropic response: {e}"))?;
            return parsed
                .content
                .into_iter()
                .find(|b| b.kind == "text")
                .and_then(|b| b.text)
                .ok_or_else(|| "No text content in Anthropic response".to_string());
        }

        let text = response.text().await.unwrap_or_default();
        let normalized = normalize_provider_error("anthropic", status, &text);
        if normalized.billing_related {
            return Err(normalized.message);
        }
        if normalized.retryable {
            if attempt == 3 {
                return Err(format!(
                    "{} Retried 3 times without success.",
                    normalized.message
                ));
            }
            last_err = format!(
                "Anthropic rate limit: retrying... (attempt {})",
                attempt + 1
            );
            eprintln!("{last_err}");
            continue;
        }
        return Err(normalized.message);
    }

    Err(last_err)
}

#[tauri::command]
pub async fn call_anthropic_api(
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::new();
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
    let client = reqwest::Client::new();
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
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_message}
        ],
        "max_tokens": max_tokens,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| ollama_unavailable_message(&base_url))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if text.to_lowercase().contains("model") {
            return Err(format!(
                "Ollama model {model} is not installed. Run: ollama pull {model}"
            ));
        }
        return Err(format!("Ollama {status}: {text}"));
    }

    let parsed: OpenAIResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {e}"))?;

    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "No content in Ollama response".to_string())
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
    format!(
        "Ollama is selected, but the local Ollama server is not reachable at {base_url}. Please start Ollama and try again."
    )
}

fn ollama_has_model(tags: &OllamaTagsResponse, model: &str) -> bool {
    tags.models
        .iter()
        .any(|m| m.name == model || m.name.starts_with(&format!("{model}:")))
}

#[tauri::command]
pub fn get_provider_defaults() -> ProviderDefaults {
    let llm_provider = env::var("LLM_PROVIDER").unwrap_or_else(|_| "auto".to_string());
    let ollama_base_url =
        env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string());
    let ollama_model =
        env::var("OLLAMA_MODEL").unwrap_or_else(|_| DEFAULT_OLLAMA_MODEL.to_string());

    ProviderDefaults {
        llm_provider,
        ollama_base_url,
        ollama_model,
        openai_api_key_configured: resolve_api_key("", "OPENAI_API_KEY").is_ok(),
        anthropic_api_key_configured: resolve_api_key("", "ANTHROPIC_API_KEY").is_ok(),
        suggested_ollama_models: vec![
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
                model.trim().to_string()
            };
            let tags_url = format!("{}/api/tags", base_url.trim_end_matches('/'));
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

        other => Err(format!("Unknown provider: {other}")),
    }
}

// Suppress unused warning for mask_key — used in debug builds
#[allow(dead_code)]
fn _use_mask_key(key: &str) -> String {
    mask_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
