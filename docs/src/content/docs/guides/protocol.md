---
title: Coding Agents Protocol
description: JSON-RPC over stdio protocol specification and handshake sequence.
---

Skrvm interacts with coding agents (like Antigravity, Kiro, or Codex) using
standard streams (`stdin`/`stdout`) driven by standard **JSON-RPC 2.0**. This
specification details the protocol steps and turn sequence.

---

## 🤝 Handshake & Initialization Sequence

When a ticket is scheduled for execution, Skrvm boots the agent process
configured in `agents.command` and initiates the initialization handshake:

```text
[Orchestrator]                             [Agent Process]
      |                                           |
      | ------ initialize (RPC Request) --------> |
      | <----- initialize (RPC Response) -------- |
      |                                           |
      | ------ initialized (Notification) ------> |
      |                                           |
      | ------ thread/start (RPC Request) ------> |
      | <----- thread/start (RPC Response) -----> |
      |                                           |
      | ------ turn/start (RPC Request) --------> |
      | <----- turn/start (RPC Response) -------- |
      |                                           |
      | [Streaming Turn Reader Loop Starts]       |
```

### 1. `initialize` (Orchestrator Request)

Sent by Skrvm immediately after booting the subprocess.

- **Params**: Empty/capabilities details.
- **Agent Response**: Confirms agent capabilities and supported protocol
  configurations.

### 2. `initialized` (Orchestrator Notification)

A standard JSON-RPC notification sent by Skrvm acknowledging the completion of
the setup phase.

### 3. `thread/start` (Orchestrator Request)

Allocates an execution thread matching the active ticket.

- **Params**: `issue_id`, `workspace_path`.
- **Agent Response**: Confirms thread allocation.

### 4. `turn/start` (Orchestrator Request)

Triggers the actual execution of a single coding turn.

- **Params**: Injects the compiled system prompt and workspace target variables.
- **Agent Response**: Confirms the receipt of the prompt and begins process
  loop.

---

## 🔄 Streaming Turn Reader Loop

Once a turn starts, the agent reports actions back to the orchestrator. Skrvm
intercepts these tool requests, executing approvals or custom trackers:

### Command Approval: `execCommandApproval`

Whenever an agent wishes to execute a bash command on the host (e.g.
`npm run test` or `git status`), it MUST request approval from the orchestrator:

- **Request Method**: `execCommandApproval`
- **Params**: `{ command: "git status" }`
- **Skrvm Response**: Returns an approved status. If it violates boundaries or
  auto-approve lists, Skrvm halts the agent and alerts the operator.

### File Patch Approval: `applyPatchApproval`

Sent when the agent wishes to modify or write file contents:

- **Request Method**: `applyPatchApproval`
- **Params**: `{ path: "/absolute/path/file.py", patch: "..." }`
- **Skrvm Response**: Confirms whether the patch was successfully written within
  safe directory boundaries.

### Operator Handoff: `item/tool/requestUserInput`

If the agent gets stuck (e.g. missing an API secret key or needing architectural
confirmation from a human), it issues this request:

- **Request Method**: `item/tool/requestUserInput`
- **Params**:
  `{ prompt: "Please specify the target production database name." }`

**Orchestrator Action**: Skrvm immediately pauses execution, suspends the
subprocess, and moves the ticket card into **Human Review** on the dashboard.
The operator enters feedback in the drawer, which is returned as the JSON-RPC
response, and the agent continues.

### Turn Completion: `turn/completed` (Agent Notification)

Sent by the agent once all actions for the current turn are finished.

- **Method**: `turn/completed`
- **Params**: Injects token usage metrics:

  ```json
  {
    "usage": {
      "input_tokens": 12000,
      "output_tokens": 4200
    }
  }
  ```

Skrvm records these metrics to update global telemetry counters on the dashboard
and executes `hooks.after_run`.
