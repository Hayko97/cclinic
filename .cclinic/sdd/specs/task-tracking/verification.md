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
| TC-TASK-004 | FR-TASK-003 | e2e | A project with roadmap 1 | Run `tasks milestone add --title M --goal G` | Exit 2, the message names `cclinic plan`, and no milestone is saved |
| TC-TASK-005 | FR-TASK-004 | integration | Milestone 1 with two tasks | Run `tasks milestone remove 1` | The milestone is gone, both tasks still exist with no milestone |
| TC-TASK-006 | FR-TASK-005 | integration | Task 1 exists | Run `tasks add` with a title, description, spec and `--depends-on 1`, then with `--milestone 1` | The first saves an `open` task with no milestone, the spec, the description and dependency 1, and the printed ID matches; the second exits 2 naming `cclinic plan` and saves nothing |
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
| TC-TASK-023 | FR-TASK-018 | e2e | Tasks 1 and 2 | Run `tasks add --title C --depends-on 1 --depends-on 2`, then `tasks depend 1 --on 2`, then `tasks undepend 1 --on 2` | Task 3 depends on 1 and 2; task 1 then depends on 2, then on nothing |
| TC-TASK-024 | FR-TASK-018 | e2e | Task 2 depends on task 1 | Run `tasks depend 1 --on 2`, `tasks depend 1 --on 1`, `tasks depend 1 --on 99` and `tasks add --title X --depends-on 99` | Each exits 2, names the problem (cycle, itself, missing ID), and the database is unchanged |
| TC-TASK-025 | FR-TASK-019 | e2e | Task 3 depends on tasks 1 and 2 | Run `tasks show 3 --json`, `tasks list --json`, `tasks roadmap` and `tasks show 3` | The JSON has `dependsOn: [1, 2]` for task 3 and `[]` for the others; the text output names tasks 1 and 2 for task 3 |
| TC-TASK-026 | FR-TASK-020 | integration | A task set to `blocked` through the store | Run `tasks list --json`, then `tasks start <id>` | The list includes it with status `blocked`; after start it's `in-progress` |
| TC-TASK-027 | FR-TASK-021 | integration | Task 2 depends on task 1, task 1 depends on task 3 | Remove task 1 | Task 2 has no dependencies, and no dependency row mentions task 1 |
| TC-TASK-028 | FR-TASK-022 | integration | A version 1 database with a milestone and two tasks, made with the old schema | Run `tasks list`, compare file bytes, then run `tasks add --title X` | The list works and the file is unchanged; after the add, `user_version` is 2 and the milestone, both old tasks and the new task are there |
| TC-TASK-029 | FR-TASK-023 | e2e | An empty project | Run `tasks roadmap add --title Launch` | Exit 2, the message names `cclinic plan`, and no `.cclinic/tasks.db` is created |
| TC-TASK-030 | FR-TASK-024 | e2e | Roadmap 1 with 2 milestones and tasks `open`, `in-progress`, `done` and `blocked`, and empty roadmap 2 | Run `tasks roadmaps --json`, then `tasks roadmaps` | The JSON lists roadmap 1 then 2, with title, goal, status, milestone count 2 and 0, and task counts by status (1 each, then all 0); the text shows the same |
| TC-TASK-031 | FR-TASK-024, FR-TASK-002 | e2e | An empty project with no `.cclinic` folder | Run `tasks roadmaps` | Exit 0, no roadmaps reported, no `.cclinic` folder created |
| TC-TASK-032 | FR-TASK-025 | e2e | Roadmap 1 with milestones at positions 2 and 1, and task 3 depending on task 1 | Run `tasks roadmap show 1 --json` and without `--json` | Milestones appear in position order with goals, each task has its status, and task 3 lists dependency 1 |
| TC-TASK-033 | FR-TASK-026 | unit | Roadmaps with: no tasks; all `open`; one `blocked`; one `in-progress`; all `done` | Work out each status | `planned`, `planned`, `in-progress`, `in-progress`, `done` |
| TC-TASK-034 | FR-TASK-027 | integration | Roadmap 1 with 2 milestones, and existing task 5 | Save a plan for roadmap 1 with 1 milestone and tasks A and B, where B depends on A and on task 5 | The milestone is position 3, A and B are `open`, and B depends on A's new ID and on 5 |
| TC-TASK-035 | FR-TASK-027 | integration | A store made to fail on the second task | Save a new-roadmap plan with 2 tasks | No roadmap, milestone, task or dependency from the plan exists afterwards |
| TC-TASK-036 | FR-TASK-012 | unit | Roadmaps 2 and 1, each with milestones and tasks, and one task with no milestone | Render `tasks roadmap` | Roadmap 1 then 2, each with its milestones in position order and tasks with statuses, then the task with no milestone |
| TC-TASK-037 | FR-TASK-028 | integration | Roadmap 1 with milestone 1 holding two tasks | Run `tasks roadmap remove 1` | The roadmap and milestone are gone, and both tasks exist with no milestone |
| TC-TASK-038 | FR-TASK-029 | e2e | Roadmap 1 | Run `roadmap show` and `roadmap remove` with `0`, `-1`, `abc`, `1.5` and `99` | Each exits 2, names the ID, and the database is unchanged |
| TC-TASK-039 | FR-TASK-022 | integration | A version 1 database with milestones A (position 1) and B (position 2) | Run `tasks add --title X`, then `tasks roadmaps --json` | One roadmap titled `Roadmap` exists, holding A then B |
| TC-TASK-040 | FR-TASK-027 | integration | Roadmap 1 with milestone 2, and task 4 | Save a single task in milestone 2 depending on 4, then a standalone one, then one whose dependency save is made to fail | The first is `open` in milestone 2 with dependency 4; the second has no milestone; the third leaves no task behind |
