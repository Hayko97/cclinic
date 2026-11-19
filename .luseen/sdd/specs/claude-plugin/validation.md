# claude-plugin: validation

Acceptance criteria in plain language.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-PLUG-001 | FR-PLUG-001, FR-PLUG-002, FR-PLUG-003, FR-PLUG-014 | I can install Luseen into Claude Code from its repository | Following the README, `/plugin marketplace add` and `/plugin install luseen@luseen` install the plugin with no errors, and `/plugin` lists it at the package's version |
| VAL-PLUG-002 | FR-PLUG-004, FR-PLUG-005, FR-PLUG-016 | Luseen can be listed in Anthropic's plugin directory although we aren't a Verified organization | Submitting the plugin in the developer portal shows no "accepted only from Verified organizations" finding |
| VAL-PLUG-003 | FR-PLUG-009, FR-PLUG-013 | I set up a project from Claude Code, and know what it adds | `/luseen:init` tells me it will use my Claude usage and add luseen's MCP server and hook to my project, asks first, then sets up `.luseen/sdd`, the agent instructions, the MCP server and the hook, without skill folders; after I approve the server, `/mcp` shows it connected |
| VAL-PLUG-004 | FR-PLUG-007, FR-PLUG-008, FR-PLUG-016, FR-PLUG-010, FR-PLUG-011 | I can plan, follow and watch my work from Claude Code | `/luseen:plan` starts a planning conversation that can't change my files, `/luseen:status` tells me where my change stands, and `/luseen:gui` gives me a link to the board; before setup, status and plan tell me to run `/luseen:init` |
| VAL-PLUG-005 | FR-PLUG-006, FR-PLUG-013 | My Claude Code sessions show up on the board | After using luseen's tools in a set-up project, the GUI shows that session on its task or planning session |
| VAL-PLUG-008 | FR-PLUG-013 | Installing luseen from npm still works as before | Running `luseen` from npm in a project installs the skill folders, the agent instructions, the MCP server and the hook, exactly as before the plugin changed |
| VAL-PLUG-006 | FR-PLUG-012 | The plugin never drifts from the CLI it runs | A release always has the plugin at the package's version, with the same skills `luseen skills` installs |
| VAL-PLUG-007 | FR-PLUG-015 | Luseen is recognisable in the plugin directory | The plugin shows the Luseen logo, a moon in an eye, when submitted to Anthropic's directory |
