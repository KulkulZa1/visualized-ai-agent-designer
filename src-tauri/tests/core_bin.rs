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

/// Asks for the provider defaults and returns the reply.
#[cfg(unix)]
fn ask(stdin: &mut impl Write, stdout: &mut impl BufRead, id: u32) -> Value {
    writeln!(stdin, r#"{{"id":{id},"cmd":"get_provider_defaults"}}"#).unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

/// Ctrl+C in the terminal reaches the core along with harness run, which turns it
/// into Stop: the core must keep serving so the run can end and be saved.
#[cfg(unix)]
#[test]
fn keeps_serving_after_ctrl_c() {
    let mut core = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = core.stdin.take().unwrap();
    let mut stdout = BufReader::new(core.stdout.take().unwrap());
    assert_eq!(ask(&mut stdin, &mut stdout, 1)["id"], 1);

    let interrupted = Command::new("kill").args(["-INT", &core.id().to_string()]).status().unwrap();
    assert!(interrupted.success());
    std::thread::sleep(std::time::Duration::from_millis(200));

    assert_eq!(ask(&mut stdin, &mut stdout, 2)["id"], 2);
    drop(stdin);
    assert!(core.wait().unwrap().success());
}
