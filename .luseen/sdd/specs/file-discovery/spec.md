# file-discovery

## Goal

Find the project's own code and documents on any technology stack, excluding dependencies, build output, binaries and secrets, and record and report every skipped file with a reason.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-DISC-001 | Each path must be checked against the exclusion rules in a fixed order (secrets, tool folders, --exclude, --include, ignore files, dependency/build folders, binaries, lockfiles/minified/generated/oversized, otherwise keep), and the first matching rule must decide and supply the skip reason. | confirmed | `sdd/specs/file-discovery/spec.md:11-20`, `src/core/exclusion-rules.ts:72-102`, `src/core/core.test.ts:115-125` |
| FR-DISC-002 | Secret files (.env*, *.pem, *.key, id_rsa etc., .npmrc, anything in .ssh or .aws) and tool folders such as .git and .luseen must never be read or included, and no option including --include "**" may override this. | confirmed | `sdd/specs/file-discovery/spec.md:37`, `sdd/specs/file-discovery/verification.md:11`, `src/core/exclusion-rules.ts:28-37`, `src/core/constants/discovery.ts:72-84` |
| FR-DISC-003 | --exclude patterns must take precedence over --include patterns, and --include must force-keep files that would otherwise be skipped by ignore, dependency, binary, lockfile, minified or size rules (but not secrets or tool folders). | confirmed | `sdd/specs/file-discovery/spec.md:13-15`, `sdd/specs/file-discovery/verification.md:9-10`, `src/core/exclusion-rules.ts:71-102` |
| FR-DISC-004 | The scan must honour .gitignore files at every level and an optional .luseenignore in the target root, using gitignore syntax, with or without a Git repository. | confirmed | `sdd/specs/file-discovery/spec.md:25`, `sdd/specs/file-discovery/verification.md:13-14`, `src/adapters/discovery/file-walker.ts:105-208` |
| FR-DISC-005 | Folders with known dependency or build names must be skipped at any depth by exact name match, except that lib, bin and src are never skipped by name and packages is skipped only when it contains .nupkg files directly or in an immediate subfolder. | confirmed | `sdd/specs/file-discovery/spec.md:26-27`, `sdd/specs/file-discovery/verification.md:15-18`, `src/core/constants/discovery.ts:4-18` |
| FR-DISC-006 | Binary files must be skipped by known binary extension or by a NUL byte in the first 8 KB, while .pdf and .docx must be treated as documents and not skipped as binary. | confirmed | `sdd/specs/file-discovery/spec.md:28`, `sdd/specs/file-discovery/verification.md:19-21`, `src/adapters/discovery/file-walker.ts:129-166` |
| FR-DISC-007 | Lockfiles, minified files (.min.js, .min.css), source maps, and bundled files with average line length above 500 characters must be skipped unless forced in. | confirmed | `sdd/specs/file-discovery/spec.md:29-31`, `sdd/specs/file-discovery/verification.md:22-24`, `src/core/exclusion-rules.ts:112-126` |
| FR-DISC-008 | Files containing @generated or DO NOT EDIT within their first 20 lines must be skipped as generated. | confirmed | `sdd/specs/file-discovery/spec.md:32`, `sdd/specs/file-discovery/verification.md:22`, `src/adapters/discovery/file-walker.ts:129-166` |
| FR-DISC-009 | Text files above the size limit (default 1 MiB, configurable with --max-file-size-mib from 1 to 50) and documents above 50 MiB must be skipped, while files exactly at the limit are kept. | confirmed | `sdd/specs/file-discovery/spec.md:33`, `sdd/specs/file-discovery/verification.md:25`, `sdd/specs/file-discovery/verification.md:38`, `src/core/constants/limits.ts:9-26` |
| FR-DISC-010 | Secret-shaped text in included files (at least AWS keys, Anthropic/OpenAI keys, GitHub tokens, Slack tokens, JWTs, private key blocks and connection-string credentials) must be replaced with [REDACTED:<type>] before content is used, preserving line numbers, and reports must show only file and count, never the secret. | confirmed | `sdd/specs/file-discovery/spec.md:38`, `sdd/specs/file-discovery/verification.md:27-30`, `src/core/redaction.ts:15-52`, `src/application/pipeline.ts:86-101` |
| FR-DISC-011 | Redaction of 1 MB of adversarial input must complete in under 1 second and must leave non-secret lookalikes such as Git commit hashes unchanged. | docs-only | `sdd/specs/file-discovery/verification.md:29-30` |
| FR-DISC-012 | Symlinks must not be followed, so files outside the target are never read and symlink loops do not hang the scan. | confirmed | `sdd/specs/file-discovery/spec.md:42`, `sdd/specs/file-discovery/verification.md:31`, `src/adapters/discovery/file-walker.ts:105-208` |
| FR-DISC-013 | Files must be processed in sorted path order, producing the same result for an unchanged project, and each included file must be classified as code, config or document. | confirmed | `sdd/specs/file-discovery/spec.md:43-44`, `sdd/specs/file-discovery/verification.md:32-33`, `src/adapters/discovery/file-walker.ts:105-208` |
| FR-DISC-014 | Every skipped file must be recorded with a reason (a skipped folder may be a single entry), unreadable files (e.g. permission denied, or a forced-in binary that is not readable as text) must be recorded as skipped without stopping the scan, and the records must feed scan-report.md. | confirmed | `sdd/specs/file-discovery/spec.md:21`, `sdd/specs/file-discovery/spec.md:44-45`, `sdd/specs/file-discovery/verification.md:12`, `sdd/specs/file-discovery/verification.md:34-35`, `src/adapters/discovery/file-walker.ts:36-39` |
| FR-DISC-015 | When no files remain after discovery, luseen must not call an LLM for analysis, and must report it as cli-commands FR-CLI-040 says: an empty folder offers a new project, and a set-up project exits 2. | confirmed | `src/cli/generate-command.ts:335-339`, `.luseen/sdd/specs/cli-commands/spec.md` FR-CLI-040, `user request 2026-11-20` |

## Edge cases

- A folder named my_vendor or a file named build is not skipped, because folder names match exactly.
- A packages/ folder without .nupkg files is kept; with a .nupkg directly inside or in an immediate subfolder it is skipped.
- A project folder named vendor or build can be restored with --include "vendor/**".
- A binary file forced in with --include that cannot be read as text is reported as skipped.
- @generated or DO NOT EDIT after line 20 does not make a file generated.
- Files exactly at the size limit are kept.
- A .env.example file is skipped as a secret-type file.
- Symlinks pointing outside the target and symlink loops.
- Permission-denied files are skipped and the scan continues (POSIX only).
- Git submodules are scanned as ordinary files unless ignored.
- A folder containing only node_modules results in no files, so it counts as empty when it has no `.luseen/sdd`.

## Non-goals

- Guaranteeing that every secret is caught; redaction is best-effort.
- Reading dependency manifests to identify third-party code.
- Detecting vendored code copied into first-party folders.
