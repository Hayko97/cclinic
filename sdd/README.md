# cclinic: SDD documentation

These documents define the MVP of `cclinic`. **No code exists yet.** An AI coding tool or developer should be able to build the CLI from these files without further design decisions.

## Folder layout

```
sdd/
  README.md                 this file
  overview.md               purpose, users, MVP scope, non-goals, glossary
  stack.md                  languages, tools, versions
  architecture.md           layers, pipeline, boundaries, build risks
  developer-guidelines.md   SOLID, naming, architecture, testing and other rules
  decisions/                Architecture Decision Records
  specs/
    <spec-name>/
      spec.md               what to build
      validation.md         did we build the right thing?
      verification.md       how to test it, for automation testers
```

## Reading order

1. [overview.md](overview.md)
2. [stack.md](stack.md)
3. [architecture.md](architecture.md)
4. [developer-guidelines.md](developer-guidelines.md)
5. The specs, in build order:

| # | Spec | Covers | Area code |
|---|---|---|---|
| 1 | [cli](specs/cli/spec.md) | Commands, options, summary, confirmation, exit codes | `CLI` |
| 2 | [model-selection](specs/model-selection/spec.md) | Model and reasoning menus, saved defaults | `MODEL` |
| 3 | [file-discovery](specs/file-discovery/spec.md) | Which files are analysed or skipped, secret protection | `DISC` |
| 4 | [content-extraction](specs/content-extraction/spec.md) | Reading code, PDF, DOCX and Markdown | `EXT` |
| 5 | [llm-providers](specs/llm-providers/spec.md) | Claude CLI and Anthropic API | `LLM` |
| 6 | [spec-analysis](specs/spec-analysis/spec.md) | Turning project content into structured results | `ANA` |
| 7 | [spec-output](specs/spec-output/spec.md) | The generated folder and how it's checked | `OUT` |
| 8 | [agent-skills](specs/agent-skills/spec.md) | Skills installed for the project's coding agent | `SKILL` |

## The three files in each spec

| File | Question it answers | Written for | ID format |
|---|---|---|---|
| `spec.md` | What must the software do? | Developers and AI coding tools | `FR-<AREA>-NNN` |
| `validation.md` | Does it meet the need, from the user's point of view? | Product owners, reviewers, anyone accepting the feature | `VAL-<AREA>-NNN` |
| `verification.md` | Which exact test proves each requirement? | Automation testers | `TC-<AREA>-NNN` |

Every requirement has at least one `VAL` and at least one `TC`.

## Conventions

- **MUST** is mandatory for the MVP. **MUST NOT** is prohibited.
- IDs are permanent once code refers to them. Don't reuse an ID for a different requirement.
- Behaviour marked **Verified** was observed on Claude Code 2.1.319 on 2026-11-07. Recheck it if the Claude CLI seems to behave differently.

## Verification conventions

**Test levels** in `verification.md`:

| Level | Meaning | Runs in CI? |
|---|---|---|
| `unit` | One module, with no real filesystem, network or child processes | Yes |
| `integration` | Several modules with a real temp filesystem and a fake `LlmProvider` or fake `claude` executable | Yes |
| `e2e` | The built `cclinic` binary, run as a child process with a fake `claude` executable | Yes |
| `manual` | Needs a person, a real terminal or a real Claude account. Candidates for later automation | No |

**Shared fixtures** in `test/fixtures/`:

| Fixture | Contents |
|---|---|
| `sample-project` | First-party code plus `node_modules`, `vendor`, a DLL, a lockfile, `.env`, and PDF, DOCX and Markdown files |
| `conflict-project` | A document that contradicts the code |
| `injection-project` | A file containing text that tells the model to ignore its instructions |
| `recorded-cli-output` | Real `claude -p` JSON responses: success, invalid model, and missing output |

**Test names** MUST start with the `TC` ID, so results can be traced back to these files: `TC-DISC-006: skips binary files but keeps PDF and DOCX`.

## Rules for building from these specs

1. A spec is done only when all of its `TC`s pass and its `VAL`s are accepted.
2. If a spec is wrong or incomplete, change the spec first and then the code. They must not drift apart.
3. Anything listed under non-goals stays out of the MVP unless the spec is changed first.
4. Follow [developer-guidelines.md](developer-guidelines.md) for all code.
