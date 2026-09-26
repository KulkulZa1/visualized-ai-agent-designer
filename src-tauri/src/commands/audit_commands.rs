use crate::commands::fs_commands::resolve_safe_path;
use crate::error::AppResult;
use crate::models::audit::AuditEntry;
use std::fs::{self, OpenOptions};
use std::io::Write;

const AUDIT_DIR: &str = ".harness";
const AUDIT_FILE: &str = "audit.log.jsonl";

#[cfg_attr(feature = "app", tauri::command)]
pub fn write_audit_entry(workspace_path: String, entry: AuditEntry) -> AppResult<()> {
    let audit_dir = resolve_safe_path(&workspace_path, AUDIT_DIR)?;
    fs::create_dir_all(&audit_dir)?;
    let audit_file = audit_dir.join(AUDIT_FILE);
    let line = serde_json::to_string(&entry)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_file)?;
    writeln!(file, "{}", line)?;
    Ok(())
}
