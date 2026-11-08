# cli-commands: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-CLI-001 | FR-CLI-001, FR-CLI-002, FR-CLI-019 | Run cclinic in a project or on a path without reading docs first. | Running cclinic, cclinic <path> and --help works for each command, and a wrong path or typo gives a helpful message with no other action. |
| VAL-CLI-002 | FR-CLI-003, FR-CLI-004, FR-CLI-005, FR-CLI-006 | Control a run with clear options and sensible limits. | Documented options are accepted, out-of-range values are rejected with a clear message before any work, and options override environment settings which override saved defaults. |
| VAL-CLI-003 | FR-CLI-007 | Preview what would be analysed safely. | A dry run shows included and skipped files and leaves the project unchanged with no Claude usage. |
| VAL-CLI-004 | FR-CLI-008, FR-CLI-009 | Know what is sent and be able to decline. | Before sending, the user sees destination, volume, model and login, can answer no with nothing sent, and scripts without a terminal never hang. |
| VAL-CLI-005 | FR-CLI-010, FR-CLI-011, FR-CLI-014, FR-CLI-016 | Use cclinic reliably in scripts. | Results are separate from progress, JSON output is one readable object including failures, exit codes reflect the outcome, and failure messages say re-running continues. |
| VAL-CLI-006 | FR-CLI-012, FR-CLI-013 | Adjust verbosity and avoid color codes in logs. | Quiet and debug modes behave as described, conflicting use is rejected, no secrets or file contents appear, and no color codes appear in logs or files. |
| VAL-CLI-007 | FR-CLI-015 | Be told clearly when Node.js is too old. | An old Node.js shows a message naming the required version and exits with the usage error. |
| VAL-CLI-008 | FR-CLI-017, FR-CLI-025 | Diagnose setup problems without using Claude. | doctor lists checks with fixes, never shows the key, uses no Claude usage, and the only network use is the provider and npm version check. |
| VAL-CLI-009 | FR-CLI-018 | Free stored-result space without losing documents. | clean removes cache and failed drafts after confirmation, reports space freed and leaves generated documents unchanged. |
| VAL-CLI-010 | FR-CLI-020, FR-CLI-021, FR-CLI-022 | Interruptions and concurrent runs do not corrupt work. | Ctrl+C stops quickly keeping finished work, unwritable folders are caught before sending, and a second run on the same folder is refused. |
| VAL-CLI-011 | FR-CLI-023, FR-CLI-024 | Be protected from running on the wrong or huge folder. | Home, root or oversized projects stop before sending, with an explanation of how to proceed deliberately. |
| VAL-CLI-012 | FR-CLI-019 | Learn the workflow from the terminal. | cclinic guide works offline and covers steps, commands, skills, limits and exit codes. |
| VAL-CLI-013 | FR-CLI-026, FR-CLI-027 | Set a default model and install agent skills from the CLI. | model lists, sets and resets the default, and skills installs the skills without Claude usage. |
