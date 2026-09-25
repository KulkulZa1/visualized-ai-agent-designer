# Coding Core, Part 3: Live Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In native tool-calling turns, the node's text streams into its output as the model writes it.

**Architecture:**
- **Rust:** `chat_turn` takes an optional JS channel id and uses the provider's streaming API. `chat_stream.rs` rebuilds, from the streamed events, the JSON the non-streaming API would have returned. The existing `parse_*` functions then read it, so the reply is identical by construction.
- **Command split:** the Tauri command becomes a thin wrapper around a plain `run_turn(…, on_text)`, so tests and the offline bridge need no Tauri.
- **TS:** `callChatTurn` creates a `Channel` when it gets an `onDelta` callback. The hook streams only the node's own turns, throttled to about 50 ms. It falls back to non-streaming, for the rest of the run, when a server cannot stream.

**Tech Stack:** Rust (reqwest `Response::chunk`, serde_json, tauri `ipc::JavaScriptChannelId`), TypeScript (`@tauri-apps/api/core` `Channel`), Vitest.

Spec: `docs/superpowers/specs/2026-09-25-coding-core-design.md` §3.

**Wire formats:**
- **OpenAI SSE:** `data: {json}` lines and `data: [DONE]`. Deltas are `choices[0].delta.content` and `.tool_calls[] {index, id, function {name, arguments}}` (argument fragments), with `finish_reason` on the last choice.
- **Anthropic SSE:** `data:` JSON events. `content_block_start` carries `{index, content_block}`; `content_block_delta` carries `{index, delta {type: text_delta | input_json_delta}}`; `message_delta` carries `{delta {stop_reason}}`; there is also `error`.
- **Ollama:** one JSON object per line, `{message {content, tool_calls}, done, done_reason}`.

## File map

| File | Change |
|---|---|
| `src-tauri/src/commands/api_commands.rs` | `send_openai` / `send_anthropic` / `send_ollama` return the successful response; `post_*` wrap them |
| `src-tauri/src/commands/chat_stream.rs` (new) | `LineBuffer`, the `StreamAccumulator` trait and three accumulators, `read_stream` |
| `src-tauri/src/commands/mod.rs` | `pub mod chat_stream;` |
| `src-tauri/src/commands/chat_turn.rs` | `ChatDelta`, `run_turn` (streaming or not), the command wrapper with `webview` + `on_delta` |
| `src/ipc/mockTauri.ts` | `Channel` class for tests |
| `src/services/model-providers/providerAdapter.ts` | `callChatTurn(params, invoke, onDelta?)`, `ChatDelta` |
| `src/hooks/useWorkflowExecution.ts` | streaming `callTurn` for the node, live output, `noStreaming`, no simulated typing when streamed |

---

### Task 1: `send_*` helpers (behavior-preserving refactor)

**Files:** Modify `src-tauri/src/commands/api_commands.rs`.

- [ ] **Step 1:** Rename `post_openai` to `send_openai`, change its return type to `Result<reqwest::Response, HttpFailure>` and its doc comment to "Send a Chat Completions request, retrying rate limits and temporary server errors (after 1 s, 2 s, 4 s). Returns the successful response with its body unread." In the success branch, replace the `return response.json()…;` statement with `return Ok(response);`. Then add:

```rust
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
```

- [ ] **Step 2:** Do the same for Anthropic: `send_anthropic` returns `Ok(response)`, and the wrapper is:

```rust
/// POST a Messages request (send_anthropic) and parse the JSON body.
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
```

- [ ] **Step 3:** And for Ollama. `send_ollama(client, base_url, api_key, body, model) -> Result<reqwest::Response, HttpFailure>` ends with `Ok(response)` after the `!status.is_success()` block. The wrapper:

```rust
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
```

- [ ] **Step 4: Run the existing tests (the refactor must keep them green)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS, 78 tests

---

### Task 2: `LineBuffer`

**Files:** Create `src-tauri/src/commands/chat_stream.rs`; modify `src-tauri/src/commands/mod.rs` (`pub mod chat_stream;`, alphabetically after `chat_turn`… or wherever modules are declared).

- [ ] **Step 1: Write the failing test.** New file with the test module first:

```rust
//! Streaming model turns: read a provider's streamed reply, pass each piece of
//! text on as it arrives, and rebuild the reply the non-streaming API would have
//! returned, so the usual parsers (chat_turn.rs) read it.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_buffer_joins_lines_split_across_chunks_even_inside_a_character() {
        let bytes = "data: 한글\nsecond\r\nlast".as_bytes();
        let mut buffer = LineBuffer::default();
        let mut lines = Vec::new();
        for chunk in bytes.chunks(3) {
            lines.extend(buffer.push(chunk));
        }
        lines.extend(buffer.finish());
        assert_eq!(lines, ["data: 한글", "second", "last"]);
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: FAIL to compile, `cannot find type LineBuffer`

- [ ] **Step 3: Implement.** Above the tests:

```rust
use serde_json::{json, Value};

/// Splits a byte stream into complete lines. A partial line waits for the rest,
/// so a character split across chunks is decoded whole.
#[derive(Default)]
pub(crate) struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            lines.push(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string());
        }
        lines
    }

    /// The last line, when the stream ends without a newline.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.pending);
        let line = String::from_utf8_lossy(&rest).trim().to_string();
        (!line.is_empty()).then_some(line)
    }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: PASS, 1 test

---

### Task 3: OpenAI stream

**Files:** Modify `src-tauri/src/commands/chat_stream.rs`, `src-tauri/src/commands/chat_turn.rs` (make `parse_openai`, `parse_anthropic`, `parse_ollama` and `ChatReply`/`ToolCall` reachable: `pub(crate) fn parse_…`).

- [ ] **Step 1: Write the failing test.** Add to the `tests` module:

```rust
    use crate::commands::chat_turn::{parse_anthropic, parse_ollama, parse_openai, ToolCall};

    /// Feeds `raw` in small chunks; returns the text pieces and the rebuilt response.
    fn feed<S: StreamAccumulator>(raw: &str) -> Result<(Vec<String>, Value), String> {
        let mut buffer = LineBuffer::default();
        let mut stream = S::default();
        let mut pieces = Vec::new();
        for chunk in raw.as_bytes().chunks(7) {
            for line in buffer.push(chunk) {
                let text = stream.line(&line)?;
                if !text.is_empty() {
                    pieces.push(text);
                }
            }
        }
        Ok((pieces, stream.response()))
    }

    const OPENAI_STREAM: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Let me \"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"check.\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"pa\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a.md\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    #[test]
    fn openai_stream_rebuilds_text_and_fragmented_tool_calls() {
        let (pieces, response) = feed::<OpenAiStream>(OPENAI_STREAM).unwrap();
        assert_eq!(pieces.concat(), "Let me check.");
        let reply = parse_openai(&response).unwrap();
        assert_eq!(reply.text, "Let me check.");
        assert_eq!(reply.tool_calls, vec![ToolCall {
            id: "call_1".into(), name: "read_file".into(), args: json!({"path": "a.md"}),
        }]);
        assert_eq!(reply.finish_reason, "tool_calls");
    }

    #[test]
    fn openai_stream_reports_an_error_event() {
        let error = feed::<OpenAiStream>("data: {\"error\":{\"message\":\"overloaded\"}}\n").unwrap_err();
        assert!(error.contains("overloaded"), "{error}");
    }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: FAIL to compile (`StreamAccumulator` and `OpenAiStream` are missing; the parsers are private)

- [ ] **Step 3: Implement.** In `chat_turn.rs`, make `parse_anthropic`, `parse_openai` and `parse_ollama` `pub(crate)`. In `chat_stream.rs`:

```rust
/// Rebuilds one provider's non-streaming response from its streamed lines.
pub(crate) trait StreamAccumulator: Default {
    /// One line of the stream; returns the text it adds (empty if none).
    fn line(&mut self, line: &str) -> Result<String, String>;
    /// The response the non-streaming API would have returned.
    fn response(self) -> Value;
}

fn event_error(error: &Value) -> String {
    error["message"].as_str().or(error.as_str()).map(str::to_string).unwrap_or_else(|| error.to_string())
}

/// The JSON of an SSE `data:` line; None for other lines (event names, comments, blanks).
fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim)
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

/// OpenAI Chat Completions (and compatible servers).
#[derive(Default)]
pub(crate) struct OpenAiStream {
    text: String,
    calls: Vec<PartialCall>,
    finish_reason: String,
}

impl StreamAccumulator for OpenAiStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        let Some(data) = sse_data(line) else { return Ok(String::new()) };
        if data.is_empty() || data == "[DONE]" {
            return Ok(String::new());
        }
        let event: Value = serde_json::from_str(data).map_err(|e| format!("Unreadable stream event: {e}"))?;
        if let Some(error) = event.get("error") {
            return Err(event_error(error));
        }
        let Some(choice) = event["choices"].get(0) else { return Ok(String::new()) };
        let delta = &choice["delta"];
        for call in delta["tool_calls"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let index = call["index"].as_u64().unwrap_or(0) as usize;
            while self.calls.len() <= index {
                self.calls.push(PartialCall::default());
            }
            let slot = &mut self.calls[index];
            if let Some(id) = call["id"].as_str().filter(|id| !id.is_empty()) {
                if slot.id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            // The name comes once (some servers repeat it); the arguments in pieces.
            if let Some(name) = call["function"]["name"].as_str() {
                if !slot.name.ends_with(name) {
                    slot.name.push_str(name);
                }
            }
            slot.arguments.push_str(call["function"]["arguments"].as_str().unwrap_or_default());
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = reason.to_string();
        }
        let text = delta["content"].as_str().unwrap_or_default();
        self.text.push_str(text);
        Ok(text.to_string())
    }

    fn response(self) -> Value {
        let mut message = json!({"role": "assistant", "content": self.text});
        if !self.calls.is_empty() {
            message["tool_calls"] = self
                .calls
                .into_iter()
                .map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}))
                .collect();
        }
        json!({"choices": [{"message": message, "finish_reason": self.finish_reason}]})
    }
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: PASS, 3 tests

---

### Task 4: Anthropic stream

**Files:** Modify `src-tauri/src/commands/chat_stream.rs`.

- [ ] **Step 1: Write the failing test**

```rust
    const ANTHROPIC_STREAM: &str = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"content\":[]}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Reading \"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"한글.md\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\": \\\"한\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"글.md\\\"}\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    #[test]
    fn anthropic_stream_rebuilds_text_and_tool_input() {
        let (pieces, response) = feed::<AnthropicStream>(ANTHROPIC_STREAM).unwrap();
        assert_eq!(pieces.concat(), "Reading 한글.md");
        let reply = parse_anthropic(&response).unwrap();
        assert_eq!(reply.text, "Reading 한글.md");
        assert_eq!(reply.tool_calls, vec![ToolCall {
            id: "toolu_1".into(), name: "read_file".into(), args: json!({"path": "한글.md"}),
        }]);
        assert_eq!(reply.finish_reason, "tool_use");
    }
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: FAIL to compile, `AnthropicStream` missing

- [ ] **Step 3: Implement**

```rust
/// Anthropic Messages API.
#[derive(Default)]
pub(crate) struct AnthropicStream {
    /// Content blocks as the non-streaming API returns them.
    blocks: Vec<Value>,
    /// tool_use input JSON arriving in pieces, by block index.
    inputs: Vec<String>,
    stop_reason: String,
}

impl StreamAccumulator for AnthropicStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        let Some(data) = sse_data(line).filter(|d| !d.is_empty()) else { return Ok(String::new()) };
        let event: Value = serde_json::from_str(data).map_err(|e| format!("Unreadable stream event: {e}"))?;
        let index = event["index"].as_u64().unwrap_or(0) as usize;
        match event["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                while self.blocks.len() <= index {
                    self.blocks.push(Value::Null);
                    self.inputs.push(String::new());
                }
                self.blocks[index] = event["content_block"].clone();
            }
            "content_block_delta" => {
                let delta = &event["delta"];
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        if let Some(block) = self.blocks.get_mut(index) {
                            let joined = format!("{}{text}", block["text"].as_str().unwrap_or_default());
                            block["text"] = json!(joined);
                        }
                        return Ok(text.to_string());
                    }
                    "input_json_delta" => {
                        if let Some(input) = self.inputs.get_mut(index) {
                            input.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = reason.to_string();
                }
            }
            "error" => return Err(event_error(&event["error"])),
            _ => {}
        }
        Ok(String::new())
    }

    fn response(mut self) -> Value {
        for (block, input) in self.blocks.iter_mut().zip(&self.inputs) {
            if block["type"] == "tool_use" && !input.is_empty() {
                block["input"] = serde_json::from_str(input).unwrap_or_else(|_| json!({}));
            }
        }
        json!({"content": self.blocks, "stop_reason": self.stop_reason})
    }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: PASS, 4 tests

---

### Task 5: Ollama stream and `read_stream`

**Files:** Modify `src-tauri/src/commands/chat_stream.rs`.

- [ ] **Step 1: Write the failing test**

```rust
    const OLLAMA_STREAM: &str = concat!(
        "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"Rea\"},\"done\":false}\n",
        "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"ding\"},\"done\":false}\n",
        "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.md\"}}}]},\"done\":false}\n",
        "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}\n",
    );

    #[test]
    fn ollama_stream_rebuilds_text_and_tool_calls() {
        let (pieces, response) = feed::<OllamaStream>(OLLAMA_STREAM).unwrap();
        assert_eq!(pieces, ["Rea", "ding"]);
        let reply = parse_ollama(&response).unwrap();
        assert_eq!(reply.text, "Reading");
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "read_file");
        assert_eq!(reply.tool_calls[0].args, json!({"path": "a.md"}));
        assert_eq!(reply.finish_reason, "stop");
    }
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: FAIL to compile, `OllamaStream` missing

- [ ] **Step 3: Implement**

```rust
/// Ollama /api/chat (one JSON object per line).
#[derive(Default)]
pub(crate) struct OllamaStream {
    text: String,
    tool_calls: Vec<Value>,
    done_reason: String,
}

impl StreamAccumulator for OllamaStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        if line.trim().is_empty() {
            return Ok(String::new());
        }
        let event: Value = serde_json::from_str(line).map_err(|e| format!("Unreadable stream event: {e}"))?;
        if let Some(error) = event.get("error") {
            return Err(event_error(error));
        }
        if let Some(calls) = event["message"]["tool_calls"].as_array() {
            self.tool_calls.extend(calls.iter().cloned());
        }
        if let Some(reason) = event["done_reason"].as_str() {
            self.done_reason = reason.to_string();
        }
        let text = event["message"]["content"].as_str().unwrap_or_default();
        self.text.push_str(text);
        Ok(text.to_string())
    }

    fn response(self) -> Value {
        json!({"message": {"content": self.text, "tool_calls": self.tool_calls}, "done_reason": self.done_reason})
    }
}

/// Read a streamed reply to the end: each piece of text goes to `on_text`, and
/// the result is the response the non-streaming API would have returned.
pub(crate) async fn read_stream<S: StreamAccumulator>(
    mut response: reqwest::Response,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<Value, String> {
    let mut lines = LineBuffer::default();
    let mut stream = S::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("The model's reply broke off: {}", e.without_url()))?
    {
        for line in lines.push(&chunk) {
            let text = stream.line(&line)?;
            if !text.is_empty() {
                on_text(&text);
            }
        }
    }
    if let Some(line) = lines.finish() {
        let text = stream.line(&line)?;
        if !text.is_empty() {
            on_text(&text);
        }
    }
    Ok(stream.response())
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_stream`
Expected: PASS, 5 tests

---

### Task 6: Streaming `chat_turn`

**Files:** Modify `src-tauri/src/commands/chat_turn.rs`.

- [ ] **Step 1: Write the failing tests.**
  - In the `tests` module, change `custom_turn` and `chat_turn_reports_an_ollama_model_without_tool_support` to call `run_turn(…, None)` instead of `chat_turn(…)`, adding the extra last argument.
  - Append:

```rust
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib chat_turn`
Expected: FAIL to compile, `run_turn` missing

- [ ] **Step 3: Implement.**

Imports: replace the `post_…` import with `send_anthropic, send_ollama, send_openai` next to the existing `post_anthropic, post_ollama, post_openai`. Add:

```rust
use super::chat_stream::{read_stream, AnthropicStream, OllamaStream, OpenAiStream, StreamAccumulator};
use tauri::ipc::{Channel, JavaScriptChannelId};
```

Add the delta type after `ChatReply`:

```rust
/// A piece of the model's text as it streams in.
#[derive(Debug, Clone, Serialize)]
pub struct ChatDelta {
    pub text: String,
}
```

Add a helper above `rejects_tools`:

```rust
/// The provider's reply as the non-streaming API returns it: read whole, or
/// streamed piece by piece to `on_text`.
async fn reply_value<S: StreamAccumulator>(
    sent: Result<reqwest::Response, HttpFailure>,
    on_text: Option<&mut (dyn FnMut(&str) + Send)>,
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
```

Replace the command with the wrapper plus `run_turn`:

```rust
/// One model turn. `provider` is "anthropic", "openai", "openai-compatible",
/// "ollama" or "ollama-cloud"; `base_url` is the custom or Ollama endpoint. With
/// `on_delta`, the reply streams and its text is sent to that channel as it arrives.
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
```

Remove the now-unused `post_anthropic, post_ollama, post_openai` from the `chat_turn.rs` import, if the compiler reports them unused.

- [ ] **Step 4: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (78 + 7 new: 5 `chat_stream` + 2 `run_turn`), no warnings

---

### Task 6b (added during execution): Servers that ignore `stream: true`

Some OpenAI-compatible servers answer a streaming request with one ordinary JSON body. With no `data:` lines the reply came out empty, and "no text" does not trigger the streaming fallback.

- [x] **Test:** `run_turn_reads_a_whole_reply_from_a_server_that_does_not_stream`. A pretty-printed JSON body gives the reply "Hi" and no deltas. It failed first.
- [x] **Fix:** `StreamAccumulator::saw_events()`. `read_stream` keeps the body, and holds back errors from lines seen before the first event. With no events, it parses the whole body as JSON, and errors only if that fails too. Error events count as events, so they still surface at once.

---

### Task 7: TS `Channel` support in `callChatTurn`

**Files:** Modify `src/ipc/mockTauri.ts`, `src/services/model-providers/providerAdapter.ts`. Test: `tests/unit/services/model-providers/chatTurnStream.test.ts` (new).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { callChatTurn } from "@/services/model-providers/providerAdapter";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

const params = {
  provider: "ollama" as const, model: "llama3", rawModel: "llama3", maxTokens: 256, apiKey: "",
  requiresKey: false, systemMsg: "sys", messages: [{ role: "user" as const, text: "hi" }], tools: [],
  ollamaBaseUrl: "http://localhost:11434", ollamaModel: "llama3", reasoningEffort: null,
};

describe("callChatTurn streaming", () => {
  it("passes a channel whose messages reach onDelta", async () => {
    const pieces: string[] = [];
    const invoke = vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
      const channel = args.onDelta as { onmessage: (d: { text: string }) => void };
      channel.onmessage({ text: "He" });
      channel.onmessage({ text: "llo" });
      return { text: "Hello", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    }) as unknown as InvokeFn;

    const reply = await callChatTurn(params, invoke, (text) => pieces.push(text));

    expect(pieces).toEqual(["He", "llo"]);
    expect(reply.text).toBe("Hello");
  });

  it("sends no channel without onDelta", async () => {
    const invoke = vi.fn(async () => ({ text: "x", toolCalls: [], finishReason: "stop", nativeToolsSupported: true })) as unknown as InvokeFn;
    await callChatTurn(params, invoke);
    expect((invoke as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }).mock.calls[0][1].onDelta).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/services/model-providers/chatTurnStream.test.ts`
Expected: FAIL. `onDelta` is not passed, so `channel.onmessage` is not a function.

- [ ] **Step 3: Implement.** In `mockTauri.ts`, append:

```ts
/** Stand-in for Tauri's Channel: a test's command handler calls `onmessage`. */
export class Channel<T> {
  onmessage: (message: T) => void = () => {};
}
```

In `providerAdapter.ts`, add the import `import { Channel } from "@tauri-apps/api/core";`, plus:

```ts
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
```

Change `callChatTurn`'s signature to `(params: ChatTurnParams, invokeFn: InvokeFn, onDelta?: (text: string) => void)` and its `turn` helper to:

```ts
  const channel = onDelta ? deltaChannel(onDelta) : null;
  const turn = (args: Record<string, unknown>) => invokeFn<ChatReply>("chat_turn", {
    system: systemMsg, messages, tools, maxTokens, reasoningEffort: null, baseUrl: null, onDelta: channel, ...args,
  });
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/services/model-providers/chatTurnStream.test.ts`
Expected: PASS, 2 tests

---

### Task 8: Live output in the run

**Files:** Modify `src/hooks/useWorkflowExecution.ts`. Test: `tests/unit/hooks/useWorkflowExecution.test.ts`.

- [ ] **Step 1: Write the failing tests.** Add to the top-level `describe`:

```ts
  it("shows a native turn's text as it streams in, then the final answer", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 2;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    const seen: string[] = [];
    mockInvokeHandler("chat_turn", async (args) => {
      const { onDelta } = args as { onDelta: { onmessage: (d: { text: string }) => void } | null };
      onDelta?.onmessage({ text: "Hel" });
      onDelta?.onmessage({ text: "lo" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      seen.push(useExecutionStore.getState().currentRun?.agents.A.output ?? "");
      return { text: "Hello", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });

    const finished = await run();

    expect(seen).toEqual(["Hello"]);
    expect(finished?.agents.A.output).toBe("Hello");
  });

  it("asks again without streaming when the server cannot stream, and stops streaming to it", async () => {
    const node = makeNode("A");
    node.data.tools = [ToolPermission.ReadFile];
    node.data.maxSteps = 3;
    useWorkflowStore.setState({ nodes: [node], edges: [] });
    mockInvokeHandler("read_workspace_file", () => "A");
    const streamed: boolean[] = [];
    let calls = 0;
    mockInvokeHandler("chat_turn", async (args) => {
      calls++;
      const streaming = Boolean((args as { onDelta: unknown }).onDelta);
      streamed.push(streaming);
      if (streaming) throw new Error("Streaming is not supported by this server");
      return calls < 3
        ? { text: "", finishReason: "tool_calls", nativeToolsSupported: true,
            toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.md" } }] }
        : { text: "done", toolCalls: [], finishReason: "stop", nativeToolsSupported: true };
    });

    const finished = await run();

    expect(finished?.agents.A).toMatchObject({ status: "done", output: "done" });
    expect(streamed).toEqual([true, false, false]);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts -t "stream"`
Expected: FAIL. `seen` is `[""]` or empty, and nothing is streamed or retried.

- [ ] **Step 3: Implement.** Next to `noNativeTools`:

```ts
    const noStreaming   = new Set<string>();         // "provider:model" that could not stream
```

In `processNode`, before the `// Shared by the node and the helpers it dispatches.` comment's `const shared`, keep `shared` as is. After `logToolCall`, add:

```ts
        // The node's own native turns stream into its output (throttled); helpers don't.
        let liveText = "";
        let streamed = false;
        let liveTimer: ReturnType<typeof setTimeout> | undefined;
        const showLiveText = (piece: string) => {
          liveText += piece;
          streamed = true;
          if (!liveTimer) {
            liveTimer = setTimeout(() => { liveTimer = undefined; updateAgent(nodeId, { output: liveText }); }, 50);
          }
        };
        const streamingCallTurn = async (system: string, messages: ChatMessage[], tools: ToolSpec[]) => {
          liveText = "";
          const params = { ...providerParams, systemMsg: system, messages, tools };
          if (noStreaming.has(nativeKey)) return callChatTurn(params, invoke);
          let received = false;
          try {
            return await callChatTurn(params, invoke, (piece) => { received = true; showLiveText(piece); });
          } catch (e) {
            // A server that cannot stream: ask again without streaming, and stop streaming to it this run.
            if (received || !/stream/i.test(String(e))) throw e;
            noStreaming.add(nativeKey);
            return callChatTurn(params, invoke);
          }
        };
```

In the node's `runAgentLoop({ ...shared, … })` call, add `callTurn: streamingCallTurn,` after `timeoutMessage`. Right after `const loop = await runAgentLoop(…);`, add `clearTimeout(liveTimer);`. Wrap the simulated streaming block:

```ts
        // Simulated streaming display, unless the text already streamed in live
        if (!(streamed && loop.mode === "native")) {
          const chunkSize = finalText.length > 2000 ? 120 : 60;
          let accumulated = "";
          for (let i = 0; i < finalText.length; i += chunkSize) {
            if (isRunCancelled()) break;
            await new Promise<void>((r) => setTimeout(r, finalText.length > 2000 ? 15 : 25));
            accumulated += finalText.slice(i, i + chunkSize);
            updateAgent(nodeId, { output: accumulated });
          }
        }
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts`
Expected: PASS (all hook tests)

---

### Task 9: Verify and commit Part 3

- [ ] **Step 1:** Run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run build`; all must pass.
- [ ] **Step 2:** Commit:

```bash
git add src tests src-tauri/src docs/superpowers/plans
git commit -m "Stream the model's text live in native tool-calling turns"
```
