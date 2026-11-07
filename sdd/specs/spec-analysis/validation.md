# Spec analysis: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-ANA-001 | FR-ANA-001, FR-ANA-002, FR-ANA-005, FR-ANA-006, FR-ANA-008 | Specs match how I think about my product | A person who knows the project agrees that the specs cover its main capabilities, and aren't just a list of its folders |
| VAL-ANA-002 | FR-ANA-007, FR-ANA-009 | I can trust the specs | In a sample of 20 requirements, each citation leads to text that supports the requirement, and none are invented |
| VAL-ANA-003 | FR-ANA-010, FR-ANA-011 | I can see what's uncertain | When documents and code disagree, or something is only in one, the output says so instead of hiding it |
| VAL-ANA-004 | FR-ANA-012 | Reviewers can accept work without reading code | A product owner can read `validation.md` and decide whether each item is met |
| VAL-ANA-005 | FR-ANA-013, FR-ANA-014, FR-ANA-015 | A tester can automate from `verification.md` | An automation tester who hasn't seen the code can write tests from a sample of 10 test cases, including failure scenarios, without asking for more information |
| VAL-ANA-006 | FR-ANA-016, FR-ANA-017 | The project description is accurate | A person who knows the project confirms that `stack.md` and `architecture.md` are correct, with no invented technologies |
| VAL-ANA-007 | FR-ANA-018, FR-ANA-019 | Guidelines fit my project | The guidelines include the full best-practice baseline, and clearly separate what the project already does from what's recommended for its stack |
| VAL-ANA-008 | FR-ANA-020, FR-ANA-021 | Re-running doesn't scramble references | After a small code change and a re-run, existing requirement IDs stay the same, so tests and tickets still point to the right place |
| VAL-ANA-009 | FR-ANA-003, FR-ANA-004, FR-ANA-022, FR-ANA-023, FR-ANA-024 | Runs don't waste time or usage | Re-running after a small change only reprocesses what changed, and a failed run resumes where it stopped |
| VAL-ANA-010 | FR-ANA-025, FR-ANA-026 | Large projects work too | A project with many capabilities gets complete specs, with none cut off or silently left out |
| VAL-ANA-011 | FR-ANA-027 | I can force a fresh analysis | When I doubt the results, one option makes it analyse everything again |
| VAL-ANA-012 | FR-ANA-028 | A small model mistake doesn't end my run | A bad citation or missing test case in one spec is corrected automatically where possible |
