# content-extraction: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test framework: Vitest with coverage-v8 (vitest.config.ts); mutation testing with Stryker (stryker.config.json).
- The project's full check script is the 'verify' script in package.json (package.json:30); run it via npm.
- Relevant existing tests: test/integration/discovery-extraction.test.ts; helpers in test/support/helpers.ts.
- Test data: sample PDF, DOCX, text and large files generated in temp folders via test/support/helpers.ts rather than committed fixtures.
- Network: block or spy on network access to prove extraction is offline; no LLM provider is needed for extraction tests.
- Manual: real multi-column and table-heavy PDFs for readability review.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-EXT-001 | FR-EXT-001 | integration | A temp folder with .ts, .json, .md, .txt, .rst and .adoc files of several known lines each | Extraction runs on each file | Each result has the file's text split into lines numbered from 1 with content matching the source, and no warnings. |
| TC-EXT-002 | FR-EXT-001 | integration | A text file containing invalid UTF-8 bytes | Extraction runs | Invalid bytes are replaced, a warning names the file, no error is thrown and the remaining text keeps correct line numbers. |
| TC-EXT-003 | FR-EXT-002 | integration | A generated multi-page PDF with distinct known text on each page | Extraction runs | Each text piece is attributed to the page it appears on. |
| TC-EXT-004 | FR-EXT-002 | manual | Real multi-column and table-heavy PDFs | They are extracted and the output read | The text is judged good enough to derive requirements; otherwise the PDF library choice is raised. |
| TC-EXT-005 | FR-EXT-003 | integration | A generated DOCX with two headings, paragraphs under each and a table | Extraction runs | Headings and table text are present, and each piece maps to its nearest heading so it can be cited as file.docx#Heading. |
| TC-EXT-006 | FR-EXT-004 | integration | A PDF with pages that have no text (averaging under 20 non-space characters per page) | Extraction runs | No text is returned and a warning naming the file is recorded. |
| TC-EXT-007 | FR-EXT-005 | integration | A PDF where pages 1 and 3 have text and page 2 has none | Extraction runs | Text of pages 1 and 3 is returned and the warning lists page 2. |
| TC-EXT-008 | FR-EXT-006, FR-EXT-010 | integration | Folder with a valid text file, an encrypted PDF, a corrupt DOCX, a corrupt PDF and a legacy .doc file | The scan and extraction run | scan-report.md has a warning for each bad file, the valid text file is extracted, and the run does not fail. |
| TC-EXT-009 | FR-EXT-007 | unit | A generated text file larger than the per-request limit | It is chunked | There is more than one chunk, joining the chunks reproduces the original text exactly, and each chunk's line numbers match the original lines. |
| TC-EXT-010 | FR-EXT-007 | unit | A large multi-page PDF extraction result above the request limit | It is chunked | Every page's text appears in exactly one chunk with its page number, and none is dropped. |
| TC-EXT-011 | FR-EXT-008 | integration | A file with known bytes | Extraction runs | The result contains the path, type, and a hash equal to SHA-256 of the original bytes (computed independently), and the positioned text. |
| TC-EXT-012 | FR-EXT-009 | integration | Network access blocked or monitored, with text, PDF and DOCX files | Extraction runs | Extraction succeeds and zero network attempts are observed. |
| TC-EXT-013 | FR-EXT-010 | integration | A mix of one corrupt file and several good files | Extraction runs | All good files produce results and only the corrupt file produces a warning. |
| TC-EXT-014 | FR-EXT-011 | unit | An AGENTS.md containing a cclinic managed section and other content | It is extracted | The result text and hash exclude the managed section, and changing only that section leaves the hash unchanged. |
| TC-EXT-015 | FR-EXT-012 | integration | An empty text file and a PDF and DOCX containing images | Extraction runs | The empty file is recorded as included with no text and no error; images produce no content. |
