# cclinic

`cclinic` sets up spec-driven development (SDD) for an existing project. It reads your own code and documents, skips dependencies, build output, binaries and secrets, and uses Claude to write documents that AI coding tools and automation testers can follow.

## Quick start

**1. Install cclinic.** It isn't on npm yet, so install it from this repository:

```bash
git clone https://github.com/Hayko97/cclinic.git
cd cclinic
npm install
npm run build
npm link
```

**2. Connect it to Claude**, using either option:

```bash
# Option A (default): log in to Claude Code
claude auth login

# Option B: use an Anthropic API key
export ANTHROPIC_API_KEY=<your-key>
```

**3. Set up your project:**

```bash
cd /path/to/your-project
cclinic
```

`cclinic` shows a summary and asks before sending anything to Anthropic. When it finishes, your project has its specs, documents and coding agent skills.

To check your setup or preview a run first, with no Claude usage:

```bash
cclinic doctor
cclinic --dry-run
```

Run `cclinic guide` for the full walkthrough, or `cclinic --help` for every option.

## Requirements

- Node.js 22.18 or newer
- One of these:
  - [Claude Code](https://code.claude.com), logged in. This is the default
  - An Anthropic API key in `ANTHROPIC_API_KEY`

## What it generates

```
.cclinic/sdd/
  README.md                 how to use these documents
  overview.md               purpose, users, scope
  stack.md                  languages, frameworks, tools
  architecture.md           structure and data flow
  developer-guidelines.md   SOLID, naming, testing and more, tailored to your stack
  open-questions.md         conflicts and unknowns
  scan-report.md            what was analysed and skipped
  manifest.json             run details and file hashes
  specs/<spec-name>/
    spec.md                 requirements, with evidence
    validation.md           acceptance criteria
    verification.md         test cases for automation testers
```

## Skills for your coding agent

`cclinic` also installs five skills, so your coding agent can work from these documents:

| Skill            | Use it to                                                             |
| ---------------- | --------------------------------------------------------------------- |
| `create-spec`    | Write a new spec for a new capability                                 |
| `refine-spec`    | Improve an existing spec, and resolve its open questions              |
| `write-code`     | Write code that fits your stack and guidelines, as a maintainer would |
| `implement-spec` | Build a spec requirement by requirement, and prove that it works      |
| `test-spec`      | Act as QA: automate the test cases, run them, and report defects      |

They're installed in `.agents/skills/` (Codex, Cursor, GitHub Copilot, Gemini CLI) and `.claude/skills/` (Claude Code), and `AGENTS.md` points other agents to them. Commit them, so your team shares them. Your own skills and edits are never overwritten without `--force`, and skills cclinic didn't create are never overwritten at all.

After an agent edits the documents, re-running `cclinic` stops rather than overwriting them, and `--force` replaces them completely.

## Help

Run `cclinic guide` for the full walkthrough, `cclinic --help` for an overview and options, or `cclinic help <command>` for one command.

## Common commands

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `cclinic model`        | Choose your default model and reasoning level from a menu |
| `cclinic --model`      | Choose a model for this run only                          |
| `cclinic model --list` | Show the options and your current choice                  |
| `cclinic doctor`       | Check your setup, without using any Claude usage          |
| `cclinic skills`       | Install the coding agent skills, with no Claude usage     |
| `cclinic clean`        | Delete the cache and failed drafts                        |

The default is Sonnet at medium reasoning. Re-running only reprocesses what changed, and continues from where a failed run stopped.

## Limits

Large or expensive runs stop before anything is sent. Each limit can be changed.

| Option                | Default                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `--max-files`         | 10,000                                                              |
| `--max-input-tokens`  | 2,000,000                                                           |
| `--max-file-size-mib` | 1                                                                   |
| `--max-budget-usd`    | None. Spend can pass this, because it's checked against an estimate |
| `--concurrency`       | 4                                                                   |
| `--timeout-minutes`   | 30                                                                  |
| `--max-retries`       | 2                                                                   |

## Privacy

- `.env` files, private keys and credential files are never read.
- Known secret formats in other files are removed before sending. This is best-effort, so review your project first.
- cclinic collects no telemetry.

## Development

The specifications live in [`sdd/`](sdd/README.md). Start there, and follow [`sdd/developer-guidelines.md`](sdd/developer-guidelines.md).

```
npm run verify          # lint, types, architecture, tests and coverage
npm test                # unit and integration tests
npm run test:e2e        # the built binary, against a fake claude command
npm run test:mutation   # mutation testing on core logic
```

Automated tests never call real Claude.
