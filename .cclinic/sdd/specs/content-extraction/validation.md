# content-extraction: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-EXT-001 | FR-EXT-001, FR-EXT-012 | Requirements stated in code, config, Markdown and text files appear in generated specs with line references. | A requirement that exists only in a text or Markdown file shows up in the specs with a line citation that leads to the source; a file with bad characters or an empty file does not stop the run. |
| VAL-EXT-002 | FR-EXT-002, FR-EXT-005 | Requirements that exist only in PDFs are captured and traceable to a page. | A requirement only in a PDF appears in the specs with a page citation, and for real multi-column and table-heavy PDFs the text is good enough for useful specs; otherwise the PDF library choice is reopened. |
| VAL-EXT-003 | FR-EXT-003 | Requirements that exist only in Word documents are captured and traceable to a heading. | A requirement only in a DOCX, including in a table, appears in the specs citing the nearest heading. |
| VAL-EXT-004 | FR-EXT-004, FR-EXT-005, FR-EXT-006, FR-EXT-010 | Unreadable documents are reported, not silently lost, and do not block the rest of the work. | For scanned, partly scanned, encrypted, corrupt and legacy .doc files the report names each file with a warning, and the other files are still processed. |
| VAL-EXT-005 | FR-EXT-007 | Very large files are fully reflected in the specs. | Content near the end of a very large file is reflected in the generated specs and no truncation notice or loss occurs. |
| VAL-EXT-006 | FR-EXT-009 | Project files are read without leaving the machine during extraction. | Reading and extracting files works with no network connection. |
| VAL-EXT-007 | FR-EXT-008, FR-EXT-011 | Results are reliable and installing cclinic's own instructions does not look like a project change. | Each analysed file is identified by a fingerprint of its original content, and adding or changing only cclinic's AGENTS.md section does not change that file's fingerprint. |
