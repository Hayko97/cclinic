---
name: implement-spec
description: "Builds a spec requirement by requirement, with tests from its test cases, and reports proof that each one works. Use when the user asks to implement, build or complete a spec, feature or requirement that has a spec folder."
metadata:
  generated-by: cclinic
  content-hash: "43f6033ab8a14159ce37a84c847aea0d1c76365d07ebf716034ebb5212198507"
---

# Implement a spec

Turn a spec into working, tested code, and report honestly on each requirement.

## Steps

1. **Read the spec.** Read its `spec.md`, `validation.md` and `verification.md` in `.cclinic/sdd/specs/<name>/`. If `.cclinic/sdd` doesn't exist, stop and ask the user to run `cclinic` in the project root to generate it. If the spec doesn't exist, use the `create-spec` skill first.
2. **Check for blockers.** Read `.cclinic/sdd/open-questions.md`. If an open question affects a requirement you're about to build, stop and ask the user. Don't guess.
3. **Check that it's approved.** If the spec was changed for this work and the user hasn't approved it, show them the changes and ask first. Don't write code until they approve.
4. **Follow the `write-code` skill** for all code. If your agent can't load it, read `.agents/skills/write-code/SKILL.md`.
5. **Plan briefly.** List the requirements in a sensible build order, and what each one touches. For a large spec, share the plan with the user before starting.
6. **Build one requirement at a time:**
   1. Write its tests from the `TC`s that cover it, naming each test with its ID, such as `TC-AUTH-001: locks the account after 5 failed logins`.
   2. Confirm that they fail for the right reason, where that's practical.
   3. Write the smallest code that meets the requirement.
   4. Run the tests, then the wider suite for what you touched.
7. **Stay in scope.** Build only what the spec says. If the spec is wrong or incomplete, stop and tell the user, or use the `refine-spec` skill with their agreement. Don't quietly build something different.
8. **Verify everything.** Run the project's full checks. Then read each `VAL`, and judge whether the result would really meet it.
9. **Update the spec.** Set each finished requirement's status to `confirmed`, and update its evidence to point to the code. Only do this for requirements that work.
10. **Show how to review it.** Run each `start` command in `.cclinic/environment/environment.json`, so the local environment includes this change, leave it running, and give the user a link, build or command to try. If the file doesn't exist, set it up with the `devops` skill.
11. **Report and ask for review,** using the format below. Ask the user to approve the implementation or request changes. If they request changes, make them and ask again.
12. **Ask to commit.** Once they approve the implementation, ask whether to commit. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change, and don't include secrets. State any test that failed or wasn't run before asking. If they decline, leave the changes uncommitted.

## Report format

```markdown
| Requirement | Result | Code | Test cases |
|---|---|---|---|
| FR-AUTH-001 | Done | `src/auth/lockout.ts:12` | TC-AUTH-001 passed, TC-AUTH-002 passed |
| FR-AUTH-002 | Blocked | | Waiting on an open question about reset emails |
```

Also list the commands you ran with their results, any manual test cases still to do, and any problems you found.

## Honesty rules

- Never say something passes unless you ran it and saw it pass.
- If you couldn't run something, say so.
- Never skip, delete or weaken a test to get a pass. A failing test is either a bug to fix or a question for the user.
- "Done" means built and tested. Report anything else as partial or blocked.
- Approving a spec or an implementation doesn't mean agreeing to commit, so always ask.
- Never push unless the user asks.
