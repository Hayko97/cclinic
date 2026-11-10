# Technology stack

| Category | Name | Version | Evidence |
|---|---|---|---|
| Language | TypeScript | ~6.0.3 | `package.json:52`, `sdd/stack.md:9` |
| Runtime | Node.js | >=22.18 (.nvmrc: 26) | `package.json:17-19`, `.nvmrc:1`, `bin/cclinic.js:5` |
| Build | tsup | ^9.0.0 | `package.json:51`, `tsup.config.ts:1` |
| Test | Vitest with coverage-v8 | ^5.1.0 | `package.json:47`, `vitest.config.ts:1` |
| Test | Stryker Mutator | ^10.1.1 | `package.json:44-45`, `stryker.config.json:2` |
| Lint | ESLint + typescript-eslint | ^10.14.0 / ^8.72.1 | `package.json:49`, `package.json:53`, `eslint.config.js:5` |
| Formatting | Prettier | ^3.9.10 | `package.json:50`, `.prettierrc.json:2` |
| Architecture check | dependency-cruiser | ^18.7.2 | `package.json:48`, `.dependency-cruiser.cjs:3-41` |
| Commit lint | commitlint config-conventional | ^21.2.4 | `package.json:42-43`, `commitlint.config.js:2` |
| Library | commander | ^15.1.0 | `package.json:35` |
| Library | @inquirer/prompts | ^8.7.5 | `package.json:34` |
| Library | @anthropic-ai/sdk | ^1.6.0 | `package.json:33` |
| Library | zod | ^4.6.7 | `package.json:39` |
| Library | pdfjs-dist | ^6.5.438 | `package.json:38` |
| Library | mammoth | ^1.13.0 | `package.json:37` |
| Library | ignore | ^7.0.14 | `package.json:36` |
| Library | @modelcontextprotocol/sdk (MIT) | ^1.32.2 | `package.json:35`. Needed for the `cclinic mcp` server (FR-MCP-006): the official MCP implementation, maintained by the protocol's authors. Used only in `src/adapters/mcp/` |
| External tool | Claude Code CLI | tested 2.1.319 | `src/core/constants/llm.ts:9-11`, `sdd/stack.md:48` |
| External tool | Git | unknown | `sdd/stack.md:49`, `src/core/constants/git.ts:4` |
| Package manager | npm | unknown | `README.md:12-14`, `sdd/stack.md:13` |
| CI | CI (not among analysed files; runs npm ci and npm run verify per docs) | unknown | `sdd/stack.md:82` |

**Not found in the project:** Framework, Database.
