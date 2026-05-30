---
# Skrvm Orchestrator Template Workflow Configuration
# Copy this file to your root directory as `WORKFLOW.md` and customize it for your setup.
# Ensure all sensitive API keys are stored in environment variables.

tracker:
  # Supported kinds: "linear", "jira", or "memory" (for mock offline testing)
  kind: "linear"

  # Linear endpoint: "https://api.linear.app/graphql"
  # Jira endpoint: "https://your-company.atlassian.net"
  endpoint: "https://api.linear.app/graphql"

  # API key reference. Skrvm automatically resolves any string prefixed with '$' from process env.
  # Best Practice: export LINEAR_API_KEY="lin_api_..." or JIRA_API_KEY="..." in your shell profile.
  api_key: "$LINEAR_API_KEY"

  # Project identifier slug (e.g. Linear team key "ENG", or Jira Project Key "PROJ")
  project_slug: "ENG"

  # Filter tickets assigned to. Use "me" for Linear current viewer, or Jira Account ID, or leave blank.
  assignee: "me"

  # States representing active issues that the scheduler should process
  active_states:
    - "Todo"
    - "In Progress"

  # States representing terminal/completed states
  terminal_states:
    - "Done"
    - "Canceled"

polling:
  # How often the orchestrator polls your issue tracker (in milliseconds)
  interval_ms: 15000

workspace:
  # Base folder where individual ticket sandboxes will be created.
  # Supports tilde expansion (~) and env variables.
  root: "~/dev/skrvm-workspaces"

agent:
  # Global limit on concurrent background coding agents
  max_concurrent_agents: 3
  # Maximum allowed JSON-RPC turn cycles per worker before timing out
  max_turns: 20
  # Maximum backoff delay for retrying failed agents (in milliseconds)
  max_retry_backoff_ms: 300000

codex:
  # Command used by the runner to start the background coding agent.
  command: "kiro run"
  # The default thread sandbox security level
  thread_sandbox: "workspace-write"
  # Maximum execution time for a single turn (in milliseconds)
  turn_timeout_ms: 3600000

hooks:
  # Shell hooks run inside the issue's sandbox workspace (e.g. ~/dev/skrvm-workspaces/ENG-101)

  # 1. Runs immediately after sandbox folder creation. Bootstraps the target project repository.
  # Example: Clones target project and sets up a ticket-specific branch:
  after_create: "git clone git@github.com:my-org/my-project.git . && git checkout -b feature/skrvm-{{ issue.identifier }}"

  # 2. Runs before launching the coding agent. Prepares environment dependencies.
  before_run: "npm install"

  # 3. Runs after each successful turn. Commits and pushes progress back to origin.
  after_run: "git add . && git commit -m 'skrvm: turn progression progress' --allow-empty && git push origin HEAD"

  # Timeout for each shell hook (in milliseconds)
  timeout_ms: 120000
---

You are Antigravity, an elite agentic coding assistant spawned by the Skrvm
orchestrator to resolve ticket **{{ issue.identifier }}**.

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
