---
name: plan
description: "Plans a roadmap of milestones and tasks, or one concrete task, with luseen's PM, in a conversation with the user. Use when the user wants to plan, build a roadmap, create or refine tasks, or decide what to build next."
---

# Plan with luseen

The user's request: $ARGUMENTS

1. **Check for the tools.** If the luseen MCP tool `plan_begin` isn't available, tell the user to run `/luseen:init`, which adds luseen's MCP server to the project, and stop.
2. **Know what to plan.** If the request doesn't say whether to plan a new roadmap, more milestones for a roadmap, or one task, ask the user, and wait.
3. **Begin the planning session.** Before any other tool call, call the luseen MCP tool `plan_begin` with the target and the user's request in their words. Use the planning ID it returns with every other plan tool.
4. **Plan as the `product-engineer` skill says,** from its steps, skipping how it begins a session.
