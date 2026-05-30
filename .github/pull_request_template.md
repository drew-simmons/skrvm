## Description

Please include a detailed description of the changes introduced by this pull
request. Explain the problem, the proposed solution, and the technical approach
taken.

## Related Issues

Please link any related issues or tracker items here (e.g., `Closes #123`,
`Fixes #456`).

## Verification Plan

Describe how you verified these changes. Include both automated test results and
manual verification details.

### Automated Tests

- Run `pnpm test` (includes frontend and Rust backend unit tests).
- Specify any additional tests run.

### Manual Verification

- Describe the steps taken to verify the changes manually (e.g. running the
  desktop application, checking UI layout, etc.).

## Checklist

- [ ] I have read the [AGENTS.md](../AGENTS.md) guidelines.
- [ ] TypeScript/TSX code is formatted using `pnpm fmt:ts`.
- [ ] Rust code is formatted using `pnpm fmt:rust`.
- [ ] TypeScript/TSX lint check passes using `pnpm lint:ts`.
- [ ] Rust backend lint check passes using `pnpm lint:rust`.
- [ ] All tests pass locally using `pnpm test`.
- [ ] Every changed line can be traced directly to the request (surgical
      changes).
- [ ] I have removed any unused imports, variables, or functions introduced by
      my changes.
- [ ] No remote API calls are made in integration tests without mock models or
      TCP listeners.
