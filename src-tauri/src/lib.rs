mod commands;
mod error;
mod models;

use commands::{
    api_commands::{
        call_anthropic_api, call_claude_api, call_ollama_api, call_openai_api,
        check_provider_health, get_provider_defaults,
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().build())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
