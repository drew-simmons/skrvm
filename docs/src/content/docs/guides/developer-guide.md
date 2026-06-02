---
title: Developer & Contributor Guide
description: Contribution guidelines, code style rules, test commands, and security requirements.
---

Thank you for contributing to Skrvm! To maintain codebase health, safety, and
performance, all contributors must adhere to the style mandates, testing
routines, and path security rules outlined below.

---

## 🛠️ Unified Developer Scripts

Skrvm exposes high-level pnpm helper commands in the root `package.json` to
automate checks. Always execute these before creating a pull request.

### Code Formatting

Keep all files formatted to match local styling standards:

- **Format Frontend TypeScript / TSX**:

  ```bash
  pnpm fmt:ts
  ```

- **Format Backend Rust**:

  ```bash
  pnpm fmt:rust
  ```

- **Format Both**:

  ```bash
  pnpm fmt
  ```

- **Format Markdown**:

  ```bash
  uvx rumdl check --config 'MD013.code-blocks=false' --config 'MD013.reflow=true' --disable MD036,MD041 --fix <path-to-markdown-file>
  ```

### Linting & Static Analysis

Clean all static analysis audits and compile warnings:

- **Lint Frontend TypeScript**:

  ```bash
  pnpm lint:ts
  ```

- **Lint Backend Rust (Clippy)**:

  ```bash
  pnpm lint:rust
  ```

- **Lint Both**:

  ```bash
  pnpm lint
  ```

### Test Suites

All tests must pass locally:

- **Run Frontend Tests** (Vitest):

  ```bash
  pnpm test:ts
  ```

- **Run Backend Tests** (Cargo):

  ```bash
  pnpm test:rust
  ```

- **Run Complete Test Runner**:

  ```bash
  pnpm test
  ```

---

## 🔒 Security & Path Safety Mandates

Because Skrvm runs background coding agents operating on local directories, path
security is absolute:

### 1. Boundary Containment

Any code modifying file access or creating workspace directory entries must use
the native validation helper `validate_workspace_cwd`.

- **Rule**: Never allow path evaluations containing parent traversals (`../`) or
  matching the root workspace folder directly.
- **Action**: Reject any relative or nested path parameter from coding agents
  before letting it touch the filesystem.

### 2. Side-Effect Free Integrations

When writing integration tests or tracking modules for third-party trackers
(like Jira, Linear, or GitLab):

- **Rule**: Do not perform real HTTP calls to live remote endpoints during
  standard tests.
- **Action**: Always use local in-memory mock endpoints or mock listeners
  (`TcpListener`) inside the Rust/TypeScript test suites to guarantee offline
  capability.

### 3. Safe Credential Handling

All newly added tracking fields, usernames, or API tokens must support dynamic
env resolution (e.g. prefixing with `$`). They must never be hardcoded into code
files, template specs, or mock configurations.
