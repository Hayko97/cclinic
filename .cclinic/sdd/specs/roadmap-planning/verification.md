# roadmap-planning: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest, with unit tests colocated in `src/core`, and integration and e2e tests in `test/integration` and `test/e2e`.
- Each test uses a fresh temporary project with `.cclinic/sdd` and the cclinic skills installed.
- No test calls real Claude. A fake `claude` on `PATH` (extending `test/fixtures/fake-claude/claude`) returns a scripted sequence of replies (questions, proposals, invalid JSON), costs and delays, and records its arguments and prompt for each call.
- Interactive tests drive cclinic through a pseudo-terminal with scripted answers.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-PLAN-001 | FR-PLAN-001 | e2e | A ready project | Run `plan` with `--roadmap abc`, `--max-budget-usd 0` and `--timeout-minutes 0` | Each exits 2, names the option, and the fake `claude` is never called |
| TC-PLAN-002 | FR-PLAN-002 | e2e | A ready project, stdin not a TTY | Run `plan` | Exit 2, the message says a terminal is needed, and no `tasks.db` is created |
| TC-PLAN-003 | FR-PLAN-003 | e2e | Projects with: the anthropic-api provider; no `claude` on `PATH`; no `.cclinic/sdd` | Run `plan` in a pseudo-terminal | Each exits 2 naming the failed check and how to fix it |
| TC-PLAN-004 | FR-PLAN-004 | integration | Roadmaps 1 and 2 exist | Run `plan` and choose "extend roadmap 2" | The list shows both with ID, title and status, and the PM prompt says it's extending roadmap 2 |
| TC-PLAN-005 | FR-PLAN-004 | integration | No roadmaps exist | Run `plan` | The choice offers only a new roadmap or a single task; choosing the first, the PM prompt asks for a new roadmap |
| TC-PLAN-006 | FR-PLAN-004 | e2e | Roadmap 1 exists | Run `plan --roadmap 99` | Exit 2 naming roadmap 99 |
| TC-PLAN-007 | FR-PLAN-005 | unit | The PM agent settings | Build the PM's arguments | They have `-p`, tools Read, Glob and Grep only, `--permission-mode dontAsk`, `--safe-mode`, `--no-session-persistence`, and deny reading `.env` and secret files; no Bash, Write or Edit |
| TC-PLAN-008 | FR-PLAN-006 | unit | Roadmap 1 with a task depending on another, and two earlier conversation turns | Build the PM prompt for extending roadmap 1 | It contains the product-engineer instructions, the overview and specs list paths, every roadmap with its tasks, statuses and dependencies, that roadmap 1 is being extended, and both earlier turns |
| TC-PLAN-009 | FR-PLAN-007 | unit | Replies: 2 questions; 0 questions; 6 questions; a full proposal; a proposal task missing `dependsOn`; a new-roadmap proposal with no title | Parse each | Only the 2-question reply and the full proposal are accepted |
| TC-PLAN-010 | FR-PLAN-008 | integration | The fake PM asks 2 questions, then proposes | Answer the first and leave the second empty | The second PM prompt has the first answer and "unknown" for the second, and the proposal shown includes the fake PM's open questions |
| TC-PLAN-011 | FR-PLAN-009 | unit | Proposals with: a 201-character title; spec `Auth`; `dependsOn` naming a missing key; `dependsOn` naming missing task 99; keys A → B → A; no milestones; a milestone with no tasks; a dependency on existing task 3 | Check each | All fail with a named problem except the one depending on existing task 3 |
| TC-PLAN-012 | FR-PLAN-009 | integration | The fake PM first proposes a cycle, then a valid proposal | Run `plan` | The user never sees the first proposal; the second PM prompt names the cycle; the second proposal is shown |
| TC-PLAN-013 | FR-PLAN-010 | integration | The fake PM returns invalid JSON once, then questions | Run `plan` | The second prompt contains the parse error, and the session continues |
| TC-PLAN-014 | FR-PLAN-010 | integration | The fake PM returns invalid JSON twice | Run `plan` | Exit code 4, and `tasks.db` is not created or not changed |
| TC-PLAN-015 | FR-PLAN-011 | integration | A valid proposal with 2 milestones, a task with spec `auth`, a task with `null` spec depending on it, and one open question | Run `plan` | The output shows the roadmap title and goal, milestones in order with goals, `auth` and "new spec", the dependency, the open question, and the `approve`, `refine` and `cancel` choices |
| TC-PLAN-016 | FR-PLAN-012 | integration | The fake PM proposes, then proposes again | Choose `refine` with "split task 2", then `approve` | The PM's next prompt contains "split task 2", and the second proposal is saved |
| TC-PLAN-017 | FR-PLAN-013 | integration | An empty project; a proposal with 2 milestones, 3 tasks and dependencies by key | Choose `approve` | One roadmap, 2 milestones in order and 3 `open` tasks are saved with dependencies mapped to the new IDs; the output has the roadmap ID and `cclinic auto --roadmap <id>` |
| TC-PLAN-018 | FR-PLAN-013 | integration | Roadmap 1 with 2 milestones; an extending proposal with 1 milestone | Run `plan --roadmap 1` and approve | The new milestone is position 3 of roadmap 1, and no new roadmap is created |
| TC-PLAN-019 | FR-PLAN-013 | integration | A store that fails while saving the third task | Approve a proposal | No roadmap, milestone or task from the proposal is in the database, the exit code isn't 0, and the proposal is printed |
| TC-PLAN-020 | FR-PLAN-014 | integration | A valid proposal | Choose `cancel` | Exit 0, and the database is unchanged |
| TC-PLAN-021 | FR-PLAN-014 | e2e | A fake PM that waits 10 seconds | Send SIGINT during the turn, then repeat with SIGTERM | The fake `claude` process ends, nothing is saved, and the exit codes are 130 and 143 |
| TC-PLAN-022 | FR-PLAN-015 | integration | A fake PM that always asks questions, at 0.01 USD per turn | Run `plan` and answer each question | The session stops after 20 PM turns with exit 4 naming the turn limit, and nothing is saved |
| TC-PLAN-023 | FR-PLAN-015 | integration | A fake PM costing 0.6 USD per turn, `--max-budget-usd 1` | Run `plan` | No turn starts once the remaining budget can't cover it, total cost is at most 1, exit 4 names the budget, nothing is saved |
| TC-PLAN-024 | FR-PLAN-015 | integration | A fake PM that never returns, with a shortened timeout | Run `plan` | The turn is stopped at the timeout |
| TC-PLAN-025 | FR-PLAN-016 | e2e | A ready project | Run `tasks roadmap add --title X`, `tasks milestone add --title M` and `tasks add --title T --milestone 1` | Each exits 2, says to use `cclinic plan`, and nothing is saved |
| TC-PLAN-026 | FR-PLAN-016 | integration | A full session that ends in `approve` | Watch `tasks.db` during the session | It isn't written until the user approves, and the fake `claude` was never given a write or Bash tool |
| TC-PLAN-027 | FR-PLAN-001, FR-PLAN-008, FR-PLAN-013 | manual | A real project and real Claude CLI | Run `cclinic plan`, answer the questions, refine once, and approve | The PM asks about goal, scope and done, the roadmap is saved, and `cclinic tasks roadmap show <id>` shows it with dependencies |
| TC-PLAN-028 | FR-PLAN-017 | integration | Roadmaps 1 and 2 | Run `plan --task` and choose roadmap 2; then run `plan --task` and choose standalone; then run `plan --task --roadmap 1` | The first PM prompt names roadmap 2 and its milestones; the second says standalone; the third asks no question and names roadmap 1 |
| TC-PLAN-029 | FR-PLAN-017 | e2e | Roadmap 1 | Run `plan --task --roadmap 99` | Exit 2 naming roadmap 99, and the fake `claude` isn't called |
| TC-PLAN-030 | FR-PLAN-018 | unit | Task-mode replies: one task with milestone 3; one standalone task; two tasks; a task with no title; a task whose `dependsOn` uses a key | Parse each | Only the first two are accepted |
| TC-PLAN-031 | FR-PLAN-018 | integration | Task mode; the fake PM asks a question, returns invalid JSON once, then proposes | Leave the answer empty, then choose `refine` with "smaller scope", then `cancel` | The answer is sent as "unknown", the parse error is sent back, the feedback reaches the PM, and after `cancel` nothing is saved and the exit code is 0 |
| TC-PLAN-032 | FR-PLAN-019 | unit | Task proposals for roadmap 1: milestone of roadmap 2; `milestoneId` `null`; dependency on missing task 99; a dependency that makes a cycle; a valid one | Check each | Only the valid one passes, and each failure names its problem |
| TC-PLAN-033 | FR-PLAN-019 | unit | A standalone task proposal with `milestoneId` 1 | Check it | It fails, saying a standalone task has no milestone |
| TC-PLAN-034 | FR-PLAN-020 | integration | Task mode for roadmap 1; a valid proposal in milestone 2, depending on task 4, with spec `null` | Choose `approve` | The output showed milestone 2, roadmap 1, "new spec" and task 4; one `open` task is saved in milestone 2 with dependency 4; the output has its ID and `cclinic auto --roadmap 1` |
| TC-PLAN-035 | FR-PLAN-020 | integration | Task mode, standalone, a store made to fail when saving the dependency | Approve | No task is saved |
| TC-PLAN-036 | FR-PLAN-020 | integration | Task mode, standalone, a valid proposal | Choose `approve` | The task is saved with no milestone, and the output has its ID, says it's worked on through the agent lifecycle, and contains no `cclinic auto` command |
