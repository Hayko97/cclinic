# file-discovery: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test framework: Vitest with coverage-v8 (vitest.config.ts); tests are colocated *.test.ts under src/ and under test/integration and test/e2e.
- Relevant existing tests: src/core/core.test.ts (rule tests), test/integration/discovery-extraction.test.ts (walker), test/e2e/cli.test.ts (CLI), helpers in test/support/helpers.ts. The package.json verify script is the project-wide check.
- Rule and redaction tests are pure functions with no filesystem; walker tests create a fresh temporary folder per test.
- Use file-read spies to prove secret files are never opened.
- Replace Claude with the fake executable test/fixtures/fake-claude/claude for e2e runs; no real LLM or network is used.
- Permission-denied test is POSIX only.
- Manual: run cclinic --dry-run on real Node, .NET, Python, Java and Go projects.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-DISC-001 | FR-DISC-001 | unit | A path that matches several rules, e.g. a file inside node_modules that is also matched by --include. | The exclusion rules are evaluated for that path. | The result is from the first matching rule in the documented order and includes that rule's reason. |
| TC-DISC-002 | FR-DISC-002 | integration | A temp folder with .env, .env.example, server.pem, .ssh/config, .git/config and .cclinic/x, plus a normal source file, and file-read spies. | Discovery runs with --include "**". | None of the secret or tool-folder files are included, each is recorded as skipped with a reason, and the spies show none were opened. |
| TC-DISC-003 | FR-DISC-003 | unit | A file matched by both --include and --exclude patterns. | The rules are evaluated. | The file is skipped as excluded; a file matched only by --include inside an ignored or dependency folder is kept. |
| TC-DISC-004 | FR-DISC-004 | integration | Temp folders (one with git repo, one without) with root .gitignore, nested .gitignore with a negation, and a .cclinicignore. | Discovery runs. | Ignored files are skipped per gitignore syntax, negated files are kept, and .cclinicignore entries are skipped, in both folders. |
| TC-DISC-005 | FR-DISC-005 | integration | Folders node_modules, my_vendor, vendor, a file named build, lib/, bin/, src/, and packages/ without .nupkg. | Discovery runs. | node_modules and vendor are skipped; my_vendor, build file, lib, bin, src and packages are kept. |
| TC-DISC-006 | FR-DISC-005 | integration | packages/ with a .nupkg directly inside, and another packages/ with .nupkg in an immediate subfolder. | Discovery runs. | Both packages folders are skipped with a reason; with --include "packages/**" files are kept. |
| TC-DISC-007 | FR-DISC-006 | integration | A .dll, a .png, an extensionless file with a NUL byte in the first 8 KB, a .pdf and a .docx. | Discovery runs. | The .dll, .png and NUL-byte file are skipped as binary; the .pdf and .docx are included as documents. |
| TC-DISC-008 | FR-DISC-006, FR-DISC-014 | integration | A binary .dll in the target. | Discovery runs with --include "**". | The .dll is reported as skipped because it cannot be read as text. |
| TC-DISC-009 | FR-DISC-007 | integration | package-lock.json, app.min.js, site.min.css, app.js.map, and a bundle whose lines average about 600 characters. | Discovery runs. | All five are skipped with distinct reasons; a normal file with short lines is kept. |
| TC-DISC-010 | FR-DISC-008 | integration | One file with @generated on line 5, one with DO NOT EDIT on line 20, one with the marker on line 25. | Discovery runs. | The first two are skipped as generated; the third is included. |
| TC-DISC-011 | FR-DISC-009 | integration | Text files of exactly 1 MiB and 1 MiB + 1 byte, a document just over 50 MiB, and one exactly 50 MiB. | Discovery runs with default limits. | The exact-limit files are kept; the larger ones are skipped with a size reason. |
| TC-DISC-012 | FR-DISC-009 | e2e | A project with a 3 MiB text file. | cclinic --dry-run is run with default settings, then with --max-file-size-mib 5. | The file is listed as skipped by default and as included with the raised limit. |
| TC-DISC-013 | FR-DISC-010 | unit | Text containing an AWS key, Anthropic key, OpenAI key, GitHub token, Slack token, JWT, private key block and a connection string with password. | Redaction is applied. | Each secret is replaced with [REDACTED:<type>], the line count is unchanged, and the original secret strings are absent from the output. |
| TC-DISC-014 | FR-DISC-010 | integration | A source file with a secret and a fake provider that records prompts. | The pipeline runs and scan-report.md is produced. | The secret appears in no prompt or report; the report shows the file name and redaction count only. |
| TC-DISC-015 | FR-DISC-011 | unit | A 1 MB hostile string designed to cause slow matching, and a text containing a 40-character Git commit hash. | Redaction is applied and timed. | It finishes in under 1 second and the commit hash is unchanged. |
| TC-DISC-016 | FR-DISC-012 | integration | A symlink pointing to a file outside the target and a symlink loop, on a POSIX system. | Discovery runs. | The outside file's content is never read, the scan finishes without hanging, and links are not followed. |
| TC-DISC-017 | FR-DISC-013 | integration | A folder with files created in non-alphabetical order, including code, config and document files. | Discovery runs twice. | Both runs return identical lists sorted by path, with files classified as code, config or document. |
| TC-DISC-018 | FR-DISC-014 | integration | A file with permissions removed (POSIX only) among readable files. | Discovery runs. | The unreadable file is recorded as skipped with a reason and the other files are still discovered. |
| TC-DISC-019 | FR-DISC-014, FR-DISC-001 | integration | A sample project containing a mix of included, ignored, binary and dependency files. | Discovery runs. | Every file is either in the included list or covered by a skipped entry (file or folder) with a non-empty reason. |
| TC-DISC-020 | FR-DISC-015 | e2e | A folder containing only node_modules and the fake claude executable. | cclinic --yes is run. | A clear message about no files is printed, exit code is 2, and the fake claude is never invoked. |
| TC-DISC-021 | FR-DISC-001, FR-DISC-006, FR-DISC-005 | manual | Real Node, .NET, Python, Java and Go projects. | cclinic --dry-run is run on each. | No third-party or binary files are included and no first-party files are wrongly skipped. |
