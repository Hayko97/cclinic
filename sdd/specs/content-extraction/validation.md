# Content extraction: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-EXT-001 | FR-EXT-001, FR-EXT-002, FR-EXT-003 | All my documents and code are understood | Requirements described only in my PDF, DOCX or Markdown documents show up in the generated specs |
| VAL-EXT-002 | FR-EXT-002 | Complex PDFs are readable | With real multi-column and table-heavy PDFs, the extracted text is good enough for useful specs. If not, the library choice is reopened |
| VAL-EXT-003 | FR-EXT-001, FR-EXT-002, FR-EXT-003, FR-EXT-006 | I can trace claims back to a source | A cited line, page or heading leads me to the text behind the requirement |
| VAL-EXT-004 | FR-EXT-004, FR-EXT-007 | One bad file doesn't ruin the run | A scanned, encrypted or corrupt document produces a warning that names the file, and everything else still gets processed |
| VAL-EXT-005 | FR-EXT-005 | Large files are fully covered | Content near the end of a very large file is reflected in the specs |
| VAL-EXT-006 | FR-EXT-007 | Reading files stays on my machine | No network connection is needed to read and extract files |
