# File discovery: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-DISC-001 | FR-DISC-004, FR-DISC-006, FR-DISC-007 | Specs describe my project, not its libraries | On real Node, .NET, Python, Java and Go projects, the report contains no dependency code, DLLs or other binaries, lockfiles or build output among the included files |
| VAL-DISC-002 | FR-DISC-005, FR-DISC-006, FR-DISC-012 | My own code and documents aren't missed | My code in folders such as `lib/`, `bin/` and `packages/` is analysed, as are my PDF, DOCX and Markdown documents |
| VAL-DISC-003 | FR-DISC-008, FR-DISC-009 | My secrets stay on my machine | Environment files and keys are never read, and known secret formats in code never reach Claude |
| VAL-DISC-004 | FR-DISC-001, FR-DISC-002, FR-DISC-003 | I control what's included | My `.gitignore` is respected, and `--include`, `--exclude` and `.cclinicignore` work as I expect, but can't expose secrets |
| VAL-DISC-005 | FR-DISC-012, FR-DISC-013, FR-DISC-014 | I can see what happened to every file | The report explains why each skipped file or folder was skipped, and an empty result gives me a clear explanation |
| VAL-DISC-006 | FR-DISC-010, FR-DISC-011 | Scans are safe and consistent | Scans never leave the chosen folder or hang on links, and an unchanged project gives the same result each time |
