mod agent_runner;
mod config;
mod orchestrator;
mod path_safety;
mod tracker;
mod workflow;

use orchestrator::Orchestrator;
use std::path::PathBuf;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Locate WORKFLOW.md in CWD, with fallback to src-tauri/WORKFLOW.md
            let mut workflow_path = std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            workflow_path.push("WORKFLOW.md");

            if !workflow_path.exists() {
                let mut fallback_path = std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."));
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
            unblock_issue
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
