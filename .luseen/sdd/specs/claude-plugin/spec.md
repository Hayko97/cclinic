# claude-plugin

## Goal

Ship Luseen as a Claude Code plugin, `luseen`, in a plugin marketplace kept in this repository, so a user installs it once with `/plugin` and then sets up and uses Luseen in any project from Claude Code, with no per-project MCP config, hook or skill folders.

The plugin is a thin wrapper. It holds no product logic: its MCP server, hook and commands run the `luseen` npm package with `npx`, at the plugin's own version. Its skills are the ones `luseen skills` installs ([agent-skills](../agent-skills/spec.md)), generated from the same source.

```
repository root
├── .claude-plugin/marketplace.json      marketplace "luseen", one plugin
└── plugins/luseen/
    ├── .claude-plugin/plugin.json       name, version = package.json's
    ├── .claude-plugin/icon.png          the logo, from assets/luseen-icon.png
    ├── .mcp.json                        npx -y luseen@<version> mcp (runs in the user's project)
    ├── hooks/hooks.json                 PostToolUse → npx -y luseen@<version> session-link
    ├── skills/<9 agent skills>/SKILL.md
    ├── skills/{init,plan,status,gui}/SKILL.md     /luseen:init … /luseen:gui
    └── agents/pm.md                     read-only PM agent
```

Claude Code names a plugin's MCP tools `mcp__plugin_luseen_luseen__<tool>`, not `mcp__luseen__<tool>` (https://code.claude.com/docs/en/mcp.md), so the hook and `session-link` must accept both forms.

Publishing (npm publish, pushing the repository, submitting to Anthropic's directory) is a release step the owner does, outside this spec.

## Requirements

### Marketplace and manifest

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-001 | The repository root must hold `.claude-plugin/marketplace.json` with `name` `luseen`, `owner.name` `Hayko97`, and exactly one plugin entry: `name` `luseen`, `source` `./plugins/luseen`, and a `description`. | confirmed | `src/core/claude-plugin.ts:135-143`, `.claude-plugin/marketplace.json`, `test/integration/claude-plugin.test.ts` TC-PLUG-001 |
| FR-PLUG-002 | `plugins/luseen/.claude-plugin/plugin.json` must have `name` `luseen`, `version` equal to `package.json`'s `version`, and `description`, `author`, `homepage`, `repository` and `license` taken from `package.json`. | confirmed | `src/core/claude-plugin.ts:144-155`, `plugins/luseen/.claude-plugin/plugin.json`, `test/integration/claude-plugin.test.ts` TC-PLUG-002 |
| FR-PLUG-003 | `claude plugin validate --strict` must pass for the repository root and for `plugins/luseen`. | confirmed | `claude plugin validate --strict` on `.` and `plugins/luseen`, Claude Code 2.1.319, 2026-11-15 |

### What the plugin runs

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-004 | `plugins/luseen/.mcp.json` must declare one server, `luseen`, with command `npx` and arguments `-y`, `luseen@<version>` and `mcp`, where `<version>` is `package.json`'s `version`. It must name no variable, because the plugin directory refuses a command whose path it can't follow; Claude Code starts a plugin's server in the user's project folder, which `luseen mcp` serves by default. | confirmed | `src/core/claude-plugin.ts:162-170`, `plugins/luseen/.mcp.json`, claude.ai directory validation 2026-11-16, `test/integration/claude-plugin.test.ts` TC-PLUG-004 |
| FR-PLUG-005 | `plugins/luseen/hooks/hooks.json` must hold one `PostToolUse` hook whose matcher is `mcp__plugin_luseen_luseen__.*` and whose command is `npx` with the arguments `-y`, `luseen@<version>` and `session-link`, each a plain word, as the plugin directory asks. | confirmed | `src/core/claude-plugin.ts:164-177`, `src/core/constants/plugin.ts` `PLUGIN_TOOL_PREFIX`, `test/integration/claude-plugin.test.ts` TC-PLUG-005 |
| FR-PLUG-006 | `luseen session-link`, and everything that reads a tool name the hook reports (mcp-server FR-MCP-045, roadmap-planning FR-PLAN-044), must treat `mcp__plugin_luseen_luseen__<tool>` exactly as `mcp__luseen__<tool>`. | confirmed | `src/core/planning.ts:725-742`, `src/cli/mcp-command.ts` `linkFromHook`, `src/core/planning.test.ts` TC-PLUG-007, `test/e2e/plugin.test.ts` TC-PLUG-006 |
| FR-PLUG-007 | When the project has no `.luseen/sdd`, `luseen mcp` must start anyway and offer only `workflow_status`, which must answer that the project isn't set up and that `/luseen:init` sets it up. This replaces mcp-server FR-MCP-003's exit 2, so the plugin's server starts in every project. | confirmed | `src/cli/mcp-command.ts:136-144`, `src/application/workflow-tools.ts:524`, `test/e2e/plugin.test.ts` TC-PLUG-008, TC-PLUG-009 |

### Skills, commands and agents

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-008 | `plugins/luseen/skills/` must hold the nine agent skills, each identical to what `luseen skills` writes for the documents folder `.luseen/sdd`. | confirmed | `src/core/claude-plugin.ts:178-179`, `test/integration/claude-plugin.test.ts` TC-PLUG-010 |
| FR-PLUG-009 | The skill `init` (`/luseen:init`) must tell Claude to: say when the project already has `.luseen/sdd` and stop; otherwise tell the user that setup analyses the project with their Claude usage and ask before starting; on yes, run `npx -y luseen@<version> --yes --plugin` in the project root and report its result; on no, do nothing. | confirmed | `src/core/claude-plugin.ts:60-71`, `plugins/luseen/skills/init/SKILL.md`, `test/integration/claude-plugin.test.ts` TC-PLUG-011 |
| FR-PLUG-010 | The skill `plan` (`/luseen:plan`) must start planning as the `product-engineer` skill does from Claude Code (roadmap-planning FR-PLAN-044), with `plan_begin` first. The skill `status` (`/luseen:status`) must call `workflow_status` and `tasks_list` and summarise the current change, its waiting gate and the open tasks. The skill `gui` (`/luseen:gui`) must start `npx -y luseen@<version> gui --no-open --json` in the background in the project root and give the user the link it prints. | confirmed | `src/core/claude-plugin.ts:72-106`, `test/integration/claude-plugin.test.ts` TC-PLUG-011 |
| FR-PLUG-011 | `plugins/luseen/agents/pm.md` must define the agent `pm` with the `product-engineer` skill's instructions, and `tools` limited to `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` and the plugin's planning tools (`plan_begin`, `plan_resume`, `plan_status`, `plan_suggest`, `plan_propose`), so it can't edit files or run commands. | confirmed | `src/core/claude-plugin.ts:116-128`, `plugins/luseen/agents/pm.md`, `test/integration/claude-plugin.test.ts` TC-PLUG-012 |

### Generation and setup

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-012 | Every file under `plugins/luseen/` and `.claude-plugin/marketplace.json` must be written by `npm run build:plugin` from luseen's own sources (`package.json`, the skill definitions and the name constants), and the test suite must fail when a committed file differs from what the script writes. | confirmed | `package.json` `build:plugin`, `src/cli/build-plugin.ts`, `src/adapters/storage/plugin-files.ts`, `test/integration/claude-plugin.test.ts` TC-PLUG-013 |
| FR-PLUG-013 | `luseen --plugin` and `luseen skills --plugin` must install only the managed `AGENTS.md` and `CLAUDE.md` sections: no skill folders, no `.mcp.json` entry and no Claude Code hook. With `--plugin`, the section's skills table must say the skills come from the luseen Claude Code plugin, as `/luseen:<skill>`, instead of `.agents/skills/<name>/SKILL.md`. | confirmed | `src/adapters/storage/skill-installer.ts:155-159`, `src/core/agent-skills.ts` `renderAgentsBlock`, `src/cli/main.ts:124,197`, `test/e2e/plugin.test.ts` TC-PLUG-014, TC-PLUG-015 |
| FR-PLUG-014 | The README must give the install commands `/plugin marketplace add <owner>/<repo>` and `/plugin install luseen@luseen`, with `<owner>/<repo>` taken from `package.json`'s `repository`, and then `/luseen:init`. | confirmed | `README.md:49-61`, `test/integration/claude-plugin.test.ts` TC-PLUG-016 |
| FR-PLUG-015 | `plugins/luseen/.claude-plugin/icon.png` must be a copy of the repository's logo `assets/luseen-icon.png`, a square PNG of 512 to 2048 pixels on each side and under 2 MB, for the plugin directory listing. | confirmed | `src/adapters/storage/plugin-files.ts` `buildPluginFiles`, `assets/luseen-icon.svg`, `test/integration/claude-plugin.test.ts` TC-PLUG-018, `user request 2026-11-16` |

## Edge cases

- A project already set up the old way, with a `luseen` entry in `.mcp.json` and the hook: Claude Code starts both servers. Both share `.luseen/` and its locks, so they don't corrupt each other, but the tools appear twice (see open questions).
- `/luseen:init` in a project already set up: it says so and changes nothing.
- `/luseen:init` without the `claude` executable or with the API provider: the CLI's own checks report it, and the skill relays the message.
- The plugin's server in a folder that isn't a project, such as the home folder: it starts with only `workflow_status`.
- `npx` can't reach npm: Claude Code shows the server as failed; nothing else breaks.

## Non-goals

- Publishing: `npm publish`, pushing the repository, tagging and submitting to Anthropic's directory are done by the owner.
- A native panel beside the chat (early-access Claude Code API); a later spec.
- Writing the specs from Claude's own session during `/luseen:init`; it runs the existing pipeline.
- Codex: it keeps the per-project install from agent-skills and mcp-server.
- Detecting whether the plugin is installed from the CLI.
