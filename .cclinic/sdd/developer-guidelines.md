# Developer guidelines

## Core principles

- **Clarity first.** Code is read far more often than it's written.
- **KISS.** Choose the simplest design that meets the spec.
- **YAGNI.** Don't build for needs that aren't in a spec.
- **DRY, with judgement.** Each piece of knowledge has one source. Don't merge code that merely looks alike but changes for different reasons.
- **Leave it better.** Every change should improve, or at least not worsen, the health of the code.

## SOLID

Apply SOLID to reduce the cost of change, not for its own sake. An abstraction with one implementation and no test need is usually just extra indirection.

- **Single Responsibility:** each module has one reason to change. It answers to one group or concern, so a change for one doesn't break another.
- **Open/Closed:** add behaviour with new code rather than by editing working code.
- **Liskov Substitution:** any implementation of an interface can be used wherever the interface is expected, without surprising the caller.
- **Interface Segregation:** callers don't depend on methods they don't use. Prefer small, focused interfaces.
- **Dependency Inversion:** high-level logic and low-level details both depend on abstractions owned by the high-level side.

## Other design principles

- **Composition over inheritance.**
- **Functional core, imperative shell.** Keep logic pure, and keep I/O at the edges.
- **Immutability by default.** Return new values rather than changing arguments.
- **Parse, don't validate.** Turn unknown input into a trusted type once, at the boundary.
- **Make illegal states unrepresentable** where the language allows it.

### For this project

- **Observed:** Change the spec before the code; specs are source of truth; IDs are permanent and never reused. (`sdd/README.md:3`, `sdd/README.md:56`)

## Architecture

- **Dependency rule:** source code dependencies point inward, toward business logic. Inner code knows nothing about frameworks, databases or the UI.
- **Boundaries:** data crosses a boundary in the form the inner layer wants. Keep third-party types inside the code that wraps them.
- **Decisions:** record decisions that are expensive to reverse as Architecture Decision Records, with context, decision, alternatives and consequences.
- See [architecture.md](architecture.md) for this project's structure.

### For this project

- **Observed:** Keep dependencies pointing inward: core imports only core and zod; application only core; adapters not application, cli or each other; only cli creates concrete adapters. Enforced by dependency-cruiser (npm run check:arch). (`.dependency-cruiser.cjs:5-40`, `sdd/architecture.md:102-107`)
- **Observed:** Confine @anthropic-ai/sdk imports to adapters/llm/anthropic-api.ts and Claude CLI stream parsing to claude-cli.ts. (`.dependency-cruiser.cjs:34-39`, `sdd/decisions/0002-claude-cli-integration.md:28`)

## Naming

- Names are clear to a new reader, without being unnecessarily long.
- Functions start with a verb. Functions returning booleans read as questions.
- Booleans are positive: `isEnabled`, not `isNotDisabled`. Collections are plural.
- Include units when a number has one: `timeoutMs`, `fileSizeBytes`.
- Avoid abbreviations made by dropping letters, and vague words such as Manager, Helper, Util, Data and Info.
- Use the same word for the same concept throughout.

### For this project

- **Observed:** kebab-case files, UpperCamelCase types, lowerCamelCase functions, CONSTANT_CASE constants, is/has/was booleans, test files <module>.test.ts. (`sdd/developer-guidelines.md:86-105`, `src/adapters/git/git-repository.ts:27-33`)

## Language rules

Follow the established style guide and formatter for each language, and enforce them automatically.

### For this project

- **Observed:** Use strict TypeScript (~6.0.3) with NodeNext ESM, .js import suffixes, named exports only (default exports only where tool configs require, with a disable comment), import type, as const instead of enums. (`tsconfig.json:4-14`, `eslint.config.js:11`, `sdd/developer-guidelines.md:112-122`)
- **Observed:** No magic numbers or literal model IDs outside src/core/constants; names carry units (Ms, Usd, Bytes). (`eslint.config.js:15-24`, `src/core/constants/constants.test.ts:62-96`)

## Functions, modules and comments

- A function does one job at one level of detail, and returns early rather than nesting deeply.
- Group long parameter lists into a named object. Avoid boolean flags that change what a function does.
- Never write a value directly in logic. Name it, and define it once:
  - Fixed options, limits and technical names: an enum or constants file
  - Values that differ between environments: environment variables, or an `.env` file for local development, committing only an `.env.example`
  - Secrets: environment variables or a secret manager, never in code, constants or committed files
  - Values that change without a release, or that users or admins manage: a database, or a config file if there's no database
- Simple arithmetic such as `0` and `1`, one-off messages, and expected values in tests can stay in place.
- Avoid side effects when a module loads.
- Comments explain **why**, not what. Don't leave commented-out code. Link each TODO to an issue or requirement.
- Update documentation in the same change as the behaviour.

## Error handling

- Separate **operational errors**, which are expected and handled, from **programmer errors**, which are bugs and shouldn't be carried on from.
- Handle errors in one central place, and keep the original cause.
- Never swallow errors. An empty catch needs a comment explaining why it's correct.
- Messages say what went wrong and how to fix it. Don't show users stack traces for expected errors.

### For this project

- **Observed:** Throw only typed errors extending CclinicError; only cli converts errors to messages and exit codes (0,1,2,3,4,5,130,143); preserve cause; empty catches carry a comment. (`src/core/errors.ts:3-55`, `sdd/developer-guidelines.md:185-195`)

## Async and concurrency

- Limit concurrency, and never start unbounded parallel work.
- Set a timeout on every network call and external process.
- Support cancellation in long operations.
- Don't leave work running unobserved, because its failures will be lost.

### For this project

- **Observed:** Bound LLM concurrency (default 4, max 16), give every child process/network call a timeout, pass AbortSignal, and abort sibling tasks on first failure while keeping finished results cached. (`src/core/constants/limits.ts:9-16`, `src/application/pipeline.ts:156-187`, `sdd/developer-guidelines.md:201-204`)

## Security

- Treat all external input as untrusted, and validate it at the boundary, preferably against an allow-list.
- Prevent injection: parameterise queries, and run processes with argument lists rather than through a shell.
- Keep secrets out of code, logs and error messages.
- Check that users may access what they request.
- Keep dependencies updated, and scan them for known vulnerabilities.

### For this project

- **Observed:** Use spawn/execFile with argument arrays, never a shell; wrap scanned content in <project_content> tags as untrusted; give the model no tools; never read secret files; strip ANTHROPIC_API_KEY/AUTH_TOKEN from claude child env. (`src/core/prompts.ts:9-29`, `src/adapters/llm/claude-cli.ts:35-46`, `src/core/exclusion-rules.ts:28-37`, `sdd/specs/git-setup/spec.md:61`)
- **Exception:** `preview_start` runs each `start` command from `.cclinic/environment/environment.json` in a shell, because a start line is a shell command written for one, which the agent would otherwise run in its own shell. It runs only commands from that file, after its schema is checked. (`src/adapters/preview/preview-runner.ts`, `sdd/specs/mcp-server/spec.md` FR-MCP-023)
- **Recommended:** Run npm audit in CI and enable 2FA on the publishing npm account. (`sdd/developer-guidelines.md:226-228`)

## Logging and performance

- Never log secrets or personal data.
- Log what helps diagnose problems: stages, durations, counts and identifiers.
- Measure before optimising, and add performance tests when a real problem is found.

### For this project

- **Observed:** Progress/logs/prompts to stderr, results to stdout; never log file contents, prompts or keys; keep generated Markdown deterministic. (`src/cli/reporter.ts:1`, `src/core/rendering.ts:1-11`)

## Testing

- **Test pyramid:** many fast unit tests, fewer integration tests, very few end-to-end tests. Push each test as far down as it can go.
- **Test behaviour, not implementation,** through public interfaces. Refactoring shouldn't break tests.
- **FIRST:** tests are fast, independent, repeatable, self-validating and timely.
- **Arrange, Act, Assert,** usually with one behaviour per test. Name tests after the behaviour, so a failure explains the bug.
- **Keep logic out of tests.** Prefer clarity over removing all duplication.
- **Test doubles,** in order of preference: real implementation, fake, stub, then interaction checks only when the call itself matters. Mock only at boundaries such as the network, filesystem and clock.
- **Determinism:** no real clocks, randomness, sleeps or shared state. Fix or remove flaky tests promptly.
- **Bugs:** first write a failing test that reproduces the bug.
- **Traceability:** each test case in a spec's `verification.md` maps to a test whose name starts with its `TC` ID.

### For this project

- **Observed:** Name tests with TC-<AREA>-NNN prefix; use temp folders per test, fake claude and FakeLlm; never call real Claude; hold coverage at 80% overall and 90% in core; mutation score target 70+. (`vitest.config.ts:9-13`, `stryker.config.json:5`, `test/support/helpers.ts:10-20`, `README.md:151`)
- **Observed:** Bump PROMPT_VERSION whenever prompts or schemas change so caches are invalidated. (`src/core/constants/llm.ts:3-4`)

## Dependencies

- Justify each new production dependency: why it's needed, its maintenance and its license.
- Commit the lockfile, and pin versions through it.
- Keep third-party types behind your own interfaces, so a dependency can be replaced in one place.

### For this project

- **Observed:** Production dependencies limited to the allow-list; commit package-lock.json and install with npm ci; new dependencies need a stated reason. (`sdd/stack.md:13`, `sdd/stack.md:19`)

## Git and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[scope]: <description>`, such as `feat`, `fix`, `docs`, `test` or `refactor`.
- Keep changes small and self-contained. Include related tests in the same change.
- Keep refactoring separate from behaviour changes.
- Reference the requirement IDs a change implements.

### For this project

- **Observed:** Use Conventional Commits (commitlint), reference requirement IDs, keep PRs small, branches <type>/<short-description>. (`commitlint.config.js:2`, `sdd/developer-guidelines.md:320-337`)

## Code review

Reviewers check that the change:

- Meets its requirement, and that the spec is still accurate
- Fits the architecture and isn't over-engineered
- Handles edge cases, with tests that would fail if the code broke
- Has clear names and useful comments
- Handles input safely, without leaking secrets
- Updates documentation

Style preferences not covered here don't block merging.

## Definition of done

- [ ] The change meets its requirements, and its test cases pass
- [ ] Specs and documentation match the behaviour
- [ ] All automated checks pass
- [ ] The change has been reviewed
- [ ] The commit message references the requirement IDs

### For this project

- **Observed:** npm run verify passes (lint, typecheck, arch, coverage tests, e2e), TCs pass, docs match behaviour, no new secrets/any/commented-out code. (`package.json:30`, `sdd/developer-guidelines.md:364-371`)

## Sources

- [The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html), Robert C. Martin
- [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html), Robert C. Martin
- [Google engineering practices](https://google.github.io/eng-practices/)
- *Software Engineering at Google*: [Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html) and [Test Doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html), Ham Vocke
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [Architectural Decision Records](https://adr.github.io/)
