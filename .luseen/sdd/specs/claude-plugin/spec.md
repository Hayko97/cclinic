# claude-plugin

## Goal

Ship Luseen as a Claude Code plugin, `luseen`, in a plugin marketplace kept in this repository and in Anthropic's plugin directory, so a user installs it once with `/plugin` and then sets up and uses Luseen in any project from Claude Code, with no skill folders in the project.

The plugin is a thin wrapper. It holds no product logic: its commands run the `luseen` npm package with `npx`, at the plugin's own version. Its skills are the ones `luseen skills` installs ([agent-skills](../agent-skills/spec.md)), generated from the same source.

The plugin ships **no MCP server and no hook**. Anthropic's directory accepts local MCP servers and hooks only from Verified organizations (directory check, 2026-11-17). luseen's MCP server and session-link hook are added to each project instead, when it's set up: by `/luseen:init` from the plugin, or by `luseen` from npm, as before ([mcp-server](../mcp-server/spec.md) FR-MCP-004, FR-MCP-044). The npm flow doesn't change.

```
repository root
├── .claude-plugin/marketplace.json      marketplace "luseen", one plugin
└── plugins/luseen/
    ├── .claude-plugin/plugin.json       name, version = package.json's
    ├── .claude-plugin/icon.png          the logo, from assets/luseen-icon.png
    ├── skills/<10 agent skills>/SKILL.md
    ├── skills/{init,plan,status,gui}/SKILL.md     /luseen:init … /luseen:gui
    ├── agents/pm.md                     read-only PM agent
    └── agents/designer.md               UI/UX designer and UI developer (ui-design FR-DSGN-038)

user's project, after /luseen:init or `luseen`
├── .mcp.json                            luseen → npx luseen mcp
└── .claude/settings.json                PostToolUse mcp__luseen__.* → npx luseen session-link
```

Plugin version 0.1.1 shipped its own server, whose tools Claude Code names `mcp__plugin_luseen_luseen__<tool>` (https://code.claude.com/docs/en/mcp.md). `session-link` keeps accepting that form for sessions recorded with it.

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
| FR-PLUG-004 | The plugin must declare no MCP server: `plugins/luseen/` must hold no `.mcp.json`, and `plugin.json` must have no `mcpServers` key, because Anthropic's directory accepts local MCP servers only from Verified organizations. | confirmed | `src/core/claude-plugin.ts:133-165`, `test/integration/claude-plugin.test.ts` TC-PLUG-004, `src/core/claude-plugin.test.ts`, claude.ai directory check 2026-11-17 "Local MCP servers accepted only from Verified organizations", `user request 2026-11-17` |
| FR-PLUG-005 | The plugin must ship no hooks: `plugins/luseen/` must hold no `hooks/` folder, and `plugin.json` must have no `hooks` key, because Anthropic's directory accepts hooks of any type only from Verified organizations. | confirmed | `src/core/claude-plugin.ts:133-165`, `test/integration/claude-plugin.test.ts` TC-PLUG-005, `src/core/claude-plugin.test.ts`, claude.ai directory check 2026-11-17 "Hooks of type command accepted only from Verified organizations", `user request 2026-11-17` |
| FR-PLUG-006 | `luseen session-link`, and everything that reads a tool name the hook reports (mcp-server FR-MCP-045, roadmap-planning FR-PLAN-044), must treat `mcp__plugin_luseen_luseen__<tool>` exactly as `mcp__luseen__<tool>`, for sessions recorded with plugin version 0.1.1. | confirmed | `src/core/planning.ts:725-742`, `src/cli/mcp-command.ts` `linkFromHook`, `src/core/planning.test.ts` TC-PLUG-007, `test/e2e/plugin.test.ts` TC-PLUG-006 |
| FR-PLUG-007 | When the project has no `.luseen/sdd`, `luseen mcp` must start anyway and offer only `workflow_status`, which must answer that the project isn't set up and that `/luseen:init` sets it up. This replaces mcp-server FR-MCP-003's exit 2. | confirmed | `src/cli/mcp-command.ts:136-144`, `src/application/workflow-tools.ts:524`, `test/e2e/plugin.test.ts` TC-PLUG-008, TC-PLUG-009 |

### Skills, commands and agents

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-008 | `plugins/luseen/skills/` must hold the ten agent skills, each identical to what `luseen skills` writes for the documents folder `.luseen/sdd`, except that the plugin's copy has no `metadata` block in its frontmatter (FR-PLUG-016). | confirmed | `src/core/claude-plugin.ts:178-179`, `test/integration/claude-plugin.test.ts` TC-PLUG-010, claude.ai directory check 2026-11-19 |
| FR-PLUG-016 | Every `SKILL.md` and agent file under `plugins/luseen/` must start with frontmatter between a first line of exactly `---` and a second `---` line, in which every line is one unindented `key: value` pair with a text value, and the keys are only `name` and `description` for a skill, and only `name`, `description` and `tools` for an agent. In particular, no file may have a `metadata` key or any nested or indented line, because Anthropic's directory accepts frontmatter keys outside its allowed list only from Verified organizations. | confirmed | `src/core/claude-plugin.ts` `renderClaudePlugin`, `src/core/agent-skills.ts` `withoutStamp`, `test/integration/claude-plugin.test.ts` TC-PLUG-021, `test/e2e/plugin.test.ts` TC-PLUG-022, claude.ai directory check 2026-11-19 "Frontmatter keys outside the allowed list accepted only from Verified organizations", `plugins/luseen/skills/*/SKILL.md` and `plugins/luseen/agents/designer.md` `metadata:` block, `user request 2026-11-19` |
| FR-PLUG-009 | The skill `init` (`/luseen:init`) must tell Claude to: (1) when the project has `.luseen/sdd` and `.mcp.json` has a `luseen` server, say it's already set up and stop; (2) when it has `.luseen/sdd` but no `luseen` server in `.mcp.json`, tell the user it will add luseen's local MCP server to `.mcp.json` and its hook to `.claude/settings.json`, without using Claude usage, ask, and on yes run `npx -y luseen@<version> skills --plugin` in the project root; (3) otherwise tell the user that setup analyses the project with their Claude usage, writes the specs and the `AGENTS.md` and `CLAUDE.md` sections, and adds luseen's local MCP server to `.mcp.json` and its hook to `.claude/settings.json`, ask before starting, and on yes run `npx -y luseen@<version> --yes --plugin` in the project root. After a command succeeds, it must tell the user to restart Claude Code or run `/mcp`, and approve the project's `luseen` server. On no, it must do nothing. | confirmed | `src/core/claude-plugin.ts:58-71`, `plugins/luseen/skills/init/SKILL.md`, `test/integration/claude-plugin.test.ts` TC-PLUG-011, `user request 2026-11-17` |
| FR-PLUG-010 | The skill `plan` (`/luseen:plan`) must start planning as the `product-engineer` skill does from Claude Code (roadmap-planning FR-PLAN-044), with `plan_begin` first; when luseen's MCP tools aren't available, it must tell the user to run `/luseen:init` and stop. The skill `status` (`/luseen:status`) must call `workflow_status` and `tasks_list` and summarise the current change, its waiting gate and the open tasks; when luseen's MCP tools aren't available, it must run `npx -y luseen@<version> tasks list --json`, summarise the open tasks, and say that the change's status needs luseen's MCP server, which `/luseen:init` adds. The skill `gui` (`/luseen:gui`) must start `npx -y luseen@<version> gui --no-open --json` in the background in the project root and give the user the link it prints. | confirmed | `src/core/claude-plugin.ts:72-108`, `test/integration/claude-plugin.test.ts` TC-PLUG-011, `user request 2026-11-17` |
| FR-PLUG-011 | `plugins/luseen/agents/pm.md` must define the agent `pm` with the `product-engineer` skill's instructions, and `tools` limited to `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` and the project server's planning tools `mcp__luseen__plan_begin`, `mcp__luseen__plan_resume`, `mcp__luseen__plan_status`, `mcp__luseen__plan_suggest` and `mcp__luseen__plan_propose`, so it can't edit files or run commands. | confirmed | `src/core/claude-plugin.ts:118-130`, `plugins/luseen/agents/pm.md`, `test/integration/claude-plugin.test.ts` TC-PLUG-012, `user request 2026-11-17` |

### Generation and setup

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-PLUG-012 | Every file under `plugins/luseen/` and `.claude-plugin/marketplace.json` must be written by `npm run build:plugin` from luseen's own sources (`package.json`, the skill definitions and the name constants), and the test suite must fail when a committed file differs from what the script writes. | confirmed | `package.json` `build:plugin`, `src/cli/build-plugin.ts`, `src/adapters/storage/plugin-files.ts`, `test/integration/claude-plugin.test.ts` TC-PLUG-013 |
| FR-PLUG-013 | `luseen --plugin` and `luseen skills --plugin` must install the managed `AGENTS.md` and `CLAUDE.md` sections, the `luseen` entry in `.mcp.json` (mcp-server FR-MCP-004) and the Claude Code hook (mcp-server FR-MCP-044), and no skill folders. With `--plugin`, the section's skills table must say the skills come from the luseen Claude Code plugin, as `/luseen:<skill>`, instead of `.agents/skills/<name>/SKILL.md`. Without `--plugin`, `luseen` and `luseen skills` must work as before: skill folders, sections, `.mcp.json` entry and hook. | confirmed | `src/adapters/storage/skill-installer.ts:146-177`, `src/core/agent-skills.ts` `renderAgentsBlock`, `src/cli/main.ts:124,200`, `test/e2e/plugin.test.ts` TC-PLUG-014, TC-PLUG-015, TC-PLUG-019, `user request 2026-11-17` |
| FR-PLUG-014 | The README must give the install commands `/plugin marketplace add <owner>/<repo>` and `/plugin install luseen@luseen`, with `<owner>/<repo>` taken from `package.json`'s `repository`, and then `/luseen:init`. It must say that the plugin itself holds no MCP server or hook, and that `/luseen:init` adds luseen's local MCP server to the project's `.mcp.json` and its hook to `.claude/settings.json`, after asking. | confirmed | `README.md:49-61`, `test/integration/claude-plugin.test.ts` TC-PLUG-016, `user request 2026-11-17` |
| FR-PLUG-015 | `plugins/luseen/.claude-plugin/icon.png` must be a copy of the repository's logo `assets/luseen-icon.png`, a square PNG of 512 to 2048 pixels on each side and under 2 MB, for the plugin directory listing. | confirmed | `src/adapters/storage/plugin-files.ts` `buildPluginFiles`, `assets/luseen-icon.svg`, `test/integration/claude-plugin.test.ts` TC-PLUG-018, `user request 2026-11-16` |

## Edge cases

- A project already set up the old way, with a `luseen` entry in `.mcp.json` and the hook: the plugin adds no second server, so the tools appear once. `/luseen:init` says it's set up and changes nothing.
- A project set up with plugin 0.1.1, which has `.luseen/sdd` but no `luseen` entry in `.mcp.json`: after updating the plugin, `/luseen:init` offers to add the server and hook with `luseen skills --plugin`, which uses no Claude usage.
- A `luseen` entry in `.mcp.json` that differs from luseen's own: it's left unchanged, as mcp-server FR-MCP-004 says.
- `/luseen:init` without the `claude` executable or with the API provider: the CLI's own checks report it, and the skill relays the message.
- `/luseen:status` or `/luseen:plan` before `/luseen:init`: no luseen MCP tools exist, so they point to `/luseen:init`.
- `npx` can't reach npm: `/luseen:init` and `/luseen:gui` report the error; the project's server shows as failed in `/mcp`.
- A project that installs the skills with `luseen skills` keeps the `metadata` block (`generated-by`, `content-hash`) in its own copies, so luseen still recognises and updates them (agent-skills); only the plugin's copies drop it.
- The user doesn't approve the project's `luseen` server when Claude Code asks: the skills work without its tools, as the AGENTS.md section's "without the tools" steps describe.

## Non-goals

- Publishing: `npm publish`, pushing the repository, tagging and submitting to Anthropic's directory are done by the owner.
- A native panel beside the chat (early-access Claude Code API); a later spec.
- Writing the specs from Claude's own session during `/luseen:init`; it runs the existing pipeline.
- Codex: it keeps the per-project install from agent-skills and mcp-server.
- Becoming a Verified organization, and a plugin that ships its own MCP server and hook once Luseen is one; a later change.
- The directory's warnings about pinned `npx` packages and a missing lockfile, which apply to a plugin's own MCP server; this plugin has none.
- Detecting whether the plugin is installed from the CLI.
