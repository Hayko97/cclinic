# code-review: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-CREV-001 | FR-CREV-001, FR-CREV-002 | Any coding agent can review code the same way | After setup, my agent has a `review-code` skill, and in Claude Code its built-in `/code-review` still works |
| VAL-CREV-002 | FR-CREV-003, FR-CREV-004 | Code is checked against my rules | Findings cite my own rules or the developer guidelines, and my rules win over the defaults |
| VAL-CREV-003 | FR-CREV-004 | Common problems are caught | A change with a hardcoded limit, duplicated logic, a vague name or a class doing two jobs gets a finding for each |
| VAL-CREV-004 | FR-CREV-005, FR-CREV-011 | The review stays on my change | Only files my change touched get findings to fix, and my unrelated work in progress is left alone. Older problems and failures elsewhere are listed as follow-ups |
| VAL-CREV-005 | FR-CREV-006 | Tools do what tools do best | The review reports the linter, type checker and test results, and a failing check in my change is blocking |
| VAL-CREV-006 | FR-CREV-007, FR-CREV-010 | I can see what matters | Each finding says how serious it is, where it is, which rule it breaks and how to fix it, and the review ends with a clear verdict |
| VAL-CREV-007 | FR-CREV-008, FR-CREV-009 | Claude Code's reviewer is used too, without noise | In Claude Code, its review runs at a fixed, moderate level, even if I used a costly level earlier, and its confirmed findings appear in the report. Elsewhere, the report says it didn't run |
| VAL-CREV-008 | FR-CREV-012, FR-CREV-018 | Every change is reviewed before I see it | Before the preview, the agent reviews the change, separately when it can, and the reviewer doesn't start its own spec work |
| VAL-CREV-009 | FR-CREV-013, FR-CREV-014 | Review problems are fixed safely | Findings are fixed without changing behaviour, tests run again after the fixes, and a finding the agent disagrees with is explained instead of fixed |
| VAL-CREV-010 | FR-CREV-015 | The agent doesn't loop forever | After 3 reviews that still have problems, the agent stops and tells me what's left, instead of asking for approval |
| VAL-CREV-011 | FR-CREV-016, FR-CREV-017 | I know the review result before I approve or commit | The report shows what was found and fixed, and any open finding is stated before I'm asked to commit |
| VAL-CREV-012 | FR-CREV-019 | The skills agree with the workflow | Following `implement-spec` alone gives the same review step as following `AGENTS.md` |
| VAL-CREV-013 | FR-CREV-020 | The instructions stay short enough to follow | The `AGENTS.md` section is still under 200 lines |
| VAL-CREV-014 | FR-CREV-014, FR-CREV-021 | Code I see and commit is always tested and reviewed | Changes I ask for after the preview are tested and reviewed again, and the agent never asks for approval of review fixes that QA couldn't test |
| VAL-CREV-015 | FR-CREV-022, FR-CREV-023 | Reviews are counted and independent | With the cclinic tools, every review is recorded and fixes are tested again before I see them; in auto runs, a separate reviewer reviews the developer's work |
