# Spec analysis: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** use `FakeLlmProvider`, which returns canned, schema-valid data and records each request. Manual tests measure output quality with a real provider. Claude's output varies, so judge those by the stated criteria rather than exact text.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-ANA-001 | FR-ANA-001 | unit | A monorepo with several manifests, plus plain folders and root files | Group modules | Modules follow the nearest manifest, then the first-level folder, then `root` |
| TC-ANA-002 | FR-ANA-002 | unit | Two documents and some code | Group modules | Each document is its own module |
| TC-ANA-003 | FR-ANA-003 | integration | Random fake delays at concurrency 3 | Run twice | Never more than 3 run at once, and the combine inputs are identical |
| TC-ANA-004 | FR-ANA-004 | unit | A large module, and a single oversized file | Chunk | No request exceeds the limit, and splits fall on line or page boundaries |
| TC-ANA-005 | FR-ANA-005 | integration | A chunked module, and a fake provider | Summarise | Each result passes the schema, and they merge into one summary |
| TC-ANA-006 | FR-ANA-005 | unit | A summary with an item missing evidence | Validate | It's rejected |
| TC-ANA-007 | FR-ANA-006 | integration | A small set, and an oversized set of summaries | Combine | The data passes the schema, and the oversized set is combined in stages within the limit |
| TC-ANA-008 | FR-ANA-007 | unit | Built prompts | Inspect | They require evidence and behaviour-level descriptions, and prohibit invention |
| TC-ANA-009 | FR-ANA-008 | unit | Specs with duplicate names, and names that aren't `kebab-case` | Validate | They're rejected |
| TC-ANA-010 | FR-ANA-009 | unit | A requirement with no evidence, then one for each evidence format | Validate | The first is rejected, and each format is accepted |
| TC-ANA-011 | FR-ANA-010 | unit | Each status, and an unknown status | Validate | Only the three valid statuses pass |
| TC-ANA-012 | FR-ANA-010, FR-ANA-011 | manual | `conflict-project`, and a real provider | Run | `open-questions.md` describes the conflict with both citations, and the status isn't `confirmed` |
| TC-ANA-013 | FR-ANA-012 | unit | A requirement with no `VAL`, and a `VAL` with no outcome | Validate | Both are rejected |
| TC-ANA-014 | FR-ANA-013 | unit | A requirement with no `TC`, and a `TC` missing its level, Given, When or Then | Validate | All are rejected |
| TC-ANA-015 | FR-ANA-013, FR-ANA-014 | manual | A real project, and a tester who hasn't seen the code | Write tests from 10 sampled test cases | The tests can be written without more information, and failure scenarios are present |
| TC-ANA-016 | FR-ANA-015 | manual | A project with `npm` scripts, and one with no test setup | Run with a real provider | The first uses real commands. The second has no invented commands, and an open question records the gap |
| TC-ANA-017 | FR-ANA-016 | unit | A stack item with no evidence | Validate | It's rejected |
| TC-ANA-018 | FR-ANA-016, FR-ANA-017 | manual | A project with known technology and structure | Run with a real provider | Stack and architecture are correct, with no invented technologies |
| TC-ANA-019 | FR-ANA-018 | integration | Canned tailoring that tries to drop baseline text | Render guidelines | All baseline sections are present and unchanged |
| TC-ANA-020 | FR-ANA-019 | unit | A guideline with no label, and an `observed` guideline with no evidence | Validate | Both are rejected |
| TC-ANA-021 | FR-ANA-019 | manual | A project whose conventions differ from common practice | Run with a real provider | The project's convention is stated, and the difference is recorded |
| TC-ANA-022 | FR-ANA-020 | integration | A previous manifest, with one requirement removed from new results | Combine | Prior IDs are in the prompt, and the removed ID isn't reused |
| TC-ANA-023 | FR-ANA-020 | manual | A real project, with a small code change | Run twice with a real provider | Unaffected requirements keep their IDs |
| TC-ANA-024 | FR-ANA-021 | unit | Well-formed and malformed IDs of each type, and one area used by two specs | Validate | Only well-formed IDs with unique areas pass |
| TC-ANA-025 | FR-ANA-022 | integration | A completed run | Re-run unchanged, then change a file, the prompt version, the model, and the reasoning level in turn | Unchanged makes no calls, and each change re-analyses only the affected modules |
| TC-ANA-026 | FR-ANA-022 | integration | A corrupt cache entry | Run | The entry is ignored and replaced, and the run succeeds |
| TC-ANA-027 | FR-ANA-023 | integration | A fake provider failing on the third of five modules | Run, then run again with it fixed | Finished summaries were saved, and only remaining modules are called |
| TC-ANA-028 | FR-ANA-023 | integration | A completed run | Re-run unchanged | The combine call is skipped |
| TC-ANA-029 | FR-ANA-024 | integration | A completed run | Run with `--force` | No summaries are regenerated |
| TC-ANA-030 | FR-ANA-025 | integration | A fake provider, with a project list of 3 specs | Run | There's one spec call for each, each request includes the spec list, and each result is cached separately |
| TC-ANA-031 | FR-ANA-025 | integration | A completed run, with one module changed | Re-run | Only the specs that use that module are regenerated |
| TC-ANA-032 | FR-ANA-026 | integration | A fake provider that raises `TruncatedError` once for one spec, then returns two smaller specs | Run | It retries once asking for a split, and both specs are written |
| TC-ANA-033 | FR-ANA-026 | integration | A fake provider that always raises `TruncatedError` for one spec | Run | Exit code is 4, and the message names the spec |
| TC-ANA-034 | FR-ANA-025, FR-ANA-026 | manual | A large real project with many capabilities | Run with a real provider | All capabilities are covered, and no output is cut off |
| TC-ANA-035 | FR-ANA-027 | integration | A completed run | Run with `--no-cache`, then again with no flag | The first calls the provider for every module, and the second makes no calls |
| TC-ANA-036 | FR-ANA-028 | integration | A fake provider whose first spec result cites a missing file | Run | The second request lists the problem, and the corrected result is written |
