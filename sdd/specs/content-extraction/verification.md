# Content extraction: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** keep small sample documents in `test/fixtures/documents/`: multi-page, scanned, partly scanned, encrypted and corrupt PDFs, plus DOCX and `.doc` files. Generate large files during the test.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-EXT-001 | FR-EXT-001 | unit | A text file of known content with several lines | Extract | The text and each line number are correct |
| TC-EXT-002 | FR-EXT-001 | unit | One each of `.ts`, `.json`, `.md`, `.txt`, `.rst` and `.adoc` | Extract | All are read with line numbers |
| TC-EXT-003 | FR-EXT-001 | unit | A file with invalid UTF-8 bytes | Extract | The bad bytes are replaced, a warning names the file, and no error is raised |
| TC-EXT-004 | FR-EXT-002 | integration | A 3-page PDF with a unique word per page | Extract | Each word is attributed to the right page |
| TC-EXT-005 | FR-EXT-002 | manual | Real multi-column and table-heavy PDFs | Extract and read the output | The text is readable enough for useful specs |
| TC-EXT-006 | FR-EXT-003 | integration | A DOCX with nested headings and a table | Extract | Headings and table text are present, and each piece of text maps to its nearest heading |
| TC-EXT-007 | FR-EXT-004 | integration | A scanned PDF | Extract | A warning names the file, and no text is returned |
| TC-EXT-008 | FR-EXT-004 | integration | A partly scanned PDF | Extract | Text pages are extracted, and the warning lists the empty pages |
| TC-EXT-009 | FR-EXT-004 | integration | An encrypted PDF, an encrypted DOCX, a corrupt PDF, a corrupt DOCX and a `.doc` file | Run the pipeline to the report stage | Each has a warning in `scan-report.md`, and the run continues |
| TC-EXT-010 | FR-EXT-005 | integration | A file larger than the request limit | Extract and chunk, then join the chunks | The joined text matches the original exactly, and positions are correct |
| TC-EXT-011 | FR-EXT-006 | unit | One file of each type | Extract | Each result has path, type, correct SHA-256 hash of the original bytes, and positioned text |
| TC-EXT-012 | FR-EXT-007 | integration | Network access blocked, and a spy on network calls | Extract all fixture types | No network attempts are made |
| TC-EXT-013 | FR-EXT-007 | integration | A corrupt file among good files | Extract all | All good files are extracted, and the bad file has a warning |
| TC-EXT-014 | FR-EXT-001, FR-EXT-002, FR-EXT-003 | manual | A project with requirements stated only in PDF, DOCX and Markdown | Run with a real provider | Those requirements appear, with correct citations |
