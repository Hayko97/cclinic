---
name: write-code
description: "Writes or changes code the way a careful maintainer of this project would: following its stack, architecture and conventions, in small changes without unnecessary comments or abstractions. Use whenever writing, changing or refactoring production code in this project."
---

# Write code

Write what an experienced maintainer of this project would write. A reviewer should find it hard to tell your code from the code around it, because it fits, and it should be no bigger than the task needs.

## Before writing

1. **Read the project's rules:** `.luseen/sdd/stack.md`, `architecture.md` and `developer-guidelines.md`. They set the languages, versions, layers, naming and test tools. Where they conflict with habit, they win.
2. **Read the code nearby.** Read the file you'll change, its neighbours and its tests. Where nearby code and general best practice differ, follow the project, and mention the difference instead of introducing a second style.
3. **Search before creating.** Look for an existing function, type, helper or pattern that does this. Extend or reuse it.

## While writing

**Match the project:** naming, file layout, error handling, logging, formatting and test style. Use the libraries it already uses. Don't add a dependency without a clear need, and tell the user if you do.

**Keep the change small:**

- Do what was asked, and nothing else. Note other problems you see instead of fixing them in this change.
- Don't reformat, rename or reorganise code you aren't otherwise changing.
- Delete what your change makes unused.

**Design for today's need:**

- Write the simple, direct version first. Don't add interfaces, factories, options or configuration for needs that don't exist yet.
- Apply SOLID and the project's architecture rules where they reduce the cost of change, not as ceremony.
- Duplicate a little rather than build the wrong abstraction. But if the same logic is already there, reuse it.

## Avoid these habits of careless generated code

| Avoid | Instead |
|---|---|
| Comments restating the code, such as `// increment the counter` | Clear names. Comment only on why, such as a surprising constraint or workaround |
| Long doc comments on every small function | Follow the project's documentation habits |
| Unused helpers, parameters, imports and variables | Write only what's called |
| Checks for cases that can't happen, and catching errors only to log and rethrow | Validate at boundaries. Trust internal code. Handle errors where you can act on them |
| New wrappers, managers and utility files around one call | Call it directly, or use what exists |
| Unrequested features, flags, fallbacks and backwards compatibility | Ask, or leave them out |
| Duplicating logic because editing existing code seems riskier | Refactor the existing code when the task needs it, with tests |
| Placeholders, TODOs and stubs presented as finished | Finish it, or say clearly what's incomplete |
| Invented APIs and options | Check the source, types or docs of the version in use |
| Vague names such as `data`, `result`, `handler`, `processItem` | Names from the project's domain |
| Summary files, and changelogs nobody asked for | Update existing docs only when behaviour changes |

## Before finishing

1. Run the project's formatter, linter, type checker and tests, using the commands in `.luseen/sdd/stack.md` or the project's own scripts.
2. Read your whole diff as a reviewer would. Remove anything the task doesn't need.
3. Say plainly what you changed, what you ran and the results, including anything that failed or that you couldn't run.

Follow the project's rules on commit messages and on disclosing AI assistance. Writing like a maintainer is about code quality. Never hide or remove attribution that the project or the user requires.
