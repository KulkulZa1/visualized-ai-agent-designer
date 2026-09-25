//! One model turn with native tool calling, for every provider.
//!
//! The agent loop (history, tool execution, falling back to the text
//! `<tool_call>` protocol) lives in `src/services/execution/agentLoop.ts`; this
//! module only translates the provider-neutral history to each wire format and
//! the reply back.

use super::api_commands::{
    generation_client, normalize_anthropic_model, normalize_ollama_model, ollama_requires_api_key,
    resolve_api_key, resolve_ollama_api_key_for_endpoint, send_anthropic, send_ollama, send_openai,
    HttpFailure, DEFAULT_OLLAMA_BASE_URL,
};
use super::chat_stream::{read_stream, AnthropicStream, OllamaStream, OpenAiStream, StreamAccumulator};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "app")]
use tauri::ipc::{Channel, JavaScriptChannelId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// `role` is "user" (text), "assistant" (text + tool calls) or "tool" (the
/// results for the previous assistant turn's calls).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub tool_results: Vec<ToolResult>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    pub parameters: Value,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: String,
    /// False when the model or server refused the tool definitions; the caller
    /// then uses the text protocol instead.
    pub native_tools_supported: bool,
}

impl ChatReply {
    fn tools_unsupported() -> Self {
        ChatReply {
            text: String::new(),
            tool_calls: Vec::new(),
            finish_reason: "tools_unsupported".to_string(),
            native_tools_supported: false,
        }
    }
}

/// A piece of the model's text as it streams in.
#[derive(Debug, Clone, Serialize)]
pub struct ChatDelta {
    pub text: String,
}

/// Tool arguments are a JSON object; anything else becomes {} so the tool
/// reports what is missing and the model can retry.
fn object_or_empty(args: &Value) -> Value {
    if args.is_object() {
        args.clone()
    } else {
        json!({})
    }
}

/// OpenAI sends arguments as a JSON string; Ollama (and some servers) as an object.
fn args_from_wire(raw: &Value) -> Value {
    match raw {
        Value::String(text) => object_or_empty(&serde_json::from_str(text).unwrap_or_default()),
        other => object_or_empty(other),
    }
}

/// Ids for servers that send none (Ollama); unique so results pair up in history.
fn generated_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("call_{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn openai_tools(tools: &[ToolSpec]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|t| {
                json!({"type": "function", "function": {
                    "name": t.name, "description": t.description, "parameters": t.parameters
                }})
            })
            .collect(),
    )
}

fn anthropic_body(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    max_tokens: u32,
) -> Value {
    let wire: Vec<Value> = messages
        .iter()
        .filter_map(|m| match m.role.as_str() {
            "assistant" => {
                let mut content = Vec::new();
                if !m.text.is_empty() {
                    content.push(json!({"type": "text", "text": m.text}));
                }
                content.extend(m.tool_calls.iter().map(|c| {
                    json!({"type": "tool_use", "id": c.id, "name": c.name, "input": object_or_empty(&c.args)})
                }));
                // The API rejects an assistant turn with no content.
                (!content.is_empty()).then(|| json!({"role": "assistant", "content": content}))
            }
            // Every result for the previous turn goes back in one user message.
            "tool" => Some(json!({"role": "user", "content": m.tool_results.iter().map(|r| {
                json!({"type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error})
            }).collect::<Vec<_>>()})),
            _ => Some(json!({"role": "user", "content": m.text})),
        })
        .collect();
    let mut body = json!({
        "model": normalize_anthropic_model(model),
        "max_tokens": max_tokens,
        "system": system,
        "messages": wire,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters}))
                .collect(),
        );
    }
    body
}

fn openai_body(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    custom_endpoint: bool,
) -> Value {
    let mut wire = vec![json!({"role": "system", "content": system})];
    for m in messages {
        match m.role.as_str() {
            "assistant" => {
                let content = if m.text.is_empty() { Value::Null } else { json!(m.text) };
                let mut msg = json!({"role": "assistant", "content": content});
                if !m.tool_calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        m.tool_calls
                            .iter()
                            .map(|c| {
                                json!({"id": c.id, "type": "function", "function": {
                                    "name": c.name, "arguments": object_or_empty(&c.args).to_string()
                                }})
                            })
                            .collect(),
                    );
                }
                wire.push(msg);
            }
            "tool" => wire.extend(m.tool_results.iter().map(|r| {
                json!({"role": "tool", "tool_call_id": r.id, "content": r.content})
            })),
            _ => wire.push(json!({"role": "user", "content": m.text})),
        }
    }
    let mut body = json!({"model": model, "messages": wire});
    // Same rule as `openai_chat_body`: reasoning models reject `max_tokens`.
    let max_tokens_field = if custom_endpoint { "max_tokens" } else { "max_completion_tokens" };
    body[max_tokens_field] = json!(max_tokens);
    if let Some(effort) = reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    }
    if !tools.is_empty() {
        body["tools"] = openai_tools(tools);
    }
    body
}

fn ollama_body(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    max_tokens: u32,
) -> Value {
    let mut wire = vec![json!({"role": "system", "content": system})];
    for m in messages {
        match m.role.as_str() {
            "assistant" => {
                let mut msg = json!({"role": "assistant", "content": m.text});
                if !m.tool_calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        m.tool_calls
                            .iter()
                            .map(|c| json!({"function": {"name": c.name, "arguments": object_or_empty(&c.args)}}))
                            .collect(),
                    );
                }
                wire.push(msg);
            }
            "tool" => wire.extend(m.tool_results.iter().map(|r| {
                json!({"role": "tool", "content": r.content, "tool_name": r.name})
            })),
            _ => wire.push(json!({"role": "user", "content": m.text})),
        }
    }
    let mut body = json!({
        "model": normalize_ollama_model(model),
        "messages": wire,
        "stream": false,
        "options": {"num_predict": max_tokens},
    });
    if !tools.is_empty() {
        body["tools"] = openai_tools(tools);
    }
    body
}

fn reply(text: String, tool_calls: Vec<ToolCall>, finish_reason: String) -> Result<ChatReply, String> {
    if text.trim().is_empty() && tool_calls.is_empty() {
        let reason = if finish_reason.is_empty() { "unknown" } else { &finish_reason };
        return Err(format!(
            "The model returned no text (finish_reason: {reason}). If it is \"length\", raise Max tokens."
        ));
    }
    Ok(ChatReply { text, tool_calls, finish_reason, native_tools_supported: true })
}

fn str_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

/// gpt-oss behind some servers leaks template tokens into the name
/// ("read_file<|channel|>commentary") or keeps its namespace ("functions.read_file").
fn clean_tool_name(raw: &Value) -> String {
    let raw = raw.as_str().unwrap_or_default();
    let name = raw.split("<|").next().unwrap_or(raw).trim();
    name.strip_prefix("functions.").unwrap_or(name).to_string()
}

pub(crate) fn parse_anthropic(value: &Value) -> Result<ChatReply, String> {
    let blocks = value["content"].as_array().map(Vec::as_slice).unwrap_or_default();
    let text = blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let tool_calls = blocks
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| ToolCall { id: str_of(&b["id"]), name: str_of(&b["name"]), args: object_or_empty(&b["input"]) })
        .collect();
    reply(text, tool_calls, str_of(&value["stop_reason"]))
}

pub(crate) fn parse_openai(value: &Value) -> Result<ChatReply, String> {
    let choice = value["choices"]
        .get(0)
        .ok_or_else(|| "No content in OpenAI response".to_string())?;
    let message = &choice["message"];
    let tool_calls = message["tool_calls"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|c| ToolCall {
            id: c["id"].as_str().filter(|id| !id.is_empty()).map(str::to_string).unwrap_or_else(generated_id),
            name: clean_tool_name(&c["function"]["name"]),
            args: args_from_wire(&c["function"]["arguments"]),
        })
        .collect();
    reply(str_of(&message["content"]), tool_calls, str_of(&choice["finish_reason"]))
}

pub(crate) fn parse_ollama(value: &Value) -> Result<ChatReply, String> {
    let message = &value["message"];
    let tool_calls = message["tool_calls"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|c| ToolCall {
            id: c["id"].as_str().filter(|id| !id.is_empty()).map(str::to_string).unwrap_or_else(generated_id),
            name: clean_tool_name(&c["function"]["name"]),
            args: args_from_wire(&c["function"]["arguments"]),
        })
        .collect();
    reply(str_of(&message["content"]), tool_calls, str_of(&value["done_reason"]))
}

/// The provider's reply as the non-streaming API returns it: read whole, or
/// streamed piece by piece to `on_text`.
async fn reply_value<S: StreamAccumulator>(
    sent: Result<reqwest::Response, HttpFailure>,
    on_text: Option<&mut (dyn FnMut(&str) + Send + 'static)>,
    what: &str,
) -> Result<Value, HttpFailure> {
    let response = sent?;
    let status = response.status().as_u16();
    match on_text {
        Some(on_text) => read_stream::<S>(response, on_text)
            .await
            .map_err(|message| HttpFailure { status: Some(status), message }),
        None => response.json().await.map_err(|e| HttpFailure {
            status: Some(status),
            message: format!("Failed to parse {what} response: {}", e.without_url()),
        }),
    }
}

/// A server that refuses the tool definitions (a model without tool support,
/// vLLM without --enable-auto-tool-choice, …) answers 400/422 naming tools.
fn rejects_tools(failure: &HttpFailure) -> bool {
    matches!(failure.status, Some(400 | 422)) && failure.message.to_lowercase().contains("tool")
}

/// One model turn. `provider` is "anthropic", "openai", "openai-compatible",
/// "ollama" or "ollama-cloud"; `base_url` is the custom or Ollama endpoint. With
/// `on_delta`, the reply streams and its text is sent to that channel as it arrives.
#[cfg(feature = "app")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_turn(
    webview: tauri::Webview,
    provider: String,
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSpec>,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
    base_url: Option<String>,
    on_delta: Option<JavaScriptChannelId>,
) -> Result<ChatReply, String> {
    let on_text = on_delta.map(|id| {
        let channel: Channel<ChatDelta> = id.channel_on(webview);
        Box::new(move |text: &str| {
            let _ = channel.send(ChatDelta { text: text.to_string() });
        }) as Box<dyn FnMut(&str) + Send>
    });
    run_turn(provider, model, system, messages, tools, api_key, max_tokens, reasoning_effort, base_url, on_text).await
}

/// chat_turn without Tauri: streams to `on_text` when given.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_turn(
    provider: String,
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSpec>,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
    base_url: Option<String>,
    mut on_text: Option<Box<dyn FnMut(&str) + Send>>,
) -> Result<ChatReply, String> {
    let client = generation_client()?;
    let custom_url = base_url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    let refused = |failure: &HttpFailure| !tools.is_empty() && rejects_tools(failure);
    let streaming = on_text.is_some();
    let on_text = on_text.as_deref_mut();

    match provider.as_str() {
        "anthropic" => {
            let key = resolve_api_key(&api_key, "ANTHROPIC_API_KEY")?;
            let mut body = anthropic_body(&model, &system, &messages, &tools, max_tokens);
            if streaming {
                body["stream"] = json!(true);
            }
            let sent = send_anthropic(&client, &key, &body).await;
            let value = reply_value::<AnthropicStream>(sent, on_text, "Anthropic").await.map_err(|f| f.message)?;
            parse_anthropic(&value)
        }
        "openai" | "openai-compatible" => {
            if provider == "openai-compatible" && custom_url.is_none() {
                return Err("Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint.".to_string());
            }
            let endpoint = custom_url
                .map(|u| format!("{}/chat/completions", u.trim_end_matches('/')))
                .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());
            // A custom endpoint may need no key: then no Authorization header is sent.
            let key = if custom_url.is_some() && api_key.trim().is_empty() {
                String::new()
            } else {
                resolve_api_key(&api_key, "OPENAI_API_KEY")?
            };
            let mut body = openai_body(
                &model,
                &system,
                &messages,
                &tools,
                max_tokens,
                reasoning_effort.as_deref(),
                custom_url.is_some(),
            );
            if streaming {
                body["stream"] = json!(true);
            }
            let sent = send_openai(&client, &endpoint, &key, &body).await;
            match reply_value::<OpenAiStream>(sent, on_text, "OpenAI").await {
                Ok(value) => parse_openai(&value),
                // The official API supports tools; only a custom server may refuse them.
                Err(failure) if custom_url.is_some() && refused(&failure) => Ok(ChatReply::tools_unsupported()),
                Err(failure) => Err(failure.message),
            }
        }
        "ollama" | "ollama-cloud" => {
            let base = custom_url.unwrap_or(DEFAULT_OLLAMA_BASE_URL);
            let key = resolve_ollama_api_key_for_endpoint(&api_key, base, ollama_requires_api_key(base))?;
            let model = normalize_ollama_model(&model);
            let mut body = ollama_body(&model, &system, &messages, &tools, max_tokens);
            body["stream"] = json!(streaming);
            let sent = send_ollama(&client, base, key.as_deref(), &body, &model).await;
            match reply_value::<OllamaStream>(sent, on_text, "Ollama").await {
                Ok(value) => parse_ollama(&value),
                Err(failure) if refused(&failure) => Ok(ChatReply::tools_unsupported()),
                Err(failure) => Err(failure.message),
            }
        }
        other => Err(format!("Unknown provider: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::api_commands::tests::spawn_mock_ollama_server;
    use serde_json::json;
    use std::time::Duration;

    fn read_file_spec() -> ToolSpec {
        ToolSpec {
            name: "read_file".into(),
            description: "Read a workspace file.".into(),
            parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        }
    }

    /// user → assistant (text + one call) → tool result, as the TS loop sends it.
    fn history() -> Vec<ChatMessage> {
        serde_json::from_value(json!([
            {"role": "user", "text": "Summarize a.md"},
            {"role": "assistant", "text": "Reading.", "toolCalls": [
                {"id": "call_1", "name": "read_file", "args": {"path": "a.md"}}
            ]},
            {"role": "tool", "toolResults": [
                {"id": "call_1", "name": "read_file", "content": "A", "isError": false}
            ]}
        ]))
        .unwrap()
    }

    #[test]
    fn anthropic_body_echoes_tool_use_and_returns_results_in_one_user_message() {
        let body = anthropic_body("claude-sonnet-4.6", "sys", &history(), &[read_file_spec()], 512);
        assert_eq!(body["model"], "claude-sonnet-4-6");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(
            body["messages"],
            json!([
                {"role": "user", "content": "Summarize a.md"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Reading."},
                    {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a.md"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "A", "is_error": false}
                ]}
            ])
        );
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert_eq!(body["tools"][0]["input_schema"]["required"], json!(["path"]));
    }

    #[test]
    fn openai_body_uses_tool_calls_and_tool_messages() {
        let body = openai_body("gpt-5.5", "sys", &history(), &[read_file_spec()], 512, None, false);
        assert_eq!(
            body["messages"],
            json!([
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "Summarize a.md"},
                {"role": "assistant", "content": "Reading.", "tool_calls": [
                    {"id": "call_1", "type": "function",
                     "function": {"name": "read_file", "arguments": "{\"path\":\"a.md\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "A"}
            ])
        );
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["parameters"]["required"], json!(["path"]));
        assert_eq!(body["max_completion_tokens"], 512);

        let custom = openai_body("m", "sys", &history(), &[], 512, None, true);
        assert_eq!(custom["max_tokens"], 512);
    }

    #[test]
    fn ollama_body_uses_object_arguments_and_tool_name() {
        let body = ollama_body("gemma4-31b:cloud", "sys", &history(), &[read_file_spec()], 512);
        assert_eq!(body["model"], "gemma4:31b-cloud");
        assert_eq!(body["stream"], false);
        assert_eq!(body["options"]["num_predict"], 512);
        assert_eq!(
            body["messages"],
            json!([
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "Summarize a.md"},
                {"role": "assistant", "content": "Reading.", "tool_calls": [
                    {"function": {"name": "read_file", "arguments": {"path": "a.md"}}}
                ]},
                {"role": "tool", "content": "A", "tool_name": "read_file"}
            ])
        );
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn bodies_omit_tools_when_none_are_offered() {
        let msgs = &history()[..1];
        assert!(anthropic_body("m", "s", msgs, &[], 1).get("tools").is_none());
        assert!(openai_body("m", "s", msgs, &[], 1, None, true).get("tools").is_none());
        assert!(ollama_body("m", "s", msgs, &[], 1).get("tools").is_none());
    }

    #[test]
    fn parses_anthropic_text_and_tool_use_blocks() {
        let reply = parse_anthropic(&json!({
            "content": [
                {"type": "text", "text": "Reading both."},
                {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "a.md"}},
                {"type": "tool_use", "id": "toolu_2", "name": "read_file", "input": {"path": "b.md"}}
            ],
            "stop_reason": "tool_use"
        }))
        .unwrap();
        assert_eq!(reply.text, "Reading both.");
        assert_eq!(reply.finish_reason, "tool_use");
        assert!(reply.native_tools_supported);
        assert_eq!(
            reply.tool_calls,
            vec![
                ToolCall { id: "toolu_1".into(), name: "read_file".into(), args: json!({"path": "a.md"}) },
                ToolCall { id: "toolu_2".into(), name: "read_file".into(), args: json!({"path": "b.md"}) },
            ]
        );
    }

    #[test]
    fn parses_openai_tool_calls_with_string_arguments() {
        let reply = parse_openai(&json!({"choices": [{
            "message": {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_a", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\": \"a.md\"}"}},
                {"type": "function", "function": {"name": "fs_write", "arguments": "{bad json"}}
            ]},
            "finish_reason": "tool_calls"
        }]}))
        .unwrap();
        assert_eq!(reply.text, "");
        assert_eq!(reply.finish_reason, "tool_calls");
        assert_eq!(reply.tool_calls[0], ToolCall { id: "call_a".into(), name: "read_file".into(), args: json!({"path": "a.md"}) });
        // A missing id is generated; arguments that are not a JSON object become {}.
        assert_eq!(reply.tool_calls[1].name, "fs_write");
        assert!(!reply.tool_calls[1].id.is_empty());
        assert_eq!(reply.tool_calls[1].args, json!({}));
    }

    #[test]
    fn strips_leaked_template_tokens_and_namespace_from_tool_names() {
        // Seen live from gpt-oss behind an OpenAI-compatible server.
        let reply = parse_openai(&json!({"choices": [{"message": {"tool_calls": [
            {"id": "a", "function": {"name": "read_file<|channel|>commentary", "arguments": "{}"}},
            {"id": "b", "function": {"name": "functions.fs_write", "arguments": "{}"}}
        ]}, "finish_reason": "tool_calls"}]}))
        .unwrap();
        let names: Vec<&str> = reply.tool_calls.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["read_file", "fs_write"]);

        let reply = parse_ollama(&json!({"message": {"content": "", "tool_calls": [
            {"function": {"name": "grep<|channel|>commentary", "arguments": {}}}
        ]}}))
        .unwrap();
        assert_eq!(reply.tool_calls[0].name, "grep");
    }

    #[test]
    fn parses_ollama_tool_calls_and_generates_ids() {
        let reply = parse_ollama(&json!({
            "message": {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "read_file", "arguments": {"path": "a.md"}}},
                {"function": {"name": "read_file", "arguments": {"path": "b.md"}}}
            ]},
            "done_reason": "stop"
        }))
        .unwrap();
        assert_eq!(reply.tool_calls.len(), 2);
        assert_eq!(reply.tool_calls[1].args, json!({"path": "b.md"}));
        assert_ne!(reply.tool_calls[0].id, reply.tool_calls[1].id);
    }

    #[test]
    fn a_reply_with_neither_text_nor_tool_calls_is_an_error() {
        let error = parse_openai(&json!({"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}))
            .unwrap_err();
        assert!(error.contains("no text") && error.contains("length"), "{error}");
        assert!(parse_anthropic(&json!({"content": [], "stop_reason": "max_tokens"})).is_err());
        assert!(parse_ollama(&json!({"message": {"content": " "}, "done_reason": "length"})).is_err());
    }

    async fn custom_turn(status: u16, body: &'static str, tools: Vec<ToolSpec>) -> (Result<ChatReply, String>, String) {
        let (base_url, request_rx) = spawn_mock_ollama_server(status, body);
        let reply = run_turn(
            "openai-compatible".into(),
            "openai".into(),
            "sys".into(),
            history()[..1].to_vec(),
            tools,
            String::new(),
            256,
            None,
            Some(base_url),
            None,
        )
        .await;
        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        (reply, request)
    }

    #[tokio::test]
    async fn chat_turn_sends_tools_to_a_custom_endpoint_and_returns_the_calls() {
        let (reply, request) = custom_turn(
            200,
            r#"{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.md\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            vec![read_file_spec()],
        )
        .await;
        let reply = reply.unwrap();
        assert!(request.starts_with("POST /chat/completions "));
        let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(sent["tools"][0]["function"]["name"], "read_file");
        assert_eq!(reply.tool_calls[0].args, json!({"path": "a.md"}));
        assert!(reply.native_tools_supported);
    }

    #[tokio::test]
    async fn chat_turn_reports_a_custom_endpoint_that_rejects_tools() {
        let (reply, _) = custom_turn(
            400,
            r#"{"error":{"message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}"#,
            vec![read_file_spec()],
        )
        .await;
        let reply = reply.unwrap();
        assert!(!reply.native_tools_supported);
        assert!(reply.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn chat_turn_keeps_errors_when_no_tools_were_sent() {
        let (reply, _) = custom_turn(400, r#"{"error":{"message":"bad tool_choice"}}"#, vec![]).await;
        assert!(reply.unwrap_err().contains("400"));
    }

    #[tokio::test]
    async fn chat_turn_reports_an_ollama_model_without_tool_support() {
        let (base_url, _rx) = spawn_mock_ollama_server(
            400,
            r#"{"error":"registry.ollama.ai/library/gemma3:latest does not support tools"}"#,
        );
        let reply = run_turn(
            "ollama".into(),
            "gemma3".into(),
            "sys".into(),
            history()[..1].to_vec(),
            vec![read_file_spec()],
            String::new(),
            256,
            None,
            Some(base_url),
            None,
        )
        .await
        .unwrap();
        assert!(!reply.native_tools_supported);
    }

    use std::sync::{Arc, Mutex};

    fn collector() -> (Arc<Mutex<Vec<String>>>, Box<dyn FnMut(&str) + Send>) {
        let pieces = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&pieces);
        (pieces, Box::new(move |text: &str| sink.lock().unwrap().push(text.to_string())))
    }

    #[tokio::test]
    async fn run_turn_streams_an_ollama_reply() {
        let (base_url, request_rx) = spawn_mock_ollama_server(200, concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"Rea\"},\"done\":false}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"ding\"},\"done\":true,\"done_reason\":\"stop\"}\n",
        ));
        let (pieces, on_text) = collector();
        let reply = run_turn(
            "ollama".into(), "llama3".into(), "sys".into(), history()[..1].to_vec(), vec![],
            String::new(), 256, None, Some(base_url), Some(on_text),
        )
        .await
        .unwrap();
        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();

        assert_eq!(sent["stream"], true);
        assert_eq!(*pieces.lock().unwrap(), ["Rea", "ding"]);
        assert_eq!(reply.text, "Reading");
    }

    #[tokio::test]
    async fn run_turn_reads_a_whole_reply_from_a_server_that_does_not_stream() {
        let (base_url, _rx) = spawn_mock_ollama_server(
            200,
            "{\n  \"choices\": [{\"message\": {\"role\": \"assistant\", \"content\": \"Hi\"}, \"finish_reason\": \"stop\"}]\n}",
        );
        let (pieces, on_text) = collector();
        let reply = run_turn(
            "openai-compatible".into(), "openai".into(), "sys".into(), history()[..1].to_vec(), vec![],
            String::new(), 256, None, Some(base_url), Some(on_text),
        )
        .await
        .unwrap();

        assert_eq!(reply.text, "Hi");
        assert!(pieces.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn run_turn_streams_a_custom_endpoint_reply_with_tool_calls() {
        let (base_url, request_rx) = spawn_mock_ollama_server(200, concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"On it.\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        ));
        let (pieces, on_text) = collector();
        let reply = run_turn(
            "openai-compatible".into(), "openai".into(), "sys".into(), history()[..1].to_vec(),
            vec![read_file_spec()], String::new(), 256, None, Some(base_url), Some(on_text),
        )
        .await
        .unwrap();
        let request = request_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let sent: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();

        assert_eq!(sent["stream"], true);
        assert_eq!(*pieces.lock().unwrap(), ["On it."]);
        assert_eq!(reply.tool_calls[0].args, json!({"path": "a.md"}));
    }
}
