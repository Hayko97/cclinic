# agent-instructions

## Goal

Install marked AGENTS.md and CLAUDE.md sections into a target project so coding agents follow a spec-first lifecycle (prompt, spec approval, implementation approval, optional commit), without disturbing the user's own instructions or triggering reprocessing by cclinic.

Stage 3 also requires showing a preview before asking for approval. See FR-ENV-027 in [local-environment](../local-environment/spec.md).

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

## Non-goals

- Enforcing the workflow technically (hooks, CI checks); it is guidance only.
- Configuring Gemini CLI or Aider to read AGENTS.md.
- cclinic committing or pushing changes.
- Installing or editing the skills themselves (covered by agent-skills).
- Skill and docs generation (covered by spec-analysis and spec-output).
