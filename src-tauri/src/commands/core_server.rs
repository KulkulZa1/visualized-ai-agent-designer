//! harness-core's server: the app's Rust commands without Tauri, over
//! stdin/stdout, for `harness run`.
//!
//! Each input line is a request `{"id":N,"cmd":"…","args":{…}}` whose arguments
//! are the camelCase ones the app passes to Tauri's `invoke`. Each output line is
//! `{"id":N,"ok":…}` or `{"id":N,"err":"…"}`, where `err` is the message the app
//! would get. Requests run concurrently and are answered as they finish, in any
//! order. At the end of the input the requests still running are answered, then
//! the server returns.

use std::collections::HashMap;
use std::future::Future;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::api_commands::{
    call_anthropic_api, call_claude_api, call_ollama_api, call_openai_api, check_provider_health,
    get_provider_defaults,
};
use super::audit_commands::write_audit_entry;
use super::chat_turn::{run_turn, ChatMessage, ToolSpec};
use super::fs_commands::{
    delete_workspace_file, list_workspace_files, read_workspace_file, write_workspace_file,
};
use super::process_commands::{cancel_command, execute_command, execute_hook};
use crate::models::audit::AuditEntry;

// ── Arguments, as the app sends them ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatTurnArgs {
    provider: String,
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSpec>,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
    base_url: Option<String>,
    // `onDelta`, the app's stream channel, is ignored: harness-core does not stream.
}

/// call_openai_api, call_anthropic_api and call_claude_api. The Anthropic ones
/// get no `reasoningEffort` or `baseUrl`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextCallArgs {
    model: String,
    system: String,
    user_message: String,
    api_key: String,
    max_tokens: u32,
    reasoning_effort: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OllamaArgs {
    model: String,
    system: String,
    user_message: String,
    base_url: String,
    api_key: Option<String>,
    max_tokens: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthArgs {
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArgs {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileArgs {
    workspace_path: String,
    relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteArgs {
    workspace_path: String,
    relative_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditArgs {
    workspace_path: String,
    entry: AuditEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookArgs {
    workspace_path: String,
    hook_path: String,
    agent_id: String,
    env: Option<HashMap<String, String>>,
    consent_granted: bool,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    workspace_path: String,
    command: String,
    consent_granted: bool,
    timeout_secs: u64,
    command_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelArgs {
    command_id: String,
}

/// A request's command, with its arguments checked.
#[derive(Debug)]
enum Call {
    ChatTurn(ChatTurnArgs),
    OpenAi(TextCallArgs),
    Anthropic(TextCallArgs),
    Claude(TextCallArgs),
    Ollama(OllamaArgs),
    Health(HealthArgs),
    Defaults,
    Read(FileArgs),
    Write(WriteArgs),
    Delete(FileArgs),
    List(WorkspaceArgs),
    Audit(AuditArgs),
    Hook(HookArgs),
    Command(CommandArgs),
    Cancel(CancelArgs),
}

fn args_of<T: DeserializeOwned>(cmd: &str, args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("Invalid arguments for {cmd}: {e}"))
}

/// The commands a workflow run uses. The app's others (dialogs, saving
/// workflows, listing models) are not served.
fn parse(cmd: &str, args: Value) -> Result<Call, String> {
    Ok(match cmd {
        "chat_turn" => Call::ChatTurn(args_of(cmd, args)?),
        "call_openai_api" => Call::OpenAi(args_of(cmd, args)?),
        "call_anthropic_api" => Call::Anthropic(args_of(cmd, args)?),
        "call_claude_api" => Call::Claude(args_of(cmd, args)?),
        "call_ollama_api" => Call::Ollama(args_of(cmd, args)?),
        "check_provider_health" => Call::Health(args_of(cmd, args)?),
        "get_provider_defaults" => Call::Defaults,
        "read_workspace_file" => Call::Read(args_of(cmd, args)?),
        "write_workspace_file" => Call::Write(args_of(cmd, args)?),
        "delete_workspace_file" => Call::Delete(args_of(cmd, args)?),
        "list_workspace_files" => Call::List(args_of(cmd, args)?),
        "write_audit_entry" => Call::Audit(args_of(cmd, args)?),
        "execute_hook" => Call::Hook(args_of(cmd, args)?),
        "execute_command" => Call::Command(args_of(cmd, args)?),
        "cancel_command" => Call::Cancel(args_of(cmd, args)?),
        _ => return Err(format!("Unknown command: {cmd}")),
    })
}

/// A command's result as the reply value, or its error message as the app gets it.
fn reply<T: Serialize, E: ToString>(result: Result<T, E>) -> Result<Value, String> {
    serde_json::to_value(result.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Runs a command that blocks (files, processes) off the async worker threads.
async fn blocking<T, E>(work: impl FnOnce() -> Result<T, E> + Send + 'static) -> Result<Value, String>
where
    T: Serialize + Send + 'static,
    E: ToString + Send + 'static,
{
    reply(tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?)
}

/// Runs one request with the same command functions the app's `invoke` calls.
pub async fn dispatch(cmd: String, args: Value) -> Result<Value, String> {
    match parse(&cmd, args)? {
        Call::ChatTurn(a) => reply(
            run_turn(
                a.provider, a.model, a.system, a.messages, a.tools, a.api_key, a.max_tokens,
                a.reasoning_effort, a.base_url, None,
            )
            .await,
        ),
        Call::OpenAi(a) => reply(
            call_openai_api(
                a.model, a.system, a.user_message, a.api_key, a.max_tokens, a.reasoning_effort, a.base_url,
            )
            .await,
        ),
        Call::Anthropic(a) => {
            reply(call_anthropic_api(a.model, a.system, a.user_message, a.api_key, a.max_tokens).await)
        }
        Call::Claude(a) => {
            reply(call_claude_api(a.model, a.system, a.user_message, a.api_key, a.max_tokens).await)
        }
        Call::Ollama(a) => reply(
            call_ollama_api(a.model, a.system, a.user_message, a.base_url, a.api_key, a.max_tokens).await,
        ),
        Call::Health(a) => reply(check_provider_health(a.provider, a.api_key, a.base_url, a.model).await),
        Call::Defaults => reply(Ok::<_, String>(get_provider_defaults())),
        Call::Read(a) => blocking(move || read_workspace_file(a.workspace_path, a.relative_path)).await,
        Call::Write(a) => {
            blocking(move || write_workspace_file(a.workspace_path, a.relative_path, a.content)).await
        }
        Call::Delete(a) => blocking(move || delete_workspace_file(a.workspace_path, a.relative_path)).await,
        Call::List(a) => blocking(move || list_workspace_files(a.workspace_path)).await,
        Call::Audit(a) => blocking(move || write_audit_entry(a.workspace_path, a.entry)).await,
        Call::Hook(a) => {
            blocking(move || {
                execute_hook(a.workspace_path, a.hook_path, a.agent_id, a.env, a.consent_granted, a.timeout_secs)
            })
            .await
        }
        Call::Command(a) => {
            blocking(move || {
                execute_command(a.workspace_path, a.command, a.consent_granted, a.timeout_secs, a.command_id)
            })
            .await
        }
        Call::Cancel(a) => blocking(move || Ok::<_, String>(cancel_command(a.command_id))).await,
    }
}

// ── The server ────────────────────────────────────────────────────────────────

/// A request line's id, command and arguments; or its id (null if unreadable)
/// and what is wrong with it.
fn request(line: &str) -> Result<(Value, String, Value), (Value, String)> {
    let value: Value =
        serde_json::from_str(line).map_err(|e| (Value::Null, format!("Bad request: {e}")))?;
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let Some(cmd) = value.get("cmd").and_then(Value::as_str) else {
        return Err((id, "Bad request: no \"cmd\"".to_string()));
    };
    let args = value.get("args").cloned().unwrap_or_else(|| json!({}));
    Ok((id, cmd.to_string(), args))
}

fn response(id: Value, result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "id": id, "ok": value }),
        Err(message) => json!({ "id": id, "err": message }),
    }
}

/// Starts one request; its reply goes to `replies` when it finishes.
fn start<D, F>(line: &str, replies: &mpsc::UnboundedSender<Value>, dispatch: &D)
where
    D: Fn(String, Value) -> F,
    F: Future<Output = Result<Value, String>> + Send + 'static,
{
    let replies = replies.clone();
    match request(line) {
        Ok((id, cmd, args)) => {
            let work = dispatch(cmd, args);
            tokio::spawn(async move {
                let _ = replies.send(response(id, work.await));
            });
        }
        Err((id, message)) => {
            let _ = replies.send(response(id, Err(message)));
        }
    }
}

async fn write_line<W: AsyncWrite + Unpin>(output: &mut W, reply: &Value) -> std::io::Result<()> {
    let mut line = reply.to_string();
    line.push('\n');
    output.write_all(line.as_bytes()).await?;
    output.flush().await
}

/// Serves the requests read from `input`, writing each reply to `output` as its
/// command finishes. Returns once the input has ended and every request is
/// answered, or when `output` fails.
pub async fn serve<R, W, D, F>(input: R, mut output: W, dispatch: D)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    D: Fn(String, Value) -> F,
    F: Future<Output = Result<Value, String>> + Send + 'static,
{
    let mut lines = BufReader::new(input).lines();
    let (sender, mut replies) = mpsc::unbounded_channel::<Value>();
    // Dropped at the end of the input; `replies` then ends after the last running request.
    let mut sender = Some(sender);
    loop {
        tokio::select! {
            line = lines.next_line(), if sender.is_some() => match line {
                Ok(Some(line)) => {
                    if let (false, Some(tx)) = (line.trim().is_empty(), &sender) {
                        start(&line, tx, &dispatch);
                    }
                }
                _ => sender = None,
            },
            reply = replies.recv() => match reply {
                Some(reply) => {
                    if write_line(&mut output, &reply).await.is_err() {
                        return; // nobody reads the replies any more
                    }
                }
                None => return,
            },
        }
    }
}

/// harness-core's main loop: requests on stdin, replies on stdout.
pub async fn serve_stdio() {
    serve(tokio::io::stdin(), tokio::io::stdout(), dispatch).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::api_commands::tests::spawn_mock_ollama_server;
    use std::time::Duration;

    #[test]
    fn accepts_the_arguments_the_app_sends() {
        // As providerAdapter.ts, toolExecutor.ts, commandTool.ts and the engine build them.
        let cases = [
            ("chat_turn", json!({
                "system": "You are A.",
                "messages": [
                    {"role": "user", "text": "Read a.md"},
                    {"role": "assistant", "text": "", "toolCalls": [{"id": "c1", "name": "read_file", "args": {"path": "a.md"}}]},
                    {"role": "tool", "toolResults": [{"id": "c1", "name": "read_file", "content": "A", "isError": false}]}
                ],
                "tools": [{"name": "read_file", "description": "Read a file.", "parameters": {"type": "object"}}],
                "maxTokens": 1024, "reasoningEffort": null, "baseUrl": "http://localhost:11434", "onDelta": null,
                "provider": "ollama", "model": "qwen2.5-coder:7b", "apiKey": ""
            })),
            ("call_openai_api", json!({"model": "gpt-4o-mini", "system": "s", "userMessage": "u", "apiKey": "",
                "maxTokens": 1024, "baseUrl": "https://llm.example/v1", "reasoningEffort": null})),
            ("call_claude_api", json!({"model": "claude-sonnet-4-5", "system": "s", "userMessage": "u",
                "apiKey": "", "maxTokens": 1024})),
            ("call_anthropic_api", json!({"model": "claude-sonnet-4-5", "system": "s", "userMessage": "u",
                "apiKey": "", "maxTokens": 1024})),
            ("call_ollama_api", json!({"model": "qwen2.5-coder:7b", "system": "s", "userMessage": "u",
                "baseUrl": "http://localhost:11434", "apiKey": "", "maxTokens": 1024})),
            ("check_provider_health", json!({"provider": "ollama", "apiKey": "",
                "baseUrl": "http://localhost:11434", "model": "qwen2.5-coder:7b"})),
            ("get_provider_defaults", json!({})),
            ("read_workspace_file", json!({"workspacePath": "/ws", "relativePath": "a.md"})),
            ("write_workspace_file", json!({"workspacePath": "/ws", "relativePath": "a.md", "content": "x"})),
            ("delete_workspace_file", json!({"workspacePath": "/ws", "relativePath": "a.md"})),
            ("list_workspace_files", json!({"workspacePath": "/ws"})),
            ("write_audit_entry", json!({"workspacePath": "/ws", "entry": {"id": "A-cmd-1",
                "timestamp": "2026-09-25T10:00:00.000Z", "action": "command_executed", "agentId": "A",
                "details": "A ran: npm test", "success": true}})),
            ("execute_hook", json!({"workspacePath": "/ws", "hookPath": ".harness/hooks/gate.sh",
                "agentId": "Gate", "env": {}, "consentGranted": true, "timeoutSecs": 120})),
            ("execute_command", json!({"workspacePath": "/ws", "command": "npm test", "consentGranted": true,
                "commandId": "run-1-cmd-1", "timeoutSecs": 300})),
            ("cancel_command", json!({"commandId": "run-1-cmd-1"})),
        ];
        for (cmd, args) in cases {
            if let Err(e) = parse(cmd, args) {
                panic!("{cmd}: {e}");
            }
        }
    }

    #[test]
    fn names_a_missing_argument() {
        let err = parse("read_workspace_file", json!({"workspacePath": "/ws"})).unwrap_err();
        assert!(err.contains("relativePath"), "{err}");
    }

    #[tokio::test]
    async fn serves_only_the_commands_a_run_uses() {
        assert_eq!(
            dispatch("open_workspace_dialog".into(), json!({})).await,
            Err("Unknown command: open_workspace_dialog".to_string())
        );
    }

    #[tokio::test]
    async fn runs_file_commands_in_the_workspace() {
        let ws = tempfile::tempdir().unwrap();
        let path = ws.path().to_string_lossy().to_string();
        let write = json!({"workspacePath": path, "relativePath": "notes/a.txt", "content": "hello"});
        assert_eq!(dispatch("write_workspace_file".into(), write).await, Ok(Value::Null));
        let read = json!({"workspacePath": path, "relativePath": "notes/a.txt"});
        assert_eq!(dispatch("read_workspace_file".into(), read).await, Ok(json!("hello")));
    }

    #[tokio::test]
    async fn returns_errors_as_the_app_gets_them() {
        let ws = tempfile::tempdir().unwrap();
        let path = ws.path().to_string_lossy().to_string();
        let missing = dispatch("read_workspace_file".into(),
            json!({"workspacePath": path, "relativePath": "nope.txt"})).await;
        assert!(missing.as_ref().is_err_and(|e| e.starts_with("IO error:")), "{missing:?}");
        let outside = dispatch("read_workspace_file".into(),
            json!({"workspacePath": path, "relativePath": "../outside.txt"})).await;
        assert!(outside.as_ref().is_err_and(|e| e.starts_with("Path traversal detected")), "{outside:?}");
    }

    #[tokio::test]
    async fn still_requires_consent_to_run_a_command() {
        let ws = tempfile::tempdir().unwrap();
        let args = json!({"workspacePath": ws.path().to_string_lossy(), "command": "echo hi",
            "consentGranted": false, "timeoutSecs": 5});
        assert_eq!(
            dispatch("execute_command".into(), args).await,
            Err("Running a command requires the user's approval.".to_string())
        );
    }

    #[tokio::test]
    async fn runs_a_model_turn_with_the_app_arguments() {
        let (base_url, _request) = spawn_mock_ollama_server(
            200,
            r#"{"message":{"role":"assistant","content":"hi"},"done":true,"done_reason":"stop"}"#,
        );
        let args = json!({
            "system": "You are A.", "messages": [{"role": "user", "text": "Say hi"}], "tools": [],
            "maxTokens": 64, "reasoningEffort": null, "baseUrl": base_url, "onDelta": null,
            "provider": "ollama", "model": "qwen2.5-coder:7b", "apiKey": ""
        });
        let reply = dispatch("chat_turn".into(), args).await.unwrap();
        assert_eq!(reply["text"], "hi");
        assert_eq!(reply["finishReason"], "stop");
    }

    fn replies(output: Vec<u8>) -> Vec<Value> {
        String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[tokio::test]
    async fn answers_requests_by_id_as_they_finish_and_waits_for_them_at_end_of_input() {
        let input = "{\"id\":1,\"cmd\":\"slow\"}\n{\"id\":2,\"cmd\":\"fast\"}\n";
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output, |cmd, _args| async move {
            if cmd == "slow" {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Ok(json!(cmd))
        })
        .await;
        assert_eq!(replies(output), vec![json!({"id": 2, "ok": "fast"}), json!({"id": 1, "ok": "slow"})]);
    }

    #[tokio::test]
    async fn answers_a_bad_request_with_an_error_and_keeps_serving() {
        let input = "not json\n\n{\"id\":7,\"cmd\":\"fast\"}\n{\"id\":8}\n";
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output, |cmd, _args| async move { Ok(json!(cmd)) }).await;
        let replies = replies(output);
        assert_eq!(replies.len(), 3, "{replies:?}");
        assert!(replies[0]["id"].is_null());
        assert!(replies[0]["err"].as_str().unwrap().starts_with("Bad request"));
        let by_id = |id: i64| replies.iter().find(|r| r["id"] == id).cloned();
        assert_eq!(by_id(7), Some(json!({"id": 7, "ok": "fast"})));
        assert_eq!(by_id(8), Some(json!({"id": 8, "err": "Bad request: no \"cmd\""})));
    }
}
