# local-environment: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-ENV-001 | FR-ENV-001, FR-ENV-002 | Any coding agent can set up my environment | After setup, the `devops` skill is available to my agent, and it never commits or pushes while using it |
| VAL-ENV-002 | FR-ENV-003, FR-ENV-004, FR-ENV-005 | Nothing runs my code without my agreement | Setup tells me what will happen and asks first. Scripts and CI don't start it unless they ask for it, and I can turn it off |
| VAL-ENV-003 | FR-ENV-006 | I can set this up later | Running one command sets up the environment on a project, even with no documents yet |
| VAL-ENV-004 | FR-ENV-007 | I'm not stuck without the Claude CLI | I get one sentence to give my own coding agent, and setup still succeeds |
| VAL-ENV-005 | FR-ENV-008, FR-ENV-009 | This step can't get out of hand | It can't run `git` or `sudo` directly, it uses my login rather than my API key, and it stops at a clear time and cost limit |
| VAL-ENV-006 | FR-ENV-010, FR-ENV-011 | I know what happened | I see how to preview the project, or a clear failure, and I'm told about any file changed outside the environment folder. A failure here doesn't lose my documents |
| VAL-ENV-007 | FR-ENV-012, FR-ENV-013 | Re-running stays cheap | Running `cclinic` again doesn't set up the environment again or reprocess anything because of it |
| VAL-ENV-008 | FR-ENV-014, FR-ENV-016 | I get the right kind of preview | A website gets a link, a mobile app gets a simulator build, and a command-line tool gets a command. When it's unclear, I'm asked |
| VAL-ENV-009 | FR-ENV-015, FR-ENV-021 | The link is easy to recognise | My project's name is in the link, and if that link can't work, I get a plain `localhost` link that does |
| VAL-ENV-010 | FR-ENV-017, FR-ENV-020, FR-ENV-034 | A web project starts with one command | The project is running and ready when the command ends, without disturbing my other projects |
| VAL-ENV-011 | FR-ENV-018 | My Docker setup is safe | My existing Docker files are unchanged |
| VAL-ENV-012 | FR-ENV-019, FR-ENV-022 | The environment is safe to run | Other computers on my network can't reach it, my secrets aren't copied into it, and production isn't touched |
| VAL-ENV-013 | FR-ENV-023, FR-ENV-024 | I'm told what's missing | If Docker or a simulator isn't available, I'm told what I need, and nothing gets installed without me |
| VAL-ENV-014 | FR-ENV-025, FR-ENV-026 | Projects that aren't web apps also work, and reports are honest | A tool or library gets a real command to try, with no needless Docker, and a failed start is reported as failed |
| VAL-ENV-015 | FR-ENV-027, FR-ENV-028, FR-ENV-029 | I can try each change myself | Before I'm asked to approve, I get a link or build showing this exact change, what to look at, and how to stop it |
| VAL-ENV-016 | FR-ENV-030, FR-ENV-031 | Previews don't get in the way | A failed preview is explained and I can still review, and a documentation change doesn't start one |
| VAL-ENV-017 | FR-ENV-032 | My local data is safe | The preview stays up while I look, and my data isn't deleted without my say |
| VAL-ENV-018 | FR-ENV-033 | I stay in charge of commits | Environment files are committed only when I agree |
