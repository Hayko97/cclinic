---
name: status
description: "Shows where the current change stands in luseen's workflow, and the open tasks. Use when the user asks for the status, the current change, or what's waiting for them."
---

# Show the status

1. Call the luseen MCP tool `workflow_status`. If it says the project isn't set up, tell the user to run `/luseen:init`, and stop.
2. Call `tasks_list`.
3. Sum up in a few lines: the open change, with its step, spec and task, and the approval it's waiting for, if any; then the open tasks, with their ID, title and status. Say so when there's no open change or no open task.
