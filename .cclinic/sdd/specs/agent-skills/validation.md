# agent-skills: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-SKILL-001 | FR-SKILL-001, FR-SKILL-002, FR-SKILL-017 | Get a consistent set of six skills that any coding agent can read and that fit any project. | After setup the five named skills exist, each with a valid name and short description, none naming a specific agent, and all pointing to the project's own documents folder. |
| VAL-SKILL-002 | FR-SKILL-003, FR-SKILL-004, FR-SKILL-005 | Have the skills found by Claude Code, Codex, Cursor, Copilot and Gemini CLI, and by agents without skill support. | The skills appear in both shared skill locations with identical content, and AGENTS.md lists them and the documents folder. |
| VAL-SKILL-003 | FR-SKILL-006, FR-SKILL-007, FR-SKILL-008, FR-SKILL-009 | Install skills automatically or on their own, without using Claude, and be told what happened. | Running cclinic installs skills unless opted out, a preview installs nothing, the skills-only command works with no Claude or key, a skill problem never fails a saved run, and each location is reported as installed, updated, unchanged or skipped. |
| VAL-SKILL-004 | FR-SKILL-010, FR-SKILL-011, FR-SKILL-012, FR-SKILL-013 | Never lose my own skills or my edits to the provided ones. | My own same-named skill is never changed, my edited copy is kept unless I force, unchanged files are left as they are, and untouched older copies are updated, regardless of line endings. |
| VAL-SKILL-005 | FR-SKILL-014 | Keep my existing AGENTS.md content safe. | Only the cclinic section changes, everything else is identical, and a broken section is left untouched and reported. |
| VAL-SKILL-006 | FR-SKILL-015, FR-SKILL-016 | Installing skills must not alter my generated documents or cause reprocessing. | A second run after installing uses no Claude calls and changes no document. |
| VAL-SKILL-007 | FR-SKILL-018 | Create and refine specs in the same structure as generated ones. | Specs produced follow the three-file format with permanent IDs, coverage and evidence, refinement does not renumber or invent answers, and the user is warned that forcing a re-run replaces hand edits. |
| VAL-SKILL-008 | FR-SKILL-019, FR-SKILL-020 | Get small, consistent code and honest implementation reports. | New code follows project conventions in small changes, every requirement is implemented with tests, open questions are raised instead of guessed, and no pass is claimed without running. |
| VAL-SKILL-009 | FR-SKILL-021 | Have every test case automated or documented and failures reported honestly. | Each test case has an automated test or manual steps, results are reported, failures appear as defects with reproduction steps, and tests are not weakened. |
| VAL-SKILL-010 | FR-SKILL-022, FR-SKILL-023 | Implementing a spec includes independent testing and fixing, and I get clear manual steps. | The implementation report includes a QA result; defects are fixed and re-tested, at most 3 rounds; manual test cases come with steps I can follow in the preview. |
| VAL-SKILL-011 | FR-SKILL-024 | Implementing never loops on QA, and QA works without a spec. | Every QA run counts toward the limit of 3, wrong tests are fixed to match the spec, and a change with no spec gets the full checks instead of a question. |
