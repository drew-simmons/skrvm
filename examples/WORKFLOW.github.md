---
# Skrvm GitHub Issues Workflow Configuration (Production Checkout Workflow)
# Orchestrates coding agents on external repositories based on GitHub Issues.
# Ensure all sensitive API keys are stored in environment variables.

tracker:
  # Supported kinds: "linear", "jira", "github", or "memory" (for mock offline testing)
  kind: "github"

  # GitHub API endpoint: "https://api.github.com"
  endpoint: "https://api.github.com"

  # API key reference. Skrvm automatically resolves any string prefixed with '$' from process env.
  # Best Practice: export GITHUB_TOKEN="..." in your shell profile.
  api_key: "$GITHUB_TOKEN"

  # Repository owner/repo identifier slug (e.g. "my-org/my-target-project")
  project_slug: "my-org/my-target-project"

  # Filter tickets assigned to. Limit to issues assigned to this user, or leave blank.
  assignee: "my-github-username"

  # States representing active issues that the scheduler should process
  active_states:
    - "Todo"
    - "In Progress"

  # States representing terminal/completed states
  terminal_states:
    - "Done"

polling:
  # How often the orchestrator polls your issue tracker (in milliseconds)
  interval_ms: 30000

workspace:
  # Base folder where individual ticket sandboxes will be created.
  # Supports tilde expansion (~) and env variables.
  root: "~/dev/scratch/skrvm/workspaces"

agent:
  # Global limit on concurrent background coding agents
  max_concurrent_agents: 3
  # Maximum allowed JSON-RPC turn cycles per worker before timing out
  max_turns: 20
  # Maximum backoff delay for retrying failed agents (in milliseconds)
  max_retry_backoff_ms: 300000

# Agent Configuration.
# You can use "agy", "antigravity", "kiro", or "codex" as the block key.
agy:
  # Command used by the runner to start the background coding agent.
  # If left as default, Skrvm auto-detects installed commands in your PATH:
  #   1. "agy run" (Antigravity CLI)
  #   2. "kiro run"
  #   3. "codex app-server"
  command: "agy run"

  # The default thread sandbox security level
  thread_sandbox: "workspace-write"
  # Maximum execution time for a single turn (in milliseconds)
  turn_timeout_ms: 3600000

hooks:
  # Shell hooks run inside the issue's sandbox workspace

  # 1. Runs immediately after sandbox folder creation. Bootstraps the target project repository.
  after_create: "git clone git@github.com:my-org/my-target-project.git . && git checkout -b skrvm-{{ issue.identifier }}"

  # 2. Runs before launching the coding agent. Prepares environment dependencies.
  before_run: "npm install"

  # 3. Runs after each successful turn. Commits and pushes progress back to origin.
  after_run: "git add . && git commit -m 'skrvm: turn progression progress' --allow-empty && git push origin HEAD"

  # Timeout for each shell hook (in milliseconds)
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

### Technical Guidelines

1. Analyze the sandbox workspace directory.
2. Code your solutions cleanly, respecting existing code styles.
3. Validate and verify your changes before completing your turn.
