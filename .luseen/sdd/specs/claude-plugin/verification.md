# claude-plugin: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest. Plugin file checks are in test/integration/claude-plugin.test.ts; CLI cases in test/e2e/plugin.test.ts against the built `bin/luseen.js`.
- The committed plugin files are compared with the output of `npm run build:plugin` written to a temporary folder.
- `claude plugin validate` needs a real `claude` executable, so TC-PLUG-003 is `manual` (or a CI step where `claude` is installed). Cases that need Claude Code to load the plugin are `manual`; repeat each at least once on a clean install.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-PLUG-001 | FR-PLUG-001 | integration | The repository | Read `.claude-plugin/marketplace.json` | `name` is `luseen`, `owner.name` is `Hayko97`, and `plugins` is one entry with `name` `luseen`, `source` `./plugins/luseen` and a non-empty `description` |
| TC-PLUG-002 | FR-PLUG-002 | integration | The repository | Read `plugins/luseen/.claude-plugin/plugin.json` and `package.json` | `name` is `luseen`; `version`, `description`, `author`, `homepage`, `repository` and `license` equal `package.json`'s |
| TC-PLUG-003 | FR-PLUG-003 | manual | `claude` installed | Run `claude plugin validate --strict .` and `claude plugin validate --strict plugins/luseen` | Both exit 0 |
| TC-PLUG-004 | FR-PLUG-004 | integration | The repository | Read `plugins/luseen/.mcp.json` | It has exactly one server, `luseen`: command `npx`, args `["-y", "luseen@<package version>", "mcp"]`, and no argument names a variable |
| TC-PLUG-005 | FR-PLUG-005 | integration | The repository | Read `plugins/luseen/hooks/hooks.json` | `hooks.PostToolUse` is one entry with matcher `mcp__plugin_luseen_luseen__.*` and one command hook with command `npx` and args `["-y", "luseen@<package version>", "session-link"]`; the matcher matches `mcp__plugin_luseen_luseen__workflow_status` and not `mcp__luseen__workflow_status` or `mcp__plugin_other_x__y` |
| TC-PLUG-006 | FR-PLUG-006 | e2e | A set-up project with a change in progress, and a planning session started with `plan_begin` | Pipe hook JSON with `tool_name` `mcp__plugin_luseen_luseen__workflow_status`, then `mcp__plugin_luseen_luseen__plan_begin` with that session's ID, to `luseen session-link` | The Claude session is linked to the change, then recorded on the planning session, exactly as with the `mcp__luseen__` names |
| TC-PLUG-007 | FR-PLUG-006 | unit | — | Read the planning ID from tool calls named `mcp__plugin_luseen_luseen__plan_resume` and `mcp__luseen__plan_resume` | Both give the same ID; a `mcp__plugin_luseen_luseen__workflow_status` call gives none |
| TC-PLUG-008 | FR-PLUG-007 | e2e | A folder with no `.luseen/sdd` | Start `luseen mcp`, list tools, call `workflow_status` | The server starts; the only tool is `workflow_status`; its answer says the project isn't set up and names `/luseen:init`; stdout carries only MCP messages |
| TC-PLUG-009 | FR-PLUG-007 | e2e | A set-up project | Start `luseen mcp` and list tools | Every tool of FR-MCP-007 is offered, as before |
| TC-PLUG-010 | FR-PLUG-008 | integration | The repository | Compare each `plugins/luseen/skills/<skill>/SKILL.md` for the nine agent skills with what `luseen skills` writes into an empty project's `.agents/skills/` | They are byte-identical |
| TC-PLUG-011 | FR-PLUG-009, FR-PLUG-010 | integration | The repository | Read the `init`, `plan`, `status` and `gui` skills | Each has a `name` and `description`; `init` contains `npx -y luseen@<package version> --yes --plugin`, a step that asks the user before running it, and a step for an already set-up project; `plan` names `plan_begin` as the first call; `status` names `workflow_status` and `tasks_list`; `gui` contains `npx -y luseen@<package version> gui --no-open --json` |
| TC-PLUG-012 | FR-PLUG-011 | integration | The repository | Read `plugins/luseen/agents/pm.md` | Its frontmatter `name` is `pm`; `tools` is exactly `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` and the five `mcp__plugin_luseen_luseen__plan_*` tools; the body contains the `product-engineer` instructions |
| TC-PLUG-013 | FR-PLUG-012 | integration | The repository | Run the plugin build into a temporary folder and compare with the committed files | Every file matches; changing `package.json`'s version in a copy makes the comparison fail, naming the files that differ |
| TC-PLUG-014 | FR-PLUG-013 | e2e | An empty project | Run `luseen skills <project> --plugin` | `AGENTS.md` and `CLAUDE.md` hold the managed sections; the skills table names `/luseen:<skill>` and not `.agents/skills`; `.agents/`, `.claude/` and `.mcp.json` don't exist |
| TC-PLUG-015 | FR-PLUG-013 | e2e | A sample project and the fake `claude` | Run `luseen <project> --yes --plugin` | Documents are generated; only the `AGENTS.md` and `CLAUDE.md` sections are installed, as in TC-PLUG-014 |
| TC-PLUG-016 | FR-PLUG-014 | integration | The repository | Read `README.md` | It contains `/plugin marketplace add <owner>/<repo>` with the repository from `package.json`, `/plugin install luseen@luseen`, and `/luseen:init` |
| TC-PLUG-017 | FR-PLUG-001 to FR-PLUG-011 | manual | Claude Code, `luseen` published to npm at the plugin's version, and the repository pushed | Add the marketplace and install the plugin, open a project that isn't set up, run `/mcp`, ask for the status, run `/luseen:init` and answer yes, then `/luseen:plan`, `/luseen:status` and `/luseen:gui` | The server connects; status says to run `/luseen:init`; init asks, then sets up the project with no skill folders, MCP entry or hook; plan starts with `plan_begin`; status summarises; gui gives a working link; the session appears on the board |
| TC-PLUG-018 | FR-PLUG-015 | integration | The repository | Read `plugins/luseen/.claude-plugin/icon.png` | It equals `assets/luseen-icon.png`, is a PNG, square, 512 to 2048 px on each side, and under 2 MB |
