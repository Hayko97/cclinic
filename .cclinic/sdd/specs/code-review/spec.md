# code-review

## Goal

Add a code review step to the agent lifecycle. After QA passes and before the user sees the preview, a reviewer checks the change against the project's coding guidelines, and against Claude Code's built-in code review when the agent is Claude Code. The implementing agent fixes what the reviewer finds, so the user approves, and later commits, reviewed code.

A new `review-code` skill holds the review method. It's installed like the other skills ([agent-skills](../agent-skills/spec.md)), and the lifecycle in `AGENTS.md` ([agent-instructions](../agent-instructions/spec.md)) names the step.

## Where the step sits

```
Stage 3: implement → QA (test-spec) → code review (review-code) → fix → QA again → preview → user approval
Stage 4: ask to commit
```

The review runs before the preview, not after the user approves, so the code the user tries and approves is the code that gets committed. Fixing review findings after approval would change approved code.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-CREV-001 | cclinic must provide a skill named `review-code`, installed in `.agents/skills` and `.claude/skills`, protected from overwriting and listed in the `AGENTS.md` skills table like the other skills. It must not be named `code-review`, so it doesn't hide Claude Code's built-in `code-review` skill. | confirmed | `src/core/constants/paths.ts:13`, `src/core/agent-skills.ts:481`, `test/integration/skills.test.ts:281`, `user request` |
| FR-CREV-002 | The skill must follow the Agent Skills format, and must work with any coding agent: it must name no agent's tools except where FR-CREV-008 allows it. | confirmed | `src/core/agent-skills.ts:481-553`, `src/core/agent-skills.test.ts:570`, `user request` |
| FR-CREV-003 | The skill must review against these rule sources, in this order of precedence: the user's own project rules (such as `CONTRIBUTING.md`, the user's part of `AGENTS.md` or `CLAUDE.md`, and lint and formatter configuration), then `<docs>/developer-guidelines.md`, then the skill's built-in checklist. When two sources conflict, the earlier one must win, and the finding must cite the rule it uses. | confirmed | `src/core/agent-skills.ts:496-502`, `src/core/agent-skills.test.ts:577`, `user request` |
| FR-CREV-004 | The skill's built-in checklist must cover: correctness against the spec's requirements; design and fit with the architecture; SOLID; KISS and YAGNI; DRY, including reuse of existing helpers; no hardcoded values (magic numbers, strings, URLs, limits and paths go in the project's constants, configuration or existing named values); naming; error handling at boundaries; security (secrets, injection, unvalidated input); tests (each changed behaviour tested, tests check the spec, no weakened tests); unneeded comments, dead code and unused code; and docs that the change makes wrong. | confirmed | `src/core/agent-skills.ts:513-528`, `src/core/agent-skills.test.ts:591`, `user request` |
| FR-CREV-005 | The skill must review only the files the change touched, as named by the implementing agent or, when none are named, every uncommitted file: their diff, including new files, spec files and tests. It must read enough of the surrounding code to judge each changed line, and must report problems in other files, or in code the change doesn't touch, only as follow-ups. | confirmed | `src/core/agent-skills.ts:491`, `src/core/agent-skills.test.ts:612`, `src/core/agent-skills.test.ts:773`, `user request` |
| FR-CREV-006 | Before reviewing by hand, the skill must run the project's formatter, linter, type checker and tests, report their real results, and treat each failure in the changed files, or caused by them, as a `blocking` finding, rather than reviewing by hand what these tools check. A failure only in files outside the change must be a follow-up. | confirmed | `src/core/agent-skills.ts:507`, `src/core/agent-skills.test.ts:622`, `user request` |
| FR-CREV-007 | Each finding must give a severity (`blocking`, `should-fix` or `nit`), the file and line, the rule it breaks with its source, why it matters, and a suggested fix. `blocking` means a bug, a security problem, a failed check, or a change that doesn't meet the spec; `should-fix` means a broken rule from FR-CREV-003 or FR-CREV-004; `nit` means a matter of taste that no rule covers. | confirmed | `src/core/agent-skills.ts:530-553`, `src/core/agent-skills.test.ts:633`, `user request` |
| FR-CREV-008 | When the agent is Claude Code and its built-in `code-review` skill or command is available, the skill must also run it on the current change, at the explicit level `medium`, never relying on the default level, which reuses the last level the user typed. It must not pass `--fix`, `--comment`, `max` or `ultra` unless the user asks. It must check each of its findings against the code, and add the ones it confirms to the report, marked as from Claude Code's review. When it isn't available, the report must say so, and the checklist review still runs. | confirmed | `src/core/constants/paths.ts:16`, `src/core/agent-skills.ts:509`, `src/core/agent-skills.test.ts:643`, `user request` |
| FR-CREV-009 | The skill must confirm each finding against the code before reporting it, and must drop any it can't confirm, rather than report a guess. | confirmed | `src/core/agent-skills.ts:510`, `src/core/agent-skills.test.ts:656`, `user request` |
| FR-CREV-010 | The skill must not change code, tests or specs itself. It must end with a report listing the findings by severity, the checks it ran with their results, whether Claude Code's review ran, and a verdict: `approve` when no `blocking` or `should-fix` findings remain, otherwise `changes`. | confirmed | `src/core/agent-skills.ts:490`, `src/core/agent-skills.ts:553`, `src/core/agent-skills.test.ts:660`, `user request` |
| FR-CREV-011 | Problems the skill sees in code the change doesn't touch must be listed separately as follow-ups, and must not cause a `changes` verdict. | confirmed | `src/core/agent-skills.ts:491`, `src/core/agent-skills.test.ts:612`, `user request` |
| FR-CREV-012 | The workflow in `AGENTS.md` must tell agents, in stage 3, after QA passes and before the preview, to review the change with the `review-code` skill, in a separate agent if the tool can run one, including changes with no spec update. | confirmed | `src/core/agent-skills.ts:626`, `src/core/agent-skills.test.ts:665`, `src/core/agent-skills.test.ts:773`, `user request` |
| FR-CREV-013 | For each `blocking` or `should-fix` finding, the workflow must tell agents to fix it with the `write-code` skill without changing behaviour the spec doesn't ask to change, or, if they believe the finding is wrong, to say why in the report instead of fixing it. If a finding shows the spec is wrong, they must go back to stage 2. `nit` findings must be reported, and fixed only if the user asks. | confirmed | `src/core/agent-skills.ts:626`, `src/core/agent-skills.test.ts:675`, `user request` |
| FR-CREV-014 | After fixing review findings, the workflow must tell agents to run QA again, and then the review again. That QA run counts toward the 3-run QA limit (FR-INSTR-027). If review fixes need a QA run and the 3 QA runs are used up, agents must stop: report the findings and the untested fixes, show the preview if it can start, and not ask for approval. The review must run at most 3 times for a change, counting every run, and the count must start again only after the user replies. | confirmed | `src/core/agent-skills.ts:626`, `src/core/agent-skills.test.ts:686`, `src/core/agent-skills.test.ts:730`, `user request` |
| FR-CREV-015 | If the 3rd review still has `blocking` or `should-fix` findings, the workflow must tell agents to stop, report what's left, show the preview if it can start, and not ask for approval. | confirmed | `src/core/agent-skills.ts:626`, `src/core/agent-skills.test.ts:697`, `user request` |
| FR-CREV-016 | The stage 3 report must include the review: each finding fixed, each finding the agent disagreed with and why, the `nit` findings and follow-ups left, and whether Claude Code's review ran. | confirmed | `src/core/agent-skills.ts:627`, `src/core/agent-skills.test.ts:703`, `user request` |
| FR-CREV-017 | At stage 4, before asking to commit, the workflow must tell agents to state any `blocking` or `should-fix` finding that's still open, as it does for failed tests. | confirmed | `src/core/agent-skills.ts:631`, `src/core/agent-skills.test.ts:715`, `user request` |
| FR-CREV-018 | A review run for the implementing agent must follow only the `review-code` skill, and must not start the lifecycle, change the spec or stop at stage 2. | confirmed | `src/core/agent-skills.ts:494`, `src/core/agent-skills.ts:626`, `src/core/agent-skills.test.ts:723`, `user request` |
| FR-CREV-019 | The `implement-spec` skill must include the review step in the same place and with the same rules as the workflow (FR-CREV-012 to FR-CREV-016). Since it names no agent, it must report whether "the agent's built-in code review" ran. | confirmed | `src/core/agent-skills.ts:212`, `src/core/agent-skills.test.ts:730`, `user request` |
| FR-CREV-020 | The `AGENTS.md` section, with the new step, must stay under 200 lines (FR-INSTR-010). | confirmed | `src/core/agent-skills.test.ts:758`, `user request` |
| FR-CREV-021 | When the user requests changes after the preview, the workflow and the `implement-spec` skill must tell agents to make them, take them through QA and the review again, and show the preview again before asking again. | confirmed | `src/core/agent-skills.ts:629`, `src/core/agent-skills.ts:215`, `src/core/agent-skills.test.ts:764`, review-code run 1 finding, `user request` |
| FR-CREV-022 | When the cclinic MCP server is present, the workflow must tell agents to report each review with `review_report`, giving its verdict and the findings by severity, so the server counts the reviews and requires QA after each fix (FR-MCP-021, FR-MCP-022). | confirmed | `src/core/agent-skills.ts`, `src/core/agent-skills.test.ts`, `.cclinic/sdd/specs/mcp-server/spec.md`, `user request` |
| FR-CREV-023 | In auto mode, the review must be run by a reviewer agent the task server starts with this skill, not by the developer agent, and its JSON verdict must be `approve` or `changes` with the findings (FR-MCP-033). | docs-only | `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-033, `user request` |

## Changes to other specs

Adding a ninth skill changes these requirements, which must be updated with this spec:

- [agent-skills](../agent-skills/spec.md) FR-SKILL-001 and its goal: "exactly eight skills" becomes nine, adding `review-code`. VAL-SKILL-001 and TC-SKILL-021, TC-SKILL-030 and TC-SKILL-040 say nine too.
- [agent-skills](../agent-skills/spec.md) FR-SKILL-017: skills stay agent-agnostic, except the optional Claude Code step of `review-code` (FR-CREV-008).
- [agent-instructions](../agent-instructions/spec.md) goal: the lifecycle includes a code review in stage 3.

## Edge cases

- The agent isn't Claude Code, or Claude Code's `code-review` isn't available: the checklist review still runs, and the report says Claude Code's review didn't run.
- Claude Code's review reports something the agent can't confirm in the code: it's dropped, not reported.
- The project has no `developer-guidelines.md`, such as a custom `--out` folder that's missing it: the review uses the project's own rules and the built-in checklist, and says the guidelines file is missing.
- A project rule conflicts with the built-in checklist, such as a project that allows magic numbers in tests: the project rule wins, and no finding is reported.
- The change is a refactor with no spec: the review still runs, and checks that behaviour didn't change.
- The review finds only `nit` findings: the verdict is `approve`, and the nits are listed in the report.
- Fixing a review finding breaks a test: the next QA run catches it, and it's fixed or reported like any QA failure.
- The agent disagrees with a finding: it isn't fixed, and the report says why, so the user decides.
- The agent's tool can't run a separate agent: the review runs in the same session.
- The working tree has the user's unrelated work in progress, such as a file with a lint error: it isn't reviewed, its check failure is a follow-up, and the agent doesn't change it.
- QA passes on its 3rd run, then the review finds a `should-fix`: the agent can fix it but can't run QA again, so it stops and reports, without asking for approval.
- The user typed `/code-review max` earlier in the session: the review still runs Claude Code's review at `medium`.
- A user who asked to skip the review: it's skipped, and the agent says the review stage was skipped.
- Automated mode (`cclinic auto`): the task server starts a reviewer agent with this skill (FR-CREV-023), and no human is asked.

## Non-goals

- cclinic running a reviewer itself in manual mode, or enforcing the review with hooks or CI. In manual mode the review is guidance, checked by the MCP server when it's present. In auto mode the task server runs it (FR-CREV-023).
- Posting review comments to a pull request or another remote service.
- A new rules file or configuration for the review. The user sets rules in their own project files or in `developer-guidelines.md`.
- Fixing problems in code the change doesn't touch.
- Running Claude Code's `max` or `ultra` review levels, which are costly, unless the user asks.
