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
