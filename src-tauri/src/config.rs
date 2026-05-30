use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TrackerConfig {
    pub kind: String,
    pub endpoint: String,
    pub api_key: Option<String>,
    pub project_slug: String,
    pub assignee: Option<String>,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            kind: "jira".to_string(),
            endpoint: String::new(),
            api_key: None,
            project_slug: String::new(),
            assignee: None,
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec![
                "Closed".to_string(),
                "Cancelled".to_string(),
                "Canceled".to_string(),
                "Duplicate".to_string(),
                "Done".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PollingConfig {
    pub interval_ms: u64,
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self { interval_ms: 30000 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceConfig {
    pub root: String,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        let mut tmp = env::temp_dir();
        tmp.push("skrvm_workspaces");
        Self {
            root: tmp.to_string_lossy().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
    pub max_concurrent_agents: usize,
    pub max_turns: usize,
    pub max_retry_backoff_ms: u64,
    pub max_concurrent_agents_by_state: HashMap<String, usize>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_concurrent_agents: 10,
            max_turns: 20,
            max_retry_backoff_ms: 300000,
            max_concurrent_agents_by_state: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CodexConfig {
    pub command: String,
    pub approval_policy: serde_json::Value,
    pub thread_sandbox: String,
    pub turn_sandbox_policy: Option<serde_json::Value>,
    pub turn_timeout_ms: u64,
    pub read_timeout_ms: u64,
    pub stall_timeout_ms: u64,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            command: "codex app-server".to_string(),
            approval_policy: serde_json::json!({
                "reject": {
                    "sandbox_approval": true,
                    "rules": true,
                    "mcp_elicitations": true
                }
            }),
            thread_sandbox: "workspace-write".to_string(),
            turn_sandbox_policy: None,
            turn_timeout_ms: 3600000,
            read_timeout_ms: 5000,
            stall_timeout_ms: 300000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HooksConfig {
    pub after_create: Option<String>,
    pub before_run: Option<String>,
    pub after_run: Option<String>,
    pub before_remove: Option<String>,
    pub timeout_ms: u64,
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            after_create: None,
            before_run: None,
            after_run: None,
            before_remove: None,
            timeout_ms: 60000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub port: Option<u16>,
    pub host: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: None,
            host: "127.0.0.1".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub tracker: TrackerConfig,
    pub polling: PollingConfig,
    pub workspace: WorkspaceConfig,
    pub agent: AgentConfig,
    pub codex: CodexConfig,
    pub hooks: HooksConfig,
    pub server: ServerConfig,
}

impl Settings {
    /// Finalizes settings by resolving environment references (e.g. `$LINEAR_API_KEY`) and expanding paths
    pub fn finalize(&mut self, workflow_dir: &Path) {
        // Tracker env resolution
        if let Some(ref api_key) = self.tracker.api_key {
            self.tracker.api_key = resolve_env_ref(api_key)
                .or_else(|| env::var("JIRA_API_KEY").ok())
                .or_else(|| env::var("JIRA_API_TOKEN").ok())
                .or_else(|| env::var("LINEAR_API_KEY").ok());
        } else {
            self.tracker.api_key = env::var("JIRA_API_KEY")
                .ok()
                .or_else(|| env::var("JIRA_API_TOKEN").ok())
                .or_else(|| env::var("LINEAR_API_KEY").ok());
        }

        if let Some(ref assignee) = self.tracker.assignee {
            self.tracker.assignee = resolve_env_ref(assignee)
                .or_else(|| env::var("JIRA_ASSIGNEE").ok())
                .or_else(|| env::var("LINEAR_ASSIGNEE").ok());
        }

        // Workspace Path resolution
        let raw_root =
            resolve_env_ref(&self.workspace.root).unwrap_or_else(|| self.workspace.root.clone());
        let expanded = expand_path(&raw_root);

        let absolute_path = if expanded.is_relative() {
            workflow_dir.join(expanded)
        } else {
            expanded
        };
        self.workspace.root = absolute_path.to_string_lossy().to_string();
    }

    /// Performs preflight validation
    pub fn validate(&self) -> Result<(), String> {
        if self.tracker.kind.is_empty() {
            return Err("tracker.kind is missing".to_string());
        }

        if self.tracker.kind != "linear"
            && self.tracker.kind != "jira"
            && self.tracker.kind != "memory"
        {
            return Err(format!("Unsupported tracker kind: {}", self.tracker.kind));
        }

        if self.tracker.kind == "linear" {
            if self.tracker.api_key.is_none() || self.tracker.api_key.as_ref().unwrap().is_empty() {
                return Err(
                    "Missing Linear API token. Export LINEAR_API_KEY or set tracker.api_key"
                        .to_string(),
                );
            }
            if self.tracker.project_slug.is_empty() {
                return Err("Missing Linear project_slug".to_string());
            }
        }

        if self.tracker.kind == "jira" {
            if self.tracker.api_key.is_none() || self.tracker.api_key.as_ref().unwrap().is_empty() {
                return Err(
                    "Missing Jira API token. Export JIRA_API_KEY or set tracker.api_key"
                        .to_string(),
                );
            }
            if self.tracker.project_slug.is_empty() {
                return Err("Missing Jira project_slug".to_string());
            }
            if self.tracker.endpoint.is_empty() {
                return Err("Missing Jira endpoint".to_string());
            }
        }

        if self.codex.command.is_empty() {
            return Err("codex.command is empty".to_string());
        }

        Ok(())
    }
}

/// Resolves environment variable references like `$VAR`
fn resolve_env_ref(val: &str) -> Option<String> {
    if let Some(env_name) = val.strip_prefix('$') {
        env::var(env_name).ok()
    } else {
        Some(val.to_string())
    }
}

/// Expands `~` home directory to absolute path
fn expand_path(val: &str) -> PathBuf {
    if let Some(suffix) = val.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            let tail = if suffix.starts_with('/') || suffix.starts_with('\\') {
                &suffix[1..]
            } else {
                suffix
            };
            home.join(tail)
        } else {
            PathBuf::from(val)
        }
    } else {
        PathBuf::from(val)
    }
}
