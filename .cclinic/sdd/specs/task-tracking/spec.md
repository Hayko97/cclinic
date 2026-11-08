# task-tracking

## Goal

Keep a project's roadmap (ordered milestones) and its planned tasks in a local SQLite database at `.cclinic/tasks.db`, and let users and coding agents read and change it with `cclinic tasks` commands that need no Claude, no network and no extra dependency.

The `product-engineer` skill that plans tasks is in [agent-skills](../agent-skills/spec.md). The open-task check on every prompt is in [agent-instructions](../agent-instructions/spec.md).

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-TASK-001 | cclinic must store milestones and tasks in one SQLite database at `<project>/.cclinic/tasks.db`, using Node's built-in `node:sqlite` module, with no new npm dependency. | confirmed | `src/adapters/storage/task-store.ts:80`, `src/core/constants/paths.ts`, `test/integration/tasks.test.ts`, `user request` |
| FR-TASK-002 | The database must be created, with any missing `.cclinic` folder, only by a command that writes. `tasks list` and `tasks roadmap` on a project without a database must exit 0 and report no tasks, and no read command (`list`, `show`, `roadmap`) may create a file or folder. | confirmed | `src/adapters/storage/task-store.ts:80`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-003 | `cclinic tasks milestone add --title <text> [--goal <text>]` must save a milestone placed after all existing milestones, and print its numeric ID. | confirmed | `src/adapters/storage/task-store.ts:130`, `src/cli/tasks-command.ts`, `user request` |
| FR-TASK-004 | `cclinic tasks milestone remove <id>` must delete the milestone and keep its tasks, which then belong to no milestone. | confirmed | `src/adapters/storage/task-store.ts:141`, `src/cli/tasks-command.ts`, `user request` |
| FR-TASK-005 | `cclinic tasks add --title <text> [--description <text>] [--milestone <id>] [--spec <name>]` must save a task with status `open` and print its numeric ID. | confirmed | `src/adapters/storage/task-store.ts:149`, `src/cli/tasks-command.ts:110`, `user request` |
| FR-TASK-006 | A title must be 1 to 200 characters after trimming, a description at most 4000 characters, and a spec name lowercase letters, digits and single hyphens (kebab-case). An invalid value, or a milestone ID that doesn't exist, must exit 2 and save nothing. | confirmed | `src/core/tasks.ts:37`, `src/core/tasks.test.ts`, `user request` |
| FR-TASK-007 | `cclinic tasks list` must show tasks with status `open` or `in-progress`, ordered by milestone position, then tasks with no milestone, then by task ID. `--all` must also include `done` tasks. | confirmed | `src/adapters/storage/task-store.ts:36`, `src/cli/tasks-command.ts:74`, `user request` |
| FR-TASK-008 | `cclinic tasks show <id>` must print every field of the task: ID, title, description, status, milestone, spec, created and updated times. | confirmed | `src/core/tasks.ts:76`, `src/cli/tasks-command.ts:96`, `user request` |
| FR-TASK-009 | `cclinic tasks start <id>` must set the status to `in-progress`, and `cclinic tasks done <id>` to `done`, each updating the task's updated time. | confirmed | `src/adapters/storage/task-store.ts:160`, `src/cli/tasks-command.ts:132`, `user request` |
| FR-TASK-010 | `cclinic tasks remove <id>` must delete the task permanently. | confirmed | `src/adapters/storage/task-store.ts:166`, `src/cli/tasks-command.ts:150`, `user request` |
| FR-TASK-011 | `show`, `start`, `done`, `remove` and `milestone remove` with an ID that isn't a positive integer or doesn't exist must exit 2, name the ID, and change nothing. | confirmed | `src/core/tasks.ts:60`, `src/cli/tasks-command.ts:56`, `user request` |
| FR-TASK-012 | `cclinic tasks roadmap` must print each milestone in position order with its goal and its tasks and their statuses, followed by tasks with no milestone. | confirmed | `src/core/tasks.ts:103`, `src/cli/tasks-command.ts:86`, `user request` |
| FR-TASK-013 | Every `tasks` command must accept `--json` and then print exactly one valid JSON document on stdout and nothing else, including no Node warning. Errors must also be one JSON document, in cclinic's usual error form, with `"status": "error"`, the exit code and a `message`. | confirmed | `src/cli/tasks-command.ts:38`, `bin/cclinic.js:17`, `src/cli/main.ts:219`, `user request`, `src/cli/main.ts:198-215` |
| FR-TASK-014 | Every `tasks` command must accept `-C, --dir <path>` to choose the project folder, defaulting to the current folder. A path that doesn't exist or isn't a folder must exit 2. | confirmed | `src/cli/tasks-command.ts:27`, `user request` |
| FR-TASK-015 | `tasks` commands must never call Claude, use the network, or need the `claude` executable or an API key, and must never prompt. | confirmed | `src/cli/tasks-command.ts`, `test/e2e/tasks.test.ts`, `user request` |
| FR-TASK-016 | The database must record its schema version in `PRAGMA user_version`. A database with a newer version than cclinic knows, or a file that isn't a SQLite database, must make the command exit 1 with a clear message and leave the file unchanged. | confirmed | `src/adapters/storage/task-store.ts:54`, `src/core/errors.ts`, `user request` |
| FR-TASK-017 | `cclinic clean` must not delete or change `tasks.db`, and changes to it must not affect analysis, the cache or generated documents. | confirmed | `src/adapters/storage/document-store.ts:256-261`, `src/core/constants/discovery.ts:85`, `test/integration/tasks.test.ts`, `src/adapters/storage/document-store.ts:256-261`, `src/core/constants/discovery.ts:85` |

## Edge cases

- No database yet and only read commands run: no file is created.
- A milestone is removed while it still has tasks: the tasks stay, with no milestone.
- Adding a task to a milestone ID that doesn't exist: exit 2, nothing saved.
- An ID of `0`, `-1`, `abc` or `1.5`: exit 2.
- A title of only spaces: exit 2.
- `start` on a task that's already `done`: allowed, it reopens the work as `in-progress`.
- A database written by a newer cclinic: refused, untouched.
- `tasks.db` is not a SQLite file: refused, untouched.
- `--json` on Node 22, where `node:sqlite` prints an experimental warning: stdout is still only JSON.

## Non-goals

- Syncing tasks with external trackers (GitHub Issues, Jira, Linear).
- Assignees, due dates, priorities or comments.
- Reordering milestones or tasks after they're created.
- Merging two people's `tasks.db` files.
- Deciding which tasks to create. That's the `product-engineer` skill's job, with the user.
