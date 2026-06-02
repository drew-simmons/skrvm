---
title: Getting Started
description: Walkthrough guide for setting up and running Skrvm Orchestrator locally.
---

Welcome to Skrvm! This guide will help you set up the desktop coding agent
orchestrator locally on your machine and run an offline demonstration in under
five minutes.

---

## 📋 Prerequisites

Before setting up Skrvm, ensure you have the following toolchains installed:

* **Rust & Cargo** (v1.75+ or newer) for building the backend core.
* **Node.js** (v18+ or newer) for the React web interface.
* **pnpm** (Package manager, `npm i -g pnpm`) for managing dependencies.

---

## 🚀 Step-by-Step Setup

Follow these steps to initialize the codebase and run your first sandbox:

### 1. Clone the Codebase

Clone the repository and move into the project root:

```bash
git clone https://github.com/drew-simmons/skrvm.git
cd skrvm
```

### 2. Install Project Dependencies

Install standard npm dependencies for the frontend React application and verify
the build setup:

```bash
pnpm install
```

### 3. Setup Your Local `WORKFLOW.md`

Skrvm relies on a central configuration file called `WORKFLOW.md` in the root of
the project. For this quick setup, we will configure a local, credentials-free
**Memory Tracker** workflow.

Create a `WORKFLOW.md` file in your project root with the following YAML
frontmatter and template:

```yaml
---
tracker:
  kind: "memory"
  endpoint: ""
  api_key: ""
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
You are a helpful coding agent. Solve this issue:
Issue: {{ issue.title }}
```

### 4. Create a Mock Agent Script

To run the offline setup without requiring real OpenAI/Anthropic keys, let's
create a small script that mimics the JSON-RPC agent handshake.

Create a folder called `scratch/` in the project root:

```bash
mkdir -p scratch
```

Now create a script at `scratch/mock_agent.sh` and populate it:

```bash
#!/bin/bash
# Mock Agent Stdio Handshake Script
read -r line # Read initialize
echo '{"id":1,"result":{"capabilities":{}}}'
read -r line # Read initialized
read -r line # Read thread/start
echo '{"id":2,"result":{"thread":{"id":"mock-thread-id"}}}'
read -r line # Read turn/start
echo '{"id":3,"result":{"turn":{"id":"mock-turn-id"}}}'
sleep 3
echo '{"method":"turn/completed","params":{"usage":{"input_tokens":120,"output_tokens":80}}}'
```

Make the script executable:

```bash
chmod +x scratch/mock_agent.sh
```

### 5. Run the Desktop App in Dev Mode

Start the Vite frontend development server and the Tauri wrapper:

```bash
pnpm tauri dev
```

The desktop dashboard window will open, showing a live Kanban board populated
with mock issues from your Memory tracker. The orchestrator loop will
automatically boot the mock agent script inside
`~/dev/scratch/skrvm/workspaces`!

---

## 🔍 Next Steps

Now that you have your first offline run working:

* Learn how to configure Jira or Linear trackers in the
  [Configuration Guide](/skrvm/guides/configuration/).
* Understand the orchestrator architecture in
  [System Architecture](/skrvm/guides/architecture/).
