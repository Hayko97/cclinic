/**
 * The language-neutral baseline for generated developer guidelines (FR-ANA-018).
 * It's fixed text rather than model output, so it stays complete on every run.
 */

export const GUIDELINE_SECTIONS = [
  "Core principles",
  "SOLID",
  "Other design principles",
  "Architecture",
  "Naming",
  "Language rules",
  "Functions, modules and comments",
  "Error handling",
  "Async and concurrency",
  "Security",
  "Logging and performance",
  "Testing",
  "Dependencies",
  "Git and pull requests",
  "Code review",
  "Definition of done",
  "Sources",
] as const;

export type GuidelineSection = (typeof GUIDELINE_SECTIONS)[number];

export const GUIDELINE_BASELINE: Readonly<Record<GuidelineSection, string>> = {
  "Core principles": `- **Clarity first.** Code is read far more often than it's written.
- **KISS.** Choose the simplest design that meets the spec.
- **YAGNI.** Don't build for needs that aren't in a spec.
- **DRY, with judgement.** Each piece of knowledge has one source. Don't merge code that merely looks alike but changes for different reasons.
- **Leave it better.** Every change should improve, or at least not worsen, the health of the code.`,
  SOLID: `Apply SOLID to reduce the cost of change, not for its own sake. An abstraction with one implementation and no test need is usually just extra indirection.

- **Single Responsibility:** each module has one reason to change. It answers to one group or concern, so a change for one doesn't break another.
- **Open/Closed:** add behaviour with new code rather than by editing working code.
- **Liskov Substitution:** any implementation of an interface can be used wherever the interface is expected, without surprising the caller.
- **Interface Segregation:** callers don't depend on methods they don't use. Prefer small, focused interfaces.
- **Dependency Inversion:** high-level logic and low-level details both depend on abstractions owned by the high-level side.`,
  "Other design principles": `- **Composition over inheritance.**
- **Functional core, imperative shell.** Keep logic pure, and keep I/O at the edges.
- **Immutability by default.** Return new values rather than changing arguments.
- **Parse, don't validate.** Turn unknown input into a trusted type once, at the boundary.
- **Make illegal states unrepresentable** where the language allows it.`,
  Architecture: `- **Dependency rule:** source code dependencies point inward, toward business logic. Inner code knows nothing about frameworks, databases or the UI.
- **Boundaries:** data crosses a boundary in the form the inner layer wants. Keep third-party types inside the code that wraps them.
- **Decisions:** record decisions that are expensive to reverse as Architecture Decision Records, with context, decision, alternatives and consequences.
- See [architecture.md](architecture.md) for this project's structure.`,
  Naming: `- Names are clear to a new reader, without being unnecessarily long.
- Functions start with a verb. Functions returning booleans read as questions.
- Booleans are positive: \`isEnabled\`, not \`isNotDisabled\`. Collections are plural.
- Include units when a number has one: \`timeoutMs\`, \`fileSizeBytes\`.
- Avoid abbreviations made by dropping letters, and vague words such as Manager, Helper, Util, Data and Info.
- Use the same word for the same concept throughout.`,
  "Language rules": `Follow the established style guide and formatter for each language, and enforce them automatically.`,
  "Functions, modules and comments": `- A function does one job at one level of detail, and returns early rather than nesting deeply.
- Group long parameter lists into a named object. Avoid boolean flags that change what a function does.
- Never write a value directly in logic. Name it, and define it once:
  - Fixed options, limits and technical names: an enum or constants file
  - Values that differ between environments: environment variables, or an \`.env\` file for local development, committing only an \`.env.example\`
  - Secrets: environment variables or a secret manager, never in code, constants or committed files
  - Values that change without a release, or that users or admins manage: a database, or a config file if there's no database
- Simple arithmetic such as \`0\` and \`1\`, one-off messages, and expected values in tests can stay in place.
- Avoid side effects when a module loads.
- Comments explain **why**, not what. Don't leave commented-out code. Link each TODO to an issue or requirement.
- Update documentation in the same change as the behaviour.`,
  "Error handling": `- Separate **operational errors**, which are expected and handled, from **programmer errors**, which are bugs and shouldn't be carried on from.
- Handle errors in one central place, and keep the original cause.
- Never swallow errors. An empty catch needs a comment explaining why it's correct.
- Messages say what went wrong and how to fix it. Don't show users stack traces for expected errors.`,
  "Async and concurrency": `- Limit concurrency, and never start unbounded parallel work.
- Set a timeout on every network call and external process.
- Support cancellation in long operations.
- Don't leave work running unobserved, because its failures will be lost.`,
  Security: `- Treat all external input as untrusted, and validate it at the boundary, preferably against an allow-list.
- Prevent injection: parameterise queries, and run processes with argument lists rather than through a shell.
- Keep secrets out of code, logs and error messages.
- Check that users may access what they request.
- Keep dependencies updated, and scan them for known vulnerabilities.`,
  "Logging and performance": `- Never log secrets or personal data.
- Log what helps diagnose problems: stages, durations, counts and identifiers.
- Measure before optimising, and add performance tests when a real problem is found.`,
  Testing: `- **Test pyramid:** many fast unit tests, fewer integration tests, very few end-to-end tests. Push each test as far down as it can go.
- **Test behaviour, not implementation,** through public interfaces. Refactoring shouldn't break tests.
- **FIRST:** tests are fast, independent, repeatable, self-validating and timely.
- **Arrange, Act, Assert,** usually with one behaviour per test. Name tests after the behaviour, so a failure explains the bug.
- **Keep logic out of tests.** Prefer clarity over removing all duplication.
- **Test doubles,** in order of preference: real implementation, fake, stub, then interaction checks only when the call itself matters. Mock only at boundaries such as the network, filesystem and clock.
- **Determinism:** no real clocks, randomness, sleeps or shared state. Fix or remove flaky tests promptly.
- **Bugs:** first write a failing test that reproduces the bug.
- **Traceability:** each test case in a spec's \`verification.md\` maps to a test whose name starts with its \`TC\` ID.`,
  Dependencies: `- Justify each new production dependency: why it's needed, its maintenance and its license.
- Commit the lockfile, and pin versions through it.
- Keep third-party types behind your own interfaces, so a dependency can be replaced in one place.`,
  "Git and pull requests": `- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): \`<type>[scope]: <description>\`, such as \`feat\`, \`fix\`, \`docs\`, \`test\` or \`refactor\`.
- Keep changes small and self-contained. Include related tests in the same change.
- Keep refactoring separate from behaviour changes.
- Reference the requirement IDs a change implements.`,
  "Code review": `Reviewers check that the change:

- Meets its requirement, and that the spec is still accurate
- Fits the architecture and isn't over-engineered
- Handles edge cases, with tests that would fail if the code broke
- Has clear names and useful comments
- Handles input safely, without leaking secrets
- Updates documentation

Style preferences not covered here don't block merging.`,
  "Definition of done": `- [ ] The change meets its requirements, and its test cases pass
- [ ] Specs and documentation match the behaviour
- [ ] All automated checks pass
- [ ] The change has been reviewed
- [ ] The commit message references the requirement IDs`,
  Sources: `- [The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html), Robert C. Martin
- [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html), Robert C. Martin
- [Google engineering practices](https://google.github.io/eng-practices/)
- *Software Engineering at Google*: [Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html) and [Test Doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html), Ham Vocke
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [Architectural Decision Records](https://adr.github.io/)`,
};
