---
title: Configuration Guide
description: Detailed reference for the WORKFLOW.md file format, YAML parameters, and MiniJinja templates.
---

Skrvm Orchestrator's entire runtime behavior is configured via a single local
file: `WORKFLOW.md`. This file is automatically watched and hot-reloaded every
1.5 seconds by the Rust core, allowing you to update prompts, tools, and hooks
live without restarting the dashboard.

---

## 📄 File Format Overview

`WORKFLOW.md` uses a **double-dash split format**:

1. **YAML Frontmatter**: Defines trackers, directories, hooks, and process
   configuration.
2. **MiniJinja System Prompt**: A rich prompt template injected into coding
   agents during execution.

```markdown
---
# 1. YAML Configuration Frontmatter
tracker:
  kind: "linear"
  api_key: "$LINEAR_API_KEY"
...
---
# 2. MiniJinja System Prompt Template
You are Antigravity, resolving issue {{ issue.identifier }}.
...
```

---

## ⚙️ YAML Key Reference

Here is a full breakdown of the configuration keys available in the YAML block:

### `tracker` (VCS & Issue Trackers)

Configures how Skrvm polls active tickets and checks upstream status.

* `kind`: The type of tracker. Supported options: `"linear"`, `"jira"`, or
  `"memory"`.
* `endpoint`: The base domain/API URL (e.g., `https://your-domain.atlassian.net`
  for Jira). Leave empty for Linear or Memory.
* `api_key`: Authorization token (e.g. `$LINEAR_API_KEY`). Supports environment
  variable resolution.
* `project_slug`: Project or team shorthand identifier (e.g., `PROJ`).
* `assignee` *(Optional)*: Filter tickets assigned to a specific user (use
  `"me"` for Linear).
* `active_states`: List of tracker states mapped to the active pipeline (e.g.,
  `["Todo", "In Progress"]`).
* `terminal_states`: List of completed states (e.g., `["Closed", "Done"]`).

### `polling`

Specifies synchronization intervals.

* `interval_ms`: Frequency (in milliseconds) with which the orchestrator polls
  your issue tracker.

### `workspace`

Manages local sandbox directories.

* `root`: Path to the directory where issue work folders are created. Supports
  tilde `~` (e.g., `~/dev/workspaces`) and environment variables.

### `agent`

Controls background process limits.

* `max_concurrent_agents`: The maximum number of background coding processes
  allowed to execute simultaneously.
* `max_turns`: The turn threshold after which the agent is halted to prevent
  infinite loops.
* `max_retry_backoff_ms`: Scaled delay cap for exponential error backoffs.

### `agents`

Details the process execution profile.

* `command`: Shell command used to boot the coding agent (e.g.,
  `codex app-server`, `kiro app-server`, or `./scratch/mock_agent.sh`).
* `thread_sandbox`: Sandbox isolation mode (e.g., `"workspace-write"`).
* `turn_timeout_ms`: Maximum execution time allowed per turn.

### `hooks`

Declares shell commands executed at distinct lifecycle stages of a ticket's
workspace folder.

* `after_create`: Executed immediately after creating the sandbox folder. Ideal
  for cloning target repositories and creating branches:

    ```yaml
    hooks:
      after_create: "git clone --depth 1 git@github.com:my-org/my-project.git . && git checkout -b feature/skrvm-{{ issue.identifier }}"
    ```

* `before_run`: Executed before launching each agent turn. Best used for
  installing node modules or packages:

    ```yaml
    hooks:
      before_run: "pnpm install"
    ```

* `after_run`: Executed immediately after a turn successfully completes. Useful
  for committing and pushing updates:

    ```yaml
    hooks:
      after_run: "git add . && git commit -m 'skrvm: turn progress' --allow-empty && git push origin HEAD"
    ```

* `timeout_ms`: The execution window limit for all hook processes.

---

## 🔒 Dynamic Env Resolution

To keep sensitive keys and personal configurations out of Git, Skrvm supports
dynamic env resolution. Prefix any string in your YAML config with `$` (e.g.
`api_key: "$JIRA_API_KEY"`), and Skrvm will read the value directly from your
host environment at runtime.

---

## 📝 MiniJinja Prompts

The markdown content below the closing yaml separator (`---`) serves as a system
prompt template compiled via **MiniJinja** (Jinja2-compatible syntax). Skrvm
binds ticket-specific properties to the environment dynamically during agent
creation.

### Injected Context Variables

You can reference these variables in your prompt layout:

* `{{ issue.identifier }}`: The tracker key (e.g., `PROJ-123`).
* `{{ issue.title }}`: The title of the ticket.
* `{{ issue.state }}`: The status string of the ticket.
* `{{ issue.description }}`: The issue's body description.
