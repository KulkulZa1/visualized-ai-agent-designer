use crate::commands::fs_commands::resolve_safe_path;
use crate::error::{AppError, AppResult};
use crate::models::audit::AuditEntry;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

const AUDIT_DIR: &str = ".harness";
const AUDIT_FILE: &str = "audit.log.jsonl";

/// Refuses a log that is a symbolic link. A cloned repository can ship one, and
/// opening it for append writes the entry to the link's target, wherever that
/// is. `resolve_safe_path` cannot catch this: it vets the folder, and a dangling
/// link resolves to a new file under it.
fn refuse_symlink(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(AppError::Other(format!(
            "{AUDIT_DIR}/{AUDIT_FILE} is a symbolic link; the audit entry was not written"
        ))),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn write_audit_entry(workspace_path: String, entry: AuditEntry) -> AppResult<()> {
    let audit_dir = resolve_safe_path(&workspace_path, AUDIT_DIR)?;
    fs::create_dir_all(&audit_dir)?;
    let audit_file = audit_dir.join(AUDIT_FILE);
    refuse_symlink(&audit_file)?;
    let line = serde_json::to_string(&entry)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_file)?;
    writeln!(file, "{}", line)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn entry(id: &str) -> AuditEntry {
        AuditEntry {
            id: id.to_string(),
            timestamp: "2026-09-29T00:00:00Z".to_string(),
            action: "test".to_string(),
            path: None,
            agent_id: None,
            details: None,
            success: true,
        }
    }

    fn root(workspace: &TempDir) -> String {
        workspace.path().to_string_lossy().to_string()
    }

    /// Makes the workspace's `.harness/audit.log.jsonl` a symbolic link to `target`.
    #[cfg(unix)]
    fn link_log_to(workspace: &TempDir, target: &std::path::Path) {
        fs::create_dir(workspace.path().join(AUDIT_DIR)).unwrap();
        std::os::unix::fs::symlink(target, workspace.path().join(AUDIT_DIR).join(AUDIT_FILE)).unwrap();
    }

    #[test]
    fn write_audit_entry_appends_one_json_line_per_entry() {
        let workspace = tempfile::tempdir().unwrap();

        write_audit_entry(root(&workspace), entry("first")).unwrap();
        write_audit_entry(root(&workspace), entry("second")).unwrap();

        let log = fs::read_to_string(workspace.path().join(AUDIT_DIR).join(AUDIT_FILE)).unwrap();
        let ids: Vec<String> = log
            .lines()
            .map(|line| serde_json::from_str::<AuditEntry>(line).unwrap().id)
            .collect();
        assert_eq!(ids, ["first", "second"]);
    }

    #[cfg(unix)]
    #[test]
    fn write_audit_entry_refuses_a_log_linked_to_a_file_outside_the_workspace() {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join(".bashrc");
        fs::write(&target, "export PATH=/usr/bin\n").unwrap();
        let workspace = tempfile::tempdir().unwrap();
        link_log_to(&workspace, &target);

        let error = write_audit_entry(root(&workspace), entry("a")).unwrap_err();

        assert!(error.to_string().contains("symbolic link"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "export PATH=/usr/bin\n");
    }

    #[cfg(unix)]
    #[test]
    fn write_audit_entry_does_not_create_a_missing_file_outside_the_workspace_through_a_link() {
        // resolve_safe_path alone would pass this: the link dangles, so the log
        // path resolves to a new file under .harness, yet opening it for append
        // would create the link's target.
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("created-by-the-audit-log");
        let workspace = tempfile::tempdir().unwrap();
        link_log_to(&workspace, &target);

        let result = write_audit_entry(root(&workspace), entry("a"));

        assert!(result.is_err());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_audit_entry_refuses_a_log_linked_to_another_file_in_the_workspace() {
        // Inside the workspace is no safer: the link could aim at a git hook.
        let workspace = tempfile::tempdir().unwrap();
        let hook = workspace.path().join("pre-commit");
        fs::write(&hook, "#!/bin/sh\n").unwrap();
        link_log_to(&workspace, &hook);

        assert!(write_audit_entry(root(&workspace), entry("a")).is_err());
        assert_eq!(fs::read_to_string(&hook).unwrap(), "#!/bin/sh\n");
    }
}
