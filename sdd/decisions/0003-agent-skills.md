# ADR 0003: How cclinic installs agent skills

**Status:** Accepted
**Date:** 2026-11-07

## Context

cclinic must give each project skills that work with whichever coding agent the team prefers. Each tool looks in its own places, so we checked their documentation.

| Tool | Project skill locations, per its docs |
|---|---|
| Codex | `.agents/skills` |
| Cursor | `.agents/skills`, `.cursor/skills`, and for compatibility `.claude/skills` and `.codex/skills` |
| GitHub Copilot | `.github/skills`, `.claude/skills`, `.agents/skills` |
| Gemini CLI | `.gemini/skills`, and `.agents/skills` as an alias |
| Claude Code | `.claude/skills`. Its docs don't mention `.agents/skills` |

Many tools also read `AGENTS.md`, including some with no documented skill support here, such as Aider, Zed and Windsurf.

## Decision

| Decision | Reason |
|---|---|
| Use the open Agent Skills format | One format is supported across these tools |
| Install to `.agents/skills` and `.claude/skills` | Together these cover all five tools above, with no need to ask users which they use |
| Add a marked section to `AGENTS.md` | It reaches agents without skill support. Markers let cclinic update its part and leave everything else alone |
| Mark installed files with a content hash in `metadata` | It separates untouched copies, which can be updated, from edited copies and other people's skills, which must not be touched. It needs no extra state file, and works after a fresh clone |
| Never overwrite a skill cclinic didn't create, even with `--force` | `--force` means replacing cclinic's own output |
| Skip `.agents` and `.claude` in the scan, and remove the marked section before hashing `AGENTS.md` | Otherwise installing skills would change the analysis and invalidate the cache |
| Keep skills generic, and have them read the project's documents | One set of skills adapts to any stack, and needs no Claude call to install |
| Keep unprefixed names, such as `write-code` | They read well in agent menus. Name clashes are safe, because other skills are never overwritten |

"Code like a human" means writing the way a careful maintainer of that project would: matching its conventions, in small changes, without the noise generated code often has. It doesn't mean hiding that AI was used.

## Consequences

- **Agent-edited specs and `cclinic --force` conflict.** The skills edit documents in `.cclinic/sdd/`, which cclinic treats as hand edits. A re-run refuses to continue, and `--force` replaces everything, because merging is out of MVP scope. The skills warn about this. This is the main limitation to resolve after the MVP.
- Cursor and Copilot may list a skill twice, because they read both folders.
- Only Claude Code's discovery was tested directly. The others rely on their docs, and need a manual check (`TC-SKILL-030`).
- Tool locations can change, so recheck them on each release.

## Sources

- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Codex skills](https://developers.openai.com/codex/skills)
- [Cursor skills](https://cursor.com/docs/skills)
- [GitHub Copilot agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Gemini CLI skills](https://geminicli.com/docs/cli/skills/)
- [AGENTS.md](https://agents.md/)
- [Ox Security analysis of AI code anti-patterns, as reported by DevOps.com](https://devops.com/analysis-identifies-10-ai-coding-tool-behaviors-that-ignore-best-software-engineering-practices/)
