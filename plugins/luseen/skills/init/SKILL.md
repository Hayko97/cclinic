---
name: init
description: "Sets up luseen in this project: analyses it with Claude, writes its specs to .luseen/sdd, and adds luseen's section to AGENTS.md and CLAUDE.md. Use when the user asks to set up luseen, or a luseen tool says the project isn't set up."
---

# Set up luseen in this project

1. **Check for an empty folder.** If the project root has no `.luseen/sdd` and nothing to analyse, such as no code and no documents, setup can't write specs from it. Don't run setup. Tell the user to start a new project with the PM instead: run `npx luseen` in a terminal, or `npx luseen gui` for the browser, in the project folder. Then stop.
2. **Check whether it's set up.** If `.luseen/sdd` exists in the project root and `.mcp.json` there has a `luseen` server, tell the user the project is already set up, and stop. Change nothing.
3. **If only the server is missing,** because `.luseen/sdd` exists but `.mcp.json` has no `luseen` server: tell the user you'll add luseen's local MCP server to `.mcp.json` and its hook to `.claude/settings.json`, without using their Claude usage. Ask whether to add them, and wait for their answer. If they say yes, run `npx -y luseen@0.1.4 skills --plugin` in the project root, report its result, and go to step 7.
4. **Otherwise, ask first.** Tell the user that setup analyses the whole project with Claude, using their Claude usage, and can take several minutes. It writes the specs to `.luseen/sdd`, adds luseen's section to `AGENTS.md` and `CLAUDE.md`, and adds luseen's local MCP server to `.mcp.json` and its hook to `.claude/settings.json`. Ask whether to start, and wait for their answer.
5. **If they say no,** do nothing more.
6. **If they say yes,** run `npx -y luseen@0.1.4 --yes --plugin` in the project root. It can take longer than a command's usual time limit, so run it in the background if you can, and wait for it to finish. Report its result: the specs and requirements it wrote, or the error it printed and the fix it gives, such as installing the `claude` executable.
7. **Connect the tools.** Once it succeeds, tell the user to restart Claude Code or run `/mcp`, and approve the project's `luseen` server, so luseen's tools work.
