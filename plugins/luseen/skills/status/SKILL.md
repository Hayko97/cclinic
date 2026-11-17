---
name: status
description: "Shows where the current change stands in luseen's workflow, and the open tasks. Use when the user asks for the status, the current change, or what's waiting for them."
---

# Show the status

1. **If the luseen MCP tools aren't available,** run `npx -y luseen@0.1.2 tasks list --json` in the project root, and sum up the open tasks, with their ID, title and status. Tell the user that the current change's status needs luseen's MCP server, which `/luseen:init` adds, and stop.
2. Call the luseen MCP tool `workflow_status`. If it says the project isn't set up, tell the user to run `/luseen:init`, and stop.
3. Call `tasks_list`.
4. Sum up in a few lines: the open change, with its step, spec and task, and the approval it's waiting for, if any; then the open tasks, with their ID, title and status. Say so when there's no open change or no open task.
