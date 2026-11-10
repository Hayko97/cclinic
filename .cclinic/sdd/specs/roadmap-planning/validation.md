# roadmap-planning: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-PLAN-001 | FR-PLAN-001, FR-PLAN-002, FR-PLAN-003 | I can plan a roadmap with one command | `cclinic plan` starts a PM in my terminal, or tells me clearly what's missing |
| VAL-PLAN-002 | FR-PLAN-004 | I choose what the PM plans | I'm asked whether to create a new roadmap, extend one of my roadmaps (which I'm shown), or create a single task |
| VAL-PLAN-003 | FR-PLAN-005, FR-PLAN-016 | Only the PM, with my approval, shapes my roadmaps | The PM can only read the project, and roadmaps, milestones and roadmap tasks can't be created any other way |
| VAL-PLAN-004 | FR-PLAN-006, FR-PLAN-007, FR-PLAN-008 | The PM understands my project and my answers | The PM knows my specs and existing roadmaps, asks me focused questions, and lists what I didn't know as open questions instead of guessing |
| VAL-PLAN-005 | FR-PLAN-009, FR-PLAN-010 | A plan that can't run is never shown to me as ready | Proposals with missing tasks, bad dependencies or loops are fixed by the PM before I see them, and a PM that can't answer properly ends the session without saving |
| VAL-PLAN-006 | FR-PLAN-011, FR-PLAN-012, FR-PLAN-013 | I approve the roadmap before it's saved | I see the whole roadmap with its dependencies, can send feedback until I'm happy, and after I approve it's saved in full and I'm told how to run it |
| VAL-PLAN-007 | FR-PLAN-014, FR-PLAN-015 | Planning can't cost too much or leave a half-saved plan | Cancelling, stopping or hitting a limit saves nothing, and a session never goes over its budget or turn limit |
| VAL-PLAN-008 | FR-PLAN-017, FR-PLAN-018, FR-PLAN-019, FR-PLAN-020 | I can have the PM write one well-defined task without planning a whole roadmap | `cclinic plan --task` asks me questions, proposes one task with its spec and dependencies, standalone or in a roadmap I choose, and saves it only after I approve |
