# Content extraction

## Goal

Turn every included file into text, with enough position information for generated requirements to cite where they came from.

## Requirements

- **FR-EXT-001** Code, config, Markdown and plain text files (`.txt`, `.rst`, `.adoc`) MUST be read as UTF-8 with line numbers kept. Invalid UTF-8 MUST be replaced rather than stopping the run, with a warning for that file.
- **FR-EXT-002** PDF text MUST be extracted with `pdfjs-dist`, keeping the page number of each piece of text.
- **FR-EXT-003** DOCX text MUST be extracted with `mammoth`, keeping headings and table contents. Evidence for DOCX files cites the nearest heading, as `document.docx#Heading`, because DOCX has no fixed pages.
- **FR-EXT-004** These files MUST produce a warning in `scan-report.md`, and the run MUST continue without them:
  - PDFs with no extractable text, such as scanned documents (under 20 non-space characters per page on average)
  - Encrypted or password-protected files
  - Corrupt files
  - Legacy `.doc` files
- **FR-EXT-005** Content MUST NOT be silently truncated. Files too large for one request MUST be split into chunks ([FR-ANA-004](../spec-analysis/spec.md#grouping-and-chunking)) that keep their line or page positions.
- **FR-EXT-006** Each extracted file MUST record its path, type, SHA-256 hash of the original bytes, and text with positions. Later stages MUST use only this form.
- **FR-EXT-007** Extraction MUST run locally, without any network access. A failure in one file MUST NOT stop other files.

## Edge cases

- cclinic's own section is removed from `AGENTS.md` before hashing and analysis ([FR-SKILL-012](../agent-skills/spec.md#staying-out-of-the-analysis)).
- A PDF that's partly scanned has its text pages extracted, with a warning listing pages that had no text.
- Empty files are recorded as included, with nothing to send.
- Images inside PDFs and DOCX files are ignored.

## Non-goals

- OCR, or understanding images and diagrams.
- Preserving exact layout, such as columns or table alignment.
- Spreadsheets, slide decks and other document formats, which are treated as unsupported binary files.
