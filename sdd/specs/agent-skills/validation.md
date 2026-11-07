# Agent skills: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-SKILL-001 | FR-SKILL-001, FR-SKILL-002, FR-SKILL-003, FR-SKILL-004 | My coding agent can use these skills, whichever one I prefer | In Claude Code, Codex, Cursor, Copilot and Gemini CLI, the five skills are found and can be used, and an agent without skill support finds them through `AGENTS.md` |
| VAL-SKILL-002 | FR-SKILL-005, FR-SKILL-006, FR-SKILL-007 | Setup gives me the skills with no extra work | After running `cclinic`, the skills are in place, I'm told what happened, and I can install them alone without using any Claude usage |
| VAL-SKILL-003 | FR-SKILL-008, FR-SKILL-009, FR-SKILL-010 | My own work is safe | My own skills, my edits to these skills, and my existing `AGENTS.md` content are never lost |
| VAL-SKILL-004 | FR-SKILL-011, FR-SKILL-012 | Skills don't distort the analysis | Installing the skills doesn't change the generated documents, and doesn't make the next run reprocess anything |
| VAL-SKILL-005 | FR-SKILL-013 | The skills fit my project | On projects in different languages, the agent follows that project's own stack and guidelines |
| VAL-SKILL-006 | FR-SKILL-014 | Specs written by an agent match the rest | A spec from `create-spec` has the same structure as generated ones, and `refine-spec` improves a spec without renumbering it or inventing answers |
| VAL-SKILL-007 | FR-SKILL-015 | Code reads like my team wrote it | A reviewer finds new code consistent with the code around it, small in scope, and free of noise such as restating comments and unused helpers |
| VAL-SKILL-008 | FR-SKILL-016 | Implementation follows the spec and is proven | Every requirement is built and tested, open questions are raised rather than guessed, and the report matches what really happened |
| VAL-SKILL-009 | FR-SKILL-017 | QA gives me an honest result | Every test case is automated or has manual steps, and failures are reported as defects rather than hidden by weakening tests |
