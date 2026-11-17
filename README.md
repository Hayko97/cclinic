# luseen

`luseen` sets up spec-driven development for your project. It reads your code, uses Claude to write specs, and gives your coding agent skills to work from them. You can then plan work with a PM agent, run whole roadmaps with AI, and watch everything in a local web GUI.

## Quick start

```bash
npm install -g luseen       # install
claude auth login            # connect to Claude, if you haven't already
cd /path/to/your-project
luseen doctor               # check your setup, with no Claude usage
luseen                      # set up specs and agent skills for the project
luseen gui                  # open the web GUI
```

Each step is explained below.

## 1. Install

You need Node.js 22.18 or newer (`node --version`). Install luseen from npm:

```bash
npm install -g luseen
luseen --version
```

Or run it without installing, from your project folder:

```bash
npx luseen doctor
npx luseen
```

`npx` downloads luseen the first time. Add `@latest` (`npx luseen@latest`) to make sure you run the newest version.

Update or remove it:

```bash
npm install -g luseen@latest   # update
npm uninstall -g luseen        # remove
```

If the install fails:

- **`luseen: command not found`:** npm's global folder isn't on your `PATH`. Run `npm prefix -g`, and add its `bin` folder to your `PATH`.
- **`EACCES: permission denied`:** don't use `sudo`. Install Node.js with a version manager such as [nvm](https://github.com/nvm-sh/nvm), or [change npm's global folder](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).
- **"luseen needs Node.js 22.18 or newer":** update Node.js, then install luseen again.

### Or install the Claude Code plugin

In Claude Code, add this repository as a plugin marketplace, install the plugin, then set up your project:

```text
/plugin marketplace add Hayko97/cclinic
/plugin install luseen@luseen
/luseen:init
```

On Claude Code 2.1.275 or later, `/plugin install luseen --marketplace Hayko97/cclinic` does the first two in one step.

The plugin brings luseen's skills (`/luseen:create-spec`, `/luseen:plan`, `/luseen:status`, `/luseen:gui` and more), so your project gets no skill folders. The plugin itself holds no MCP server or hook. `/luseen:init` adds luseen's local MCP server to your project's `.mcp.json` and the hook that links your sessions to the GUI to `.claude/settings.json`, after asking, along with the specs and the `AGENTS.md` and `CLAUDE.md` sections. Then approve the project's `luseen` server when Claude Code asks, or in `/mcp`. It needs Node.js 22.18 or newer, and runs luseen with `npx`. To set up a project from a terminal instead, run `luseen --plugin`.

To work on luseen itself, install it from this repository instead:

```bash
git clone https://github.com/Hayko97/cclinic.git
cd cclinic
npm install
npm run build
npm link
```

## 2. Connect to Claude

Use one of these:

```bash
claude auth login                      # A (default): your Claude Code login and plan
export ANTHROPIC_API_KEY=<your-key>    # B: an Anthropic API key
```

Check it, with no Claude usage:

```bash
luseen doctor
```

## 3. Set up your project

```bash
cd /path/to/your-project
luseen --dry-run   # optional: see what would be analysed, with no Claude usage
luseen             # shows a summary and asks before sending anything
```

You get:

- `.luseen/sdd/`: project docs and specs (`spec.md`, `validation.md`, `verification.md` per area)
- Nine agent skills in `.claude/skills/` and `.agents/skills/`
- A workflow section in `AGENTS.md`, and a `CLAUDE.md` that imports it
- `.mcp.json` and a Claude Code hook, so the GUI can follow your sessions
- Optionally, a local preview in `.luseen/environment/`

Then **commit these files**, so your team and the AI agents use them.

Prefer a browser? Run `luseen gui` and use its **Setup** screen instead.

## 4. Open the GUI

```bash
luseen gui
```

It opens your browser at a private link on `127.0.0.1` (port 4417, or a free port if it's taken). Keep the terminal open, and press Ctrl+C to stop.

| In the GUI  | What you do                                                        |
| ----------- | ------------------------------------------------------------------ |
| Setup       | Generate docs, install skills, set up the preview, pick a model    |
| Canvas      | See roadmaps, milestones and tasks, with their status              |
| Plan        | Plan a roadmap or one task with the PM agent, then approve it      |
| Run with AI | Run a roadmap with agents. Stop it, or Continue it later           |
| Task panel  | See a task's steps, answer its questions, read its Claude sessions |
| Top bar     | Your Claude plan limits, so you see a limit coming                 |

Options: `--port <n>`, `--no-open`, `-C <folder>`. More in [GUI_FLOW.md](GUI_FLOW.md).

## 5. Work with your coding agent

Open your agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI) in the project and ask for a change. It follows these steps, and waits for you at each one:

1. **Spec:** it updates the spec. You reply `approve`, `refine` or `review-doc`.
2. **Build:** it writes the code and tests.
3. **Check:** a QA agent tests it, and a reviewer checks the code.
4. **Preview:** it starts the local preview, and you try it.
5. **Commit:** only if you say yes. It never pushes on its own.

Answer a waiting question in the agent's chat, with `luseen approve`, or in the GUI. More in [DEVELOPMENT_FLOW.md](DEVELOPMENT_FLOW.md).

## 6. Plan work

```bash
luseen plan                 # plan a roadmap with the PM agent, as a chat
luseen plan --task          # plan one task
luseen plan --resume        # continue a planning session
luseen tasks list           # see open tasks
```

The PM is a Claude session you chat with in the terminal, the GUI or Claude Code. Attach briefs or screenshots if you like. It researches, asks a few questions at a time, recommends options, then proposes milestones and tasks. Nothing is saved until you approve. More in [PLANNING_FLOW.md](PLANNING_FLOW.md).

## 7. Run a roadmap with AI

```bash
luseen auto --roadmap <id> --dry-run   # see the plan only
luseen auto --roadmap <id>             # run it
```

Agents build each task on its own branch and merge it into `luseen/auto/<run-id>/run`. Your branch is never touched, and nothing is pushed. If your Claude plan limit is reached, the run stops cleanly and tells you when it resets. Continue it later from the GUI. You get a report in `.luseen/auto/<run-id>/report.md`. More in [AUTO_FLOW.md](AUTO_FLOW.md).

## Commands

| Command              | What it does                                  | Uses Claude |
| -------------------- | --------------------------------------------- | ----------- |
| `luseen`             | Generate docs and install skills              | yes         |
| `luseen doctor`      | Check your setup                              | no          |
| `luseen gui`         | Open the local web GUI                        | no\*        |
| `luseen skills`      | Install or update the agent skills            | no          |
| `luseen environment` | Set up the local preview                      | yes         |
| `luseen model`       | Choose the default model and reasoning level  | no          |
| `luseen tasks`       | See and track roadmaps and tasks              | no          |
| `luseen plan`        | Plan with the PM agent                        | yes         |
| `luseen auto`        | Run a roadmap with agents                     | yes         |
| `luseen approve`     | Answer a question your agent is waiting on    | no          |
| `luseen mcp`         | The server your coding agent starts by itself | depends     |
| `luseen clean`       | Delete the cache and failed drafts            | no          |
| `luseen guide`       | Full walkthrough in the terminal              | no          |

\* Only the actions you start in it, such as Plan or Run with AI.

Run `luseen help <command>` for a command's options.

## Good to know

- **Re-running `luseen`** only reprocesses what changed. If the docs were edited by hand, it stops. `--force` replaces them all.
- **Privacy:** `.env` files, keys and credential files are never read. Known secrets are removed before sending. No telemetry.
- **Git:** luseen never pushes. It sends Claude only recent commit messages and file names, never diffs or authors (`--no-git` turns this off).
- **Limits:** big runs stop before sending anything. See `luseen --help` for `--max-files`, `--max-input-tokens` and more.

## Guides

| Guide                                      | About                                               |
| ------------------------------------------ | --------------------------------------------------- |
| [SETUP_FLOW.md](SETUP_FLOW.md)             | What `luseen` does when it sets up a project        |
| [GUI_FLOW.md](GUI_FLOW.md)                 | Every screen of the GUI                             |
| [DEVELOPMENT_FLOW.md](DEVELOPMENT_FLOW.md) | How your agent takes a change from prompt to commit |
| [PLANNING_FLOW.md](PLANNING_FLOW.md)       | Planning roadmaps and tasks with the PM             |
| [AUTO_FLOW.md](AUTO_FLOW.md)               | Running a roadmap with AI                           |

## Developing luseen

Specs are in [`.luseen/sdd/`](.luseen/sdd/README.md). Follow [`developer-guidelines.md`](.luseen/sdd/developer-guidelines.md).

```bash
npm run setup:browsers  # once: headless Chromium for the GUI page tests
npm run verify          # lint, types, architecture, tests and coverage
npm run test:e2e        # the built binary, against a fake claude
```

Automated tests never call real Claude.

The Claude Code plugin in `plugins/luseen/` and `.claude-plugin/marketplace.json` are generated: run `npm run build:plugin` after changing the skills or the version, and commit the result. A test fails when they're out of date.
