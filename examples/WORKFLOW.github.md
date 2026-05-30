---
# Skrvm GitHub Issues Workflow Configuration (Production Checkout Workflow)
# Orchestrates coding agents on external repositories based on GitHub Issues.

tracker:
  kind: "github"
  endpoint: "https://api.github.com"
  api_key: "$GITHUB_TOKEN" # Resolves GITHUB_TOKEN environment variable
  project_slug: "my-org/my-target-project" # Repository owner/repo identifier slug
  assignee: "my-github-username" # Optional: Limit to issues assigned to this user
  active_states:
    - "Todo"
    - "In Progress"
  terminal_states:
    - "Done"

polling:
  interval_ms: 30000

workspace:
  root: "~/dev/skrvm-workspaces" # Parent folder for checking out sandbox workspaces

agent:
  max_concurrent_agents: 3
  max_turns: 20

codex:
  command: "kiro run" # Spawns Kiro CLI JSON-RPC server
  thread_sandbox: "workspace-write"
  turn_timeout_ms: 3600000

hooks:
  # 1. Bootstraps the external target repository into the ticket's sandbox workspace folder
  after_create: "git clone git@github.com:my-org/my-target-project.git . && git checkout -b feature/skrvm"

  # 2. Prepares workspace dependencies before running the agent
  before_run: "npm install"

  # 3. Commits and pushes turn progress back to the remote repository
  after_run: "git add . && git commit -m 'skrvm: turn progression progress' --allow-empty && git push origin HEAD"

  timeout_ms: 120000
---

You are Antigravity, an elite agentic coding assistant spawned by the Skrvm
orchestrator to resolve GitHub Issue **#{{ issue.identifier }}**.

### Task Overview

- **Title**: {{ issue.title }}
- **Status**: {{ issue.state }}

#### Description

```markdown
{{ issue.description }}
```

---

### Technical Instructions

1. Locate the workspace directory and analyze the existing codebase.
2. Code your solutions cleanly and verify correctness before completing the
   turn.
