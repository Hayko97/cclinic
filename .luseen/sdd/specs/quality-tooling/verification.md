# quality-tooling: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Install: npm ci (Node >=22.18; .nvmrc pins 26) (package.json:17-19, .nvmrc:1).
- Unit and integration: npm test; with thresholds: npm run test:coverage (package.json:22-23).
- E2E: npm run test:e2e (builds, then runs test/e2e) (package.json:24).
- Mutation: npm run test:mutation (Stryker, vitest runner) (package.json:25).
- Static checks: npm run lint, npm run typecheck, npm run check:arch (package.json:26-29); full gate: npm run verify (package.json:30).
- Direct architecture check: node_modules/.bin/depcruise src --config .dependency-cruiser.cjs (test/integration/cli-commands.test.ts:412-419).
- Commit lint: commitlint with config-conventional (commitlint.config.js:2).
- Test data: temp folders via makeTempFolder, writeProject, synthetic PDF/DOCX builders, FakeLlm in test/support/helpers.ts; fixtures in test/fixtures/fake-claude/claude and test/fixtures/recorded-cli-output/*.jsonl.
- External systems replaced: Claude CLI (fake-claude with FAKE_CLAUDE_* env vars), Anthropic API (not called), HOME/XDG_CONFIG_HOME sandboxed; real git used in git tests.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-QUAL-001 | FR-QUAL-001 | integration | The repository with dependencies installed, and a temporary copy of src/core/x.ts that imports node:fs | npm run check:arch (depcruise src --config .dependency-cruiser.cjs) is run | It exits non-zero and reports a violation for x.ts; with the file removed it exits 0 and reports no dependency violations. |
| TC-QUAL-002 | FR-QUAL-001, FR-QUAL-002 | integration | A temp non-test file in src/core importing commander, and another importing zod | The architecture check runs | Only the commander import is reported; the zod import is not. |
| TC-QUAL-003 | FR-QUAL-002 | integration | A src/core/*.test.ts file importing vitest | The architecture check runs | No violation is reported for that file. |
| TC-QUAL-004 | FR-QUAL-003 | integration | A temp file in src/application importing from src/adapters | The architecture check runs | A violation is reported. |
| TC-QUAL-005 | FR-QUAL-004 | integration | A temp file in src/adapters/config importing from src/adapters/llm, and another adapter importing src/cli | The architecture check runs | Both are reported as violations. |
| TC-QUAL-006 | FR-QUAL-005 | integration | A temp file in src/adapters/llm/claude-cli.ts-like location (not anthropic-api) importing @anthropic-ai/sdk | The architecture check runs | A violation is reported, while the anthropic-api adapter import is not. |
| TC-QUAL-007 | FR-QUAL-006 | integration | Two temp files in src/core importing each other | The architecture check runs | A circular dependency error is reported. |
| TC-QUAL-008 | FR-QUAL-007 | integration | A temp file in src/cli containing `const x = 42;` and one in src/core/constants with the same line | npm run lint is run | A magic-number error is reported for the src/cli file only; `0`, `1`, `-1` literals produce no error. |
| TC-QUAL-009 | FR-QUAL-007 | integration | A temp src file with `export default 1` and no disable comment | npm run lint is run | A default-export lint error is reported; tsup.config.ts and vitest.config.ts pass. |
| TC-QUAL-010 | FR-QUAL-008 | integration | A temp file that indexes an array and uses the result as a definite string, or uses an optional property assigned undefined | npm run typecheck is run | tsc reports errors and exits non-zero; without the file it exits 0. |
| TC-QUAL-011 | FR-QUAL-009 | integration | The test suite and a temporary untested module added to src/core large enough to push core coverage below 90% | npm run test:coverage is run | It exits non-zero citing the threshold; without the module it exits 0. |
| TC-QUAL-012 | FR-QUAL-010 | manual | Dependencies installed | npm run test:mutation is run and the report is inspected | Only files under src/core are mutated, test files and guidelines-baseline.ts are not, and the score is compared to 70 (low) and 85 (high); a lower score does not make the command exit non-zero. |
| TC-QUAL-013 | FR-QUAL-011 | integration | Dependencies installed and a deliberate lint error in a file | npm run verify is run | It exits non-zero; with the error removed it runs lint, typecheck, check:arch, coverage tests and e2e, does not start Stryker, and exits 0. |
| TC-QUAL-014 | FR-QUAL-012 | integration | commitlint with the repo config | The messages `feat: add x` and `added stuff` are each linted | The first passes; the second fails with a type/subject error. |
| TC-QUAL-015 | FR-QUAL-013 | integration | A src file with wrong formatting and a badly formatted file in test/fixtures or sdd/ | npm run lint is run | Only the src file is reported by Prettier; ignored paths are not checked. |
| TC-QUAL-016 | FR-QUAL-014, FR-QUAL-020 | e2e | A fresh checkout with no dist folder | npm run test:e2e is run | The build creates dist/main.js (and a sourcemap) first, then the e2e tests run bin/luseen.js; running the e2e tests directly without a build fails. |
| TC-QUAL-017 | FR-QUAL-014 | integration | Test files placed in src/core, test/integration and test/e2e | npm test is run | The src/**/*.test.ts and test/integration tests are discovered and executed. |
| TC-QUAL-018 | FR-QUAL-015, FR-QUAL-019 | e2e | A sandbox HOME, restricted PATH with the fake claude, and FAKE_CLAUDE_MODE set to each of auth-error, usage-limit, invalid-output, hang, invalid-model | bin/luseen.js is run against a sample project with --yes | The fake is the only claude called, the call is recorded to the FAKE_CLAUDE_RECORD file with args and prompt, the real HOME is untouched, and each mode yields the expected failure outcome. |
| TC-QUAL-019 | FR-QUAL-016 | integration | Any test using makeTempFolder | The test finishes | The temp folder no longer exists and each test got a different folder path. |
| TC-QUAL-020 | FR-QUAL-017 | manual | A verification document with TC IDs and the test files | Test names are listed (e.g. vitest list) | Each automated TC has a test whose name starts with its ID, and manual TCs have written steps. |
| TC-QUAL-021 | FR-QUAL-018 | unit | The fixtures budget.jsonl, invalid-model.jsonl and success.jsonl | Each is fed to the Claude CLI output parser | success yields a parsed result, budget yields the budget-exhausted error, invalid-model yields the invalid-model error; a malformed line is rejected without crashing. |
| TC-QUAL-022 | FR-QUAL-021 | integration | The source tree plus a temporary file in `src/application` that imports `@modelcontextprotocol/sdk` | Run `npm run check:arch` | It fails naming the rule; after removing the file it passes |
