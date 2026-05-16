use crate::error::{AppError, AppResult};
use crate::commands::fs_commands::resolve_safe_path;
use crate::models::workflow::WorkflowDef;
use std::fs;

#[tauri::command]
pub fn save_workflow(
    workspace_path: String,
    relative_path: String,
    workflow: WorkflowDef,
) -> AppResult<()> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(&workflow)?;
    let tmp = safe.with_extension("tmp");
    fs::write(&tmp, &yaml)?;
    fs::rename(&tmp, &safe)?;
    Ok(())
}

#[tauri::command]
pub fn load_workflow(workspace_path: String, relative_path: String) -> AppResult<WorkflowDef> {
    let safe = resolve_safe_path(&workspace_path, &relative_path)?;
    let content = fs::read_to_string(safe)?;
    let def: WorkflowDef = serde_yaml::from_str(&content)
        .map_err(|e| AppError::Yaml(e))?;
    Ok(def)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::workflow::{WorkflowMeta, ExecutionSettings};
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn temp_workspace() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    fn sample_workflow() -> WorkflowDef {
        WorkflowDef {
            meta: WorkflowMeta {
                name: "Test".to_string(),
                version: "1.0.0".to_string(),
                description: "".to_string(),
                project_root: "/test".to_string(),
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
            },
            agents: vec![],
            connections: vec![],
            execution_settings: ExecutionSettings {
                max_parallel: 4,
                timeout_seconds: 300,
                retry_on_failure: false,
                max_retries: 0,
            },
            node_positions: HashMap::new(),
        }
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = temp_workspace();
        let root = dir.path().to_str().unwrap().to_string();
        let wf = sample_workflow();
        save_workflow(root.clone(), "workflow.yaml".to_string(), wf.clone()).unwrap();
        let loaded = load_workflow(root, "workflow.yaml".to_string()).unwrap();
        assert_eq!(loaded.meta.name, "Test");
        assert_eq!(loaded.meta.version, "1.0.0");
    }
}
