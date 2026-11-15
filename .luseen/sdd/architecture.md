# Architecture

## Main parts

| Part | Responsibility | Depends on | Evidence |
|---|---|---|---|
| bin | Executable entry; Node version guard then imports dist/main.js | cli | `bin/luseen.js:4-13` |
| cli | Composition root: commander commands, options, menus, reporter, exit codes, wiring of adapters | application, adapters, core | `src/cli/main.ts:69-173`, `src/cli/generate-command.ts:290-519` |
| application | Pipeline: summarise, combine, generate specs, validate, publish; caching and budget | core | `src/application/pipeline.ts:222-459`, `.dependency-cruiser.cjs:16-21` |
| adapters | Implement ports: file walker, extraction, git, LLM providers (claude-cli, anthropic-api), document store, skill installer, user config | core | `src/core/ports.ts:28-102`, `.dependency-cruiser.cjs:22-33` |
| core | Pure logic, constants, schemas, prompts, validation, rendering, redaction, chunking, errors, ports | zod | `.dependency-cruiser.cjs:5-15`, `src/core/ports.ts:1` |
| tests | Unit (colocated), integration and e2e tests with fake claude and helpers | cli, adapters, core | `vitest.config.ts:16-18`, `test/fixtures/fake-claude/claude:1-117` |

## Data flow

- discover -> extract -> redact -> chunk -> summarise modules (LLM) -> combine (LLM) -> generate specs (LLM) -> render -> validate -> atomically write .luseen/sdd
- Cache in .luseen/cache, rejected drafts in .luseen/failed, lock in .luseen/.lock
- Git history (14 days, messages and paths) feeds combine and spec stages
- Skills and AGENTS.md/CLAUDE.md installed after generation

## External systems

- Claude Code CLI (claude -p)
- Anthropic API
- Git
- npm registry (doctor version check)
- Filesystem

## Structural problems

- Core ports named inconsistently in architecture.md: layer diagram lists LlmProvider, FileSystem, Cache, Clock while source layout lists LlmProvider, Cache, DocumentStore, Logger; src/core/ports.ts defines LlmProvider, ContentExtractor, Cache, DocumentStore, Logger, PipelineDeps. `sdd/architecture.md:46`, `sdd/architecture.md:59`, `src/core/ports.ts:28-102`
