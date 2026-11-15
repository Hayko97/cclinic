# task-tracking

## Goal

Keep a project's named roadmaps (each an ordered list of milestones), and its planned tasks with their dependencies, in a local SQLite database at `.luseen/tasks.db`, and let users and coding agents read and change it with `luseen tasks` commands that need no Claude, no network and no extra dependency.

The `product-engineer` skill that plans tasks is in [agent-skills](../agent-skills/spec.md). The open-task check on every prompt is in [agent-instructions](../agent-instructions/spec.md).

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-TASK-001 | luseen must store milestones and tasks in one SQLite database at `<project>/.luseen/tasks.db`, using Node's built-in `node:sqlite` module, with no new npm dependency. | confirmed | `src/adapters/storage/task-store.ts:80`, `src/core/constants/paths.ts`, `test/integration/tasks.test.ts`, `user request` |
| FR-TASK-002 | The database must be created, with any missing `.luseen` folder, only by a command that writes. `tasks list` and `tasks roadmap` on a project without a database must exit 0 and report no tasks, and no read command (`list`, `show`, `roadmap`, `roadmaps`, `roadmap show`) may create a file or folder. | confirmed | `src/adapters/storage/task-store.ts:80`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-003 | Milestones must be created only by `luseen plan` (see [roadmap-planning](../roadmap-planning/spec.md)). `luseen tasks milestone add` must exit 2, save nothing, and say to use `luseen plan`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-004 | `luseen tasks milestone remove <id>` must delete the milestone and keep its tasks, which then belong to no milestone. | confirmed | `src/adapters/storage/task-store.ts:141`, `src/cli/tasks-command.ts`, `user request` |
| FR-TASK-005 | `luseen tasks add --title <text> [--description <text>] [--spec <name>] [--depends-on <id>]` must save a task with status `open` and no milestone, and print its numeric ID. `--milestone` must exit 2, save nothing, and say tasks join a roadmap through `luseen plan`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `src/adapters/storage/task-store.ts:149`, `src/cli/tasks-command.ts:110`, `user request` |
| FR-TASK-006 | A title must be 1 to 200 characters after trimming, a description at most 4000 characters, and a spec name lowercase letters, digits and single hyphens (kebab-case). An invalid value, or a milestone ID that doesn't exist, must exit 2 and save nothing. | confirmed | `src/core/tasks.ts:37`, `src/core/tasks.test.ts`, `user request` |
| FR-TASK-007 | `luseen tasks list` must show tasks with status `open` or `in-progress`, ordered by milestone position, then tasks with no milestone, then by task ID. `--all` must also include `done` tasks. | confirmed | `src/adapters/storage/task-store.ts:36`, `src/cli/tasks-command.ts:74`, `user request` |
| FR-TASK-008 | `luseen tasks show <id>` must print every field of the task: ID, title, description, status, milestone, spec, created and updated times. | confirmed | `src/core/tasks.ts:76`, `src/cli/tasks-command.ts:96`, `user request` |
| FR-TASK-009 | `luseen tasks start <id>` must set the status to `in-progress`, and `luseen tasks done <id>` to `done`, each updating the task's updated time. | confirmed | `src/adapters/storage/task-store.ts:160`, `src/cli/tasks-command.ts:132`, `user request` |
| FR-TASK-010 | `luseen tasks remove <id>` must delete the task permanently. | confirmed | `src/adapters/storage/task-store.ts:166`, `src/cli/tasks-command.ts:150`, `user request` |
| FR-TASK-011 | `show`, `start`, `done`, `remove` and `milestone remove` with an ID that isn't a positive integer or doesn't exist must exit 2, name the ID, and change nothing. | confirmed | `src/core/tasks.ts:60`, `src/cli/tasks-command.ts:56`, `user request` |
| FR-TASK-012 | `luseen tasks roadmap` must print each roadmap in ID order, each with its milestones in position order, their goals, and their tasks and statuses, followed by tasks with no milestone. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `src/core/tasks.ts:103`, `src/cli/tasks-command.ts:86`, `user request` |
| FR-TASK-013 | Every `tasks` command must accept `--json` and then print exactly one valid JSON document on stdout and nothing else, including no Node warning. Errors must also be one JSON document, in luseen's usual error form, with `"status": "error"`, the exit code and a `message`. | confirmed | `src/cli/tasks-command.ts:38`, `bin/luseen.js:17`, `src/cli/main.ts:219`, `user request`, `src/cli/main.ts:198-215` |
| FR-TASK-014 | Every `tasks` command must accept `-C, --dir <path>` to choose the project folder, defaulting to the current folder. A path that doesn't exist or isn't a folder must exit 2. | confirmed | `src/cli/tasks-command.ts:27`, `user request` |
| FR-TASK-015 | `tasks` commands must never call Claude, use the network, or need the `claude` executable or an API key, and must never prompt. | confirmed | `src/cli/tasks-command.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-016 | The database must record its schema version in `PRAGMA user_version`. A database with a newer version than luseen knows, or a file that isn't a SQLite database, must make the command exit 1 with a clear message and leave the file unchanged. | confirmed | `src/adapters/storage/task-store.ts:54`, `src/core/errors.ts`, `user request` |
| FR-TASK-017 | `luseen clean` must not delete or change `tasks.db`, and changes to it must not affect analysis, the cache or generated documents. | confirmed | `src/adapters/storage/document-store.ts:256-261`, `src/core/constants/discovery.ts:85`, `test/integration/tasks.test.ts`, `src/adapters/storage/document-store.ts:256-261`, `src/core/constants/discovery.ts:85` |
| FR-TASK-018 | `luseen tasks add` must accept `--depends-on <id>` (repeatable), and `luseen tasks depend <id> --on <id>` and `luseen tasks undepend <id> --on <id>` must add and remove a dependency. A task that doesn't exist, a task depending on itself, or a dependency that would make a cycle must exit 2 and save nothing. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-019 | `tasks show`, `tasks list` and `tasks roadmap`, with and without `--json`, must show each task's dependencies as task IDs. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-020 | A task's status may also be `blocked`. `tasks list` must show `blocked` tasks with the open and in-progress ones, and `tasks start` on a `blocked` task must set it to `in-progress`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request`, `.luseen/sdd/specs/automated-mode/spec.md` |
| FR-TASK-021 | `luseen tasks remove <id>` must also remove every dependency on or from that task. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-022 | The database schema version must become 2. A version 1 database must still be readable by read commands without being changed, and must be upgraded to version 2 by the first command that writes, keeping every milestone and task, and putting all existing milestones, in their order, into one roadmap titled `Roadmap`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `src/adapters/storage/task-store.ts:9`, `user request` |
| FR-TASK-023 | Roadmaps must be created only by `luseen plan`. `luseen tasks roadmap add` must exit 2, save nothing, and say to use `luseen plan`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-024 | `luseen tasks roadmaps` must list every roadmap in ID order, with its ID, title, goal, status, number of milestones, and number of tasks in each status. With no database, it must exit 0 and report no roadmaps. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-025 | `luseen tasks roadmap show <id>` must print one roadmap: its title, goal and status, and its milestones in position order with their goals and tasks, each task with its status and dependencies. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-026 | A roadmap's status must be worked out from its tasks: `done` when it has at least one task and all of them are `done`, `in-progress` when any task is `in-progress`, `done` or `blocked`, and otherwise `planned`. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-027 | The task store must save a whole approved plan (a new roadmap or an existing one, its new milestones placed after the roadmap's existing ones, their `open` tasks, and dependencies given by key or existing ID) in one transaction, and likewise a single approved task with its dependencies, in an existing milestone or with none. If any part fails, nothing may be saved. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request`, `.luseen/sdd/specs/roadmap-planning/spec.md` |
| FR-TASK-028 | `luseen tasks roadmap remove <id>` must delete the roadmap and its milestones, and keep their tasks, which then belong to no milestone. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-029 | `tasks roadmap show` and `tasks roadmap remove` with an ID that isn't a positive integer or doesn't exist must exit 2, name the ID, and change nothing. | confirmed | `src/adapters/storage/task-store.ts`, `src/cli/tasks-command.ts`, `src/core/tasks.ts`, `test/integration/tasks.test.ts`, `test/e2e/tasks.test.ts`, `user request` |

## Edge cases

- No database yet and only read commands run: no file is created.
- A milestone is removed while it still has tasks: the tasks stay, with no milestone.
- Anyone can remove a roadmap, milestone or task, but only `luseen plan` can create roadmaps and milestones.
- A roadmap is removed: its milestones go, and their tasks stay, with no milestone.
- A task with no milestone belongs to no roadmap. It shows after the roadmaps in `tasks roadmap`, and automated mode doesn't run it.
- A task may depend on a task in another roadmap.
- A roadmap with no tasks has status `planned`.
- Adding a task to a milestone ID that doesn't exist: exit 2, nothing saved.
- An ID of `0`, `-1`, `abc` or `1.5`: exit 2.
- A title of only spaces: exit 2.
- `start` on a task that's already `done`: allowed, it reopens the work as `in-progress`.
- A database written by a newer luseen: refused, untouched.
- `tasks.db` is not a SQLite file: refused, untouched.
- Task 2 depends on 1, and the user adds 1 depending on 2: exit 2, it would make a cycle.
- A version 1 database from an older luseen: read as is, upgraded on the first write.
- `--json` on Node 22, where `node:sqlite` prints an experimental warning: stdout is still only JSON.

## Non-goals

- Syncing tasks with external trackers (GitHub Issues, Jira, Linear).
- Assignees, due dates, priorities or comments. (Running tasks with agents is in [automated-mode](../automated-mode/spec.md).)
- Reordering milestones or tasks after they're created.
- Merging two people's `tasks.db` files.
- Deciding which tasks to create. That's the `product-engineer` skill's job, with the user.
