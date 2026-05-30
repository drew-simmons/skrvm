use crate::config::Settings;
use crate::tracker::Issue;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::timeout;

/// Represents an event emitted by the agent runner during execution
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentUpdate {
    pub issue_id: String,
    pub event: String,
    pub timestamp: String,
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub turn_count: usize,
    pub message: Option<String>,
    pub token_delta: Option<TokenDelta>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenDelta {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// Executes before/after shell hooks inside the workspace directory
pub async fn run_hook(script: &str, cwd: &Path, timeout_ms: u64) -> Result<(), String> {
    let script = script.to_string();
    let cwd = cwd.to_path_buf();

    let fut = async move {
        let mut child = Command::new("bash")
            .args(["-lc", &script])
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn hook shell: {}", e))?;

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Failed to wait for hook shell: {}", e))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Hook script exited with non-zero status: {:?}",
                status.code()
            ))
        }
    };

    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(res) => res,
        Err(_) => Err(format!("Hook script timed out after {}ms", timeout_ms)),
    }
}

/// Main entry point to run a single Codex/Kiro agent session for an issue inside its workspace
pub async fn run_agent(
    issue: Issue,
    workspace: PathBuf,
    settings: Settings,
    prompt_template: String,
    attempt: usize,
    tx: mpsc::Sender<AgentUpdate>,
) -> Result<(), String> {
    let issue_id = issue.id.clone();

    // 1. Run before_run hook if present
    if let Some(ref hook) = settings.hooks.before_run {
        println!(
            "[Runner] Running before_run hook for issue {}",
            issue.identifier
        );
        tx.send(AgentUpdate {
            issue_id: issue_id.clone(),
            event: "preparing_workspace".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            pid: None,
            session_id: None,
            thread_id: None,
            turn_id: None,
            turn_count: 0,
            message: Some("Running before_run workspace hook".to_string()),
            token_delta: None,
        })
        .await
        .ok();

        if let Err(e) = run_hook(hook, &workspace, settings.hooks.timeout_ms).await {
            return Err(format!("before_run hook failed: {}", e));
        }
    }

    // 2. Build template prompt
    let mut jinja_env = minijinja::Environment::new();
    jinja_env
        .add_template("prompt", &prompt_template)
        .map_err(|e| format!("Jinja template error: {}", e))?;

    let template = jinja_env
        .get_template("prompt")
        .map_err(|e| format!("Failed to load template: {}", e))?;

    let prompt = template
        .render(json!({
            "issue": issue,
            "attempt": attempt,
        }))
        .map_err(|e| format!("Failed to render prompt: {}", e))?;

    // 3. Launch the subprocess
    tx.send(AgentUpdate {
        issue_id: issue_id.clone(),
        event: "launching_agent_process".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        pid: None,
        session_id: None,
        thread_id: None,
        turn_id: None,
        turn_count: 0,
        message: Some("Launching app-server subprocess".to_string()),
        token_delta: None,
    })
    .await
    .ok();

    let mut child = Command::new("bash")
        .args(["-lc", &settings.codex.command])
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start agent command: {}", e))?;

    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or("Failed to capture child stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture child stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    // 4. Perform JSON-RPC handshake
    // 4a. Initialize
    let init_req = json!({
        "method": "initialize",
        "id": 1,
        "params": {
            "capabilities": {
                "experimentalApi": true
            },
            "clientInfo": {
                "name": "skrvm-orchestrator",
                "title": "Skrvm Orchestrator",
                "version": "0.1.0"
            }
        }
    });

    write_json_rpc(&mut stdin, &init_req).await?;

    // Await response 1
    let init_res_line = reader
        .next_line()
        .await
        .map_err(|e| format!("Handshake read failed: {}", e))?
        .ok_or("App-server exited during initialization")?;
    let init_res: serde_json::Value = serde_json::from_str(&init_res_line)
        .map_err(|e| format!("Malformed initialize response: {}", e))?;

    if init_res["error"].is_object() {
        return Err(format!("Initialize error: {}", init_res["error"]));
    }

    // Send initialized
    let initialized_notify = json!({
        "method": "initialized",
        "params": {}
    });
    write_json_rpc(&mut stdin, &initialized_notify).await?;

    // 4b. Start Thread
    let thread_req = json!({
        "method": "thread/start",
        "id": 2,
        "params": {
            "approvalPolicy": settings.codex.approval_policy,
            "sandbox": settings.codex.thread_sandbox,
            "cwd": workspace.to_string_lossy().to_string(),
            "dynamicTools": [
                {
                    "name": "linear_graphql",
                    "description": "Execute a raw GraphQL query or mutation against Linear using Skrvm's configured auth.",
                    "inputSchema": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["query"],
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "GraphQL query or mutation document to execute against Linear."
                            },
                            "variables": {
                                "type": ["object", "null"],
                                "description": "Optional GraphQL variables object.",
                                "additionalProperties": true
                            }
                        }
                    }
                },
                {
                    "name": "gitlab_api",
                    "description": "Execute a REST API call against GitLab APIs (REST or GraphQL) using Skrvm's configured GitLab auth.",
                    "inputSchema": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["path"],
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method (GET, POST, PUT, DELETE, etc.). Defaults to GET."
                            },
                            "path": {
                                "type": "string",
                                "description": "GitLab API path suffix, e.g. 'projects/123/merge_requests' or 'user'."
                            },
                            "body": {
                                "type": ["object", "null"],
                                "description": "Optional request body object for POST/PUT requests.",
                                "additionalProperties": true
                            }
                        }
                    }
                }
            ]
        }
    });

    write_json_rpc(&mut stdin, &thread_req).await?;

    // Await response 2
    let thread_res_line = reader
        .next_line()
        .await
        .map_err(|e| format!("Thread read failed: {}", e))?
        .ok_or("App-server exited during thread creation")?;
    let thread_res: serde_json::Value = serde_json::from_str(&thread_res_line)
        .map_err(|e| format!("Malformed thread response: {}", e))?;

    let thread_id = thread_res["result"]["thread"]["id"]
        .as_str()
        .ok_or_else(|| format!("Invalid thread start payload: {:?}", thread_res))?
        .to_string();

    // 4c. Start Turn
    let turn_req = json!({
        "method": "turn/start",
        "id": 3,
        "params": {
            "threadId": thread_id,
            "input": [
                {
                    "type": "text",
                    "text": prompt
                }
            ],
            "cwd": workspace.to_string_lossy().to_string(),
            "title": format!("{}: {}", issue.identifier, issue.title),
            "approvalPolicy": settings.codex.approval_policy,
            "sandboxPolicy": settings.codex.turn_sandbox_policy
        }
    });

    write_json_rpc(&mut stdin, &turn_req).await?;

    // Await response 3
    let turn_res_line = reader
        .next_line()
        .await
        .map_err(|e| format!("Turn read failed: {}", e))?
        .ok_or("App-server exited during turn start")?;
    let turn_res: serde_json::Value = serde_json::from_str(&turn_res_line)
        .map_err(|e| format!("Malformed turn response: {}", e))?;

    let turn_id = turn_res["result"]["turn"]["id"]
        .as_str()
        .ok_or_else(|| format!("Invalid turn start payload: {:?}", turn_res))?
        .to_string();

    let session_id = format!("{}-{}", thread_id, turn_id);

    // 5. Broadcast session started
    tx.send(AgentUpdate {
        issue_id: issue_id.clone(),
        event: "session_started".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        pid,
        session_id: Some(session_id.clone()),
        thread_id: Some(thread_id.clone()),
        turn_id: Some(turn_id.clone()),
        turn_count: 1,
        message: Some("App-server handshake successful".to_string()),
        token_delta: None,
    })
    .await
    .ok();

    // 6. Streaming turn reader loop
    let turn_count = 1;
    let turn_timeout = Duration::from_millis(settings.codex.turn_timeout_ms);
    let mut last_activity = std::time::Instant::now();

    loop {
        // Read next line with timeout
        let read_fut = reader.next_line();
        let line_res = match timeout(Duration::from_millis(1000), read_fut).await {
            Ok(Ok(Some(line))) => {
                last_activity = std::time::Instant::now();
                Ok(Some(line))
            }
            Ok(Ok(None)) => Ok(None),
            Ok(Err(e)) => Err(format!("Read stream error: {}", e)),
            Err(_) => {
                // Read timeout (1s) is normal, we check stall timeout and turn timeout
                if last_activity.elapsed() > turn_timeout {
                    return Err("Turn execution timed out".to_string());
                }
                Ok(Some(String::new()))
            }
        };

        let line = match line_res? {
            Some(line) => line,
            None => {
                println!(
                    "[Runner] Stdio stream closed for issue {}",
                    issue.identifier
                );
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // Non-JSON output (stderr/diagnostic)
                continue;
            }
        };

        // Handle JSON-RPC method callbacks from app-server
        if let Some(method) = msg["method"].as_str() {
            match method {
                "turn/completed" => {
                    tx.send(AgentUpdate {
                        issue_id: issue_id.clone(),
                        event: "turn_completed".to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        pid,
                        session_id: Some(session_id.clone()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        turn_count,
                        message: Some("Turn completed successfully".to_string()),
                        token_delta: extract_token_delta(&msg),
                    })
                    .await
                    .ok();
                    break;
                }
                "turn/failed" | "turn/cancelled" => {
                    let err_msg = msg["params"]["error"]["message"]
                        .as_str()
                        .unwrap_or("Unknown failure");
                    tx.send(AgentUpdate {
                        issue_id: issue_id.clone(),
                        event: "turn_failed".to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        pid,
                        session_id: Some(session_id.clone()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        turn_count,
                        message: Some(format!("Turn failed: {}", err_msg)),
                        token_delta: extract_token_delta(&msg),
                    })
                    .await
                    .ok();
                    return Err(format!("Turn failed: {}", err_msg));
                }
                "item/commandExecution/requestApproval" | "execCommandApproval" => {
                    let id = &msg["id"];
                    println!("[Runner] Auto-approving command execution approval request");
                    let decision = if method == "execCommandApproval" {
                        "approved_for_session"
                    } else {
                        "acceptForSession"
                    };
                    let approve_res = json!({
                        "id": id,
                        "result": { "decision": decision }
                    });
                    write_json_rpc(&mut stdin, &approve_res).await?;

                    tx.send(AgentUpdate {
                        issue_id: issue_id.clone(),
                        event: "approval_auto_approved".to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        pid,
                        session_id: Some(session_id.clone()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        turn_count,
                        message: Some(format!(
                            "Auto-approved command execution: {}",
                            msg["params"]["command"].as_str().unwrap_or("")
                        )),
                        token_delta: None,
                    })
                    .await
                    .ok();
                }
                "item/fileChange/requestApproval" | "applyPatchApproval" => {
                    let id = &msg["id"];
                    println!("[Runner] Auto-approving patch/file change approval request");
                    let decision = if method == "applyPatchApproval" {
                        "approved_for_session"
                    } else {
                        "acceptForSession"
                    };
                    let approve_res = json!({
                        "id": id,
                        "result": { "decision": decision }
                    });
                    write_json_rpc(&mut stdin, &approve_res).await?;

                    tx.send(AgentUpdate {
                        issue_id: issue_id.clone(),
                        event: "approval_auto_approved".to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        pid,
                        session_id: Some(session_id.clone()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        turn_count,
                        message: Some("Auto-approved file patch/change".to_string()),
                        token_delta: None,
                    })
                    .await
                    .ok();
                }
                "item/tool/requestUserInput" => {
                    // Stalls turns immediately under high-trust non-interactive configurations
                    tx.send(AgentUpdate {
                        issue_id: issue_id.clone(),
                        event: "turn_input_required".to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        pid,
                        session_id: Some(session_id.clone()),
                        thread_id: Some(thread_id.clone()),
                        turn_id: Some(turn_id.clone()),
                        turn_count,
                        message: Some("Operator manual input required".to_string()),
                        token_delta: None,
                    })
                    .await
                    .ok();

                    // Exit turn loop with input required state
                    return Err("turn_input_required".to_string());
                }
                "item/tool/call" => {
                    let id = &msg["id"];
                    let tool_name = msg["params"]["name"].as_str().unwrap_or("");
                    let arguments = &msg["params"]["arguments"];

                    let result = if tool_name == "linear_graphql" {
                        let query = arguments["query"].as_str().unwrap_or("");
                        let vars = arguments["variables"].clone();

                        match execute_linear_graphql(&settings, query, vars).await {
                            Ok(output) => json!({
                                "success": true,
                                "output": output,
                                "contentItems": [{"type": "inputText", "text": output}]
                            }),
                            Err(e) => json!({
                                "success": false,
                                "output": format!("Linear GraphQL tool error: {}", e),
                                "contentItems": [{"type": "inputText", "text": format!("Error: {}", e)}]
                            }),
                        }
                    } else if tool_name == "gitlab_api" {
                        let method = arguments["method"].as_str().unwrap_or("GET");
                        let path = arguments["path"].as_str().unwrap_or("");
                        let body = arguments["body"].clone();

                        match execute_gitlab_api(method, path, body).await {
                            Ok(output) => json!({
                                "success": true,
                                "output": output,
                                "contentItems": [{"type": "inputText", "text": output}]
                            }),
                            Err(e) => json!({
                                "success": false,
                                "output": format!("GitLab API tool error: {}", e),
                                "contentItems": [{"type": "inputText", "text": format!("Error: {}", e)}]
                            }),
                        }
                    } else {
                        json!({
                            "success": false,
                            "output": format!("Unsupported tool: {}", tool_name),
                            "contentItems": [{"type": "inputText", "text": "Unsupported tool"}]
                        })
                    };

                    let tool_reply = json!({
                        "id": id,
                        "result": result
                    });
                    write_json_rpc(&mut stdin, &tool_reply).await?;
                }
                _ => {}
            }
        }
    }

    // 7. Cleanup active child process cleanly
    let stop_notify = json!({
        "method": "thread/stop",
        "params": {
            "threadId": thread_id
        }
    });
    write_json_rpc(&mut stdin, &stop_notify).await.ok();
    child.kill().await.ok();

    // 8. Run after_run hook if configured
    if let Some(ref hook) = settings.hooks.after_run {
        println!(
            "[Runner] Running after_run hook for issue {}",
            issue.identifier
        );
        run_hook(hook, &workspace, settings.hooks.timeout_ms)
            .await
            .ok();
    }

    Ok(())
}

/// Helper to write line-delimited JSON-RPC message to process stdin
async fn write_json_rpc(
    stdin: &mut tokio::process::ChildStdin,
    value: &serde_json::Value,
) -> Result<(), String> {
    let mut payload =
        serde_json::to_string(value).map_err(|e| format!("Failed to serialize JSON-RPC: {}", e))?;
    payload.push('\n');

    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write JSON-RPC stdio: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush JSON-RPC stdio: {}", e))?;

    Ok(())
}

/// Helper to extract token usage delta from response completed events
fn extract_token_delta(msg: &serde_json::Value) -> Option<TokenDelta> {
    // Attempt to extract from thread/tokenUsage/updated structure if available
    let usage = &msg["params"]["usage"];
    if usage.is_object() {
        let input = usage["input_tokens"]
            .as_i64()
            .or_else(|| usage["input"].as_i64())
            .unwrap_or(0);
        let output = usage["output_tokens"]
            .as_i64()
            .or_else(|| usage["output"].as_i64())
            .unwrap_or(0);
        let total = usage["total_tokens"]
            .as_i64()
            .or_else(|| usage["total"].as_i64())
            .unwrap_or(input + output);
        Some(TokenDelta {
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
        })
    } else {
        None
    }
}

/// Runs standard raw GraphQL queries using Skrvm's internal configured Linear credentials
async fn execute_linear_graphql(
    settings: &Settings,
    query: &str,
    variables: serde_json::Value,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let api_key = settings
        .tracker
        .api_key
        .as_deref()
        .ok_or("Linear API Key is missing")?;

    let payload = json!({
        "query": query,
        "variables": variables
    });

    let res = client
        .post(&settings.tracker.endpoint)
        .header("Authorization", api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Linear request failure: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Linear API request failed with HTTP status: {}",
            res.status()
        ));
    }

    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to decode response body: {}", e))?;

    Ok(text)
}

/// Runs standard GitLab REST API calls using Skrvm's configured GitLab credentials
async fn execute_gitlab_api(
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let gitlab_token = std::env::var("GITLAB_PRIVATE_TOKEN")
        .or_else(|_| std::env::var("GITLAB_TOKEN"))
        .or_else(|_| std::env::var("PRIVATE_TOKEN"))
        .map_err(|_| "GitLab API Token is missing. Export GITLAB_PRIVATE_TOKEN or GITLAB_TOKEN in the environment.".to_string())?;

    let gitlab_endpoint = std::env::var("GITLAB_API_ENDPOINT")
        .unwrap_or_else(|_| "https://gitlab.com/api/v4".to_string());

    let mut clean_path = path.trim();
    if clean_path.starts_with('/') {
        clean_path = &clean_path[1..];
    }

    let url = format!("{}/{}", gitlab_endpoint.trim_end_matches('/'), clean_path);

    let method_type = match method.to_uppercase().as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => reqwest::Method::GET,
    };

    let mut req = client
        .request(method_type, &url)
        .header("PRIVATE-TOKEN", gitlab_token)
        .header("Content-Type", "application/json");

    if body.is_object() {
        req = req.json(&body);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("GitLab API request failure: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "GitLab API request failed with HTTP status: {}",
            res.status()
        ));
    }

    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to decode response body: {}", e))?;

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[tokio::test]
    async fn test_execute_gitlab_api() {
        use tokio::io::AsyncReadExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Spawn mock GitLab server task
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            let req_str = String::from_utf8_lossy(&buf[..n]);
            let req_str_lower = req_str.to_lowercase();

            // Assert headers and path
            assert!(req_str_lower.contains("private-token: mock-test-token"));
            assert!(req_str.contains("POST /api/v4/projects/123/issues HTTP/1.1"));
            assert!(req_str.contains("{\"title\":\"hello\"}"));

            // Respond with HTTP 200
            let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"status\":\"created\"}";
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        // Setup env variables for test
        std::env::set_var("GITLAB_PRIVATE_TOKEN", "mock-test-token");
        std::env::set_var(
            "GITLAB_API_ENDPOINT",
            format!("http://127.0.0.1:{}/api/v4", port),
        );

        let res =
            execute_gitlab_api("POST", "projects/123/issues", json!({"title": "hello"})).await;
        assert!(res.is_ok());
        let body = res.unwrap();
        assert_eq!(body, "{\"status\":\"created\"}");
    }

    #[tokio::test]
    async fn test_run_agent_stdio_handshake() {
        // Create temp workspace directory safely
        let mut workspace = std::env::temp_dir();
        workspace.push(format!(
            "skrvm_agent_test_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::create_dir_all(&workspace).unwrap();

        // Write the mock agent bash script
        let script_path = workspace.join("mock_agent.sh");
        {
            let mut file = File::create(&script_path).unwrap();
            let script_content = r#"#!/bin/bash
read -r line # Read initialize
echo '{"id":1,"result":{"capabilities":{}}}'
read -r line # Read initialized
read -r line # Read thread/start
echo '{"id":2,"result":{"thread":{"id":"test-thread-id"}}}'
read -r line # Read turn/start
echo '{"id":3,"result":{"turn":{"id":"test-turn-id"}}}'
sleep 0.1
echo '{"method":"turn/completed","params":{"usage":{"input_tokens":120,"output_tokens":80}}}'
"#;
            file.write_all(script_content.as_bytes()).unwrap();
        }

        // Make script executable (on unix systems)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms).unwrap();
        }

        // Setup settings with the mock command
        let mut settings = Settings::default();
        settings.codex.command = format!("bash {:?}", script_path);
        settings.workspace.root = workspace.to_string_lossy().to_string();

        let issue = Issue {
            id: "test-issue-123".to_string(),
            identifier: "TEST-101".to_string(),
            title: "Test Issue Title".to_string(),
            description: Some("Test description".to_string()),
            priority: Some(3),
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

        let (tx, mut rx) = mpsc::channel(100);
        let prompt_template =
            "You are a helpful coding assistant. Solve this issue: {{ issue.title }}".to_string();

        let runner_res =
            run_agent(issue, workspace.clone(), settings, prompt_template, 0, tx).await;

        assert!(runner_res.is_ok());

        // Drain channel and verify events
        let mut events = Vec::new();
        while let Some(update) = rx.recv().await {
            events.push(update);
        }

        // Verify events were broadcast correctly
        assert!(events.iter().any(|e| e.event == "session_started"));
        assert!(events.iter().any(|e| e.event == "turn_completed"));

        let final_update = events.iter().find(|e| e.event == "turn_completed").unwrap();
        assert_eq!(final_update.turn_count, 1);
        let delta = final_update.token_delta.as_ref().unwrap();
        assert_eq!(delta.input_tokens, 120);
        assert_eq!(delta.output_tokens, 80);

        // Cleanup
        std::fs::remove_dir_all(&workspace).ok();
    }
}
