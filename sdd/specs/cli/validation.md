# CLI: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-CLI-001 | FR-CLI-001, FR-CLI-002 | I can run it on any project with one command | Running `cclinic` in a project, or `cclinic <path>`, works without reading any documentation first. `--help` shows everything needed |
| VAL-CLI-002 | FR-CLI-001, FR-CLI-002 | A mistake gives me a helpful answer | A wrong path or option produces a message saying what was wrong and how to fix it, and nothing else happens |
| VAL-CLI-003 | FR-CLI-003 | I can preview before using any Claude usage | `--dry-run` shows what would be included and skipped, and leaves the project unchanged |
| VAL-CLI-004 | FR-CLI-004, FR-CLI-005 | I decide before my code is sent anywhere | Before anything is sent, I can see where it's going, how much, with which model and login, and can say no |
| VAL-CLI-005 | FR-CLI-005, FR-CLI-007 | It can run safely in scripts | In a script, it never hangs waiting for input, and the exit code tells the script what happened |
| VAL-CLI-006 | FR-CLI-006, FR-CLI-012 | I can follow what it's doing | Progress stays visible during a long run, and the end result clearly says where the documents are, what was created, and what it used |
| VAL-CLI-007 | FR-CLI-008 | Help answers my questions | Someone new can work out how to use any command from its help alone, and a typo suggests the right word |
| VAL-CLI-008 | FR-CLI-009, FR-CLI-011 | Output suits where I'm running it | I can make it quieter or more detailed, and it never prints color codes into logs or files |
| VAL-CLI-009 | FR-CLI-010 | Scripts can read the result | A script can read the result of any run as JSON, including failures, without parsing text |
| VAL-CLI-010 | FR-CLI-013, FR-CLI-015 | I can fix setup problems myself | When something isn't set up, `cclinic doctor` tells me what's wrong and how to fix it, without using any Claude usage |
| VAL-CLI-011 | FR-CLI-014 | I can clear stored results safely | `cclinic clean` frees the space and never touches my generated documents |
| VAL-CLI-012 | FR-CLI-016, FR-CLI-017, FR-CLI-018 | Interruptions and mistakes don't cause damage | Ctrl+C stops quickly, keeps finished work, and a second run on the same folder can't corrupt the first |
| VAL-CLI-013 | FR-CLI-019, FR-CLI-020 | A mistake can't send or cost far more than I intended | Running in the wrong folder or on an unexpectedly huge project stops before anything is sent, and tells me how to continue if I meant it |
| VAL-CLI-014 | FR-CLI-021 | I know where my data goes | cclinic sends nothing anywhere except to Anthropic through my chosen provider, plus the npm version check in `doctor` |
| VAL-CLI-015 | FR-CLI-008, FR-CLI-022 | I can learn how it works from the terminal | Someone new can get from installing cclinic to working with their coding agent using only `--help` and `cclinic guide` |
