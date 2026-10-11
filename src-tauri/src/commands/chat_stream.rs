//! Streaming model turns: read a provider's streamed reply, pass each piece of
//! text on as it arrives, and rebuild the reply the non-streaming API would have
//! returned, so the usual parsers (chat_turn.rs) read it.

use super::api_commands::TIMED_OUT_MESSAGE;
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

/// Rebuilds one provider's non-streaming response from its streamed lines.
pub(crate) trait StreamAccumulator: Default {
    /// One line of the stream; returns the text it adds (empty if none).
    fn line(&mut self, line: &str) -> Result<String, String>;
    /// The response the non-streaming API would have returned.
    fn response(self) -> Value;
    /// False while no line was a stream event: the server may have ignored
    /// `stream: true` and be sending one JSON body.
    fn saw_events(&self) -> bool;
}

fn event_error(error: &Value) -> String {
    error["message"].as_str().or(error.as_str()).map(str::to_string).unwrap_or_else(|| error.to_string())
}

/// The JSON of an SSE `data:` line; None for other lines (event names, comments, blanks).
fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim)
}

/// The highest `index` accepted for a tool call (OpenAI) or content block
/// (Anthropic). The server picks each index and the accumulators grow to fit
/// it, so `"index": 4000000000` would otherwise allocate until the app aborts.
const MAX_STREAM_INDEX: usize = 64;

/// Fails when a server-supplied `index` is over the limit. Call it before
/// growing anything to fit the index.
fn check_index(index: usize, what: &str) -> Result<(), String> {
    if index > MAX_STREAM_INDEX {
        return Err(format!("Unreadable stream event: {what} index {index} is over the limit of {MAX_STREAM_INDEX}"));
    }
    Ok(())
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
    events: bool,
}

impl StreamAccumulator for OpenAiStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        let Some(data) = sse_data(line) else { return Ok(String::new()) };
        if data.is_empty() || data == "[DONE]" {
            return Ok(String::new());
        }
        let event: Value = serde_json::from_str(data).map_err(|e| format!("Unreadable stream event: {e}"))?;
        self.events = true;
        if let Some(error) = event.get("error") {
            return Err(event_error(error));
        }
        let Some(choice) = event["choices"].get(0) else { return Ok(String::new()) };
        let delta = &choice["delta"];
        for call in delta["tool_calls"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let index = call["index"].as_u64().unwrap_or(0) as usize;
            check_index(index, "tool call")?;
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

    fn saw_events(&self) -> bool {
        self.events
    }
}

/// Anthropic Messages API.
#[derive(Default)]
pub(crate) struct AnthropicStream {
    /// Content blocks as the non-streaming API returns them.
    blocks: Vec<Value>,
    /// tool_use input JSON arriving in pieces, by block index.
    inputs: Vec<String>,
    stop_reason: String,
    /// The `usage` of the response the non-streaming API would have returned. `message_start` has the input
    /// counts (and the output so far), and each `message_delta` the output count, cumulative: the last
    /// one stands.
    usage: serde_json::Map<String, Value>,
    events: bool,
}

impl AnthropicStream {
    /// Takes the counts of a stream event's `usage` object, each replacing the earlier one of its name. Only
    /// whole numbers: a `null` (the API sends them for counts that do not apply) never replaces a count.
    fn add_usage(&mut self, usage: &Value) {
        for (name, count) in usage.as_object().into_iter().flatten() {
            if count.is_u64() {
                self.usage.insert(name.clone(), count.clone());
            }
        }
    }
}

impl StreamAccumulator for AnthropicStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        let Some(data) = sse_data(line).filter(|d| !d.is_empty()) else { return Ok(String::new()) };
        let event: Value = serde_json::from_str(data).map_err(|e| format!("Unreadable stream event: {e}"))?;
        self.events = true;
        let index = event["index"].as_u64().unwrap_or(0) as usize;
        match event["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                check_index(index, "content block")?;
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
            "message_start" => self.add_usage(&event["message"]["usage"]),
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = reason.to_string();
                }
                self.add_usage(&event["usage"]);
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
        let mut response = json!({"content": self.blocks, "stop_reason": self.stop_reason});
        if !self.usage.is_empty() {
            response["usage"] = Value::Object(self.usage);
        }
        response
    }

    fn saw_events(&self) -> bool {
        self.events
    }
}

/// Ollama /api/chat (one JSON object per line).
#[derive(Default)]
pub(crate) struct OllamaStream {
    text: String,
    tool_calls: Vec<Value>,
    done_reason: String,
    /// The counts of the reply, which its last line carries.
    prompt_eval_count: Option<u64>,
    eval_count: Option<u64>,
    events: bool,
}

impl StreamAccumulator for OllamaStream {
    fn line(&mut self, line: &str) -> Result<String, String> {
        if line.trim().is_empty() {
            return Ok(String::new());
        }
        let event: Value = serde_json::from_str(line).map_err(|e| format!("Unreadable stream event: {e}"))?;
        self.events = true;
        if let Some(error) = event.get("error") {
            return Err(event_error(error));
        }
        if let Some(calls) = event["message"]["tool_calls"].as_array() {
            self.tool_calls.extend(calls.iter().cloned());
        }
        if let Some(reason) = event["done_reason"].as_str() {
            self.done_reason = reason.to_string();
        }
        self.prompt_eval_count = event["prompt_eval_count"].as_u64().or(self.prompt_eval_count);
        self.eval_count = event["eval_count"].as_u64().or(self.eval_count);
        let text = event["message"]["content"].as_str().unwrap_or_default();
        self.text.push_str(text);
        Ok(text.to_string())
    }

    fn response(self) -> Value {
        let mut response =
            json!({"message": {"content": self.text, "tool_calls": self.tool_calls}, "done_reason": self.done_reason});
        if let Some(count) = self.prompt_eval_count {
            response["prompt_eval_count"] = json!(count);
        }
        if let Some(count) = self.eval_count {
            response["eval_count"] = json!(count);
        }
        response
    }

    fn saw_events(&self) -> bool {
        self.events
    }
}

/// Read a streamed reply to the end: each piece of text goes to `on_text`, and
/// the result is the response the non-streaming API would have returned. A
/// server that ignores `stream: true` sends that response as one JSON body.
pub(crate) async fn read_stream<S: StreamAccumulator>(
    mut response: reqwest::Response,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> Result<Value, String> {
    let mut lines = LineBuffer::default();
    let mut stream = S::default();
    let mut body = Vec::new();
    // Until a line is a stream event, an unreadable line may be part of a JSON body.
    let mut early_error = None;
    let mut take = |stream: &mut S, line: &str| -> Result<(), String> {
        match stream.line(line) {
            Ok(text) if !text.is_empty() => on_text(&text),
            Ok(_) => {}
            Err(e) if !stream.saw_events() => {
                early_error.get_or_insert(e);
            }
            Err(e) => return Err(e),
        }
        Ok(())
    };
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        // The request timeout covers the whole reply, so a slow model's stream can run out of it.
        if e.is_timeout() {
            TIMED_OUT_MESSAGE.to_string()
        } else {
            format!("The model's reply broke off: {}", e.without_url())
        }
    })? {
        body.extend_from_slice(&chunk);
        for line in lines.push(&chunk) {
            take(&mut stream, &line)?;
        }
    }
    if let Some(line) = lines.finish() {
        take(&mut stream, &line)?;
    }
    if !stream.saw_events() {
        if let Ok(whole) = serde_json::from_slice::<Value>(&body) {
            return Ok(whole);
        }
        if let Some(error) = early_error {
            return Err(error);
        }
    }
    Ok(stream.response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::api_commands::Usage;
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

    #[test]
    fn openai_stream_reports_an_error_event() {
        let error = feed::<OpenAiStream>("data: {\"error\":{\"message\":\"overloaded\"}}\n").unwrap_err();
        assert!(error.contains("overloaded"), "{error}");
    }

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

    /// One OpenAI stream event carrying a single tool-call delta at `index`.
    fn openai_call_event(index: u64) -> String {
        let call = json!({"index": index, "id": "call_1", "function": {"name": "read_file", "arguments": "{}"}});
        format!("data: {}", json!({"choices": [{"delta": {"tool_calls": [call]}}]}))
    }

    /// One Anthropic `content_block_start` event at `index`.
    fn anthropic_block_start(index: u64) -> String {
        let block = json!({"type": "text", "text": ""});
        format!("data: {}", json!({"type": "content_block_start", "index": index, "content_block": block}))
    }

    #[test]
    fn openai_stream_rejects_a_huge_tool_call_index_without_allocating() {
        let mut stream = OpenAiStream::default();
        let error = stream.line(&openai_call_event(4_000_000_000)).unwrap_err();
        assert!(error.contains("4000000000"), "{error}");
        assert!(stream.calls.is_empty());

        // The same event arriving through the chunked reader fails the read.
        let raw = format!("{}\n\n", openai_call_event(4_000_000_000));
        let error = feed::<OpenAiStream>(&raw).unwrap_err();
        assert!(error.contains("4000000000"), "{error}");
    }

    #[test]
    fn openai_stream_accepts_tool_call_index_64_and_rejects_65() {
        let mut stream = OpenAiStream::default();
        stream.line(&openai_call_event(64)).unwrap();
        assert_eq!(stream.calls.len(), 65);

        let error = stream.line(&openai_call_event(65)).unwrap_err();
        assert!(error.contains("65"), "{error}");
        assert_eq!(stream.calls.len(), 65);
    }

    #[test]
    fn anthropic_stream_rejects_a_huge_block_index_without_allocating() {
        let mut stream = AnthropicStream::default();
        let error = stream.line(&anthropic_block_start(4_000_000_000)).unwrap_err();
        assert!(error.contains("4000000000"), "{error}");
        assert!(stream.blocks.is_empty() && stream.inputs.is_empty());

        // The same event arriving through the chunked reader fails the read.
        let raw = format!("{}\n\n", anthropic_block_start(4_000_000_000));
        let error = feed::<AnthropicStream>(&raw).unwrap_err();
        assert!(error.contains("4000000000"), "{error}");
    }

    #[test]
    fn anthropic_stream_accepts_block_index_64_and_rejects_65() {
        let mut stream = AnthropicStream::default();
        stream.line(&anthropic_block_start(64)).unwrap();
        assert_eq!((stream.blocks.len(), stream.inputs.len()), (65, 65));

        let error = stream.line(&anthropic_block_start(65)).unwrap_err();
        assert!(error.contains("65"), "{error}");
        assert_eq!((stream.blocks.len(), stream.inputs.len()), (65, 65));
    }

    #[tokio::test]
    async fn a_stream_that_runs_out_of_the_request_timeout_says_so_and_has_shown_what_it_got() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        // A model that starts to answer, then takes longer than the client will wait.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let line = "{\"message\":{\"content\":\"Rea\"},\"done\":false}\n";
            let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n";
            stream.write_all(format!("{head}{:x}\r\n{line}\r\n", line.len()).as_bytes()).unwrap();
            std::thread::sleep(Duration::from_secs(3));
        });
        let client = reqwest::Client::builder().timeout(Duration::from_millis(400)).build().unwrap();
        let response = client.get(url).send().await.unwrap();
        let mut pieces = Vec::new();

        let error = read_stream::<OllamaStream>(response, &mut |text: &str| pieces.push(text.to_string()))
            .await
            .unwrap_err();

        assert_eq!(error, TIMED_OUT_MESSAGE);
        assert_eq!(pieces, ["Rea"]);
    }

    // ── Token usage ─────────────────────────────────────────────────────────────

    #[test]
    fn anthropic_stream_has_the_input_counts_of_message_start_and_the_output_count_of_message_delta() {
        let raw = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"content\":[],\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":20,\"cache_read_input_tokens\":30,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
            // The output count is cumulative; the counts that do not apply are null, and must not erase the input counts.
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":null,\"output_tokens\":15,\"server_tool_use\":{\"web_search_requests\":0}}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let (_pieces, response) = feed::<AnthropicStream>(raw).unwrap();

        // The response the non-streaming API would have returned: the usual parser reads it.
        assert_eq!(response["usage"]["input_tokens"], 100);
        assert_eq!(response["usage"]["output_tokens"], 15);
        let reply = parse_anthropic(&response).unwrap();
        assert_eq!(reply.text, "Hi");
        assert_eq!(reply.usage, Some(Usage { input: 150, output: 15 }));
    }

    #[test]
    fn anthropic_stream_that_never_says_what_it_used_has_no_usage() {
        let (_pieces, response) = feed::<AnthropicStream>(ANTHROPIC_STREAM).unwrap();
        assert!(response.get("usage").is_none(), "{response}");
        assert_eq!(parse_anthropic(&response).unwrap().usage, None);

        // Only the input counts came, with no message_delta after them: the output count is not known, so there is no usage.
        let raw = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100}}}\n\n";
        let (_pieces, response) = feed::<AnthropicStream>(raw).unwrap();
        let started = response["usage"].clone();
        assert_eq!(started, json!({"input_tokens": 100}));
        let with_text = json!({"content": [{"type": "text", "text": "x"}], "usage": started});
        assert_eq!(parse_anthropic(&with_text).unwrap().usage, None);
    }

    #[test]
    fn ollama_stream_has_the_counts_its_last_line_carries() {
        let raw = concat!(
            "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"Rea\"},\"done\":false}\n",
            "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"ding\"},\"done\":false}\n",
            "{\"model\":\"m\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\",\"total_duration\":5,\"prompt_eval_count\":26,\"eval_count\":298}\n",
        );
        let (_pieces, response) = feed::<OllamaStream>(raw).unwrap();

        assert_eq!(response["prompt_eval_count"], 26);
        assert_eq!(response["eval_count"], 298);
        let reply = parse_ollama(&response).unwrap();
        assert_eq!(reply.text, "Reading");
        assert_eq!(reply.usage, Some(Usage { input: 26, output: 298 }));
    }

    #[test]
    fn ollama_stream_without_counts_has_no_usage() {
        let (_pieces, response) = feed::<OllamaStream>(OLLAMA_STREAM).unwrap();
        assert!(response.get("prompt_eval_count").is_none() && response.get("eval_count").is_none(), "{response}");
        assert_eq!(parse_ollama(&response).unwrap().usage, None);
    }

    #[test]
    fn openai_stream_has_no_usage_because_its_request_does_not_ask_for_one() {
        let (_pieces, response) = feed::<OpenAiStream>(OPENAI_STREAM).unwrap();
        assert!(response.get("usage").is_none(), "{response}");
        assert_eq!(parse_openai(&response).unwrap().usage, None);
    }
}
