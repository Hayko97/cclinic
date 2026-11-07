# Spec output

## Goal

Create a folder of checked, traceable documents that AI coding tools and automation testers can use directly, and never damage existing documents when a run fails.

## Generated folder

```
<target>/.cclinic/
  sdd/
    README.md                 how AI tools and testers should use these documents
    overview.md               purpose, users, scope, glossary
    stack.md                  languages, frameworks, tools and versions
    architecture.md           structure, dependencies, data flow
    developer-guidelines.md   best practices, tailored to the stack
    open-questions.md         conflicts and unknowns
    scan-report.md            what was analysed and skipped
    manifest.json             run details and file hashes
    specs/
      <spec-name>/
        spec.md               requirements
        validation.md         acceptance criteria
        verification.md       test cases for automation testers
  cache/                      not committed
  failed/                     rejected drafts, not committed
```

## Requirements

### Project-level documents

- **FR-OUT-001** cclinic MUST create all the files above in `.cclinic/sdd/`, or in the `--out` folder when given. `open-questions.md` MUST be created even when there are no open questions, and say so.
- **FR-OUT-002** The generated `README.md` MUST include a table of all specs and tell readers the reading order, what the IDs and statuses mean, that `docs-only` requirements may not be built, and to check `open-questions.md` before relying on a disputed requirement. It MUST state that AI tools follow `developer-guidelines.md`, and that testers use `verification.md`.
- **FR-OUT-003** `stack.md` MUST list technologies by category, with version and evidence for each, and say when a category wasn't found.
- **FR-OUT-004** `architecture.md` MUST contain the main parts and their responsibilities, how they depend on each other, data flow, external systems, and any structural problems found.
- **FR-OUT-005** `developer-guidelines.md` MUST contain every section listed in [developer guidelines](#developer-guidelines), with the baseline text unchanged, followed by labelled, stack-specific guidance.
- **FR-OUT-006** `scan-report.md` MUST include included and skipped totals, skipped paths with reasons, extraction warnings, and redaction counts per file. It MUST NOT include any secret values. Tool folders such as `.cclinic` and `.agents` MUST be left out, because they appear only after the first run, and would change the report between identical runs.
- **FR-OUT-007** `manifest.json` MUST include the cclinic version, prompt version, generation time, provider, requested and actual model, reasoning level, the hash of each analysed file, the hash of each generated file, and all spec names, IDs and titles.
- **FR-OUT-008** cclinic MUST create a `.gitignore` containing `*` in both `.cclinic/cache/` and `.cclinic/failed/`, so they aren't committed.

### Spec folders

- **FR-OUT-009** Each spec MUST have its own folder at `specs/<spec-name>/`, containing exactly `spec.md`, `validation.md` and `verification.md`.
- **FR-OUT-010** `spec.md` MUST contain a goal, requirements (each with ID, statement, status and evidence), edge cases where known, and non-goals where known.
- **FR-OUT-011** `validation.md` MUST list every acceptance criterion in this format:

  ```markdown
  | ID | Covers | User need | Accepted when |
  |---|---|---|---|
  | VAL-AUTH-001 | FR-AUTH-001 | I can log in | A valid user reaches their dashboard |
  ```

- **FR-OUT-012** `verification.md` MUST begin with test setup (project test tools and commands, where found, plus any test data and external systems to replace) and then list every test case in this format:

  ```markdown
  | ID | Covers | Level | Given | When | Then |
  |---|---|---|---|---|---|
  | TC-AUTH-001 | FR-AUTH-001 | e2e | A registered user | They log in with a wrong password | An error shows, and no session is created |
  ```

### Validation before saving

- **FR-OUT-013** Before saving, cclinic MUST check that:
  - All data matches its schema
  - IDs are correctly formatted and unique, and each spec folder has all three files
  - Every `FR` has at least one `VAL` and one `TC`, and every `VAL` and `TC` points to an existing `FR`
  - Every piece of evidence points to an analysed file, with lines or pages in range
  - All required `developer-guidelines.md` sections are present
  - Links between generated files resolve
- **FR-OUT-014** If validation fails, cclinic MUST list every failure, keep any existing documents unchanged, save the rejected draft to `.cclinic/failed/` for inspection, and exit with code 5.

### Safe writing

- **FR-OUT-015** Output MUST be written to a temp folder on the same filesystem as the destination, and moved into place only after validation passes. A crash at any point MUST NOT leave a partly written folder.
- **FR-OUT-016** If any generated file's hash differs from `manifest.json`, cclinic MUST list the changed files and exit with the usage error code unless `--force` is set. This check MUST run before any LLM call, so no usage is wasted.
- **FR-OUT-017** If the output folder exists, has files, and has no `manifest.json`, cclinic MUST refuse to use it unless `--force` is set, because it may not be cclinic's folder.
- **FR-OUT-018** Generated Markdown MUST use stable ordering, and the generation time MUST appear only in `manifest.json`, so re-runs with no changes don't create noisy git diffs.
- **FR-OUT-019** Text from the target project and from Claude MUST be escaped where it's placed into Markdown tables, so `|` and line breaks can't break the format.

## Developer guidelines

cclinic ships a language-neutral baseline as a template, adapted from [cclinic's own guidelines](../../developer-guidelines.md). It's not generated by the model, so it stays consistent and complete on every run. The generated file MUST include these sections:

| Section | Baseline content | Stack-specific additions |
|---|---|---|
| Core principles | KISS, YAGNI, DRY, clarity | None |
| SOLID | All five principles, with guidance on when not to over-apply them | Examples in the project's language |
| Other design principles | Composition, functional core, immutability, parsing at boundaries | Language idioms |
| Architecture | Dependency rule, boundaries, ADRs | The project's actual layers and boundaries |
| Naming | General rules | Casing and file naming for the stack, and observed conventions |
| Language rules | None | Type safety, formatting and idioms for each detected language |
| Functions, modules and comments | Size, parameters, side effects, where hardcoded values belong, comments that explain why | Observed conventions |
| Error handling | Operational or programmer errors, central handling, clear messages | Language and framework idioms |
| Async and concurrency | Limits, timeouts, cancellation | Language and framework idioms |
| Security | Input validation, secrets, injection, dependencies | Risks for the detected frameworks |
| Logging and performance | No sensitive data, measure first | Project's tools, if found |
| Testing | Test pyramid, FIRST, Arrange-Act-Assert, doubles, determinism, traceability to `TC` IDs | Project's test tools and commands |
| Dependencies | Justify, pin and isolate | Package manager |
| Git and pull requests | Conventional Commits, small changes, tests in the same change | Observed branch and commit conventions |
| Code review | Review checklist | None |
| Definition of done | Checklist | Project's commands |
| Sources | Links to primary sources | None |

## Edge cases

- If nothing changed since the last run, all results come from the cache, and the output matches the previous run except for the generation time.
- A failed run on a project with no previous documents leaves `.cclinic/failed/` and the cache, but no `sdd/` folder.
- With `--force`, hand-edited documents are replaced completely. The final message lists what was overwritten.
- A project with no detected language still gets the baseline guidelines, and a note that stack-specific guidance wasn't possible.

## Non-goals

- Merging hand edits with regenerated content.
- Output formats other than Markdown, apart from `manifest.json`.
- Tool-specific files such as `CLAUDE.md` or `.cursorrules`. Skills and `AGENTS.md` are covered by [agent-skills](../agent-skills/spec.md).
- Keeping a history of past runs. Git does this.
- Executable test code. `verification.md` only describes the tests.
