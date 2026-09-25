use crate::commands::fs_commands::resolve_safe_path;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
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
#[cfg_attr(feature = "app", tauri::command(async))]
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

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Agent commands that are running, by the id the frontend gave them: the
/// shell's process id, for cancel_command.
static RUNNING_COMMANDS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Takes a command out of RUNNING_COMMANDS when it ends, however it ends.
struct Registration(Option<String>);

impl Drop for Registration {
    fn drop(&mut self) {
        if let (Some(id), Ok(mut running)) = (&self.0, RUNNING_COMMANDS.lock()) {
            running.remove(id);
        }
    }
}

/// Run an agent's shell command line in the workspace folder: cmd.exe on Windows,
/// sh elsewhere. The frontend asks the user to approve each command first.
#[cfg_attr(feature = "app", tauri::command(async))]
pub fn execute_command(
    workspace_path: String,
    command: String,
    consent_granted: bool,
    // The time the agent has left, bounded to 1 s–1 h.
    timeout_secs: u64,
    // Lets cancel_command stop it (Stop in the UI).
    command_id: Option<String>,
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
    let registration = Registration(command_id);
    match wait_with_timeout(shell, timeout, |pid| {
        if let (Some(id), Ok(mut running)) = (&registration.0, RUNNING_COMMANDS.lock()) {
            running.insert(id.clone(), pid);
        }
    }) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err(AppError::Other(format!(
            "Command timed out after {} s",
            timeout.as_secs()
        ))),
        Err(e) => Err(AppError::Other(format!("Could not start the command: {e}"))),
    }
}

/// Stop a running agent command: kill its whole process tree. False if no
/// command with that id is running.
#[cfg_attr(feature = "app", tauri::command)]
pub fn cancel_command(command_id: String) -> bool {
    let pid = RUNNING_COMMANDS.lock().ok().and_then(|mut running| running.remove(&command_id));
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    pid.is_some()
}

/// Kill a process and everything it started: killing only the shell leaves its
/// children running.
fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Agent commands start in their own process group (shell_command).
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str, dir: &str) -> AppResult<Command> {
    use std::os::windows::process::CommandExt;

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
    // Its own process group, so kill_tree can end everything it started.
    std::os::unix::process::CommandExt::process_group(&mut shell, 0);
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
    wait_with_timeout(command, timeout, |_| {})
        .map_err(|e| AppError::HookExecution(e.to_string()))?
        .ok_or_else(|| {
            AppError::HookExecution(format!("Hook timeout after {}ms", timeout.as_millis()))
        })
}

/// Run to completion and collect the output; `None` if it ran past `timeout`
/// (the process tree is killed). `on_spawn` gets the process id.
fn wait_with_timeout(
    mut command: Command,
    timeout: Duration,
    on_spawn: impl FnOnce(u32),
) -> std::io::Result<Option<HookResult>> {
    let start = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    on_spawn(child.id());

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
            kill_tree(child.id());
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

    /// The platform's shell running a line: cmd.exe /C on Windows, sh -c elsewhere.
    fn shell(windows: &str, unix: &str) -> (&'static str, Vec<String>) {
        if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C".to_string(), windows.to_string()])
        } else {
            ("sh", vec!["-c".to_string(), unix.to_string()])
        }
    }

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

    #[test]
    fn execute_hook_runs_a_hook_with_consent() {
        // canonicalize() yields a \\?\ path that cmd/powershell/bash cannot open.
        let dir = tempdir().unwrap();
        let (file, script) =
            if cfg!(target_os = "windows") { ("hook.bat", "@echo hook-ran") } else { ("hook.sh", "echo hook-ran") };
        fs::write(dir.path().join(file), script).unwrap();

        let output = execute_hook(
            dir.path().to_string_lossy().to_string(),
            file.to_string(),
            "agent-1".to_string(),
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        assert!(output.stdout.contains("hook-ran"));
    }

    #[test]
    fn execute_hook_honours_the_node_timeout() {
        let dir = tempdir().unwrap();
        let (file, script) =
            if cfg!(target_os = "windows") { ("slow.bat", "@ping -n 8 127.0.0.1 >nul") } else { ("slow.sh", "sleep 8") };
        fs::write(dir.path().join(file), script).unwrap();
        let started = Instant::now();

        let result = execute_hook(
            dir.path().to_string_lossy().to_string(),
            file.to_string(),
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
        let (program, args) = shell("echo %PHASE4_MODE%", "echo $PHASE4_MODE");
        let output = run_command_with_timeout(
            program,
            &args,
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
        let (program, args) = shell("echo key=%OLLAMA_REMOTE_API_KEY%", "echo key=$OLLAMA_REMOTE_API_KEY");
        let output = run_command_with_timeout(
            program,
            &args,
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
        let (program, args) = shell(
            "for /L %i in (1,1,3000) do @echo 0123456789012345678901234567890123456789",
            "i=0; while [ $i -lt 3000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done",
        );
        let output = run_command_with_timeout(
            program,
            &args,
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
        // `start /b` (or `&` in sh) leaves a process running, holding stdout, after the shell exits.
        let dir = tempdir().unwrap();
        let started = Instant::now();
        let (program, args) = shell("start /b ping -n 8 127.0.0.1 >nul & echo done", "sleep 8 & echo done");
        let output = run_command_with_timeout(
            program,
            &args,
            dir.path(),
            &HashMap::new(),
            Duration::from_secs(20),
        )
        .unwrap();

        assert!(output.stdout.contains("done"));
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    fn run_in(dir: &Path, command: &str, timeout_secs: u64) -> AppResult<HookResult> {
        execute_command(dir.to_string_lossy().to_string(), command.to_string(), true, timeout_secs, None)
    }

    #[test]
    fn execute_command_requires_explicit_consent() {
        let dir = tempdir().unwrap();
        let result = execute_command(
            dir.path().to_string_lossy().to_string(),
            "echo ran> marker.txt".to_string(),
            false,
            10,
            None,
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

    #[test]
    fn execute_command_stops_at_the_time_limit() {
        let dir = tempdir().unwrap();
        let started = Instant::now();
        let line = if cfg!(target_os = "windows") { "ping -n 8 127.0.0.1 >nul" } else { "sleep 8" };
        let result = run_in(dir.path(), line, 1);

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

    #[test]
    fn agent_commands_do_not_inherit_provider_api_keys() {
        std::env::set_var("OLLAMA_REMOTE_API_KEY", "probe-secret-must-not-leak");
        let dir = tempdir().unwrap();
        let line =
            if cfg!(target_os = "windows") { "echo key=%OLLAMA_REMOTE_API_KEY%" } else { "echo key=$OLLAMA_REMOTE_API_KEY" };
        let output = run_in(dir.path(), line, 10);
        std::env::remove_var("OLLAMA_REMOTE_API_KEY");

        assert!(!output.unwrap().stdout.contains("probe-secret-must-not-leak"));
    }

    #[test]
    fn run_hook_enforces_timeout() {
        let dir = tempdir().unwrap();
        let (program, args) = shell("ping -n 4 127.0.0.1 > nul", "sleep 4");
        let result = run_command_with_timeout(
            program,
            &args,
            dir.path(),
            &HashMap::new(),
            Duration::from_millis(100),
        );

        assert!(
            matches!(result, Err(AppError::HookExecution(message)) if message.contains("timeout"))
        );
    }

    #[test]
    fn cancel_command_kills_a_running_command() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let started = Instant::now();
        let line = if cfg!(target_os = "windows") { "ping -n 30 127.0.0.1 >nul" } else { "sleep 30" };
        let runner = thread::spawn(move || {
            execute_command(path, line.to_string(), true, 60, Some("cancel-test".to_string()))
        });
        while !RUNNING_COMMANDS.lock().unwrap().contains_key("cancel-test") {
            assert!(started.elapsed() < Duration::from_secs(10), "the command never started");
            thread::sleep(Duration::from_millis(20));
        }

        assert!(cancel_command("cancel-test".to_string()));
        let output = runner.join().unwrap().unwrap();

        assert_ne!(output.exit_code, 0);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[test]
    fn cancel_command_ignores_unknown_and_finished_commands() {
        assert!(!cancel_command("no-such-command".to_string()));
        let dir = tempdir().unwrap();
        execute_command(dir.path().to_string_lossy().to_string(), "echo done".to_string(), true, 10,
            Some("finished-test".to_string())).unwrap();
        assert!(!cancel_command("finished-test".to_string()));
    }
}
