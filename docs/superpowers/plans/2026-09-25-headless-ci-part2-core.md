# Headless + CI, Part 2: `harness-core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the app's Rust commands without Tauri as a `harness-core` binary that serves them as JSON lines over stdin/stdout, for `harness run` (Part 3).

**Architecture:**
- Tauri and its plugins become optional dependencies of a default `app` feature, so the crate also builds without them. A marker `core` feature builds the helper binary.
- `commands/core_server.rs` does three things:
  - it parses each request's camelCase arguments (the ones the app sends through `invoke`) into typed structs;
  - it calls the same command functions the app calls;
  - it serves requests concurrently, matching replies by id.
- `src/bin/harness-core.rs` is a three-line `main`.

**Tech Stack:** Rust 1.95, Cargo features, tokio (`full`), serde_json, tempfile (dev).

**Spec:** `docs/superpowers/specs/2026-09-25-headless-ci-design.md` §2.

---

## Design decisions (read before starting)

1. **`core_server.rs` is compiled in both builds.** It uses no Tauri, so `cargo test` with the default features runs its tests too. The `core` feature enables nothing; it exists so that `required-features = ["core"]` keeps `tauri build` from building `harness-core`.
2. **The desktop binary needs an explicit `[[bin]]` with `required-features = ["app"]`.** Otherwise `cargo check --no-default-features --features core` tries to compile `main.rs`, which calls the Tauri-only `run()`.
   - Its name stays `agent-workflow-builder`, the package name that the Tauri CLI already expects.
   - `default-run` names it, so `cargo run` still has one default.
3. **Parsing is separate from running** (`parse` → `Call` → `dispatch`). Tests can check every command's argument shape without calling a provider or starting a process.
   - The shapes are copied from what `providerAdapter.ts`, `toolExecutor.ts`, `commandTool.ts` and the engine send.
   - `chat_turn` ignores `onDelta`, so `onDelta: null` is accepted.
4. **Errors are the app's error messages:** `AppError::to_string()`, which is what its `Serialize` sends to the webview, or the command's `String` error. Arguments that don't parse get `Invalid arguments for <cmd>: <serde message>`, and serde names the camelCase key.
5. **Blocking commands** (files, audit, hooks, commands, cancel) run on `spawn_blocking`, and async ones (model calls, health) on the runtime. `get_provider_defaults` only reads the environment, so it runs inline.
6. **The server loop is one `select!`** over "read the next line" and "write the next reply". Replies go out as each request finishes. At end of input, reading stops. Replies keep flowing until every running request's sender is dropped, and then `serve` returns.
   - The loop takes the dispatcher as a parameter, so a test can use a fake slow/fast dispatcher.
7. **Dead code in the core build.** The core build leaves the app-only commands unused: model listing, workflow save and load, the stream-delta type. `lib.rs` allows dead code only when `app` is off, with a comment.
8. **Served commands:** exactly the ones a run uses:
   - `chat_turn`, `call_openai_api`, `call_anthropic_api`, `call_claude_api`, `call_ollama_api`;
   - `check_provider_health`, `get_provider_defaults`;
   - `read_workspace_file`, `write_workspace_file`, `delete_workspace_file`, `list_workspace_files`;
   - `write_audit_entry`, `execute_hook`, `execute_command`, `cancel_command`.

   `callProvider` uses `call_claude_api` for Anthropic, so it is served. The spec's list now includes it.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | modify | features, optional Tauri deps, `[[bin]]`s, `default-run` |
| `src-tauri/build.rs` | modify | `tauri_build::build()` only with `app` |
| `src-tauri/src/lib.rs` | modify | gate `run()` and its imports; re-export `serve_stdio` |
| `src-tauri/src/commands/*.rs` | modify attributes | `#[cfg_attr(feature = "app", tauri::command)]`; the Tauri-only `chat_turn` wrapper and `open_workspace_dialog` behind `#[cfg(feature = "app")]` |
| `src-tauri/src/commands/core_server.rs` | create | argument types, `parse`, `dispatch`, `serve`, `serve_stdio`, unit tests |
| `src-tauri/src/commands/mod.rs` | modify | `pub mod core_server;` |
| `src-tauri/src/bin/harness-core.rs` | create | the binary's `main` |
| `src-tauri/tests/core_bin.rs` | create | spawns the real binary over pipes (only with `core`) |
| `package.json` | modify | `build:core` script |

---

### Task 0: Baseline

- [ ] **Step 1: Rust baseline**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "^test result|^warning"`
Expected: `test result: ok. 86 passed`, and no warnings.

---

### Task 1: Tauri becomes optional

**Files:** `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/{api_commands,audit_commands,chat_turn,fs_commands,process_commands,workflow_commands}.rs`

- [ ] **Step 1: See the core build fail today**

Run: `cd src-tauri && cargo check --no-default-features --features core`
Expected: an error that the package has no feature `core`.

- [ ] **Step 2: Cargo features**

In `src-tauri/Cargo.toml`, add `default-run` to `[package]`:

```toml
# Two binaries: the desktop app (what `tauri dev` / `tauri build` run) and harness-core.
default-run = "agent-workflow-builder"
```

After the `[lib]` table, add:

```toml
[[bin]]
name = "agent-workflow-builder"
path = "src/main.rs"
required-features = ["app"]

[features]
default = ["app"]
# The desktop app.
app = [
  "dep:tauri", "dep:tauri-build",
  "dep:tauri-plugin-opener", "dep:tauri-plugin-fs", "dep:tauri-plugin-dialog",
  "dep:tauri-plugin-shell", "dep:tauri-plugin-store", "dep:tauri-plugin-log",
]
# harness-core: the app's commands over stdin/stdout without Tauri, for `harness run`.
core = []
```

Make the Tauri crates optional:

```toml
[build-dependencies]
tauri-build = { version = "2", features = [], optional = true }
```
```toml
tauri = { version = "2", optional = true }
```
```toml
tauri-plugin-opener = { version = "2", optional = true }
tauri-plugin-fs = { version = "2", optional = true }
tauri-plugin-dialog = { version = "2", optional = true }
tauri-plugin-shell = { version = "2", optional = true }
tauri-plugin-store = { version = "2", optional = true }
tauri-plugin-log = { version = "2", optional = true }
```

- [ ] **Step 3: `build.rs`**

```rust
fn main() {
    // Only the desktop app (feature "app") is a Tauri build; harness-core is not.
    #[cfg(feature = "app")]
    tauri_build::build();
}
```

- [ ] **Step 4: Gate the command attributes**

```bash
cd src-tauri/src/commands
sed -i 's/^#\[tauri::command\]$/#[cfg_attr(feature = "app", tauri::command)]/; s/^#\[tauri::command(async)\]$/#[cfg_attr(feature = "app", tauri::command(async))]/' \
  api_commands.rs audit_commands.rs chat_turn.rs fs_commands.rs process_commands.rs workflow_commands.rs
```

Then make the two Tauri-only functions app-only.

In `fs_commands.rs`, change `open_workspace_dialog`'s attribute to:

```rust
#[cfg(feature = "app")]
#[tauri::command]
pub fn open_workspace_dialog(app: tauri::AppHandle) -> Option<String> {
```

In `chat_turn.rs`, change the import to:

```rust
#[cfg(feature = "app")]
use tauri::ipc::{Channel, JavaScriptChannelId};
```

and the wrapper's attributes to:

```rust
#[cfg(feature = "app")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_turn(
```

Check what is left: `grep -rn "tauri" src-tauri/src/commands`. Expected: only the `cfg_attr` lines, the two functions above with their `cfg(feature = "app")`, and the gated `use`.

- [ ] **Step 5: `lib.rs`**

Add at the top, before `mod commands;`:

```rust
// The core build (harness-core) serves only the commands a workflow run uses,
// so the app's other commands are unused there.
#![cfg_attr(not(feature = "app"), allow(dead_code))]
```

Put `#[cfg(feature = "app")]` on the `use commands::{…};` block and on `pub fn run()`. On `run()` it goes *above* `#[cfg_attr(mobile, tauri::mobile_entry_point)]`:

```rust
#[cfg(feature = "app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

- [ ] **Step 6: Both builds check cleanly, and Tauri is gone from the core build**

Run from `src-tauri`:
```bash
cargo check 2>&1 | grep -E "^(warning|error)" ; echo "app: $?"
cargo check --no-default-features --features core 2>&1 | grep -E "^(warning|error)" ; echo "core: $?"
cargo tree --no-default-features --features core -i tauri 2>&1 | tail -1
cargo test 2>&1 | grep -E "^test result: ok. [0-9]+ passed"
```
Expected:
- Both `grep`s print nothing and exit 1.
- `cargo tree` reports that `tauri` did not match any packages.
- `cargo test` reports `86 passed`.

If the core check warns about an unused import, gate that import with `#[cfg(feature = "app")]`. Never gate a function that `core_server` will use; the Task 2 list names them.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/build.rs src-tauri/src/lib.rs src-tauri/src/commands
git commit -m "Make Tauri optional in the Rust crate: an app feature (default) and a core feature"
```

---

### Task 2: `core_server.rs`

**Files:** create `src-tauri/src/commands/core_server.rs`; modify `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add `pub mod core_server;` to `src-tauri/src/commands/mod.rs` (alphabetical, after `chat_turn`). Create `src-tauri/src/commands/core_server.rs` with only this test module:

```rust
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test core_server 2>&1 | grep -E "^error" | head -5`
Expected: compile errors, because `parse`, `dispatch`, `serve`, `json` and `Value` are not found.

- [ ] **Step 3: Write the implementation**

Put this above the test module in `core_server.rs`:

```rust
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
```

Then re-export the loop from `src-tauri/src/lib.rs`, after the `mod` lines:

```rust
/// harness-core's stdin/stdout loop (`src/bin/harness-core.rs`).
pub use commands::core_server::serve_stdio;
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd src-tauri && cargo test core_server 2>&1 | grep -E "^test |^test result"`
Expected: 9 tests pass.

- [ ] **Step 5: Both builds, all tests, no warnings**

Run from `src-tauri`:
```bash
cargo check 2>&1 | grep -E "^(warning|error)"; cargo check --no-default-features --features core 2>&1 | grep -E "^(warning|error)"
cargo test 2>&1 | grep -E "^test result: ok. [0-9]+ passed"
```
Expected:
- The first line prints nothing.
- `cargo test` reports `95 passed` (86 + 9).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/core_server.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "Add core_server: the run's Rust commands as JSON lines over stdin/stdout"
```

---

### Task 3: The `harness-core` binary

**Files:** create `src-tauri/src/bin/harness-core.rs`, `src-tauri/tests/core_bin.rs`; modify `src-tauri/Cargo.toml`, `package.json`

- [ ] **Step 1: Write the failing integration test**

`src-tauri/tests/core_bin.rs`:

```rust
//! The harness-core binary answers requests on stdout and exits at the end of its input.
#![cfg(feature = "core")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

#[test]
fn answers_requests_over_its_pipes_and_exits_at_end_of_input() {
    let mut core = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = core.stdin.take().unwrap();
    writeln!(stdin, r#"{{"id":1,"cmd":"get_provider_defaults","args":{{}}}}"#).unwrap();
    writeln!(stdin, r#"{{"id":2,"cmd":"open_workspace_dialog","args":{{}}}}"#).unwrap();
    drop(stdin);

    let replies: Vec<Value> = BufReader::new(core.stdout.take().unwrap())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();

    assert!(core.wait().unwrap().success());
    assert_eq!(replies.len(), 2, "{replies:?}");
    let by_id = |id: i64| replies.iter().find(|r| r["id"] == id).unwrap();
    assert!(by_id(1)["ok"]["llm_provider"].is_string(), "{replies:?}");
    assert_eq!(by_id(2)["err"], "Unknown command: open_workspace_dialog");
}
```

Run: `cd src-tauri && cargo test --no-default-features --features core --test core_bin`
Expected: FAIL. `CARGO_BIN_EXE_harness-core` is not defined, because the binary does not exist yet.

- [ ] **Step 2: Add the binary**

`src-tauri/src/bin/harness-core.rs`:

```rust
//! harness-core: the app's Rust commands without Tauri, served over stdin/stdout
//! for `harness run`. Build: `npm run build:core`. Protocol: commands/core_server.rs.

#[tokio::main]
async fn main() {
    tauri_app_lib::serve_stdio().await;
}
```

In `src-tauri/Cargo.toml`, after the desktop `[[bin]]`:

```toml
[[bin]]
name = "harness-core"
path = "src/bin/harness-core.rs"
required-features = ["core"]
```

In `package.json` `scripts`, after `"build"`:

```json
    "build:core": "cargo build --release --manifest-path src-tauri/Cargo.toml --no-default-features --features core --bin harness-core",
```

- [ ] **Step 3: Run the integration test to see it pass**

Run: `cd src-tauri && cargo test --no-default-features --features core --test core_bin`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 4: Run the whole suite in the core build**

Run: `cd src-tauri && cargo test --no-default-features --features core 2>&1 | grep -E "^test result"`
Expected:
- Every line reads `ok`: the library's 95 tests and `core_bin`'s 1.
- This build is what Linux CI can run without Tauri's system packages.

- [ ] **Step 5: Build the release binary and try it by hand**

```bash
npm run build:core
printf '%s\n' '{"id":1,"cmd":"get_provider_defaults"}' '{"id":2,"cmd":"read_workspace_file","args":{"workspacePath":".","relativePath":"package.json"}}' \
  | src-tauri/target/release/harness-core | cut -c1-120
```
Expected: two JSON lines, id 1 with `"ok":{"llm_provider":…` and id 2 with `"ok":"{\n  \"name\": \"harness-studio\"…`, and exit 0.

- [ ] **Step 6: The default build still skips `harness-core`**

Run: `cd src-tauri && cargo build 2>&1 | tail -2 && ls target/debug/ | grep -E "^(agent-workflow-builder|harness-core)(\.exe)?$"`
Expected:
- The build succeeds and lists `agent-workflow-builder.exe`.
- `harness-core.exe` may also appear from Step 3's test build; that is fine. The next task confirms the Tauri CLI builds only the app.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/bin/harness-core.rs src-tauri/tests/core_bin.rs src-tauri/Cargo.toml package.json
git commit -m "Add the harness-core binary and npm run build:core"
```

---

### Task 4: The desktop build still works through the Tauri CLI

- [ ] **Step 1: A debug app build without bundling**

Run: `npx tauri build --debug --no-bundle 2>&1 | tail -5`
Expected:
- The frontend build runs, then Cargo builds and reports `Finished`.
- The CLI names `src-tauri/target/debug/agent-workflow-builder.exe` as the built app.
- No error about a missing binary.

If the Tauri CLI changed `Cargo.toml` (it can add features to `tauri`), check `git diff src-tauri/Cargo.toml`. Keep its change only if the build needs it, and commit it with a note.

- [ ] **Step 2: Full verification**

Run:
```bash
npx tsc --noEmit && npx vitest run 2>&1 | tail -3
cd src-tauri && cargo test 2>&1 | grep -E "^test result: ok. [0-9]+ passed" | head -1
```
Expected:
- TypeScript is unchanged: 611 tests pass.
- Rust: `95 passed`.

---

## Spec coverage (Part 2)

| Spec §2 requirement | Where |
|---|---|
| Tauri and the plugins optional under a default `app` feature; `tauri-build` optional | Task 1, Step 2 |
| `build.rs` runs `tauri_build::build()` only with `app` | Task 1, Step 3 (compile-time `cfg`, since the crate itself is optional) |
| `core` feature; desktop bin `required-features = ["app"]`, `harness-core` `["core"]` | Task 1, Step 2; Task 3, Step 2 |
| `cfg_attr(feature = "app", tauri::command)`; `open_workspace_dialog`, the `chat_turn` wrapper and `run()` app-only | Task 1, Steps 4–5 |
| JSON lines protocol, ids, `ok`/`err` | Task 2 (`request`, `response`, `serve`) |
| concurrent requests, blocking commands on `spawn_blocking`, any order | Task 2 (`start`, `blocking`); tested by the slow/fast test |
| end of input: finish in-flight, exit | Task 2 test; Task 3 integration test (exit 0) |
| served commands (plus `call_claude_api`); unknown → `Unknown command: X` | Task 2 (`parse`) and tests |
| same protections (safe paths, consent) | Task 2 tests (traversal, consent) |
| `npm run build:core` | Task 3, Step 2 |
| tests: dispatch, unknown, errors, concurrency; `cargo check --no-default-features --features core` | Tasks 1–3 |
