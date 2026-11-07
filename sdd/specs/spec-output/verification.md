# Spec output: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** use `FakeLlmProvider` with canned data covering two specs, in a new temp copy of the fixture for each test. To check crash safety, run the built binary as a child process and kill it at a controlled point.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-OUT-001 | FR-OUT-001 | integration | Default options | Run | All listed files exist under `.cclinic/sdd/` |
| TC-OUT-002 | FR-OUT-001 | integration | `--out <temp folder>` | Run | All listed files exist in that folder, not in `.cclinic/sdd/` |
| TC-OUT-003 | FR-OUT-001 | integration | Data with no open questions | Run | `open-questions.md` exists and says there are none |
| TC-OUT-004 | FR-OUT-002 | integration | Data with two specs | Inspect `README.md` | It has a table of both specs, and covers reading order, IDs, statuses, the `docs-only` warning, open questions, guidelines and `verification.md` |
| TC-OUT-005 | FR-OUT-003 | integration | Stack data with a missing category | Inspect `stack.md` | Items have version and evidence, and the missing category says it wasn't found |
| TC-OUT-006 | FR-OUT-004 | integration | Canned architecture data | Inspect `architecture.md` | All required parts are present |
| TC-OUT-007 | FR-OUT-005 | integration | Canned tailoring | Inspect `developer-guidelines.md` | Every section in the table exists, baseline text is unchanged, and stack guidance is labelled |
| TC-OUT-008 | FR-OUT-005 | integration | Data with no detected language | Inspect `developer-guidelines.md` | The baseline is complete, and a note says stack guidance wasn't possible |
| TC-OUT-009 | FR-OUT-006 | integration | A project containing a marker secret, a skip and an extraction warning | Inspect `scan-report.md` | It has totals, skips, warnings and redaction counts, and the marker is absent |
| TC-OUT-010 | FR-OUT-007 | integration | A completed run | Parse `manifest.json` | All listed fields are present, and the hashes match actual files |
| TC-OUT-011 | FR-OUT-008 | integration | A git repository, with a run and a forced failure | Run `git status` | Neither `.cclinic/cache` nor `.cclinic/failed` is listed |
| TC-OUT-012 | FR-OUT-009 | integration | Data with two specs | List `specs/` | There's one folder per spec, named after it, with exactly three files |
| TC-OUT-013 | FR-OUT-010 | integration | Canned spec data | Inspect `spec.md` | It has a goal, and requirements with ID, statement, status and evidence |
| TC-OUT-014 | FR-OUT-011 | integration | Canned spec data | Parse `validation.md` | Every row has the four columns in order, and covers each `FR` |
| TC-OUT-015 | FR-OUT-012 | integration | Canned spec data | Parse `verification.md` | Setup comes first, every row has the six columns in order, and each `FR` is covered |
| TC-OUT-016 | FR-OUT-013 | unit | Each fault separately: duplicate ID, `FR` with no `VAL`, `FR` with no `TC`, `VAL` or `TC` pointing to an unknown `FR`, a missing evidence file, a line or page out of range, a missing guidelines section, a broken link | Validate | Each is detected and named in the result |
| TC-OUT-017 | FR-OUT-013 | unit | Fully valid data | Validate | No problems are reported |
| TC-OUT-018 | FR-OUT-014 | integration | Existing documents, and invalid new data | Run | All failures are listed, existing documents are unchanged, a draft is in `.cclinic/failed/`, and exit code is 5 |
| TC-OUT-019 | FR-OUT-015 | e2e | Existing documents, with the process killed during the write stage | Kill it, and inspect the folder | The folder is either the complete old version or the complete new one |
| TC-OUT-020 | FR-OUT-015 | e2e | The leftovers of a killed run | Run again | It succeeds, and no temp folders remain |
| TC-OUT-021 | FR-OUT-016 | e2e | A generated file edited by hand | Run with no `--force` | The file is listed, exit code is 2, and the fake `claude` isn't run |
| TC-OUT-022 | FR-OUT-016 | integration | A generated file edited by hand | Run with `--force` | The documents are replaced, and the final message lists the overwritten file |
| TC-OUT-023 | FR-OUT-017 | integration | `--out` pointing to a folder with unrelated files | Run with and without `--force` | Without it, it refuses and the files are untouched. With it, it proceeds |
| TC-OUT-024 | FR-OUT-018 | integration | An unchanged project, using the cache | Run twice | Markdown files are byte-identical, and only `manifest.json`'s time differs |
| TC-OUT-025 | FR-OUT-019 | unit | Text containing a pipe and line breaks | Render table rows | The tables parse with the right number of columns |
| TC-OUT-026 | FR-OUT-001, FR-OUT-002, FR-OUT-009 | manual | A real project, and an AI coding tool pointed at the generated `README.md` | Ask the tool questions about the project | It finds and uses the right documents |
