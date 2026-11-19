---
name: implement-spec
description: "Builds a spec requirement by requirement, with tests from its test cases, and reports proof that each one works. Use when the user asks to implement, build or complete a spec, feature or requirement that has a spec folder."
---

# Implement a spec

Turn a spec into working, tested code, and report honestly on each requirement.

## Steps

1. **Read the spec.** Read its `spec.md`, `validation.md` and `verification.md` in `.luseen/sdd/specs/<name>/`. If `.luseen/sdd` doesn't exist, stop and ask the user to run `luseen` in the project root to generate it. If the spec doesn't exist, use the `create-spec` skill first.
2. **Check for blockers.** Read `.luseen/sdd/open-questions.md`. If an open question affects a requirement you're about to build, stop and ask the user. Don't guess.
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
9. **Hand it to QA.** Test the change with the `test-spec` skill, in a separate agent if your tool can run one. QA reports each defect to you, the developer agent, as a bug to fix. For each defect, decide whether the code, the test or the spec is wrong. Fix wrong code with `write-code`, or a wrong test so it checks what the spec says, then run QA again. If the spec is wrong, stop and use the `refine-spec` skill with the user's agreement. Unless the spec is wrong, don't ask the user for approval or anything else between QA runs: fix the bugs, then run QA again, until it passes or the 3rd run fails. QA runs at most 3 times for a change, counting every run, and the count starts again only after the user replies. If the 3rd QA run still fails, stop: report the failures, save them as tasks (step 13), and show how to review it if the preview can start, instead of asking for approval.
10. **Review the code.** Once QA passes, review the change with the `review-code` skill, naming the files the change touched, in a separate agent if your tool can run one. Fix each `blocking` and `should-fix` finding with `write-code`, without changing behaviour the spec doesn't ask to change, or say in the report why you think it's wrong. If a finding shows the spec is wrong, stop and use the `refine-spec` skill with the user's agreement. Fix `nit` findings only if the user asks. After fixing, run QA again, then the review again. If the fixes need QA and the 3 QA runs are used up, stop: report the findings and the untested fixes, save the findings as tasks (step 13), and show how to review it if the preview can start, instead of asking for approval. The review runs at most 3 times for a change, counting every run, and the count starts again only after the user replies. If the 3rd review still has `blocking` or `should-fix` findings, stop: report them, save them as tasks (step 13), and show how to review it if the preview can start, instead of asking for approval. If your tool has the luseen MCP tools, report each review with `review_report`, with its verdict and findings by severity.
11. **Update the spec.** Set each finished requirement's status to `confirmed`, and update its evidence to point to the code. Only do this for requirements that work.
12. **Show how to review it.** Run each `start` command in `.luseen/environment/environment.json`, so the local environment includes this change, leave it running, and give the user a link, build or command to try. If the file doesn't exist, set it up with the `local-env` skill.
13. **Report and ask for review,** using the format below, with the review findings fixed, disputed and left, and whether the agent's built-in code review ran. **Save problems left for later.** Without asking, save as a task each problem this change won't fix: a review follow-up or a bug you noticed in code the change doesn't touch, and each failed test case or `blocking` or `should-fix` finding still open when you stop after the 3rd QA run or review. Don't save problems fixed in this change. Check the open tasks first, and skip a problem one of them already records. Save each with `task_add` if you have the luseen MCP tools, or `luseen tasks add` otherwise, with no milestone: a title naming the problem, a description with the file and line, what's wrong, where it was found (QA run, review run or while working) and a suggested fix, and the spec's name (`spec` for `task_add`, `--spec` for `luseen tasks add`) when a spec covers that code. If you can't save one, say so, and list it in the report. In the report, list the tasks saved with their IDs. Then list the `nit` findings left and the findings you disagreed with, and ask the user which of them, or anything else, to save as tasks for later, and save only those they choose. This question isn't approval, and you can ask it with the approval question. In an unattended run, don't ask it, and don't save those. Give the steps for each `manual` test case QA didn't run, so the user can test it by hand. Ask the user to approve the implementation or request changes. If they request changes, make them, run QA and the review again, show how to review it again, and ask again.
14. **Ask to commit.** Once they approve the implementation, ask whether to commit. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change, and don't include secrets. State any test that failed or wasn't run, and any `blocking` or `should-fix` finding still open, before asking. If they decline, leave the changes uncommitted.

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
