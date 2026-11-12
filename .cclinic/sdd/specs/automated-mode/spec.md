# automated-mode

## Goal

Let a user hand a whole saved roadmap created beforehand by the PM agent with `cclinic plan` ([roadmap-planning](../roadmap-planning/spec.md)), to a team of Claude CLI agents that works with no human in the loop. Developer agents take tasks in dependency order, several at once. Each task's steps are run by its own `cclinic mcp` server in `pm-agent` mode ([mcp-server](../mcp-server/spec.md)): a product manager (PM) agent approves each spec change and reviews each finished task, a QA agent tests it end to end, and a reviewer agent reviews the code. Each run works on its own branches and never touches the user's checked-out branch. The user gets a notification and a report when it finishes.

Roadmaps, milestones, tasks, dependencies and the `blocked` status are stored as described in [task-tracking](../task-tracking/spec.md). The skills the agents follow (`create-spec`, `refine-spec`, `write-code`, `implement-spec`, `test-spec`) are in [agent-skills](../agent-skills/spec.md). Running Claude is covered by [llm-providers](../llm-providers/spec.md).

## Roles

| Role | Runs as | Does |
|---|---|---|
| Orchestrator | cclinic itself, no LLM | Picks tasks, creates branches and worktrees, starts each task's developer agent with its own `cclinic mcp --approver pm-agent` server, makes every Git commit and merge, updates `tasks.db`, adds up costs, writes the report, notifies the user |
| Task server | `cclinic mcp --approver pm-agent`, one per task, started for the developer agent | Runs the task's steps and gates, starts the PM, QA and reviewer agents, enforces the per-task limits ([mcp-server](../mcp-server/spec.md)) |
| Developer | A `claude -p` process in the task's worktree, with the task server as its only MCP server | Drives the task through the server's tools: creates or refines the spec, implements it, and fixes what the PM, QA or reviewer reports |
| PM | A separate `claude -p` process, read-only, started by the task server | Approves or sends back the spec change, then approves or sends back the finished work |
| QA | A separate `claude -p` process in the task's worktree, started by the task server | Tests the change against the spec with the `test-spec` skill, including end-to-end tests |
| Reviewer | A separate `claude -p` process in the task's worktree, started by the task server | Reviews the change with the `review-code` skill, without changing files |

## Per-task flow

1. Developer: spec, using `refine-spec` (when the task names a spec) or `create-spec`, then asks the server to move on.
2. PM (started by the server): spec review, `approve` or `refine` with feedback. On `refine`, back to step 1.
3. Developer: implement, using `implement-spec` and `write-code`.
4. QA (started by the server): test. On `fail`, the developer fixes, and QA runs again.
5. Reviewer (started by the server): code review. On `changes`, the developer fixes, then back to step 4.
6. PM (started by the server): implementation review, `approve` or `changes` with feedback. On `changes`, the developer fixes, then back to step 4.
7. Orchestrator: when the server reports the change `done`, commits on the task branch, merges it into the run branch, and marks the task `done`.

## Requirements

### Starting a run

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-001 | `cclinic auto --roadmap <id>` must run the whole roadmap: every task in the roadmap's milestones with status `open` or `blocked`. Tasks that are `done` must be left as they are, and tasks that are `in-progress` must be skipped and reported, since someone may be working on them. A roadmap ID that doesn't exist must exit 2. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-002 | `cclinic auto` must accept `--roadmap <id>`, `-C, --dir <path>`, `--developers <n>` (1 to 8, default 2), `--max-budget-usd <amount>` (required, greater than 0), `--model`, `--effort`, `--timeout-minutes`, `--yes` and `--json`. A missing or out-of-range value must exit 2 and start nothing. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-003 | Before starting anything, cclinic must check that the provider is the Claude CLI and `claude` is installed, that the folder is a Git repository with at least one commit, that the working tree has no uncommitted changes to files in the last commit (new files, staged or not, are allowed, and so are changes to `.cclinic/tasks.db`, which cclinic itself updates), that the cclinic skills are installed, and that the roadmap has at least one task that is `open` or `blocked`. Each failed check must exit 2 with a message naming the check and how to fix it, and change nothing. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/adapters/llm/select-provider.ts`, `src/adapters/git/git-repository.ts` |
| FR-AUTO-004 | Before starting, cclinic must check the dependencies of the selected tasks. A dependency cycle must exit 2 and name the tasks in the cycle. A selected task that depends on a task that is neither `done` nor selected must be reported as blocked before the run starts, and not run. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-005 | Before starting, cclinic must show the plan: the roadmap's ID and title, each task in run order with its dependencies, the run branch name, the number of developers and the budget, and ask for confirmation. `--yes` must skip the question. With no TTY and no `--yes`, it must exit 2 and start nothing. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/cli/other-commands.ts` |
| FR-AUTO-034 | Without `--roadmap`, `cclinic auto` in a TTY must show the roadmaps (ID, title, status and number of tasks to run) and let the user choose one. With no TTY, it must exit 2, list the roadmap IDs, and point to `cclinic tasks roadmaps`. With no roadmaps, it must exit 2 and say to create one with `cclinic plan`. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |

### Scheduling

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-006 | A task must start only when every task it depends on is `done`, either before the run or by being merged into the run branch during it. | confirmed | `src/application/automation.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-007 | At most `--developers` tasks must be worked on at the same time. When a slot is free, the next ready task must start, in roadmap order (milestone position, then task ID). | confirmed | `src/application/automation.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-008 | When a task becomes `blocked`, every selected task that depends on it, directly or indirectly, must be skipped and reported as blocked by that task, and the other tasks must continue. | confirmed | `src/application/automation.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-009 | When a task starts, cclinic must set its status to `in-progress` in the project's `tasks.db`. When it's merged, it must set it to `done`, so the roadmap's status shows progress. When it can't be finished, it must set it to `blocked`. | confirmed | `src/application/automation.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/adapters/storage/task-store.ts:160` |

### Branches and worktrees

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-010 | Each run must create a run ID (UTC time `YYYYMMDD-HHMMSS`, plus a suffix if it's already used) and a run branch `cclinic/auto/<run-id>/run` from the current `HEAD`. Git can't hold a branch and branches below it with the same name, so the run branch has its own `/run` name. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `git worktree add` refuses `cclinic/auto/<run-id>/task-1` when `cclinic/auto/<run-id>` exists |
| FR-AUTO-011 | Each task must get its own branch `cclinic/auto/<run-id>/task-<id>`, created from the run branch's tip when the task starts, and its own Git worktree at `.cclinic/auto/<run-id>/worktrees/task-<id>`. Every agent for that task must run in that worktree. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-012 | The run must never change the user's checked-out branch, index, or working tree other than `.cclinic/tasks.db` (FR-AUTO-009) and `.cclinic/auto/`, never push, and never create, change or delete a branch outside `cclinic/auto/<run-id>/`. Worktree folders must not show as untracked files in the user's working tree. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `.cclinic/sdd/overview.md` |
| FR-AUTO-013 | After the PM approves a task, cclinic itself must commit every change in the task's worktree to the task branch, with a message that starts with the task ID and title and lists the requirement IDs the PM reported, and then merge the task branch into the run branch without fast-forward. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-014 | If merging a task branch into the run branch conflicts, cclinic must abort the merge, leave the run branch as it was, keep the task branch, and set the task to `blocked` with the conflicting files as the reason. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-015 | When a task is merged, its worktree must be removed and its task branch kept. When a task is blocked, its worktree must be removed and its task branch kept with any work committed to it, marked `WIP` in the commit message. | confirmed | `src/adapters/git/run-branches.ts`, `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |

### Agents

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-016 | Every agent must run as a separate `claude -p` process with `--permission-mode dontAsk`, `--safe-mode`, `--session-id <uuid>` (a new UUID for each agent call, as FR-AUTO-039 records), the run's model and effort, and a per-call `--max-budget-usd` no higher than the budget left in the run. It must not pass `--no-session-persistence`, so the GUI can show the session ([gui](../gui/spec.md)). | confirmed | `src/adapters/llm/agent-process.ts` `buildAgentArgs`, `src/cli/auto-command.ts` `agentRunner`, `test/integration/automation.test.ts` TC-AUTO-021, `src/adapters/llm/agent-process.test.ts`, `.cclinic/sdd/specs/gui/spec.md`, `user request` |
| FR-AUTO-017 | No agent may run `git`, `sudo`, or read `.env` files or other secret files. Developer and QA agents may write only inside their task's worktree. The PM agent may only read files (Read, Glob, Grep) and run no commands. | confirmed | `src/adapters/llm/agent-process.ts`, `src/core/constants/agents.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/constants/environment.ts` |
| FR-AUTO-018 | The developer's prompt must say it works in automated mode: it must follow the project's `AGENTS.md` lifecycle and skills, drive the task through the task server's tools, not wait for a human, since the PM agent the server starts gives approvals, and not commit, push or change `tasks.db`. | docs-only | `src/adapters/llm/agent-process.ts`, `src/core/constants/agents.ts`, `src/core/automation.ts`, `AGENTS.md`, `.cclinic/sdd/specs/mcp-server/spec.md`, `user request` |
| FR-AUTO-019 | The PM's spec review, started by the task server, must check the spec change against the task's title and description and its milestone's goal, and return a JSON verdict of `approve`, or `refine` with feedback. On `refine`, the developer must get the feedback and revise the spec. | docs-only | `src/application/automation.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-031, `user request` |
| FR-AUTO-020 | Implementation must not start until the PM has approved the spec. | confirmed | `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `AGENTS.md` |
| FR-AUTO-021 | The QA agent, started by the task server, must be a different process from the developer, follow the `test-spec` skill, run the spec's test cases including end-to-end tests where the spec has them, and return a JSON result of `pass`, or `fail` with each failing test case and its output. On `fail`, the developer must get the failures and fix them. | docs-only | `src/application/automation.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-032, `AGENTS.md`, `user request` |
| FR-AUTO-022 | The PM's implementation review, started by the task server, must check the diff, the latest QA result and the latest code review against the spec and the task, and return a JSON verdict of `approve` with the requirement IDs covered, or `changes` with feedback. A `changes` verdict must send the work back to the developer, then to QA and the code review again. | docs-only | `src/application/automation.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-031, `user request` |
| FR-AUTO-023 | A PM or QA reply that isn't a valid verdict, and an agent that fails, times out or hits its budget, must count as a rejected round, with the reason saved. | confirmed | `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |

### Task server

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-035 | For each task, cclinic must start the developer agent with `cclinic mcp --approver pm-agent --run <run-id> --task <id> --max-budget-usd <amount>` as its only MCP server, in the task's worktree, and must not run the PM, QA or reviewer agents itself. | docs-only | `src/application/automation.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-002, FR-MCP-031 to FR-MCP-037, `user request` |
| FR-AUTO-036 | When the developer agent ends, cclinic must read the task's workflow state: when the change is `done`, it must commit and merge as FR-AUTO-013 says; when it's `blocked`, it must block the task with the recorded reason; otherwise it must block the task with the step the change stopped at as the reason. | docs-only | `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-035, FR-MCP-038, `user request` |
| FR-AUTO-037 | The `--max-budget-usd` given to a task server must be no higher than the budget left in the run when the task starts, and the cost the server records must be added to the run's total cost, the task's cost in `run.json`, and the report. | docs-only | `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-036, `user request` |
| FR-AUTO-038 | Each task must go through a code review by a reviewer agent the task server starts with the `review-code` skill, after QA passes and before the PM's implementation review. | docs-only | `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-033, `.cclinic/sdd/specs/code-review/spec.md`, `user request` |

### Limits

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-024 | Each task must have at most 3 PM spec reviews, 3 QA runs, 3 code reviews and 3 PM implementation reviews, counted by the task server. When any limit is reached without approval or a pass, the task must become `blocked`, with the last feedback or failures as the reason. | docs-only | `src/application/automation.ts`, `src/core/constants/agents.ts:32`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-035, `AGENTS.md`, `user request` |
| FR-AUTO-025 | The total cost of all agents must not go over `--max-budget-usd`. When the budget left can't cover another agent call, cclinic must start no new agent, let running agents finish, set unfinished tasks back to `open`, and end the run as `budget-reached`. | confirmed | `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/adapters/llm/environment-agent.ts:54` |
| FR-AUTO-026 | Each agent call must stop at `--timeout-minutes` (default 30). | confirmed | `src/application/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/constants/limits.ts:14` |

### Finishing

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTO-027 | cclinic must keep the run's state in `.cclinic/auto/<run-id>/run.json`, updated after every step: each task's status, branch, rounds, cost and reason, and each agent's final message in `.cclinic/auto/<run-id>/logs/`. Secrets must be redacted from both. | confirmed | `src/adapters/storage/run-store.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/redaction.ts` |
| FR-AUTO-039 | For every agent started for a run, by the orchestrator or by a task server, cclinic must write `.cclinic/auto/<run-id>/sessions/<session-id>.json` atomically before the agent starts. It holds the session ID, task ID, role (`developer`, `pm`, `qa` or `reviewer`), the step name used for its log, the working folder, the transcript path Claude Code writes for that session under `~/.claude/projects/`, and the start time. When the agent ends, the end time, exit status and the cost Claude Code reported (null when it reported none) must be added. It must hold no prompt or agent output. | docs-only | `src/cli/auto-command.ts` `agentRunner`, `src/core/automation.ts` `agentSessionSchema`, `test/integration/automation.test.ts` TC-AUTO-057, TC-AUTO-058, TC-AUTO-060 (orchestrator agents only; task-server agents wait for the `pm-agent` approver, `src/cli/mcp-command.ts`), `src/adapters/llm/agent-process.ts`, `src/adapters/storage/run-store.ts`, `.cclinic/sdd/specs/gui/spec.md` FR-GUI-030, FR-GUI-039, `user request` |
| FR-AUTO-040 | `cclinic auto --dry-run` must make every check `cclinic auto` makes before a run starts (a run already going, the project's readiness, the roadmap, its open tasks and dependency cycles), refusing with the same message and exit code, then print the plan `cclinic auto` shows and exit 0. It must start no agent, take no lock, and create no branch, folder or file. With `--json`, stdout must be exactly one JSON document holding `status` `plan`, the roadmap ID, the plan text, the task IDs to run in order, and the IDs already blocked. | confirmed | `src/cli/auto-command.ts` `runAutoCommand`, `test/integration/automation.test.ts` TC-AUTO-061, TC-AUTO-062, `user request`, `.cclinic/sdd/specs/gui/spec.md` FR-GUI-027 |
| FR-AUTO-028 | At the end, cclinic must write `.cclinic/auto/<run-id>/report.md`, listing the roadmap's ID and title, the run branch, the outcome (`completed`, `partial`, `budget-reached` or `interrupted`), each task with its result, branch, rounds and cost, the reason each blocked task stopped, the total cost, and how to review and merge the run branch. | confirmed | `src/adapters/storage/run-store.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-029 | When the run ends, for any outcome, cclinic must send a desktop notification with the roadmap's title, the outcome and the number of tasks done and blocked: `osascript` on macOS, `notify-send` on Linux when it's installed, and otherwise a terminal bell and a printed message. A failed notification must not change the exit code. | confirmed | `src/adapters/notify/desktop-notifier.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-030 | The exit code must be 0 when every selected task is `done`, 1 when the run ended `partial` or `budget-reached`, and 2 for a usage or precondition error. With `--json`, stdout must be exactly one JSON document with the outcome, the run branch, the report path and each task's result. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/errors.ts:42-51` |
| FR-AUTO-031 | On Ctrl+C or SIGTERM, cclinic must stop every agent, commit no unapproved work to the run branch, set in-progress tasks back to `open`, remove the worktrees, keep the branches, write the report with outcome `interrupted`, notify, and exit 130 or 143. | confirmed | `src/cli/auto-command.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/errors.ts:48-49` |
| FR-AUTO-032 | Only one automated run may work on a project at a time. A second `cclinic auto` must exit 2 and name the run that's in progress. A lock left by a process that is no longer running must be replaced. | confirmed | `src/adapters/storage/run-store.ts`, `src/core/automation.ts`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request` |
| FR-AUTO-033 | `cclinic clean` must not delete `.cclinic/auto`, and the files in it must not affect analysis, the cache or generated documents. | confirmed | `src/core/constants/discovery.ts:85`, `test/integration/automation.test.ts`, `test/integration/automation-flow.test.ts`, `test/e2e/auto.test.ts`, `user request`, `src/core/constants/discovery.ts:85` |

## Edge cases

- A task with no milestone belongs to no roadmap, and isn't run.
- A task that was `blocked` in an earlier run is tried again from the start, on a new task branch.
- A task depends on a task in another roadmap that isn't `done`: it's reported as blocked before the run starts (FR-AUTO-004).
- A task with no spec: the developer uses `create-spec`, and the new spec goes through the same PM review.
- Two developers change the same spec or file: the second merge may conflict, and that task is blocked (FR-AUTO-014). Its dependants are skipped.
- A dependency is `done` but its work was made outside this run: it counts as done, since the run branch starts from `HEAD`.
- Every selected task is blocked before the run starts: nothing runs, the report is still written, the user is notified, and the exit code is 1.
- QA has nothing to run end to end, such as a docs-only change: QA runs the project's full checks, as the `test-spec` skill says, and reports that.
- The PM approves the spec but finds later that the spec is wrong: it returns `changes`, and the developer may change the spec again, which counts toward the implementation review limit.
- The budget runs out mid-task: that task goes back to `open`, and its task branch keeps any work as a `WIP` commit.
- `tasks.db` is changed by the user during a run: cclinic reads each task again before starting it, and skips any that was removed or is no longer `open`.
- The user's `HEAD` moves during the run: the run branch is unaffected.
- The developer agent crashes or times out before the change is `done`: the task is blocked with the step it stopped at (FR-AUTO-036).
- The task server can't start, such as a broken install: the developer agent has no cclinic tools, ends without a `done` change, and the task is blocked with that reason.
- `.cclinic/tasks.db` is committed: each run updates task statuses in it, so it shows as modified afterwards. That doesn't stop the next run.

## Non-goals

- Pushing branches, opening pull requests or merging into the user's branch. The user does that after reading the report.
- Running a single task, one milestone, several roadmaps, or tasks outside a roadmap. Automated mode only runs a whole roadmap. A standalone task is worked on through the normal `AGENTS.md` lifecycle, or planned into a roadmap with `cclinic plan --task --roadmap <id>`.
- Resuming an interrupted or budget-limited run. A new run takes the tasks that are still `open`.
- Agents other than the Claude CLI, or the Anthropic API provider.
- Running agents in the cloud or on other machines.
- Fixing merge conflicts with an agent.
- Notifications by email, chat or webhook.
- Creating roadmaps, milestones or tasks. That's `cclinic plan`, with the user.
