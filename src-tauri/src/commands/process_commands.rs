use crate::commands::fs_commands::resolve_safe_path;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const HOOK_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Serialize)]
pub struct HookResult {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
}

#[tauri::command]
pub fn execute_hook(
    workspace_path: String,
    hook_path: String,
    agent_id: String,
    env: Option<HashMap<String, String>>,
) -> AppResult<HookResult> {
    // Validate path stays within workspace
    let safe = resolve_safe_path(&workspace_path, &hook_path)?;
    let hook_arg = safe.to_string_lossy().to_string();

    // Determine executor based on extension
    let ext = safe.extension().and_then(|e| e.to_str()).unwrap_or("");
    let (program, args): (&str, Vec<String>) = match ext {
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
        Duration::from_secs(HOOK_TIMEOUT_SECS),
    )
}

fn run_command_with_timeout(
    program: &str,
    args: &[String],
    current_dir: &Path,
    env_vars: &HashMap<String, String>,
    timeout: Duration,
) -> AppResult<HookResult> {
    let start = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .current_dir(current_dir)
        .envs(env_vars)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::HookExecution(e.to_string()))?;

    loop {
        if child
            .try_wait()
            .map_err(|e| AppError::HookExecution(e.to_string()))?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|e| AppError::HookExecution(e.to_string()))?;
            return Ok(HookResult {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                duration_ms: start.elapsed().as_millis() as u64,
            });
        }

        if start.elapsed() >= timeout {
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
    use tempfile::tempdir;

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
