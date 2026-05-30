# Skrvm AI Agent Guidelines 🤖

Welcome, elite agent! To ensure the highest level of trust, code quality, and
surgical safety in the **Skrvm Orchestrator** repository, you MUST strictly
adhere to the following guidelines.

---

## 1. Think Before Coding

**Do not assume. Do not hide confusion. Surface tradeoffs.**

- **Understand the Architecture**: Skrvm is a desktop coding agent orchestrator
  built on **Tauri v2**, **React 19**, **TypeScript**, and **Rust**.
- **Identify Ambiguity**: If a task requirement is unclear or presents multiple
  valid architectural options, stop and present the tradeoffs to the operator.
  Do not make silent assumptions.
- **Push for Simplicity**: If there is a simpler approach that achieves the goal
  with fewer lines of code, recommend it first.

## 2. Simplicity First

**Write the minimum code that solves the problem. Nothing speculative.**

- Do not build abstractions for single-use code.
- Avoid introducing speculative configurations, flexibility, or hooks that
  weren't explicitly requested.
- Refuse overly complex implementations. If a change can be written in 50 lines
  instead of 200, rewrite it.

## 3. Surgical Changes

**Touch only what you must. Clean up your own workspace.**

- **Respect Local Style**: Match the existing code style, formatting, and naming
  conventions of the file you are modifying, regardless of personal preference.
- **Do Not Refactor adjacent code**: Do not "improve" or format surrounding
  lines, dead code, or unrelated comments unless explicitly asked to do so.
- **Remove Orphans**: If your changes render imports, variables, or functions
  unused, delete them immediately.

## 4. Goal-Driven Execution

**Define success criteria. Loop and verify before claiming victory.**

- **Never assume it works**: Always run compilation, linting, formatting, and
  testing checks before concluding.
- **Verification Checklist**: Break down complex tasks into verifiable sub-goals
  and run test commands to gather concrete evidence of success.

---

## 🛠️ Project-Specific Verification & Tools

Always run the unified project scripts to audit your changes. Under no
circumstances should you bypass these checks.

### Code Formatting

Ensure all changed files are perfectly formatted:

- **Format All TypeScript/TSX**: `pnpm fmt:ts`
- **Format All Rust**: `pnpm fmt:rust`
- **Format All Markdown**:

  ```bash
  uvx rumdl check --config 'MD013.code-blocks=false' --config 'MD013.reflow=true' --disable MD036,MD041 --fix <path-to-markdown-file>
  ```

### Linting & Code Quality

Review static analysis audits:

- **Lint TypeScript/TSX**: `pnpm lint:ts`
- **Lint Rust (Clippy)**: `pnpm lint:rust`

### Test Suites

Always run the complete test runner before concluding a task:

- **Run All Tests**: `pnpm test`
- **Run Frontend Only**: `pnpm test:ts`
- **Run Rust Backend Only**: `pnpm test:rust`

---

## 🔒 Security & Path Safety Mandates

Skrvm runs background coding agents in local directory sandboxes. Absolute path
security is paramount:

- **Boundary Containment**: All workspace creations and file accesses must be
  validated using `validate_workspace_cwd`. Never allow parent directory
  traversals (`../`) or identical-to-root workspace path resolutions.
- **Safe Credential Handling**: All tracker API keys or assignee limits must
  support dynamic env resolution (e.g. `$JIRA_API_KEY`) and should never be
  hardcoded.
- **Side-Effect Free Verification**: When writing integration tests for
  third-party trackers (like Jira or GitLab),
  **never make actual remote creations**. Always use mock models or local
  in-memory TCP listeners (`TcpListener`) inside the test suite.
