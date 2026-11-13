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

`cclinic` also installs nine skills, so your coding agent can work from these documents:

| Skill              | Use it to                                                                  |
| ------------------ | -------------------------------------------------------------------------- |
| `create-spec`      | Write a new spec for a new capability                                      |
| `refine-spec`      | Improve an existing spec, and resolve its open questions                   |
| `write-code`       | Write code that fits your stack and guidelines, as a maintainer would      |
| `implement-spec`   | Build a spec requirement by requirement, and prove that it works           |
| `test-spec`        | Act as QA: automate the test cases, run them, and report defects           |
| `local-env`        | Set up a local environment, and show how to review each change             |
| `product-engineer` | The PM's instructions: ask what to build, and propose a roadmap            |
| `review-doc`       | Show, with diagrams and mockups, how a spec change will work and look      |
| `review-code`      | Review a change against your coding rules and guidelines before you see it |

Roadmaps are created only by the PM agent: run `cclinic plan` in a terminal, answer its questions, and approve its proposal of milestones and tasks with their dependencies. `cclinic plan --task` plans one concrete task instead, standalone or in a roadmap. Nothing is saved until you approve.

Roadmaps and tasks are kept in `.cclinic/tasks.db`, and read and changed with `cclinic tasks` (`roadmaps`, `roadmap [show|remove]`, `list`, `add`, `depend`, `undepend`, `show`, `start`, `done`, `remove`, `milestone remove`, each with `--json` and `-C <folder>`). On every prompt, your agent checks for open tasks, and asks whether to work on one, remove it, or keep it and carry on.

`cclinic auto --roadmap <id>` runs a whole roadmap with no human. It has no dollar budget: when your Claude plan's usage limit is reached, it stops cleanly, puts unfinished tasks back, and says when the limit resets, so you can continue then (from `cclinic gui`, Continue on the roadmap). Developer agents take tasks in dependency order, several at once (`--developers`). For each task, the PM agent approves the spec, a QA agent tests the change end to end, and the PM reviews it before cclinic commits it to the task's branch and merges it into the run branch `cclinic/auto/<run-id>/run`. Your own branch is never touched and nothing is pushed. When the run ends, you get a desktop notification and a report in `.cclinic/auto/<run-id>/report.md`. Agents work from the last commit, so commit the skills and documents first.

When your agent asks you to review a spec change, you can choose `approve`, `refine` or `review-doc`. `review-doc` writes `.cclinic/reviews/<spec>/review.md`, with diagrams, screenshots of today and mockups of after, and then asks you to approve or refine the spec.

They're installed in `.agents/skills/` (Codex, Cursor, GitHub Copilot, Gemini CLI) and `.claude/skills/` (Claude Code), and `AGENTS.md` points other agents to them. Commit them, so your team shares them. Your own skills and edits are never overwritten without `--force`, and skills cclinic didn't create are never overwritten at all.

## How your coding agent works

`cclinic` also adds a section to `AGENTS.md`, and a `CLAUDE.md` that imports it. Your own text in those files is kept. They tell your agent to follow this lifecycle for code changes:

1. **Prompt:** it analyses your request, and finds the spec. A question just gets an answer.
2. **Spec:** it refines or creates the spec, and asks you to approve or reject it. No production code changes before you approve.
3. **Implement:** it builds and tests, reviews the code against your rules and `developer-guidelines.md` (and with Claude Code's `/code-review` in Claude Code), fixes what the review finds, shows you a way to try the change, such as a link or a simulator build, and asks you to approve it or request changes.
4. **Commit:** once you approve, it asks whether to commit. It never pushes on its own.

These files are guidance, so an agent can still fail to follow them.

After an agent edits the documents, re-running `cclinic` stops rather than overwriting them, and `--force` replaces them completely.

## Local environment

After generating documents, `cclinic` offers to set up a local environment, so you can try each change yourself. If you agree, Claude creates files in `.cclinic/environment/` and runs build and Docker commands, which can build and run your project's code.

| Project type            | How you review a change                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| Web app or API          | Docker Compose, at `http://my-app.localhost:3000` or `http://localhost:3000` |
| iOS or Android          | The app in a simulator or emulator                                           |
| Desktop, CLI or library | An exact command, and what it should do                                      |

`--yes` doesn't agree to this step, so use `--environment` in scripts, `--no-environment` to skip it, or `cclinic environment` to run it later. It stops after 15 minutes, or $2 unless you set `--max-budget-usd`. Without the Claude CLI, `cclinic` gives you a sentence to pass to your own coding agent.

## Git

If the project has no Git repository, `cclinic` creates a local one and tells you how to connect a remote, such as GitHub. It never commits or pushes for you.

If there is a repository, its last 14 days of commit messages and changed file names give Claude context on recent work. Code diffs and author details are never sent. Use `--no-git` to turn this off.

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
| `cclinic environment`  | Set up a local environment for previewing changes         |
| `cclinic tasks`        | See roadmaps and track tasks, with no Claude usage        |
| `cclinic plan`         | Plan a roadmap, or one task, with the PM agent            |
| `cclinic auto`         | Run a whole roadmap with developer, PM and QA agents      |
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

The specifications live in [`.cclinic/sdd/`](.cclinic/sdd/README.md). Start there, and follow [`.cclinic/sdd/developer-guidelines.md`](.cclinic/sdd/developer-guidelines.md).

```
npm run setup:browsers  # once: the headless Chromium the GUI's page tests use
npm run verify          # lint, types, architecture, tests and coverage
npm test                # unit and integration tests
npm run test:e2e        # the built binary, against a fake claude command
npm run test:mutation   # mutation testing on core logic
```

Automated tests never call real Claude.
