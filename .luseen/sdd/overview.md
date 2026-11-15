# Overview

## Purpose

luseen is a Node.js/TypeScript command-line tool that sets up spec-driven development (SDD) for an existing project. It scans the project's own code and documents (skipping dependencies, build output, binaries and secrets), redacts secrets, and uses Claude (Claude CLI by default, or the Anthropic API) to generate overview, stack, architecture, developer-guideline and per-capability spec documents (spec/validation/verification) into .luseen/sdd/. It also installs agent skills and AGENTS.md/CLAUDE.md workflow sections.

## Users

- Developers who want SDD documents for an existing project
- AI coding tools and agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI) that consume generated docs, skills and AGENTS.md
- Automation testers who use verification.md test cases
- Contributors to luseen itself

## Scope

- Scan, extract (text, code, PDF, DOCX), redact and chunk project content
- Summarise modules, combine and generate specs with an LLM, with caching and resume
- Validate and safely publish generated documents
- Install six agent skills and marked AGENTS.md/CLAUDE.md sections
- Create a local Git repo and use 14 days of history as context
- Model and reasoning selection, doctor, clean, guide commands

## Non-goals

- Other LLM providers including local models (Codex entries defined but not selectable)
- OCR for scanned PDFs and legacy .doc
- Changing target project code/tests or running generated tests
- Watch mode, GUI, web service, CI integrations
- Remote model list fetching, shell completions, self-update, per-project config
- Merging regenerated docs with hand edits
- Committing, pushing or creating remotes

## Glossary

| Term | Meaning |
|---|---|
| SDD | Spec-driven development |
| FR / VAL / TC | Requirement, validation (acceptance) and test case IDs of form FR-<AREA>-NNN, etc. |
| Provider | LLM backend: claude-cli or anthropic-api |
| Effort | Reasoning level: low, medium, high, xhigh, max |
| Skill | Agent Skills format SKILL.md installed under .agents/skills and .claude/skills |
| ADR | Architecture decision record in sdd/decisions |
| Manifest | manifest.json with run details and file hashes used to detect hand edits |
