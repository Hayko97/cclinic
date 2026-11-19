---
name: refine-spec
description: "Improves an existing spec: fixes vague or untestable requirements, fills coverage gaps, updates it to match the code, and resolves open questions. Use when the user asks to review, refine, update or tighten a spec, or when code and spec have drifted apart."
---

# Refine a spec

Make an existing spec more accurate and testable, without changing what the project intends unless the user agrees.

## Steps

1. **Read the spec's three files,** plus `.luseen/sdd/open-questions.md`. If `.luseen/sdd` doesn't exist, stop and ask the user to run `luseen` in the project root to generate it.
2. **Check it against the code and cited evidence.** Open what each requirement cites, and confirm it still says that.
3. **Find the problems:**
   - Requirements that are vague, untestable, or combine several behaviours
   - Requirements with no `VAL` or `TC`, and test cases with no failure scenarios
   - Test cases that an automation tester couldn't write without more information
   - Acceptance criteria that mention implementation details
   - Wrong statuses or stale evidence
   - Conflicts with other specs, code or documents
4. **Separate what you can fix from what the user must decide.** Fix wording, coverage, evidence and status yourself. Anything that changes intended behaviour is the user's decision, so ask. If they can't answer now, record an open question.
5. **Make the changes,** keeping IDs stable. When a requirement is removed, delete it and don't reuse its ID. When one is split, keep the ID for the closest match, and give the rest new numbers.
6. **Remove resolved items** from `open-questions.md`, and reflect the answers in the spec.
7. **Ask for review, and stop.** Report what changed and why, what you asked, and what's still open. Then offer the user three options, and stop until they choose one:
   - **`approve`:** the spec is ready to implement.
   - **`refine`:** refine the spec with the changes they ask for, and ask again.
   - **`review-doc`:** use the `review-doc` skill to write a visual doc of how the project will work and look after the change.

   Don't implement it in this skill.

## Spec format

Each spec is a folder, `.luseen/sdd/specs/<kebab-case-name>/`, with exactly three files. Copy the structure of an existing spec if there is one.

**`spec.md`:** a goal, then requirements, then edge cases and non-goals.

```markdown
| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTH-001 | The system must lock an account after 5 failed logins. | docs-only | `docs/security.md:12` |
```

**`validation.md`:** acceptance criteria in plain language, with no implementation details.

```markdown
| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-AUTH-001 | FR-AUTH-001 | My account is protected from guessing | After 5 wrong passwords, I can't log in until I reset it |
```

**`verification.md`:** test setup, then test cases detailed enough to automate without reading the code. Include error and edge cases.

```markdown
| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-AUTH-001 | FR-AUTH-001 | integration | An account with 4 failed logins | A 5th login fails | The account is locked, and a correct password is rejected |
```

**Rules:**

- **IDs:** `FR-`, `VAL-` and `TC-<AREA>-NNN`. The area is 2 to 8 uppercase letters, unique to the spec. IDs are permanent: never renumber or reuse one, even if its requirement is removed.
- **Coverage:** every requirement has at least one `VAL` and one `TC`. Every `Covers` entry points to a real requirement.
- **Requirements:** one testable behaviour each, using "must". Avoid words that can't be tested, such as "fast", "secure" or "user-friendly".
- **Status:** `confirmed` (code and documents agree), `code-only` (only in code), or `docs-only` (not built yet, or only in documents).
- **Evidence:** cite `path:line`, `path:start-end`, `document.pdf:page` or `document.docx#Heading`. For a new request with no document, cite where it came from, such as `user request`.
- **Unknowns:** never invent an answer. Add it to `.luseen/sdd/open-questions.md`.

## Don't lose this work

luseen treats edits in `.luseen/sdd` as hand edits. Re-running `luseen` then refuses to continue, and `luseen --force` replaces the whole folder, including these edits. Never run `luseen --force` without asking the user first.
