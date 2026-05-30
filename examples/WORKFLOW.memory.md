---
# Skrvm Memory (Offline Mock) Workflow Configuration
# This config allows local offline runs with zero credentials, using mock issues.

tracker:
  kind: "memory"
  project_slug: "DEMO"
  active_states:
    - "Todo"
  terminal_states:
    - "Done"

polling:
  interval_ms: 10000

workspace:
  root: "~/dev/scratch/skrvm/workspaces"

agent:
  max_concurrent_agents: 2
  max_turns: 5

codex:
  command: "./scratch/mock_agent.sh"
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
