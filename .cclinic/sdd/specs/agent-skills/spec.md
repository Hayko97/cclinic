# agent-skills

## Goal

Install six portable agent skills (create-spec, refine-spec, write-code, implement-spec, test-spec, devops) into .agents/skills and .claude/skills, plus a marked AGENTS.md section, without overwriting other people's or edited work and without affecting analysis.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-SKILL-001 | cclinic must provide exactly six skills named create-spec, refine-spec, write-code, implement-spec, test-spec and devops. The devops skill is specified in local-environment. | confirmed | `sdd/specs/agent-skills/spec.md:9-15`, `sdd/specs/agent-skills/verification.md:9`, `src/core/agent-skills.ts:57-281` |
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

## Non-goals

- Asking users which coding agent they use.
- Merging agent-edited specs on re-run (out of MVP scope).
- Calling Claude to produce skills; skills are generic and fixed.
- Hiding AI use; 'code like a human' means careful-maintainer style.
- Automatically verifying skill discovery in Codex, Cursor, Copilot and Gemini CLI.
