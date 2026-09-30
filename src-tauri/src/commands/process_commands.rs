use crate::commands::fs_commands::resolve_safe_path;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{ErrorKind, Read};
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

/// The first line of what a hook fingerprint hashes; it names the encoding (see
/// `fingerprint_hook`). Changing the encoding needs a new version here, so that fingerprints of
/// two versions are never equal.
const FINGERPRINT_PREFIX: &str = "harness-hook-fingerprint-v1";

/// Lowercase hex.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What a hook is, as a fingerprint: its script's bytes and the `env` it is started with
/// (`preHook.env`, applied as it is, so a `BASH_ENV`, `PATH` or `PYTHONPATH` in it changes what
/// the script runs). The engine takes one per Hook node when a run starts (`hook_fingerprint`),
/// and `execute_hook` compares a hook that runs without asking with a fresh one, right before it
/// starts the script. This is the only function that computes it.
///
/// The encoding, version 1. The fingerprint is the SHA-256, as 64 lowercase hex characters, of
/// the UTF-8 text of these three lines, joined by newlines (0x0A), with no newline at the end:
///
/// ```text
/// harness-hook-fingerprint-v1
/// <hex SHA-256 of the script's bytes>
/// <env as JSON>
/// ```
///
/// - The script is hashed as bytes, as the file is: it need not be UTF-8, or text.
/// - The env is the JSON array of its `[name, value]` pairs, sorted by name (the UTF-8 bytes of
///   the name, which is code point order). The JSON is compact: no whitespace, non-ASCII
///   characters as they are, and only `"`, `\` and the characters below U+0020 escaped (`\"`,
///   `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, otherwise `\u00xx` with lowercase hex). No env and an
///   empty one are both `[]`; `[["A","1"],["B","2"]]` is A=1 and B=2.
///
/// The script's hash is always 64 characters and the env is one JSON text, so different scripts
/// or envs never give the same input to the outer hash: no pair can be cut another way (`A` =
/// `B=C` against `A=B` = `C`).
fn fingerprint_hook(script: &[u8], env: Option<&HashMap<String, String>>) -> String {
    let mut vars: Vec<(&String, &String)> = env.into_iter().flatten().collect();
    vars.sort_by(|a, b| a.0.cmp(b.0));
    let env_json = Value::Array(
        vars.into_iter()
            .map(|(name, value)| Value::from(vec![name.as_str(), value.as_str()]))
            .collect(),
    );
    let script_hash = hex(&Sha256::digest(script));
    let input = format!("{FINGERPRINT_PREFIX}\n{script_hash}\n{env_json}");
    hex(&Sha256::digest(input.as_bytes()))
}

/// A hook script's bytes, read from the path `resolve_safe_path` returned. Only a regular file
/// is read: a FIFO, a device or a folder is refused first, because reading a FIFO that has no
/// writer waits for ever, and the caller with it.
fn read_script(path: &Path) -> std::io::Result<Vec<u8>> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    std::fs::read(path)
}

/// The fingerprint (`fingerprint_hook`) of the hook script at `hook_path` with the `env` the
/// hook is started with; None if there is no such file. Anything that is not a regular file (a
/// folder, a FIFO, a device) is an error ("not a regular file") and is not read. Any other
/// failure to read it is an error too; the message is the operating system's, with no file
/// content.
///
/// The file is read at the path `resolve_safe_path` returns, links followed: a link that was
/// re-pointed is hashed as its target, the file `execute_hook` runs.
// `async`: run on Tauri's thread pool, so that a slow read does not block the UI thread, where
// a plain sync command runs.
#[cfg_attr(feature = "app", tauri::command(async))]
pub fn hook_fingerprint(
    workspace_path: String,
    hook_path: String,
    env: Option<HashMap<String, String>>,
) -> AppResult<Option<String>> {
    let safe = resolve_safe_path(&workspace_path, &hook_path)?;
    match read_script(&safe) {
        Ok(script) => Ok(Some(fingerprint_hook(&script, env.as_ref()))),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
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
    // What hook_fingerprint gave for this script and `env` when the caller checked them. When
    // given, the hook starts only if the script and `env` still have it; None starts it
    // without that check (the Hooks tab's manual runs).
    expected_fingerprint: Option<String>,
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
    if let Some(custom_env) = &env {
        env_vars.extend(custom_env.clone());
    }

    // The last step before the start: read the script again, at the path the interpreter is
    // given (links followed), and fingerprint it with the `env` about to be applied. A script
    // that changed, is gone, is not a regular file or cannot be read, or an `env` other than the
    // one that was checked, is not run. What this cannot close is the moment between this read
    // and the interpreter's own opening of the file.
    if let Some(expected) = &expected_fingerprint {
        let unchanged = read_script(&safe)
            .is_ok_and(|script| fingerprint_hook(&script, env.as_ref()) == *expected);
        if !unchanged {
            return Err(AppError::HookExecution(format!(
                "Hook script {hook_path} or its environment changed after it was checked; it was not run."
            )));
        }
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

/// How long a Stop that found no running command is remembered.
const EARLY_STOP_MEMORY: Duration = Duration::from_secs(60);

/// What cancel_command works from, by the id the frontend gave each agent command.
#[derive(Default)]
struct Commands {
    /// The commands that are running: the shell's process id.
    running: HashMap<String, u32>,
    /// Stops that found no running command, and when. Stop can overtake a command
    /// that is still starting; the command then ends the moment it has a process.
    early_stops: HashMap<String, Instant>,
}

impl Commands {
    /// A Stop: the process id to kill if the command is running, else None and the
    /// Stop is remembered for a command that is about to start.
    fn stop(&mut self, id: String) -> Option<u32> {
        if let Some(pid) = self.running.remove(&id) {
            return Some(pid);
        }
        self.early_stops
            .retain(|_, at| at.elapsed() < EARLY_STOP_MEMORY);
        self.early_stops.insert(id, Instant::now());
        None
    }

    /// The command's shell has started as `pid`. True if a Stop came first: the
    /// caller must kill it now; it is not registered.
    fn start(&mut self, id: &str, pid: u32) -> bool {
        let stopped = self
            .early_stops
            .remove(id)
            .is_some_and(|at| at.elapsed() < EARLY_STOP_MEMORY);
        if !stopped {
            self.running.insert(id.to_string(), pid);
        }
        stopped
    }
}

static COMMANDS: LazyLock<Mutex<Commands>> = LazyLock::new(Mutex::default);

/// A command's entry in COMMANDS: taken out again when it ends, however it ends.
struct Registration(Option<String>);

impl Registration {
    /// The shell has a process id: Stop can reach it now. A Stop that came earlier
    /// ends it here.
    fn started(&self, pid: u32) {
        let Some(id) = &self.0 else { return };
        if COMMANDS
            .lock()
            .is_ok_and(|mut commands| commands.start(id, pid))
        {
            kill_tree(pid);
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let (Some(id), Ok(mut commands)) = (&self.0, COMMANDS.lock()) {
            commands.running.remove(id);
            commands.early_stops.remove(id);
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
    shell.current_dir(&dir);

    let timeout = Duration::from_secs(timeout_secs.clamp(1, 3600));
    let registration = Registration(command_id);
    match wait_with_timeout(shell, timeout, |pid| registration.started(pid)) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err(AppError::Other(format!(
            "Command timed out after {} s",
            timeout.as_secs()
        ))),
        Err(e) => Err(AppError::Other(format!("Could not start the command: {e}"))),
    }
}

/// Stop a running agent command: kill its whole process tree. False if no
/// command with that id is running; one that starts under it within the next
/// minute is stopped as it starts.
#[cfg_attr(feature = "app", tauri::command)]
pub fn cancel_command(command_id: String) -> bool {
    let pid = COMMANDS
        .lock()
        .ok()
        .and_then(|mut commands| commands.stop(command_id));
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
        // Hooks and agent commands start in their own process group (child_command):
        // signal the group itself. Running `kill -KILL -<pgid>` instead is ambiguous: a
        // kill binary may read "-<pgid>" as an option and signal pid -1, every process
        // of the user.
        // SAFETY: kill(2) only sends a signal; a negative pid names a process group.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
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
    let mut shell = child_command("cmd.exe");
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
    let mut shell = child_command("sh");
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

/// Makes cmd.exe run a bare command name (`npm`, `git`) only from PATH, not from the
/// working folder, where an agent could have planted an `npm.cmd`. Only Windows
/// reads it.
const NO_CWD_IN_EXE_PATH: &str = "NoDefaultCurrentDirectoryInExePath";

/// The one way the app starts a child process (hook or agent command). The child:
/// - does not inherit the app's provider keys (a hook's explicit `env`, applied
///   later, may still set one deliberately);
/// - gets no input: a child that asks a question reads end-of-file instead of
///   waiting on the app's own stdin;
/// - does not search the working folder for bare command names (NO_CWD_IN_EXE_PATH);
/// - on Unix, is the leader of its own process group, so that kill_tree ends
///   everything it starts.
fn child_command(program: &str) -> Command {
    let mut command = Command::new(program);
    for key in PROVIDER_KEY_ENV_VARS {
        command.env_remove(key);
    }
    command.env(NO_CWD_IN_EXE_PATH, "1").stdin(Stdio::null());
    #[cfg(not(target_os = "windows"))]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command
}

fn run_command_with_timeout(
    program: &str,
    args: &[String],
    current_dir: &Path,
    env_vars: &HashMap<String, String>,
    timeout: Duration,
) -> AppResult<HookResult> {
    let mut command = child_command(program);
    command.args(args).current_dir(current_dir).envs(env_vars);
    wait_with_timeout(command, timeout, |_| {})
        .map_err(|e| AppError::HookExecution(e.to_string()))?
        .ok_or_else(|| {
            AppError::HookExecution(format!("Hook timeout after {}ms", timeout.as_millis()))
        })
}

/// Run to completion and collect the output; `None` if it ran past `timeout`
/// (the process tree is killed: `command` must come from child_command). `on_spawn`
/// gets the process id.
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

    /// `windows` on Windows, `unix` everywhere else.
    fn platform<'a>(windows: &'a str, unix: &'a str) -> &'a str {
        if cfg!(target_os = "windows") { windows } else { unix }
    }

    /// The shell line as the platform's own shell runs it: cmd.exe on Windows, sh elsewhere.
    fn shell_line(windows: &str, unix: &str) -> (&'static str, Vec<String>) {
        if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C".to_string(), windows.to_string()])
        } else {
            ("sh", vec!["-c".to_string(), unix.to_string()])
        }
    }

    /// The hook path (`run_command_with_timeout`) running one shell line.
    fn run_line(dir: &Path, windows: &str, unix: &str, timeout: Duration) -> AppResult<HookResult> {
        let (program, args) = shell_line(windows, unix);
        run_command_with_timeout(program, &args, dir, &HashMap::new(), timeout)
    }

    fn is_running(command_id: &str) -> bool {
        COMMANDS.lock().unwrap().running.contains_key(command_id)
    }

    /// Marks the second copy of the test binary that `in_fresh_process` starts.
    const PROBE_MARKER: &str = "HARNESS_TEST_PROBE";

    /// For checks that depend on the state of the whole process: its environment (the
    /// app holds a provider key) or its stdin (a child must not inherit it). Setting
    /// either in this process would change what the tests running alongside see, so
    /// the check runs in a second copy of the test binary that starts with `env` set
    /// and with a stdin that is open but never delivers anything. The copy also
    /// starts without NO_CWD_IN_EXE_PATH, which the app does not have either: a
    /// machine that sets it for every process would let a test of the code that sets
    /// it pass without that code. Call it first in the test, with the test's own
    /// name. In the copy it runs `probe`, prints its result and returns None (the
    /// test is over). In the first process it returns what the copy's probe printed.
    fn in_fresh_process(test: &str, env: &[(&str, &str)], probe: impl FnOnce() -> String) -> Option<String> {
        if std::env::var_os(PROBE_MARKER).is_some() {
            println!("{PROBE_MARKER}:{}", probe().replace(['\r', '\n'], " "));
            return None;
        }
        let module = module_path!().split_once("::").map_or("", |(_, path)| path);
        let mut copy = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("{module}::{test}"), "--nocapture"])
            .env(PROBE_MARKER, "1")
            .env_remove(NO_CWD_IN_EXE_PATH)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        // Kept open until the copy is done: a child that inherits it waits for input.
        let stdin = copy.stdin.take();
        let mut printed = String::new();
        copy.stdout.take().unwrap().read_to_string(&mut printed).unwrap();
        copy.wait().unwrap();
        drop(stdin);
        let probed = printed
            .split_once(&format!("{PROBE_MARKER}:"))
            .map(|(_, rest)| rest.lines().next().unwrap_or_default().to_string());
        Some(probed.unwrap_or_else(|| panic!("the copy of the test binary printed no probe result:\n{printed}")))
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
            None,
        );

        assert!(matches!(result, Err(AppError::HookExecution(message)) if message.contains("timeout")));
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    // ── The hook fingerprint ─────────────────────────────────────────────────

    /// The hook file's name: the platform's shell runs it.
    const HOOK: &str = if cfg!(target_os = "windows") { "hook.bat" } else { "hook.sh" };

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }

    /// What `hook_fingerprint` gives for a script that exists.
    fn fingerprint_of(dir: &Path, file: &str, env: Option<&HashMap<String, String>>) -> String {
        hook_fingerprint(dir.to_string_lossy().to_string(), file.to_string(), env.cloned())
            .unwrap()
            .expect("the script exists")
    }

    /// `execute_hook` as the engine calls it for a hook that runs without asking: with consent, the
    /// node's env, and the fingerprint it took when it checked the script (None: no check).
    fn run_checked(
        dir: &Path,
        file: &str,
        env: Option<&HashMap<String, String>>,
        expected: Option<&str>,
    ) -> AppResult<HookResult> {
        execute_hook(
            dir.to_string_lossy().to_string(),
            file.to_string(),
            "agent-1".to_string(),
            env.cloned(),
            true,
            None,
            expected.map(str::to_string),
        )
    }

    /// A script for `HOOK` that prints `hook-ran` and the value of PHASE4_MODE.
    fn prints_hook_ran() -> &'static str {
        platform("@echo hook-ran %PHASE4_MODE%", "echo hook-ran $PHASE4_MODE")
    }

    /// A script for `HOOK` that writes marker.txt in the workspace: a hook that ran leaves it.
    fn writes_the_marker() -> &'static str {
        platform("@echo ran> marker.txt", "echo ran > marker.txt")
    }

    fn assert_refused_as_changed(result: &AppResult<HookResult>, file: &str) {
        assert!(
            matches!(result, Err(AppError::HookExecution(message))
                if message.contains(file)
                    && message.contains("changed after it was checked")
                    && message.contains("it was not run")),
            "{result:?}"
        );
    }

    /// Bytes that are not UTF-8: 0xFF, and 0xC3 0x28 (a lead byte without its continuation).
    const NOT_UTF8: &[u8] = b"\xff\xfe#!/bin/sh\necho \xc3\x28\n";

    /// An env whose values need each kind of JSON escaping the encoding has, and a name that is
    /// not ASCII (it sorts last: U+00E9 comes after `Z`). In the fingerprint's input it is
    /// `[["A","line\nbreak \r\b\f \u0001 \u001b <DEL>"],["Z","tab\there \"quoted\" back\\slash"],["é","café <U+2028> <U+1F600>"]]`:
    /// DEL (0x7F), U+2028 and the emoji as they are; the other escapes as written here.
    fn escaping_env() -> HashMap<String, String> {
        env_of(&[
            ("Z", "tab\there \"quoted\" back\\slash"),
            ("\u{e9}", "caf\u{e9} \u{2028} \u{1F600}"),
            ("A", "line\nbreak \r\u{8}\u{c} \u{1} \u{1b} \u{7f}"),
        ])
    }

    /// The fingerprint of NOT_UTF8 with `escaping_env()`: vector (d) of the pinned encoding.
    const NOT_UTF8_FINGERPRINT: &str = "c1839de3f5d130be3e306b6fe107d8d7e6cfa3849c6e0137ca4bd9d62d253fe1";

    /// The fingerprint of `echo hi` + LF with the env B=2, A=1: vector (a) of the pinned encoding.
    const ECHO_HI_FINGERPRINT: &str = "c664d4fa5a1f7d70399717222711718d0d5cce35df2dc5f3eb3b0c04aecf7122";

    #[test]
    fn the_hook_fingerprint_encoding_is_pinned() {
        // Values computed outside this code, so that a change to the prefix, the script hash, the
        // JSON or the order shows. In Python 3:
        //
        //   import hashlib, json
        //   def fingerprint(script, env):
        //       pairs = [[name, env[name]] for name in sorted(env or {})]
        //       body = json.dumps(pairs, separators=(",", ":"), ensure_ascii=False)
        //       text = "harness-hook-fingerprint-v1\n" + hashlib.sha256(script).hexdigest() + "\n" + body
        //       return hashlib.sha256(text.encode("utf-8")).hexdigest()
        //
        //   (a) fingerprint(b"echo hi\n", {"B": "2", "A": "1"})   -> ECHO_HI_FINGERPRINT
        //   (b) fingerprint(b"echo hi\n", None), and with {}      -> no_env below
        //   (c) fingerprint(b"", None)                            -> the last value below
        //   (d) fingerprint(b"\xff\xfe#!/bin/sh\necho \xc3\x28\n",
        //           {"Z": "tab\there \"quoted\" back\\slash", "\u00e9": "caf\u00e9 \u2028 \U0001F600",
        //            "A": "line\nbreak \r\x08\x0c \x01 \x1b \x7f"})      -> NOT_UTF8_FINGERPRINT
        //
        // (a) again with sha256sum alone. The first command gives the script hash, which goes
        // into the input of the second:
        //   $ printf 'echo hi\n' | sha256sum
        //   ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e  -
        //   $ printf 'harness-hook-fingerprint-v1\nab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e\n[["A","1"],["B","2"]]' | sha256sum
        //   c664d4fa5a1f7d70399717222711718d0d5cce35df2dc5f3eb3b0c04aecf7122  -
        let echo_hi: &[u8] = b"echo hi\n";
        let unsorted = env_of(&[("B", "2"), ("A", "1")]);
        assert_eq!(fingerprint_hook(echo_hi, Some(&unsorted)), ECHO_HI_FINGERPRINT);
        let no_env = "2a638062e79ca4ece22f381ec451ed077e00e6522931e27b6853afdfcae3b92c";
        assert_eq!(fingerprint_hook(echo_hi, None), no_env);
        assert_eq!(fingerprint_hook(echo_hi, Some(&HashMap::new())), no_env);
        assert_eq!(
            fingerprint_hook(b"", None),
            "916fc571515d8f38c8a9f715cf797ff32bd361cefed15ba5a35cf58376a5dbcf"
        );
        assert_eq!(fingerprint_hook(NOT_UTF8, Some(&escaping_env())), NOT_UTF8_FINGERPRINT);

        // hook_fingerprint hashes the file on disk the same way.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.sh"), echo_hi).unwrap();
        assert_eq!(fingerprint_of(dir.path(), "a.sh", Some(&unsorted)), ECHO_HI_FINGERPRINT);
        assert_eq!(fingerprint_of(dir.path(), "a.sh", None), no_env);
    }

    #[test]
    fn a_script_that_is_not_utf8_is_fingerprinted_from_its_bytes() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("odd.sh"), NOT_UTF8).unwrap();

        // A read as text fails, so a check made on the text never covered such a script.
        assert!(fs::read_to_string(dir.path().join("odd.sh")).is_err());
        assert_eq!(fingerprint_of(dir.path(), "odd.sh", Some(&escaping_env())), NOT_UTF8_FINGERPRINT);
    }

    #[test]
    fn the_fingerprint_of_a_script_that_does_not_exist_is_none() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::create_dir(dir.path().join("hooks")).unwrap();

        for missing in ["gone.sh", "hooks/gone.sh", "no-such-folder/gone.sh"] {
            let result = hook_fingerprint(root.clone(), missing.to_string(), None);
            assert!(matches!(result, Ok(None)), "{missing}: {result:?}");
        }
    }

    #[test]
    fn hook_fingerprint_stays_in_the_workspace_and_reports_other_read_errors() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let outside = hook_fingerprint(root.clone(), "../outside.sh".to_string(), None);
        assert!(matches!(outside, Err(AppError::PathTraversal(_))), "{outside:?}");
        // A workspace that is not there is not a script that is not there.
        let no_workspace = dir.path().join("gone").to_string_lossy().to_string();
        let result = hook_fingerprint(no_workspace, "hook.sh".to_string(), None);
        assert!(matches!(result, Err(AppError::Io(_))), "{result:?}");
        // A folder where the script should be is not a regular file: an error, not "no such script".
        fs::create_dir(dir.path().join("hooks")).unwrap();
        let folder = hook_fingerprint(root, "hooks".to_string(), None);
        assert!(matches!(&folder, Err(AppError::Io(e)) if e.to_string() == "not a regular file"), "{folder:?}");
    }

    #[cfg(unix)]
    #[test]
    fn hook_fingerprint_reports_an_unreadable_script_without_its_content() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let script = dir.path().join("locked.sh");
        fs::write(&script, "echo top-secret-content\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o000)).unwrap();
        let enforced = fs::read(&script).is_err();
        let result = hook_fingerprint(dir.path().to_string_lossy().to_string(), "locked.sh".to_string(), None);
        // Restore first, so the TempDir can clean up even if an assertion fails.
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644)).unwrap();
        if !enforced {
            // root (CAP_DAC_OVERRIDE) reads the file anyway: nothing to test.
            eprintln!("skipped: file permissions do not apply to this user");
            return;
        }

        let message = result.unwrap_err().to_string();
        assert!(message.starts_with("IO error:"), "{message}");
        assert!(!message.contains("top-secret-content"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn hook_fingerprint_refuses_a_link_that_leads_outside_the_workspace() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("evil.sh"), "echo evil\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("evil.sh"), ws.path().join("hook.sh")).unwrap();

        let result = hook_fingerprint(ws.path().to_string_lossy().to_string(), "hook.sh".to_string(), None);

        assert!(matches!(result, Err(AppError::PathTraversal(_))), "{result:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_fingerprinted_as_its_target() {
        // resolve_safe_path follows links, and the resolved path is what execute_hook runs.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.sh"), "echo a\n").unwrap();
        fs::write(dir.path().join("b.sh"), "echo b\n").unwrap();
        let link = dir.path().join("link.sh");
        std::os::unix::fs::symlink("a.sh", &link).unwrap();
        let through_link = fingerprint_of(dir.path(), "link.sh", None);
        assert_eq!(through_link, fingerprint_of(dir.path(), "a.sh", None));

        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("b.sh", &link).unwrap();

        assert_ne!(fingerprint_of(dir.path(), "link.sh", None), through_link);
        assert_eq!(fingerprint_of(dir.path(), "link.sh", None), fingerprint_of(dir.path(), "b.sh", None));
    }

    #[test]
    fn the_env_order_does_not_change_the_fingerprint() {
        // Each HashMap iterates in an order of its own, so two maps with the same content are
        // enough to tell a sorted encoding from one that follows the map: with 32 variables
        // the chance that both orders agree by accident is negligible.
        let vars = |order: Vec<u32>| -> HashMap<String, String> {
            order.into_iter().map(|i| (format!("VAR_{i:02}"), format!("value {i}"))).collect()
        };
        let forward = vars((0..32).collect());
        let backward = vars((0..32).rev().collect());

        assert_eq!(forward, backward);
        assert_eq!(fingerprint_hook(b"x", Some(&forward)), fingerprint_hook(b"x", Some(&backward)));
    }

    #[test]
    fn a_changed_env_or_script_changes_the_fingerprint() {
        let script: &[u8] = b"echo hi\n";
        let base = fingerprint_hook(script, Some(&env_of(&[("A", "1")])));
        let differs = |script: &[u8], env: Option<HashMap<String, String>>| {
            assert_ne!(fingerprint_hook(script, env.as_ref()), base, "{script:?} with {env:?}");
        };

        // One byte of the script: changed, appended, removed, or the line ending.
        differs(b"echo ho\n", Some(env_of(&[("A", "1")])));
        differs(b"echo hi\n\0", Some(env_of(&[("A", "1")])));
        differs(b"echo hi", Some(env_of(&[("A", "1")])));
        differs(b"echo hi\r\n", Some(env_of(&[("A", "1")])));
        differs(b"", Some(env_of(&[("A", "1")])));
        // The env: no variables, another value or name, one more (an empty value counts).
        differs(script, None);
        differs(script, Some(env_of(&[])));
        differs(script, Some(env_of(&[("A", "2")])));
        differs(script, Some(env_of(&[("A", "")])));
        differs(script, Some(env_of(&[("B", "1")])));
        differs(script, Some(env_of(&[("A", "1"), ("B", "")])));
        differs(script, Some(env_of(&[("A", "1"), ("BASH_ENV", "/tmp/x")])));
        // The same characters cut into names and values another way.
        let cut = |pairs: &[(&str, &str)]| fingerprint_hook(script, Some(&env_of(pairs)));
        assert_ne!(cut(&[("A", "B=C")]), cut(&[("A=B", "C")]));
        assert_ne!(cut(&[("A", "B"), ("C", "D")]), cut(&[("A", "B\",\"C"), ("D", "")]));
        // No env and an empty one are the same.
        assert_eq!(fingerprint_hook(script, None), fingerprint_hook(script, Some(&HashMap::new())));
    }

    #[test]
    fn execute_hook_runs_a_hook_whose_fingerprint_matches() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), prints_hook_ran()).unwrap();
        let env = env_of(&[("PHASE4_MODE", "enabled")]);
        let fingerprint = fingerprint_of(dir.path(), HOOK, Some(&env));

        let output = run_checked(dir.path(), HOOK, Some(&env), Some(&fingerprint)).unwrap();

        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        // The env that was fingerprinted is the one the hook gets.
        assert!(output.stdout.contains("hook-ran enabled"), "stdout: {:?}", output.stdout);
    }

    #[cfg(unix)]
    #[test]
    fn execute_hook_accepts_the_pinned_fingerprint_of_the_pinned_script() {
        // The guard computes the encoding pinned above, not merely one that agrees with
        // hook_fingerprint.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hook.sh"), "echo hi\n").unwrap();
        let env = env_of(&[("B", "2"), ("A", "1")]);

        let output = run_checked(dir.path(), "hook.sh", Some(&env), Some(ECHO_HI_FINGERPRINT)).unwrap();

        assert_eq!(output.stdout.trim(), "hi");
    }

    #[test]
    fn execute_hook_refuses_a_script_that_changed_after_it_was_checked() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), prints_hook_ran()).unwrap();
        let fingerprint = fingerprint_of(dir.path(), HOOK, None);
        // The change: the script now leaves a marker file when it runs.
        fs::write(dir.path().join(HOOK), writes_the_marker()).unwrap();

        let result = run_checked(dir.path(), HOOK, None, Some(&fingerprint));

        assert_refused_as_changed(&result, HOOK);
        assert!(!dir.path().join("marker.txt").exists(), "the changed script ran");
        // Without a fingerprint the same script runs and leaves it: the marker shows a real run.
        run_checked(dir.path(), HOOK, None, None).unwrap();
        assert!(dir.path().join("marker.txt").exists());
    }

    #[test]
    fn execute_hook_refuses_an_env_other_than_the_one_that_was_checked() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), writes_the_marker()).unwrap();
        let checked = env_of(&[("PHASE4_MODE", "enabled")]);
        let fingerprint = fingerprint_of(dir.path(), HOOK, Some(&checked));

        for changed in [
            None,
            Some(env_of(&[])),
            Some(env_of(&[("PHASE4_MODE", "other")])),
            Some(env_of(&[("PHASE4_MODE", "enabled"), ("BASH_ENV", "/tmp/x")])),
        ] {
            let result = run_checked(dir.path(), HOOK, changed.as_ref(), Some(&fingerprint));
            assert_refused_as_changed(&result, HOOK);
        }
        assert!(!dir.path().join("marker.txt").exists(), "a hook with another env ran");
        run_checked(dir.path(), HOOK, Some(&checked), Some(&fingerprint)).unwrap();
        assert!(dir.path().join("marker.txt").exists());
    }

    #[test]
    fn execute_hook_refuses_a_script_that_is_gone_or_cannot_be_read() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), writes_the_marker()).unwrap();
        let fingerprint = fingerprint_of(dir.path(), HOOK, None);

        fs::remove_file(dir.path().join(HOOK)).unwrap();
        assert_refused_as_changed(&run_checked(dir.path(), HOOK, None, Some(&fingerprint)), HOOK);
        // A folder where the script was cannot be read.
        fs::create_dir(dir.path().join(HOOK)).unwrap();
        assert_refused_as_changed(&run_checked(dir.path(), HOOK, None, Some(&fingerprint)), HOOK);
        // A script that never was: there is nothing a fingerprint could match.
        assert_refused_as_changed(&run_checked(dir.path(), "never-was.sh", None, Some(&fingerprint)), "never-was.sh");
        // A fingerprint that is none at all matches nothing, whatever the script.
        fs::remove_dir(dir.path().join(HOOK)).unwrap();
        fs::write(dir.path().join(HOOK), writes_the_marker()).unwrap();
        for bad in ["", "not-a-fingerprint"] {
            assert_refused_as_changed(&run_checked(dir.path(), HOOK, None, Some(bad)), HOOK);
        }
        assert!(!dir.path().join("marker.txt").exists(), "a refused hook ran");
    }

    #[test]
    fn execute_hook_checks_consent_before_the_fingerprint() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), writes_the_marker()).unwrap();

        let result = execute_hook(
            dir.path().to_string_lossy().to_string(),
            HOOK.to_string(),
            "agent-1".to_string(),
            None,
            false,
            None,
            Some("not-a-fingerprint".to_string()),
        );

        assert!(matches!(result, Err(AppError::HookExecution(message)) if message.contains("consent")));
        assert!(!dir.path().join("marker.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn execute_hook_checks_the_target_of_a_link_that_was_re_pointed() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.sh"), "echo hook-ran\n").unwrap();
        fs::write(dir.path().join("evil.sh"), writes_the_marker()).unwrap();
        let link = dir.path().join("hook.sh");
        std::os::unix::fs::symlink("good.sh", &link).unwrap();
        let fingerprint = fingerprint_of(dir.path(), "hook.sh", None);
        assert!(run_checked(dir.path(), "hook.sh", None, Some(&fingerprint)).unwrap().stdout.contains("hook-ran"));

        // The hook path is the same; the link now leads to another script.
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("evil.sh", &link).unwrap();

        assert_refused_as_changed(&run_checked(dir.path(), "hook.sh", None, Some(&fingerprint)), "hook.sh");
        assert!(!dir.path().join("marker.txt").exists(), "the script the link was re-pointed to ran");
    }

    #[cfg(unix)]
    #[test]
    fn execute_hook_guards_a_script_that_is_not_utf8() {
        let dir = tempdir().unwrap();
        // An invalid byte in a comment: bash runs it; a read as text cannot open it.
        fs::write(dir.path().join(HOOK), b"echo hook-ran\n# \xff\n").unwrap();
        assert!(fs::read_to_string(dir.path().join(HOOK)).is_err());
        let fingerprint = fingerprint_of(dir.path(), HOOK, None);
        assert!(run_checked(dir.path(), HOOK, None, Some(&fingerprint)).unwrap().stdout.contains("hook-ran"));

        // Another invalid byte. Read lossily, both files are the same text.
        fs::write(dir.path().join(HOOK), b"echo hook-ran\n# \xfe\n").unwrap();

        assert_refused_as_changed(&run_checked(dir.path(), HOOK, None, Some(&fingerprint)), HOOK);
    }

    /// Where a hook script was, a FIFO (a named pipe) with no writer: reading it waits for ever.
    /// Both calls must refuse it without reading.
    #[cfg(unix)]
    #[test]
    fn a_fifo_where_the_script_was_is_refused_at_once() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(HOOK), "echo hook-ran\n").unwrap();
        let fingerprint = fingerprint_of(dir.path(), HOOK, None);
        fs::remove_file(dir.path().join(HOOK)).unwrap();
        let made = Command::new("mkfifo").arg(dir.path().join(HOOK)).status().unwrap();
        assert!(made.success(), "mkfifo failed");

        // On a thread of their own: a call that waits for the FIFO then fails this test after
        // the timeout instead of hanging it.
        let workspace = dir.path().to_path_buf();
        let (done, results) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let fingerprinted =
                hook_fingerprint(workspace.to_string_lossy().to_string(), HOOK.to_string(), None);
            let run = run_checked(&workspace, HOOK, None, Some(&fingerprint));
            let _ = done.send((fingerprinted, run));
        });
        let (fingerprinted, run) = results.recv_timeout(Duration::from_secs(10)).expect("a call waited for the FIFO");

        assert!(
            matches!(&fingerprinted, Err(AppError::Io(e)) if e.to_string() == "not a regular file"),
            "{fingerprinted:?}"
        );
        assert_refused_as_changed(&run, HOOK);
    }

    #[test]
    fn run_hook_passes_custom_environment() {
        let dir = tempdir().unwrap();
        let (program, args) = shell_line("echo %PHASE4_MODE%", "echo $PHASE4_MODE");
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

    const PROBE_SECRET: &str = "probe-secret-must-not-leak";

    /// The app holds a provider key: does a child it starts see it? `run` starts the
    /// child and returns its output.
    fn assert_child_does_not_see_the_apps_key(test: &str, run: fn(&Path) -> AppResult<HookResult>) {
        let Some(seen) = in_fresh_process(test, &[("OLLAMA_REMOTE_API_KEY", PROBE_SECRET)], || {
            let dir = tempdir().unwrap();
            let app_has_key = std::env::var("OLLAMA_REMOTE_API_KEY").as_deref() == Ok(PROBE_SECRET);
            let stdout = run(dir.path()).map(|output| output.stdout).unwrap_or_else(|e| format!("error: {e}"));
            format!("app_has_key={app_has_key} child_stdout={:?}", stdout.trim())
        }) else {
            return;
        };

        assert!(seen.contains("app_has_key=true"), "the app had no key to leak: {seen}");
        assert!(seen.contains(r#"child_stdout="key="#), "the child did not run: {seen}");
        assert!(!seen.contains(PROBE_SECRET), "the child saw the key: {seen}");
    }

    #[test]
    fn child_processes_do_not_inherit_provider_api_keys() {
        // Hooks must not be able to read the app's keys.
        assert_child_does_not_see_the_apps_key("child_processes_do_not_inherit_provider_api_keys", |dir| {
            run_line(dir, "echo key=%OLLAMA_REMOTE_API_KEY%", "echo key=$OLLAMA_REMOTE_API_KEY", Duration::from_secs(5))
        });
    }

    #[test]
    fn agent_commands_do_not_inherit_provider_api_keys() {
        assert_child_does_not_see_the_apps_key("agent_commands_do_not_inherit_provider_api_keys", |dir| {
            run_in(dir, platform("echo key=%OLLAMA_REMOTE_API_KEY%", "echo key=$OLLAMA_REMOTE_API_KEY"), 10)
        });
    }

    #[test]
    fn run_command_collects_more_than_a_pipe_buffer_of_output() {
        // ~126 KB of stdout: more than the 64 KiB pipe buffer. The child must not
        // block on a full pipe while we wait for it to exit.
        let dir = tempdir().unwrap();
        let output = run_line(
            dir.path(),
            "for /L %i in (1,1,3000) do @echo 0123456789012345678901234567890123456789",
            "i=0; while [ $i -lt 3000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done",
            Duration::from_secs(20),
        )
        .unwrap();

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.len() > 65_536, "got {} bytes", output.stdout.len());
    }

    #[test]
    fn run_command_returns_when_a_background_grandchild_keeps_the_pipes_open() {
        // The background process (`start /b` / `&`) keeps running, holding stdout,
        // after the shell exits.
        let dir = tempdir().unwrap();
        let started = Instant::now();
        let output = run_line(
            dir.path(),
            "start /b ping -n 8 127.0.0.1 >nul & echo done",
            "sleep 8 & echo done",
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
    fn run_hook_enforces_timeout() {
        let dir = tempdir().unwrap();
        let result = run_line(dir.path(), "ping -n 4 127.0.0.1 > nul", "sleep 4", Duration::from_millis(100));

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
        while !is_running("cancel-test") {
            assert!(started.elapsed() < Duration::from_secs(10), "the command never started");
            thread::sleep(Duration::from_millis(20));
        }

        assert!(cancel_command("cancel-test".to_string()));
        let output = runner.join().unwrap().unwrap();

        assert_ne!(output.exit_code, 0);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    /// Stopping a command must signal only its own process group. `kill -KILL -<pgid>`
    /// can be read by a kill binary as option `-1…` and signal pid -1: every process
    /// of the user. On the first Linux CI runs that ended the runner itself.
    #[cfg(unix)]
    #[test]
    fn stopping_a_command_leaves_other_processes_running() {
        let mut neighbour = Command::new("sleep").arg("30").spawn().unwrap();
        let dir = tempdir().unwrap();

        let result = run_in(dir.path(), "sleep 8", 1);

        assert!(matches!(result, Err(AppError::Other(message)) if message.contains("timed out")));
        let still_running = neighbour.try_wait().unwrap().is_none();
        let _ = neighbour.kill();
        let _ = neighbour.wait();
        assert!(still_running, "a process outside the command's group was killed");
    }

    #[test]
    fn cancel_command_ignores_unknown_and_finished_commands() {
        assert!(!cancel_command("no-such-command".to_string()));
        let dir = tempdir().unwrap();
        execute_command(dir.path().to_string_lossy().to_string(), "echo done".to_string(), true, 10,
            Some("finished-test".to_string())).unwrap();
        assert!(!cancel_command("finished-test".to_string()));
    }

    #[test]
    fn a_stop_that_arrives_before_the_command_starts_still_ends_it() {
        // Stop can reach cancel_command between the frontend's call and the moment
        // the shell has a process to register: it must not be lost.
        let dir = tempdir().unwrap();
        assert!(!cancel_command("stopped-early-test".to_string()), "nothing runs under this id yet");
        let started = Instant::now();
        let output = execute_command(
            dir.path().to_string_lossy().to_string(),
            platform("ping -n 30 127.0.0.1 >nul", "sleep 30").to_string(),
            true,
            60,
            Some("stopped-early-test".to_string()),
        )
        .unwrap();

        assert_ne!(output.exit_code, 0);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[test]
    fn hooks_get_no_input() {
        // A hook that asks a question gets end-of-file instead of waiting on the app's
        // own stdin. In the copy the stdin is open and silent, so a hook that
        // inherited it would wait for the whole timeout.
        let Some(seen) = in_fresh_process("hooks_get_no_input", &[], || {
            let dir = tempdir().unwrap();
            let result = run_line(
                dir.path(),
                "set /p answer=Continue? & echo after",
                "read answer; echo after",
                Duration::from_secs(3),
            );
            format!("{:?}", result.map(|output| output.stdout.trim().to_string()))
        }) else {
            return;
        };

        assert!(seen.starts_with("Ok(") && seen.contains("after"), "the hook did not finish: {seen}");
    }

    #[test]
    fn children_do_not_search_the_working_folder_for_bare_command_names() {
        // On Windows cmd.exe reads this variable and then runs a bare command name
        // (npm, git) only from PATH, not from the workspace folder, where an agent
        // could have planted npm.cmd. Elsewhere it does nothing, so here the test can
        // only check that hooks and agent commands both start with it. The copy does
        // not have it itself, so what the children see comes from the code under test
        // (a machine that sets it for every process would show it either way).
        let test = "children_do_not_search_the_working_folder_for_bare_command_names";
        let Some(seen) = in_fresh_process(test, &[], || {
            let dir = tempdir().unwrap();
            let line = platform(
                "echo folder=%NoDefaultCurrentDirectoryInExePath%",
                "echo folder=$NoDefaultCurrentDirectoryInExePath",
            );
            let hook = run_line(dir.path(), line, line, Duration::from_secs(5));
            let agent = run_in(dir.path(), line, 10);
            format!(
                "hook={:?} agent={:?}",
                hook.map(|output| output.stdout.trim().to_string()),
                agent.map(|output| output.stdout.trim().to_string()),
            )
        }) else {
            return;
        };

        assert!(seen.contains(r#"hook=Ok("folder=1")"#), "hook: {seen}");
        assert!(seen.contains(r#"agent=Ok("folder=1")"#), "agent command: {seen}");
    }

    /// The shell starts a background `sleep`, notes its process id and waits for it.
    #[cfg(unix)]
    const BACKGROUND_SLEEP: &str = "sleep 60 & echo $! > grandchild.pid; wait";

    /// The background process's id, once the shell has written it down.
    #[cfg(unix)]
    fn grandchild_pid(dir: &Path) -> u32 {
        let started = Instant::now();
        loop {
            if let Some(pid) = fs::read_to_string(dir.join("grandchild.pid")).ok().and_then(|text| text.trim().parse().ok()) {
                return pid;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "the background process never started");
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// A process that was killed but not yet collected by its parent (a zombie) is
    /// dead, though it is still listed.
    #[cfg(unix)]
    fn is_alive(pid: u32) -> bool {
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            // "pid (name) S ...": the state follows the last ')'.
            return stat.rsplit(')').next().is_some_and(|rest| !rest.trim_start().starts_with('Z'));
        }
        // No /proc entry: gone, or a system without /proc.
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn assert_stopped(pid: u32) {
        let started = Instant::now();
        while is_alive(pid) {
            assert!(started.elapsed() < Duration::from_secs(5), "process {pid} is still running");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancel_command_kills_the_commands_background_processes_too() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let (done, result) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(execute_command(path, BACKGROUND_SLEEP.to_string(), true, 30, Some("cancel-tree-test".to_string())));
        });
        let grandchild = grandchild_pid(dir.path());
        assert!(is_alive(grandchild));
        assert!(is_running("cancel-tree-test"));

        assert!(cancel_command("cancel-tree-test".to_string()));
        let output = result.recv_timeout(Duration::from_secs(10)).expect("Stop did not end the command").unwrap();

        assert_ne!(output.exit_code, 0);
        assert_stopped(grandchild);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_times_out_takes_its_background_processes_with_it() {
        let dir = tempdir().unwrap();
        let result = run_in(dir.path(), BACKGROUND_SLEEP, 2);

        assert!(matches!(result, Err(AppError::Other(message)) if message.contains("timed out")));
        assert_stopped(grandchild_pid(dir.path()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_times_out_takes_its_background_processes_with_it() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hook.sh"), "sleep 60 &\necho $! > grandchild.pid\nwait\n").unwrap();

        let result = execute_hook(
            dir.path().to_string_lossy().to_string(),
            "hook.sh".to_string(),
            "agent-1".to_string(),
            None,
            true,
            Some(2),
            None,
        );

        assert!(matches!(result, Err(AppError::HookExecution(message)) if message.contains("timeout")));
        assert_stopped(grandchild_pid(dir.path()));
    }
}
