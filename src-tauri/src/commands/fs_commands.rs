use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub children: Option<Vec<FileTreeEntry>>,
}

/// True for a UNC path (`\\host\share`, `//host/share`) or a Windows device or
/// verbatim path (`\\.\...`, `\\?\UNC\...`, `\\?\GLOBALROOT\...`, and their
/// forward-slash forms). Windows reads `/` and `\` alike, so mixed forms count.
///
/// Opening such a path makes Windows authenticate to the named host (SMB/WebDAV,
/// an NTLM credential leak) before any workspace check could refuse it, so this
/// looks at the text alone and runs before any filesystem call, on every platform.
/// Drive paths (`C:\ws\x`) and the verbatim drive form `canonicalize` returns
/// (`\\?\C:\ws\x`) do not match: whether they lie inside the workspace is decided
/// after canonicalization.
fn is_unc_or_device_path(path: &str) -> bool {
    let path = path.replace('/', "\\");
    let Some(rest) = path.strip_prefix("\\\\") else {
        return false;
    };
    // `\\?\C:` (then end or `\`) is the one `\\`-prefixed form that stays local.
    let verbatim_drive = rest.strip_prefix("?\\").is_some_and(|after| {
        matches!(after.as_bytes(), [d, b':'] | [d, b':', b'\\', ..] if d.is_ascii_alphabetic())
    });
    !verbatim_drive
}

/// Validates that `relative_path` stays within `workspace_root`.
/// Returns the canonical resolved path on success.
///
/// UNC and device paths are refused first, on the text alone (see
/// `is_unc_or_device_path`), with the same error as a path outside the workspace.
pub fn resolve_safe_path(workspace_root: &str, relative_path: &str) -> AppResult<PathBuf> {
    if is_unc_or_device_path(relative_path) {
        return Err(AppError::PathTraversal(relative_path.to_string()));
    }
    let root = Path::new(workspace_root).canonicalize()?;
    let joined = root.join(relative_path);
    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Path does not exist yet (new file or folder). Canonicalize the deepest
            // existing ancestor — following any symlink or junction — and re-append
            // the missing components, so a link inside the workspace cannot place a
            // new file outside it.
            let mut ancestor = joined.clone();
            let mut missing = Vec::new();
            let base = loop {
                if let Ok(base) = ancestor.canonicalize() {
                    break base;
                }
                match ancestor.components().next_back() {
                    Some(std::path::Component::Normal(name)) => missing.push(name.to_os_string()),
                    _ => return Err(AppError::PathTraversal(relative_path.to_string())),
                }
                ancestor.pop();
            };
            missing.iter().rev().fold(base, |path, name| path.join(name))
        }
    };
    if !resolved.starts_with(&root) {
        return Err(AppError::PathTraversal(relative_path.to_string()));
    }
    Ok(resolved)
}

/// Write via a uniquely named temp file in the same folder, then rename, so a
/// failed write never leaves a truncated target. Refuses directory targets
/// (including the workspace root itself).
pub fn atomic_write(target: &Path, content: &[u8]) -> AppResult<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);

    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(AppError::Other(format!("{} is not a file path", target.display())));
    };
    if target.is_dir() {
        return Err(AppError::Other(format!("{} is a directory", target.display())));
    }
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, content)?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn open_workspace_dialog(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

// `async`: walking a large tree (node_modules, target) must not block the UI thread.
#[cfg_attr(feature = "app", tauri::command(async))]
pub fn list_workspace_files(workspace_path: String) -> AppResult<Vec<FileTreeEntry>> {
    let root = Path::new(&workspace_path);
    if !root.is_dir() {
        return Err(AppError::Other(format!(
            "{} is not a directory",
            workspace_path
        )));
    }
    read_dir_recursive(root, root)
}

/// Fails only if `dir` itself cannot be read; the caller decides what that means.
/// An entry that cannot be read is skipped, and so is the content of a subfolder
/// that cannot be read (it is listed, with no children).
fn read_dir_recursive(base: &Path, dir: &Path) -> AppResult<Vec<FileTreeEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden directories except .agent-audit
        if name.starts_with('.') && name != ".agent-audit" {
            continue;
        }
        let relative = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        // Unlike `path.is_dir()`, `file_type()` does not follow links: a symlink or
        // junction is listed as a leaf and never entered, so a link that points back
        // at its own folder cannot make the walk endless.
        let Ok(file_type) = entry.file_type() else { continue };
        let is_dir = file_type.is_dir();
        let children = if is_dir {
            Some(read_dir_recursive(base, &path).unwrap_or_default())
        } else {
            None
        };
        entries.push(FileTreeEntry {
            name,
            path: relative,
            is_directory: is_dir,
            children,
        });
    }
    entries.sort_by(|a, b| {
        // Directories first, then alphabetical
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });
    Ok(entries)
}

#[cfg_attr(feature = "app", tauri::command)]
pub fn read_workspace_file(workspace_path: String, relative_path: String) -> AppResult<String> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    Ok(std::fs::read_to_string(safe)?)
}

#[cfg_attr(feature = "app", tauri::command)]
pub fn write_workspace_file(
    workspace_path: String,
    relative_path: String,
    content: String,
) -> AppResult<()> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    atomic_write(&safe, content.as_bytes())
}

/// Delete one file inside the workspace (reverting a file an agent created).
/// Folders are refused.
#[cfg_attr(feature = "app", tauri::command)]
pub fn delete_workspace_file(workspace_path: String, relative_path: String) -> AppResult<()> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    if !safe.is_file() {
        return Err(AppError::Other(format!("{relative_path} is not a file")));
    }
    std::fs::remove_file(safe)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn temp_workspace() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn resolve_safe_path_allows_nested_file() {
        let dir = temp_workspace();
        let result = resolve_safe_path(dir.path().to_str().unwrap(), "foo/bar.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_safe_path_rejects_traversal() {
        let dir = temp_workspace();
        let result = resolve_safe_path(dir.path().to_str().unwrap(), "../outside.txt");
        assert!(matches!(result, Err(AppError::PathTraversal(_))));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_safe_path_rejects_new_files_under_a_junction_leading_outside() {
        let ws = temp_workspace();
        let outside = temp_workspace();
        let linked = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(ws.path().join("link"))
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(linked.status.success());

        let root = ws.path().to_str().unwrap();
        assert!(matches!(resolve_safe_path(root, "link/new.txt"), Err(AppError::PathTraversal(_))));
        assert!(matches!(
            resolve_safe_path(root, "link/deep/nested/new.txt"),
            Err(AppError::PathTraversal(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_safe_path_rejects_new_files_under_a_symlink_leading_outside() {
        let ws = temp_workspace();
        let outside = temp_workspace();
        std::os::unix::fs::symlink(outside.path(), ws.path().join("link")).unwrap();

        let root = ws.path().to_str().unwrap();
        assert!(matches!(resolve_safe_path(root, "link/new.txt"), Err(AppError::PathTraversal(_))));
        assert!(matches!(
            resolve_safe_path(root, "link/deep/nested/new.txt"),
            Err(AppError::PathTraversal(_))
        ));
    }

    #[test]
    fn resolve_safe_path_rejects_new_absolute_paths_outside_the_workspace() {
        let ws = temp_workspace();
        let outside = temp_workspace();
        let target = outside.path().join("new.txt");
        let result = resolve_safe_path(ws.path().to_str().unwrap(), target.to_str().unwrap());
        assert!(matches!(result, Err(AppError::PathTraversal(_))));
    }

    /// UNC and device spellings. The check is textual, so every one of them is
    /// tested here on Linux too, where none is a special path to the OS.
    const UNC_AND_DEVICE_PATHS: &[&str] = &[
        r"\\host\share\file.txt",
        "//host/share/file.txt",
        r"\/host/share/file.txt",
        r"/\host\share\file.txt",
        r"\\?\UNC\host\share\file.txt",
        r"\\?\unc\host\share\file.txt",
        "//?/UNC/host/share/file.txt",
        r"\\.\pipe\file",
        "//./pipe/file",
        r"\\.\C:\file.txt",
        r"\\?\GLOBALROOT\Device\Mup\host\share\file.txt",
    ];

    #[test]
    fn resolve_safe_path_rejects_unc_and_device_paths() {
        let ws = temp_workspace();
        let root = ws.path().to_str().unwrap();
        for rel in UNC_AND_DEVICE_PATHS {
            assert!(
                matches!(resolve_safe_path(root, rel), Err(AppError::PathTraversal(p)) if p == *rel),
                "{rel} must be refused as PathTraversal"
            );
        }
    }

    #[test]
    fn resolve_safe_path_rejects_unc_and_device_paths_before_any_filesystem_call() {
        // The workspace root does not exist, so a filesystem call made first
        // (canonicalize, exists, metadata) would fail with an I/O error instead.
        let ws = temp_workspace();
        let missing_root = ws.path().join("missing");
        let missing_root = missing_root.to_str().unwrap();

        assert!(matches!(resolve_safe_path(missing_root, "file.txt"), Err(AppError::Io(_))));
        for rel in UNC_AND_DEVICE_PATHS {
            assert!(
                matches!(resolve_safe_path(missing_root, rel), Err(AppError::PathTraversal(_))),
                "{rel} must be refused before the filesystem is touched"
            );
        }
    }

    #[test]
    fn unc_check_leaves_relative_and_drive_paths_alone() {
        // No rule ties a drive path to the workspace root's text: on Windows the
        // canonical root is `\\?\C:\...` while the UI passes `C:\...`.
        for rel in [
            "",
            "file.txt",
            "sub/file.txt",
            r"sub\file.txt",
            "./file.txt",
            "sub//file.txt",
            r"sub\\file.txt",
            "/tmp/ws/file.txt",
            r"\file.txt",
            r"C:\ws\file.txt",
            "C:/ws/file.txt",
            r"\\?\C:\ws\file.txt",
            r"\\?\C:",
        ] {
            assert!(!is_unc_or_device_path(rel), "{rel:?} is not a UNC or device path");
        }
    }

    #[test]
    fn resolve_safe_path_still_resolves_relative_and_absolute_paths_inside_the_workspace() {
        let ws = temp_workspace();
        fs::create_dir(ws.path().join("sub")).unwrap();
        fs::write(ws.path().join("sub").join("file.txt"), "x").unwrap();
        let root = ws.path().to_str().unwrap();
        let canonical_root = ws.path().canonicalize().unwrap();
        let existing = canonical_root.join("sub").join("file.txt");
        let new_file = canonical_root.join("sub").join("new.txt");

        assert_eq!(resolve_safe_path(root, "sub/file.txt").unwrap(), existing);
        assert_eq!(resolve_safe_path(root, "sub/new.txt").unwrap(), new_file);

        let absolute_existing = ws.path().join("sub").join("file.txt");
        let absolute_new = ws.path().join("sub").join("new.txt");
        assert_eq!(resolve_safe_path(root, absolute_existing.to_str().unwrap()).unwrap(), existing);
        assert_eq!(resolve_safe_path(root, absolute_new.to_str().unwrap()).unwrap(), new_file);
    }

    #[test]
    fn write_workspace_file_refuses_the_workspace_root_and_leaves_no_stray_temp_file() {
        let parent = temp_workspace();
        let ws = parent.path().join("ws");
        fs::create_dir(&ws).unwrap();

        let result = write_workspace_file(ws.to_string_lossy().to_string(), ".".to_string(), "x".to_string());

        assert!(result.is_err());
        assert!(!parent.path().join("ws.tmp").exists());
    }

    #[test]
    fn write_workspace_file_does_not_clobber_a_sibling_tmp_file() {
        let dir = temp_workspace();
        fs::write(dir.path().join("report.tmp"), "user data").unwrap();

        write_workspace_file(
            dir.path().to_string_lossy().to_string(),
            "report.md".to_string(),
            "# report".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("report.tmp")).unwrap(), "user data");
    }

    #[test]
    fn reading_a_missing_file_reports_os_error_2() {
        // Contract with toolExecutor's fs.append: only "(os error 2|3)" means
        // "file does not exist yet"; any other read error must not be treated as empty.
        let dir = temp_workspace();
        let err = read_workspace_file(
            dir.path().to_string_lossy().to_string(),
            "missing.txt".to_string(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("(os error 2)"), "{err}");
    }

    #[test]
    fn write_and_read_roundtrip() {
        let dir = temp_workspace();
        let root = dir.path().to_str().unwrap().to_string();
        write_workspace_file(root.clone(), "test.txt".to_string(), "hello".to_string()).unwrap();
        let content = read_workspace_file(root, "test.txt".to_string()).unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn list_files_returns_sorted_dirs_first() {
        let dir = temp_workspace();
        let root = dir.path();
        fs::create_dir(root.join("subdir")).unwrap();
        fs::write(root.join("file.txt"), "").unwrap();
        let entries = list_workspace_files(root.to_str().unwrap().to_string()).unwrap();
        assert!(entries[0].is_directory);
    }

    #[cfg(unix)]
    #[test]
    fn list_files_lists_a_self_referencing_symlink_as_a_leaf() {
        let dir = temp_workspace();
        let root = dir.path();
        fs::write(root.join("file.txt"), "").unwrap();
        // Points at its own folder. Followed, it recurses until the OS gives up
        // (exponentially, with more than one such link).
        std::os::unix::fs::symlink(".", root.join("loop")).unwrap();

        let entries = list_workspace_files(root.to_str().unwrap().to_string()).unwrap();

        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["file.txt", "loop"]);
        assert!(!entries[1].is_directory);
        assert!(entries[1].children.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn list_files_does_not_follow_a_symlink_to_a_folder_outside_the_workspace() {
        let ws = temp_workspace();
        let outside = temp_workspace();
        fs::write(outside.path().join("secret.txt"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), ws.path().join("link")).unwrap();

        let entries = list_workspace_files(ws.path().to_str().unwrap().to_string()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "link");
        assert!(!entries[0].is_directory);
        assert!(entries[0].children.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn list_files_skips_the_content_of_a_subfolder_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_workspace();
        let root = dir.path();
        let locked = root.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("inner.txt"), "").unwrap();
        fs::write(root.join("ok.txt"), "").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let enforced = fs::read_dir(&locked).is_err();
        let result = list_workspace_files(root.to_str().unwrap().to_string());
        // Restore first, so the TempDir can clean up even if an assertion fails.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if !enforced {
            // root (CAP_DAC_OVERRIDE) reads the folder anyway: nothing to test.
            eprintln!("skipped: file permissions do not apply to this user");
            return;
        }

        let entries = result.expect("an unreadable subfolder must not fail the listing");
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["locked", "ok.txt"]);
        assert!(entries[0].is_directory);
        assert!(entries[0].children.as_ref().unwrap().is_empty());
    }

    #[test]
    fn delete_workspace_file_removes_a_file_inside_the_workspace() {
        let dir = temp_workspace();
        fs::write(dir.path().join("new.txt"), "x").unwrap();

        delete_workspace_file(dir.path().to_string_lossy().to_string(), "new.txt".to_string()).unwrap();

        assert!(!dir.path().join("new.txt").exists());
    }

    #[test]
    fn delete_workspace_file_refuses_folders_and_paths_outside() {
        let dir = temp_workspace();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let root = dir.path().to_string_lossy().to_string();

        assert!(delete_workspace_file(root.clone(), "sub".to_string()).is_err());
        assert!(dir.path().join("sub").exists());
        assert!(matches!(
            delete_workspace_file(root, "../outside.txt".to_string()),
            Err(AppError::PathTraversal(_))
        ));
    }
}
