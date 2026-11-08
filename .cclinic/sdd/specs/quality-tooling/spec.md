# quality-tooling

## Goal

Enforce architecture, lint, types, coverage, mutation testing and test infrastructure so that every change to cclinic passes one repeatable quality gate (npm run verify) and the test suite is deterministic and runs without real Claude or network.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-QUAL-001 | The architecture check must fail when src/core imports from adapters, application, cli, or Node built-ins (fs, path, os, child_process, net, http, https, process, node:*). | confirmed | `.dependency-cruiser.cjs:5-9`, `sdd/developer-guidelines.md:74-77`, `package.json:29` |
| FR-QUAL-002 | The architecture check must fail when non-test code in src/core depends on an npm package other than zod. | code-only | `.dependency-cruiser.cjs:11-15` |
| FR-QUAL-003 | The architecture check must fail when non-test code in src/application imports anything other than src/core or src/application. | code-only | `.dependency-cruiser.cjs:16-21` |
| FR-QUAL-004 | The architecture check must fail when an adapter imports from application, cli, or another adapter. | code-only | `.dependency-cruiser.cjs:22-33`, `sdd/developer-guidelines.md:74-77` |
| FR-QUAL-005 | The architecture check must fail when @anthropic-ai/sdk is imported from anywhere other than src/adapters/llm/anthropic-api. | code-only | `.dependency-cruiser.cjs:34-39`, `test/integration/cli-commands.test.ts:412-419` |
| FR-QUAL-006 | The architecture check must treat circular dependencies as errors. | code-only | `.dependency-cruiser.cjs:40` |
| FR-QUAL-007 | Linting must fail on magic numbers (other than 0, 1, -1) in src outside tests and src/core/constants, and must restrict default exports except in tool config files. | code-only | `eslint.config.js:11`, `eslint.config.js:15-24`, `tsup.config.ts:13-15`, `vitest.config.ts:23-25` |
| FR-QUAL-008 | Type-checking must run in strict mode with the extra strict options (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax) and ESM NodeNext resolution, and the typecheck script must run tsc --noEmit. | confirmed | `tsconfig.json:3-16`, `package.json:28`, `sdd/developer-guidelines.md:112-122`, `sdd/stack.md:80` |
| FR-QUAL-009 | The test coverage run must fail when coverage is below 80% lines and branches globally or below 90% in src/core. | confirmed | `vitest.config.ts:9-13`, `sdd/developer-guidelines.md:301-303`, `package.json:23` |
| FR-QUAL-010 | Mutation testing must mutate src/core (excluding test files and guidelines-baseline.ts) using the Vitest runner, with score thresholds high 85 and low 70 and without breaking the build. | confirmed | `stryker.config.json:2-5`, `package.json:25`, `sdd/developer-guidelines.md:301-303` |
| FR-QUAL-011 | The verify script must run lint, typecheck, architecture check, coverage tests and e2e tests, and must not run mutation testing. | confirmed | `package.json:30`, `sdd/stack.md:82`, `sdd/developer-guidelines.md:341` |
| FR-QUAL-012 | Commit messages must be validated against the Conventional Commits configuration. | confirmed | `commitlint.config.js:2`, `sdd/developer-guidelines.md:320`, `sdd/stack.md:42` |
| FR-QUAL-013 | The lint script must check formatting with Prettier (printWidth 120), ignoring dist, coverage, reports, .stryker-tmp, sdd/, test/fixtures and package-lock.json. | code-only | `.prettierrc.json:2`, `.prettierignore:1-7`, `package.json:26` |
| FR-QUAL-014 | Unit tests must be co-located as src/**/*.test.ts, and integration and e2e tests must live under test/, with e2e tests running the built binary bin/cclinic.js after a build. | confirmed | `vitest.config.ts:16-18`, `package.json:24`, `test/e2e/cli.test.ts:19`, `test/e2e/cli.test.ts:49` |
| FR-QUAL-015 | E2E tests must run against a fake claude executable, a sandboxed HOME/XDG_CONFIG_HOME and a restricted PATH, so no real Claude or network is used. | confirmed | `test/fixtures/fake-claude/claude:3-35`, `test/e2e/cli.test.ts:36-58`, `sdd/developer-guidelines.md:265` |
| FR-QUAL-016 | Every test that touches the filesystem must use a fresh temp folder that is cleaned up after each test. | confirmed | `test/support/helpers.ts:10-20`, `sdd/developer-guidelines.md:290-293` |
| FR-QUAL-017 | Test names must start with the traceable test-case ID (e.g. TC-CLI-001). | confirmed | `test/e2e/cli.test.ts:95`, `test/integration/pipeline.test.ts:338`, `sdd/developer-guidelines.md:307` |
| FR-QUAL-018 | Parser contract tests must use recorded real claude output fixtures for success, budget exhaustion and invalid model. | confirmed | `test/fixtures/recorded-cli-output/success.jsonl:1-2`, `test/fixtures/recorded-cli-output/budget.jsonl:1`, `test/fixtures/recorded-cli-output/invalid-model.jsonl:1`, `sdd/developer-guidelines.md:297` |
| FR-QUAL-019 | The fake claude must support failure modes (fail-after-1, hang, slow, invalid-model, auth-error, invalid-output, usage-limit, retry-events) selected by FAKE_CLAUDE_MODE and record each call. | code-only | `test/fixtures/fake-claude/claude:1-117`, `test/fixtures/fake-claude/claude:27-35` |
| FR-QUAL-020 | The build must bundle src/cli/main.ts into a single ESM dist/main.js with sourcemaps, launched by bin/cclinic.js. | code-only | `tsup.config.ts:3-11`, `package.json:10-12`, `package.json:21` |

## Edge cases

- A test file in src/core importing an npm package other than zod must not trigger the core-npm rule, because only non-test code is restricted.
- Config files needing default exports (tsup, vitest) must pass lint thanks to annotated disable comments.
- Magic numbers 0, 1 and -1 are allowed outside constants.
- Tests needing non-root or non-Windows environments are skipped via skipIf rather than failing.
- Mutation score below the low threshold does not break the build (break not set).
- E2E tests require a prior build; running them without dist fails.
- Generated sdd/ docs and test/fixtures are excluded from Prettier checks.

## Non-goals

- Runtime behaviour of CLI commands, providers, discovery, extraction, analysis, output, skills, git and instructions (covered by other specs).
- Defining the CI pipeline file itself; none is among the analysed files.
- Testing against the real Claude CLI or Anthropic API.
