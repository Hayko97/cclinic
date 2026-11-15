# claude-plugin: validation

Acceptance criteria in plain language.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-PLUG-001 | FR-PLUG-001, FR-PLUG-002, FR-PLUG-003, FR-PLUG-014 | I can install Luseen into Claude Code from its repository | Following the README, `/plugin marketplace add` and `/plugin install luseen@luseen` install the plugin with no errors, and `/plugin` lists it at the package's version |
| VAL-PLUG-002 | FR-PLUG-004, FR-PLUG-007 | Luseen's tools are there in every project, without setting anything up per project | After installing, `/mcp` shows the luseen server connected in any project; in a project that isn't set up, asking for the status tells me to run `/luseen:init` |
| VAL-PLUG-003 | FR-PLUG-009, FR-PLUG-013 | I set up a project from Claude Code | `/luseen:init` asks before using my Claude usage, then sets up `.luseen/sdd` and the agent instructions, without adding skill folders, an MCP entry or a hook to my project |
| VAL-PLUG-004 | FR-PLUG-008, FR-PLUG-010, FR-PLUG-011 | I can plan, follow and watch my work from Claude Code | `/luseen:plan` starts a planning conversation that can't change my files, `/luseen:status` tells me where my change stands, and `/luseen:gui` gives me a link to the board |
| VAL-PLUG-005 | FR-PLUG-005, FR-PLUG-006 | My Claude Code sessions show up on the board | After using the plugin's tools in a session, the GUI shows that session on its task or planning session |
| VAL-PLUG-006 | FR-PLUG-012 | The plugin never drifts from the CLI it runs | A release always has the plugin at the package's version, with the same skills `luseen skills` installs |
| VAL-PLUG-007 | FR-PLUG-015 | Luseen is recognisable in the plugin directory | The plugin shows the Luseen logo, a moon in an eye, when submitted to Anthropic's directory |
