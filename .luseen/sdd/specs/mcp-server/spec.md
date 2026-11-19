# mcp-server

## Goal

Give coding agents a local MCP server, `luseen mcp`, that runs the spec-driven lifecycle for one change at a time as checked steps instead of written instructions. An agent moves from step to step by calling the server's tools, and the server refuses any step whose gate hasn't passed.

The server works in two modes, which differ only in who answers the gates:

| | Manual mode | Auto mode |
|---|---|---|
| Started by | Claude Code or Codex, from `.mcp.json` | `luseen auto`, once per task, for that task's developer agent |
| Approver | The user, asked through the host (MCP elicitation) | A PM agent the server starts |
| QA | A QA agent the host runs, which reports with `qa_report` | A QA agent the server starts |
| Code review | A reviewer the host runs with the `review-code` skill, which reports with `review_report` | A reviewer agent the server starts, with the `review-code` skill |
| Preview | Started with `preview_start` | Skipped and recorded |
| Commit | The agent commits, only if the user agrees | `luseen auto` commits and merges, as today |

The steps are the ones in `AGENTS.md` ([agent-instructions](../agent-instructions/spec.md)), including the code review step ([code-review](../code-review/spec.md)). Tasks are the ones in [task-tracking](../task-tracking/spec.md). Auto mode's run-level work (picking tasks, worktrees, usage limits, merging, report) stays in [automated-mode](../automated-mode/spec.md).

## Steps and gates

```
begin → spec ─[G1 spec approved]→ implement → qa ─[G2 QA passed]→ review ─[G3 review approved]→ preview ─[G4 preview tried]→ approval ─[G5 change approved]→ commit ─[G6 commit agreed]→ done
```

| Gate | Passes when | Manual: who answers | Auto: who answers |
|---|---|---|---|
| G1 spec approved | The spec's three files exist and the approver approves them | User: `approve`, `refine` or `review-doc` | PM agent: `approve` or `refine` |
| G2 QA passed | The latest QA run passed, within 3 runs | QA agent, through `qa_report` | QA agent started by the server |
| G3 review approved | The latest code review's verdict is `approve`, within 3 reviews, and QA passed after the last fix | Reviewer, through `review_report` | Reviewer agent started by the server |
| G4 preview tried | `preview_start` ran for this change, whatever its result | The server | Skipped and recorded |
| G5 change approved | The approver approves the finished change | User: `approve` or `request changes` | PM agent: `approve` or `changes` |
| G6 commit agreed | Permission to commit | User: `yes` or `no` | Automatic |

## Requirements

### Server and setup

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-001 | `luseen mcp` must start an MCP server over stdio for the project in the current folder, or the folder given with `-C, --dir <path>`. It must write only MCP protocol messages to stdout, and its logs to stderr. | confirmed | `src/cli/mcp-command.ts`, `src/cli/main.ts`, `test/e2e/mcp.test.ts`, `user request` |
| FR-MCP-002 | `luseen mcp` must accept `--approver <user\|pm-agent>` (default `user`). With `pm-agent`, it must also require `--run <run-id>` and `--task <id>`. It must have no dollar budget option: `--max-budget-usd` is an unknown option (automated-mode FR-AUTO-037). A missing, invalid or unknown value must exit 2 before serving anything. | docs-only | `user request`, `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-025, FR-AUTO-037 |
| FR-MCP-003 | When `.luseen/sdd` doesn't exist, `luseen mcp` must start and offer only `workflow_status`, which answers that the project isn't set up and that `/luseen:init` (or `luseen` in a terminal) sets it up, as claude-plugin FR-PLUG-007 describes. | confirmed | `src/cli/mcp-command.ts:136-144`, `src/application/workflow-tools.ts:524`, `test/e2e/plugin.test.ts` TC-PLUG-008 and TC-MCP-004, `.luseen/sdd/specs/claude-plugin/spec.md` FR-PLUG-007 |
| FR-MCP-004 | When luseen installs the skills and the `AGENTS.md` section, it must also write a `luseen` entry to `.mcp.json` at the project root that runs `npx luseen mcp`. It must keep every other server in an existing `.mcp.json`, and must leave a `luseen` entry that differs from its own unchanged, saying so. | confirmed | `src/core/mcp-config.ts`, `src/adapters/storage/skill-installer.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-044 | When luseen writes the `.mcp.json` entry (FR-MCP-004), it must also add to `.claude/settings.json` a Claude Code `PostToolUse` hook whose matcher is `mcp__luseen__.*` and whose command is `npx luseen session-link`. It must keep every other setting and hook. When a luseen hook that differs from its own is already there, it must leave it unchanged and say so. A `.claude/settings.json` whose only content is this hook must be left out of analysis, as FR-MCP-042 does for `.mcp.json`. | confirmed | `src/core/mcp-config.ts` `mergeClaudeSettings`, `src/adapters/storage/skill-installer.ts`, `src/core/constants/workflow.ts` `SESSION_LINK_HOOK`, `test/integration/session-link.test.ts` TC-MCP-069, TC-MCP-070, `user request` |
| FR-MCP-005 | luseen must print the `[mcp_servers.luseen]` block for Codex's `~/.codex/config.toml`, and must not write any file outside the project. | confirmed | `src/core/constants/workflow.ts`, `src/adapters/storage/skill-installer.ts`, `test/e2e/mcp.test.ts`, `user request` |
| FR-MCP-006 | The server must use `@modelcontextprotocol/sdk` (MIT license), added to the production dependency allow-list in `stack.md` with its reason. Imports of the SDK must be confined to `src/adapters/mcp/`, enforced by dependency-cruiser (FR-QUAL-021), as for `@anthropic-ai/sdk`. | confirmed | `package.json`, `.dependency-cruiser.cjs`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request`, `.luseen/sdd/developer-guidelines.md:145`, `.luseen/sdd/developer-guidelines.md:43` |

### Tools

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-007 | The server must offer exactly these tools: `workflow_status`, `workflow_begin`, `workflow_advance`, `workflow_skip`, `workflow_reset`, `workflow_resume`, `tasks_list`, `task_get`, `task_next`, `task_start`, `task_block`, `task_add`, `qa_handoff`, `qa_report`, `review_report`, `preview_start`, `auto_status`, and the planning tools `plan_begin`, `plan_resume`, `plan_status`, `plan_suggest` and `plan_propose`, which behave as roadmap-planning FR-PLAN-007, FR-PLAN-009, FR-PLAN-018, FR-PLAN-019 and FR-PLAN-044 to FR-PLAN-046 describe. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-008 | Each tool's input must be checked with a zod schema, reusing the task schemas the `luseen tasks` commands use. Invalid input must return a tool error that names the field, and change nothing. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `src/core/tasks.ts`, `user request` |
| FR-MCP-009 | `workflow_status` must return the current step, the task ID (or none), the spec name, the change type, the QA runs and code reviews used, the preview result, each gate's decision with its approver, the skipped steps, and the approver mode. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-010 | `workflow_begin` must take a change type (`feature`, `bug` or `no-behaviour`), a spec name, and an optional task ID, and start a new change at the `spec` step, or at `implement` for `no-behaviour`. It must refuse while another change is open, naming it. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request`, `AGENTS.md` |
| FR-MCP-011 | `tasks_list`, `task_get`, `task_start` and `task_add` must behave as `luseen tasks list`, `show`, `start` and `add` do, using the same task store. `task_block` must take a task ID and a reason, set the task to `blocked` in that store, and record the reason in the change's workflow state, since the task store has no reason field. `task_next` must return the first `open` or `blocked` task in roadmap order whose dependencies are all `done`, or none. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `src/adapters/storage/task-store.ts`, `.luseen/sdd/specs/task-tracking/spec.md`, `user request` |
| FR-MCP-012 | `task_start` must refuse a task that a running `luseen auto` run is working on, naming the run. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `src/adapters/storage/run-store.ts`, `user request` |
| FR-MCP-013 | No tool may mark a task `done` directly. A task linked to the change must become `done` only when G5 passes. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `AGENTS.md`, `user request` |
| FR-MCP-014 | `qa_handoff` must return what a separate QA agent needs: the spec's `spec.md`, `validation.md` and `verification.md`, and the list of files the change touched. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request`, `AGENTS.md` |
| FR-MCP-015 | `auto_status` must return a read-only summary of a `luseen auto` run (the latest when no run ID is given): its outcome so far, each task's status and rounds, and its cost, read from `.luseen/auto/<run-id>/run.json`. | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `src/adapters/storage/run-store.ts`, `user request` |
| FR-MCP-016 | The server must offer the resources `luseen://specs` (the spec list from the docs README) and `luseen://specs/{name}` (that spec's three files), and `luseen://roadmap` (roadmaps, milestones and tasks). | confirmed | `src/application/workflow-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `test/integration/mcp-server.test.ts`, `user request` |

### Steps and gates

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-017 | `workflow_advance` must move a change only to the next step in the order above. A call that skips a step, or whose gate hasn't passed, must be refused with the missing gate named, and leave the state unchanged. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-018 | G1 must refuse while the spec folder lacks `spec.md`, `validation.md` or `verification.md`. Otherwise the server must ask the approver. In manual mode, the answer `approve` must move to `implement`; `refine` must keep the change at `spec` and return the user's text; `review-doc` must keep it at `spec` and tell the agent to write the review doc with the `review-doc` skill, after which the next G1 question must offer only `approve` and `refine`. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `AGENTS.md`, `.luseen/sdd/specs/agent-instructions/spec.md`, `user request` |
| FR-MCP-019 | `qa_report` must take `passed` and a list of failures, and record one QA run for the change. G2 must pass only when the latest run passed. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `AGENTS.md`, `user request` |
| FR-MCP-020 | A change must have at most 3 QA runs, counting every run. After a 3rd run that fails, the change must stop: every `workflow_advance` must be refused with the reason, until the user answers `workflow_resume`, which must ask the user and, on yes, start the count again, or on no end the change (FR-MCP-043). | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/agent-instructions/spec.md` FR-INSTR-023, FR-INSTR-027, `user request` |
| FR-MCP-021 | `review_report` must take a verdict (`approve` or `changes`) and the findings by severity, and record one code review. G3 must pass only when the latest review is `approve` and a passing QA run was recorded after the last `changes` review. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/code-review/spec.md` FR-CREV-010, FR-CREV-014, `user request` |
| FR-MCP-022 | After a `changes` review, the change must go back to `implement`, and must pass G2 and G3 again. A change must have at most 3 code reviews, and after a 3rd review with `changes`, or when fixes need a QA run and 3 QA runs are used, it must stop as FR-MCP-020 describes. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/code-review/spec.md` FR-CREV-014, FR-CREV-015, `user request` |
| FR-MCP-047 | After a failed `qa_report` that isn't the change's last allowed run, the change must go back to `implement` with the preview cleared, and the reply must list the run's failures and tell the agent to hand them to the developer agent as bugs, decide whether the code, the test or the spec is wrong, fix wrong code or a wrong test with the `write-code` skill without asking the user anything, advance to `qa` and report the next run, or call `workflow_reset` if the spec is wrong. No approval question must be asked between QA runs, and `qa_report` must be refused until the change is at `qa` again. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-023 | `preview_start` must run each `start` command in `.luseen/environment/environment.json`, in a shell as the agent would, leave any that are still running after a short wait running, and return the link or command to try, or the error and the command's output when one fails. When the file doesn't exist, it must say to set it up with the `local-env` skill. G4 must pass once `preview_start` has run for the change, whatever its result, with the result recorded. On a change stopped at the QA or review limit, `preview_start` must also run, so the stop report can include a preview, but its result must not be recorded or count for G4. | confirmed | `src/adapters/preview/preview-runner.ts`, `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/local-environment/spec.md`, `AGENTS.md`, `user request` |
| FR-MCP-024 | At G5 in manual mode, `approve` must mark the linked task `done` and move to `commit`; `request changes` must return the user's text, move back to `implement`, and start the QA and review counts again. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `AGENTS.md`, `.luseen/sdd/specs/agent-instructions/spec.md` FR-INSTR-032, `user request` |
| FR-MCP-025 | At G6 in manual mode, `yes` must tell the agent to commit the spec, code and tests of this change only, with the requirement IDs, leaving out `.luseen/reviews/`; `no` must end the change with nothing committed. The server itself must never commit or push. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/agent-instructions/spec.md` FR-INSTR-019, FR-INSTR-020, FR-INSTR-035, `user request` |
| FR-MCP-026 | `workflow_skip` must take a step and a reason. In manual mode it must ask the user to confirm, and record the skip only on yes. In auto mode it must be refused. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/agent-instructions/spec.md` FR-INSTR-018, `user request` |
| FR-MCP-027 | `workflow_reset` must take a reason and move a change at `implement`, `qa`, `review`, `preview` or `approval` back to `spec`, clearing G1's approval and any waiting question, for when the spec turns out wrong. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `AGENTS.md`, `user request` |

### Approvals

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-028 | In manual mode, the server must ask each gate question through MCP elicitation, with the allowed answers as a fixed list. No tool input may count as an approval. A declined or cancelled question must leave the gate closed. | confirmed | `src/adapters/mcp/mcp-server.ts`, `src/cli/mcp-command.ts`, `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-029 | When the host doesn't declare elicitation support, a gate question must instead return `waiting-for-approval` with the question, the allowed answers, and the command `luseen approve`. `luseen approve` must show the waiting question and record the user's choice, and must refuse to run without a TTY, so an agent's shell can't answer it. | confirmed | `src/adapters/mcp/mcp-server.ts`, `src/cli/mcp-command.ts`, `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-030 | Every gate decision must be recorded with the gate, the answer, the approver (`user` or `pm-agent`), the time, and any notes or feedback. | confirmed | `src/adapters/mcp/mcp-server.ts`, `src/cli/mcp-command.ts`, `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |

### Auto mode

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-031 | With `--approver pm-agent`, G1 and G5 must be decided by a PM agent the server starts as a separate process, with the same restrictions, review prompts and JSON verdicts as automated mode's spec review and implementation review. A `refine` or `changes` verdict must refuse the step and return the PM agent's feedback. | docs-only | `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-016, FR-AUTO-017, FR-AUTO-019, FR-AUTO-022, `src/adapters/llm/agent-process.ts`, `user request` |
| FR-MCP-032 | With `--approver pm-agent`, moving to G2 must start a QA agent with the `test-spec` skill, as automated mode does, and record its result. `qa_report` from the developer agent must be refused. | docs-only | `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-021, `user request` |
| FR-MCP-033 | With `--approver pm-agent`, moving to G3 must start a reviewer agent that follows the `review-code` skill in the task's worktree, may run the project's checks but not change files, and returns a JSON verdict with its findings. `review_report` from the developer agent must be refused. | docs-only | `.luseen/sdd/specs/code-review/spec.md`, `user request` |
| FR-MCP-034 | With `--approver pm-agent`, G4 must be skipped and recorded, and G6 must pass without asking. | docs-only | `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-013, `user request` |
| FR-MCP-035 | With `--approver pm-agent`, a change must have at most 3 PM spec reviews, 3 QA runs, 3 code reviews and 3 PM implementation reviews. When one is used up without approval or a pass, the change must become `blocked` with the last feedback as the reason, and every further `workflow_advance` must be refused. | docs-only | `src/core/constants/agents.ts:32`, `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-024, `user request` |
| FR-MCP-036 | With `--approver pm-agent`, once Claude reports that a plan usage limit is reached (a `rate_limit_event` whose status isn't `allowed`, or an agent that ends with Claude Code's usage-limit message), the server must start no new agent, and must refuse the step with `limit-reached`, naming the reset time Claude reported. The agent call that hit the limit must not count as a rejected round. The server must record the cost of each agent it starts in the change's state, as Claude Code's estimate, and must set no dollar limit. | docs-only | `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-025, FR-AUTO-037, `user request` |
| FR-MCP-037 | With `--approver pm-agent`, a PM, QA or reviewer reply that isn't a valid verdict, or an agent that fails or times out, must count as a rejected round, with the reason recorded. | docs-only | `.luseen/sdd/specs/automated-mode/spec.md` FR-AUTO-023, `user request` |

### State and safety

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MCP-038 | The server must keep each change's state in `.luseen/workflow/`, one file per change, named by its task ID, or by the current Git branch when it has no task. Each write must be atomic. After a restart, `workflow_status` must return the same state. The folder must hold a `.gitignore` that ignores everything in it, so the state and preview logs stay on this machine and aren't listed as changed files. | confirmed | `src/adapters/storage/workflow-store.ts`, `test/integration/workflow-store.test.ts`, `test/integration/mcp-server.test.ts`, `user request` |
| FR-MCP-039 | Secrets must be redacted from the workflow state, the recorded feedback and the agent logs the server writes. | confirmed | `src/adapters/storage/workflow-store.ts`, `test/integration/workflow-store.test.ts`, `test/integration/mcp-server.test.ts`, `src/core/redaction.ts`, `user request` |
| FR-MCP-040 | The server must change no files other than `.luseen/workflow/`, `.luseen/tasks.db` (for an approved plan only after the user approves it), the planning session records under `.luseen/plans/`, and in auto mode its run's logs under `.luseen/auto/<run-id>/`. It must never run `git commit` or `git push`. | confirmed | `src/adapters/storage/workflow-store.ts`, `test/integration/workflow-store.test.ts`, `test/integration/mcp-server.test.ts`, `.luseen/sdd/specs/agent-instructions/spec.md` FR-INSTR-020, `user request`, `user request 2026-11-13` |
| FR-MCP-041 | `luseen clean` must not delete `.luseen/workflow/`, and its files must not affect analysis, the cache or generated documents. | confirmed | `src/adapters/storage/workflow-store.ts`, `test/integration/workflow-store.test.ts`, `test/integration/mcp-server.test.ts`, `src/core/constants/discovery.ts:85`, `user request` |
| FR-MCP-042 | A `.mcp.json` whose only server is luseen's entry must be left out of analysis, and out of the Git history used as context when a commit touches only it. When it has other servers too, luseen's entry must be removed from the content analysed. | confirmed | `src/core/mcp-config.ts`, `src/adapters/discovery/file-walker.ts`, `src/adapters/extraction/extract.ts`, `src/core/constants/git.ts`, `test/e2e/git.test.ts`, `src/adapters/discovery/file-walker.ts:199`, `src/core/constants/git.ts:20`, `user request` |
| FR-MCP-043 | When the user answers "no" to `workflow_resume`, the change must end: its status must become `done`, with nothing committed and the reason "The user chose not to continue" recorded, so `workflow_begin` can start a new change. A linked task's status must not change. | confirmed | `src/core/workflow.ts`, `src/application/workflow-tools.ts`, `src/core/workflow.test.ts`, `test/integration/mcp-server.test.ts`, Code review run 2, `user request` |
| FR-MCP-045 | `luseen session-link` must read the hook's JSON from stdin (`session_id`, `transcript_path`, `cwd`, `tool_name`). When the tool was a planning tool (`mcp__luseen__plan_*`), it must not link the session to a change; for `plan_begin` and `plan_resume`, the calls that take a planning session, it must record the session ID and transcript path in that planning session (roadmap-planning FR-PLAN-044), and any other planning tool must link nothing, so a call from another Claude session never moves the link. Otherwise it must find the change the same way `workflow_status` does from `cwd`, and add the session to that change's state as `sessions[]` (session ID, transcript path, first and last seen time), once per session ID, updating only last seen after that. When there's no change yet, when the input isn't valid, or when it fails in any way, it must change nothing. It must always exit 0, print nothing to stdout, and finish within the constant timeout, so it never disturbs the user's session. | confirmed | `src/cli/mcp-command.ts` `runSessionLink`, `src/core/workflow.ts` `linkSession`, `src/adapters/storage/workflow-store.ts` `updateOpen`, `test/integration/session-link.test.ts` TC-MCP-071, TC-MCP-072, `test/integration/workflow-lock-no-links.test.ts`, `user request`, `user request 2026-11-13` |
| FR-MCP-046 | `luseen mcp --plan <id>` must start the server for one planning session that the calling luseen process holds, as used by luseen-driven PM turns (roadmap-planning FR-PLAN-005). It must offer only `plan_status`, `plan_suggest` and `plan_propose` for that session, refuse any other session ID, and never ask elicitation questions: an accepted `plan_propose` must return that the proposal is shown to the user, who answers in `luseen plan` or the GUI. An unknown or closed session ID must exit 2. | confirmed | `.luseen/sdd/specs/roadmap-planning/spec.md` FR-PLAN-005, FR-PLAN-045, `user request 2026-11-13` |

## Changes to other specs

These specs were refined with this one:

- [automated-mode](../automated-mode/spec.md): each task's developer agent gets its own task server (FR-AUTO-035), the orchestrator commits or blocks from the workflow state (FR-AUTO-036), adds the server's cost (FR-AUTO-037), and auto mode gains a code review (FR-AUTO-038). FR-AUTO-018, 019, 021, 022 and 024 now say the task server runs those stages.
- [agent-instructions](../agent-instructions/spec.md): `AGENTS.md` tells agents to use the tools when they're available (FR-INSTR-036) and never to approve for the user (FR-INSTR-037).
- [code-review](../code-review/spec.md): reviews are reported with `review_report` (FR-CREV-022), and in auto mode the task server starts the reviewer (FR-CREV-023).
- [cli-commands](../cli-commands/spec.md): the `mcp` (FR-CLI-028) and `approve` (FR-CLI-029) commands.
- [quality-tooling](../quality-tooling/spec.md): the SDK stays in `src/adapters/mcp/` (FR-QUAL-021).

## Edge cases

- The host can't start the server (luseen not installed): the agent sees no luseen tools and follows the written steps in `AGENTS.md`.
- The agent calls `workflow_advance` before `workflow_begin`: refused, saying no change is open.
- A change with no task, such as a quick fix: the state file is named by the Git branch, and no task is marked done.
- Two sessions on the same branch with no task: the second `workflow_begin` is refused, naming the open change.
- The user cancels an approval question: the gate stays closed, and the agent can ask again with `workflow_advance`.
- The host has no elicitation, and the agent runs `luseen approve` itself in a non-TTY shell: refused.
- QA passes on its 3rd run, then the review finds a `should-fix`: the fix needs a 4th QA run, so the change stops until the user agrees through `workflow_resume`.
- `preview_start` fails because a port is in use: the error is returned and recorded, and G4 passes, so the user can still approve, knowing there's no preview.
- A `no-behaviour` change: G1 is skipped and recorded, and QA runs the project's full checks.
- In auto mode, the PM agent returns invalid JSON 3 times at G1: 3 rejected rounds, and the change is blocked.
- In auto mode, Claude's usage limit is reached while QA is due: the step is refused with `limit-reached` and the reset time, and `luseen auto` ends the run as `limit-reached`.
- The workflow state file is deleted mid-change: `workflow_status` reports no open change, and the agent starts again with `workflow_begin`.
- The user starts a task by hand that an auto run is working on: `task_start` refuses it and names the run.

## Non-goals

- Team setup: GitHub or Linear as a shared task hub, task claiming across machines, a team board.
- A hosted or remote server. The server runs only over stdio, on the machine where the agent runs.
- Starting a `luseen auto` run from an MCP tool. `auto_status` only reads a run.
- MCP prompts (slash commands). Agents use the tools.
- Creating Git branches in manual mode. Manual mode works on whatever branch the user is on, as today.
- Replacing `AGENTS.md`. It stays as the fallback for agents without MCP.
