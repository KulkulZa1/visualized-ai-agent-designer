use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowMeta {
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutionSettings {
    #[serde(rename = "maxParallel")]
    pub max_parallel: u32,
    #[serde(rename = "timeoutSeconds")]
    pub timeout_seconds: u32,
    #[serde(rename = "retryOnFailure")]
    pub retry_on_failure: bool,
    #[serde(rename = "maxRetries")]
    pub max_retries: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowDef {
    pub meta: WorkflowMeta,
    pub agents: Vec<serde_json::Value>,
    pub connections: Vec<serde_json::Value>,
    #[serde(rename = "executionSettings")]
    pub execution_settings: ExecutionSettings,
    #[serde(rename = "nodePositions")]
    pub node_positions: HashMap<String, NodePosition>,
}
