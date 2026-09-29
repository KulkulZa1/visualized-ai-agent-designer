// The core build (harness-core) serves only the commands a workflow run uses,
// so the app's other commands are unused there.
#![cfg_attr(not(feature = "app"), allow(dead_code))]

mod commands;
mod error;
mod models;

/// harness-core's stdin/stdout loop (`src/bin/harness-core.rs`).
pub use commands::core_server::serve_stdio;

#[cfg(feature = "app")]
use commands::{
    api_commands::{
        call_anthropic_api, call_claude_api, call_ollama_api, call_openai_api,
        check_provider_health, get_provider_defaults, list_provider_models,
    },
    audit_commands::write_audit_entry,
    chat_turn::chat_turn,
    fs_commands::{
        delete_workspace_file, list_workspace_files, open_workspace_dialog, read_workspace_file,
        write_workspace_file,
    },
    process_commands::{cancel_command, execute_command, execute_hook},
    workflow_commands::{load_workflow, save_workflow},
};

#[cfg(feature = "app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log level: DEBUG in dev builds, WARN in release.
    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().level(log_level).build())
        .setup(|_app| {
            // In debug builds: mark the window title and open DevTools automatically
            // so any frontend error or console.error is immediately visible.
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.set_title("Harness Studio [DEV]");
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace_dialog,
            list_workspace_files,
            read_workspace_file,
            write_workspace_file,
            delete_workspace_file,
            save_workflow,
            load_workflow,
            write_audit_entry,
            execute_hook,
            execute_command,
            cancel_command,
            call_claude_api,
            call_anthropic_api,
            call_openai_api,
            call_ollama_api,
            chat_turn,
            check_provider_health,
            get_provider_defaults,
            list_provider_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
