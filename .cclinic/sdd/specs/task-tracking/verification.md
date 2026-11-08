# task-tracking: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest. Tests are in src/core/tasks.test.ts, test/integration/tasks.test.ts and test/e2e/tasks.test.ts.
- Each test uses a fresh temporary project folder. e2e tests run the built `bin/cclinic.js` with no `claude` on `PATH` and no `ANTHROPIC_API_KEY`.
- Run e2e tests on the oldest supported Node (22.18), where `node:sqlite` prints an experimental warning.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-TASK-001 | FR-TASK-001 | integration | An empty project | Add a task, then open a new store on the same folder | `.cclinic/tasks.db` exists, starts with the SQLite header, and the task is read back |
| TC-TASK-002 | FR-TASK-001 | unit | package.json | Read dependencies | No SQLite package was added |
| TC-TASK-003 | FR-TASK-002 | e2e | An empty project with no `.cclinic` folder | Run `tasks list`, `tasks roadmap` and `tasks show 1 --json` | `list` and `roadmap` exit 0 and report no tasks, `show` exits 2, and no `.cclinic` folder exists |
| TC-TASK-004 | FR-TASK-003 | integration | Two milestones exist | Add a third with a goal | It gets a new ID, its position is after both, and the goal is saved |
| TC-TASK-005 | FR-TASK-004 | integration | Milestone 1 with two tasks | Run `tasks milestone remove 1` | The milestone is gone, both tasks still exist with no milestone |
| TC-TASK-006 | FR-TASK-005 | integration | Milestone 1 exists | Add a task with all options | It has status `open`, milestone 1, the spec and the description, and the printed ID matches |
| TC-TASK-007 | FR-TASK-006 | unit | Task input validation | Validate titles of `""`, `"   "`, 201 characters and 200 characters, a 4001-character description, and specs `Auth`, `auth--x`, `-auth` and `auth-2` | Only the 200-character title and `auth-2` are accepted |
| TC-TASK-008 | FR-TASK-006 | e2e | No milestones | Run `tasks add --title X --milestone 9` | Exit code 2, the message names milestone 9, and no task is saved |
| TC-TASK-009 | FR-TASK-007 | integration | Tasks across milestones at positions 2 and 1, one with no milestone, and one `done` | Run `tasks list --json`, then with `--all` | The first omits the done task and orders milestone 1's tasks, milestone 2's, then the unassigned one; `--all` includes the done task |
| TC-TASK-010 | FR-TASK-008 | e2e | A task with every field set | Run `tasks show <id> --json` | The JSON has the ID, title, description, status, milestone, spec, created and updated times |
| TC-TASK-011 | FR-TASK-009 | integration | An open task | Run `start`, then `done` | The status is `in-progress`, then `done`, and the updated time increases each time |
| TC-TASK-012 | FR-TASK-010 | integration | Two tasks | Run `tasks remove` on the first | Only the second remains, even with `--all` |
| TC-TASK-013 | FR-TASK-011 | e2e | One task with ID 1 | Run `show`, `start`, `done`, `remove` and `milestone remove` with `0`, `-1`, `abc`, `1.5` and `99` | Each exits 2, names the ID, and the database is unchanged |
| TC-TASK-014 | FR-TASK-012 | unit | Two milestones and an unassigned task | Render the roadmap | The milestones appear in position order with their goals and tasks with statuses, then the unassigned task |
| TC-TASK-015 | FR-TASK-013 | e2e | A project with tasks | Run every `tasks` command with `--json`, including one that fails | stdout of each parses as one JSON document, a failure has `"status": "error"` and a `message`, and stdout contains no `ExperimentalWarning` |
| TC-TASK-016 | FR-TASK-014 | e2e | A project in a temp folder, with the shell in another folder | Run `tasks add -C <project>`, then `tasks list --dir <project>` | The task is saved in the project's database and listed; nothing is created in the current folder |
| TC-TASK-017 | FR-TASK-014 | e2e | A path that doesn't exist, and a path to a file | Run `tasks list -C <path>` | Exit code 2 each time |
| TC-TASK-018 | FR-TASK-015 | e2e | No `claude` on `PATH`, no API key, stdin closed | Run add, list, start, done, remove and roadmap | Each finishes with its normal exit code without prompting |
| TC-TASK-019 | FR-TASK-016 | integration | A database whose `user_version` is one more than cclinic knows | Run `tasks list` and `tasks add` | Exit code 1, the message says the database is from a newer cclinic, and the file's bytes are unchanged |
| TC-TASK-020 | FR-TASK-016 | integration | `tasks.db` containing plain text | Run `tasks list` | Exit code 1 with a clear message, and the file's bytes are unchanged |
| TC-TASK-021 | FR-TASK-017 | integration | A project with a task, a cache and failed drafts | Run `cclinic clean --yes` | The cache and drafts are gone, and `tasks.db` is unchanged |
| TC-TASK-022 | FR-TASK-017 | e2e | A generated project, using the fake `claude` | Add a task, then run `cclinic --yes` again | No Claude call is made and no Markdown changes |
