use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: String,
    pub action: String,
    pub path: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    pub details: Option<String>,
    pub success: bool,
}
