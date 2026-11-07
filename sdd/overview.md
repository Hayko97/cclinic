# Overview

## Purpose

`cclinic` sets up spec-driven development (SDD) for an existing project. Run on a folder, it reads the project's own code and documents, skips third-party and binary files, and uses Claude to generate project documentation and specifications that AI coding tools and testers can follow.

## Users

- **Developers and teams** bringing AI coding tools into an existing codebase, on any technology stack.
- **AI coding tools**, which read the generated documents as their source of truth.
- **Automation testers**, who use each spec's `verification.md` to write automated tests.

The target project can be in any language. Users need Node.js to run cclinic, but no knowledge of Claude model names or settings.

## Typical use

```
cd my-project
cclinic
```

cclinic scans the folder, shows what it's about to send to Claude, asks for confirmation, then writes everything to `.cclinic/sdd/`.

## What cclinic generates

```
.cclinic/sdd/
  README.md                 how AI tools should use these documents
  overview.md               the project's purpose and scope
  stack.md                  detected languages, frameworks and tools
  architecture.md           detected structure and data flow
  developer-guidelines.md   best practices, tailored to the detected stack
  open-questions.md         conflicts and unknowns
  scan-report.md            what was analysed and skipped
  manifest.json             run details and file hashes
  specs/
    <spec-name>/
      spec.md               requirements
      validation.md         acceptance criteria
      verification.md       test cases for automation testers
```

This matches the layout of cclinic's own documentation in this `sdd/` folder.

It also installs five skills for the project's coding agent, in `.agents/skills/` and `.claude/skills/`, and adds a marked section to `AGENTS.md`.

## MVP scope

- Scan a chosen folder, excluding dependencies, build output, binaries and secrets.
- Read code, config, Markdown, plain text, PDF and DOCX files.
- Generate documents through the Claude CLI by default, or an Anthropic API key as the second option.
- Use Sonnet at medium reasoning by default, with console menus to choose others.
- Generate project-level documents and one folder per spec.
- Tie each generated requirement to evidence in the project, with a status showing whether code and docs agree.
- Check generated documents before saving, and report anything skipped or in conflict.
- Re-run efficiently through caching, without overwriting hand edits unless told to.
- Install skills that any coding agent can use to create and refine specs, write code, implement specs and test them.

## Non-goals for the MVP

- LLM providers other than Claude, including local models.
- OCR for scanned PDFs, and legacy `.doc` files.
- Generating or changing the target project's code or tests.
- Running the generated test cases.
- Watch mode, a GUI, a web service, or CI-specific integrations.
- Merging regenerated documents with hand edits.
- Fetching the model list from a remote service.

## Glossary

| Term | Meaning |
|---|---|
| **SDD** | Spec-driven development: specs are written first and guide the implementation |
| **Target project** | The folder cclinic is run on |
| **Spec** | One folder describing one capability, with `spec.md`, `validation.md` and `verification.md` |
| **Validation** | Checking that we built the right thing, from the user's point of view |
| **Verification** | Checking that we built it correctly, through specific tests |
| **Provider** | How cclinic reaches Claude: the Claude CLI or the Anthropic API |
| **Reasoning level** | How much thinking Claude applies: low, medium, high, extra high or max. Sent as `effort` |
| **Evidence** | A citation showing where a requirement came from: `path:line` or `document:page` |
| **Module** | A group of related files that are summarised together |
| **Chunk** | A piece of a large file, small enough to send in one request |
