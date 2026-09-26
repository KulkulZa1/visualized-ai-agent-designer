//! harness-core: the app's Rust commands without Tauri, served over stdin/stdout
//! for `harness run`. Build: `npm run build:core`. Protocol: commands/core_server.rs.

#[tokio::main]
async fn main() {
    ignore_ctrl_c();
    tauri_app_lib::serve_stdio().await;
}

/// Ctrl+C in the terminal reaches this process too (same console or process
/// group). harness run turns it into Stop and needs the core to finish the run
/// and save it, so the core ignores it: the end of its input is what stops it.
fn ignore_ctrl_c() {
    #[cfg(unix)]
    let signals = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
    #[cfg(windows)]
    let signals = tokio::signal::windows::ctrl_c();
    if let Ok(mut signals) = signals {
        tokio::spawn(async move { while signals.recv().await.is_some() {} });
    }
}
