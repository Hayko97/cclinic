# spec-output: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test framework: Vitest (vitest.config.ts); unit and integration tests are in src/**/*.test.ts and test/integration, e2e tests in test/e2e.
- Run the full check with the project's npm run verify script (package.json:30); mutation testing uses Stryker (stryker.config.json).
- Each test uses a fresh temporary copy of a fixture project; FakeLlmProvider supplies canned data covering two specs.
- E2E and crash-safety tests run the built binary (bin/cclinic.js, built with tsup) as a child process, using the fake claude executable test/fixtures/fake-claude/claude in place of the real Claude CLI.
- Replace external systems: Claude CLI, Anthropic API, network. Git is needed only to check ignore behaviour.
- Helpers are in test/support/helpers.ts.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-OUT-001 | FR-OUT-001, FR-OUT-003, FR-OUT-017 | integration | A temp copy of the fixture project and FakeLlmProvider canned data for two specs with no open questions. | The pipeline runs with default output. | .cclinic/sdd contains README.md, overview.md, stack.md, architecture.md, developer-guidelines.md, open-questions.md (stating there are no open questions), scan-report.md and manifest.json; manifest hashes match the files on disk. |
| TC-OUT-002 | FR-OUT-001 | e2e | A temp fixture project and fake claude executable. | The built CLI runs with --out <custom-dir> --yes. | The documents appear in <custom-dir> and not in .cclinic/sdd. |
| TC-OUT-003 | FR-OUT-002, FR-OUT-004 | integration | Canned data with two specs. | Output is generated. | specs/ holds one folder per spec with exactly spec.md, validation.md, verification.md; validation.md header has 4 columns (ID, Covers, User need, Accepted when); verification.md has test setup before a 6-column table (ID, Covers, Level, Given, When, Then). |
| TC-OUT-004 | FR-OUT-005, FR-OUT-006 | unit | Generated data with each single fault: duplicate ID, requirement without VAL, requirement without TC, VAL or TC referencing unknown requirement, evidence file not analysed, line or page out of range, missing guidelines section, broken link. | The validation function runs on each. | Each fault is reported by name; valid data reports no problems. |
| TC-OUT-005 | FR-OUT-006 | integration | Existing valid docs in .cclinic/sdd and a provider returning data with two faults. | The pipeline runs. | Both faults are listed, existing docs are byte-identical, a draft exists in .cclinic/failed/, and the exit code is 5. |
| TC-OUT-006 | FR-OUT-013, FR-OUT-006 | integration | No previous .cclinic/sdd and invalid generated data. | The pipeline runs. | No sdd/ folder exists; .cclinic/failed/ holds the draft; the cache exists. |
| TC-OUT-007 | FR-OUT-007, FR-OUT-008 | e2e | Existing docs and the built binary run as a child process. | The process is killed during the write stage, then the CLI is run again. | After the kill the folder is either the complete old or complete new set; the rerun succeeds and no temp or backup folders remain. |
| TC-OUT-008 | FR-OUT-009, FR-OUT-011 | e2e | Previously generated docs where one generated file was edited by hand; fake claude records invocations. | The CLI runs without --force. | Exit code is 2, the changed file is listed, and the fake claude was not invoked. |
| TC-OUT-009 | FR-OUT-012 | e2e | Same hand-edited state as TC-OUT-008. | The CLI runs with --force. | Exit code is 0, the edited file is replaced by generated content, and the final message lists it as overwritten. |
| TC-OUT-010 | FR-OUT-010 | e2e | An --out folder containing unrelated files and no manifest.json. | The CLI runs without --force, then with --force. | The first run is refused with exit code 2 and the files are untouched; the second run proceeds. |
| TC-OUT-011 | FR-OUT-014 | integration | A temp git repository with a completed run. | git status and git check-ignore are run on .cclinic/cache and .cclinic/failed. | Both folders contain a .gitignore with * and are ignored. |
| TC-OUT-012 | FR-OUT-015 | integration | An unchanged project with a warm cache. | Generation runs twice into separate output folders. | All Markdown files are byte-identical; only generatedAt in manifest.json differs. |
| TC-OUT-013 | FR-OUT-016 | unit | Requirement and criteria text containing \| and newline characters. | The tables are rendered. | Each rendered row parses with the correct column count and the text is preserved. |
| TC-OUT-014 | FR-OUT-018 | integration | A fixture with skipped files, an extraction warning and a file containing a fake secret that is redacted. | scan-report.md is generated. | It lists totals, skipped paths with reasons, the warning and the redaction count, does not contain the secret value, and does not list .cclinic or .agents paths. |
| TC-OUT-015 | FR-OUT-019 | integration | Two projects: one with a detected language and one with none. | developer-guidelines.md is generated. | Both contain the identical baseline text; the first adds a labelled stack-specific section; the second contains a note that no language was detected. |
| TC-OUT-016 | FR-OUT-020 | integration | Canned stack data with one category empty. | stack.md and README.md are generated. | stack.md lists items with version and evidence and states the empty category was not found; README.md has a table of all specs and sections on IDs, statuses and reading order. |
| TC-OUT-017 | FR-OUT-001, FR-OUT-020 | manual | An AI coding tool and a real generated .cclinic/sdd/README.md. | The tool is asked questions about the project. | It finds and uses the correct documents from the README. |
