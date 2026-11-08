# spec-output: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-OUT-001 | FR-OUT-001, FR-OUT-003, FR-OUT-020 | I get one folder of project documents that an AI tool or new developer can start from. | After a run, the output folder contains the overview, stack, architecture, guidelines, open-questions, scan report and manifest, and the README lists every spec and explains how to read the set. |
| VAL-OUT-002 | FR-OUT-002, FR-OUT-004 | Each capability has its own requirements, acceptance criteria and test cases that I can read or hand off alone. | Each spec folder has exactly three files, with the acceptance and test tables showing the expected columns and the test setup coming first in the test file. |
| VAL-OUT-003 | FR-OUT-005, FR-OUT-006 | I am not given documents with broken links, missing coverage or invalid citations. | A faulty draft stops the run with a complete list of problems and a failure exit, previous documents are unchanged, and the rejected draft can be inspected. |
| VAL-OUT-004 | FR-OUT-007, FR-OUT-008, FR-OUT-013 | A crash or failure never leaves me with half-written or lost documentation. | After an interrupted or failed run the folder holds either the complete old or the complete new set, a later run works, and no leftover temporary folders remain. |
| VAL-OUT-005 | FR-OUT-009, FR-OUT-010, FR-OUT-011, FR-OUT-012 | My hand-edited documents and unrelated folders are not replaced by accident, and I learn this before any usage is spent. | Without --force, edited documents or an unrelated non-empty folder cause an immediate refusal naming the problem and no Claude usage; with --force they are replaced and the overwritten files are reported. |
| VAL-OUT-006 | FR-OUT-014, FR-OUT-015, FR-OUT-016 | Git diffs show only meaningful changes and tables display correctly. | Cache and failed drafts do not show up in git status, two runs on an unchanged project give identical Markdown apart from the manifest time, and table text with pipes or line breaks stays in its cell. |
| VAL-OUT-007 | FR-OUT-017, FR-OUT-018 | I can see what was analysed or skipped and which model produced the output, without any secrets exposed. | The scan report and manifest show totals, skipped paths with reasons, warnings, redaction counts, model and provider, and contain no secret values. |
| VAL-OUT-008 | FR-OUT-019, FR-OUT-020 | Developer guidelines are consistent and stack documents are honest about gaps. | Guidelines always contain the standard baseline with labelled stack-specific advice (and a note if no language was found), and stack.md says when a category was not found. |
