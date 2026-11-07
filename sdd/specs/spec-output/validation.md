# Spec output: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-OUT-001 | FR-OUT-001, FR-OUT-002 | I get one clear folder for AI tools | After a run, an AI coding tool pointed at `.cclinic/sdd/README.md` can find everything it needs and answer questions about the project from it |
| VAL-OUT-002 | FR-OUT-003, FR-OUT-004 | I can understand the project at a high level | `stack.md` and `architecture.md` are enough for a new developer to get oriented, and they say when something wasn't found |
| VAL-OUT-003 | FR-OUT-005 | Developers have complete guidelines | `developer-guidelines.md` covers SOLID, naming, architecture, unit testing and the other listed practices, and has guidance specific to the project's stack |
| VAL-OUT-004 | FR-OUT-009, FR-OUT-010 | Each capability has its own folder | Each spec is in its own named folder with `spec.md`, `validation.md` and `verification.md`, and one can be read or handed off alone |
| VAL-OUT-005 | FR-OUT-011 | Reviewers have a clear acceptance list | Each spec's `validation.md` lists what must be true, in plain language, and every requirement is covered |
| VAL-OUT-006 | FR-OUT-012 | Automation testers have what they need | Each spec's `verification.md` gives setup and test cases with level, Given, When and Then, and every requirement is covered |
| VAL-OUT-007 | FR-OUT-013, FR-OUT-014 | I never get broken output presented as finished | Broken links, missing coverage or invalid citations stop the run with a clear list of problems, and I can inspect the draft |
| VAL-OUT-008 | FR-OUT-014, FR-OUT-015 | A failed run never damages my existing documents | After a failure or crash, my previous documents are still complete and unchanged |
| VAL-OUT-009 | FR-OUT-016, FR-OUT-017 | My own work isn't overwritten by accident | Hand-edited documents or unrelated folders are never replaced unless I pass `--force`, and I'm told before any usage is spent |
| VAL-OUT-010 | FR-OUT-006, FR-OUT-007 | I can see what was analysed and how | The report and manifest show what was included and skipped, and which model produced the output, without exposing secrets |
| VAL-OUT-011 | FR-OUT-008, FR-OUT-018, FR-OUT-019 | It works well with git | Only meaningful changes appear in diffs, the cache and failed drafts aren't committed, and tables always display correctly |
