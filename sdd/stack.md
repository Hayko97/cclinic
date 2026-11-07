# Technology stack

Versions were checked against the npm registry and nodejs.org on 2026-11-07. Commit `package-lock.json` so that every install is identical, and recheck these versions when the build starts.

## Runtime

| Item | Choice | Notes |
|---|---|---|
| Language | TypeScript `~6.0.3` | Strict mode. **Don't use TypeScript 7 yet:** `typescript-eslint` 8.72 only supports versions below 6.1 |
| Runtime | Node.js `>=22.18` | Lowest version all the tools below support. Node 22, 24 and 26 are all LTS lines |
| Development Node version | Node.js 26 | Pin in `.nvmrc`. CI also tests on 22 |
| Modules | ESM | `"type": "module"` in `package.json` |
| Package manager | npm | `package-lock.json` is committed, and CI uses `npm ci` |
| Distribution | npm package with a `cclinic` binary | `npm install -g cclinic` or `npx cclinic` |
| Platforms | macOS, Linux, Windows | Use `node:path` for all paths, and don't assume a shell |

## Production dependencies

Only these. Adding another requires a good reason (see [developer-guidelines.md](developer-guidelines.md#16-dependencies)).

| Package | Version | Used for |
|---|---|---|
| `commander` | `^15.1.0` | Argument parsing, including options with optional values |
| `@inquirer/prompts` | `^8.7.5` | Console menus and confirmation |
| `ignore` | `^7.0.14` | `.gitignore`-style pattern matching |
| `pdfjs-dist` | `^6.5.438` | PDF text with page numbers |
| `mammoth` | `^1.13.0` | DOCX text |
| `zod` | `^4.6.7` | Schemas for LLM output and config, and JSON Schema generation |
| `@anthropic-ai/sdk` | `^1.6.0` | Anthropic API provider |

## Development tools

| Package | Version | Used for |
|---|---|---|
| `vitest`, `@vitest/coverage-v8` | `^5.1.0` | Tests and coverage |
| `tsup` | `^9.0.0` | Bundling |
| `eslint` | `^10.14.0` | Linting |
| `typescript-eslint` | `^8.72.1` | TypeScript lint rules |
| `prettier` | `^3.9.10` | Formatting |
| `dependency-cruiser` | `^18.7.2` | Enforcing the architecture's import rules |
| `@stryker-mutator/core` | `^10.1.1` | Mutation testing on core logic |
| `@commitlint/cli`, `@commitlint/config-conventional` | `^21.2.4` | Checking commit messages in CI |

## External requirements

| Requirement | Needed for |
|---|---|
| Claude Code CLI, logged in | The default provider. Tested on 2.1.319 |
| `ANTHROPIC_API_KEY` | The second provider |
| Network access to Anthropic | LLM stages only. Scanning and `--dry-run` work offline, except for token counting on the API provider |

## Standards

| Standard | Used for |
|---|---|
| [Agent Skills](https://agentskills.io/specification) | The format of the skills cclinic installs |
| [AGENTS.md](https://agents.md/) | Pointing other coding agents to the skills and documents |

## Claude models

Defined in `src/core/constants/models.ts`. See [llm-providers](specs/llm-providers/spec.md#model-constants), which also lists Codex models for later use.

| Choice | CLI value | API model ID |
|---|---|---|
| **Default: Sonnet 5.5 at medium** | `sonnet` | `claude-sonnet-5-5` |
| Opus 5.5 | `opus` | `claude-opus-5-5` |
| Haiku 5.5 | `haiku` | `claude-haiku-5-5` |
| Fable 5.1 | `fable` | `claude-fable-5-1` |

## Standard scripts

| Script | Does |
|---|---|
| `npm run build` | Bundle to `dist/` |
| `npm test` | Unit and integration tests |
| `npm run test:e2e` | Run the built binary against fixtures |
| `npm run test:mutation` | Mutation testing on core logic |
| `npm run lint` | ESLint and Prettier check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:arch` | `dependency-cruiser` import rules |
| `npm run verify` | All of the above except mutation testing. CI runs this on every change |
