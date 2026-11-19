# code-review: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest. Skill and workflow text tests go in `src/core/agent-skills.test.ts`, install tests in `test/integration/` and `test/e2e/skills.test.ts`.
- What the skill makes an agent do can only be judged with a real agent, so those cases are `manual`. Repeat each at least 3 times, and judge by the stated result rather than exact wording.
- Manual fixture: a small project with luseen installed and an uncommitted change that contains a hardcoded timeout (`setTimeout(fn, 30000)`), a function copied from an existing helper, a variable named `data`, one class that both parses input and writes files, and a lint error. A second fixture adds a `CONTRIBUTING.md` rule that allows numeric literals in tests.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-CREV-001 | FR-CREV-001 | integration | An empty target | Run `luseen skills` | `review-code` is in `.agents/skills` and `.claude/skills` with identical content, and is listed in the `AGENTS.md` skills table |
| TC-CREV-002 | FR-CREV-001 | unit | The list of skills | Read the skill names | One is `review-code`, and none is `code-review` |
| TC-CREV-003 | FR-CREV-001 | integration | An edited installed `review-code` skill, and in another target a user's own skill named `review-code` | Install, with and without `--force` | The user's own skill is never changed. The edited one is kept and reported without `--force`, and replaced with it |
| TC-CREV-004 | FR-CREV-002 | unit | The `review-code` skill | Run the skill format checks, and search the text | It passes, and it names Claude Code only in the optional Claude Code step |
| TC-CREV-005 | FR-CREV-003 | unit | The `review-code` skill | Search the text | It names the project's own rules, `<docs>/developer-guidelines.md` with the configured docs folder, and the built-in checklist, in that order, and says the earlier source wins and each finding cites its rule |
| TC-CREV-006 | FR-CREV-004 | unit | The `review-code` skill | Search the checklist | It covers spec correctness, design, SOLID, KISS, YAGNI, DRY, hardcoded values and constants, naming, error handling, security, tests, comments and dead code, and outdated docs |
| TC-CREV-007 | FR-CREV-005, FR-CREV-011 | unit | The `review-code` skill | Search the text | It reviews only the files the change touched, named by the implementing agent or else every uncommitted file, including new, spec and test files, and lists problems elsewhere as follow-ups that don't affect the verdict |
| TC-CREV-008 | FR-CREV-006 | unit | The `review-code` skill | Search the text | It runs the formatter, linter, type checker and tests first, treats a failure in or caused by the changed files as `blocking`, and a failure only in other files as a follow-up |
| TC-CREV-009 | FR-CREV-007 | unit | The `review-code` skill | Search the text | It defines `blocking`, `should-fix` and `nit`, and each finding has severity, file and line, rule and source, reason and fix |
| TC-CREV-010 | FR-CREV-008 | unit | The `review-code` skill | Search the text | It runs Claude Code's `code-review` when available at the explicit level `medium`, says not to rely on the default level, passes no `--fix`, `--comment`, `max` or `ultra` unless the user asks, and says in the report when it isn't available |
| TC-CREV-011 | FR-CREV-009 | unit | The `review-code` skill | Search the text | It confirms each finding against the code and drops what it can't confirm |
| TC-CREV-012 | FR-CREV-010 | unit | The `review-code` skill | Search the text | It forbids changing code, tests and specs, and ends with a report and an `approve` or `changes` verdict defined by the open findings |
| TC-CREV-013 | FR-CREV-012 | unit | The rendered `AGENTS.md` section | Find the stage 3 steps | The review step with `review-code` comes after QA and before the preview, says to use a separate agent when possible, and applies to changes with no spec update |
| TC-CREV-014 | FR-CREV-013 | unit | The rendered `AGENTS.md` section | Search stage 3 | It says to fix `blocking` and `should-fix` findings with `write-code` without changing unrequested behaviour, to explain a finding it disagrees with, to go back to stage 2 if the spec is wrong, and to fix `nit` findings only when asked |
| TC-CREV-015 | FR-CREV-014 | unit | The rendered `AGENTS.md` section | Search stage 3 | After fixes it runs QA then the review again, the QA run counts toward the QA limit, the review runs at most 3 times, and the count starts again only after the user replies. If review fixes need QA and the 3 QA runs are used up, it stops, reports, shows the preview if possible and doesn't ask for approval |
| TC-CREV-016 | FR-CREV-015 | unit | The rendered `AGENTS.md` section | Search stage 3 | After the 3rd review with open `blocking` or `should-fix` findings, it stops, reports them, shows the preview if possible, and doesn't ask for approval |
| TC-CREV-017 | FR-CREV-016 | unit | The rendered `AGENTS.md` section | Search stage 3's report step | It includes fixed findings, disagreed findings with reasons, `nit` findings, follow-ups, and whether Claude Code's review ran |
| TC-CREV-018 | FR-CREV-017 | unit | The rendered `AGENTS.md` section | Search stage 4 | It states open `blocking` or `should-fix` findings before asking to commit |
| TC-CREV-019 | FR-CREV-018 | unit | The rendered `AGENTS.md` section | Search the review step | A review run for the implementing agent follows only `review-code`, and doesn't start the lifecycle, change the spec or stop at stage 2 |
| TC-CREV-020 | FR-CREV-019 | unit | The `implement-spec` skill | Search its steps | It has the review step after QA and before showing how to review it, with the fix, re-QA, 3-run limit and report rules |
| TC-CREV-021 | FR-CREV-020 | unit | The rendered `AGENTS.md` section | Count lines | Fewer than 200 |
| TC-CREV-022 | FR-CREV-003, FR-CREV-004, FR-CREV-007 | manual | The first manual fixture, in Claude Code and in one other agent | Ask the agent to review the change with `review-code` | Findings include the hardcoded timeout, the duplicated helper, the name `data` and the two-job class, each with severity, location, cited rule and fix, and the lint error is `blocking` |
| TC-CREV-023 | FR-CREV-003 | manual | The second manual fixture, with a numeric literal in a test | Review | No finding for the numeric literal in the test, and the review cites `CONTRIBUTING.md` if it mentions it |
| TC-CREV-024 | FR-CREV-008, FR-CREV-009 | manual | The first fixture, in Claude Code, and then in an agent without `/code-review` | Review | In Claude Code, the report says its review ran and marks the findings it added. In the other agent, it says it didn't run, and the checklist findings are still there |
| TC-CREV-025 | FR-CREV-005, FR-CREV-011 | manual | The first fixture, plus a pre-existing vague name in a file the change doesn't touch | Review | The pre-existing problem is a follow-up, and doesn't change the verdict |
| TC-CREV-026 | FR-CREV-012, FR-CREV-013, FR-CREV-014, FR-CREV-016 | manual | A project with luseen installed and an approved spec change | Ask the agent to implement it, and approve when asked | Order is QA, review, fixes, QA, review, preview, approval. The report lists the review findings and what was done with each |
| TC-CREV-027 | FR-CREV-015 | manual | A project whose `developer-guidelines.md` has a rule the agent can't meet without breaking a test the spec needs | Ask the agent to implement the change | After the 3rd review it stops, reports the open finding and doesn't ask for approval |
| TC-CREV-028 | FR-CREV-017 | manual | A change with an open `should-fix` finding the agent disagreed with, approved by the user | Reach stage 4 | The open finding is stated before the commit question |
| TC-CREV-029 | FR-CREV-001 | manual | A project with luseen installed, in Claude Code | Type `/code-review` | Claude Code's built-in review runs, not the `review-code` skill |
| TC-CREV-030 | FR-CREV-021 | unit | The rendered `AGENTS.md` section and the `implement-spec` skill | Search the step for requested changes | Both say to take requested changes through QA and the review again, then show the preview again |
| TC-CREV-031 | FR-CREV-005, FR-CREV-012 | unit | The rendered `AGENTS.md` section and the `implement-spec` skill | Search the review step | Both say to name the files the change touched for the reviewer |
| TC-CREV-032 | FR-CREV-005, FR-CREV-006 | manual | The first manual fixture, plus an unrelated uncommitted file with a lint error that the change doesn't touch | Implement a small approved change, and let the agent run the review | The unrelated file isn't reviewed or changed, its lint error is a follow-up, and the verdict depends only on the change |
| TC-CREV-033 | FR-CREV-021 | manual | A change at the preview, in a project with luseen installed | Request a change that adds a hardcoded value | The agent runs QA and the review again, fixes or reports the finding, then shows the preview again |
| TC-CREV-034 | FR-CREV-022 | unit | The rendered AGENTS.md section and `implement-spec` skill | Search them | They say to report each review with `review_report`, with the verdict and findings by severity, when the luseen MCP tools are available |
| TC-CREV-035 | FR-CREV-023 | integration | An auto run whose fake reviewer returns `approve` | Run `luseen auto --yes` and read the call log | The reviewer was started by the task server, not by the developer, its prompt names `review-code`, and its verdict was recorded |
| TC-CREV-036 | FR-CREV-024 | unit | The `implement-spec` and `review-code` skills | Search them | `implement-spec` has the same task-saving and task-question rules as the workflow; `review-code` says each follow-up gives the file, line and problem, and that it doesn't save tasks |
