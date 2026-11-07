# Architecture

## Style

cclinic is a local command-line pipeline built with **ports and adapters** (hexagonal architecture). The analysis logic sits in the middle, and everything that touches the outside world (the terminal, filesystem, Claude) is a replaceable adapter.

The one rule that matters most: **source code dependencies point inward.** Inner code knows nothing about outer code.

## Pipeline

```
discover → extract → redact → chunk → summarise modules → combine → generate specs → render → validate → write
└────────── local only ──────────┘   └───────────── Claude ─────────────────┘   └───── local only ─────┘
```

Nothing leaves the machine until redaction has run and the user has confirmed (or passed `--yes`).

| Stage | Input | Output | Spec |
|---|---|---|---|
| Discover | Target folder | Included files, skipped files with reasons | [file-discovery](specs/file-discovery/spec.md) |
| Extract | Included files | Text with line or page positions | [content-extraction](specs/content-extraction/spec.md) |
| Redact | Extracted text | Text with secrets replaced | [file-discovery](specs/file-discovery/spec.md) |
| Chunk | Redacted text | Request-sized chunks, grouped by module | [spec-analysis](specs/spec-analysis/spec.md) |
| Summarise | Module chunks | One structured summary per module, cached | [spec-analysis](specs/spec-analysis/spec.md) |
| Combine | Module summaries | Project-wide data and a list of specs | [spec-analysis](specs/spec-analysis/spec.md) |
| Generate specs | Spec list, relevant summaries | Each spec's content, one call per spec, cached | [spec-analysis](specs/spec-analysis/spec.md) |
| Render | Structured data | Markdown files | [spec-output](specs/spec-output/spec.md) |
| Validate, write | Rendered files | Checked documents swapped into place | [spec-output](specs/spec-output/spec.md) |

## Layers

```
┌───────────────────────────────────────────────┐
│ cli: parses input, wires everything together  │  composition root
├───────────────────────────────────────────────┤
│ adapters                                      │
│   llm/claude-cli   llm/anthropic-api          │  talk to the outside world
│   discovery  extraction  output/writer  config│
├───────────────────────────────────────────────┤
│ application: pipeline.ts                      │  order of stages, retries, budget
├───────────────────────────────────────────────┤
│ core                                          │  pure logic and types
│   rules  redaction  chunking  grouping        │  no I/O
│   schemas  prompts  rendering  validation     │
│   ports (LlmProvider, FileSystem, Cache, Clock)│
└───────────────────────────────────────────────┘
          dependencies point downward only
```

## Planned source layout

```
bin/cclinic.js      checks the Node.js version, then starts dist/main.js
src/
  cli/              main.ts, commands, menus, options, reporter
  application/      pipeline.ts: stage orchestration, budget tracking
  core/
    ports.ts        LlmProvider, Cache, DocumentStore, Logger interfaces
    errors.ts       typed errors and exit codes
    constants/      models.ts: Claude and Codex models, reasoning levels, prices
                    llm.ts: provider limits, beta names, environment variable names
                    limits.ts: flag defaults and thresholds
                    paths.ts: file and folder names
                    discovery.ts: exclusion lists and skip reasons
                    terminal.ts: command-line output values
    models.ts       parsing, resolving and cost logic that uses those constants
    node-version.ts supported Node.js and Claude CLI versions
    exclusion-rules.ts
    redaction.ts
    chunking.ts     module grouping and chunking
    schemas.ts
    prompts.ts
    rendering.ts
    guidelines-baseline.ts
    agent-skills.ts the skills cclinic installs, and the AGENTS.md section
    validation.ts
  adapters/
    llm/            claude-cli.ts, anthropic-api.ts, select-provider.ts, retry.ts
    discovery/      file-walker.ts
    extraction/     extract.ts
    storage/        document-store.ts: cache, safe writes, hand-edit checks, lock
                    skill-installer.ts: installs skills without touching others' work
    config/         user-config.ts
test/
  fixtures/         fake claude command and recorded CLI output
  support/          helpers, sample documents, FakeLlm
  integration/
  e2e/
```

Sample projects are created in temp folders by each test, rather than kept as fixture folders.

Unit tests sit next to the code they test, as `*.test.ts`.

### Import rules

`npm run check:arch` enforces these with `dependency-cruiser`, and a violation fails CI.

| Folder | May import | MUST NOT import |
|---|---|---|
| `core/` | Other `core/` files, `zod` | Node I/O modules, `adapters/`, `application/`, `cli/` |
| `application/` | `core/` | `adapters/`, `cli/`, provider SDKs |
| `adapters/` | `core/`, external libraries | `application/`, `cli/`, other adapter folders |
| `cli/` | Anything. This is the only place concrete classes are created | Not applicable |

Only `adapters/llm/anthropic-api.ts` may import `@anthropic-ai/sdk`, and only `adapters/llm/claude-cli.ts` may run `claude` generation calls.

## Main interface

```ts
interface LlmProvider {
  readonly name: "claude-cli" | "anthropic-api";
  readonly isSubscription: boolean;
  describeAuth(): Promise<string>;
  estimateTokens(text: string, model: ModelChoice): Promise<number>;
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

interface LlmRequest<T> {
  system: string;        // fixed instructions
  prompt: string;        // delimited project content
  schema: ZodType<T>;
  model: ModelChoice;
  effort: Effort;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

interface LlmResult<T> {
  data: T;               // always passed schema validation
  actualModel: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}
```

`generate` returns validated data or throws a typed error: `AuthError`, `RateLimitError`, `RefusalError`, `TruncatedError`, `SchemaError`, `BudgetError` or `ProviderError`. `cli/` is the only place these errors become messages and exit codes.

## Data locations

| Location | Contents | Commit to git? |
|---|---|---|
| `<target>/.cclinic/sdd/` | Generated documents | Yes |
| `<target>/.cclinic/cache/` | Module summaries | No. cclinic adds its own `.gitignore` |
| `<target>/.cclinic/failed/` | Rejected drafts, for inspection | No. cclinic adds its own `.gitignore` |
| `<target>/.cclinic/.lock` | Process ID of the active run. Removed when it ends | No |
| `<target>/.agents/skills/`, `<target>/.claude/skills/` | Skills for the project's coding agent | Yes |
| `<target>/AGENTS.md` | A marked section, pointing agents to the skills and documents | Yes |
| `~/.config/cclinic/config.json` | Saved model and reasoning level only | Not applicable |

## Security model

- **Scanned content is untrusted.** It can contain text written to manipulate the model. It's sent as delimited data, and Claude is given no tools, so injected instructions can't trigger actions. The worst outcome is misleading content, which evidence citations and validation help to expose.
- **Project content goes to Anthropic**, through either provider. The summary and confirmation before each run make this clear.
- **Secrets** are excluded and redacted before anything is sent, and API keys are never written to disk or logs.

## Key decisions

| Decision | Reason |
|---|---|
| TypeScript rather than Go | Faster to build, with stronger PDF and DOCX libraries. LLM calls dominate run time in any language |
| Claude CLI as the default provider | Works with an existing login, without managing an API key |
| Provider fallback only at startup | Users should never be billed on a different account by surprise |
| Whole-folder swap when writing | A failed run can never leave a half-updated set of documents |

New significant decisions are recorded as ADRs (see [developer-guidelines.md](developer-guidelines.md#4-architecture)).

## Build risks

Tackle these first during implementation.

| Risk | Why it matters | First step |
|---|---|---|
| PDF extraction quality | Multi-column and table-heavy PDFs can come out scrambled | Try `pdfjs-dist` on real PDFs before building on it |
| Cost and speed on very large repos | Each module means a Claude call, so runs could be slow or expensive | Test on a large repo early, and tune module size and concurrency |
| `ANTHROPIC_API_KEY` with the Claude CLI | A key in the environment may change which account the CLI bills. Not yet observed | Test with a key set, then confirm what `authMethod` reports |
| `claude` CLI output changes | cclinic depends on its JSON output, which could change between versions | Keep parsing inside `claude-cli.ts`, with tests against recorded output |
| Secret redaction gaps | Pattern matching can't catch every secret | Be clear in the docs that redaction is best-effort, and test real-world formats |
| `claude` on Windows | An npm-installed `claude.cmd` may not start without a shell, and the guidelines prohibit using one | Test both Windows install types early |
