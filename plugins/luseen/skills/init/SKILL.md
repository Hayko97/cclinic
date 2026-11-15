---
name: init
description: "Sets up luseen in this project: analyses it with Claude, writes its specs to .luseen/sdd, and adds luseen's section to AGENTS.md and CLAUDE.md. Use when the user asks to set up luseen, or a luseen tool says the project isn't set up."
---

# Set up luseen in this project

1. **Check whether it's set up.** If `.luseen/sdd` exists in the project root, tell the user the project is already set up, and stop. Change nothing.
2. **Ask first.** Tell the user that setup analyses the whole project with Claude, using their Claude usage, and can take several minutes. It writes the specs to `.luseen/sdd` and adds luseen's section to `AGENTS.md` and `CLAUDE.md`. Ask whether to start, and wait for their answer.
3. **If they say no,** do nothing more.
4. **If they say yes,** run `npx -y luseen@0.1.1 --yes --plugin` in the project root. It can take longer than a command's usual time limit, so run it in the background if you can, and wait for it to finish. Report its result: the specs and requirements it wrote, or the error it printed and the fix it gives, such as installing the `claude` executable.
5. **Connect the tools.** Once it succeeds, tell the user to run `/mcp` and reconnect the `luseen` server, so luseen's tools work with the new documents.
