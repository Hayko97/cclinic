# task-tracking: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-TASK-001 | FR-TASK-001, FR-TASK-002 | My plan is kept with the project, without installing anything | Tasks are saved in `.cclinic/tasks.db` and survive between sessions; just looking at tasks never creates files |
| VAL-TASK-002 | FR-TASK-003, FR-TASK-004, FR-TASK-012 | I can see the roadmap | I can add and remove milestones, and the roadmap shows them in order with their tasks, plus tasks not yet in a milestone |
| VAL-TASK-003 | FR-TASK-005, FR-TASK-006 | Tasks I save are well-formed | A task needs a real title, can name a spec and milestone, and a mistake is rejected without saving anything |
| VAL-TASK-004 | FR-TASK-007, FR-TASK-008 | I see what's still to do | The task list shows open and in-progress work in roadmap order, and I can see a task's full details |
| VAL-TASK-005 | FR-TASK-009, FR-TASK-010, FR-TASK-011 | I can move work along or drop it | I can start, finish or remove a task, and a wrong ID gives a clear error and changes nothing |
| VAL-TASK-006 | FR-TASK-013, FR-TASK-014, FR-TASK-015 | My coding agent can use it reliably | Any agent can run the commands on any project folder, without Claude or network, never gets stuck on a prompt, and can read clean JSON |
| VAL-TASK-007 | FR-TASK-016 | My tasks are never damaged | A database from a newer cclinic, or a broken file, is refused and left as it was |
| VAL-TASK-008 | FR-TASK-017 | Tasks don't interfere with the rest of cclinic | Cleaning the cache keeps my tasks, and changing tasks doesn't make `cclinic` reprocess anything |
