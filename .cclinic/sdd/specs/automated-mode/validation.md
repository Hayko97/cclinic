# automated-mode: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-AUTO-001 | FR-AUTO-001, FR-AUTO-002, FR-AUTO-034 | I can hand a whole roadmap to agents with one command | I pick a roadmap by ID or from a list, and `cclinic auto` works through all its unfinished tasks, retrying blocked ones and leaving work in progress alone, with as many developers and as much budget as I choose |
| VAL-AUTO-002 | FR-AUTO-003, FR-AUTO-004, FR-AUTO-005 | A run never starts in a state that will go wrong | Without Claude CLI, Git, a clean tree, skills or open tasks, or with circular dependencies, I get a clear reason and nothing starts; otherwise I see the plan and confirm it first |
| VAL-AUTO-003 | FR-AUTO-006, FR-AUTO-007, FR-AUTO-008, FR-AUTO-009 | Work happens in the right order, in parallel where it can | Progress shows in the roadmap's status, a task never starts before the tasks it depends on are done, independent tasks run side by side, a stuck task only stops the tasks that need it, and the task list always shows what's happening |
| VAL-AUTO-004 | FR-AUTO-010, FR-AUTO-011, FR-AUTO-012 | My own work is never touched | My branch, files and staged changes are the same after the run, nothing is pushed, and all the run's work is on branches named after the run |
| VAL-AUTO-005 | FR-AUTO-013, FR-AUTO-014, FR-AUTO-015 | Each finished task lands cleanly | Each approved task is one commit on its own branch, merged into the run branch, and a task that can't merge is kept on its branch with the reason |
| VAL-AUTO-006 | FR-AUTO-016, FR-AUTO-017, FR-AUTO-018 | Agents can't do damage while I'm away | Agents can't use Git, read secrets or write outside their task, and the PM only reads |
| VAL-AUTO-007 | FR-AUTO-019, FR-AUTO-020 | Specs are approved before code is written | Every task's spec is approved by the PM before any implementation, and rejected specs are revised with the PM's feedback |
| VAL-AUTO-008 | FR-AUTO-021, FR-AUTO-022, FR-AUTO-023 | Only tested, reviewed work is committed | Each task is tested by a separate QA agent and approved by the PM before it's committed, and a broken or unclear answer is never taken as approval |
| VAL-AUTO-009 | FR-AUTO-024, FR-AUTO-025, FR-AUTO-026 | A run can't loop or spend without limit | A task stops after 3 failed rounds at any stage, the run never costs more than my budget, and no agent runs longer than the timeout |
| VAL-AUTO-010 | FR-AUTO-027, FR-AUTO-028, FR-AUTO-029, FR-AUTO-030 | I know when it's finished and what happened | I get a desktop notification when the run ends, and a report tells me what's done, what's blocked and why, what it cost, and how to merge the work |
| VAL-AUTO-011 | FR-AUTO-031, FR-AUTO-032 | I can stop a run safely | Stopping a run keeps all work on its branches, puts unfinished tasks back to open, and a second run can't start while one is going |
| VAL-AUTO-012 | FR-AUTO-033 | Runs don't interfere with the rest of cclinic | Cleaning the cache keeps run reports, and runs don't make `cclinic` reprocess anything |
