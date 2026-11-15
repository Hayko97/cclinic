# quality-tooling: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-QUAL-001 | FR-QUAL-001, FR-QUAL-002, FR-QUAL-003, FR-QUAL-004, FR-QUAL-005, FR-QUAL-006 | Maintainers need the layered design protected automatically so the core stays independent and the Claude SDK stays isolated. | A change that breaks any layering rule, uses the SDK outside its adapter, or creates a circular dependency is reported as an error, while the current code reports no violations. |
| VAL-QUAL-002 | FR-QUAL-007, FR-QUAL-008, FR-QUAL-013 | Maintainers need consistent, strictly typed and formatted code. | Hardcoded numbers, disallowed default exports, type errors and badly formatted files are each reported by the lint and typecheck steps, and clean code passes. |
| VAL-QUAL-003 | FR-QUAL-009 | The team needs assurance that tests exercise enough of the code. | The coverage run fails when overall coverage drops under 80% or core coverage under 90%, and passes otherwise. |
| VAL-QUAL-004 | FR-QUAL-010 | Release owners need to know whether core tests actually detect faults. | Mutation testing on core logic produces a score report that is judged against the 70 and 85 thresholds without blocking the build. |
| VAL-QUAL-005 | FR-QUAL-011, FR-QUAL-012 | Contributors need one command that tells them whether a change is mergeable, and consistent commit history. | Running the verify command runs all checks except mutation testing and fails if any fails; non-conventional commit messages are rejected. |
| VAL-QUAL-006 | FR-QUAL-014, FR-QUAL-015, FR-QUAL-016, FR-QUAL-019 | Testers need a safe, repeatable test environment that never uses real Claude, the network or the user's own files. | The whole suite runs offline with a stand-in Claude, leaves no leftover temp folders, and can simulate failures such as login errors, timeouts and usage limits. |
| VAL-QUAL-007 | FR-QUAL-017, FR-QUAL-018 | Product owners need each documented test case traceable to an automated test and parsing checked against real output. | Automated tests carry their test-case IDs in their names, and recorded real outputs for success, budget and invalid model are checked by tests. |
| VAL-QUAL-008 | FR-QUAL-020 | Users need the tool to be installable as a single runnable command. | After a build the luseen command starts from the bundled output. |
| VAL-QUAL-009 | FR-QUAL-021 | The MCP library stays in one place, so it can be replaced | Using it anywhere else fails the quality check |
