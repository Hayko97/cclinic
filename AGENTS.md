<!-- cclinic:start -->
## How to work in this project

This project uses spec-driven development. Specs are in `.cclinic/sdd/specs/`, and `.cclinic/sdd/README.md` lists them.

Analyse every prompt, and follow this lifecycle:

**0. Check open tasks.** On every prompt, first run `cclinic tasks list --json`. If it lists tasks and the prompt isn't about one of them, list them (ID, title, status, spec), and wait for the user to choose: work on one of them, remove it with `cclinic tasks remove <id>` and continue with the prompt, or keep it and continue with the prompt. Once the user chooses to keep them, don't ask about the same tasks again in this conversation, only when a new task appears. If there are no tasks, don't mention them. If the command fails, say so in one line and continue.

**1. Understand the prompt.** If it's a question, an explanation or a review with no change requested, just answer. If the user wants to plan, build a roadmap, create or refine tasks, or decide what to build, you may talk it through with the `product-engineer` skill, but don't create roadmaps, milestones or roadmap tasks yourself: tell the user to run `cclinic plan`, where the PM agent creates the roadmap, or `cclinic plan --task` for one concrete task. Don't start spec or code work. If it's a code change, work out which spec it belongs to, and tell the user. If it could be more than one, or none clearly fits, ask. When work starts on a task, run `cclinic tasks start <id>`, and use the task's spec.

**2. Refine the spec, and get it approved.**
- **New feature:** use the `refine-spec` skill if it belongs in an existing spec, or the `create-spec` skill if not.
- **Bug or issue:** use `refine-spec`. Add a test case that reproduces it, and correct any requirement that's wrong or missing.
- **No behaviour change**, such as a refactor, formatting, a typo or a dependency update: no spec update is needed. Go to stage 3.

Show what changed in `spec.md`, `validation.md` and `verification.md`, and any open questions. Then offer the user three options, and stop until they choose one. Don't change production code until they clearly approve:
- **`approve`:** go to stage 3.
- **`refine`:** refine the spec with the changes they ask for, and offer the three options again. A rejection works the same way.
- **`review-doc`:** use the `review-doc` skill to write a visual doc of how the project will work and look after the change, in `.cclinic/reviews/<spec-name>/review.md`. Give the user its path, ask them to review it, and offer `approve` or `refine`. A review doc isn't approval, and it changes no production code.

Any other reply, such as a question, isn't approval: answer it, and offer the options again.

**3. Implement, test, and get it approved.** Use the `implement-spec` skill, with the `write-code` skill for all code. If the spec turns out to be wrong, go back to stage 2. Then, in this order:
1. **Test it as QA.** Use the `test-spec` skill to test the change against the spec's `verification.md` and `validation.md`, even if the spec didn't change. If no spec covers the change, QA runs the project's full checks and reports that. If your tool can run a separate agent, run QA there, so the code isn't checked by the agent that wrote it. If you're running QA for the agent that implemented the change, follow only the `test-spec` skill. Don't start this lifecycle, change the spec or stop at stage 2.
2. **Fix what fails.** For each failed test case or unmet acceptance criterion, decide whether the code, the test or the spec is wrong. Fix wrong code with the `write-code` skill and send it back to QA. Fix a wrong test the same way, so it checks what the spec says. If the spec is wrong, go back to stage 2. Never weaken a test to get a pass. QA runs at most 3 times for a change, counting every run, whatever was fixed. If the 3rd QA run still fails, stop: report what fails, show the preview if it can start, and don't ask for approval. The count starts again only after the user replies, such as approving a spec change or requesting a change.
3. **Review the code.** Once QA passes, review the change with the `review-code` skill, even if the spec didn't change, and name the files the change touched. If your tool can run a separate agent, run the review there. If you're reviewing for the agent that implemented the change, follow only the `review-code` skill. Don't start this lifecycle, change the spec or stop at stage 2. Fix each `blocking` and `should-fix` finding with the `write-code` skill, without changing behaviour the spec doesn't ask to change, or say in the report why you think it's wrong. If a finding shows the spec is wrong, go back to stage 2. Report `nit` findings, and fix them only if the user asks. After fixing, run QA again, which counts toward its limit, then the review again. If the fixes need QA and the 3 QA runs are used up, stop: report the findings and the untested fixes, show the preview if it can start, and don't ask for approval. The review runs at most 3 times for a change, counting every run, and the count starts again only after the user replies. If the 3rd review still has `blocking` or `should-fix` findings, stop: report them, show the preview if it can start, and don't ask for approval.
4. Report each requirement, the tests you ran and their real results, including the QA rounds, and the review: findings fixed, findings you disagreed with and why, `nit` findings and follow-ups left, and whether Claude Code's review ran.
5. **Show a preview. Don't ask for approval until you've done this.** Run each `start` command in `.cclinic/environment/environment.json`, so the local environment includes this change, leave it running, and check it. A server you start yourself doesn't count. If the file doesn't exist, set it up with the `local-env` skill. Give the user the link, simulator build or command to try. If there's nothing to run, or it can't start, say why.
6. Ask the user to test it by hand, with steps for each `manual` test case QA didn't run. Ask the user to approve the implementation or request changes. If they request changes, make them, take them through QA and the review again, show the preview again, and ask again.

**4. Ask to commit.** Once the user approves the implementation, run `cclinic tasks done <id>` if it was a task, state any `blocking` or `should-fix` review finding that's still open, then ask whether to commit it. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change, and leave out review docs in `.cclinic/reviews/` unless the user asks for them. Don't push unless asked. If they decline, leave the changes uncommitted.

If the user tells you to skip a stage, do as they ask, and say which stage was skipped. If `.cclinic/sdd` doesn't exist, ask the user to run `cclinic` first. If nobody can answer, as in an unattended run, stop at stage 2 and report the spec, because silence isn't approval.

### Documents and skills

Follow `.cclinic/sdd/developer-guidelines.md` for all code.

Skills are in `.agents/skills/<name>/SKILL.md`. If your tool doesn't load skills automatically, read the matching file and follow it:

| Skill | Purpose |
|---|---|
| `create-spec` | Writes a new spec for a feature or capability, with requirements, acceptance criteria and test cases |
| `refine-spec` | Improves an existing spec: fixes vague or untestable requirements, fills coverage gaps, updates it to match the code, and resolves open questions |
| `write-code` | Writes or changes code the way a careful maintainer of this project would: following its stack, architecture and conventions, in small changes without unnecessary comments or abstractions |
| `implement-spec` | Builds a spec requirement by requirement, with tests from its test cases, and reports proof that each one works |
| `test-spec` | Acts as QA for a spec or feature: automates its test cases, runs them, explores edge cases, and reports results and defects |
| `local-env` | Sets up a local environment suited to the project, and shows how to review each change, such as a link or a simulator build |
| `product-engineer` | Plans what to build as the PM: asks the user questions and proposes a roadmap of milestones and tasks with their dependencies, or one concrete task |
| `review-doc` | Writes a simple, visual review doc for a spec change, with diagrams, screenshots and mockups of how the project will work and look after it |
| `review-code` | Reviews a change against the project's coding rules and developer guidelines, and reports findings by severity with a verdict, without changing code |

This section is managed by cclinic, so keep your own notes outside the markers.
<!-- cclinic:end -->
