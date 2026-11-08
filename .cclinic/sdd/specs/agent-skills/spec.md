# agent-skills

## Goal

Install eight portable agent skills (create-spec, refine-spec, write-code, implement-spec, test-spec, devops, product-engineer, review-doc) into .agents/skills and .claude/skills, plus a marked AGENTS.md section, without overwriting other people's or edited work and without affecting analysis.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-SKILL-001 | cclinic must provide exactly eight skills named create-spec, refine-spec, write-code, implement-spec, test-spec, devops, product-engineer and review-doc. The devops skill is specified in local-environment. | confirmed | `sdd/specs/agent-skills/spec.md:9-15`, `sdd/specs/agent-skills/verification.md:9`, `src/core/agent-skills.ts:57-281`, `user request` |
| FR-SKILL-002 | Each skill must follow the Agent Skills format: a folder named after the skill with SKILL.md whose frontmatter has a matching lowercase-hyphen name (max 64 chars) and a description of 1 to 1024 characters, and the file must be under 500 lines. | confirmed | `sdd/specs/agent-skills/spec.md:32`, `sdd/specs/agent-skills/verification.md:10` |
| FR-SKILL-003 | cclinic must install each skill with identical content to <target>/.agents/skills/<name>/SKILL.md and <target>/.claude/skills/<name>/SKILL.md. | confirmed | `sdd/specs/agent-skills/spec.md:19-23`, `sdd/specs/agent-skills/verification.md:11`, `src/adapters/storage/skill-installer.ts:79-103` |
| FR-SKILL-004 | cclinic must add a marked section to AGENTS.md listing the skills and the project document locations, creating the file if missing. | confirmed | `sdd/specs/agent-skills/spec.md:33-34`, `sdd/specs/agent-skills/verification.md:12`, `sdd/decisions/0003-agent-skills.md:26` |
| FR-SKILL-005 | Installed skill files must carry frontmatter metadata `generated-by: cclinic` and a content hash used to detect ownership and edits. | confirmed | `sdd/specs/agent-skills/spec.md:44-45`, `sdd/decisions/0003-agent-skills.md:27`, `sdd/specs/agent-skills/verification.md:21` |
| FR-SKILL-006 | A successful generation run must install the skills unless --no-skills is given, and --dry-run must create no skill folders or AGENTS.md. | confirmed | `sdd/specs/agent-skills/spec.md:38`, `sdd/specs/agent-skills/verification.md:13-14`, `sdd/specs/agent-skills/verification.md:19` |
| FR-SKILL-007 | A skill installation failure during a generation run must only produce a warning and must not fail a run whose documents were saved. | confirmed | `sdd/specs/agent-skills/spec.md:38`, `src/cli/generate-command.ts:451-459`, `sdd/specs/agent-skills/verification.md:15` |
| FR-SKILL-008 | `cclinic skills [path]` must install the skills without calling Claude and without needing the claude executable or an API key, and must accept --out, --force, --json and --dry-run, where --dry-run installs nothing. | confirmed | `sdd/specs/agent-skills/spec.md:39-40`, `sdd/specs/agent-skills/verification.md:16`, `src/cli/main.ts:153-163` |
| FR-SKILL-009 | The install result must report each location as installed, updated, unchanged or skipped with a reason, and --json must output each location with its status. | confirmed | `sdd/specs/agent-skills/spec.md:40`, `sdd/specs/agent-skills/verification.md:18` |
| FR-SKILL-010 | A same-named skill without the cclinic mark must never be modified, even with --force, and must be reported. | confirmed | `sdd/specs/agent-skills/spec.md:44`, `sdd/decisions/0003-agent-skills.md:28`, `sdd/specs/agent-skills/verification.md:20`, `src/adapters/storage/skill-installer.ts:45-66` |
| FR-SKILL-011 | A cclinic skill whose content no longer matches its hash must be left alone and reported unless --force is given. | confirmed | `sdd/specs/agent-skills/spec.md:45`, `sdd/specs/agent-skills/verification.md:22` |
| FR-SKILL-012 | Up-to-date skill files must not be rewritten, and older untouched cclinic copies whose hash is valid must be updated. | confirmed | `sdd/specs/agent-skills/spec.md:45`, `sdd/decisions/0003-agent-skills.md:27`, `sdd/specs/agent-skills/verification.md:23-24` |
| FR-SKILL-013 | Line endings (CRLF) in an installed skill file must not change whether it is classified as managed. | confirmed | `sdd/specs/agent-skills/verification.md:25`, `src/adapters/storage/skill-installer.ts:45-66` |
| FR-SKILL-014 | Only the marked AGENTS.md section may change; other content must be preserved exactly, and a start marker without an end marker must leave the file untouched and be reported. | confirmed | `sdd/specs/agent-skills/spec.md:46`, `sdd/specs/agent-skills/verification.md:26-28`, `src/core/agent-skills.ts:386-395` |
| FR-SKILL-015 | Scanning must skip the .agents and .claude folders, strip the marked AGENTS.md section before analysis and hashing, and ignore an AGENTS.md that contains only that section. | confirmed | `sdd/specs/agent-skills/spec.md:50-51`, `sdd/decisions/0003-agent-skills.md:29`, `src/adapters/extraction/extract.ts:144-147`, `sdd/specs/agent-skills/verification.md:29` |
| FR-SKILL-016 | Installing skills must not change generated documents or invalidate the analysis cache, so a second `cclinic --yes` run makes no Claude calls and leaves all Markdown unchanged. | confirmed | `sdd/specs/agent-skills/spec.md:51`, `sdd/specs/agent-skills/verification.md:30-31` |
| FR-SKILL-017 | Skills must be agent- and stack-agnostic and must refer to the project documents at the configured --out folder rather than the default .cclinic/sdd. | confirmed | `sdd/specs/agent-skills/spec.md:55`, `sdd/specs/agent-skills/verification.md:17`, `sdd/specs/agent-skills/verification.md:32` |
| FR-SKILL-018 | The create-spec and refine-spec skills must require the project's spec format (three files per spec, permanent IDs, at least one VAL and one TC per requirement, evidence, statuses, unknowns as open questions) and warn that `cclinic --force` replaces hand-edited documents. | confirmed | `sdd/specs/agent-skills/spec.md:56`, `sdd/specs/agent-skills/verification.md:33`, `sdd/decisions/0003-agent-skills.md:37` |
| FR-SKILL-019 | The write-code skill must require reading stack, architecture, guidelines and nearby code first, matching conventions and small changes, and must not tell the agent to hide AI use. | confirmed | `sdd/specs/agent-skills/spec.md:57`, `sdd/specs/agent-skills/verification.md:34`, `sdd/decisions/0003-agent-skills.md:33` |
| FR-SKILL-020 | The implement-spec skill must work through requirements in order, stop on blocking open questions, write tests from test cases, run real project commands and never claim a pass without running. | confirmed | `sdd/specs/agent-skills/spec.md:58`, `sdd/specs/agent-skills/verification.md:35` |
| FR-SKILL-021 | The test-spec skill must map every test case to an automated test named with its TC ID or to written manual steps, run them, report defects with reproduction steps, and not weaken tests or change production code to pass. | confirmed | `sdd/specs/agent-skills/spec.md:59`, `sdd/specs/agent-skills/verification.md:36` |
| FR-SKILL-022 | The implement-spec skill must, after verifying and before showing how to review it, hand the change to the `test-spec` skill (in a separate agent when the tool supports it), fix each code defect it reports with `write-code` and run QA again, return to the spec if it's wrong, and stop after 3 failing rounds to report the failures instead of asking for approval. | confirmed | `src/core/agent-skills.ts:197`, `src/core/agent-skills.test.ts:280`, `user request` |
| FR-SKILL-023 | The test-spec skill must classify each failure as code, test or spec wrong, and list the steps for each `manual` test case it didn't run, so they can be given to the user with the preview. | confirmed | `src/core/agent-skills.ts:246`, `src/core/agent-skills.ts:279-280`, `src/core/agent-skills.test.ts:290`, `user request` |
| FR-SKILL-024 | The implement-spec skill must fix a wrong test so it checks what the spec says, count every QA run toward the limit of 3 for a change and start the count again only after the user replies; and the test-spec skill, when run for the implementing agent on a change no spec covers, must run the project's full checks and report that no spec covers it instead of asking to create one. | confirmed | `src/core/agent-skills.ts:197`, `src/core/agent-skills.ts:234`, `src/core/agent-skills.test.ts:307-326`, `user request` |
| FR-SKILL-025 | The product-engineer skill must, before proposing any task, read the project overview, the specs list and the current roadmap (`cclinic tasks roadmap`), and ask the user focused questions, a few at a time, about the goal, who it's for, scope, constraints and what done looks like, until the work is clear. It must record anything the user can't answer as an open question rather than invent it. | confirmed | `src/core/agent-skills.ts:391`, `src/core/agent-skills.test.ts`, `user request` |
| FR-SKILL-026 | The product-engineer skill must propose milestones and tasks where each task is one deliverable change and names an existing spec or says a new spec is needed, show the proposal to the user, and save it with `cclinic tasks milestone add` and `cclinic tasks add` only after the user approves it. | confirmed | `src/core/agent-skills.ts:391`, `src/core/agent-skills.test.ts`, `user request` |
| FR-SKILL-027 | The product-engineer skill must not write or change production code, tests or specs, and must point the user to the lifecycle (refine-spec or create-spec) to start work on a task. | confirmed | `src/core/agent-skills.ts:391`, `src/core/agent-skills.test.ts`, `user request` |
| FR-SKILL-028 | The review-doc skill must read the spec's three files, the spec's uncommitted changes, and the code the changed requirements touch, and write one Markdown doc to `.cclinic/reviews/<spec-name>/review.md`, with its images in `.cclinic/reviews/<spec-name>/images/`, replacing any earlier review doc for that spec. | confirmed | `src/core/agent-skills.ts:446-482`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-SKILL-029 | The review doc must have these sections, in order: a plain-language summary; what changes in the spec, listing each added, changed or removed requirement with its ID; how it works now and after the change, with at least one Mermaid diagram of the behaviour after the change; how it looks, with images; how it will be tested, mapping each changed requirement to its test cases; and open questions and risks. | confirmed | `src/core/agent-skills.ts:446-482`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-SKILL-030 | For "how it looks", the review-doc skill must take real screenshots of the current behaviour when the local environment can start and the agent can capture them, or say in the doc why there's none; and must draw the behaviour after the change as mockup images (such as SVG of a screen, or of terminal output for a command-line tool), each with a caption that says it's a mockup and not built yet. | confirmed | `src/core/agent-skills.ts:446-482`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-SKILL-031 | The review-doc skill must not change production code, tests or the spec's files, and must end by giving the doc's path and asking the user to review it and choose `approve` or `refine` for the spec. | confirmed | `src/core/agent-skills.ts:446-482`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-SKILL-032 | The create-spec and refine-spec skills must end the review step by offering the user the three options `approve`, `refine` and `review-doc`, and saying that `review-doc` uses the `review-doc` skill. | confirmed | `src/core/agent-skills.ts:56-61`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-SKILL-033 | Files in `.cclinic/reviews/` must not be analysed, must not count as hand edits to the documents folder, and must not be removed by a cclinic run. | confirmed | `src/core/constants/discovery.ts:85`, `src/adapters/storage/document-store.ts:153-166`, `src/core/constants/paths.ts:10`, `test/e2e/skills.test.ts:127`, `user request` |

## Edge cases

- Target folder is read-only (POSIX only): documents still created, exit 0, warning shown.
- A same-named skill exists without the cclinic mark: left alone even with --force.
- A cclinic skill was edited by hand: kept and reported unless --force.
- Skill file with CRLF line endings is still recognised as managed.
- AGENTS.md has a start marker but no end marker: file untouched and reported.
- AGENTS.md already has user content: preserved exactly outside the marked section.
- AGENTS.md contains only the cclinic section: ignored during analysis.
- Custom --out folder: skills refer to that folder, not .cclinic/sdd.
- Second run after install: no Claude calls and no Markdown changes.
- Skills already up to date: not rewritten and reported unchanged.
- The user asks product-engineer for tasks but can't answer a question: it's recorded as an open question, not guessed.
- The user rejects the proposed tasks: nothing is saved.
- The local environment can't start, or the agent can't take screenshots: the review doc says so and still has the mockups and diagrams.
- A review doc already exists for the spec: it and its images are replaced, not added to.
- The change has no visible output, such as an internal rule: "how it looks" shows example input and output, or says there's nothing visible, and the diagrams carry the explanation.

## Non-goals

- Asking users which coding agent they use.
- Merging agent-edited specs on re-run (out of MVP scope).
- Calling Claude to produce skills; skills are generic and fixed.
- Hiding AI use; 'code like a human' means careful-maintainer style.
- Automatically verifying skill discovery in Codex, Cursor, Copilot and Gemini CLI.
- cclinic rendering review docs, Mermaid or images itself; the agent writes them.
