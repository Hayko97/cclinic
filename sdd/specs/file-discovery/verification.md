# File discovery: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** rule tests use pure functions with no filesystem. Walker tests use a new temp folder for each test. Use spies on file reads to prove that secret files are never opened.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-DISC-001 | FR-DISC-001 | unit | Paths matching two or more rules, such as `.env` with `--include`, or `vendor/a.dll` | Evaluate the rules | The first rule in the specified order decides, and its reason is returned |
| TC-DISC-002 | FR-DISC-001 | unit | A path matched by both `--include` and `--exclude` | Evaluate the rules | It's skipped, because `--exclude` comes first |
| TC-DISC-003 | FR-DISC-002 | integration | `.env`, `.git/config` and `.cclinic/x` with `--include "**"` | Scan | All stay skipped, each with a reason |
| TC-DISC-004 | FR-DISC-002 | integration | A DLL with `--include "**/*.dll"` | Scan | It's reported as skipped because it can't be read as text |
| TC-DISC-005 | FR-DISC-003 | integration | A folder that isn't a git repository, with root and nested `.gitignore` files, including negated patterns | Scan | All patterns are honoured at the right levels |
| TC-DISC-006 | FR-DISC-003 | integration | A `.cclinicignore` in the root | Scan | Its patterns are honoured with `.gitignore` syntax |
| TC-DISC-007 | FR-DISC-004 | integration | Every listed folder name at the root and nested two levels deep, each with a source file | Scan | None of their files are included |
| TC-DISC-008 | FR-DISC-004 | unit | A folder named `my_vendor`, and a file named `build` | Evaluate the rules | They're kept, because only exact folder names match |
| TC-DISC-009 | FR-DISC-005 | integration | `lib/`, `bin/` and `src/` with source files | Scan | All are included |
| TC-DISC-010 | FR-DISC-005 | integration | A `packages/` of source files, a `packages/` with a `.nupkg` directly inside, and one with `.nupkg` in an immediate subfolder | Scan | Only the last two are skipped |
| TC-DISC-011 | FR-DISC-006 | unit | Each listed binary extension | Evaluate the rules | Each is skipped as binary |
| TC-DISC-012 | FR-DISC-006 | integration | A `.txt` file with a NUL byte in its first 8 KB | Scan | It's skipped as binary |
| TC-DISC-013 | FR-DISC-006 | integration | Valid `.pdf` and `.docx` files | Scan | Both are included as documents |
| TC-DISC-014 | FR-DISC-007 | unit | Each listed lockfile, `a.min.js`, `a.min.css` and `a.js.map` | Evaluate the rules | Each is skipped with the right reason |
| TC-DISC-015 | FR-DISC-007 | integration | A bundle averaging 600 characters a line, and a normal file | Scan | Only the bundle is skipped |
| TC-DISC-016 | FR-DISC-007 | integration | `@generated` on line 1, `DO NOT EDIT` on line 20, and the marker on line 21 | Scan | The first two are skipped, and the third is kept |
| TC-DISC-017 | FR-DISC-007 | integration | Text files at exactly 1 MiB and just above, and documents at exactly 50 MiB and just above | Scan | Only the files above the limits are skipped |
| TC-DISC-018 | FR-DISC-008 | integration | Each listed secret file holding `MARKER-SECRET`, and a spy on file reads | Scan with `--include "**"` | None of them are opened, and the marker appears nowhere in results |
| TC-DISC-019 | FR-DISC-009 | unit | One sample per secret type in source text | Redact | Each is replaced with `[REDACTED:<type>]`, and surrounding text is unchanged |
| TC-DISC-020 | FR-DISC-009 | unit | Text that looks similar to a secret but isn't, such as a Git commit hash | Redact | It's unchanged |
| TC-DISC-021 | FR-DISC-009 | integration | A code file containing a secret, and a fake provider | Run the pipeline | The secret is absent from prompts and the report, and the report shows the file and count |
| TC-DISC-022 | FR-DISC-009 | unit | Very long inputs of 1 MB built to slow down patterns | Redact | It finishes in under 1 second |
| TC-DISC-023 | FR-DISC-010 | integration | A symlink to a file outside the target, and a symlink loop | Scan | The outside file isn't read, and the scan finishes |
| TC-DISC-024 | FR-DISC-011 | unit | A fake filesystem returning entries in shuffled order | Scan twice | The results are identical and sorted |
| TC-DISC-025 | FR-DISC-012 | unit | `.ts`, `package.json`, `.yaml`, `.md`, `.pdf` and `.docx` files | Classify | Each gets the right type |
| TC-DISC-026 | FR-DISC-012 | integration | A file with no read permission (POSIX only) | Scan | It's recorded as skipped, and other files are scanned |
| TC-DISC-027 | FR-DISC-013 | integration | `sample-project` | Compare results with a full listing | Every file is either included or covered by a skipped entry with a reason |
| TC-DISC-028 | FR-DISC-014 | e2e | A folder containing only `node_modules` | Run `cclinic --yes` | A clear message prints, it exits 2, and the fake `claude` isn't run |
| TC-DISC-029 | FR-DISC-004, FR-DISC-006, FR-DISC-007 | manual | Real Node, .NET, Python, Java and Go projects | Run `--dry-run` and review | No third-party files are included, and no first-party files are wrongly skipped |
| TC-DISC-030 | FR-DISC-007 | integration | A 3 MiB text file | Scan with `--max-file-size-mib 5`, then with the default | It's kept the first time and skipped the second |
