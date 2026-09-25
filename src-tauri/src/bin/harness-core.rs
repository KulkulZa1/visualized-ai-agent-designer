//! harness-core: the app's Rust commands without Tauri, served over stdin/stdout
//! for `harness run`. Build: `npm run build:core`. Protocol: commands/core_server.rs.

#[tokio::main]
async fn main() {
    tauri_app_lib::serve_stdio().await;
}
