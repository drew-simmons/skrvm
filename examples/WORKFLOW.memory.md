---
# Skrvm Memory (Offline Mock) Workflow Configuration
# This config allows local offline runs with zero credentials, using mock issues.

tracker:
  # Supported kinds: "linear", "jira", "github", or "memory" (for mock offline testing)
  kind: "memory"

  # Project identifier slug for mock testing (e.g. "DEMO")
  project_slug: "DEMO"

  # States representing active issues that the scheduler should process
  active_states:
    - "Todo"

  # States representing terminal/completed states
  terminal_states:
    - "Done"

polling:
  # How often the orchestrator polls your issue tracker (in milliseconds)
  interval_ms: 10000

workspace:
  # Base folder where individual ticket sandboxes will be created.
  # Supports tilde expansion (~) and env variables.
  root: "~/dev/scratch/skrvm/workspaces"

agent:
  # Global limit on concurrent background coding agents
  max_concurrent_agents: 2
  # Maximum allowed JSON-RPC turn cycles per worker before timing out
  max_turns: 5
  # Maximum backoff delay for retrying failed agents (in milliseconds)
  max_retry_backoff_ms: 300000

# Agent Configuration.
# You can use "agy", "antigravity", "kiro", or "codex" as the block key.
agy:
  # Command used by the runner to start the background coding agent.
  command: "./scratch/mock_agent.sh"

  # The default thread sandbox security level
  thread_sandbox: "workspace-write"
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
