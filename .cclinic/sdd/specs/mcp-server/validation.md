# mcp-server: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-MCP-001 | FR-MCP-001, FR-MCP-002, FR-MCP-003 | The server starts by itself and fails clearly | Opening the project in Claude Code starts the server with no command from me; a wrong option or a project without cclinic docs gives a clear message instead of a broken session |
| VAL-MCP-002 | FR-MCP-004, FR-MCP-005 | Setting it up takes nothing extra | Running `cclinic` adds the server to `.mcp.json` without touching my other servers, and shows me what to add for Codex |
| VAL-MCP-003 | FR-MCP-006 | The new dependency is justified and contained | The MCP library is listed with its reason, and only one part of cclinic uses it |
| VAL-MCP-004 | FR-MCP-007, FR-MCP-008, FR-MCP-016 | The agent has the tools it needs, and bad calls do no harm | The agent sees the listed tools and resources, and a tool called with wrong input explains what's wrong and changes nothing |
| VAL-MCP-005 | FR-MCP-009, FR-MCP-038 | The agent always knows where the work stands | After `/clear` or a new session, the agent carries on from the same step, with the same counts and approvals |
| VAL-MCP-006 | FR-MCP-010 | Each change starts in the right place | A feature or bug starts at the spec, a refactor starts at implementation, and a second change can't start while one is open |
| VAL-MCP-007 | FR-MCP-011, FR-MCP-012, FR-MCP-013 | Tasks are tracked without the agent remembering to | Tasks look the same as with `cclinic tasks`, the next ready task is found for me, a task an auto run holds can't be taken, and a task is done only when I approve the change |
| VAL-MCP-008 | FR-MCP-014 | QA gets what it needs to test independently | A separate QA agent gets the spec, its test cases and the changed files in one call |
| VAL-MCP-009 | FR-MCP-015 | I can check an auto run from my coding tool | Asking the agent about the auto run shows its progress, task by task, and its cost, and changes nothing |
| VAL-MCP-010 | FR-MCP-017, FR-MCP-027 | Steps can't be skipped or done out of order | The agent can't start coding before the spec is approved or reach approval before QA and review, and a wrong spec can be sent back for approval again |
| VAL-MCP-011 | FR-MCP-018 | I decide on the spec exactly as today | I'm asked to approve, refine or get a review doc; refine sends my notes to the agent; after a review doc I'm asked only approve or refine |
| VAL-MCP-012 | FR-MCP-019, FR-MCP-020 | QA can't loop forever | After 3 failing QA runs the agent stops and reports, and goes on only if I agree |
| VAL-MCP-013 | FR-MCP-021, FR-MCP-022 | Code is reviewed before I see it, and fixes are tested | I only reach the preview after a review approves the change, every review fix is tested again, and review stops after 3 rounds |
| VAL-MCP-014 | FR-MCP-023 | I always get a preview, or know why not | Before I approve, the project's local environment is started and I get a link, or I'm told why it couldn't start |
| VAL-MCP-015 | FR-MCP-024 | My approval or change request is acted on | Approving marks the task done; requesting changes sends my notes to the agent and the change goes through QA and review again |
| VAL-MCP-016 | FR-MCP-025, FR-MCP-040 | Nothing is committed without me | The change is committed only if I say yes, only its own files are included, cclinic itself never commits or pushes, and it changes only its own state files |
| VAL-MCP-017 | FR-MCP-026 | Only I can skip a step | A step is skipped only when I confirm it, and the skip is recorded |
| VAL-MCP-018 | FR-MCP-028, FR-MCP-029, FR-MCP-030 | The agent can't approve for me | Approval questions come to me, not the agent; if my tool can't show them I answer in a terminal, which an agent can't do; every decision is recorded with who made it |
| VAL-MCP-019 | FR-MCP-031, FR-MCP-034 | Auto runs still get approved, by the PM agent | In an auto run, the PM agent approves the spec and the finished change, no preview is needed, and nobody is asked |
| VAL-MCP-020 | FR-MCP-032, FR-MCP-033 | Auto runs are tested and reviewed independently | The developer agent can't report its own QA or review; separate QA and reviewer agents do it |
| VAL-MCP-021 | FR-MCP-035, FR-MCP-036, FR-MCP-037 | Auto runs stay within limits | A task that can't get approved, tested or reviewed within 3 rounds is blocked with the reason, bad agent replies count as rejections, and the budget is never exceeded |
| VAL-MCP-022 | FR-MCP-039 | Secrets don't leak into saved state | No secret appears in the workflow state, feedback or logs |
| VAL-MCP-023 | FR-MCP-041 | The new state doesn't disturb cclinic | Cleaning keeps the workflow state, and it never changes analysis or generated docs |
| VAL-MCP-024 | FR-MCP-042 | Adding the server doesn't cost me a re-analysis | After cclinic adds itself to `.mcp.json`, running `cclinic` again doesn't treat the project as changed |
| VAL-MCP-025 | FR-MCP-043 | A change I stop doesn't block my next one | After QA stops a change and I choose not to continue, the agent can start a new change right away, and my task is left as it was |
| VAL-MCP-026 | FR-MCP-044, FR-MCP-045 | The Claude Code sessions I work on a change in are linked to it without extra steps | After I use cclinic's tools in a Claude Code session, that session is listed on the change's task or spec, and my session is never slowed or broken by it |
