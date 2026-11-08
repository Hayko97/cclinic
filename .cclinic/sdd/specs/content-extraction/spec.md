# content-extraction

## Goal

Extract text with positions (line numbers, pages, headings) from code, text, PDF and DOCX files locally. Tolerate per-file failures with warnings, never silently truncate, and split large files into position-preserving chunks.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-EXT-001 | The system must read code, config, Markdown and plain-text files (.txt, .rst, .adoc) as UTF-8 text keeping line numbers, and must replace invalid UTF-8 bytes and record a per-file warning instead of failing. | confirmed | `sdd/specs/content-extraction/spec.md:9`, `sdd/specs/content-extraction/verification.md:9-11`, `src/adapters/extraction/extract.ts:31-166` |
| FR-EXT-002 | The system must extract PDF text with pdfjs-dist and keep the page number of each piece of text. | confirmed | `sdd/specs/content-extraction/spec.md:10`, `sdd/specs/content-extraction/verification.md:12`, `src/adapters/extraction/extract.ts:47` |
| FR-EXT-003 | The system must extract DOCX text with mammoth, keeping headings and table contents, and must map each piece of text to its nearest heading so it can be cited as document.docx#Heading. | confirmed | `sdd/specs/content-extraction/spec.md:11`, `sdd/specs/content-extraction/verification.md:14`, `src/adapters/extraction/extract.ts:124` |
| FR-EXT-004 | The system must treat a PDF averaging under 20 non-space characters per page as having no extractable text, produce a warning naming the file, and continue without its content. | confirmed | `sdd/specs/content-extraction/spec.md:12-13`, `sdd/specs/content-extraction/verification.md:15`, `src/adapters/extraction/extract.ts:31-166` |
| FR-EXT-005 | For a partly scanned PDF the system must extract the pages that have text and must warn listing the pages that had no text. | confirmed | `sdd/specs/content-extraction/spec.md:24`, `sdd/specs/content-extraction/verification.md:16` |
| FR-EXT-006 | The system must produce a warning in scan-report.md for encrypted, password-protected or corrupt PDF/DOCX files and for legacy .doc files, and must continue the run without them. | confirmed | `sdd/specs/content-extraction/spec.md:12-16`, `sdd/specs/content-extraction/verification.md:17`, `src/adapters/extraction/extract.ts:31-166` |
| FR-EXT-007 | The system must split files too large for one request into chunks that keep their line or page positions, must never silently truncate content, and the chunks must join back to the original text exactly. | confirmed | `sdd/specs/content-extraction/spec.md:17`, `sdd/specs/content-extraction/verification.md:18`, `src/core/chunking.ts:47-138`, `src/core/constants/limits.ts:21` |
| FR-EXT-008 | Each extracted file must record its path, type, SHA-256 hash of the original bytes and text with positions, and later stages must use only this form. | confirmed | `sdd/specs/content-extraction/spec.md:18`, `sdd/specs/content-extraction/verification.md:19` |
| FR-EXT-009 | Extraction must run locally with no network access. | confirmed | `sdd/specs/content-extraction/spec.md:19`, `sdd/specs/content-extraction/verification.md:20`, `sdd/specs/content-extraction/validation.md:12` |
| FR-EXT-010 | A failure while extracting one file must not stop extraction of the other files. | confirmed | `sdd/specs/content-extraction/spec.md:19`, `sdd/specs/content-extraction/verification.md:21`, `sdd/specs/content-extraction/validation.md:10` |
| FR-EXT-011 | The system must remove cclinic's own managed section from AGENTS.md before hashing and analysis. | confirmed | `sdd/specs/content-extraction/spec.md:23`, `src/adapters/extraction/extract.ts:144-147` |
| FR-EXT-012 | Empty files must be recorded as included with nothing to send, and images inside PDF and DOCX files must be ignored. | docs-only | `sdd/specs/content-extraction/spec.md:25-26` |

## Edge cases

- Invalid UTF-8 bytes in a text file: replaced, warning names the file, no error.
- Scanned PDF with no text: warning, no content, run continues.
- Partly scanned PDF: text pages kept, warning lists empty pages.
- Encrypted, password-protected or corrupt PDF/DOCX: warning in scan-report.md, other files still processed.
- Legacy .doc file: warning, not extracted.
- File larger than the request limit: chunked, joined chunks equal the original.
- Empty file: included with nothing to send.
- Images in PDF/DOCX: ignored.
- Multi-column or table-heavy PDFs: readability must be checked manually.
- AGENTS.md containing a cclinic section: section removed before hashing.

## Non-goals

- OCR or image understanding.
- Exact layout preservation.
- Spreadsheets, slide decks and other formats (treated as unsupported binary files).
- Deciding which files are included (covered by file-discovery).
- Defining chunk size and summarising (covered by spec-analysis).
