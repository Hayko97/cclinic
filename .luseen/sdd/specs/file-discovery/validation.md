# file-discovery: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-DISC-001 | FR-DISC-001, FR-DISC-005, FR-DISC-006, FR-DISC-007, FR-DISC-008 | Only my own code and documents are analysed, not dependencies, binaries, lockfiles, generated or build output. | On Node, .NET, Python, Java and Go projects, the list of included files contains no dependency code, binaries, lockfiles, minified, generated or build output files. |
| VAL-DISC-002 | FR-DISC-005, FR-DISC-006, FR-DISC-013 | My own code in folders like lib/, bin/ and packages/ and my PDF, DOCX and Markdown documents are analysed. | Files in lib/, bin/, src/ and a packages/ folder without NuGet packages appear as included, and PDF, DOCX and Markdown documents are included and labelled as documents. |
| VAL-DISC-003 | FR-DISC-002, FR-DISC-010, FR-DISC-011 | My secrets never leave my machine. | Environment files and keys are never read, even when forced with include patterns, and known secret formats in code appear only as [REDACTED:<type>] with reports showing just file and count. |
| VAL-DISC-004 | FR-DISC-001, FR-DISC-003, FR-DISC-004 | I can control which files are included. | .gitignore and .luseenignore are respected, --include restores skipped files, --exclude wins over --include, and none of these can expose secrets. |
| VAL-DISC-005 | FR-DISC-009, FR-DISC-014 | I understand why files were left out and can adjust size limits. | The report gives a reason for every skipped file or folder, oversized files are skipped by default and kept when I raise the size limit. |
| VAL-DISC-006 | FR-DISC-012, FR-DISC-013, FR-DISC-014 | Scans are safe and repeatable. | Scans stay within the chosen folder, do not hang on symlink loops, continue past unreadable files, and give the same result for an unchanged project. |
| VAL-DISC-007 | FR-DISC-015 | I get a clear explanation when there is nothing to analyse. | For a folder with nothing analysable, a clear message is shown, the command fails with a usage error and nothing is sent to Claude. |
