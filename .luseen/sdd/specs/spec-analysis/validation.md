# spec-analysis: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-ANA-001 | FR-ANA-001, FR-ANA-002, FR-ANA-003 | Large and mixed projects are analysed completely without hitting size limits. | A large project with code and documents is analysed fully, and no part is cut off or silently left out. |
| VAL-ANA-002 | FR-ANA-004, FR-ANA-028 | Analysis is reasonably fast and gives the same result every time. | Running twice on the same project yields identical documents, and a provider failure stops the run with a clear failure and keeps finished work. |
| VAL-ANA-003 | FR-ANA-005, FR-ANA-006, FR-ANA-007 | Project-wide data reflects every module and is backed by evidence. | Overview, stack, architecture and open questions reflect all modules, and no statement lacks a source. |
| VAL-ANA-004 | FR-ANA-008, FR-ANA-009, FR-ANA-015 | Nothing is invented and the project's own text cannot steer the tool. | A sample of statements all trace to project text, no unknown commands or tools appear, and instructions planted in project files are not obeyed. |
| VAL-ANA-005 | FR-ANA-010, FR-ANA-012, FR-ANA-020 | Specs are well organised and identifiable. | Each spec has a unique readable name, every requirement has one of three clear statuses, and all IDs follow the documented pattern. |
| VAL-ANA-006 | FR-ANA-011 | Citations are trustworthy. | In a sample of 20 requirements, each citation leads to text that supports it. |
| VAL-ANA-007 | FR-ANA-013, FR-ANA-029 | Uncertainty is surfaced, not hidden. | Conflicts between documents and code, and items present in only one, are listed in open questions with both sources; document-only and code-only projects are labelled accordingly. |
| VAL-ANA-008 | FR-ANA-014 | Product owners and testers can use the criteria and test cases without reading code. | Each requirement has a plain-language acceptance criterion and a test case, including a failure scenario, that a tester can automate without further information. |
| VAL-ANA-009 | FR-ANA-016 | Stack and architecture descriptions are correct. | The project owner confirms stack and architecture are correct and no technology is invented. |
| VAL-ANA-010 | FR-ANA-017 | Guidelines keep best practice while reflecting the project. | Guidelines include the full baseline unchanged and clearly separate what the project already does from what is recommended. |
| VAL-ANA-011 | FR-ANA-018, FR-ANA-019 | Requirement IDs stay stable over time. | After a small code change and re-run, existing requirement IDs are unchanged and no removed ID is reused. |
| VAL-ANA-012 | FR-ANA-021, FR-ANA-022, FR-ANA-023 | Re-runs are cheap and failed runs can resume. | A re-run reprocesses only what changed, an unchanged re-run makes no model calls, a damaged cache does not break the run, and a failed run resumes where it stopped. |
| VAL-ANA-013 | FR-ANA-024 | I can force a fresh analysis. | One option makes everything be analysed again, and the forced run produces fresh results. |
| VAL-ANA-014 | FR-ANA-025, FR-ANA-026 | Projects with many capabilities get complete specs. | Large projects produce complete specs; if a spec is too long it is split, and if that still fails the run says which spec failed. |
| VAL-ANA-015 | FR-ANA-027 | Small model mistakes do not end the run. | A bad citation or missing test case in one spec is corrected automatically where possible, and invalid results are never kept for later runs. |
