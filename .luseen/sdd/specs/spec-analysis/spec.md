# spec-analysis

## Goal

Group extracted project content into modules, summarise each with an LLM, combine the summaries into project-wide data, and generate traceable specs (requirements, acceptance criteria, test cases) with stable IDs, caching, resumability and validation, while keeping LLM calls to a minimum.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-ANA-001 | The system must group code and config files into modules by nearest package manifest, otherwise by first-level folder, otherwise into a root module. | confirmed | `sdd/specs/spec-analysis/spec.md:11-14`, `sdd/specs/spec-analysis/verification.md:9-10`, `src/core/chunking.ts:47-138` |
| FR-ANA-002 | The system must treat each document (PDF, DOCX, text document) as its own module. | confirmed | `sdd/specs/spec-analysis/spec.md:11-14`, `sdd/specs/spec-analysis/verification.md:9-10`, `src/core/chunking.ts:47-138` |
| FR-ANA-003 | The system must split modules and oversized files into chunks so that no request exceeds 150,000 estimated tokens, keeping files together where possible and splitting oversized files on line or page boundaries. | confirmed | `sdd/specs/spec-analysis/spec.md:14`, `sdd/specs/spec-analysis/verification.md:12`, `src/core/constants/limits.ts:21`, `src/core/chunking.ts:47-138` |
| FR-ANA-004 | The system must run module LLM calls in parallel up to the --concurrency value and must sort results by module before the next stage so completion order does not change output. | confirmed | `sdd/specs/spec-analysis/spec.md:13`, `sdd/specs/spec-analysis/verification.md:11`, `src/application/pipeline.ts:290-305`, `src/core/constants/limits.ts:9-16` |
| FR-ANA-005 | The system must validate each chunk summary against the module summary schema and merge the chunk results of a module into one summary. | confirmed | `sdd/specs/spec-analysis/spec.md:18`, `sdd/specs/spec-analysis/verification.md:13`, `src/core/schemas.ts:11-95`, `src/application/pipeline.ts:222-459` |
| FR-ANA-006 | The system must reject module summary items that lack evidence. | confirmed | `sdd/specs/spec-analysis/spec.md:18`, `sdd/specs/spec-analysis/verification.md:14`, `src/core/schemas.ts:11-95` |
| FR-ANA-007 | The system must combine all module summaries into project-wide data (overview, stack, architecture, guideline tailoring, spec list with relevant modules, open questions), combining in stages when the summaries exceed the request limit. | confirmed | `sdd/specs/spec-analysis/spec.md:19`, `sdd/specs/spec-analysis/verification.md:15`, `src/application/pipeline.ts:222-459` |
| FR-ANA-008 | The prompts must require evidence for every statement, require behaviour-level descriptions and forbid invented requirements, commands, test frameworks and paths. | confirmed | `sdd/specs/spec-analysis/spec.md:20`, `sdd/specs/spec-analysis/spec.md:41`, `sdd/specs/spec-analysis/verification.md:16`, `src/core/prompts.ts:9-57` |
| FR-ANA-009 | The system must treat project content as untrusted by wrapping it in <project_content> tags, escaping closing tags inside content, and instructing the model not to follow instructions found in it. | code-only | `src/core/prompts.ts:9-29`, `src/core/core.test.ts:362-371` |
| FR-ANA-010 | Each generated spec must have a unique kebab-case name that becomes its folder name. | confirmed | `sdd/specs/spec-analysis/spec.md:24`, `sdd/specs/spec-analysis/verification.md:17`, `src/core/validation.ts:104-134` |
| FR-ANA-011 | Every requirement must cite evidence in one of the accepted formats (path:line, path:start-end, path:page, path.docx#Heading); only open questions may cite a whole analysed file, and commit hashes must be rejected. | confirmed | `sdd/specs/spec-analysis/spec.md:25`, `sdd/specs/spec-analysis/verification.md:18`, `sdd/specs/spec-analysis/verification.md:45`, `src/core/validation.ts:31-68`, `src/core/git-history.test.ts:138-142` |
| FR-ANA-012 | Every requirement must have a status of exactly confirmed, code-only or docs-only, and conflicting evidence must not produce confirmed. | confirmed | `sdd/specs/spec-analysis/spec.md:26-34`, `sdd/specs/spec-analysis/verification.md:19-20`, `src/core/schemas.ts:11-95` |
| FR-ANA-013 | Disagreements between documents and code, or between documents, must be recorded as open questions citing both sides rather than silently resolved. | confirmed | `sdd/specs/spec-analysis/spec.md:34`, `sdd/specs/spec-analysis/spec.md:78`, `sdd/specs/spec-analysis/verification.md:20` |
| FR-ANA-014 | Every requirement must have at least one acceptance criterion (VAL) with an outcome and at least one test case (TC) with level (unit, integration, e2e or manual), Given, When and Then. | confirmed | `sdd/specs/spec-analysis/spec.md:38-40`, `sdd/specs/spec-analysis/verification.md:21-22`, `src/core/validation.ts:104-134` |
| FR-ANA-015 | When no test tools or commands are found in the project, the system must not invent them and must record an open question about the missing test setup. | confirmed | `sdd/specs/spec-analysis/spec.md:41`, `sdd/specs/spec-analysis/verification.md:24`, `sdd/specs/spec-analysis/verification.md:26` |
| FR-ANA-016 | Stack items must include versions and evidence, and the architecture description must report the actual architecture including problems such as circular dependencies, without invented technologies. | docs-only | `sdd/specs/spec-analysis/spec.md:45-46`, `sdd/specs/spec-analysis/validation.md:12`, `sdd/specs/spec-analysis/verification.md:25` |
| FR-ANA-017 | Guidelines must combine the fixed language-neutral baseline, which tailoring must not remove or change, with model-tailored sections labelled observed or recommended, where observed items require evidence. | confirmed | `sdd/specs/spec-analysis/spec.md:47-48`, `sdd/specs/spec-analysis/verification.md:27-28`, `src/core/guidelines-baseline.ts:6-28`, `src/core/validation.ts:164-172` |
| FR-ANA-018 | The system must pass previous manifest spec names, IDs and titles to the combine step so unchanged requirements keep their IDs. | confirmed | `sdd/specs/spec-analysis/spec.md:52`, `sdd/specs/spec-analysis/verification.md:30`, `src/core/prompts.ts:100-113` |
| FR-ANA-019 | Removed requirement IDs must be recorded as retired and never reused; new requirements must get new IDs. | confirmed | `sdd/specs/spec-analysis/spec.md:52`, `sdd/specs/spec-analysis/verification.md:30`, `src/application/pipeline.ts:489-499`, `src/core/validation.ts:100-102` |
| FR-ANA-020 | IDs must follow FR-<AREA>-NNN, VAL-<AREA>-NNN and TC-<AREA>-NNN with an AREA of 2-8 uppercase letters unique per spec and NNN of at least three digits. | confirmed | `sdd/specs/spec-analysis/spec.md:53`, `sdd/specs/spec-analysis/verification.md:32`, `src/core/validation.ts:104-134` |
| FR-ANA-021 | The system must cache module summaries, combine results and per-spec results in .luseen/cache/, keyed by file hashes, prompt version, model and reasoning level, so changes to any of these re-analyse only affected items. | confirmed | `sdd/specs/spec-analysis/spec.md:57`, `sdd/specs/spec-analysis/verification.md:33`, `src/core/constants/llm.ts:3-4`, `src/core/constants/paths.ts:3-43` |
| FR-ANA-022 | The system must ignore corrupt or invalid cache entries and replace them. | confirmed | `sdd/specs/spec-analysis/spec.md:59`, `sdd/specs/spec-analysis/verification.md:34` |
| FR-ANA-023 | The system must save each result to the cache as it completes so that a failed run resumes without redoing finished work, and an unchanged re-run must skip the combine call and make no provider calls. | confirmed | `sdd/specs/spec-analysis/spec.md:57-59`, `sdd/specs/spec-analysis/verification.md:35-36`, `src/application/pipeline.ts:156-187`, `src/application/pipeline.ts:270-285` |
| FR-ANA-024 | With --no-cache the system must call the provider for every module, and --force must not clear the cache or regenerate summaries. | confirmed | `sdd/specs/spec-analysis/spec.md:59`, `sdd/specs/spec-analysis/spec.md:69`, `sdd/specs/spec-analysis/verification.md:37`, `sdd/specs/spec-analysis/verification.md:43` |
| FR-ANA-025 | The system must generate each spec in its own LLM call that includes the project spec list, cache each spec result separately, and regenerate only specs that use a changed module. | confirmed | `sdd/specs/spec-analysis/spec.md:63`, `sdd/specs/spec-analysis/verification.md:38-39`, `src/application/pipeline.ts:222-459` |
| FR-ANA-026 | When a spec output is truncated, the system must retry once asking to split it into two specs, and on a second truncation must stop with exit code 4 naming the spec. | confirmed | `sdd/specs/spec-analysis/spec.md:64`, `sdd/specs/spec-analysis/verification.md:40-41`, `src/core/schemas.ts:11-95` |
| FR-ANA-027 | When a spec result has validation problems, the system must retry once with the problems, must not cache results with problems, and must regenerate cached results that have problems. | confirmed | `sdd/specs/spec-analysis/spec.md:65`, `sdd/specs/spec-analysis/verification.md:44`, `sdd/specs/spec-analysis/verification.md:46-47`, `src/application/pipeline.ts:435-445` |
| FR-ANA-028 | If a module LLM call fails after retries, the run must stop with exit code 4 and keep completed summaries cached. | confirmed | `sdd/specs/spec-analysis/spec.md:79`, `src/application/pipeline.ts:156-187`, `src/core/errors.ts:37-55` |
| FR-ANA-029 | Document-only projects must yield docs-only requirements with a stack stating no code found, and code-only projects must yield code-only requirements. | docs-only | `sdd/specs/spec-analysis/spec.md:77` |

## Edge cases

- Project with only documents: all requirements docs-only and stack says no code found.
- Project with only code: all requirements code-only.
- Single file larger than 150,000 estimated tokens is split on line or page boundaries.
- Module summaries too large for one combine request are combined in stages.
- Module LLM calls finish in random order; combine input must be identical.
- Corrupt cache file is ignored and regenerated.
- Spec output truncated twice stops the run with exit code 4 naming the spec.
- Spec result with a bad citation or missing TC is retried once; if still invalid the run fails with validation failure and nothing invalid is cached.
- Open question citing a whole file is allowed; requirement doing so is rejected.
- Project content containing a literal closing </project_content> tag or injected instructions.
- A requirement removed between runs: its ID is retired and not reused.
- Documents and code disagree: requirement is not confirmed and an open question cites both sides.
- Project with no test tooling: open question instead of invented commands.

## Non-goals

- Static analysis or AST parsing of code.
- Verifying that code behaviour matches specs.
- Asking the user interactive questions during analysis.
- Writing executable tests.
