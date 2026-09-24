use crate::commands::fs_commands::resolve_safe_path;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const HOOK_TIMEOUT_SECS: u64 = 30;

/// Provider credentials the backend reads from the environment (api_commands.rs).
const PROVIDER_KEY_ENV_VARS: [&str; 4] = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OLLAMA_API_KEY",
    "OLLAMA_REMOTE_API_KEY",
];

#[derive(Debug, Serialize)]
pub struct HookResult {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
}

/// canonicalize() yields verbatim paths on Windows (`\\?\C:\x`, `\\?\UNC\host\share`),
/// which cmd.exe, `powershell -File` and bash cannot open. Interpreters need the
/// ordinary form.
fn interpreter_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

// `async`: run on Tauri's thread pool. A plain sync command runs on the main
// thread and would freeze the whole window for the hook's full timeout.
#[tauri::command(async)]
pub fn execute_hook(
    workspace_path: String,
    hook_path: String,
    agent_id: String,
    env: Option<HashMap<String, String>>,
    consent_granted: bool,
    // The node's timeoutSeconds; defaults to HOOK_TIMEOUT_SECS, bounded to 1 s–1 h.
    timeout_secs: Option<u64>,
) -> AppResult<HookResult> {
    if !consent_granted {
        return Err(AppError::HookExecution(
            "Hook execution requires explicit user consent.".to_string(),
        ));
    }

    // Validate path stays within workspace
    let safe = resolve_safe_path(&workspace_path, &hook_path)?;
    let hook_arg = interpreter_path(&safe);

    // Determine executor based on extension
    let ext = safe
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (program, args): (&str, Vec<String>) = match ext.as_str() {
        "ps1" => (
            "powershell.exe",
            vec!["-NonInteractive".into(), "-File".into(), hook_arg],
        ),
        "sh" | "bash" => ("bash", vec![hook_arg]),
        "py" => ("python", vec![hook_arg]),
        _ => ("cmd.exe", vec!["/C".into(), hook_arg]),
    };

    let mut env_vars = HashMap::from([
        ("AGENT_ID".to_string(), agent_id),
        ("WORKSPACE".to_string(), workspace_path.clone()),
    ]);
    if let Some(custom_env) = env {
        env_vars.extend(custom_env);
    }

    run_command_with_timeout(
        program,
        &args,
        Path::new(&workspace_path),
        &env_vars,
        Duration::from_secs(timeout_secs.unwrap_or(HOOK_TIMEOUT_SECS).clamp(1, 3600)),
    )
}

/// Per-stream cap on captured output; anything beyond it is read and discarded.
const MAX_CAPTURED_BYTES: usize = 1024 * 1024;
/// After the child exits, how long to keep collecting output from pipes that a
/// background grandchild may still hold open.
const PIPE_GRACE: Duration = Duration::from_secs(2);

type Captured = Arc<Mutex<Vec<u8>>>;

/// Read a child pipe on its own thread. A child blocks once its pipe buffer
/// (64 KiB on Windows) is full, so output must be drained while it runs.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> (Captured, thread::JoinHandle<()>) {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    let handle = thread::spawn(move || {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if let Ok(mut buf) = sink.lock() {
                let room = MAX_CAPTURED_BYTES.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
    });
    (captured, handle)
}

fn captured_text(captured: &Captured) -> String {
    captured
        .lock()
        .map(|buf| String::from_utf8_lossy(&buf).into_owned())
        .unwrap_or_default()
}

fn run_command_with_timeout(
    program: &str,
    args: &[String],
    current_dir: &Path,
    env_vars: &HashMap<String, String>,
    timeout: Duration,
) -> AppResult<HookResult> {
    let start = Instant::now();
    let mut command = Command::new(program);
    // Hook processes must not inherit the app's provider keys. A hook's explicit
    // `env` (applied below) may still set one deliberately.
    for key in PROVIDER_KEY_ENV_VARS {
        command.env_remove(key);
    }
    let mut child = command
        .args(args)
        .current_dir(current_dir)
        .envs(env_vars)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::HookExecution(e.to_string()))?;

    let (stdout, stdout_reader) = drain(child.stdout.take());
    let (stderr, stderr_reader) = drain(child.stderr.take());

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| AppError::HookExecution(e.to_string()))?
        {
            let grace_end = (Instant::now() + PIPE_GRACE).min(start + timeout);
            while !(stdout_reader.is_finished() && stderr_reader.is_finished())
                && Instant::now() < grace_end
            {
                thread::sleep(Duration::from_millis(10));
            }
            return Ok(HookResult {
                exit_code: status.code().unwrap_or(-1),
                stdout: captured_text(&stdout),
                stderr: captured_text(&stderr),
                duration_ms: start.elapsed().as_millis() as u64,
            });
        }

        if start.elapsed() >= timeout {
            // Kill the whole tree: killing only the shell leaves its children running.
            #[cfg(target_os = "windows")]
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &child.id().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::HookExecution(format!(
                "Hook timeout after {}ms",
                timeout.as_millis()
            )));
        }

        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn execute_hook_requires_explicit_consent() {
        let dir = tempdir().unwrap();
        let hook_path = dir.path().join("hook.bat");
        fs::write(&hook_path, "echo should-not-run").unwrap();

        let result = execute_hook(
            dir.path().to_string_lossy().to_string(),
            "hook.bat".to_string(),
            "agent-1".to_string(),
            None,
            false,
            None,
        );

        assert!(
            matches!(result, Err(AppError::HookExecution(message)) if message.contains("consent"))
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn execute_hook_runs_a_batch_hook_with_consent() {
        // canonicalize() yields a \\?\ path that cmd/powershell/bash cannot open.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hook.bat"), "@echo hook-ran").unwrap();

        let output = execute_hook(
            dir.path().to_string_lossy().to_string(),
            "hook.bat".to_string(),
            "agent-1".to_string(),
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        assert!(output.stdout.contains("hook-ran"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn execute_hook_honours_the_node_timeout() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("slow.bat"), "@ping -n 8 127.0.0.1 >nul").unwrap();
        let started = Instant::now();

        let result = execute_hook(
            dir.path().to_string_lossy().to_string(),
            "slow.bat".to_string(),
            "agent-1".to_string(),
            None,
            true,
            Some(1),
        );

        assert!(matches!(result, Err(AppError::HookExecution(message)) if message.contains("timeout")));
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[test]
    fn run_hook_passes_custom_environment() {
        let dir = tempdir().unwrap();
        let output = run_command_with_timeout(
            "cmd.exe",
            &["/C".to_string(), "echo %PHASE4_MODE%".to_string()],
            dir.path(),
            &HashMap::from([("PHASE4_MODE".to_string(), "enabled".to_string())]),
            Duration::from_secs(2),
        )
        .unwrap();

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("enabled"));
    }

    #[test]
    fn child_processes_do_not_inherit_provider_api_keys() {
        // Hooks and agent-issued commands must not be able to read the app's keys.
        std::env::set_var("OLLAMA_REMOTE_API_KEY", "probe-secret-must-not-leak");
        let dir = tempdir().unwrap();
        let output = run_command_with_timeout(
            "cmd.exe",
            &["/C".to_string(), "echo key=%OLLAMA_REMOTE_API_KEY%".to_string()],
            dir.path(),
            &HashMap::new(),
            Duration::from_secs(5),
        );
        std::env::remove_var("OLLAMA_REMOTE_API_KEY");

        assert!(!output.unwrap().stdout.contains("probe-secret-must-not-leak"));
    }

    #[test]
    fn run_command_collects_more_than_a_pipe_buffer_of_output() {
        // ~126 KB of stdout: more than the 64 KiB pipe buffer. The child must not
        // block on a full pipe while we wait for it to exit.
        let dir = tempdir().unwrap();
        let output = run_command_with_timeout(
            "cmd.exe",
            &[
                "/C".to_string(),
                "for /L %i in (1,1,3000) do @echo 0123456789012345678901234567890123456789"
                    .to_string(),
            ],
            dir.path(),
            &HashMap::new(),
            Duration::from_secs(20),
        )
        .unwrap();

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.len() > 65_536, "got {} bytes", output.stdout.len());
    }

    #[test]
    fn run_command_returns_when_a_background_grandchild_keeps_the_pipes_open() {
        // `start /b` leaves ping running (holding stdout) after cmd exits.
        let dir = tempdir().unwrap();
        let started = Instant::now();
        let output = run_command_with_timeout(
            "cmd.exe",
            &["/C".to_string(), "start /b ping -n 8 127.0.0.1 >nul & echo done".to_string()],
            dir.path(),
            &HashMap::new(),
            Duration::from_secs(20),
        )
        .unwrap();

        assert!(output.stdout.contains("done"));
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[test]
    fn run_hook_enforces_timeout() {
        let dir = tempdir().unwrap();
        let result = run_command_with_timeout(
            "cmd.exe",
            &["/C".to_string(), "ping -n 4 127.0.0.1 > nul".to_string()],
            dir.path(),
            &HashMap::new(),
            Duration::from_millis(100),
        );

        assert!(
            matches!(result, Err(AppError::HookExecution(message)) if message.contains("timeout"))
        );
    }
}
