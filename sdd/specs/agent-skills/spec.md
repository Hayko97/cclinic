# Agent skills

## Goal

Give each project a set of skills that its coding agent can use to create and refine specs, write code that fits the project, implement specs, and test them, whichever coding agent the team prefers.

## Skills

| Skill | Use it to |
|---|---|
| `create-spec` | Write a new spec folder for a new capability |
| `refine-spec` | Improve an existing spec, and resolve its open questions |
| `write-code` | Write code that fits the project's stack and guidelines, the way a careful maintainer would |
| `implement-spec` | Build a spec requirement by requirement, and prove that it works |
| `test-spec` | Act as QA: automate a spec's test cases, run them, and report defects |

## Where they're installed

| Location | Read by |
|---|---|
| `.agents/skills/<name>/SKILL.md` | Codex, Cursor, GitHub Copilot, Gemini CLI, and other tools using this shared folder |
| `.claude/skills/<name>/SKILL.md` | Claude Code |
| `AGENTS.md` (a marked section) | Agents that read `AGENTS.md`, including those without skill support, such as Aider, Zed and Windsurf |

These locations come from each tool's documentation on 2026-11-07. See [ADR 0003](../../decisions/0003-agent-skills.md).

## Requirements

### Format and location

- **FR-SKILL-001** cclinic MUST provide the five skills in the table above.
- **FR-SKILL-002** Each skill MUST follow the [Agent Skills format](https://agentskills.io/specification): a folder named after the skill, holding a `SKILL.md` with a `name` that matches the folder and uses only lowercase letters, numbers and single hyphens, up to 64 characters, and a `description` of up to 1024 characters stating what it does and when to use it. Each `SKILL.md` MUST stay under 500 lines.
- **FR-SKILL-003** Each skill MUST be installed, with identical content, in both `.agents/skills/` and `.claude/skills/` in the target folder.
- **FR-SKILL-004** cclinic MUST add a marked section to `AGENTS.md` in the target folder, listing the skills and where the project documents are, so that agents without skill support can still follow them. It MUST create the file if it's missing.

### Installing

- **FR-SKILL-005** A successful generation run MUST install the skills, unless `--no-skills` is set. A failure while installing MUST produce a warning, and MUST NOT fail a run whose documents were already saved.
- **FR-SKILL-006** `cclinic skills [path]` MUST install the skills without calling Claude or needing a provider. It MUST accept `--out`, `--force` and `--json`.
- **FR-SKILL-007** The result MUST report each location as installed, updated, unchanged, or skipped with the reason. `--dry-run` MUST NOT install anything.

### Protecting existing work

- **FR-SKILL-008** cclinic MUST mark each file it installs with `generated-by: cclinic` and a content hash in the frontmatter `metadata`. A skill with the same name that doesn't carry this mark MUST be left alone and reported, even with `--force`, because it's someone else's skill.
- **FR-SKILL-009** A cclinic skill whose content no longer matches its hash has been edited. It MUST be left alone and reported, unless `--force` is set. A file that's already up to date MUST NOT be rewritten.
- **FR-SKILL-010** Only the marked section of `AGENTS.md` may change. All other content MUST be preserved exactly. If the section has a start marker with no end marker, cclinic MUST leave the file alone and report it.

### Staying out of the analysis

- **FR-SKILL-011** `.agents` and `.claude` folders MUST be skipped by the scan as tool folders, so installed skills aren't analysed as project content.
- **FR-SKILL-012** The marked section MUST be removed from `AGENTS.md` before analysis and hashing, so installing the skills doesn't invalidate the cache or change the generated documents. An `AGENTS.md` holding only that section is cclinic's own file, so it MUST be left out of the scan.

### Skill content

- **FR-SKILL-013** Skills MUST work with any agent and stack. They MUST NOT name a specific agent's tools or commands, and MUST take stack details from the project's own documents, whose location MUST reflect `--out`.
- **FR-SKILL-014** `create-spec` and `refine-spec` MUST require the project's spec format: three files per spec, permanent IDs, at least one `VAL` and one `TC` per requirement, evidence, statuses, and recording unknowns as open questions. They MUST warn that re-running `cclinic --force` replaces hand-edited documents.
- **FR-SKILL-015** `write-code` MUST require reading the stack, architecture, guidelines and nearby code before writing, matching existing conventions, keeping changes small, and avoiding the common signs of careless generated code: restating comments, unused code, needless abstraction, defensive code for impossible cases, and unrequested features. It MUST NOT tell the agent to hide that AI was used.
- **FR-SKILL-016** `implement-spec` MUST require working through the spec's requirements in order, stopping on blocking open questions rather than guessing, writing tests from the spec's test cases, running the project's real commands, and reporting each requirement with its result. It MUST NOT let the agent claim something passes without having run it.
- **FR-SKILL-017** `test-spec` MUST require mapping every test case to an automated test named with its `TC` ID, or to written manual steps, then running them and reporting results and defects with reproduction steps. It MUST NOT let the agent weaken a test or change production code to make a test pass.

## Edge cases

- Cursor and Copilot also read `.claude/skills/`, so they may list a skill from both locations. The content is identical.
- A project that runs `cclinic skills` before generating documents gets the skills, and they tell the agent to ask for `cclinic` to be run when the documents are missing.
- A new cclinic version with changed skills updates unedited copies automatically on the next install.

## Non-goals

- Tool-specific formats such as `.cursorrules` or `CLAUDE.md`.
- User-wide skill folders. Skills are installed per project, so the team shares them through version control.
- A prompt to choose agents. Installing to the shared locations covers them without users having to know where each tool looks.
- Merging a user's edits into updated skills.
