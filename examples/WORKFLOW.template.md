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
  root: "~/dev/scratch/skrvm/workspaces"

agent:
  # Global limit on concurrent background coding agents
  max_concurrent_agents: 3
  # Maximum allowed JSON-RPC turn cycles per worker before timing out
  max_turns: 20
  # Maximum backoff delay for retrying failed agents (in milliseconds)
  max_retry_backoff_ms: 300000

# Agent Configuration.
# You can use "agents", "agy", "antigravity", "kiro", or "codex" as the block key.
agents:
  # Command used by the runner to start the background coding agent.
  # For jsonrpc: e.g. "codex app-server", "kiro-cli acp"
  # For oneshot: e.g. "agy --print -", "kiro-cli chat"
  command: "codex app-server"

  # Communication protocol to use:
  # - "jsonrpc" (default): Performs multi-turn background JSON-RPC handshake (Codex, Kiro ACP)
  # - "oneshot": Pipes the rendered prompt directly to stdin and runs CLI to completion (agy, Kiro TUI chat)
  protocol: "jsonrpc"

  # The default thread sandbox security level
  thread_sandbox: "workspace-write"
  # Maximum execution time for a single turn (in milliseconds)
  turn_timeout_ms: 3600000

hooks:
  # Shell hooks run inside the issue's sandbox workspace (e.g. ~/dev/scratch/skrvm/workspaces/ENG-101)

  # 1. Runs immediately after sandbox folder creation. Bootstraps the target project repository.
  # Example: Clones target project and sets up a ticket-specific branch:
  after_create: "git clone git@github.com:my-org/my-project.git . && git checkout -b {{ issue.branch_name }}"

  # 2. Runs before launching the coding agent. Prepares environment dependencies.
  before_run: "pnpm install"

  # 3. Runs after each successful turn. Commits and pushes progress back to origin.
  after_run: "git add . && git commit -m 'skrvm: turn progression progress' --allow-empty && git push -u origin HEAD:{{ issue.branch_name }} && (if git remote get-url origin | grep -q 'github.com'; then gh pr create --title '{{ issue.title }}' --body 'Automated changes by Skrvm.' --head '{{ issue.branch_name }}' || true; elif git remote get-url origin | grep -q 'gitlab.com'; then glab mr create --title '{{ issue.title }}' --description 'Automated changes by Skrvm.' --source-branch '{{ issue.branch_name }}' || true; fi)"

  # Timeout for each shell hook (in milliseconds)
  timeout_ms: 120000
---

You are Antigravity, an elite agentic coding assistant spawned by the Skrvm
orchestrator to resolve ticket **{{ issue.identifier }}**.

{% if attempt > 0 %}

### Continuation Context

- **Retry Attempt**: #{{ attempt }} (the ticket remains in an active state).
- **Strategy**: Resume directly from the current workspace state instead of
  restarting investigation.
- **Efficiency**: Avoid repeating already completed planning, implementation, or
  verification unless directly affected by new modifications.
- **Handoff**: Do not end the turn prematurely unless a hard external blocker
  (missing credentials or tooling) exists.

{% endif %}

### Task Overview

- **Title**: {{ issue.title }}
- **Status**: {{ issue.state }}

#### Description

```markdown
{{ issue.description }}
```

### Default Posture & Execution Guidelines

- **Reproduce First**: Always replicate the issue, bug signal, or target
  behavior before writing any code changes. Make sure your fix target is
  completely explicit and verified first.
- **Surgical Boundaries**: Touch only what is strictly necessary to solve the
  issue. If you discover dead code, unrelated formatting issues, or major
  refactoring opportunities, do not modify them. Instead, log them in your final
  report or file a separate follow-up ticket.
- **Persistent Skrvm Workpad**:
  - Treat a single persistent comment in the issue tracker (starting with the
    header `## Skrvm Workpad`) as the source of truth for the task's state.
  - If a Workpad comment does not exist yet, create one. If it does exist,
    update it at the start and end of every turn. Do not post separate progress
    or "done" comments.
  - Use the Workpad to track your current checklist, verification steps, and any
    obstacles.

### Technical Guidelines

1. Analyze the sandbox workspace directory.
2. Code your solutions cleanly, respecting existing code styles.
3. Validate and verify your changes before completing your turn.
4. Update the persistent tracker Workpad comment to document completed items and
   test results.
5. Once all verification checks pass and the issue is resolved, conclude the
   turn.
