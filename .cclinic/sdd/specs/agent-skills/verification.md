# agent-skills: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest (vitest.config.ts); tests in src/core/agent-skills.test.ts, test/integration/skills.test.ts and test/e2e/skills.test.ts.
- Each test uses a fresh temporary target folder (sdd/specs/agent-skills/verification.md:5).
- E2E tests replace Claude with the fake executable test/fixtures/fake-claude/claude and recorded outputs in test/fixtures/recorded-cli-output.
- Shared helpers: test/support/helpers.ts.
- Read-only folder test is POSIX only.
- Manual cases need real Claude Code, Codex, Cursor, Copilot and Gemini CLI on a real project.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-SKILL-001 | FR-SKILL-001 | unit | The built-in skill catalogue. | The skill names are listed. | The list is exactly create-spec, refine-spec, write-code, implement-spec, test-spec. |
| TC-SKILL-002 | FR-SKILL-002 | unit | Each rendered skill. | Frontmatter and length are checked. | name equals the folder name and matches lowercase letters, digits and single hyphens up to 64 chars; description is 1-1024 chars; file has under 500 lines. |
| TC-SKILL-003 | FR-SKILL-003, FR-SKILL-005 | integration | An empty temporary target folder. | Skills are installed. | .agents/skills/<name>/SKILL.md and .claude/skills/<name>/SKILL.md exist for all five skills with identical content including generated-by: cclinic and a hash. |
| TC-SKILL-004 | FR-SKILL-004 | integration | A target without AGENTS.md. | Skills are installed. | AGENTS.md is created with start and end markers listing the five skills and the documents folder. |
| TC-SKILL-005 | FR-SKILL-006 | e2e | A sample project and the fake claude executable. | `cclinic --yes` is run. | Exit 0, documents exist, and skill folders and AGENTS.md exist. |
| TC-SKILL-006 | FR-SKILL-006 | e2e | A sample project and the fake claude. | `cclinic --yes --no-skills` is run. | Documents exist but no .agents, .claude skill folders or skills AGENTS.md section are created. |
| TC-SKILL-007 | FR-SKILL-006, FR-SKILL-008 | e2e | A sample project. | `cclinic --dry-run` and `cclinic skills <path> --dry-run` are run. | No skill folders and no AGENTS.md are created. |
| TC-SKILL-008 | FR-SKILL-007 | e2e | A POSIX target where the skill folder cannot be written, and the fake claude. | `cclinic --yes` is run. | Exit code 0, documents are created and a warning about skills is shown. |
| TC-SKILL-009 | FR-SKILL-008 | e2e | No claude executable on PATH and no ANTHROPIC_API_KEY. | `cclinic skills <path>` is run. | Exit 0 and the skills are installed. |
| TC-SKILL-010 | FR-SKILL-008, FR-SKILL-017 | e2e | A target folder. | `cclinic skills <path> --out docs/sdd` is run. | Installed skills mention docs/sdd and do not mention .cclinic/sdd. |
| TC-SKILL-011 | FR-SKILL-009 | e2e | A fresh target, then skills already installed. | `cclinic skills <path> --json` is run twice. | First output lists each location as installed; second lists them as unchanged; output is valid JSON. |
| TC-SKILL-012 | FR-SKILL-010 | integration | A SKILL.md at the target path with no generated-by: cclinic mark. | Skills are installed, once without and once with --force. | The file content is byte-identical afterwards in both runs and the location is reported as skipped with a reason. |
| TC-SKILL-013 | FR-SKILL-011 | integration | An installed cclinic skill edited by hand. | Skills are installed without, then with --force. | Without --force the edit is kept and reported skipped; with --force the file is restored to the cclinic content. |
| TC-SKILL-014 | FR-SKILL-012 | integration | Skills already installed and unmodified. | Skills are installed again. | Files are not rewritten (modification times unchanged) and reported unchanged. |
| TC-SKILL-015 | FR-SKILL-012 | unit | A cclinic skill file with an older body and a valid hash for that body. | Skills are installed. | The file is replaced with the current content and reported updated. |
| TC-SKILL-016 | FR-SKILL-013 | unit | An installed cclinic skill converted to CRLF line endings. | The file is classified. | It is classified as managed and unedited. |
| TC-SKILL-017 | FR-SKILL-014 | integration | An AGENTS.md with user text and an old cclinic section. | Skills are installed. | Text outside the markers is byte-identical and the section is updated. |
| TC-SKILL-018 | FR-SKILL-014 | integration | An AGENTS.md with a start marker but no end marker. | Skills are installed. | AGENTS.md is unchanged and the result reports the problem. |
| TC-SKILL-019 | FR-SKILL-015 | integration | A project containing .agents, .claude and an AGENTS.md with a cclinic section plus user text. | Files are discovered and extracted. | Files under .agents and .claude are not analysed and the cclinic section is absent from the AGENTS.md content; an AGENTS.md with only the section is ignored. |
| TC-SKILL-020 | FR-SKILL-016 | e2e | A completed `cclinic --yes` run with the fake claude recording calls. | `cclinic --yes` is run again. | Zero new Claude calls are recorded and all Markdown files are byte-identical. |
| TC-SKILL-021 | FR-SKILL-017 | unit | The rendered text of all five skills. | It is searched for specific agent tool names and stack names. | No specific agent's tools or commands are named. |
| TC-SKILL-022 | FR-SKILL-018 | unit | Rendered create-spec and refine-spec text. | Content is checked. | It mentions three files per spec, permanent IDs, a VAL and a TC per requirement, evidence, statuses, open questions, and a warning about `cclinic --force`. |
| TC-SKILL-023 | FR-SKILL-019 | unit | Rendered write-code text. | Content is checked. | It requires reading stack, architecture, guidelines and nearby code, small changes and matching conventions, and contains no instruction to hide AI use. |
| TC-SKILL-024 | FR-SKILL-020 | unit | Rendered implement-spec text. | Content is checked. | It requires going in order, stopping on blocking open questions, writing tests from test cases, running real commands and never claiming unrun results. |
| TC-SKILL-025 | FR-SKILL-021 | unit | Rendered test-spec text. | Content is checked. | It requires mapping each test case to a test named with its TC ID or manual steps, running them, reporting defects with reproduction steps, and forbids weakening tests or changing production code. |
| TC-SKILL-030 | FR-SKILL-002, FR-SKILL-003, FR-SKILL-004 | manual | A real project with skills installed and real Claude Code, Codex, Cursor, Copilot and Gemini CLI. | Each agent is asked to list or use its skills. | All five skills are discovered in each agent; agents without skill support find them through AGENTS.md. |
| TC-SKILL-031 | FR-SKILL-018, FR-SKILL-019, FR-SKILL-020, FR-SKILL-021 | manual | A real project with skills installed and a real agent. | A feature is taken through create-spec, implement-spec and test-spec. | The spec follows the required format, code is consistent and small, every requirement has tests, and results are reported honestly. |
