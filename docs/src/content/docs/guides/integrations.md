---
title: Integrations & Trackers
description: Setup guides for Linear, Jira, GitHub, GitLab, and local Memory trackers.
---

Skrvm Orchestrator integrates with leading issue trackers and version control
systems. Instead of exposing API credentials to untrusted background agents,
Skrvm manages auth keys inside the secure Rust core and exposes standardized
GraphQL/REST APIs to agents via JSON-RPC.

---

## 🎯 Supported Trackers

### 1. Linear Integration

Linear is fully supported with automated backlog polling, filter-based issue
retrieval, state transition syncing, and custom GraphQL execution.

#### Configuration Block

Add the following block to your `WORKFLOW.md`'s tracker configuration:

```yaml
tracker:
  kind: "linear"
  api_key: "$LINEAR_API_KEY" # Resolved from shell environment
  assignee: "me" # Filters issues assigned to you. Or leave empty.
  active_states:
    - "Todo"
    - "In Progress"
  terminal_states:
    - "Done"
    - "Canceled"
```

#### Shared Agent Tool: `linear_graphql`

Skrvm provides active coding agents with a secure JSON-RPC tool called
`linear_graphql`. This allows the agent to issue raw, authed GraphQL queries
against Linear to update custom attributes, retrieve ticket comments, or link
branches without needing direct API keys.

---

### 2. Jira Integration

Jira integration connects directly to your Atlassian Cloud project, matching
issues via custom JQL queries.

#### Configuration Block

```yaml
tracker:
  kind: "jira"
  endpoint: "https://your-company.atlassian.net"
  api_key: "$JIRA_API_KEY" # Your Jira API Token
  assignee: "$JIRA_ASSIGNEE" # E.g. your Jira Account ID or email
  project_slug: "PROJ"
  active_states:
    - "To Do"
    - "In Progress"
  terminal_states:
    - "Done"
```

---

### 3. GitHub Integration

Integrates repository issue pipelines directly into your workspace scheduler.

#### Configuration Block

```yaml
tracker:
  kind: "github"
  endpoint: "https://api.github.com"
  api_key: "$GITHUB_TOKEN" # Personal Access Token (PAT)
  project_slug: "drew-simmons/skrvm" # Owner/Repository path
  active_states:
    - "open"
  terminal_states:
    - "closed"
```

When active, Skrvm can automatically create new branches, reference issue cards
in commits, and transition states as the workspace completes turns.

---

### 4. GitLab Integration

Supports standard GitLab issue boards and embeds a secure tool wrapper for
agents.

#### Configuration Block

```yaml
tracker:
  kind: "gitlab"
  endpoint: "https://gitlab.com"
  api_key: "$GITLAB_TOKEN"
  project_slug: "your-group/your-repo"
  active_states:
    - "opened"
  terminal_states:
    - "closed"
```

#### Shared Agent Tool: `gitlab_api`

Agents running inside GitLab workspaces can call the `gitlab_api` RPC method.
This dynamically pipes GitLab REST/GraphQL requests through the secure
orchestrator layer, enabling rich updates like commenting, posting patches, and
creating merge requests.

---

### 5. Memory Tracker (Local Mock Runs)

The Memory tracker is a zero-credential mock tracker designed for local testing,
CI checks, and offline agent development. It reads issues from an in-memory
queue rather than communicating with a remote server.

#### Configuration Block

```yaml
tracker:
  kind: "memory"
  endpoint: ""
  api_key: ""
  project_slug: "DEMO"
  active_states:
    - "Todo"
  terminal_states:
    - "Done"
```

- **Offline Development**: Allows sandbox evaluation without making remote
  network calls or requiring active API keys.
- **Speed**: Runs immediately without API polling delays or rate limit
  constraints.
