# spec-output

## Goal

Validate the generated document set before saving, then write it to .luseen/sdd (or --out) atomically with overwrite protection for hand-edited or foreign folders, and deterministic Markdown output.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-OUT-001 | The tool must write the project-level documents README.md, overview.md, stack.md, architecture.md, developer-guidelines.md, open-questions.md, scan-report.md and manifest.json into <target>/.luseen/sdd/, or into the --out folder when given. | confirmed | `sdd/specs/spec-output/spec.md:9-27`, `src/core/rendering.ts:280-293`, `src/core/constants/paths.ts:3-43` |
| FR-OUT-002 | The tool must create, for each spec, a folder specs/<spec-name>/ containing exactly spec.md, validation.md and verification.md. | confirmed | `sdd/specs/spec-output/spec.md:44-60`, `src/core/rendering.ts:280-293` |
| FR-OUT-003 | The tool must always create open-questions.md, stating explicitly when there are no open questions. | confirmed | `sdd/specs/spec-output/spec.md:33`, `sdd/specs/spec-output/verification.md:9-18` |
| FR-OUT-004 | The tool must render validation.md as a table with columns ID, Covers, User need, Accepted when, and verification.md with test setup first followed by a table with columns ID, Covers, Level, Given, When, Then. | confirmed | `sdd/specs/spec-output/spec.md:46-60`, `sdd/specs/spec-output/verification.md:22-23`, `src/core/rendering.ts:267-295` |
| FR-OUT-005 | The tool must validate the generated data before saving, checking schema, ID format and uniqueness, that every requirement has at least one VAL and one TC, that every VAL and TC references an existing requirement, evidence citations pointing to analysed files within range, required guideline sections and link resolution. | confirmed | `sdd/specs/spec-output/spec.md:64-71`, `src/core/validation.ts:31-206` |
| FR-OUT-006 | When validation fails, the tool must list all failures, leave existing documents unchanged, save the rejected draft under .luseen/failed/ and exit with code 5. | confirmed | `sdd/specs/spec-output/spec.md:71`, `src/application/pipeline.ts:435-445`, `src/core/errors.ts:37-55` |
| FR-OUT-007 | The tool must publish documents by writing to a temporary folder on the same filesystem and swapping it into place only after validation passes, so that an interrupted run leaves either the complete old or the complete new folder. | confirmed | `sdd/specs/spec-output/spec.md:75`, `src/adapters/storage/document-store.ts:88-129`, `sdd/specs/spec-output/verification.md:27-28` |
| FR-OUT-008 | The tool must recover from an interrupted write on a later run, succeeding and leaving no leftover temporary folders. | confirmed | `src/adapters/storage/document-store.ts:88-129`, `sdd/specs/spec-output/verification.md:28` |
| FR-OUT-009 | The tool must refuse to regenerate when any generated file's hash differs from manifest.json, listing the changed files and exiting with the usage error code (2), unless --force is given. | confirmed | `sdd/specs/spec-output/spec.md:76`, `src/adapters/storage/document-store.ts:173-189`, `sdd/specs/spec-output/verification.md:29` |
| FR-OUT-010 | The tool must refuse to write into an existing non-empty output folder that has no valid manifest.json unless --force is given. | confirmed | `sdd/specs/spec-output/spec.md:77`, `src/adapters/storage/document-store.ts:173-189`, `sdd/specs/spec-output/verification.md:31` |
| FR-OUT-011 | The overwrite-protection check must run before any LLM call is made. | confirmed | `sdd/specs/spec-output/spec.md:76`, `src/adapters/storage/document-store.ts:173-189`, `sdd/specs/spec-output/verification.md:29` |
| FR-OUT-012 | With --force, the tool must fully replace hand-edited documents and its final message must list what was overwritten. | confirmed | `sdd/specs/spec-output/spec.md:108`, `sdd/specs/spec-output/verification.md:30` |
| FR-OUT-013 | A failed run with no previous documents must leave .luseen/failed/ and the cache but no sdd/ folder. | docs-only | `sdd/specs/spec-output/spec.md:109` |
| FR-OUT-014 | The tool must create a .gitignore containing * in .luseen/cache/ and .luseen/failed/. | confirmed | `sdd/specs/spec-output/spec.md:40`, `sdd/specs/spec-output/verification.md:19` |
| FR-OUT-015 | The tool must produce deterministic Markdown with stable ordering and no timestamps outside manifest.json, so that unchanged re-runs using the cache differ only in the manifest generation time. | confirmed | `sdd/specs/spec-output/spec.md:78`, `src/core/rendering.ts:1-11`, `sdd/specs/spec-output/verification.md:32` |
| FR-OUT-016 | The tool must escape pipe characters and line breaks in text from the target project and from Claude when rendering Markdown tables, so the column count stays correct. | confirmed | `sdd/specs/spec-output/spec.md:79`, `src/core/rendering.ts:272`, `sdd/specs/spec-output/verification.md:33` |
| FR-OUT-017 | manifest.json must record the luseen version, prompt version, generation time, provider, requested and actual model, reasoning level, hashes of analysed and generated files, and spec names, IDs and titles. | confirmed | `sdd/specs/spec-output/spec.md:39`, `src/core/schemas.ts:102-121`, `src/application/pipeline.ts:479-527` |
| FR-OUT-018 | scan-report.md must include included and skipped totals, skipped paths with reasons, extraction warnings and per-file redaction counts, must exclude tool folders (.luseen, .agents), and must never contain secret values. | confirmed | `sdd/specs/spec-output/spec.md:38`, `sdd/specs/spec-output/verification.md:17` |
| FR-OUT-019 | developer-guidelines.md must contain the unchanged language-neutral baseline template with stack-specific guidance added and labelled separately, and must still contain the baseline with a note when no language is detected. | confirmed | `sdd/specs/spec-output/spec.md:37`, `sdd/specs/spec-output/spec.md:83-110`, `src/core/guidelines-baseline.ts:6-28`, `sdd/specs/spec-output/verification.md:15-16` |
| FR-OUT-020 | stack.md must list technologies by category with version and evidence, and state when a category was not found; README.md must contain a table of all specs and explain IDs, statuses and reading order. | docs-only | `sdd/specs/spec-output/spec.md:34-35`, `sdd/specs/spec-output/verification.md:12-13` |

## Edge cases

- Output folder exists, is non-empty and has no manifest.json (refused without --force).
- A generated file was hand-edited after the last run (exit 2, no LLM call).
- Process killed during the write stage (old or new folder complete, rerun succeeds, no temp folders remain).
- Validation fails on first run with no previous docs (no sdd/ folder, draft in .luseen/failed/).
- Several validation faults at once (all listed, not just the first).
- Table cell text contains | or line breaks.
- No project language detected (baseline guidelines still produced with a note).
- No open questions (open-questions.md still created).
- Evidence line or page number out of range, or file not analysed.
- Stale temp folder or backup left by an earlier interrupted write.

## Non-goals

- Merging hand edits into regenerated documents.
- Non-Markdown outputs other than manifest.json.
- Tool-specific files such as .cursorrules.
- Run history.
- Executable test code.
