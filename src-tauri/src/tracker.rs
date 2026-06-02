use crate::config::Settings;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;

struct MemoryTrackerState {
    dispatched_at: Option<Instant>,
}

static MEMORY_TRACKER: OnceLock<Mutex<MemoryTrackerState>> = OnceLock::new();

fn get_memory_tracker() -> &'static Mutex<MemoryTrackerState> {
    MEMORY_TRACKER.get_or_init(|| {
        Mutex::new(MemoryTrackerState {
            dispatched_at: None,
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockerRef {
    pub id: String,
    pub identifier: String,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub state: String,
    pub branch_name: Option<String>,
    pub url: Option<String>,
    pub assignee_id: Option<String>,
    pub blocked_by: Vec<BlockerRef>,
    pub labels: Vec<String>,
    pub assigned_to_worker: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

// GraphQL Response structures
#[derive(Deserialize)]
struct GraphQLResponse<T> {
    data: Option<T>,
    errors: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ViewerData {
    viewer: Option<ViewerInfo>,
}

#[derive(Deserialize)]
struct ViewerInfo {
    id: String,
}

#[derive(Deserialize)]
struct IssueNode {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    priority: Option<i64>,
    state: Option<StateInfo>,
    #[serde(rename = "branchName")]
    branch_name: Option<String>,
    url: Option<String>,
    assignee: Option<AssigneeInfo>,
    labels: Option<LabelInfo>,
    #[serde(rename = "inverseRelations")]
    inverse_relations: Option<InverseRelationInfo>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct StateInfo {
    name: String,
}

#[derive(Deserialize)]
struct AssigneeInfo {
    id: String,
}

#[derive(Deserialize)]
struct LabelInfo {
    nodes: Vec<LabelNode>,
}

#[derive(Deserialize)]
struct LabelNode {
    name: String,
}

#[derive(Deserialize)]
struct InverseRelationInfo {
    nodes: Vec<InverseRelationNode>,
}

#[derive(Deserialize)]
struct InverseRelationNode {
    #[serde(rename = "type")]
    relation_type: String,
    issue: Option<BlockerIssueNode>,
}

#[derive(Deserialize)]
struct BlockerIssueNode {
    id: String,
    identifier: String,
    state: Option<StateInfo>,
}

#[derive(Deserialize)]
struct IssuesData {
    issues: Option<IssuesConnection>,
}

#[derive(Deserialize)]
struct IssuesConnection {
    nodes: Vec<IssueNode>,
    #[serde(rename = "pageInfo")]
    page_info: Option<PageInfo>,
}

#[derive(Deserialize)]
struct PageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
    #[serde(rename = "endCursor")]
    end_cursor: Option<String>,
}

/// Polls Linear for candidate work based on active states and project filters
pub async fn fetch_candidate_issues(config: &Settings) -> Result<Vec<Issue>, String> {
    if config.tracker.kind == "memory" {
        let tracker = get_memory_tracker();
        let mut guard = tracker.lock().unwrap();

        let now = Instant::now();
        if let Some(dispatched) = guard.dispatched_at {
            if now.duration_since(dispatched).as_secs() > 10 {
                guard.dispatched_at = None;
            }
        }

        if guard.dispatched_at.is_none() {
            guard.dispatched_at = Some(now);
            return Ok(vec![Issue {
                id: "demo-issue-1".to_string(),
                identifier: "DEMO-101".to_string(),
                title: "Implement vintage macOS-style badges in TodoMVC footer".to_string(),
                description: Some("We need to add vintage macOS-styled badges to the Active and Completed filter tabs in the TodoMVC footer to display their respective item counts dynamically. Do not change the behavior of the filters themselves.".to_string()),
                priority: Some(2),
                state: "Todo".to_string(),
                branch_name: Some("feature/demo-badges".to_string()),
                url: Some("https://github.com/drew-simmons/skrvm/issues/101".to_string()),
                assignee_id: Some("me".to_string()),
                blocked_by: vec![],
                labels: vec!["enhancement".to_string()],
                assigned_to_worker: true,
                created_at: Some("2026-05-30T09:00:00Z".to_string()),
                updated_at: Some("2026-05-30T09:00:00Z".to_string()),
            }]);
        } else {
            return Ok(Vec::new());
        }
    }

    if config.tracker.kind == "jira" {
        return fetch_candidate_issues_jira(config).await;
    }

    if config.tracker.kind == "github" {
        return fetch_candidate_issues_github(config).await;
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Linear API Key is missing")?;

    // Resolve assignee filter if "me" is used
    let assignee_id_filter = resolve_assignee_filter(&client, config).await?;

    let mut all_issues = Vec::new();
    let mut after_cursor: Option<String> = None;
    let query = r#"
        query SkrvmLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
            issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
                nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    state {
                        name
                    }
                    branchName
                    url
                    assignee {
                        id
                    }
                    labels {
                        nodes {
                            name
                        }
                    }
                    inverseRelations(first: $relationFirst) {
                        nodes {
                            type
                            issue {
                                id
                                identifier
                                state {
                                    name
                                }
                            }
                        }
                    }
                    createdAt
                    updatedAt
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    "#;

    loop {
        let variables = serde_json::json!({
            "projectSlug": config.tracker.project_slug,
            "stateNames": config.tracker.active_states,
            "first": 50,
            "relationFirst": 50,
            "after": after_cursor
        });

        let body = serde_json::json!({
            "query": query,
            "variables": variables
        });

        let res = client
            .post(&config.tracker.endpoint)
            .header("Authorization", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Network request failed: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "Linear API request failed with status: {}",
                res.status()
            ));
        }

        let resp_data: GraphQLResponse<IssuesData> = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(errs) = resp_data.errors {
            return Err(format!("Linear GraphQL error: {}", errs));
        }

        let issues_conn = resp_data
            .data
            .and_then(|d| d.issues)
            .ok_or("Invalid response payload: missing issues connection")?;

        for node in issues_conn.nodes {
            if let Some(issue) = normalize_issue(node, assignee_id_filter.as_deref()) {
                all_issues.push(issue);
            }
        }

        if let Some(page_info) = issues_conn.page_info {
            if page_info.has_next_page && page_info.end_cursor.is_some() {
                after_cursor = page_info.end_cursor;
                continue;
            }
        }

        break;
    }

    Ok(all_issues)
}

/// Refreshes state for specific issue IDs
pub async fn fetch_issue_states_by_ids(
    config: &Settings,
    ids: &[String],
) -> Result<Vec<Issue>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    if config.tracker.kind == "memory" {
        let tracker = get_memory_tracker();
        let guard = tracker.lock().unwrap();

        let mut result = Vec::new();
        for id in ids {
            if id == "demo-issue-1" {
                let state = if let Some(dispatched) = guard.dispatched_at {
                    let elapsed = Instant::now().duration_since(dispatched).as_secs();
                    if elapsed >= 4 {
                        "Done".to_string()
                    } else {
                        "Todo".to_string()
                    }
                } else {
                    "Todo".to_string()
                };

                result.push(Issue {
                    id: "demo-issue-1".to_string(),
                    identifier: "DEMO-101".to_string(),
                    title: "Implement vintage macOS-style badges in TodoMVC footer".to_string(),
                    description: Some("We need to add vintage macOS-styled badges to the Active and Completed filter tabs in the TodoMVC footer to display their respective item counts dynamically. Do not change the behavior of the filters themselves.".to_string()),
                    priority: Some(2),
                    state,
                    branch_name: Some("feature/demo-badges".to_string()),
                    url: Some("https://github.com/drew-simmons/skrvm/issues/101".to_string()),
                    assignee_id: Some("me".to_string()),
                    blocked_by: vec![],
                    labels: vec!["enhancement".to_string()],
                    assigned_to_worker: true,
                    created_at: Some("2026-05-30T09:00:00Z".to_string()),
                    updated_at: Some("2026-05-30T09:00:00Z".to_string()),
                });
            }
        }
        return Ok(result);
    }

    if config.tracker.kind == "jira" {
        return fetch_issue_states_by_ids_jira(config, ids).await;
    }

    if config.tracker.kind == "github" {
        return fetch_issue_states_by_ids_github(config, ids).await;
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Linear API Key is missing")?;
    let assignee_id_filter = resolve_assignee_filter(&client, config).await?;

    let query = r#"
        query SkrvmLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
            issues(filter: {id: {in: $ids}}, first: $first) {
                nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    state {
                        name
                    }
                    branchName
                    url
                    assignee {
                        id
                    }
                    labels {
                        nodes {
                            name
                        }
                    }
                    inverseRelations(first: $relationFirst) {
                        nodes {
                            type
                            issue {
                                id
                                identifier
                                state {
                                    name
                                }
                            }
                        }
                    }
                    createdAt
                    updatedAt
                }
            }
        }
    "#;

    let variables = serde_json::json!({
        "ids": ids,
        "first": ids.len(),
        "relationFirst": 50
    });

    let body = serde_json::json!({
        "query": query,
        "variables": variables
    });

    let res = client
        .post(&config.tracker.endpoint)
        .header("Authorization", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Linear API request failed with status: {}",
            res.status()
        ));
    }

    let resp_data: GraphQLResponse<IssuesData> = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(errs) = resp_data.errors {
        return Err(format!("Linear GraphQL error: {}", errs));
    }

    let mut result = Vec::new();
    if let Some(data) = resp_data.data {
        if let Some(conn) = data.issues {
            for node in conn.nodes {
                if let Some(issue) = normalize_issue(node, assignee_id_filter.as_deref()) {
                    result.push(issue);
                }
            }
        }
    }

    // Retain input sorting order best-effort
    result.sort_by(|a, b| {
        let idx_a = ids.iter().position(|x| x == &a.id).unwrap_or(usize::MAX);
        let idx_b = ids.iter().position(|x| x == &b.id).unwrap_or(usize::MAX);
        idx_a.cmp(&idx_b)
    });

    Ok(result)
}

/// Fetches issues by states (used during startup workspace cleanups)
pub async fn fetch_issues_by_states(
    config: &Settings,
    state_names: &[String],
) -> Result<Vec<Issue>, String> {
    if state_names.is_empty() {
        return Ok(Vec::new());
    }

    if config.tracker.kind == "memory" {
        return Ok(Vec::new());
    }

    if config.tracker.kind == "jira" {
        return fetch_issues_by_states_jira(config, state_names).await;
    }

    if config.tracker.kind == "github" {
        return fetch_issues_by_states_github(config, state_names).await;
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Linear API Key is missing")?;
    let assignee_id_filter = resolve_assignee_filter(&client, config).await?;

    let mut all_issues = Vec::new();
    let mut after_cursor: Option<String> = None;
    let query = r#"
        query SkrvmLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
            issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
                nodes {
                    id
                    identifier
                    title
                    description
                    priority
                    state {
                        name
                    }
                    branchName
                    url
                    assignee {
                        id
                    }
                    labels {
                        nodes {
                            name
                        }
                    }
                    inverseRelations(first: $relationFirst) {
                        nodes {
                            type
                            issue {
                                id
                                identifier
                                state {
                                    name
                                }
                            }
                        }
                    }
                    createdAt
                    updatedAt
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    "#;

    loop {
        let variables = serde_json::json!({
            "projectSlug": config.tracker.project_slug,
            "stateNames": state_names,
            "first": 50,
            "relationFirst": 50,
            "after": after_cursor
        });

        let body = serde_json::json!({
            "query": query,
            "variables": variables
        });

        let res = client
            .post(&config.tracker.endpoint)
            .header("Authorization", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Network request failed: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "Linear API request failed with status: {}",
                res.status()
            ));
        }

        let resp_data: GraphQLResponse<IssuesData> = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(errs) = resp_data.errors {
            return Err(format!("Linear GraphQL error: {}", errs));
        }

        let issues_conn = resp_data
            .data
            .and_then(|d| d.issues)
            .ok_or("Invalid response payload: missing issues connection")?;

        for node in issues_conn.nodes {
            if let Some(issue) = normalize_issue(node, assignee_id_filter.as_deref()) {
                all_issues.push(issue);
            }
        }

        if let Some(page_info) = issues_conn.page_info {
            if page_info.has_next_page && page_info.end_cursor.is_some() {
                after_cursor = page_info.end_cursor;
                continue;
            }
        }

        break;
    }

    Ok(all_issues)
}

/// Resolves assignee filter using "viewer" ID if `me` is specified
async fn resolve_assignee_filter(
    client: &reqwest::Client,
    config: &Settings,
) -> Result<Option<String>, String> {
    match config.tracker.assignee.as_deref() {
        Some("me") => {
            let api_key = config
                .tracker
                .api_key
                .as_deref()
                .ok_or("Linear API Key is missing")?;
            let body = serde_json::json!({
                "query": "query SkrvmLinearViewer { viewer { id } }"
            });

            let res = client
                .post(&config.tracker.endpoint)
                .header("Authorization", api_key)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Failed to query viewer: {}", e))?;

            let data: GraphQLResponse<ViewerData> = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse viewer response: {}", e))?;

            if let Some(errs) = data.errors {
                return Err(format!("Linear GraphQL Viewer error: {}", errs));
            }

            let viewer_id = data
                .data
                .and_then(|d| d.viewer)
                .map(|v| v.id)
                .ok_or("Could not resolve viewer identity")?;

            Ok(Some(viewer_id))
        }
        Some(assignee) if !assignee.trim().is_empty() => Ok(Some(assignee.to_string())),
        _ => Ok(None),
    }
}

/// Normalizes raw GraphQL payload into stable internal Issue representation
fn normalize_issue(node: IssueNode, assignee_filter: Option<&str>) -> Option<Issue> {
    let state_name = node
        .state
        .map(|s| s.name)
        .unwrap_or_else(|| "Todo".to_string());
    let assignee_id = node.assignee.map(|a| a.id);

    let assigned_to_worker = match (assignee_filter, assignee_id.as_deref()) {
        (Some(filter), Some(id)) => filter == id,
        (Some(_), None) => false,
        _ => true,
    };

    let labels = node
        .labels
        .map(|l| l.nodes.into_iter().map(|n| n.name.to_lowercase()).collect())
        .unwrap_or_default();

    let mut blocked_by = Vec::new();
    if let Some(relations) = node.inverse_relations {
        for node in relations.nodes {
            if node.relation_type.trim().to_lowercase() == "blocks" {
                if let Some(issue) = node.issue {
                    blocked_by.push(BlockerRef {
                        id: issue.id,
                        identifier: issue.identifier,
                        state: issue.state.map(|s| s.name),
                    });
                }
            }
        }
    }

    let branch_name = node.branch_name.unwrap_or_else(|| {
        let branch_slug = slugify(&node.title);
        if branch_slug.is_empty() {
            format!("feature/issue-{}", node.identifier.to_lowercase())
        } else {
            format!(
                "feature/issue-{}-{}",
                node.identifier.to_lowercase(),
                branch_slug
            )
        }
    });

    Some(Issue {
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        description: node.description,
        priority: node.priority,
        state: state_name,
        branch_name: Some(branch_name),
        url: node.url,
        assignee_id,
        blocked_by,
        labels,
        assigned_to_worker,
        created_at: node.created_at,
        updated_at: node.updated_at,
    })
}

// ==========================================
// Jira Integration Support
// ==========================================

fn base64_encode(input: &str) -> String {
    use base64::prelude::*;
    BASE64_STANDARD.encode(input.as_bytes())
}

fn get_jira_auth_header(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.starts_with("Basic ") || trimmed.starts_with("Bearer ") {
        trimmed.to_string()
    } else if trimmed.contains(':') {
        let encoded = base64_encode(trimmed);
        format!("Basic {}", encoded)
    } else {
        format!("Bearer {}", trimmed)
    }
}

fn map_jira_priority(name: &str) -> i64 {
    match name.to_lowercase().as_str() {
        "highest" | "critical" => 1,
        "high" | "major" => 2,
        "medium" | "normal" => 3,
        "low" | "minor" => 4,
        "lowest" => 4,
        _ => 3,
    }
}

#[derive(Deserialize, Debug)]
struct JiraSearchResponse {
    #[serde(rename = "startAt")]
    _start_at: usize,
    #[serde(rename = "maxResults")]
    _max_results: usize,
    total: usize,
    issues: Vec<JiraIssueNode>,
}

#[derive(Deserialize, Debug)]
struct JiraIssueNode {
    id: String,
    key: String,
    fields: JiraIssueFields,
}

#[derive(Deserialize, Debug)]
struct JiraIssueFields {
    summary: String,
    description: Option<String>,
    priority: Option<JiraPriority>,
    status: JiraStatus,
    assignee: Option<JiraAssignee>,
    labels: Option<Vec<String>>,
    created: Option<String>,
    updated: Option<String>,
    issuelinks: Option<Vec<JiraIssueLink>>,
}

#[derive(Deserialize, Debug)]
struct JiraPriority {
    name: String,
}

#[derive(Deserialize, Debug)]
struct JiraStatus {
    name: String,
}

#[derive(Deserialize, Debug)]
struct JiraAssignee {
    #[serde(alias = "accountId", alias = "name")]
    id: String,
}

#[derive(Deserialize, Debug)]
struct JiraIssueLink {
    #[serde(rename = "type")]
    link_type: JiraLinkType,
    #[serde(rename = "inwardIssue")]
    inward_issue: Option<JiraSubIssue>,
    #[serde(rename = "outwardIssue")]
    _outward_issue: Option<JiraSubIssue>,
}

#[derive(Deserialize, Debug)]
struct JiraLinkType {
    name: String,
}

#[derive(Deserialize, Debug)]
struct JiraSubIssue {
    id: String,
    key: String,
    fields: JiraSubIssueFields,
}

#[derive(Deserialize, Debug)]
struct JiraSubIssueFields {
    status: JiraStatus,
}

fn normalize_jira_issue(node: JiraIssueNode, assignee_filter: Option<&str>) -> Issue {
    let state_name = node.fields.status.name.clone();
    let assignee_id = node.fields.assignee.as_ref().map(|a| a.id.clone());

    let assigned_to_worker = match (assignee_filter, assignee_id.as_deref()) {
        (Some(filter), Some(id)) => filter == id,
        (Some(_), None) => false,
        _ => true,
    };

    let labels = node
        .fields
        .labels
        .unwrap_or_default()
        .into_iter()
        .map(|l| l.to_lowercase())
        .collect();

    let mut blocked_by = Vec::new();
    if let Some(links) = node.fields.issuelinks {
        for link in links {
            let link_type_lower = link.link_type.name.to_lowercase();
            if link_type_lower.contains("block") || link_type_lower.contains("depend") {
                if let Some(sub) = link.inward_issue {
                    blocked_by.push(BlockerRef {
                        id: sub.id,
                        identifier: sub.key,
                        state: Some(sub.fields.status.name),
                    });
                }
            }
        }
    }

    let branch_slug = slugify(&node.fields.summary);
    let branch_name = if branch_slug.is_empty() {
        format!("feature/issue-{}", node.key.to_lowercase())
    } else {
        format!("feature/issue-{}-{}", node.key.to_lowercase(), branch_slug)
    };

    // construct raw link URL best effort
    let jira_url = Some(format!("{}/browse/{}", node.key, node.key));

    Issue {
        id: node.id,
        identifier: node.key,
        title: node.fields.summary,
        description: node.fields.description,
        priority: node.fields.priority.map(|p| map_jira_priority(&p.name)),
        state: state_name,
        branch_name: Some(branch_name),
        url: jira_url,
        assignee_id,
        blocked_by,
        labels,
        assigned_to_worker,
        created_at: node.fields.created,
        updated_at: node.fields.updated,
    }
}

async fn fetch_candidate_issues_jira(config: &Settings) -> Result<Vec<Issue>, String> {
    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Jira API Key is missing")?;

    let auth_header = get_jira_auth_header(api_key);

    let mut jql = format!("project = '{}'", config.tracker.project_slug);

    if !config.tracker.active_states.is_empty() {
        let escaped_states: Vec<String> = config
            .tracker
            .active_states
            .iter()
            .map(|s| format!("'{}'", s.replace('\'', "\\'")))
            .collect();
        jql.push_str(&format!(" AND status in ({})", escaped_states.join(", ")));
    }

    match config.tracker.assignee.as_deref() {
        Some("me") => {
            jql.push_str(" AND assignee = currentUser()");
        }
        Some(assignee) if !assignee.trim().is_empty() => {
            jql.push_str(&format!(
                " AND assignee = '{}'",
                assignee.replace('\'', "\\'")
            ));
        }
        _ => {}
    }

    jql.push_str(" ORDER BY created ASC");

    // Endpoint normalization
    let mut search_url = config.tracker.endpoint.clone();
    if !search_url.contains("/rest/api/") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("rest/api/2/search");
    } else if !search_url.ends_with("/search") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("search");
    }

    let mut all_issues = Vec::new();
    let mut start_at = 0;
    let max_results = 50;

    loop {
        let body = serde_json::json!({
            "jql": jql,
            "startAt": start_at,
            "maxResults": max_results,
            "fields": vec!["summary", "description", "priority", "status", "assignee", "labels", "created", "updated", "issuelinks"]
        });

        let res = client
            .post(&search_url)
            .header("Authorization", &auth_header)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Jira request failed: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "Jira search API failed with status: {}",
                res.status()
            ));
        }

        let resp: JiraSearchResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse Jira response: {}", e))?;

        let count = resp.issues.len();
        for node in resp.issues {
            let normalized = normalize_jira_issue(node, config.tracker.assignee.as_deref());
            all_issues.push(normalized);
        }

        if start_at + count >= resp.total || count == 0 {
            break;
        }
        start_at += count;
    }

    Ok(all_issues)
}

async fn fetch_issue_states_by_ids_jira(
    config: &Settings,
    ids: &[String],
) -> Result<Vec<Issue>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Jira API Key is missing")?;

    let auth_header = get_jira_auth_header(api_key);

    let escaped_ids: Vec<String> = ids
        .iter()
        .map(|id| format!("'{}'", id.replace('\'', "\\'")))
        .collect();
    let jql = format!("id in ({})", escaped_ids.join(", "));

    let mut search_url = config.tracker.endpoint.clone();
    if !search_url.contains("/rest/api/") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("rest/api/2/search");
    } else if !search_url.ends_with("/search") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("search");
    }

    let body = serde_json::json!({
        "jql": jql,
        "startAt": 0,
        "maxResults": ids.len(),
        "fields": vec!["summary", "description", "priority", "status", "assignee", "labels", "created", "updated", "issuelinks"]
    });

    let res = client
        .post(&search_url)
        .header("Authorization", &auth_header)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Jira request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!(
            "Jira search API failed with status: {}",
            res.status()
        ));
    }

    let resp: JiraSearchResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira response: {}", e))?;

    let mut result = Vec::new();
    for node in resp.issues {
        let normalized = normalize_jira_issue(node, config.tracker.assignee.as_deref());
        result.push(normalized);
    }

    // Sort to match order of input ids best-effort
    result.sort_by(|a, b| {
        let idx_a = ids.iter().position(|x| x == &a.id).unwrap_or(usize::MAX);
        let idx_b = ids.iter().position(|x| x == &b.id).unwrap_or(usize::MAX);
        idx_a.cmp(&idx_b)
    });

    Ok(result)
}

async fn fetch_issues_by_states_jira(
    config: &Settings,
    state_names: &[String],
) -> Result<Vec<Issue>, String> {
    if state_names.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("Jira API Key is missing")?;

    let auth_header = get_jira_auth_header(api_key);

    let mut jql = format!("project = '{}'", config.tracker.project_slug);

    let escaped_states: Vec<String> = state_names
        .iter()
        .map(|s| format!("'{}'", s.replace('\'', "\\'")))
        .collect();
    jql.push_str(&format!(" AND status in ({})", escaped_states.join(", ")));

    jql.push_str(" ORDER BY created ASC");

    let mut search_url = config.tracker.endpoint.clone();
    if !search_url.contains("/rest/api/") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("rest/api/2/search");
    } else if !search_url.ends_with("/search") {
        if !search_url.ends_with('/') {
            search_url.push('/');
        }
        search_url.push_str("search");
    }

    let mut all_issues = Vec::new();
    let mut start_at = 0;
    let max_results = 50;

    loop {
        let body = serde_json::json!({
            "jql": jql,
            "startAt": start_at,
            "maxResults": max_results,
            "fields": vec!["summary", "description", "priority", "status", "assignee", "labels", "created", "updated", "issuelinks"]
        });

        let res = client
            .post(&search_url)
            .header("Authorization", &auth_header)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Jira request failed: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "Jira search API failed with status: {}",
                res.status()
            ));
        }

        let resp: JiraSearchResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse Jira response: {}", e))?;

        let count = resp.issues.len();
        for node in resp.issues {
            let normalized = normalize_jira_issue(node, config.tracker.assignee.as_deref());
            all_issues.push(normalized);
        }

        if start_at + count >= resp.total || count == 0 {
            break;
        }
        start_at += count;
    }

    Ok(all_issues)
}

// ==========================================
// GitHub Issues Integration Support
// ==========================================

#[derive(Deserialize, Debug)]
struct GitHubIssue {
    number: i64,
    title: String,
    body: Option<String>,
    state: String,
    html_url: String,
    assignee: Option<GitHubUser>,
    labels: Option<Vec<GitHubLabel>>,
    created_at: String,
    updated_at: String,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
struct GitHubUser {
    login: String,
}

#[derive(Deserialize, Debug)]
struct GitHubLabel {
    name: String,
}

fn normalize_github_issue(node: GitHubIssue, config: &Settings) -> Issue {
    let mut resolved_state = None;

    let labels: Vec<String> = node
        .labels
        .unwrap_or_default()
        .into_iter()
        .map(|l| l.name)
        .collect();

    // GitHub's closed state is authoritative. Labels can be stale after merge.
    if node.state.to_lowercase() == "closed" {
        resolved_state = config.tracker.terminal_states.first().cloned();
    } else {
        for label in &labels {
            if config
                .tracker
                .terminal_states
                .iter()
                .any(|s| s.to_lowercase() == label.to_lowercase())
            {
                resolved_state = config
                    .tracker
                    .terminal_states
                    .iter()
                    .find(|s| s.to_lowercase() == label.to_lowercase())
                    .cloned();
                break;
            }
        }
    }

    // Then check active labels for still-open issues.
    if resolved_state.is_none() {
        for label in &labels {
            if config
                .tracker
                .active_states
                .iter()
                .any(|s| s.to_lowercase() == label.to_lowercase())
            {
                resolved_state = config
                    .tracker
                    .active_states
                    .iter()
                    .find(|s| s.to_lowercase() == label.to_lowercase())
                    .cloned();
                break;
            }
        }
    }

    // Default based on GitHub's native open/closed state
    let state = resolved_state.unwrap_or_else(|| {
        if node.state.to_lowercase() == "closed" {
            config
                .tracker
                .terminal_states
                .first()
                .cloned()
                .unwrap_or_else(|| "Done".to_string())
        } else {
            config
                .tracker
                .active_states
                .first()
                .cloned()
                .unwrap_or_else(|| "Todo".to_string())
        }
    });

    let assignee_id = node.assignee.map(|a| a.login);
    let assigned_to_worker = match (config.tracker.assignee.as_deref(), assignee_id.as_deref()) {
        (Some(filter), Some(id)) => filter.to_lowercase() == id.to_lowercase(),
        (Some(_), None) => false,
        _ => true,
    };

    let branch_slug = slugify(&node.title);
    let branch_name = if branch_slug.is_empty() {
        format!("feature/issue-{}", node.number)
    } else {
        format!("feature/issue-{}-{}", node.number, branch_slug)
    };

    Issue {
        id: node.number.to_string(),
        identifier: node.number.to_string(),
        title: node.title,
        description: node.body,
        priority: None,
        state,
        branch_name: Some(branch_name),
        url: Some(node.html_url),
        assignee_id,
        blocked_by: vec![],
        labels,
        assigned_to_worker,
        created_at: Some(node.created_at),
        updated_at: Some(node.updated_at),
    }
}

async fn fetch_candidate_issues_github(config: &Settings) -> Result<Vec<Issue>, String> {
    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("GitHub API token is missing")?;

    let mut all_issues = Vec::new();
    let mut page = 1;

    loop {
        let url = format!(
            "{}/repos/{}/issues?state=all&per_page=50&page={}",
            config.tracker.endpoint, config.tracker.project_slug, page
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", "skrvm")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub API request failed: {}", e))?;

        if !res.status().is_success() {
            return Err(format!(
                "GitHub Issues API failed with status: {}",
                res.status()
            ));
        }

        let nodes: Vec<GitHubIssue> = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

        let count = nodes.len();
        if count == 0 {
            break;
        }

        for node in nodes {
            if node.pull_request.is_some() {
                continue; // Ignore pull requests
            }
            let normalized = normalize_github_issue(node, config);
            if config
                .tracker
                .active_states
                .iter()
                .any(|s| s.to_lowercase() == normalized.state.to_lowercase())
            {
                all_issues.push(normalized);
            }
        }

        page += 1;
    }

    Ok(all_issues)
}

async fn fetch_issue_states_by_ids_github(
    config: &Settings,
    ids: &[String],
) -> Result<Vec<Issue>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let api_key = config
        .tracker
        .api_key
        .as_deref()
        .ok_or("GitHub API token is missing")?;

    let mut result = Vec::new();
    for id in ids {
        let url = format!(
            "{}/repos/{}/issues/{}",
            config.tracker.endpoint, config.tracker.project_slug, id
        );

        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", "skrvm")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("GitHub request failed for issue {}: {}", id, e))?;

        if res.status().is_success() {
            let node: GitHubIssue = res
                .json()
                .await
                .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;
            if node.pull_request.is_none() {
                result.push(normalize_github_issue(node, config));
            }
        }
    }

    // Sort to match order of input ids best-effort
    result.sort_by(|a, b| {
        let idx_a = ids.iter().position(|x| x == &a.id).unwrap_or(usize::MAX);
        let idx_b = ids.iter().position(|x| x == &b.id).unwrap_or(usize::MAX);
        idx_a.cmp(&idx_b)
    });

    Ok(result)
}

async fn fetch_issues_by_states_github(
    config: &Settings,
    state_names: &[String],
) -> Result<Vec<Issue>, String> {
    if state_names.is_empty() {
        return Ok(Vec::new());
    }

    let all = fetch_candidate_issues_github(config).await?;
    let filtered: Vec<Issue> = all
        .into_iter()
        .filter(|issue| {
            state_names
                .iter()
                .any(|s| s.to_lowercase() == issue.state.to_lowercase())
        })
        .collect();

    Ok(filtered)
}

fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let mut trimmed = slug.trim_matches('-').to_string();
    trimmed.truncate(50);
    trimmed.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_jira_issue() {
        let raw_json = r#"{
            "id": "10001",
            "key": "PROJ-123",
            "fields": {
                "summary": "Fix some bugs",
                "description": "We need to fix several key bugs",
                "priority": {
                    "name": "High"
                },
                "status": {
                    "name": "Todo"
                },
                "assignee": {
                    "id": "user-456"
                },
                "labels": ["bug", "frontend"],
                "created": "2026-05-30T12:00:00Z",
                "updated": "2026-05-30T12:30:00Z",
                "issuelinks": [
                    {
                        "type": {
                            "name": "Blocks"
                        },
                        "inwardIssue": {
                            "id": "10002",
                            "key": "PROJ-124",
                            "fields": {
                                "status": {
                                    "name": "In Progress"
                                }
                            }
                        }
                    }
                ]
            }
        }"#;

        let node: JiraIssueNode = serde_json::from_str(raw_json).unwrap();
        let issue = normalize_jira_issue(node, Some("user-456"));

        assert_eq!(issue.id, "10001");
        assert_eq!(issue.identifier, "PROJ-123");
        assert_eq!(issue.title, "Fix some bugs");
        assert_eq!(
            issue.description,
            Some("We need to fix several key bugs".to_string())
        );
        assert_eq!(issue.priority, Some(2)); // High maps to 2
        assert_eq!(issue.state, "Todo");
        assert_eq!(
            issue.branch_name,
            Some("feature/issue-proj-123-fix-some-bugs".to_string())
        );
        assert_eq!(issue.assignee_id, Some("user-456".to_string()));
        assert_eq!(issue.assigned_to_worker, true);
        assert_eq!(
            issue.labels,
            vec!["bug".to_string(), "frontend".to_string()]
        );
        assert_eq!(issue.blocked_by.len(), 1);
        assert_eq!(issue.blocked_by[0].id, "10002");
        assert_eq!(issue.blocked_by[0].identifier, "PROJ-124");
        assert_eq!(issue.blocked_by[0].state, Some("In Progress".to_string()));
    }

    #[test]
    fn test_normalize_github_issue() {
        let raw_json = r#"{
            "number": 42,
            "title": "Fix alignment",
            "body": "The alignment is off",
            "state": "open",
            "html_url": "https://github.com/drew-simmons/skrvm/issues/42",
            "assignee": {
                "login": "drew-simmons"
            },
            "labels": [
                {
                    "name": "In Progress"
                }
            ],
            "created_at": "2026-05-30T12:00:00Z",
            "updated_at": "2026-05-30T12:30:00Z",
            "pull_request": null
        }"#;

        let config = Settings {
            tracker: crate::config::TrackerConfig {
                kind: "github".to_string(),
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                assignee: Some("drew-simmons".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };

        let node: GitHubIssue = serde_json::from_str(raw_json).unwrap();
        let issue = normalize_github_issue(node, &config);

        assert_eq!(issue.id, "42");
        assert_eq!(issue.identifier, "42");
        assert_eq!(issue.title, "Fix alignment");
        assert_eq!(issue.description, Some("The alignment is off".to_string()));
        assert_eq!(issue.state, "In Progress");
        assert_eq!(
            issue.branch_name,
            Some("feature/issue-42-fix-alignment".to_string())
        );
        assert_eq!(issue.assignee_id, Some("drew-simmons".to_string()));
        assert_eq!(issue.assigned_to_worker, true);
        assert_eq!(issue.labels, vec!["In Progress".to_string()]);
    }

    #[test]
    fn test_normalize_github_closed_issue_is_terminal() {
        let raw_json = r#"{
            "number": 11,
            "title": "Bump setup-node",
            "body": null,
            "state": "closed",
            "html_url": "https://github.com/drew-simmons/skrvm/issues/11",
            "assignee": null,
            "labels": [
                {
                    "name": "In Progress"
                }
            ],
            "created_at": "2026-05-30T12:00:00Z",
            "updated_at": "2026-06-01T19:51:50Z",
            "pull_request": null
        }"#;

        let config = Settings {
            tracker: crate::config::TrackerConfig {
                kind: "github".to_string(),
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                ..Default::default()
            },
            ..Default::default()
        };

        let node: GitHubIssue = serde_json::from_str(raw_json).unwrap();
        let issue = normalize_github_issue(node, &config);

        assert_eq!(issue.state, "Done");
    }

    #[test]
    fn test_normalize_github_terminal_label_wins_over_active_label() {
        let raw_json = r#"{
            "number": 12,
            "title": "Bump pnpm/action-setup",
            "body": null,
            "state": "open",
            "html_url": "https://github.com/drew-simmons/skrvm/issues/12",
            "assignee": null,
            "labels": [
                {
                    "name": "Todo"
                },
                {
                    "name": "Done"
                }
            ],
            "created_at": "2026-05-30T12:00:00Z",
            "updated_at": "2026-06-01T17:23:01Z",
            "pull_request": null
        }"#;

        let config = Settings {
            tracker: crate::config::TrackerConfig {
                kind: "github".to_string(),
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string()],
                ..Default::default()
            },
            ..Default::default()
        };

        let node: GitHubIssue = serde_json::from_str(raw_json).unwrap();
        let issue = normalize_github_issue(node, &config);

        assert_eq!(issue.state, "Done");
    }
}
