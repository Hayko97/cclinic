# agent-instructions

## Goal

Install marked AGENTS.md and CLAUDE.md sections into a target project so coding agents follow a spec-first lifecycle (open-task check, prompt, spec approval with an optional visual review doc, implementation approval, optional commit), without disturbing the user's own instructions or triggering reprocessing by cclinic.

Stage 3 also requires a QA pass against the spec's test cases and acceptance criteria, fixing and re-testing until it passes, then a code review against the project's coding guidelines (see [code-review](../code-review/spec.md)), then a preview for the user to test by hand before asking for approval. For the preview, see FR-ENV-027 in [local-environment](../local-environment/spec.md).

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-INSTR-001 | cclinic must install into AGENTS.md of the target folder a marked section holding the full spec-driven workflow followed by the skills table, and must create AGENTS.md if it is missing. | confirmed | `sdd/specs/agent-instructions/spec.md:58`, `sdd/specs/agent-instructions/spec.md:11`, `sdd/specs/agent-instructions/verification.md:9`, `src/core/agent-skills.ts:295-395` |
| FR-INSTR-002 | The installed workflow text must refer to the documents folder given by --out (specs in <out>/specs/, index <out>/README.md) instead of a fixed path. | confirmed | `sdd/specs/agent-instructions/spec.md:27`, `sdd/specs/agent-instructions/spec.md:32`, `sdd/specs/agent-instructions/verification.md:10` |
| FR-INSTR-003 | cclinic must install into CLAUDE.md a marked section that imports @AGENTS.md and contains no copy of the workflow text, and must create CLAUDE.md if it is missing. | confirmed | `sdd/specs/agent-instructions/spec.md:59`, `sdd/specs/agent-instructions/spec.md:12`, `sdd/specs/agent-instructions/verification.md:11`, `sdd/decisions/0005-agent-instructions.md:14-15` |
| FR-INSTR-004 | cclinic must install and report both instruction files after a successful generation run and when running `cclinic skills`. | confirmed | `sdd/specs/agent-instructions/spec.md:60`, `sdd/specs/agent-instructions/verification.md:12`, `src/adapters/storage/skill-installer.ts:79-103` |
| FR-INSTR-005 | cclinic must not create or change AGENTS.md or CLAUDE.md when --no-skills or --dry-run is given. | confirmed | `sdd/specs/agent-instructions/spec.md:60`, `sdd/specs/agent-instructions/verification.md:12` |
| FR-INSTR-006 | Installing the instruction files via `cclinic skills` must succeed with exit code 0 when no Claude CLI and no API key are available. | confirmed | `sdd/specs/agent-instructions/verification.md:13`, `src/adapters/storage/skill-installer.ts:79-103` |
| FR-INSTR-007 | When AGENTS.md or CLAUDE.md already exists, cclinic must change only the marked section and preserve all other content byte for byte; if CLAUDE.md has no marked section, one must be appended. | confirmed | `sdd/specs/agent-instructions/spec.md:65-66`, `sdd/specs/agent-instructions/verification.md:15`, `sdd/specs/agent-instructions/verification.md:16` |
| FR-INSTR-008 | cclinic must not rewrite a file whose marked section is already up to date and must report it as unchanged. | confirmed | `sdd/specs/agent-instructions/spec.md:65-66`, `sdd/specs/agent-instructions/verification.md:18` |
| FR-INSTR-009 | If a file has a start marker without a matching end marker, cclinic must leave that file unchanged and report it, while still installing the other file. | confirmed | `sdd/specs/agent-instructions/spec.md:65-66`, `sdd/specs/agent-instructions/verification.md:17`, `src/core/agent-skills.ts:386-395` |
| FR-INSTR-010 | The installed workflow section and its imported content must stay under 200 lines. | confirmed | `sdd/specs/agent-instructions/spec.md:61`, `sdd/specs/agent-instructions/verification.md:14` |
| FR-INSTR-011 | Before analysis and content hashing, cclinic must strip the marked section from the root CLAUDE.md, so installing it does not look like a project change. | confirmed | `sdd/specs/agent-instructions/spec.md:70`, `src/adapters/extraction/extract.ts:144-147`, `sdd/specs/agent-instructions/verification.md:19` |
| FR-INSTR-012 | A CLAUDE.md that contains only the installed section must be left out of the scan without a skipped-file entry. | confirmed | `sdd/specs/agent-instructions/spec.md:70`, `sdd/specs/agent-instructions/verification.md:20` |
| FR-INSTR-013 | Commits that touch only CLAUDE.md must be left out of the Git history used as context, so a re-run after committing the instruction files makes no Claude calls and changes no Markdown. | confirmed | `sdd/specs/agent-instructions/spec.md:70`, `sdd/specs/agent-instructions/verification.md:21`, `sdd/specs/agent-instructions/verification.md:22` |
| FR-INSTR-014 | The workflow must tell agents to apply the lifecycle only to code changes, answer questions, explanations and reviews directly without spec work, and name the spec a change belongs to, asking the user when unclear. | confirmed | `sdd/specs/agent-instructions/spec.md:76-77`, `sdd/specs/agent-instructions/validation.md:10`, `sdd/specs/agent-instructions/validation.md:11` |
| FR-INSTR-015 | The workflow must tell agents to use refine-spec or create-spec for new features, and refine-spec with a reproducing test case and corrected requirements for bugs, and to make no production code change until the user clearly approves the spec; a rejection must lead to refining and asking again. | confirmed | `sdd/specs/agent-instructions/spec.md:78`, `sdd/specs/agent-instructions/spec.md:79`, `sdd/specs/agent-instructions/spec.md:88` |
| FR-INSTR-016 | The workflow must tell agents to implement with implement-spec and write-code, return to the spec stage if the spec proves wrong, report real test results, and get the user's approval of the implementation before asking to commit. | confirmed | `sdd/specs/agent-instructions/spec.md:80-81`, `sdd/specs/agent-instructions/spec.md:88`, `sdd/specs/agent-instructions/validation.md:13` |
| FR-INSTR-017 | The workflow must tell agents that non-behaviour changes (refactor, formatting, typo, dependency update) skip spec update and spec review but still name the spec, follow write-code, and go through implementation review and the commit question. | confirmed | `sdd/specs/agent-instructions/spec.md:82`, `sdd/specs/agent-instructions/verification.md:33` |
| FR-INSTR-018 | The workflow must tell agents to skip a step when the user says so and state which step was skipped, to ask the user to run cclinic when the docs folder is missing, and to stop at spec review in unattended runs without treating silence as approval. | confirmed | `sdd/specs/agent-instructions/spec.md:83-84`, `sdd/decisions/0005-agent-instructions.md:23`, `sdd/decisions/0005-agent-instructions.md:24`, `sdd/specs/agent-instructions/verification.md:34`, `sdd/specs/agent-instructions/verification.md:35` |
| FR-INSTR-019 | The workflow must tell agents to commit only if the user agrees (approval of a spec or implementation is not agreement), to put spec, code and tests in one commit that follows project conventions, references requirement IDs, stages only related files and excludes secrets, to state failing or unrun tests first, and never to push unless asked. | confirmed | `sdd/specs/agent-instructions/spec.md:92-94`, `sdd/decisions/0005-agent-instructions.md:20-22`, `sdd/specs/agent-instructions/verification.md:40`, `sdd/specs/agent-instructions/verification.md:41` |
| FR-INSTR-020 | cclinic itself must never commit or push; only the coding agent may commit, at the user's request. | confirmed | `sdd/specs/agent-instructions/spec.md:108`, `sdd/specs/agent-instructions/spec.md:102` |
| FR-INSTR-021 | After implementing and before showing a preview, the workflow must tell agents to test the change with the `test-spec` skill against the spec's `verification.md` and `validation.md`, including changes with no spec update. When the agent's tool can run a separate agent or session, QA must run there, so the agent that wrote the code isn't the one checking it. | confirmed | `src/core/agent-skills.ts:451`, `src/core/agent-skills.test.ts:255`, `user request` |
| FR-INSTR-022 | When QA reports a failed test case or an unmet acceptance criterion, the workflow must tell agents to decide whether the code, the test or the spec is wrong; to fix wrong code with the `write-code` skill and send it back to QA; to go back to stage 2 if the spec is wrong; and never to weaken a test to pass. | confirmed | `src/core/agent-skills.ts:452`, `src/core/agent-skills.test.ts:255`, `user request` |
| FR-INSTR-023 | The workflow must tell agents to stop the fix loop after 3 rounds of QA that still fail, and report the remaining failures to the user, with a preview if one can start, instead of asking for approval. | confirmed | `src/core/agent-skills.ts:452`, `src/core/agent-skills.test.ts:255`, `user request` |
| FR-INSTR-024 | Only after QA passes must the workflow tell agents to show the preview and ask the user to test it by hand, giving the steps for each `manual` test case QA didn't run, and then to approve or request changes. A requested change must go through QA again before the next preview. | confirmed | `src/core/agent-skills.ts:454-455`, `src/core/agent-skills.test.ts:255`, `user request` |
| FR-INSTR-025 | The workflow must tell agents that a QA run started by the implementing agent follows only the `test-spec` skill, and doesn't start the lifecycle, change the spec or stop at stage 2. | confirmed | `src/core/agent-skills.ts:451`, `src/core/agent-skills.test.ts:281`, QA report DEF-1, `user request` |
| FR-INSTR-026 | When QA finds a test that doesn't check what the spec says, the workflow must tell agents to fix the test with the `write-code` skill so it matches the spec, without weakening it, and send it back to QA. | confirmed | `src/core/agent-skills.ts:452`, `src/core/agent-skills.test.ts:287`, `user request` |
| FR-INSTR-027 | The 3-run QA limit must count every QA run for a change, whatever was fixed between runs, and must start again only after the user replies, such as approving a spec change or requesting a change. | confirmed | `src/core/agent-skills.ts:452`, `src/core/agent-skills.test.ts:287`, `user request` |
| FR-INSTR-028 | When no spec covers a change, such as some refactors, the workflow must tell agents that QA runs the project's full checks and reports that no spec covers the change, without asking to create a spec. | confirmed | `src/core/agent-skills.ts:451`, `src/core/agent-skills.test.ts:302`, `user request` |
| FR-INSTR-029 | The workflow must tell agents, on every prompt and before stage 1, to run `cclinic tasks list --json`. If it lists open or in-progress tasks and the prompt isn't about one of them, the agent must list them (ID, title, status, spec) and wait for the user to choose: work on one of them, remove it with `cclinic tasks remove` and continue with the prompt, or keep it and continue with the prompt. | confirmed | `src/core/agent-skills.ts:489`, `src/core/agent-skills.test.ts`, `user request` |
| FR-INSTR-030 | After the user chooses to keep the listed tasks, the workflow must tell agents not to ask about those same tasks again in that conversation, and to ask again only when a new task appears. If `cclinic tasks list` fails or isn't available, the agent must say so in one line and continue with the prompt. | confirmed | `src/core/agent-skills.ts:489`, `src/core/agent-skills.test.ts`, `user request` |
| FR-INSTR-031 | The workflow must tell agents, at stage 1, that when the user wants to plan, build a roadmap or decide what to build, they may discuss it using the `product-engineer` skill, but must not create roadmaps, milestones or roadmap tasks themselves, and must tell the user to run `cclinic plan`, where the PM agent creates the roadmap, or `cclinic plan --task` for one concrete task. They must not start spec or code work. | confirmed | `src/core/agent-skills.ts`, `src/core/agent-skills.test.ts`, `src/core/agent-skills.ts:491`, `src/core/agent-skills.test.ts`, `user request` |
| FR-INSTR-032 | The workflow must tell agents, when work starts on a task, to run `cclinic tasks start <id>` and take the task's spec into stage 1, and, once the user approves the implementation, to run `cclinic tasks done <id>`. | confirmed | `src/core/agent-skills.ts:491`, `src/core/agent-skills.ts:507`, `src/core/agent-skills.test.ts`, `user request` |
| FR-INSTR-033 | At the end of stage 2, the workflow must tell agents to offer the user exactly three options, `approve`, `refine` and `review-doc`, and stop until the user chooses one: `approve` goes to stage 3; `refine` refines the spec with the user's changes and asks again; `review-doc` builds a visual review doc. | confirmed | `src/core/agent-skills.ts:543-548`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-INSTR-034 | When the user chooses `review-doc`, the workflow must tell agents to use the `review-doc` skill, give the user the path to the doc, ask them to review it, and then offer two options, `approve` or `refine`, without changing production code. Choosing `review-doc` must not count as approval. If they choose `refine`, the refined spec's review must end with the three options again. | confirmed | `src/core/agent-skills.ts:546-548`, `src/core/agent-skills.test.ts:431`, `user request` |
| FR-INSTR-035 | At stage 4, the workflow must tell agents not to stage review docs in `.cclinic/reviews/` unless the user asks for them to be committed. | confirmed | `src/core/agent-skills.ts:557`, `src/core/agent-skills.test.ts:431`, `user request` |

## Edge cases

- AGENTS.md or CLAUDE.md does not exist yet: it is created containing only the marked section.
- A file has a start marker with no end marker: file untouched, reported, the other file still installed.
- CLAUDE.md has user content but no marked section: section is appended, user content untouched.
- Re-install with a different --out: only the marked sections change.
- Repeat install with nothing to change: no file is rewritten; reported as unchanged.
- CLAUDE.md contains only the cclinic section: it is not scanned and not listed as skipped.
- A commit touches only CLAUDE.md: it does not appear in the history context.
- No claude executable and no API key: install still exits 0.
- --no-skills or --dry-run: neither file is touched.
- Docs folder missing when an agent follows the workflow: agent asks the user to run cclinic.
- Unattended agent run: agent stops at spec review; no code changes.
- Failing or unrun tests before commit question: stated first.
- Remote exists: still no push.
- QA still fails after 3 fix rounds: agent stops and reports the failures; it doesn't ask for approval.
- The failure is in the spec, not the code: agent goes back to stage 2.
- The agent's tool can't run a separate agent: QA runs in the same session.
- Every test case is automated: the user still gets the preview to try.
- QA alternates between a code fix and a test fix: every run counts, so it still stops after the 3rd run.
- The agent returns to stage 2 and the user doesn't reply: no new QA runs start.
- A refactor matches no spec: QA runs the full checks and says no spec covers it.
- The prompt is about an open task: the agent works on it without asking first.
- The user keeps the open tasks: they aren't raised again in that conversation unless a new task appears.
- cclinic isn't installed where the agent runs: the agent says the task check couldn't run, and continues.
- No open tasks: the agent goes straight to stage 1 without mentioning tasks.
- After a review doc, the user chooses `refine`: the spec is refined, and the next review offers all three options, so a new doc can be made that replaces the old one.
- The user replies with something other than the three options, such as a question: the agent answers it and offers the options again; it doesn't treat the reply as approval.
- Unattended run: the agent stops at the three options and doesn't create a review doc on its own.

## Non-goals

- Enforcing the workflow technically (hooks, CI checks); it is guidance only.
- Configuring Gemini CLI or Aider to read AGENTS.md.
- cclinic committing or pushing changes.
- Installing or editing the skills themselves (covered by agent-skills).
- Skill and docs generation (covered by spec-analysis and spec-output).
