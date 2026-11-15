---
name: review-code
description: "Reviews a change against the project's coding rules and developer guidelines, and reports findings by severity with a verdict, without changing code. Use when QA has passed and before the preview, or when the user asks to review code before it's committed."
metadata:
  generated-by: luseen
  content-hash: "6500a8844236b9e42eafcea0f5f1fde712b68a0cad8b09854e7700f0af9f5d75"
---

# Review code

Review a change the way a careful senior maintainer of this project would, before the user sees it. You find and explain problems; the implementing agent fixes them.

## Rules

- **Don't change code, tests or specs.** Report findings only.
- **Review only the change.** Review the files the change touched, as the implementing agent names them, or every uncommitted file if none are named: their diff, including new files, spec files and tests. Read enough of the surrounding code to judge each changed line. List problems in other files, or in code the change doesn't touch, as follow-ups. They don't affect the verdict.
- **Cite the rule for every finding,** with its source. A preference no rule covers is at most a `nit`.
- **Approve code that improves the project, even if it isn't perfect.**
- If you're reviewing for the agent that implemented the change, follow only this skill. Don't start the project's lifecycle, change the spec or stop at stage 2.

## Rules to review against

When two conflict, the earlier one wins:

1. **The project's own rules:** such as `CONTRIBUTING.md`, the user's own part of `AGENTS.md` or `CLAUDE.md`, and the linter and formatter configuration.
2. **`.luseen/sdd/developer-guidelines.md`.** If it's missing, say so in the report.
3. **The checklist below.**

## Steps

1. **Read the change.** Read the diff of the changed files, such as with `git diff`, and read new files in full. If a spec covers the change, read its `spec.md` in `.luseen/sdd/specs/<name>/`, so you can judge whether the code does what it says. If no spec covers it, such as a refactor, check that behaviour didn't change.
2. **Run the checks first.** Run the project's formatter, linter, type checker and tests, using the commands in `.luseen/sdd/stack.md` or the project's own scripts, and record the real results. Each failure in the changed files, or caused by them, is a `blocking` finding. A failure only in other files is a follow-up. Don't review by hand what these tools already check.
3. **Review against the rules.** Go through each changed file with the rules above and the checklist.
4. **Run Claude Code's review, if you can.** If you're running in Claude Code and its built-in `code-review` skill or command is available, run it on the current change at the level `medium`, passing it explicitly, because with no level, it reuses the last level the user typed. Don't pass `--fix`, `--comment`, `max` or `ultra` unless the user asks. Add the findings you confirm, marked `(claude-code)`, and say in the report whether it ran. If it isn't available, say so in the report.
5. **Confirm every finding.** Confirm each finding in the code, and drop any you can't confirm, rather than report a guess.
6. **Report, and stop,** in the format below.

## Checklist

| Area | Look for |
|---|---|
| Correctness | It does what each changed requirement says, including errors and edge cases. Wrong conditions, off-by-one, missing null or empty cases, races |
| Design | It fits the architecture and its dependency rules, with logic in the right layer |
| SOLID | One reason to change per module, small interfaces, dependencies on abstractions where the project uses them. No abstraction with one implementation and no need |
| KISS and YAGNI | The simplest design that meets the spec. No options, flags, layers or fallbacks nobody asked for |
| DRY | Logic that already exists is reused, not copied. Search for existing helpers. Code that only looks alike can stay separate |
| No hardcoded values | Magic numbers, strings, URLs, timeouts, limits and paths go in the project's constants, configuration or an existing named value, with units in the name |
| Naming | Names from the domain, following the project's conventions. No vague names such as `data`, `info`, `handler`, `Manager` or `Util`. Booleans read as questions |
| Errors | Handled at boundaries, where something can be done. No swallowed errors, and no catching only to log and rethrow |
| Security | No secrets in code, tests or logs. Input validated at boundaries. No injection into shell commands, queries, paths or HTML |
| Tests | Each changed behaviour is tested, and the tests check what the spec says. No skipped, deleted or weakened tests |
| Comments and dead code | No comments restating the code. No unused code, imports or parameters, and no TODOs or stubs presented as finished |
| Docs | Docs, help text and examples that the change makes wrong are updated |

## Severity

- **`blocking`:** a bug, a security problem, a failed check, or a change that doesn't meet the spec.
- **`should-fix`:** a broken rule from the project's rules, the developer guidelines or the checklist.
- **`nit`:** a matter of taste that no rule covers. Optional.

## Report format

```markdown
## Code review

Checks: format passed, lint failed (1 error), types passed, tests passed (214)

| Severity | Where | Rule (source) | Problem | Fix |
|---|---|---|---|---|
| blocking | `src/session.ts:41` | no-unused-vars (`eslint.config.js`) | `oldToken` is never used | Remove it |
| should-fix | `src/session.ts:18` | No hardcoded values (`developer-guidelines.md`) | `30000` is an unnamed timeout | Use a named constant such as `SESSION_TIMEOUT_MS` |

Follow-ups, not in this change: `src/cache.ts:12` uses the vague name `info`.

Verdict: changes
```

The verdict is `approve` when no `blocking` or `should-fix` findings remain, otherwise `changes`.
