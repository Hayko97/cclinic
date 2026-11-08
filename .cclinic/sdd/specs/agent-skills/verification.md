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
| TC-SKILL-001 | FR-SKILL-001 | unit | The built-in skill catalogue. | The skill names are listed. | The list is exactly create-spec, refine-spec, write-code, implement-spec, test-spec, devops, product-engineer, review-doc. |
| TC-SKILL-002 | FR-SKILL-002 | unit | Each rendered skill. | Frontmatter and length are checked. | name equals the folder name and matches lowercase letters, digits and single hyphens up to 64 chars; description is 1-1024 chars; file has under 500 lines. |
| TC-SKILL-003 | FR-SKILL-003, FR-SKILL-005 | integration | An empty temporary target folder. | Skills are installed. | .agents/skills/<name>/SKILL.md and .claude/skills/<name>/SKILL.md exist for all seven skills with identical content including generated-by: cclinic and a hash. |
| TC-SKILL-004 | FR-SKILL-004 | integration | A target without AGENTS.md. | Skills are installed. | AGENTS.md is created with start and end markers listing the seven skills and the documents folder. |
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
| TC-SKILL-021 | FR-SKILL-017 | unit | The rendered text of all eight skills. | It is searched for specific agent tool names and stack names. | No specific agent's tools or commands are named. |
| TC-SKILL-022 | FR-SKILL-018 | unit | Rendered create-spec and refine-spec text. | Content is checked. | It mentions three files per spec, permanent IDs, a VAL and a TC per requirement, evidence, statuses, open questions, and a warning about `cclinic --force`. |
| TC-SKILL-023 | FR-SKILL-019 | unit | Rendered write-code text. | Content is checked. | It requires reading stack, architecture, guidelines and nearby code, small changes and matching conventions, and contains no instruction to hide AI use. |
| TC-SKILL-024 | FR-SKILL-020 | unit | Rendered implement-spec text. | Content is checked. | It requires going in order, stopping on blocking open questions, writing tests from test cases, running real commands and never claiming unrun results. |
| TC-SKILL-025 | FR-SKILL-021 | unit | Rendered test-spec text. | Content is checked. | It requires mapping each test case to a test named with its TC ID or manual steps, running them, reporting defects with reproduction steps, and forbids weakening tests or changing production code. |
| TC-SKILL-030 | FR-SKILL-002, FR-SKILL-003, FR-SKILL-004 | manual | A real project with skills installed and real Claude Code, Codex, Cursor, Copilot and Gemini CLI. | Each agent is asked to list or use its skills. | All eight skills are discovered in each agent; agents without skill support find them through AGENTS.md. |
| TC-SKILL-031 | FR-SKILL-018, FR-SKILL-019, FR-SKILL-020, FR-SKILL-021 | manual | A real project with skills installed and a real agent. | A feature is taken through create-spec, implement-spec and test-spec. | The spec follows the required format, code is consistent and small, every requirement has tests, and results are reported honestly. |
| TC-SKILL-032 | FR-SKILL-022 | unit | Rendered implement-spec text. | Content is checked. | A step after verification and before showing how to review it uses `test-spec`, mentions a separate agent, fixes defects with `write-code`, re-runs QA, returns to the spec if it's wrong, and stops after 3 failing rounds. |
| TC-SKILL-033 | FR-SKILL-023 | unit | Rendered test-spec text. | Content is checked. | It requires classifying each failure as code, test or spec, and listing steps for each manual test case not run. |
| TC-SKILL-034 | FR-SKILL-024 | unit | Rendered implement-spec text. | Step "Hand it to QA" is read. | It says to fix a wrong test so it checks what the spec says, that QA runs at most 3 times per change counting every run, and that the count starts again only after the user replies. |
| TC-SKILL-035 | FR-SKILL-024 | unit | Rendered test-spec text. | Step 1 is read. | It says that when running QA for the implementing agent with no spec, QA runs the project's full checks and reports that no spec covers it; the question about create-spec applies only otherwise. |
| TC-SKILL-036 | FR-SKILL-025 | unit | Rendered product-engineer text. | Content is checked. | It passes the format checks, says to read the overview, the specs list and `cclinic tasks roadmap` first, to ask questions about goal, users, scope, constraints and done before proposing, and to record unanswered ones as open questions. |
| TC-SKILL-037 | FR-SKILL-026 | unit | Rendered product-engineer text. | Content is checked. | It says each task names an existing spec or a new one, to show the proposal, and to run `cclinic tasks milestone add` and `cclinic tasks add` only after approval. |
| TC-SKILL-038 | FR-SKILL-027 | unit | Rendered product-engineer text. | Content is checked. | It forbids changing code, tests or specs, and points to refine-spec or create-spec to start a task. |
| TC-SKILL-039 | FR-SKILL-025, FR-SKILL-026, FR-SKILL-027 | manual | A real project with skills installed and a real agent. | Ask "help me plan what to build next", answer its questions, then reject its first proposal and approve the second. | It asks questions before proposing, saves nothing after the rejection, saves the approved milestones and tasks (`cclinic tasks roadmap` shows them), and changes no code or spec. |
| TC-SKILL-040 | FR-SKILL-001, FR-SKILL-002 | unit | The skill list. | It is read. | It has exactly eight skills, including `review-doc`, and review-doc passes the format checks (name, description length, under 500 lines). |
| TC-SKILL-041 | FR-SKILL-028 | unit | Rendered review-doc text. | Content is checked. | It says to read the spec's three files, its uncommitted changes and the related code, to write `.cclinic/reviews/<spec-name>/review.md` with images in `images/`, and to replace an earlier doc for that spec. |
| TC-SKILL-042 | FR-SKILL-029 | unit | Rendered review-doc text. | Content is checked. | It lists the six sections in order (summary, spec changes with IDs, now and after with a Mermaid diagram, how it looks, how it will be tested, open questions and risks). |
| TC-SKILL-043 | FR-SKILL-030 | unit | Rendered review-doc text. | Content is checked. | It says to take real screenshots of current behaviour when the environment can start, or say why not, and to label every after image as a mockup that isn't built yet. |
| TC-SKILL-044 | FR-SKILL-031 | unit | Rendered review-doc text. | Content is checked. | It forbids changing production code, tests and spec files, and ends by giving the doc path and asking the user to review it and choose `approve` or `refine`. |
| TC-SKILL-045 | FR-SKILL-032 | unit | Rendered create-spec and refine-spec text. | The review step is read. | Each offers `approve`, `refine` and `review-doc`, and names the `review-doc` skill. |
| TC-SKILL-046 | FR-SKILL-033 | integration | A generated project with `.cclinic/reviews/demo/review.md` and `.cclinic/reviews/demo/images/after.svg`; fake claude records calls. | Run `cclinic <folder> --yes` again. | Zero new Claude calls, no hand-edit error, the review files aren't in the analysed files and still exist byte-identical. |
| TC-SKILL-047 | FR-SKILL-028, FR-SKILL-029, FR-SKILL-030, FR-SKILL-031 | manual | A real web or CLI project with skills installed and a working local environment; a spec change awaiting review. | Choose `review-doc`. | `.cclinic/reviews/<spec>/review.md` exists with the six sections, at least one Mermaid diagram that renders, at least one real screenshot of today and one labelled mockup; `git status` shows no code, test or spec change from this step; the agent asks to approve or refine the spec. |
| TC-SKILL-048 | FR-SKILL-030 | manual | Same as TC-SKILL-047, but with the local environment stopped and unable to start. | Choose `review-doc`. | The doc says why there's no real screenshot and still has mockups and diagrams. |
