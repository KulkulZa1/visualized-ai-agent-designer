mod commands;
mod error;
mod models;

use commands::{
    api_commands::{
        call_anthropic_api, call_claude_api, call_ollama_api, call_openai_api,
        check_provider_health, get_provider_defaults, list_provider_models,
    },
    audit_commands::write_audit_entry,
    fs_commands::{
        list_workspace_files, open_workspace_dialog, read_workspace_file, write_workspace_file,
    },
    process_commands::execute_hook,
    workflow_commands::{load_workflow, save_workflow},
};

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
            save_workflow,
            load_workflow,
            write_audit_entry,
            execute_hook,
            call_claude_api,
            call_anthropic_api,
            call_openai_api,
            call_ollama_api,
            check_provider_health,
            get_provider_defaults,
            list_provider_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
