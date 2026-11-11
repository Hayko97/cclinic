# gui

## Goal

Give each project a local web GUI, started with `cclinic gui` inside the project. It lets the user do everything the command line does without typing commands:
- set up cclinic for the project
- plan roadmaps and tasks with the PM agent, and view them
- run and watch automated mode on a roadmap
- answer the workflow gates that are waiting
- read, live and read-only, the Claude Code sessions attached to a task or spec

The GUI isn't an AI client. It never chats with Claude itself. It only starts cclinic's own commands and agent workflows, and shows their output.

The GUI builds on these specs:
- [cli-commands](../cli-commands/spec.md): the commands it runs
- [task-tracking](../task-tracking/spec.md): roadmaps and tasks
- [roadmap-planning](../roadmap-planning/spec.md): the PM agent
- [automated-mode](../automated-mode/spec.md): runs
- [mcp-server](../mcp-server/spec.md): the workflow state and gates

It adds no rules of its own to any of those. The same command run from the GUI and from the terminal must have the same effect.

## Screens

The GUI has one main place, the **Canvas**, and two supporting screens. Everything else opens as a side panel over the canvas, so you never lose the overall picture.

| Where | Shows | Does |
|---|---|---|
| **Canvas** (default) | Every roadmap as a frame, its tasks as cards connected by dependency arrows, the agents working on each task and its Claude Code sessions, auto runs and manual work side by side. A List view shows the same data as text | Pan, zoom, drag cards and frames (positions are saved), open a task or roadmap, start an AI run on a roadmap, plan a new roadmap or task |
| Task panel | A task's details, workflow steps, the agents working on it, its sessions, and the open session's live transcript | Every `cclinic tasks` change for that task, answering its waiting gate |
| Roadmap panel | A roadmap's goal, milestones, its running AI run (steps, cost against budget) and its past runs with reports and logs | Run with AI, stop the run, plan a task into it, remove it |
| Plan panel | The PM agent's questions and proposal | Answer, approve, refine or cancel |
| Needs you (top bar) | Every question, gate and confirmation waiting for you | Open the item |
| Setup | Whether `.cclinic/sdd` exists, the `doctor` result, the saved model and effort | Generate docs, install skills, set up the environment, choose or reset the model, clean the cache |
| Jobs | Every command the GUI started, with its live output and exit status | Cancel a running job |

## UX principles

These come from current practice in developer tools and agent monitoring (sources at the end). Each is made testable in [UI and UX](#ui-and-ux).

1. **One picture of the work:** a canvas like a whiteboard (Miro, FigJam) is the main view. Roadmaps are frames, tasks are cards, dependencies are arrows, and agents and sessions are attached to the cards they work on. Details open beside the canvas, never instead of it.
2. **Calm and keyboard-friendly:** one neutral visual style, few places to go, and a command palette (Ctrl/⌘+K) that reaches every action.
3. **What needs me comes first:** questions, gates and confirmations waiting for the user are gathered in one Needs you list, with a count that's always visible.
4. **Same data, two views:** the canvas for seeing how work connects, and a plain list grouped by roadmap and milestone for reading and for screen readers, always in sync.
5. **Watching agents like a trace:** each task shows its steps in order, each with status, time and cost. The step that's running shows a live timer and its current tool call, and a quiet agent is flagged as possibly stalled.
6. **Logs that don't fight you:** output follows new lines only while you're at the bottom. Scrolling up or selecting text pauses it, new lines are buffered, and a button jumps back to the latest.
7. **The CLI stays one step away:** every action shows the equivalent `cclinic` command, so the GUI also teaches the CLI.
8. **Safe by default:** progressive disclosure (advanced options folded away), destructive actions named and confirmed with Cancel focused, and errors shown next to their field in the CLI's words.

## Requirements

### Starting the GUI

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-001 | `cclinic gui [path]` must start an HTTP server for the project at `path`, or the current folder when no path is given. It must accept `-C, --dir`, `--port <n>` (0 to 65535, where 0 picks a free port), `--no-open` and `--json`. With no `--port`, it must use the default port constant, or a free port when that port is in use. | docs-only | `user request`, `src/cli/main.ts`, `src/core/constants/` |
| FR-GUI-002 | The server must listen only on `127.0.0.1`. | docs-only | `user request`, `.cclinic/sdd/specs/local-environment/spec.md` FR-ENV-019 |
| FR-GUI-003 | At each start, the GUI must create a new random access token of at least 128 bits, and print one URL to stdout that holds it, `http://127.0.0.1:<port>/?token=<token>`. With `--json`, stdout must be exactly one JSON document, `{"url", "port"}`. The token must never be written to disk or to a log. | docs-only | `user request` |
| FR-GUI-004 | Unless `--no-open` is given or stdout isn't a TTY, the GUI must open the URL in the default browser, with `open` on macOS, `xdg-open` on Linux and `start` on Windows, using an argument array. A browser that fails to open must only print a warning. | docs-only | `user request` |
| FR-GUI-005 | The GUI must keep running until Ctrl+C or SIGTERM. Then it must cancel every job it started, as FR-GUI-033 describes, close the server, and exit 130 or 143. | docs-only | `user request`, `src/core/errors.ts`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-031 |
| FR-GUI-006 | A port that's in use or not allowed when `--port` was given, or a `path` that isn't a folder, must exit 2 with the reason. | docs-only | `user request`, `src/core/errors.ts` |
| FR-GUI-007 | Only one GUI may run for a project at a time. A second `cclinic gui` must print the first one's port and exit 2. A lock left by a process that isn't running anymore must be replaced. | docs-only | `user request`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-032 |

### Security

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-008 | Every request except the first page load must carry the token in a header. That first page load must have the token in its query, which then sets a `SameSite=Strict`, `HttpOnly` cookie. A missing or wrong token must get 401, with no project data in the response. | docs-only | `user request` |
| FR-GUI-009 | Requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` must get 403. So must requests that change something when their `Origin` header is present and isn't the GUI's own origin. | docs-only | `user request` |
| FR-GUI-010 | The GUI must serve only its own bundled static files and its API. Every path, task ID, run ID, roadmap ID, spec name, workflow key and session ID in a request must match an allow-listed pattern or a record that exists. Anything else must get 404, and no file outside the allowed places may be read. | docs-only | `user request`, `.cclinic/sdd/developer-guidelines.md` |
| FR-GUI-011 | The GUI must not read `.env` files or other secret files. Every text it sends to the browser must have secrets redacted, as `src/core/redaction.ts` does. That covers command output, logs, reports, workflow state and transcripts. | docs-only | `user request`, `src/core/redaction.ts` |
| FR-GUI-012 | The GUI's pages must load no script, style, font or image from outside the GUI, and must send a `Content-Security-Policy` that allows only `'self'`. The GUI process itself must make no network request, other than what the commands it runs already do. | docs-only | `user request` |
| FR-GUI-013 | Every command the GUI runs must be started with an argument array, never through a shell. No text from the browser may become a command name or an option name, only an option's value. | docs-only | `user request`, `.cclinic/sdd/developer-guidelines.md` |

### Setup

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-014 | When the project has no `.cclinic/sdd`, the GUI must open on Setup, and must say that generating is the first step. The canvas and the panels must say what's missing instead of failing. | docs-only | `user request` |
| FR-GUI-015 | Setup must show the result of `cclinic doctor`, and must offer a generate form with every generate option: provider, model, effort, include and exclude patterns, the limits, `--no-skills`, `--no-cache`, `--no-git`, `--environment`, `--allow-broad-target`, `--force` and `--dry-run`. Each value must be checked with the same rules as the CLI before the job starts. | docs-only | `user request`, `src/cli/main.ts`, `src/cli/options.ts` |
| FR-GUI-016 | The GUI must show, as a dialog, each question the CLI would ask in the terminal, and must start the job only after the user answers. This covers the cost confirmation, the `git init` consent, the environment consent and the overwrite warning. It must then run the command with the answer passed as an option, such as `--yes`, `--environment` or `--force`. | docs-only | `user request`, `src/cli/menus.ts`, `src/cli/generate-command.ts` |
| FR-GUI-017 | Setup must also run `skills`, `environment`, `model --list`, choosing and saving a model, `model --reset` and `clean`, each with the same options and confirmations as the CLI. | docs-only | `user request`, `src/cli/other-commands.ts`, `src/cli/environment-command.ts` |
| FR-GUI-018 | The GUI must show how to connect a host agent to `cclinic mcp`, such as the `.mcp.json` entry and whether it's installed. It must not start the MCP server itself. | docs-only | `user request`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-004 |

### Roadmaps and tasks

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-019 | The canvas and the List view must show every roadmap with its status and task counts, and the tasks with no milestone. The roadmap panel must show its milestones in order, and each task's ID, title, status, dependencies, spec, and the run that holds it, if any. The data must be the same as `cclinic tasks roadmap show <id> --json` and `cclinic tasks list --all --json`. | docs-only | `user request`, `src/core/tasks.ts` `buildOverview`, `buildRoadmap`, `src/cli/tasks-command.ts` |
| FR-GUI-020 | The GUI must offer every `cclinic tasks` change, with the same checks and messages: add a task, depend, undepend, start, done, remove a task, remove a milestone and remove a roadmap. Removing anything must ask for confirmation first. | docs-only | `user request`, `src/cli/tasks-command.ts` |
| FR-GUI-021 | The GUI must offer no way to create a roadmap or milestone other than Plan, just as `tasks roadmap add` and `tasks milestone add` refuse in the CLI. | docs-only | `.cclinic/sdd/specs/roadmap-planning/spec.md`, `src/cli/tasks-command.ts` `addPlanOnlyCommand` |
| FR-GUI-022 | When `.cclinic/tasks.db` changes, for example from the CLI, an agent or a run, open GUI pages must show the change within 2 seconds, without a page reload. | docs-only | `user request` |

### Plan

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-023 | Plan must start the same planning session as `cclinic plan`. That means a new roadmap, `--task`, or `--roadmap <id>`, with the same model, effort, budget and timeout options and defaults. It must run through the GUI's own `PlanningPorts`, so the session logic doesn't change. | docs-only | `user request`, `src/application/planning-session.ts`, `src/cli/plan-command.ts` |
| FR-GUI-024 | Each PM question must be shown as a form for the user to answer. Each proposal must be shown in full, with `approve`, `refine` (with feedback) and `cancel`. | docs-only | `user request`, `src/application/planning-session.ts` `PlanningPorts` |
| FR-GUI-025 | A plan must be saved only after the user approves it, in the same single transaction as the CLI uses (`savePlan`, or `addTask` for one task). Cancelling, closing the GUI or a failed PM call must save nothing. | docs-only | `.cclinic/sdd/specs/roadmap-planning/spec.md`, `src/cli/plan-command.ts` |
| FR-GUI-026 | Only one planning session may run in a GUI at a time. If the browser is closed and opened again, the session that's running must be shown at its current question. | docs-only | `user request` |

### Automated mode

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-027 | Run with AI on a roadmap's frame or panel must start a run like `cclinic auto`, with that roadmap chosen. The user sets a budget (required), developers (1 to 8), model, effort and timeout. Then the GUI shows the same plan the CLI prints, with the tasks in order and the ones already blocked, and starts the run only after the user confirms it. | docs-only | `user request`, `src/cli/auto-command.ts`, `src/core/automation.ts` `renderPlan` |
| FR-GUI-028 | The GUI must refuse to start a run when the CLI would, with the CLI's reason. Examples: a run is already going (and which), there are tracked changes, there's no commit, or the Claude CLI or skills are missing. | docs-only | `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-032, `src/cli/auto-command.ts` `checkProject` |
| FR-GUI-029 | While a run is going, the roadmap panel must show from `run.json`, refreshed within 2 seconds, the outcome so far, each task's status, branch, rounds and cost, and the total spent against the budget. This must include runs started from the terminal. | docs-only | `user request`, `src/core/automation.ts` `RunState`, `src/adapters/storage/run-store.ts` |
| FR-GUI-030 | The task panel must show what each agent working on the task is doing, for runs started from the GUI and from the terminal: its role, then its messages and tool calls as they happen, read from the session transcripts the run records (automated-mode FR-AUTO-039) as FR-GUI-040 to FR-GUI-043 describe. | docs-only | `user request`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-039 |
| FR-GUI-031 | The roadmap frame and panel must offer a stop button for a run the GUI started. Stopping must have the same effect as Ctrl+C on `cclinic auto`, as automated-mode FR-AUTO-031 describes, with outcome `interrupted`. For a run started elsewhere, the GUI must say which process to stop. | docs-only | `user request`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-031 |
| FR-GUI-032 | The roadmap panel must list the roadmap's past runs from `.cclinic/auto/`, and show each run's `report.md` and agent logs. | docs-only | `user request`, `src/adapters/storage/run-store.ts` |

### Jobs and output

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-033 | Every command the GUI runs must be a job. The GUI runs it as a child process, `cclinic <command> … --json`, with the project as its folder. A job must have an ID, the command and options, its start and end times, its live stdout and stderr, and its exit code with the CLI's meaning. Cancelling a job must send SIGINT, then SIGTERM after the constant grace period. | docs-only | `user request`, `src/core/errors.ts` |
| FR-GUI-034 | Job output must reach the browser as it's written, through Server-Sent Events. A page opened after the job started must first get the output so far, up to the constant limit, and then the new output. | docs-only | `user request` |
| FR-GUI-035 | The GUI must not start two jobs that would conflict. Only one of each may run: generate or clean, environment, or an auto run. One of these may not start while another is running: generate, clean, skills, environment. The refused job must name the job that blocks it. | docs-only | `user request` |
| FR-GUI-036 | Jobs must last only as long as the GUI process, and their output must not be written to disk, except the files the commands write themselves. | docs-only | `user request` |

### Workflows and gates

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-037 | Each change in `.cclinic/workflow/` must be shown: on its task's card and task panel when it has a task, and as a card in a "Changes without a task" frame on the canvas when it's keyed by branch. Its panel must show the spec, step, status, QA runs, reviews, decisions, skips and reason. | docs-only | `user request`, `src/core/workflow.ts` `workflowStateSchema`, `src/adapters/storage/workflow-store.ts` |
| FR-GUI-038 | When a change has a gate waiting for an answer, the GUI must show the question and the allowed answers, and record the user's choice the same way `cclinic approve` does (`answerPending`). The GUI must offer no way for an agent to answer. Only a request that carries the token can answer, and the token is shown only to the user who started the GUI. | docs-only | `user request`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-029, `src/cli/mcp-command.ts` `runApproveCommand` |

### Session mirror

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-039 | The task panel must list the Claude Code sessions attached to the task, newest first, with role or source, start time, last activity and whether the session is live. Agent sessions come from runs (automated-mode FR-AUTO-039). Interactive sessions come from the workflow state (mcp-server FR-MCP-045). Filtering the canvas by a spec must show the sessions of that spec's tasks. | docs-only | `user request`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-039, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-045 |
| FR-GUI-040 | Opening a session must show its transcript, read from the recorded transcript path, as user messages, assistant messages, tool calls with their input, and tool results, in order. | docs-only | `user request` |
| FR-GUI-041 | The GUI must read only transcript files that a run or workflow state records. They must sit under `~/.claude/projects/` and end in `.jsonl`, and the GUI must refuse any other path. | docs-only | `user request` |
| FR-GUI-042 | While a transcript file grows, the open page must show the new entries within 2 seconds, without a reload. | docs-only | `user request` |
| FR-GUI-043 | The transcript must be parsed leniently. A line that isn't valid JSON, or has an unknown shape, must be skipped, and the page must show how many were skipped. A missing file must say "transcript not found" and keep the rest of the page working. | docs-only | `user request` |
| FR-GUI-044 | The session mirror must be read-only. The GUI must offer no way to send input to, resume, or stop a Claude Code session from it. | docs-only | `user request` |

### Canvas

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-067 | The canvas must be the screen the GUI opens on once the project is set up. It must show each roadmap as a frame with its title, goal, status, mode (FR-GUI-076) and done tasks against total. Inside a frame, each milestone must be a labelled column, in milestone order, holding its tasks as cards. Tasks with no milestone must be in an "Unassigned tasks" frame, and branch-keyed changes in a "Changes without a task" frame (FR-GUI-037). | docs-only | `user request`, `src/core/tasks.ts` `buildOverview` |
| FR-GUI-068 | Each task card must show the task's ID, title, the first 2 lines of its description, status, spec, current workflow step, mode, the agents working on it now (FR-GUI-077), its session count with a live marker when one is live, and its cost so far. | docs-only | `user request` |
| FR-GUI-069 | Each dependency must be drawn as an arrow from the task depended on to the task that depends on it, also between roadmaps. The arrow must be solid when the dependency is `done`, and dashed when it isn't. Selecting a card must highlight its arrows and the cards they connect, and dim the rest. | docs-only | `user request`, `src/core/tasks.ts` |
| FR-GUI-070 | A Show sessions toggle must draw each task's Claude Code sessions as small nodes linked to the card by a line, labelled with the role or "You" and live or ended. With the toggle off, only the session count on the card must be shown. The toggle must be remembered in the browser. | docs-only | `user request` |
| FR-GUI-071 | Clicking a card must select it and open its task panel, which shows the task's details, workflow steps (FR-GUI-056), agents (FR-GUI-077), sessions (FR-GUI-039) and the transcript of its live session, or its newest session when none is live (FR-GUI-040). Clicking a session node must open the task panel on that session. A task with no session must say so. | docs-only | `user request` |
| FR-GUI-072 | The canvas must pan by dragging empty space or with the scroll wheel, and zoom with Ctrl/⌘+wheel, a pinch, or `+` and `-`, from 25 % to 200 %, around the pointer. A Fit button and `0` must fit every frame in view, and the zoom level must be shown. | docs-only | `user request` |
| FR-GUI-073 | Cards and frames must be movable by drag and drop. A card must stay inside its own roadmap frame, and a frame must move with its cards. Moving must never change `tasks.db`. When a drag ends, the new positions must be saved to `.cclinic/gui/layout.json` within 1 second, atomically, and restored on reload, in other browsers and after the GUI restarts. Nothing may be written while dragging. | docs-only | `user request` |
| FR-GUI-074 | Cards and frames with no saved position must be placed automatically: frames side by side without overlap, cards in their milestone column, ordered so a task comes after the ones it depends on. A Tidy up action on a frame must ask for confirmation, then clear that frame's saved positions and place it automatically again. | docs-only | `user request` |
| FR-GUI-075 | The canvas must show changes within 2 seconds, without a reload: task status, step, agents, sessions, new tasks (placed automatically), and removed tasks, whose saved positions are then dropped from the layout. | docs-only | `user request` |
| FR-GUI-076 | Each roadmap frame and task card must show its mode. **AI run** applies while a running auto run holds the roadmap or task, with the run's ID and progress. **Manual** applies while a task has an open workflow state started from a user's Claude Code session, with its step. Otherwise there's no mode. Several roadmaps may be in different modes at once, such as one in an AI run while the user works manually on a task in another, and each must show its own mode. | docs-only | `user request`, `src/adapters/storage/run-store.ts` `findRunHoldingTask`, `src/core/workflow.ts` |
| FR-GUI-077 | Each task card and task panel must show which agents are working on the task now: for an AI run, each agent whose recorded session has no end time, shown as its role (Developer, PM, QA, Reviewer) with an icon and label; for manual work, each interactive session seen in the last 5 minutes (the activity constant), shown as "You · Claude Code". The task panel must also list the agents that worked on it before, with their step and when. | docs-only | `user request`, `.cclinic/sdd/specs/automated-mode/spec.md` FR-AUTO-039, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-045 |
| FR-GUI-078 | Each roadmap frame must offer Run with AI (FR-GUI-027), Stop (FR-GUI-031) while a run it started is going, Plan a task into this roadmap (`cclinic plan --task --roadmap <id>`), and Open, which opens the roadmap panel. A canvas button, New roadmap, must start Plan (FR-GUI-023). | docs-only | `user request`, `src/cli/plan-command.ts` |
| FR-GUI-079 | The canvas must offer a search box that highlights matching cards by ID, title or spec, filters by status, mode and spec, a Hide done switch, and a roadmap picker that zooms to that frame. Filtered-out cards must be dimmed, not moved. | docs-only | `user request` |
| FR-GUI-080 | The canvas must be usable by keyboard. Tab and Shift+Tab move between cards in roadmap and dependency order, Enter opens the selected card, and arrow keys move the selected card by one grid step, saved like a drag (FR-GUI-073). Every card must have an accessible name with its ID, title, status and mode. | docs-only | `user request`, WCAG 2.2 |
| FR-GUI-081 | With 300 tasks, 400 dependencies and 600 sessions, the canvas must draw within 1.5 seconds of the data arriving in the test browser, and must keep dragging, panning and zooming at 30 frames per second or more there. | docs-only | `user request` |
| FR-GUI-082 | The canvas must be drawn with the browser's own SVG and HTML, with no diagram or canvas library, as FR-GUI-045 requires. | docs-only | `user request`, `.cclinic/sdd/stack.md` |

### UI and UX

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-048 | Every page must use one shared set of design tokens (colours, spacing, radius, type scale), defined as CSS custom properties in one stylesheet, with the system font stack and no web fonts. There must be a light and a dark theme. The default follows the system setting (`prefers-color-scheme`), and a toggle overrides it and is remembered in the browser. | docs-only | `user request`, UX principle 2 |
| FR-GUI-049 | The layout must be a top bar and a narrow left rail with three places: Canvas, Setup and Jobs. The top bar must show the project's name and folder, the Needs you count, the running job count, the running AI runs' budget used, the ⌘K button and the theme toggle. Task, roadmap, plan, workflow and session details must open in a side panel over the canvas, which closes with Escape. No screen may scroll sideways at 768 px wide, where the side panel takes the full width. | docs-only | `user request`, UX principle 1, 2 |
| FR-GUI-050 | Ctrl+K (⌘+K on macOS) must open a command palette that lists every action the GUI offers (one per CLI command and `tasks` subcommand) and every screen, filtered as the user types. Each entry must show its equivalent `cclinic` command. `?` must open a list of the keyboard shortcuts. Shortcuts must not take over the browser's own (such as ⌘+N, ⌘+W, ⌘+L), and must not fire while typing in a field. | docs-only | `user request`, UX principle 2, 7 |
| FR-GUI-051 | Every form that starts a command must show the exact `cclinic` command it will run, updated as the user changes the form, with a copy button. | docs-only | `user request`, UX principle 7 |
| FR-GUI-052 | The top bar must show a Needs you button with the count of every PM question or proposal waiting, every waiting workflow gate, and every confirmation a job is waiting on. It must be on every screen and open a list with one button per item that opens it. The browser tab title must start with `(<count>)` when it isn't 0, and the cards those items belong to must carry a "Needs you" marker on the canvas. | docs-only | `user request`, UX principle 3 |
| FR-GUI-053 | The canvas must show one suggested next step as a banner, from the project's state, in this order of checks: not generated → Generate; no roadmap → Plan a roadmap; a roadmap with open tasks and no run → Run with AI; a run going → Open its roadmap. Each empty list in the GUI must say why it's empty and offer the one action that fills it. | docs-only | `user request`, UX principle 3 |
| FR-GUI-054 | Besides the canvas, the same tasks must be viewable as a List: roadmaps, then milestones in order, then tasks with their status, mode, agents, dependencies (as links) and session count. The two views must show the same data, and the choice must be remembered in the browser. A task whose dependencies aren't all `done` must be marked as waiting on them in both views. | docs-only | `user request`, UX principle 4, `src/core/tasks.ts` |
| FR-GUI-055 | Status must never be shown by colour alone. Each task, run, job, step and session status must have a text label and an icon as well as a colour. | docs-only | `user request`, UX principle 8 |
| FR-GUI-056 | The task panel must show the task's workflow steps in order (spec, spec review, implement, QA, code review, implementation review, merge or commit), each as not started, running, passed, sent back or failed, with its round, time taken and cost, from its run or its workflow state. The roadmap frame and panel must show done tasks against total, the time since the run started, and the budget used as a bar with the amount. | docs-only | `user request`, UX principle 5, `.cclinic/sdd/specs/automated-mode/spec.md` Per-task flow, `src/core/automation.ts` `TaskRun`, `src/core/workflow.ts` |
| FR-GUI-057 | A running agent step must show a live elapsed timer and the name and short input of the tool call it is in, from its transcript. When its transcript hasn't grown for the stall constant (default 5 minutes), the step must be marked "No activity for <n> min" without stopping it. | docs-only | `user request`, UX principle 5 |
| FR-GUI-058 | Every output and transcript view must follow new lines while it is scrolled to the bottom. Scrolling up, selecting text or jumping to a search match must pause following, keep the new lines buffered, and show a "Jump to latest (<n> new)" button. Scrolling back to the bottom or pressing the button must resume following. | docs-only | `user request`, UX principle 6 |
| FR-GUI-059 | Output and transcript views must offer text search and, for transcripts, a filter by entry kind (user, assistant, tool call, tool result). Tool results longer than the fold constant (default 20 lines) must be folded, with a button to unfold. | docs-only | `user request`, UX principle 6 |
| FR-GUI-060 | The generate, environment, plan and auto forms must show the common options first (model, effort, budget, and for auto the roadmap and developers), and fold the rest under "Advanced options". A value the CLI would reject must be shown next to its field, in the CLI's words, before the form can be submitted. | docs-only | `user request`, UX principle 8, `src/cli/options.ts` |
| FR-GUI-061 | Every confirmation for a destructive or costly action (remove, clean, force overwrite, generate, start or stop an auto run) must name the item and its effect, such as the task's title or the estimated cost, must have the action button in a danger style when it deletes or stops, and must open with Cancel focused. Escape must cancel. | docs-only | `user request`, UX principle 8 |
| FR-GUI-062 | When a job ends, a notice must appear with its result and a link to its output. A notice for success must close by itself after the notice constant (default 6 seconds). A notice for failure must stay until it's closed. Status changes must also be announced to screen readers through a polite live region. | docs-only | `user request` |
| FR-GUI-063 | Every screen, roadmap, task, run, workflow, session and job must have its own URL in the address bar, so reload, back, forward and sharing a link in the same browser return to the same view. | docs-only | `user request` |
| FR-GUI-064 | Every control must be usable by keyboard alone, with a visible focus outline. Text and controls must meet WCAG 2.2 AA contrast in both themes. When the system asks for reduced motion, the GUI must not animate. | docs-only | `user request`, WCAG 2.2 |
| FR-GUI-065 | Times must show as relative ("3 min ago") with the exact local time on hover, and costs must show as US dollars with 2 decimals. Running durations must update every second. | docs-only | `user request` |
| FR-GUI-066 | Data that takes longer than 300 ms to arrive must show a placeholder of the same shape (a skeleton) instead of a blank area. A failed request must show its reason in place, with a Retry button. | docs-only | `user request` |

### Packaging and layers

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GUI-045 | The GUI must add no production dependency. It must use `node:http` for the server, plain HTML, CSS and JavaScript for the pages, and ship the pages in the published package. | docs-only | `user request`, `.cclinic/sdd/stack.md`, `package.json` `files` |
| FR-GUI-046 | The HTTP server and the transcript reader must be adapters, in `src/adapters/http/` and `src/adapters/transcripts/`. Routing checks, view models and the transcript parser must be pure functions in core. The command must be wired in `src/cli/gui-command.ts`. All of this must pass `npm run check:arch`. | docs-only | `.dependency-cruiser.cjs`, `.cclinic/sdd/architecture.md` |
| FR-GUI-047 | The GUI must write no files except its lock and the canvas layout (FR-GUI-073) in `.cclinic/gui/`. That folder must hold a `.gitignore` that ignores everything in it, must not be deleted by `cclinic clean`, and must not affect analysis, the cache or generated documents. | docs-only | `user request`, `src/core/constants/discovery.ts:85` |

## Changes to other specs

These specs are refined with this one:

- [automated-mode](../automated-mode/spec.md):
  - Agents now run with `--session-id` instead of `--no-session-persistence` (FR-AUTO-016).
  - Each agent's session is recorded per task (FR-AUTO-039).
- [mcp-server](../mcp-server/spec.md):
  - cclinic installs a Claude Code hook (FR-MCP-044).
  - The hook links each interactive session that uses the workflow tools to that change (FR-MCP-045).
- [cli-commands](../cli-commands/spec.md): the `gui` (FR-CLI-030) and `session-link` (FR-CLI-031) commands.

## Edge cases

- The GUI starts in a folder that isn't a Git repository: Setup works, and Auto shows the CLI's reason it can't run.
- `.cclinic/tasks.db` doesn't exist: Roadmaps says there are no roadmaps yet and offers Plan.
- A run started in the terminal is going when the GUI opens: Auto shows it live (FR-GUI-029, FR-GUI-030), and refuses to start another.
- The browser is closed during a job, a plan or a run: the job keeps running, and opening the GUI again shows it.
- The GUI is stopped during an auto run it started: the run is interrupted as FR-AUTO-031 says, so work stays on its branches.
- A transcript was deleted, or Claude Code's transcript format changes: the page says what it couldn't read (FR-GUI-043), and nothing else breaks.
- A run's worktree was removed after merging: its sessions still show, because their transcripts are kept in `~/.claude/projects/`.
- Two sessions worked on the same task, such as before and after `/clear`: both are listed, newest first.
- The URL with the token is opened in another browser on the same machine: it works, because the token is checked, not the browser.
- A long output: the browser keeps only the newest lines, up to the constant limit, and says that older lines were dropped.

- A task depends on a task in another roadmap: the arrow crosses between the two frames.
- A task is in an AI run and the user also opens a manual change for it: the card shows AI run, and the task panel lists both the run's agents and the user's session.
- `.cclinic/gui/layout.json` is missing, unreadable or from an older layout: the canvas places everything automatically, says so once, and writes a new file on the next drag.
- Two browsers drag at once: the last drop wins, and the other browser shows the new positions within 2 seconds.

## Non-goals

- Chatting with Claude, or sending prompts to a session, from the GUI.
- Accounts, remote access, HTTPS, or serving to other machines.
- Running `cclinic mcp` from the GUI. It stays stdio for host agents.
- Editing spec files or code in the GUI.
- Keeping job output after the GUI stops.
- Showing the sessions of planning (`cclinic plan`) or environment agents. They keep `--no-session-persistence`.
- A desktop app or a terminal UI.
- A UI framework or component library. The modern look comes from the shared design tokens (FR-GUI-048).
- Gantt charts. Changing status, dependencies or milestones by dragging on the canvas. Dragging only moves cards (FR-GUI-073), and changes use the same actions as `cclinic tasks` (FR-GUI-020).
- Free drawing, sticky notes or comments on the canvas.
- Browser desktop notifications. Desktop notifications for runs stay with automated mode (FR-AUTO-029).

## UX sources

- Agent run monitoring: [MindStudio, monitoring long-running agents](https://www.mindstudio.ai/blog/ai-agent-observability-monitor-long-running-agents-3), [Retool Agents monitoring](https://docs.retool.com/agents/guides/monitor), [MLflow, LLM observability UI guide](https://mlflow.org/articles/llm-observability-with-the-best-ui-a-2026-engineers-guide/), [What an AI coding agent dashboard should do](https://junctionpanel.dev/blog/what-an-ai-coding-agent-dashboard-should-actually-do/)
- Task views and dependencies: [GitHub Projects layouts](https://notes.kodekloud.com/docs/GitHub-Foundations-Certification/Manage-Your-Work-with-GitHub-Projects/Layout-Options-For-Projects/page), [Kanban vs Gantt](https://www.bitrix24.com/articles/kanban-vs-gantt-which-view-fits.php)
- Command palette and keyboard: [Vercel Command Menu](https://vercel.com/docs/personal-accounts/command-menu), [Retool, designing the command palette](https://tryretool.com/blog/designing-the-command-palette), [The Linear aesthetic: tokens, density, keyboard-first](https://www.buildmvpfast.com/blog/linear-aesthetic-tokens-density-keyboard-first-ux-2026)
- Following live logs: [Claude Code issue 53435, pausing auto-scroll](https://github.com/anthropics/claude-code/issues/53435), [Airflow PR 70594, no auto-scroll during selection](https://github.com/apache/airflow/pull/70594), [Smart log following](https://vp0.com/blogs/terminal-log-auto-scroll-ui-swiftui.md)
