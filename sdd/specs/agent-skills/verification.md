# Agent skills: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** use a temp target folder for each test. Skill content can only be fully judged by using it, so `manual` cases run a real agent on a real project.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-SKILL-001 | FR-SKILL-001 | unit | The built-in skill list | Read the names | They are `create-spec`, `refine-spec`, `write-code`, `implement-spec` and `test-spec` |
| TC-SKILL-002 | FR-SKILL-002 | unit | Each rendered skill | Check its frontmatter and size | The name matches the format and limits, the description is 1 to 1024 characters, and the file has fewer than 500 lines |
| TC-SKILL-003 | FR-SKILL-003 | integration | An empty target | Install | Each skill is in both folders, in a folder of its own name, with identical content |
| TC-SKILL-004 | FR-SKILL-004 | integration | No `AGENTS.md` | Install | The file is created, and lists all five skills and the documents folder |
| TC-SKILL-005 | FR-SKILL-005 | e2e | A project and the fake `claude` | Run `cclinic --yes` | Documents and skills both exist, and the result reports the skills |
| TC-SKILL-006 | FR-SKILL-005 | e2e | A project and the fake `claude` | Run `cclinic --yes --no-skills` | Documents exist, and no skill folders or `AGENTS.md` are created |
| TC-SKILL-007 | FR-SKILL-005 | e2e | A read-only `.agents` folder (POSIX only) | Run `cclinic --yes` | Exit code is 0, the documents exist, and a warning names the problem |
| TC-SKILL-008 | FR-SKILL-006 | e2e | No `claude` and no key | Run `cclinic skills <path>` | Exit code is 0, and the skills are installed |
| TC-SKILL-009 | FR-SKILL-006, FR-SKILL-013 | e2e | `--out docs/sdd` | Run `cclinic skills <path> --out docs/sdd` | Skills refer to `docs/sdd`, and not to `.cclinic/sdd` |
| TC-SKILL-010 | FR-SKILL-007 | e2e | Empty target, then a second run, then `--json` | Run `cclinic skills` each time | The first reports installed, the second unchanged, and the JSON lists each location with its status |
| TC-SKILL-011 | FR-SKILL-007 | e2e | A project | Run `cclinic --dry-run` | No skill folders or `AGENTS.md` are created |
| TC-SKILL-012 | FR-SKILL-008 | integration | A user's own `.agents/skills/write-code/SKILL.md` | Install, then install with `--force` | The file is unchanged both times, and is reported as someone else's |
| TC-SKILL-013 | FR-SKILL-008 | unit | A rendered skill | Read its frontmatter | It has `generated-by: cclinic` and a content hash, and classifies as managed |
| TC-SKILL-014 | FR-SKILL-009 | integration | An installed skill that's then edited | Install, then install with `--force` | The first leaves it and reports the edit. The second replaces it |
| TC-SKILL-015 | FR-SKILL-009 | integration | An installed skill, with its modified time recorded | Install again | The file isn't rewritten |
| TC-SKILL-016 | FR-SKILL-009 | integration | An older unedited copy, with a valid hash but different content | Install | It's updated |
| TC-SKILL-017 | FR-SKILL-009 | unit | A managed file with Windows line endings | Classify it | It's still managed |
| TC-SKILL-018 | FR-SKILL-010 | unit | An `AGENTS.md` with content before and after the section | Merge a new section | Only the section changes |
| TC-SKILL-019 | FR-SKILL-010 | integration | An existing `AGENTS.md` with no section | Install | The original text is unchanged, and the section follows it |
| TC-SKILL-020 | FR-SKILL-010 | integration | A start marker with no end marker | Install | The file is unchanged, and it's reported |
| TC-SKILL-021 | FR-SKILL-011, FR-SKILL-012 | integration | Project code plus `.agents` and `.claude` folders, and an `AGENTS.md` holding only cclinic's section | Scan | Only the project code is included, and both folders are recorded as tool folders |
| TC-SKILL-022 | FR-SKILL-012 | unit | An `AGENTS.md` with user text and a section | Strip the section | Only the user's text remains |
| TC-SKILL-023 | FR-SKILL-012 | e2e | A project with its own `AGENTS.md`, and one without | Run `cclinic --yes` twice on each, recording calls | The second run makes no Claude calls, and every Markdown file, including `scan-report.md`, is unchanged |
| TC-SKILL-024 | FR-SKILL-013 | unit | Each rendered skill | Search for agent and stack names | None name a specific agent's tools or commands, or a specific language |
| TC-SKILL-025 | FR-SKILL-014 | unit | `create-spec` and `refine-spec` | Search for the required rules | Both cover the three files, permanent IDs, coverage, evidence, statuses, open questions, and the `--force` warning |
| TC-SKILL-026 | FR-SKILL-015 | unit | `write-code` | Search for the required rules | It requires reading the documents and nearby code, covers each listed sign, and doesn't tell the agent to hide AI use |
| TC-SKILL-027 | FR-SKILL-016 | unit | `implement-spec` | Search for the required rules | It covers order, stopping on open questions, tests from `TC`s, real commands, and honest reporting |
| TC-SKILL-028 | FR-SKILL-017 | unit | `test-spec` | Search for the required rules | It covers `TC` naming, manual steps, defects with reproduction steps, and not weakening tests or changing production code |
| TC-SKILL-029 | FR-SKILL-003 | manual | A real Claude Code session in a project with the skills | Check the skills it lists | All five are listed |
| TC-SKILL-030 | FR-SKILL-003 | manual | Real Codex, Cursor, Copilot and Gemini CLI sessions | Check the skills each one lists | All five are found in `.agents/skills` |
| TC-SKILL-031 | FR-SKILL-014, FR-SKILL-015, FR-SKILL-016, FR-SKILL-017 | manual | A real project and a real agent | Create, refine, implement and test one small feature using the skills | The spec, code, tests and report meet the validation criteria |
