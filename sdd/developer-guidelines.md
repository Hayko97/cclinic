# Developer guidelines

These rules apply to all cclinic code, whether written by a person or an AI tool. **MUST** rules are mandatory, and most are enforced automatically ([section 19](#19-enforcement)). **SHOULD** rules are the default, and can be broken when there's a clear reason, which goes in the pull request or a code comment.

Numeric limits in these guidelines (function length, coverage and so on) are this project's own choices, not industry standards. Sources are [listed at the end](#20-sources).

## 1. Core principles

- **Clarity first.** Code is read far more often than it's written. Choose the version the next reader will understand fastest.
- **KISS.** Choose the simplest design that meets the spec.
- **YAGNI.** Don't build for needs that aren't in a spec. Features the code doesn't need yet are a form of over-engineering.
- **DRY, with judgement.** Every piece of knowledge should have one source (for example, the model list in `src/core/constants/models.ts`). Don't merge code that merely looks alike but changes for different reasons. Wait for a third repetition before abstracting.
- **Leave it better.** Every change should improve, or at least not worsen, the health of the code.

## 2. SOLID

Apply SOLID to reduce the cost of change, not for its own sake. An interface with one implementation and no test need is usually just extra indirection.

### S: Single Responsibility

"Each software module should have one and only one reason to change." Robert Martin stresses that this is about people: a module should answer to one group or concern, so that a change for one doesn't break another. It doesn't mean "does only one thing".

- **Do:** keep exclusion rules, file walking and scan reporting separate. They change for different reasons.
- **Don't:** let a `claude-cli.ts` also format console messages.

### O: Open/Closed

Software should be open for extension but closed for modification: add behaviour with new code rather than by editing working code.

- **Do:** add a new document format by adding an extractor and registering it.
- **Don't:** add `if (provider === "...")` branches throughout the pipeline.

### L: Liskov Substitution

Any implementation of an interface must be usable wherever that interface is expected, without surprising the caller.

- **Do:** make both providers return validated data and throw the same typed errors.
- **Don't:** let one provider return `null` where the other throws.

### I: Interface Segregation

Callers shouldn't depend on methods they don't use. Prefer small, focused interfaces.

- **Do:** give a function that only reads files a small `ReadFile` type.
- **Don't:** create one large `Services` object passed everywhere.

### D: Dependency Inversion

High-level logic and low-level details should both depend on abstractions, with the abstraction owned by the high-level side.

```ts
// Good: the pipeline depends on a port it owns, and cli/ passes in the implementation
export async function runPipeline(deps: { llm: LlmProvider; fs: FileSystem }, options: RunOptions) { /* ... */ }

// Bad: the pipeline is tied to one provider and can't be tested without it
import { ClaudeCliProvider } from "../adapters/llm/claude-cli.js";
```

Pass dependencies through function parameters or constructors. **MUST NOT** use a dependency injection framework, a service locator or a global singleton. They aren't needed at this size.

## 3. Other design principles

- **Composition over inheritance.** Use functions and small objects. Use class inheritance only for typed errors.
- **Functional core, imperative shell.** Keep logic in pure functions in `core/`, and keep I/O at the edges. Pure code is easy to test and reason about.
- **Law of Demeter.** Talk to direct collaborators. `a.b.c.d()` usually means a missing method or a wrong boundary.
- **Parse, don't validate.** Turn unknown input into a trusted type once at the boundary, so inner code doesn't check it again.
- **Make illegal states unrepresentable.** Prefer discriminated unions to several optional fields that must be set together.
- **Immutability by default.** Use `const` and `readonly`, and return new values rather than changing arguments.

## 4. Architecture

See [architecture.md](architecture.md) for cclinic's structure.

- **MUST** follow the dependency rule: source code dependencies only point inward. `core/` knows nothing about the filesystem, terminal or Claude.
- **MUST** pass data across boundaries in the form the inner layer wants. Raw `claude` JSON and SDK types stay inside their adapters.
- **MUST** create concrete adapters only in `cli/`, the composition root.
- **MUST NOT** add an import that breaks the [import rules](architecture.md#import-rules).
- **SHOULD** organise files by purpose rather than by technical type. Avoid folders such as `utils/` and `helpers/`.
- **MUST NOT** run I/O or other side effects when a module is imported.
- **Record significant decisions.** A decision that's expensive to reverse goes in `sdd/decisions/NNNN-short-title.md` as an Architecture Decision Record, with: context, decision, alternatives considered, and consequences. ADRs are never edited after acceptance except for status. A new ADR replaces an old one.

## 5. Naming

Names should be clear to a new reader, without being unnecessarily long.

| Item | Style | Example |
|---|---|---|
| Files and folders | `kebab-case` | `exclusion-rules.ts` |
| Classes, interfaces, types | `UpperCamelCase` | `LlmProvider`, `ScanResult` |
| Functions, variables, properties | `lowerCamelCase` | `estimateTokens` |
| Global constants | `CONSTANT_CASE` | `MAX_CHUNK_TOKENS` |
| Test files | `<module>.test.ts` | `chunking.test.ts` |
| CLI options | `--kebab-case` | `--max-budget-usd` |
| Generated spec folders | `kebab-case` | `specs/user-login/` |

**Rules:**

- **Functions** start with a verb: `extractPdfText`, not `pdfText`. Functions returning booleans read as questions: `isBinaryFile`, `hasManifest`.
- **Booleans** use `is`, `has`, `can` or `should`, in the positive: `isEnabled`, not `isNotDisabled`.
- **Collections** are plural: `skippedFiles`. Maps say what they map: `modelByAlias`.
- **Include units** when a number has one: `timeoutMs`, `maxBudgetUsd`, `fileSizeBytes`.
- **Acronyms** are treated as words: `loadHttpUrl`, not `loadHTTPURL`. This also keeps `LlmProvider` readable.
- **No abbreviations** made by dropping letters: `message`, not `msg`. Common terms such as `id`, `url` and `api` are fine. Very short names are only for scopes of about 10 lines, such as `i` in a loop.
- **No decoration:** no `I` prefix on interfaces, no `T` on types, no leading or trailing underscores, no `opt_` on parameters.
- **Avoid vague words:** `Manager`, `Helper`, `Util`, `Data`, `Info`, `Processor`. If the name is hard to find, the responsibility may be unclear.
- **Same concept, same word.** Don't mix `fetch`, `get` and `load` for one idea. Use the terms in the [glossary](overview.md#glossary).

The Google style guide uses `snake_case` file names. This project uses `kebab-case`, which is common in the Node.js ecosystem. Either works, but use only one.

## 6. TypeScript

- **MUST** enable `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `exactOptionalPropertyTypes` and `noFallthroughCasesInSwitch`.
- **MUST NOT** use `any`. Use `unknown` and narrow it. A rare exception needs a comment explaining why.
- **MUST** validate all outside data with `zod` at the boundary: LLM output, config files, `claude` JSON and `manifest.json`.
- **SHOULD** avoid `as` and `!`. Prefer a runtime check. If one is needed, add a comment saying why it's safe.
- **MUST** use named exports. **MUST NOT** use default exports, which lack a canonical name and make refactoring harder.
- **MUST** use `import type` for type-only imports.
- **SHOULD** let types be inferred when obvious, and annotate exported functions' parameters and return types.
- **MUST** define fixed sets of values, such as model IDs, statuses and modes, in one place: an `as const` object in a constants file, or an `enum`. Prefer the `as const` object, and derive its type from it (see [Hardcoded values](#hardcoded-values)).
- **MUST** make `switch` statements on unions exhaustive, ending with a check on `never`.
- **MUST** use `===`, `const` by default, `let` when needed, and never `var`.
- **MUST NOT** use `eval`, `new Function` or dynamic `import()` with computed paths.

## 7. Functions and modules

- A function does one job at one level of detail. **SHOULD** stay under about 40 lines. Longer is fine if it reads straight through, as a `switch` might.
- **SHOULD** take at most 3 parameters. Beyond that, use a named options object.
- **MUST NOT** use boolean flags that change what a function does. Write two functions: `renderSpec` and `renderSpecPreview`, not `render(true)`.
- **SHOULD** return early rather than nest. More than 3 levels of nesting usually needs a new function.
- Exported functions in `core/` **MUST** have no side effects.
- **SHOULD** keep files under about 300 lines. A longer file often has more than one reason to change.
- Each folder exposes its public functions through explicit exports. Don't reach into another folder's internals.
- **MUST** keep values out of logic, as described in [Hardcoded values](#hardcoded-values).

### Hardcoded values

**MUST NOT** write a value directly in logic. Give it a name, and keep it in the right place:

| Kind of value | Where it goes | Examples |
|---|---|---|
| Fixed set of options | Enum or constants file | Model IDs, reasoning levels, statuses, exit codes |
| Limits and defaults | Constants file, overridable by a flag or environment variable where users need that | Timeouts, retry counts, token limits |
| Technical identifiers | Constants file | API beta names, environment variable names, file names, folder names |
| Differs between environments or deployments | Environment variable, or an `.env` file for local development | Service URLs, region, log level |
| Secrets | Environment variable or secret manager. **Never** in code, constants or a committed file | API keys, passwords, tokens |
| Changes without a release, or is managed by users or admins | Database, when the project has one. Otherwise a config file | Customer plans, feature settings, catalogues |

**Rules:**

- **One source.** Each value is defined once. Everything else imports it, including menus, validation and error messages.
- **Constants files** live in `src/core/constants/`, grouped by subject: `models.ts`, `llm.ts`, `limits.ts`, `paths.ts`, `discovery.ts` and `terminal.ts`. Names use `CONSTANT_CASE`.
- **Environment values** are read and validated once at startup, in one module, and passed in as parameters. Read `process.env` nowhere else.
- **`.env` files** are never committed. Commit a `.env.example` with names and no real values. cclinic itself has no `.env` file or database: it uses constants, `CCLINIC_*` environment variables and its saved config file.

```ts
// Bad: the ID and limit are buried in logic, and repeated wherever they're needed
if (model === "claude-sonnet-5-5") request.max_tokens = 64000;

// Good: named once, in src/core/constants/, and imported here
import { CLAUDE_MODELS } from "../constants/models.js";
import { MAX_OUTPUT_TOKENS } from "../constants/llm.js";

if (model === CLAUDE_MODELS.SONNET.apiId) request.max_tokens = MAX_OUTPUT_TOKENS;
```

**Allowed in place:**

- `0`, `1` and `-1` in simple arithmetic and indexing
- A message used once, such as an error or log message
- Expected values in tests, which should be stated plainly so the test can be read on its own

## 8. Comments and documentation

- Comments explain **why**, not what. If a comment explains what the code does, first try clearer names.
- **Good uses:** non-obvious constraints, workarounds, surprising behaviour, and links to specs. For example: `// is_error, not subtype: an invalid model returns subtype "success". See FR-LLM-008`.
- Exported functions in `core/` and all ports **SHOULD** have short JSDoc comments.
- **MUST NOT** leave commented-out code. Git keeps the history.
- `TODO`s **MUST** include a linked issue or a requirement ID.
- **MUST** update documentation in the same change as the behaviour, and remove it when code is deleted.

## 9. Error handling

- **Separate two kinds of error:**
  - *Operational errors* are expected: file not found, rate limit, invalid input. Handle them, and give a helpful message.
  - *Programmer errors* are bugs. Don't try to carry on. Fail with exit code 1 and a report.
- **MUST** throw only `Error` subclasses from `core/errors.ts`, always with `new`. **MUST NOT** throw strings or other primitives.
- **MUST** handle errors centrally. Only `cli/` turns errors into messages and exit codes. Inner code **MUST NOT** call `process.exit` or print to the console.
- **MUST** keep the original error: `new ProviderError("Claude CLI failed", { cause: error })`.
- **MUST NOT** swallow errors. An empty `catch` needs a comment explaining why it's correct. Catch only what you can handle.
- **MUST** `await` promises before returning them inside a `try`, so errors are caught and stack traces stay complete.
- **MUST** write messages that say what went wrong and how to fix it:
  - Good: `Claude CLI isn't logged in. Run "claude auth login", or set ANTHROPIC_API_KEY.`
  - Bad: `Error: auth failed (code 3)`
- **MUST** show users clear messages, not stack traces, for operational errors. Show technical details for unexpected errors only.
- **MUST** attach `uncaughtException` and `unhandledRejection` handlers in `cli/` that report and exit. Never resume after these.

## 10. Async and concurrency

- **MUST** use `async`/`await`. No callbacks, and no `.then` chains unless they're clearly simpler.
- **MUST NOT** leave promises floating. The `no-floating-promises` lint rule enforces this.
- **MUST** limit concurrency for LLM calls and file reads, and never run an unbounded `Promise.all` over files.
- **MUST** set a timeout on every network call and child process.
- **MUST** pass `AbortSignal` through long operations, so Ctrl+C stops them.
- **MUST** attach `error` listeners to streams and child processes.

## 11. Command-line behaviour

- **MUST** send primary output to stdout, and logs, progress and errors to stderr.
- **MUST** use distinct exit codes, as defined in the [cli spec](specs/cli/spec.md#exit-codes).
- **MUST** prompt only when stdin is a real terminal. Every prompted value **MUST** also be settable by a flag.
- **MUST** provide long-form names for all flags, and use standard names where they exist (`--help`, `--version`, `--force`).
- **MUST NOT** accept secrets as flags, because they leak into shell history and `ps`.
- **MUST** validate input early, before doing work.
- **MUST** show something within about 100 ms, and show progress during long operations.
- **MUST** make Ctrl+C work at any time, exit promptly, and bound clean-up with a timeout.
- **MUST** be crash-safe: the next run must cope with whatever a previous killed run left behind.

## 12. Security

- **MUST** run child processes with `execFile` or `spawn` and an argument array. **MUST NOT** use `exec` or `shell: true`, because file names and other input could become shell commands.
- **MUST** treat all scanned content as untrusted, both for the model and for code. It's data, never instructions.
- **MUST** give the model no tools.
- **MUST** keep file access inside the target folder and output folder. Don't follow symbolic links.
- **MUST** read secrets only from the environment, and **MUST NOT** log, cache or write them.
- **MUST** avoid regular expressions with nested repetition or overlapping alternatives on scanned content, which can hang on crafted input. Test new patterns against long inputs.
- **MUST** run `npm audit` in CI, and fail on high or critical issues in production dependencies.
- **MUST** use `npm ci` in CI, and commit the lockfile.
- **MUST** enable two-factor authentication on the npm account that publishes the package.

## 13. Logging

- **MUST** send logs to stderr only.
- **MUST NOT** include file contents, prompts, API keys or secrets in logs.
- **SHOULD** log stage starts and ends, durations, counts and token usage. These are what's useful when a run is slow or expensive.
- Use one small internal logger. A logging library isn't needed in a short-lived CLI.

## 14. Performance

- **Measure before optimising.** LLM calls dominate run time, so reduce and cache them before tuning scanning.
- **SHOULD** stream or process files in batches, and not hold a whole large repo in memory.
- **MUST NOT** load files that a rule has already skipped.
- Add a performance test when a real problem is found, not in advance.

## 15. Testing

### Test pyramid

Have many fast unit tests, fewer integration tests and very few end-to-end tests. Push each test as far down as it can go. Higher-level tests cover only what lower levels can't, without repeating every edge case. If a higher-level test finds a bug that no lower-level test catches, add a lower-level test.

| Level | Tests | Doubles | Speed |
|---|---|---|---|
| Unit | Logic in `core/`, single adapters | Fakes for ports | Milliseconds |
| Integration | Pipeline with a real temp filesystem | Fake LLM provider | Seconds |
| End-to-end | Built binary against fixtures | Fake `claude` executable | Seconds |
| Manual | Real Claude, real terminal menus | None | Minutes, and costs usage |

### What to test

- **Test behaviour, not implementation.** Check outputs for given inputs, not the internal sequence of calls. Tests tied to structure break during refactoring and stop being a safety net.
- **Test through public interfaces.** Don't test private functions directly. Wanting to may mean a new module is hiding inside.
- **Test state, not interactions.** Check the result rather than which methods were called.
- **Aim for tests that rarely change.** Refactoring, new features and bug fixes shouldn't break existing tests. Only a change in intended behaviour should.
- **Test error paths** as carefully as success paths.
- **Don't test trivial code,** such as simple getters or third-party libraries.
- **Fix a bug by first writing a failing test** that reproduces it.

### Writing tests

- **FIRST:** tests are **F**ast, **I**ndependent, **R**epeatable, **S**elf-validating, and written in a **T**imely way, alongside the code.
- **Arrange, Act, Assert.** Each test has these three parts, separated by a blank line. Usually one "act" and one behaviour per test.
- **Name tests after behaviour.** A failed test's name should explain the bug. `TC-DISC-006: skips binary files but keeps PDF and DOCX`, not `test isBinary`. If a name needs "and" for two unrelated outcomes, split the test.
- **No logic in tests.** No loops, conditionals or computed expected values, which can hide bugs. Use `it.each` for tables of cases.
- **DAMP over DRY.** Each test should be understandable on its own, even with some duplication. Helpers can build data with sensible defaults, but not hide what matters to the test.
- **Each test creates its own data.** No shared mutable state, and no reliance on test order.
- **Clear failures.** Assertions should show expected and actual values. Prefer specific matchers.

### Test doubles

Choose in this order:

1. **Real implementation,** if it's fast and deterministic. Pure `core/` functions never need mocking.
2. **Fake:** a lightweight working implementation, such as `FakeLlmProvider` or an in-memory `FileSystem`. Keep fakes in `test/` and test them with the same contract tests as the real thing.
3. **Stub:** a fixed return value, to reach a specific state such as a rate-limit error.
4. **Interaction check:** only for calls that matter themselves, such as "the provider was never called" during `--dry-run`, or that the prompt went to stdin.

Mock only at architectural boundaries: the network, filesystem, child processes and clock. Heavy mocking produces brittle tests that rarely catch bugs.

### Determinism

- **MUST NOT** use real clocks, randomness or `sleep` in unit tests. Inject `Clock`, and use fake timers.
- **MUST** use a new temp directory for each filesystem test, and clean it up.
- **MUST NOT** call real Claude in CI. It's slow, costs money and isn't repeatable.
- A flaky test **MUST** be fixed or removed promptly, because it trains people to ignore failures.

### Contract tests

Fakes can drift from reality. `recorded-cli-output` holds real `claude` responses, and parser tests run against them. When upgrading the supported Claude CLI version, re-record them.

### Coverage and test quality

- **MUST** reach 90% line and branch coverage in `core/`, and 80% overall. CI fails below this.
- Coverage shows what's untested, not that tests are good. Don't write assertion-free tests to raise a number.
- **SHOULD** run mutation testing on `core/` before each release, aiming for a score of at least 70%. It finds tests that run code without really checking it.

### Traceability

Every `TC` in a `verification.md` maps to a test whose name starts with that ID. A `TC` at `manual` level has written steps until it's automated.

## 16. Dependencies

- Each new production dependency needs a stated reason: why it's needed, its maintenance, size and license. Prefer Node.js built-ins.
- **MUST** commit `package-lock.json`.
- **MUST** keep SDK and library types inside adapters, so a dependency can be replaced in one place.
- **SHOULD** update dependencies regularly in separate pull requests.

## 17. Git and pull requests

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body: why this change]

[optional footer: Refs FR-DISC-006]
```

- **Types:** `feat` (new feature, minor version), `fix` (bug fix, patch version), `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- **Breaking changes** use `!` after the type or a `BREAKING CHANGE:` footer, and mean a major version. For this CLI, breaking means changing options, exit codes or the generated format.
- Write the description in the imperative: `add DOCX extractor`.

### Branches and pull requests

- Branch from `main` as `<type>/<short-description>`: `feat/docx-extractor`.
- **Keep changes small and self-contained.** Around 100 lines is usually reasonable, and 1000 is usually too large. A pull request should do one thing, leave the system working, and be easy to roll back.
- **MUST** include related tests in the same change.
- **MUST** keep refactoring separate from behaviour changes, apart from tiny clean-ups.
- **MUST** reference the requirement IDs in the description.
- **MUST** pass `npm run verify` before merging.

## 18. Code review

Reviewers, including AI reviewers, check:

| Area | Question |
|---|---|
| Spec | Does it meet the requirement, and is the spec still accurate? |
| Design | Does it fit the architecture and belong here? |
| Function | Does it do what's intended? Are edge cases handled? |
| Complexity | Is anything harder to understand than it should be? Is anything over-engineered? |
| Tests | Are they present, and would they fail if the code broke? |
| Hardcoded values | Is every value named and in the right place: constants, environment or database? |
| Naming | Are names clear, without being too long? |
| Comments | Do they explain why, and are they still accurate? |
| Security | Is input handled safely? Could secrets leak? |
| Documentation | Is it updated with the behaviour? |

The reviewer should understand every line. Style preferences not covered here are marked "nit" and don't block merging. Don't approve changes that make the code's overall health worse, but don't demand perfection either. Point out good work too.

## Definition of done

A change is done when:

- [ ] It meets its requirements, and its `TC`s pass
- [ ] Specs and docs match the behaviour
- [ ] `npm run verify` passes, including coverage
- [ ] It's been reviewed
- [ ] No new secrets, `any`, commented-out code, or hardcoded values
- [ ] It uses a Conventional Commit message that references the requirement IDs

## 19. Enforcement

| Rule | Tool |
|---|---|
| Formatting | Prettier |
| Type safety, strict settings | `tsc` |
| No `any`, floating promises, default exports, unsafe patterns | ESLint with `typescript-eslint` strict type-checked rules, plus the core `no-restricted-exports` rule for default exports |
| Import rules | `dependency-cruiser` |
| Hardcoded numbers | ESLint `@typescript-eslint/no-magic-numbers` |
| Model IDs outside the constants file | A unit test that searches `src/` (`TC-LLM-054`) |
| Hardcoded strings | Code review, because linters can't reliably judge them |
| Coverage thresholds | Vitest |
| Test quality | Stryker (before release) |
| Vulnerable dependencies | `npm audit` |
| Commit format | `commitlint` in CI |
| Everything else | Code review |

Don't disable a lint rule without a comment explaining why.

## 20. Sources

- Robert C. Martin, [The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html)
- Robert C. Martin, [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- Google, [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- Google, [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html) and [What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- Winters, Manshreck and Wright, *Software Engineering at Google*: [Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html) and [Test Doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- Ham Vocke, [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- Yoni Goldberg et al., [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- OWASP, [Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- [Command Line Interface Guidelines](https://clig.dev/)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Architectural Decision Records](https://adr.github.io/)
