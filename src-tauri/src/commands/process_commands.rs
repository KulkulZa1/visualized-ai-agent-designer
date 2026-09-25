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

/// Run an agent's shell command line in the workspace folder: cmd.exe on Windows,
/// sh elsewhere. The frontend asks the user to approve each command first.
#[tauri::command(async)]
pub fn execute_command(
    workspace_path: String,
    command: String,
    consent_granted: bool,
    // The time the agent has left, bounded to 1 s–1 h.
    timeout_secs: u64,
) -> AppResult<HookResult> {
    if !consent_granted {
        return Err(AppError::Other(
            "Running a command requires the user's approval.".to_string(),
        ));
    }
    let dir = Path::new(&workspace_path)
        .canonicalize()
        .ok()
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| AppError::Other(format!("Workspace folder not found: {workspace_path}")))?;
    let dir = interpreter_path(&dir);
    let mut shell = shell_command(&command, &dir)?;
    // No input: a command that asks a question gets end-of-file instead of waiting.
    shell.current_dir(&dir).stdin(Stdio::null());

    let timeout = Duration::from_secs(timeout_secs.clamp(1, 3600));
    match wait_with_timeout(shell, timeout) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err(AppError::Other(format!(
            "Command timed out after {} s",
            timeout.as_secs()
        ))),
        Err(e) => Err(AppError::Other(format!("Could not start the command: {e}"))),
    }
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str, dir: &str) -> AppResult<Command> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // cmd.exe cannot use a network path as its working folder: it would run the
    // command in C:\Windows instead.
    if dir.starts_with(r"\\") {
        return Err(AppError::Other(
            "Commands cannot run in a workspace on a network share.".to_string(),
        ));
    }
    let mut shell = keyless_command("cmd.exe");
    // The line runs as typed (/s /c "…", as Node's `shell: true`; /d skips AutoRun)
    // in a cmd started after `chcp 65001`, so cmd's own output (echo, "not
    // recognized") is UTF-8: a cmd keeps the code page it started with. The line is
    // passed in a variable that is expanded (!…!) only after the outer cmd has
    // parsed its own line, so its & | > and quotes reach the inner cmd unchanged.
    shell
        .env("HARNESS_AGENT_COMMAND", command)
        .raw_arg("/d /v:on /s /c \"chcp 65001>nul & cmd /d /s /c \"!HARNESS_AGENT_COMMAND!\"\"")
        .creation_flags(CREATE_NO_WINDOW);
    Ok(shell)
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str, _dir: &str) -> AppResult<Command> {
    let mut shell = keyless_command("sh");
    shell.args(["-c", command]);
    Ok(shell)
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

/// Child processes (hooks, agent commands) must not inherit the app's provider
/// keys. A hook's explicit `env`, applied later, may still set one deliberately.
fn keyless_command(program: &str) -> Command {
    let mut command = Command::new(program);
    for key in PROVIDER_KEY_ENV_VARS {
        command.env_remove(key);
    }
    command
}

fn run_command_with_timeout(
    program: &str,
    args: &[String],
    current_dir: &Path,
    env_vars: &HashMap<String, String>,
    timeout: Duration,
) -> AppResult<HookResult> {
    let mut command = keyless_command(program);
    command.args(args).current_dir(current_dir).envs(env_vars);
    wait_with_timeout(command, timeout)
        .map_err(|e| AppError::HookExecution(e.to_string()))?
        .ok_or_else(|| {
            AppError::HookExecution(format!("Hook timeout after {}ms", timeout.as_millis()))
        })
}

/// Run to completion and collect the output; `None` if it ran past `timeout`
/// (the process tree is killed).
fn wait_with_timeout(mut command: Command, timeout: Duration) -> std::io::Result<Option<HookResult>> {
    let start = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let (stdout, stdout_reader) = drain(child.stdout.take());
    let (stderr, stderr_reader) = drain(child.stderr.take());

    loop {
        if let Some(status) = child.try_wait()? {
            let grace_end = (Instant::now() + PIPE_GRACE).min(start + timeout);
            while !(stdout_reader.is_finished() && stderr_reader.is_finished())
                && Instant::now() < grace_end
            {
                thread::sleep(Duration::from_millis(10));
            }
            return Ok(Some(HookResult {
                exit_code: status.code().unwrap_or(-1),
                stdout: captured_text(&stdout),
                stderr: captured_text(&stderr),
                duration_ms: start.elapsed().as_millis() as u64,
            }));
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
            return Ok(None);
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

    fn run_in(dir: &Path, command: &str, timeout_secs: u64) -> AppResult<HookResult> {
        execute_command(dir.to_string_lossy().to_string(), command.to_string(), true, timeout_secs)
    }

    #[test]
    fn execute_command_requires_explicit_consent() {
        let dir = tempdir().unwrap();
        let result = execute_command(
            dir.path().to_string_lossy().to_string(),
            "echo ran> marker.txt".to_string(),
            false,
            10,
        );

        assert!(matches!(result, Err(AppError::Other(message)) if message.contains("approval")));
        assert!(!dir.path().join("marker.txt").exists());
    }

    #[test]
    fn execute_command_runs_in_the_workspace_folder() {
        let dir = tempdir().unwrap();
        let output = run_in(dir.path(), "echo ran> marker.txt", 10).unwrap();

        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        assert!(dir.path().join("marker.txt").exists());
    }

    #[test]
    fn execute_command_reports_the_exit_code() {
        let dir = tempdir().unwrap();
        assert_eq!(run_in(dir.path(), "exit 3", 10).unwrap().exit_code, 3);
    }

    #[test]
    fn execute_command_reports_an_unknown_command_as_a_failure() {
        let dir = tempdir().unwrap();
        let output = run_in(dir.path(), "no-such-command-7f3a", 10).unwrap();

        assert_ne!(output.exit_code, 0);
        // cmd's own message is localized ("not recognized"): it must arrive as UTF-8.
        assert!(!output.stderr.contains('\u{FFFD}'), "stderr: {:?}", output.stderr);
    }

    #[test]
    fn execute_command_runs_the_line_as_typed() {
        // Quotes and && reach the shell unchanged: no argument escaping on the way.
        let dir = tempdir().unwrap();
        let output = run_in(dir.path(), r#"echo "a  b" && echo second"#, 10).unwrap();

        assert!(output.stdout.contains("second"), "stdout: {:?}", output.stdout);
        #[cfg(target_os = "windows")]
        assert!(output.stdout.contains(r#""a  b""#), "stdout: {:?}", output.stdout);
        #[cfg(not(target_os = "windows"))]
        assert!(output.stdout.contains("a  b"), "stdout: {:?}", output.stdout);
    }

    #[test]
    fn execute_command_output_is_utf8() {
        let dir = tempdir().unwrap();
        let output = run_in(dir.path(), "echo 한글 출력", 10).unwrap();

        assert!(output.stdout.contains("한글 출력"), "stdout: {:?}", output.stdout);
    }

    #[test]
    fn execute_command_gives_the_command_no_input() {
        // A command that asks a question must not wait for an answer.
        let dir = tempdir().unwrap();
        #[cfg(target_os = "windows")]
        let line = "set /p answer=Continue? & echo after";
        #[cfg(not(target_os = "windows"))]
        let line = "read answer; echo after";
        let started = Instant::now();
        let output = run_in(dir.path(), line, 10).unwrap();

        assert!(output.stdout.contains("after"), "stdout: {:?}", output.stdout);
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn execute_command_stops_at_the_time_limit() {
        let dir = tempdir().unwrap();
        let started = Instant::now();
        let result = run_in(dir.path(), "ping -n 8 127.0.0.1 >nul", 1);

        assert!(matches!(result, Err(AppError::Other(message)) if message.contains("timed out")));
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[test]
    fn execute_command_needs_an_existing_workspace_folder() {
        let dir = tempdir().unwrap();
        let result = run_in(&dir.path().join("gone"), "echo hi", 10);

        assert!(matches!(result, Err(AppError::Other(message)) if message.contains("not found")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn commands_do_not_run_in_a_network_folder() {
        // cmd.exe would run them in C:\Windows instead.
        assert!(shell_command("echo hi", r"\\server\share\project").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn agent_commands_do_not_inherit_provider_api_keys() {
        std::env::set_var("OLLAMA_REMOTE_API_KEY", "probe-secret-must-not-leak");
        let dir = tempdir().unwrap();
        let output = run_in(dir.path(), "echo key=%OLLAMA_REMOTE_API_KEY%", 10);
        std::env::remove_var("OLLAMA_REMOTE_API_KEY");

        assert!(!output.unwrap().stdout.contains("probe-secret-must-not-leak"));
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
