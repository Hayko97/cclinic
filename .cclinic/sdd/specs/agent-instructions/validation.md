# agent-instructions: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-INSTR-001 | FR-INSTR-001, FR-INSTR-002, FR-INSTR-003, FR-INSTR-004, FR-INSTR-010 | After setup, a new coding agent session already knows the spec-first workflow without being told. | After running cclinic (or its skills command) on a project, a fresh session in Claude Code, Codex, Cursor or Copilot describes the workflow and the right documents folder, and the instructions stay short. |
| VAL-INSTR-002 | FR-INSTR-005, FR-INSTR-006, FR-INSTR-020 | I control when instruction files are added and need no extra account to add them. | Opting out of skills or doing a preview leaves both files untouched; installing works without Claude access; cclinic never commits or pushes. |
| VAL-INSTR-003 | FR-INSTR-007, FR-INSTR-008, FR-INSTR-009 | My own instructions in AGENTS.md and CLAUDE.md are never lost or altered. | My text stays exactly as written and is still followed after installing or re-installing; a damaged section leaves that file alone and tells me; repeating the install changes nothing. |
| VAL-INSTR-004 | FR-INSTR-011, FR-INSTR-012, FR-INSTR-013 | Adding or committing the instruction files must not cost me a new analysis run. | Running cclinic again after installing and committing the files triggers no reprocessing and changes none of the generated documents. |
| VAL-INSTR-005 | FR-INSTR-014 | Questions get plain answers and code requests are tied to the right spec. | A question is answered with no spec or code changes; for a code request the agent states which spec applies before acting, or asks me if unsure. |
| VAL-INSTR-006 | FR-INSTR-015 | I review and approve the spec before any code is written. | A feature or bug request yields a spec update for me to approve or reject; no production code changes until I approve; rejecting leads to a revised spec. |
| VAL-INSTR-007 | FR-INSTR-016 | After approval I get working code with honest test results and a chance to review. | The agent builds the approved change, reports real test results, asks me to approve or request changes, and does not commit by itself. |
| VAL-INSTR-008 | FR-INSTR-017, FR-INSTR-018 | Small changes are quick and I can override steps, yet the agent never guesses. | A typo or refactor skips spec review; telling the agent to skip a step works and is acknowledged; with no docs the agent asks me to run cclinic; with nobody to approve it stops at the spec. |
| VAL-INSTR-009 | FR-INSTR-019 | Commits happen only when I want them and contain exactly the change. | After I approve the implementation the agent asks to commit; if I agree the commit contains this change's spec, code and tests only and nothing is pushed; if I decline nothing is committed. |
| VAL-INSTR-010 | FR-INSTR-001, FR-INSTR-003, FR-INSTR-019, FR-INSTR-020 | Claude Code and other agents share a single source of the rules. | Claude Code follows the same workflow as other agents because CLAUDE.md only points to AGENTS.md. |
