# Spec analysis

## Goal

Turn extracted content into accurate, traceable project documentation and specs, using as few LLM calls as possible and making clear what's known and what isn't.

## Requirements

### Grouping and chunking

- **FR-ANA-001** Code and config files MUST be grouped into modules: the nearest folder holding a package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `*.csproj` and similar), or otherwise the first-level folder. Files in the root form a `root` module.
- **FR-ANA-002** Each document MUST be its own module, so requirements can be traced to specific documents.
- **FR-ANA-003** LLM calls MUST run in parallel up to `--concurrency`. Results MUST be sorted by module before the next stage, so that the completion order can't change the result.
- **FR-ANA-004** A request MUST NOT exceed 150,000 estimated tokens of content. Larger modules MUST be split, keeping files together where possible. Files larger than the limit MUST be split on line or page boundaries.

### Summarising and combining

- **FR-ANA-005** Each module MUST produce a structured summary that passes a schema containing: purpose, capabilities, data and interfaces, business rules, technologies, coding conventions, and test or build commands, with evidence for each item. Summaries of chunks from one module MUST be merged.
- **FR-ANA-006** All summaries MUST then be combined into project-wide data that passes a schema containing: overview, stack, architecture, guideline tailoring, a list of specs with the modules relevant to each, and open questions. If the summaries exceed the limit in FR-ANA-004, they MUST be combined in stages. Spec contents MUST be generated separately (FR-ANA-025).
- **FR-ANA-007** Prompts MUST describe what the project does and how to check it, rather than restating the code. They MUST require evidence, and MUST NOT allow invented requirements.

### Specs

- **FR-ANA-008** Each spec MUST cover one user-facing or system capability, rather than mirroring the folder structure. It MUST have a unique `kebab-case` name, which becomes its folder name.
- **FR-ANA-009** Every requirement MUST cite at least one piece of evidence: `path:line` or `path:start-end` for text files, `document.pdf:page` for PDFs, and `document.docx#Heading` for DOCX files.
- **FR-ANA-010** Every requirement MUST have one status:

| Status | Meaning |
|---|---|
| `confirmed` | Both code and documents support it, and they agree |
| `code-only` | Found in code, with no supporting documents |
| `docs-only` | Found in documents, with nothing in code. Possibly not built yet |

- **FR-ANA-011** When documents and code disagree, the disagreement MUST be recorded as an open question citing both sides. The model MUST NOT silently pick one.

### Validation and verification content

- **FR-ANA-012** Every requirement MUST have at least one acceptance criterion (`VAL`), written from the user's point of view, with an outcome that can be judged as accepted or not, and with no implementation details.
- **FR-ANA-013** Every requirement MUST have at least one test case (`TC`) with a level (`unit`, `integration`, `e2e` or `manual`), a Given, a When, and a Then with a checkable result, detailed enough for an automation tester to write the test without reading the code.
- **FR-ANA-014** Test cases MUST include error and edge cases where the requirement or evidence implies them, not only the success path.
- **FR-ANA-015** Commands, test frameworks and test paths MUST come from the project, such as its package scripts, Makefile or CI config. Where none are found, test cases MUST stay independent of tools, and an open question MUST record the missing test setup. They MUST NOT be invented.

### Project-level content

- **FR-ANA-016** The stack MUST list languages, frameworks, databases, test tools, build tools and CI tools, with versions as stated in manifests. Each item MUST cite evidence. Anything uncertain MUST be recorded as an open question rather than guessed.
- **FR-ANA-017** The architecture MUST describe the actual structure found: main parts, their responsibilities, how they depend on each other, data flow and external systems. Problems, such as circular dependencies, MUST be reported factually.
- **FR-ANA-018** Developer guidelines MUST combine a built-in, language-neutral baseline (see [spec-output](../spec-output/spec.md#developer-guidelines)) with sections tailored by the model to the detected stack. The model MUST NOT remove baseline rules.
- **FR-ANA-019** Each tailored guideline MUST be labelled either `observed` (the project already does this, with evidence) or `recommended` (a best practice for this stack). Where the project's conventions differ from common practice, the guidelines MUST state the project's convention and record the difference, rather than telling developers to break consistency.

### Stable IDs

- **FR-ANA-020** When a previous `manifest.json` exists, its spec names, IDs and titles MUST be given to the combine step, so unchanged requirements keep their IDs. A new requirement gets a new ID, and IDs of removed requirements MUST NOT be reused.
- **FR-ANA-021** IDs MUST use the formats `FR-<AREA>-NNN`, `VAL-<AREA>-NNN` and `TC-<AREA>-NNN`, where `AREA` is 2 to 8 uppercase letters unique to a spec, and `NNN` is at least three digits.

### Cache

- **FR-ANA-022** Module summaries MUST be cached in `.cclinic/cache/`, keyed by the hashes of the module's files, the prompt version, model and reasoning level. Changing any of these MUST cause that module to be analysed again. A corrupt cache entry MUST be ignored and replaced.
- **FR-ANA-023** Summaries MUST be saved as soon as each one completes, so a failed run can resume without repeating finished work. The combine step MUST be cached with a key based on all summaries.
- **FR-ANA-024** `--force` MUST NOT clear the cache. It only allows overwriting hand-edited documents.

### Output limits

- **FR-ANA-025** Each spec's requirements, acceptance criteria and test cases MUST be generated in a separate LLM call, with its own cached result, because a large project's output wouldn't fit in one response. Calls MUST receive the list of specs, so each stays within its own scope and IDs don't collide.
- **FR-ANA-026** If a spec's output is cut off by the output limit, cclinic MUST retry once, asking for the capability to be split into two specs. A second cut-off MUST stop the run with code 4 and name the spec.
- **FR-ANA-028** After generating a spec, cclinic MUST check its evidence and coverage. If there are problems, it MUST retry that spec once, listing them. Problems that remain are reported by final validation.

### Refreshing

- **FR-ANA-027** `--no-cache` MUST ignore existing cached results and analyse everything again, and MUST still save new results to the cache.

## Edge cases

- A project with only documents gets requirements that are all `docs-only`, and a stack section stating that no code was found. A project with only code gets `code-only` requirements.
- Conflicts between two documents are recorded as open questions in the same way as conflicts between documents and code.
- If one module's LLM call fails after retries, the run stops with code 4 rather than generating documents with a missing part. Completed summaries stay cached.

## Non-goals

- Static analysis or parsing code into syntax trees. Claude reads the source directly.
- Checking whether the code actually behaves as its specs say.
- Asking the user questions during a run. Unknowns go to `open-questions.md`.
- Writing executable test code. `verification.md` describes the tests only.
