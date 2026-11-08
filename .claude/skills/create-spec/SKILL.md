---
name: create-spec
description: "Writes a new spec for a feature or capability, with requirements, acceptance criteria and test cases. Use when the user asks to spec, plan or document something new before building it, or describes a feature that has no spec yet."
metadata:
  generated-by: cclinic
  content-hash: "ff50db64c9b1b3d81cc4db41b089c88e001034a0ca85759c2d02f27df4773a14"
---

# Create a spec

Write a spec that a developer and an automation tester could each work from without asking more questions. Don't write production code in this skill.

## Steps

1. **Read the context.** Read `.cclinic/sdd/README.md`, `overview.md`, `architecture.md` and `open-questions.md`. If `.cclinic/sdd` doesn't exist, stop and ask the user to run `cclinic` in the project root to generate it.
2. **Check for overlap.** Read the goals of the existing specs in `.cclinic/sdd/specs/`. If this belongs in an existing spec, use the `refine-spec` skill instead.
3. **Look at the code.** Find what already exists for this capability, so that requirements reflect reality and can cite evidence.
4. **Ask before assuming.** If the goal, users or scope are unclear, ask the user. Ask only about what would change the spec, and record anything unresolved as an open question.
5. **Write the three files,** using the format below. Scope one capability per spec, and split it if it's growing into several.
6. **Add it to the specs table** in `.cclinic/sdd/README.md`.
7. **Check your work** using the checklist below.
8. **Ask for review, and stop.** Summarise the spec and any open questions, and ask the user to approve or reject it. Don't implement it in this skill. If they reject it or ask for changes, refine it and ask again.

## Spec format

Each spec is a folder, `.cclinic/sdd/specs/<kebab-case-name>/`, with exactly three files. Copy the structure of an existing spec if there is one.

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
- **Unknowns:** never invent an answer. Add it to `.cclinic/sdd/open-questions.md`.

## Checklist

- [ ] Every requirement is one testable behaviour, with a status and evidence
- [ ] Every requirement has at least one `VAL` and one `TC`
- [ ] Error and edge cases have test cases, not only the success path
- [ ] The area code and IDs don't clash with another spec, or with `retiredIds` in `.cclinic/sdd/manifest.json`
- [ ] Nothing was invented. Unknowns are open questions

## Don't lose this work

cclinic treats edits in `.cclinic/sdd` as hand edits. Re-running `cclinic` then refuses to continue, and `cclinic --force` replaces the whole folder, including these edits. Never run `cclinic --force` without asking the user first.
