mod agent_runner;
mod config;
mod orchestrator;
mod path_safety;
mod tracker;
mod workflow;

use orchestrator::Orchestrator;
use std::collections::HashSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State};

struct AppState {
    orchestrator: Arc<Orchestrator>,
}

#[tauri::command]
fn get_orchestrator_state(
    state: State<'_, AppState>,
) -> Result<orchestrator::OrchestratorState, String> {
    let orch_state = state
        .orchestrator
        .state
        .read()
        .map_err(|e| format!("Failed to read state lock: {}", e))?;
    Ok(orch_state.clone())
}

#[tauri::command]
async fn reload_workflow(state: State<'_, AppState>) -> Result<config::Settings, String> {
    let mut store = state
        .orchestrator
        .workflow_store
        .write()
        .map_err(|e| format!("Failed to write store lock: {}", e))?;

    match store.force_reload() {
        Ok(workflow) => {
            let mut o_state = state
                .orchestrator
                .state
                .write()
                .map_err(|e| format!("Failed to write state lock: {}", e))?;
            o_state.poll_interval_ms = workflow.config.polling.interval_ms;
            o_state.max_concurrent_agents = workflow.config.agent.max_concurrent_agents;
            o_state.last_error = None;
            Ok(workflow.config)
        }
        Err(e) => Err(format!("Reload failed: {}", e)),
    }
}

#[tauri::command]
fn unblock_issue(issue_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut o_state = state
        .orchestrator
        .state
        .write()
        .map_err(|e| format!("Failed to write state lock: {}", e))?;

    if o_state.blocked.remove(&issue_id).is_some() {
        o_state.claimed.remove(&issue_id);
        println!(
            "[Orchestrator] User manually unblocked and released claim for issue {}",
            issue_id
        );
        Ok(())
    } else {
        Err("Issue is not currently in a blocked state".to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SaveWorkflowPayload {
    pub settings: config::Settings,
    pub prompt_template: String,
    pub project_dir: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GitInfo {
    pub project_dir: String,
    pub remote_url: Option<String>,
    pub project_slug: Option<String>,
    pub current_branch: Option<String>,
    pub detected_tracker: Option<String>,
}

#[tauri::command]
fn detect_local_git_info(state: State<'_, AppState>) -> Result<GitInfo, String> {
    let store = state
        .orchestrator
        .workflow_store
        .read()
        .map_err(|e| format!("Failed to read store lock: {}", e))?;

    let workflow_path = store.file_path().to_path_buf();
    let project_dir = workflow_path
        .parent()
        .ok_or_else(|| "Failed to resolve project root directory".to_string())?
        .to_path_buf();

    let project_dir_str = project_dir.to_string_lossy().to_string();

    let mut url_cmd = std::process::Command::new("git");
    url_cmd
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(&project_dir);
    let remote_url = match url_cmd.output() {
        Ok(output) if output.status.success() => {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    };

    let mut branch_cmd = std::process::Command::new("git");
    branch_cmd
        .args(["branch", "--show-current"])
        .current_dir(&project_dir);
    let mut current_branch = match branch_cmd.output() {
        Ok(output) if output.status.success() => {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    };
    if current_branch.is_none() {
        let mut rev_cmd = std::process::Command::new("git");
        rev_cmd
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&project_dir);
        current_branch = match rev_cmd.output() {
            Ok(output) if output.status.success() => {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            }
            _ => None,
        };
    }

    let mut project_slug = None;
    let mut detected_tracker = None;

    if let Some(ref url) = remote_url {
        if url.contains("github.com") {
            detected_tracker = Some("github".to_string());
        } else if url.contains("gitlab.com") {
            detected_tracker = Some("gitlab".to_string());
        }

        let cleaned = if let Some(stripped) = url.strip_prefix("git@github.com:") {
            stripped
        } else if let Some(stripped) = url.strip_prefix("https://github.com/") {
            stripped
        } else if let Some(stripped) = url.strip_prefix("git@gitlab.com:") {
            stripped
        } else if let Some(stripped) = url.strip_prefix("https://gitlab.com/") {
            stripped
        } else if let Some(idx) = url.find(':') {
            &url[idx + 1..]
        } else {
            url
        };

        let cleaned = cleaned.strip_suffix(".git").unwrap_or(cleaned);
        if !cleaned.is_empty() {
            project_slug = Some(cleaned.to_string());
        }
    }

    Ok(GitInfo {
        project_dir: project_dir_str,
        remote_url,
        project_slug,
        current_branch,
        detected_tracker,
    })
}

#[tauri::command]
fn get_current_workflow(state: State<'_, AppState>) -> Result<Option<SaveWorkflowPayload>, String> {
    let store = state
        .orchestrator
        .workflow_store
        .read()
        .map_err(|e| format!("Failed to read store lock: {}", e))?;

    let project_dir = store
        .file_path()
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    if let Some(workflow) = store.get_current() {
        Ok(Some(SaveWorkflowPayload {
            settings: workflow.config,
            prompt_template: workflow.prompt_template,
            project_dir,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn save_workflow(
    payload: SaveWorkflowPayload,
    state: State<'_, AppState>,
) -> Result<config::Settings, String> {
    let workflow_path = {
        let store = state
            .orchestrator
            .workflow_store
            .read()
            .map_err(|e| format!("Failed to read store lock: {}", e))?;
        store.file_path().to_path_buf()
    };

    // Serialize Settings to YAML front-matter
    let yaml_str = serde_yaml::to_string(&payload.settings)
        .map_err(|e| format!("Failed to serialize settings to YAML: {}", e))?;

    // Combine YAML front matter with prompt template
    let content = format!("---\n{}---\n\n{}", yaml_str, payload.prompt_template);

    // Ensure parent directory exists
    if let Some(parent) = workflow_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    // Write content to workflow file
    std::fs::write(&workflow_path, content)
        .map_err(|e| format!("Failed to write WORKFLOW.md: {}", e))?;

    // Force reload workflow store to activate the new configuration
    let mut store = state
        .orchestrator
        .workflow_store
        .write()
        .map_err(|e| format!("Failed to write store lock: {}", e))?;

    let workflow = store
        .force_reload()
        .map_err(|e| format!("Failed to reload workflow: {}", e))?;

    // Update orchestrator state
    let mut o_state = state
        .orchestrator
        .state
        .write()
        .map_err(|e| format!("Failed to write state lock: {}", e))?;

    o_state.poll_interval_ms = workflow.config.polling.interval_ms;
    o_state.max_concurrent_agents = workflow.config.agent.max_concurrent_agents;
    o_state.last_error = None;

    Ok(workflow.config)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionHistoryEntry {
    pub session_id: String,
    pub issue_id: String,
    pub identifier: String,
    pub title: String,
    pub attempt: usize,
    pub started_at: String,
    pub file_path: String,
}

fn read_session_header(file_path: &Path) -> Option<SessionHistoryEntry> {
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);
    if let Some(Ok(line)) = reader.lines().next() {
        let val: serde_json::Value = serde_json::from_str(&line).ok()?;
        if val["type"] == "header" {
            let session_id = file_path.file_stem()?.to_string_lossy().into_owned();
            return Some(SessionHistoryEntry {
                session_id,
                issue_id: val["issue_id"].as_str()?.to_string(),
                identifier: val["identifier"].as_str()?.to_string(),
                title: val["title"].as_str()?.to_string(),
                attempt: val["attempt"].as_u64()? as usize,
                started_at: val["started_at"].as_str()?.to_string(),
                file_path: file_path.to_string_lossy().into_owned(),
            });
        }
    }
    None
}

#[tauri::command]
fn get_session_histories(state: State<'_, AppState>) -> Result<Vec<SessionHistoryEntry>, String> {
    let settings = {
        let store = state
            .orchestrator
            .workflow_store
            .read()
            .map_err(|e| format!("Failed to read workflow store: {}", e))?;
        store.get_current().map(|w| w.config).unwrap_or_default()
    };

    let mut entries = Vec::new();
    let mut seen_sessions = HashSet::new();

    // 1. Scan workspaces
    let workspace_root = Path::new(&settings.workspace.root);
    if workspace_root.exists() {
        if let Ok(workspace_dirs) = std::fs::read_dir(workspace_root) {
            for dir_entry in workspace_dirs.flatten() {
                let dir_path = dir_entry.path();
                if dir_path.is_dir() {
                    let history_dir = dir_path.join("history");
                    if history_dir.exists() {
                        if let Ok(files) = std::fs::read_dir(&history_dir) {
                            for file_entry in files.flatten() {
                                let path = file_entry.path();
                                if path.is_file()
                                    && path.extension().is_some_and(|ext| ext == "jsonl")
                                {
                                    if let Some(entry) = read_session_header(&path) {
                                        if seen_sessions.insert(entry.session_id.clone()) {
                                            entries.push(entry);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Scan central archive
    let archive_dir = orchestrator::get_archive_dir();
    if archive_dir.exists() {
        if let Ok(files) = std::fs::read_dir(&archive_dir) {
            for file_entry in files.flatten() {
                let path = file_entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                    if let Some(entry) = read_session_header(&path) {
                        if seen_sessions.insert(entry.session_id.clone()) {
                            entries.push(entry);
                        }
                    }
                }
            }
        }
    }

    // Sort by started_at descending (newest first)
    entries.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    Ok(entries)
}

#[tauri::command]
fn get_session_transcript(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("Transcript file does not exist: {}", file_path));
    }

    // Security check: must be either inside the configured workspace root or inside the central archive directory
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let archive_dir = orchestrator::get_archive_dir()
        .canonicalize()
        .unwrap_or(orchestrator::get_archive_dir());

    let is_in_archive = canonical_path.starts_with(&archive_dir);
    let is_in_history = canonical_path
        .components()
        .any(|c| c.as_os_str() == "history");

    if !is_in_archive && !is_in_history {
        return Err("Access denied: path is outside permitted history directories".to_string());
    }

    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut events = Vec::new();

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| format!("Failed to read line: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        let val: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| format!("Invalid JSON line: {}", e))?;
        if val["type"] == "update" {
            events.push(val["data"].clone());
        }
    }

    Ok(events)
}

#[tauri::command]
fn verify_workspace_setup(project_dir: String, workspace_root: String) -> Result<(), String> {
    let p_path = Path::new(&project_dir);
    if !p_path.exists() {
        return Err("Project directory does not exist".to_string());
    }
    if !p_path.is_dir() {
        return Err("Project path is not a directory".to_string());
    }
    if !p_path.join(".git").exists() {
        return Err("Project directory is not a git repository (missing .git folder)".to_string());
    }

    let w_path = Path::new(&workspace_root);
    if !w_path.exists() {
        if let Err(e) = std::fs::create_dir_all(w_path) {
            return Err(format!(
                "Workspace root directory does not exist and could not be created: {}",
                e
            ));
        }
    } else if !w_path.is_dir() {
        return Err("Workspace root path is not a directory".to_string());
    }

    if p_path == w_path {
        return Err(
            "Project directory and workspace root directory cannot be identical".to_string(),
        );
    }

    if let (Ok(p_canon), Ok(w_canon)) = (p_path.canonicalize(), w_path.canonicalize()) {
        if p_canon == w_canon {
            return Err(
                "Project directory and workspace root directory cannot resolve to the same path"
                    .to_string(),
            );
        }
        if w_canon.starts_with(&p_canon) {
            return Err(
                "Workspace root directory cannot be inside the project directory".to_string(),
            );
        }
        if p_canon.starts_with(&w_canon) {
            return Err(
                "Project directory cannot be inside the workspace root directory".to_string(),
            );
        }
    }

    Ok(())
}

#[tauri::command]
async fn test_tracker_connection(
    tracker: config::TrackerConfig,
    project_dir: String,
) -> Result<usize, String> {
    let mut settings = config::Settings {
        tracker,
        ..Default::default()
    };

    let p_path = Path::new(&project_dir);
    settings.finalize(p_path);

    settings
        .validate()
        .map_err(|e| format!("Validation error: {}", e))?;

    let issues = tracker::fetch_candidate_issues(&settings)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    Ok(issues.len())
}

#[tauri::command]
fn verify_agent_command(command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }
    let first_word = command.split_whitespace().next().unwrap_or("");

    let mut found = false;
    if let Ok(path_env) = std::env::var("PATH") {
        for path_dir in std::env::split_paths(&path_env) {
            let exe_path = path_dir.join(first_word);
            if exe_path.is_file() {
                found = true;
                break;
            }
        }
    }

    if !found {
        return Err(format!(
            "Executable '{}' not found in system PATH",
            first_word
        ));
    }

    Ok(())
}

#[tauri::command]
fn verify_prompt_template(template: String) -> Result<(), String> {
    let mut jinja_env = minijinja::Environment::new();
    jinja_env
        .add_template("prompt", &template)
        .map_err(|e| format!("Template syntax error: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Locate WORKFLOW.md in CWD, with fallback to src-tauri/WORKFLOW.md
            let current_dir = std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            // Check if current directory is inside src-tauri (common in tauri dev workflows)
            let mut workflow_path = if current_dir.ends_with("src-tauri") {
                if let Some(parent) = current_dir.parent() {
                    let root_path = parent.join("WORKFLOW.md");
                    if root_path.exists() {
                        root_path
                    } else {
                        current_dir.join("WORKFLOW.md")
                    }
                } else {
                    current_dir.join("WORKFLOW.md")
                }
            } else {
                current_dir.join("WORKFLOW.md")
            };

            if !workflow_path.exists() {
                let mut fallback_path = current_dir.clone();
                fallback_path.push("src-tauri");
                fallback_path.push("WORKFLOW.md");
                if fallback_path.exists() {
                    workflow_path = fallback_path;
                }
            }

            println!("[Setup] Initializing Skrvm from {:?}", workflow_path);

            let mut workflow_store = workflow::WorkflowStore::new(workflow_path);

            // Perform initial load
            if let Err(e) = workflow_store.force_reload() {
                eprintln!("[Setup] Warning: Initial workflow load failed: {}. App will fallback to default settings.", e);
            }

            let orchestrator = Arc::new(Orchestrator::new(workflow_store));

            // Spawn background polling task
            let orch = orchestrator.clone();
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                // 1. Run startup workspace cleanup
                orch.run_startup_cleanup().await;

                // 2. Continuous scheduler loop
                loop {
                    let interval = {
                        let state_guard = orch.state.read().ok();
                        state_guard.map(|g| g.poll_interval_ms).unwrap_or(30000)
                    };

                    if let Err(e) = orch.tick(&handle).await {
                        eprintln!("[Orchestrator Loop] Tick error: {}", e);
                    }

                    tokio::time::sleep(tokio::time::Duration::from_millis(interval)).await;
                }
            });

            // Register state
            app.manage(AppState { orchestrator });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_orchestrator_state,
            reload_workflow,
            unblock_issue,
            save_workflow,
            get_current_workflow,
            get_session_histories,
            get_session_transcript,
            detect_local_git_info,
            orchestrator::get_sdd_state,
            orchestrator::save_sdd_state,
            orchestrator::trigger_sdd_step,
            verify_workspace_setup,
            test_tracker_connection,
            verify_agent_command,
            verify_prompt_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
