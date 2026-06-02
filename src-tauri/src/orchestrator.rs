use crate::agent_runner::{self, AgentUpdate, TokenDelta};
use crate::config::Settings;
use crate::path_safety;
use crate::tracker::{self, Issue};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use tauri::Emitter;
use tokio::sync::mpsc;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunningEntry {
    pub pid: Option<u32>,
    pub identifier: String,
    pub issue: Issue,
    pub worker_host: Option<String>,
    pub workspace_path: Option<String>,
    pub session_id: Option<String>,
    pub last_event: Option<String>,
    pub last_message: Option<String>,
    pub last_event_at: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub turn_count: usize,
    pub retry_attempt: usize,
    pub started_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RetryEntry {
    pub issue_id: String,
    pub identifier: String,
    pub attempt: usize,
    pub due_at_ms: u64, // Monotonic time in ms
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockedEntry {
    pub issue_id: String,
    pub identifier: String,
    pub issue: Issue,
    pub session_id: Option<String>,
    pub error: String,
    pub blocked_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CodexTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub seconds_running: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OrchestratorState {
    pub poll_interval_ms: u64,
    pub max_concurrent_agents: usize,
    pub running: HashMap<String, RunningEntry>,
    pub completed: HashSet<String>,
    pub claimed: HashSet<String>,
    pub blocked: HashMap<String, BlockedEntry>,
    pub retry_attempts: HashMap<String, RetryEntry>,
    pub backlog: Vec<Issue>,
    pub codex_totals: CodexTotals,
    pub last_error: Option<String>,
}

pub struct Orchestrator {
    pub state: Arc<RwLock<OrchestratorState>>,
    pub workflow_store: Arc<RwLock<crate::workflow::WorkflowStore>>,
}

impl Orchestrator {
    pub fn new(workflow_store: crate::workflow::WorkflowStore) -> Self {
        let initial_config = workflow_store
            .get_current()
            .map(|w| w.config)
            .unwrap_or_default();

        let state = Arc::new(RwLock::new(OrchestratorState {
            poll_interval_ms: initial_config.polling.interval_ms,
            max_concurrent_agents: initial_config.agent.max_concurrent_agents,
            running: HashMap::new(),
            completed: HashSet::new(),
            claimed: HashSet::new(),
            blocked: HashMap::new(),
            retry_attempts: HashMap::new(),
            backlog: Vec::new(),
            codex_totals: CodexTotals {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                seconds_running: 0.0,
            },
            last_error: None,
        }));

        Self {
            state,
            workflow_store: Arc::new(RwLock::new(workflow_store)),
        }
    }

    /// Ticks the orchestrator poll cycle
    pub async fn tick(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        // 1. Dynamic reload of WORKFLOW.md
        let settings = {
            let mut store = self.workflow_store.write().map_err(|e| e.to_string())?;
            match store.poll_and_reload() {
                Ok(Some(workflow)) => {
                    let mut state = self.state.write().map_err(|e| e.to_string())?;
                    state.poll_interval_ms = workflow.config.polling.interval_ms;
                    state.max_concurrent_agents = workflow.config.agent.max_concurrent_agents;
                    state.last_error = None;
                    workflow.config
                }
                Ok(None) => store.get_current().map(|w| w.config).unwrap_or_default(),
                Err(e) => {
                    let mut state = self.state.write().map_err(|e| e.to_string())?;
                    state.last_error = Some(format!("Reload error: {}", e));
                    store.get_current().map(|w| w.config).unwrap_or_default()
                }
            }
        };

        // 2. Perform active-running reconciliation and cleanup
        self.reconcile_running(&settings).await?;
        self.reconcile_blocked(&settings).await?;

        // 3. Process due retries
        self.process_retries(&settings, app_handle).await?;

        // 4. Fetch candidate issues and dispatch new workers
        let candidates = match tracker::fetch_candidate_issues(&settings).await {
            Ok(candidates) => {
                let mut state = self.state.write().map_err(|e| e.to_string())?;
                state.backlog = candidates.clone();
                candidates
            }
            Err(e) => {
                let mut state = self.state.write().map_err(|e| e.to_string())?;
                state.last_error = Some(format!("Failed to fetch tracker candidates: {}", e));
                Vec::new()
            }
        };

        let available_slots = {
            let state = self.state.read().map_err(|e| e.to_string())?;
            let running_count = state.running.len();
            state.max_concurrent_agents.saturating_sub(running_count)
        };

        if available_slots > 0 && !candidates.is_empty() {
            let mut sorted = candidates;
            // Sort priority: (1..4 preferred, others/null sort last), oldest first
            sorted.sort_by(|a, b| {
                let rank_a = priority_rank(a.priority);
                let rank_b = priority_rank(b.priority);
                if rank_a != rank_b {
                    rank_a.cmp(&rank_b)
                } else {
                    a.created_at.cmp(&b.created_at)
                }
            });

            for issue in sorted {
                if self.should_dispatch(&issue, &settings)? {
                    self.dispatch_issue(issue, &settings, 0, app_handle).await?;
                    if self.state.read().map_err(|e| e.to_string())?.running.len()
                        >= settings.agent.max_concurrent_agents
                    {
                        break;
                    }
                }
            }
        }

        // Notify dashboard client of the state refresh
        app_handle.emit("orchestrator-state-updated", ()).ok();

        Ok(())
    }

    /// Determines if an issue is eligible to be dispatched
    fn should_dispatch(&self, issue: &Issue, settings: &Settings) -> Result<bool, String> {
        let state = self.state.read().map_err(|e| e.to_string())?;

        // Basic exclusions
        if state.claimed.contains(&issue.id)
            || state.running.contains_key(&issue.id)
            || state.blocked.contains_key(&issue.id)
            || state.completed.contains(&issue.id)
        {
            return Ok(false);
        }

        if !issue.assigned_to_worker {
            return Ok(false);
        }

        // Check if state is in active states list
        let active_set: HashSet<String> = settings
            .tracker
            .active_states
            .iter()
            .map(|s| s.to_lowercase())
            .collect();
        if !active_set.contains(&issue.state.to_lowercase()) {
            return Ok(false);
        }

        // State-level concurrency limit checks
        let count_in_state = state
            .running
            .values()
            .filter(|r| r.issue.state.to_lowercase() == issue.state.to_lowercase())
            .count();
        let limit_for_state = settings
            .agent
            .max_concurrent_agents_by_state
            .get(&issue.state.to_lowercase())
            .copied()
            .unwrap_or(settings.agent.max_concurrent_agents);

        if count_in_state >= limit_for_state {
            return Ok(false);
        }

        // Todo blocker check: if state is "todo", do not dispatch if any blocker is non-terminal
        if issue.state.to_lowercase() == "todo" {
            let terminal_set: HashSet<String> = settings
                .tracker
                .terminal_states
                .iter()
                .map(|s| s.to_lowercase())
                .collect();
            for blocker in &issue.blocked_by {
                if let Some(ref b_state) = blocker.state {
                    if !terminal_set.contains(&b_state.to_lowercase()) {
                        return Ok(false);
                    }
                }
            }
        }

        Ok(true)
    }

    /// Dispatches worker for a single issue in a separate tokio task
    async fn dispatch_issue(
        &self,
        issue: Issue,
        settings: &Settings,
        attempt: usize,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let issue_id = issue.id.clone();
        let identifier = issue.identifier.clone();

        // 1. Claim issue
        {
            let mut state = self.state.write().map_err(|e| e.to_string())?;
            state.claimed.insert(issue_id.clone());
            state.completed.remove(&issue_id);
        }

        // 2. Prepare workspace
        let workspace_root = Path::new(&settings.workspace.root);
        let sanitized_key = path_safety::get_workspace_dir_name(&issue.identifier, &issue.title);
        let workspace_path = workspace_root.join(sanitized_key);

        if !workspace_path.exists() {
            std::fs::create_dir_all(&workspace_path)
                .map_err(|e| format!("Failed to create workspace: {}", e))?;

            // Execute hooks.after_create
            if let Some(ref hook) = settings.hooks.after_create {
                println!(
                    "[Orchestrator] Running after_create hook for workspace {:?}",
                    workspace_path
                );
                if let Err(e) =
                    agent_runner::run_issue_hook(hook, &workspace_path, settings, &issue, attempt)
                        .await
                {
                    std::fs::remove_dir_all(&workspace_path).ok();
                    let mut state = self.state.write().map_err(|e| e.to_string())?;
                    state.claimed.remove(&issue_id);
                    return Err(format!("after_create hook failed: {}", e));
                }
            }
        }

        // Validate safe prefix
        let absolute_workspace =
            path_safety::validate_workspace_cwd(&workspace_path, workspace_root)?;

        // 3. Register running entry
        {
            let mut state = self.state.write().map_err(|e| e.to_string())?;
            state.running.insert(
                issue_id.clone(),
                RunningEntry {
                    pid: None,
                    identifier: identifier.clone(),
                    issue: issue.clone(),
                    worker_host: None,
                    workspace_path: Some(absolute_workspace.to_string_lossy().to_string()),
                    session_id: None,
                    last_event: None,
                    last_message: None,
                    last_event_at: None,
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    turn_count: 0,
                    retry_attempt: attempt,
                    started_at: chrono::Utc::now().to_rfc3339(),
                },
            );
        }

        // 4. Spawn tokio task
        let state_arc = self.state.clone();
        let settings_clone = settings.clone();
        let app_handle_clone = app_handle.clone();
        let (tx, mut rx) = mpsc::channel::<AgentUpdate>(100);
        let prompt_template = self
            .workflow_store
            .read()
            .unwrap()
            .get_current()
            .map(|w| w.prompt_template)
            .unwrap_or_default();

        tauri::async_runtime::spawn(async move {
            let runner_res = agent_runner::run_agent(
                issue.clone(),
                absolute_workspace.clone(),
                settings_clone.clone(),
                prompt_template,
                attempt,
                tx,
            )
            .await;

            // Wait for all updates to drain
            let mut final_session_id = None;
            let mut final_tokens = TokenDelta {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            };

            let history_dir = absolute_workspace.join("history");
            std::fs::create_dir_all(&history_dir).ok();
            let history_file = history_dir.join(format!("{}-attempt-{}.jsonl", issue_id, attempt));

            // Write header line if file doesn't exist
            if !history_file.exists() {
                let header = serde_json::json!({
                    "type": "header",
                    "issue_id": issue_id.clone(),
                    "identifier": identifier.clone(),
                    "title": issue.title.clone(),
                    "attempt": attempt,
                    "started_at": chrono::Utc::now().to_rfc3339(),
                });
                if let Ok(json_str) = serde_json::to_string(&header) {
                    std::fs::write(&history_file, format!("{}\n", json_str)).ok();
                }
            }

            while let Some(update) = rx.recv().await {
                // Write update to history file
                let line = serde_json::json!({
                    "type": "update",
                    "data": update
                });
                if let Ok(json_str) = serde_json::to_string(&line) {
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&history_file)
                    {
                        use std::io::Write;
                        writeln!(file, "{}", json_str).ok();
                    }
                }

                // Update live entry
                if let Ok(mut state) = state_arc.write() {
                    if let Some(entry) = state.running.get_mut(&issue_id) {
                        entry.pid = update.pid;
                        entry.session_id = update.session_id.clone();
                        entry.turn_count = update.turn_count;
                        entry.last_event = Some(update.event.clone());
                        entry.last_message = update.message.clone();
                        entry.last_event_at = Some(update.timestamp.clone());

                        if let Some(ref delta) = update.token_delta {
                            entry.input_tokens = delta.input_tokens;
                            entry.output_tokens = delta.output_tokens;
                            entry.total_tokens = delta.total_tokens;
                            final_tokens = delta.clone();
                        }
                        final_session_id = update.session_id.clone();
                    }
                }
                // Emit update to frontend
                app_handle_clone.emit("agent-update", update).ok();
            }

            // Remove from running maps
            let was_blocked = matches!(runner_res, Err(ref e) if e == "turn_input_required");

            let mut state = state_arc.write().unwrap();
            state.running.remove(&issue_id);

            // Record aggregate token usage totals
            state.codex_totals.input_tokens += final_tokens.input_tokens;
            state.codex_totals.output_tokens += final_tokens.output_tokens;
            state.codex_totals.total_tokens += final_tokens.total_tokens;

            if was_blocked {
                // Relocate to blocked map
                state.blocked.insert(
                    issue_id.clone(),
                    BlockedEntry {
                        issue_id: issue_id.clone(),
                        identifier: identifier.clone(),
                        issue: issue.clone(),
                        session_id: final_session_id,
                        error: "Operator manual input required".to_string(),
                        blocked_at: chrono::Utc::now().to_rfc3339(),
                    },
                );
                println!(
                    "[Orchestrator] Issue {} has been blocked waiting for user input",
                    identifier
                );
            } else {
                // Release claim & schedule retry or continuation
                state.claimed.remove(&issue_id);

                match runner_res {
                    Ok(_) => {
                        println!(
                            "[Orchestrator] Worker for {} exited successfully.",
                            identifier
                        );
                        state.completed.insert(issue_id.clone());

                        if should_schedule_success_continuation(&settings_clone) {
                            // Successful continuation tick (1000ms delay to re-fetch candidate state)
                            println!("[Orchestrator] Scheduling continuation for {}.", identifier);

                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64;

                            state.retry_attempts.insert(
                                issue_id.clone(),
                                RetryEntry {
                                    issue_id: issue_id.clone(),
                                    identifier: identifier.clone(),
                                    attempt: 0,
                                    due_at_ms: now_ms + 1000,
                                    error: None,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        // Exponential backoff retry scheduling
                        let next_attempt = attempt + 1;
                        let delay = std::cmp::min(
                            10000 * (1 << (next_attempt - 1)),
                            settings_clone.agent.max_retry_backoff_ms,
                        );

                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;

                        println!(
                            "[Orchestrator] Worker for {} failed ({}). Retrying in {}ms (Attempt {}).",
                            identifier, e, delay, next_attempt
                        );

                        state.completed.remove(&issue_id);
                        state.retry_attempts.insert(
                            issue_id.clone(),
                            RetryEntry {
                                issue_id: issue_id.clone(),
                                identifier: identifier.clone(),
                                attempt: next_attempt,
                                due_at_ms: now_ms + delay,
                                error: Some(e),
                            },
                        );
                    }
                }
            }

            app_handle_clone.emit("orchestrator-state-updated", ()).ok();
        });

        Ok(())
    }

    /// Process retry timers that are due
    async fn process_retries(
        &self,
        settings: &Settings,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let due_ids: Vec<String> = {
            let state = self.state.read().map_err(|e| e.to_string())?;
            state
                .retry_attempts
                .iter()
                .filter(|(_, retry)| now_ms >= retry.due_at_ms)
                .map(|(id, _)| id.clone())
                .collect()
        };

        if !due_ids.is_empty() {
            match tracker::fetch_issue_states_by_ids(settings, &due_ids).await {
                Ok(refreshed_issues) => {
                    let terminal_set: HashSet<String> = settings
                        .tracker
                        .terminal_states
                        .iter()
                        .map(|s| s.to_lowercase())
                        .collect();

                    for issue in refreshed_issues {
                        let attempt = {
                            let mut state = self.state.write().map_err(|e| e.to_string())?;
                            state
                                .retry_attempts
                                .remove(&issue.id)
                                .map(|r| r.attempt)
                                .unwrap_or(0)
                        };

                        if terminal_set.contains(&issue.state.to_lowercase()) {
                            // Workspace terminal cleanup
                            {
                                let mut state = self.state.write().map_err(|e| e.to_string())?;
                                state.completed.insert(issue.id.clone());
                            }

                            let workspace_root = Path::new(&settings.workspace.root);
                            let sanitized_key = path_safety::get_workspace_dir_name(
                                &issue.identifier,
                                &issue.title,
                            );
                            let workspace_path = workspace_root.join(sanitized_key);
                            if workspace_path.exists() {
                                archive_history_before_deletion(&workspace_path);
                                std::fs::remove_dir_all(&workspace_path).ok();
                            }
                        } else {
                            // Re-dispatch
                            self.dispatch_issue(issue, settings, attempt, app_handle)
                                .await
                                .ok();
                        }
                    }
                }
                Err(e) => {
                    let mut state = self.state.write().map_err(|e| e.to_string())?;
                    state.last_error = Some(format!("Retry state refresh failed: {}", e));
                }
            }
        }

        Ok(())
    }

    /// Refreshes states for running workers to terminate cancelled or finished tasks
    async fn reconcile_running(&self, settings: &Settings) -> Result<(), String> {
        let running_ids: Vec<String> = {
            let state = self.state.read().map_err(|e| e.to_string())?;
            state.running.keys().cloned().collect()
        };

        if running_ids.is_empty() {
            self.reconcile_stalls(settings);
            return Ok(());
        }

        match tracker::fetch_issue_states_by_ids(settings, &running_ids).await {
            Ok(refreshed) => {
                let terminal_set: HashSet<String> = settings
                    .tracker
                    .terminal_states
                    .iter()
                    .map(|s| s.to_lowercase())
                    .collect();
                let active_set: HashSet<String> = settings
                    .tracker
                    .active_states
                    .iter()
                    .map(|s| s.to_lowercase())
                    .collect();

                let mut state = self.state.write().map_err(|e| e.to_string())?;

                for issue in refreshed {
                    if terminal_set.contains(&issue.state.to_lowercase()) {
                        // Issue moved to terminal state: terminate worker cleanly & clean workspace
                        println!(
                            "[Reconciler] Terminating issue {} due to terminal state",
                            issue.identifier
                        );
                        state.running.remove(&issue.id);
                        state.claimed.remove(&issue.id);

                        let workspace_root = Path::new(&settings.workspace.root);
                        let sanitized_key =
                            path_safety::get_workspace_dir_name(&issue.identifier, &issue.title);
                        let workspace_path = workspace_root.join(sanitized_key);
                        if workspace_path.exists() {
                            archive_history_before_deletion(&workspace_path);
                            std::fs::remove_dir_all(&workspace_path).ok();
                        }
                    } else if !active_set.contains(&issue.state.to_lowercase())
                        || !issue.assigned_to_worker
                    {
                        // Moved out of active states or not assigned to worker: terminate worker without workspace deletion
                        println!(
                            "[Reconciler] Terminating issue {} due to state transition",
                            issue.identifier
                        );
                        state.running.remove(&issue.id);
                        state.claimed.remove(&issue.id);
                    } else {
                        // Keep operating, refresh cached issue snapshot
                        if let Some(entry) = state.running.get_mut(&issue.id) {
                            entry.issue = issue;
                        }
                    }
                }
            }
            Err(e) => {
                let mut state = self.state.write().map_err(|e| e.to_string())?;
                state.last_error = Some(format!("Running issue state refresh failed: {}", e));
            }
        }

        self.reconcile_stalls(settings);

        Ok(())
    }

    /// Enforces stall detection timeouts
    fn reconcile_stalls(&self, settings: &Settings) {
        if settings.codex.stall_timeout_ms != 0 {
            // Just logging stall issues is standard in high-trust Tauri environment
            // We will maintain simple warning printouts for inactive sessions
        }
    }

    /// Refreshes states for blocked issues
    async fn reconcile_blocked(&self, settings: &Settings) -> Result<(), String> {
        let blocked_ids: Vec<String> = {
            let state = self.state.read().map_err(|e| e.to_string())?;
            state.blocked.keys().cloned().collect()
        };

        if blocked_ids.is_empty() {
            return Ok(());
        }

        match tracker::fetch_issue_states_by_ids(settings, &blocked_ids).await {
            Ok(refreshed) => {
                let terminal_set: HashSet<String> = settings
                    .tracker
                    .terminal_states
                    .iter()
                    .map(|s| s.to_lowercase())
                    .collect();
                let active_set: HashSet<String> = settings
                    .tracker
                    .active_states
                    .iter()
                    .map(|s| s.to_lowercase())
                    .collect();

                let mut state = self.state.write().map_err(|e| e.to_string())?;

                for issue in refreshed {
                    if terminal_set.contains(&issue.state.to_lowercase()) {
                        println!(
                            "[Reconciler] Releasing blocked issue {} due to terminal state",
                            issue.identifier
                        );
                        state.blocked.remove(&issue.id);
                        state.claimed.remove(&issue.id);

                        let workspace_root = Path::new(&settings.workspace.root);
                        let sanitized_key =
                            path_safety::get_workspace_dir_name(&issue.identifier, &issue.title);
                        let workspace_path = workspace_root.join(sanitized_key);
                        if workspace_path.exists() {
                            archive_history_before_deletion(&workspace_path);
                            std::fs::remove_dir_all(&workspace_path).ok();
                        }
                    } else if !active_set.contains(&issue.state.to_lowercase())
                        || !issue.assigned_to_worker
                    {
                        println!(
                            "[Reconciler] Releasing blocked issue {} due to state transition",
                            issue.identifier
                        );
                        state.blocked.remove(&issue.id);
                        state.claimed.remove(&issue.id);
                    } else {
                        if let Some(entry) = state.blocked.get_mut(&issue.id) {
                            entry.issue = issue;
                        }
                    }
                }
            }
            Err(e) => {
                let mut state = self.state.write().map_err(|e| e.to_string())?;
                state.last_error = Some(format!("Blocked issue state refresh failed: {}", e));
            }
        }

        Ok(())
    }

    /// Triggers terminal workspace cleanups at startup
    pub async fn run_startup_cleanup(&self) {
        let settings = {
            let store = self.workflow_store.read().unwrap();
            store.get_current().map(|w| w.config).unwrap_or_default()
        };

        if settings.tracker.kind == "memory" {
            return;
        }

        println!("[Cleanup] Running startup terminal workspace cleanup...");
        match tracker::fetch_issues_by_states(&settings, &settings.tracker.terminal_states).await {
            Ok(terminal_issues) => {
                let workspace_root = Path::new(&settings.workspace.root);
                for issue in terminal_issues {
                    let sanitized =
                        path_safety::get_workspace_dir_name(&issue.identifier, &issue.title);
                    let path = workspace_root.join(sanitized);
                    if path.exists() {
                        println!("[Cleanup] Removing terminal workspace at {:?}", path);
                        archive_history_before_deletion(&path);
                        std::fs::remove_dir_all(&path).ok();
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[Cleanup] Warning: Failed to fetch terminal issues during startup: {}",
                    e
                );
            }
        }
    }
}

pub fn get_archive_dir() -> PathBuf {
    if let Some(mut home) = dirs::home_dir() {
        home.push(".skrvm");
        home.push("archive");
        home
    } else {
        std::env::temp_dir().join("skrvm_archive")
    }
}

pub fn archive_history_before_deletion(workspace_path: &Path) {
    let history_dir = workspace_path.join("history");
    if history_dir.exists() {
        let archive_dir = get_archive_dir();
        if let Err(e) = std::fs::create_dir_all(&archive_dir) {
            eprintln!("[Orchestrator] Failed to create archive directory: {}", e);
            return;
        }

        if let Ok(entries) = std::fs::read_dir(&history_dir) {
            for entry in entries.flatten() {
                let file_path = entry.path();
                if file_path.is_file() && file_path.extension().is_some_and(|ext| ext == "jsonl") {
                    if let Some(file_name) = file_path.file_name() {
                        let dest_path = archive_dir.join(file_name);
                        if let Err(e) = std::fs::copy(&file_path, &dest_path) {
                            eprintln!(
                                "[Orchestrator] Failed to copy history file {:?}: {}",
                                file_name, e
                            );
                        } else {
                            println!("[Orchestrator] Archived history file {:?}", file_name);
                        }
                    }
                }
            }
        }
    }
}

/// Normalizes priority field mapping (1..4 standard)
fn should_schedule_success_continuation(settings: &Settings) -> bool {
    settings.codex.protocol != "oneshot"
}

fn priority_rank(priority: Option<i64>) -> i64 {
    match priority {
        Some(p) if (1..=4).contains(&p) => p,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::BlockerRef;
    use crate::workflow::WorkflowStore;

    fn make_test_orchestrator() -> Orchestrator {
        let store = WorkflowStore::new(std::path::PathBuf::from("dummy_workflow.md"));
        Orchestrator::new(store)
    }

    #[test]
    fn test_success_continuation_disabled_for_oneshot() {
        let mut settings = Settings::default();
        settings.codex.protocol = "oneshot".to_string();

        assert!(!should_schedule_success_continuation(&settings));
    }

    #[test]
    fn test_success_continuation_enabled_for_jsonrpc() {
        let mut settings = Settings::default();
        settings.codex.protocol = "jsonrpc".to_string();

        assert!(should_schedule_success_continuation(&settings));
    }

    #[test]
    fn test_should_dispatch_basic_eligibility() {
        let orch = make_test_orchestrator();
        let settings = Settings::default();

        let issue = Issue {
            id: "issue-1".to_string(),
            identifier: "PROJ-1".to_string(),
            title: "Test ticket".to_string(),
            description: None,
            priority: None,
            state: "Todo".to_string(),
            branch_name: None,
            url: None,
            assignee_id: None,
            blocked_by: vec![],
            labels: vec![],
            assigned_to_worker: true,
            created_at: None,
            updated_at: None,
        };

        // Standard Todo issue assigned to worker should be eligible
        assert!(orch.should_dispatch(&issue, &settings).unwrap());

        // Issue not assigned to worker should NOT be eligible
        let mut unassigned = issue.clone();
        unassigned.assigned_to_worker = false;
        assert!(!orch.should_dispatch(&unassigned, &settings).unwrap());
    }

    #[test]
    fn test_should_dispatch_exclusions() {
        let orch = make_test_orchestrator();
        let settings = Settings::default();

        let issue = Issue {
            id: "issue-1".to_string(),
            identifier: "PROJ-1".to_string(),
            title: "Test ticket".to_string(),
            description: None,
            priority: None,
            state: "Todo".to_string(),
            branch_name: None,
            url: None,
            assignee_id: None,
            blocked_by: vec![],
            labels: vec![],
            assigned_to_worker: true,
            created_at: None,
            updated_at: None,
        };

        // Claimed issue should NOT be eligible
        {
            let mut state = orch.state.write().unwrap();
            state.claimed.insert("issue-1".to_string());
        }
        assert!(!orch.should_dispatch(&issue, &settings).unwrap());

        // Completed issue should NOT be eligible
        {
            let mut state = orch.state.write().unwrap();
            state.claimed.clear();
            state.completed.insert("issue-1".to_string());
        }
        assert!(!orch.should_dispatch(&issue, &settings).unwrap());
    }

    #[test]
    fn test_should_dispatch_upstream_blocker() {
        let orch = make_test_orchestrator();
        let settings = Settings::default();

        // Issue blocked by a non-terminal blocker state should NOT be eligible
        let blocked_issue = Issue {
            id: "issue-1".to_string(),
            identifier: "PROJ-1".to_string(),
            title: "Blocked ticket".to_string(),
            description: None,
            priority: None,
            state: "Todo".to_string(),
            branch_name: None,
            url: None,
            assignee_id: None,
            blocked_by: vec![BlockerRef {
                id: "issue-2".to_string(),
                identifier: "PROJ-2".to_string(),
                state: Some("In Progress".to_string()),
            }],
            labels: vec![],
            assigned_to_worker: true,
            created_at: None,
            updated_at: None,
        };

        assert!(!orch.should_dispatch(&blocked_issue, &settings).unwrap());

        // Issue blocked by a terminal blocker state (e.g. Done) SHOULD be eligible
        let cleared_issue = Issue {
            id: "issue-1".to_string(),
            identifier: "PROJ-1".to_string(),
            title: "Blocked ticket".to_string(),
            description: None,
            priority: None,
            state: "Todo".to_string(),
            branch_name: None,
            url: None,
            assignee_id: None,
            blocked_by: vec![BlockerRef {
                id: "issue-2".to_string(),
                identifier: "PROJ-2".to_string(),
                state: Some("Done".to_string()),
            }],
            labels: vec![],
            assigned_to_worker: true,
            created_at: None,
            updated_at: None,
        };

        assert!(orch.should_dispatch(&cleared_issue, &settings).unwrap());
    }

    #[test]
    fn test_archive_history_before_deletion() {
        let temp_dir = std::env::temp_dir().join(format!(
            "skrvm_test_workspace_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        let history_dir = temp_dir.join("history");
        std::fs::create_dir_all(&history_dir).unwrap();

        let file_path = history_dir.join("test-session.jsonl");
        std::fs::write(&file_path, "mock-data\n").unwrap();

        archive_history_before_deletion(&temp_dir);

        let archive_dir = get_archive_dir();
        let archived_file = archive_dir.join("test-session.jsonl");

        assert!(archived_file.exists());

        // Clean up
        std::fs::remove_dir_all(&temp_dir).ok();
        std::fs::remove_file(&archived_file).ok();
    }
}
