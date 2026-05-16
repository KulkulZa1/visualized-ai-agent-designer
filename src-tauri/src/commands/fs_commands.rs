use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub children: Option<Vec<FileTreeEntry>>,
}

/// Validates that `relative_path` stays within `workspace_root`.
/// Returns the canonical resolved path on success.
pub fn resolve_safe_path(workspace_root: &str, relative_path: &str) -> AppResult<PathBuf> {
    let root = Path::new(workspace_root).canonicalize()?;
    let joined = root.join(relative_path);
    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Path may not exist yet (new file). Walk components manually.
            let mut clean = root.clone();
            for component in Path::new(relative_path).components() {
                use std::path::Component;
                match component {
                    Component::Normal(c) => clean.push(c),
                    Component::ParentDir => {
                        // reject traversal
                        return Err(AppError::PathTraversal(relative_path.to_string()));
                    }
                    _ => {}
                }
            }
            clean
        }
    };
    if !resolved.starts_with(&root) {
        return Err(AppError::PathTraversal(relative_path.to_string()));
    }
    Ok(resolved)
}

#[tauri::command]
pub fn open_workspace_dialog(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
pub fn list_workspace_files(workspace_path: String) -> AppResult<Vec<FileTreeEntry>> {
    let root = Path::new(&workspace_path);
    if !root.is_dir() {
        return Err(AppError::Other(format!("{} is not a directory", workspace_path)));
    }
    read_dir_recursive(root, root)
}

fn read_dir_recursive(base: &Path, dir: &Path) -> AppResult<Vec<FileTreeEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden directories except .agent-audit
        if name.starts_with('.') && name != ".agent-audit" {
            continue;
        }
        let relative = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
        let is_dir = path.is_dir();
        let children = if is_dir {
            Some(read_dir_recursive(base, &path)?)
        } else {
            None
        };
        entries.push(FileTreeEntry { name, path: relative, is_directory: is_dir, children });
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

#[tauri::command]
pub fn read_workspace_file(workspace_path: String, relative_path: String) -> AppResult<String> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    Ok(std::fs::read_to_string(safe)?)
}

#[tauri::command]
pub fn write_workspace_file(workspace_path: String, relative_path: String, content: String) -> AppResult<()> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    if let Some(parent) = safe.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write: write to .tmp then rename
    let tmp = safe.with_extension("tmp");
    std::fs::write(&tmp, &content)?;
    std::fs::rename(&tmp, &safe)?;
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
}
