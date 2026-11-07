# CLI: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** run the built binary as a child process. Use a fake `claude` executable or fake `LlmProvider`. Use a temp copy of `sample-project`, and set `XDG_CONFIG_HOME` to a temp folder.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-CLI-001 | FR-CLI-001 | e2e | Current directory is `sample-project` | Run `cclinic --dry-run` | Summary shows `sample-project` as the target, and exit code is 0 |
| TC-CLI-002 | FR-CLI-001 | e2e | A different current directory | Run `cclinic <sample-project path> --dry-run` | Summary shows the given path as the target |
| TC-CLI-003 | FR-CLI-001 | e2e | A path that doesn't exist, and a path to a file | Run `cclinic <path>` for each | Exit code is 2, and the message names the path |
| TC-CLI-004 | FR-CLI-002 | e2e | None | Run `cclinic --help` | Output lists `model` and every option in the spec table |
| TC-CLI-005 | FR-CLI-002 | e2e | None | Run `cclinic --version` | Output matches the `package.json` version |
| TC-CLI-006 | FR-CLI-002 | e2e | None | Run with `--provider nope`, `--concurrency 0`, `--concurrency 17`, `--max-budget-usd -1`, and `--unknown` | Each exits 2 with a clear message, and no scan starts |
| TC-CLI-007 | FR-CLI-002 | integration | `--out`, `--include`, `--exclude`, `--provider` and `--concurrency 3` are set | Run with the fake provider | Each setting reaches the pipeline and takes effect |
| TC-CLI-008 | FR-CLI-003 | integration | `sample-project` and the fake provider | Run `--dry-run` | Summary and skip totals print. `generate` is never called, and a folder snapshot is unchanged |
| TC-CLI-009 | FR-CLI-004 | integration | `sample-project` and the fake provider | Capture the summary | It has folder, provider, auth method, model, reasoning, file counts, skipped count and tokens, and says content goes to Anthropic |
| TC-CLI-010 | FR-CLI-004 | integration | API provider, then a subscription CLI provider | Capture each summary | API shows an estimated cost, and the CLI shows tokens only |
| TC-CLI-011 | FR-CLI-005 | integration | A mocked prompt answers no | Run | `generate` is never called, no files are written, and exit code is 0 |
| TC-CLI-012 | FR-CLI-005 | integration | A mocked prompt answers yes | Run | `generate` is called |
| TC-CLI-013 | FR-CLI-005 | e2e | Stdin isn't a terminal, and no `--yes` | Run with a 10-second limit | Exit code is 2 before the limit, and there are no provider calls |
| TC-CLI-014 | FR-CLI-005 | e2e | Stdin isn't a terminal, and `--yes` is set | Run with the fake `claude` | It runs without prompting, and exit code is 0 |
| TC-CLI-015 | FR-CLI-006 | e2e | A project file containing the marker `MARKER-CONTENT-123` | Capture stdout and stderr separately | Progress is on stderr, the result is on stdout, and the marker appears in neither |
| TC-CLI-016 | FR-CLI-007 | e2e | One scenario for each outcome: success, internal error, usage error, no provider, LLM failure, validation failure, Ctrl+C (SIGINT) | Run each | Exit codes are 0, 1, 2, 3, 4, 5 and 130 |
| TC-CLI-017 | FR-CLI-001, FR-CLI-004, FR-CLI-005 | manual | A real terminal and real project | Run `cclinic`, read the summary, and answer the prompt | It's easy to understand and shows correct values |
| TC-CLI-018 | FR-CLI-002 | integration | `CCLINIC_PROVIDER` set to one provider, and `--provider` to the other | Run `--dry-run` | The option wins. With no option, the variable wins over the default |
| TC-CLI-019 | FR-CLI-006 | integration | Mocked prompt and menu | Capture streams | Prompt and menu text is on stderr, and stdout has only the result |
| TC-CLI-020 | FR-CLI-008 | e2e | None | Run `--help`, `-h`, `cclinic help`, and `--help` and `cclinic help <command>` for each command | Each has a description, two examples, every option with its default, and a pointer to `cclinic guide`. Both forms match |
| TC-CLI-021 | FR-CLI-008 | e2e | None | Run `cclinic --dry-run --help` | Help shows, and no scan runs |
| TC-CLI-022 | FR-CLI-008 | e2e | None | Run `cclinic docter` and `cclinic --dry-rn` | Each suggests the right word, exits 2, and runs nothing. `docter` is reported as neither a command nor an existing path |
| TC-CLI-023 | FR-CLI-009 | e2e | A project that produces a warning | Run with `--quiet` | Only the final result appears, and exit code is 0 |
| TC-CLI-024 | FR-CLI-009 | e2e | A project containing `MARKER-CONTENT-123`, and a forced internal error | Run with `--debug` | Stage timings and a stack trace are on stderr, and the marker is absent |
| TC-CLI-025 | FR-CLI-009 | e2e | None | Run with `--quiet --debug` | Exit code is 2 |
| TC-CLI-026 | FR-CLI-010 | e2e | One success and one failure for each failing exit code | Run with `--json` and parse stdout | Stdout is exactly one JSON object with the listed fields, and its exit code matches the process's |
| TC-CLI-027 | FR-CLI-010 | e2e | `sample-project` | Run `--dry-run --json` | JSON lists every included path, and every skipped path or folder with its reason |
| TC-CLI-028 | FR-CLI-011 | e2e | Each case: not a terminal, `NO_COLOR=1`, `NO_COLOR=` (empty), `TERM=dumb`, `--color always`, `--color never` | Capture output | ANSI codes appear only with `--color always` and in a terminal with an empty `NO_COLOR` |
| TC-CLI-029 | FR-CLI-012 | integration | A successful run with some cached modules | Capture the result | It shows folder, counts, tokens, estimated cost, duration, cached module count and warnings |
| TC-CLI-030 | FR-CLI-012 | e2e | A fake `claude` that fails mid-run | Run | The message says re-running continues from where it stopped |
| TC-CLI-031 | FR-CLI-013 | e2e | One scenario per check: pass and fail for Node, CLI found, login, key, config and writable folder | Run `cclinic doctor` | Each check shows the right state, and each failure has a fix |
| TC-CLI-032 | FR-CLI-013 | e2e | A marker value in `ANTHROPIC_API_KEY`, and a marker in a project file | Run `doctor` and `doctor --json` | Output says the key is set, neither marker appears, and the fake `claude` gets no generation calls |
| TC-CLI-033 | FR-CLI-013 | e2e | Provider usable, then none usable | Run `doctor` | Exit codes are 0 and 3 |
| TC-CLI-034 | FR-CLI-013 | integration | npm registry stub that hangs, then one that reports a newer version | Run `doctor` | The first skips the check after 5 seconds. The second reports the new version |
| TC-CLI-035 | FR-CLI-014 | integration | Existing `.cclinic/sdd`, `cache` and `failed` folders | Run `cclinic clean --yes` | `cache` and `failed` are gone, `sdd` is byte-identical, and the space freed is reported |
| TC-CLI-036 | FR-CLI-014 | e2e | No terminal and no `--yes` | Run `cclinic clean` | Exit code is 2, and nothing is deleted |
| TC-CLI-037 | FR-CLI-015 | unit | Versions below, at and above the minimum | Run the version check | Only the version below fails, and the message names the required version |
| TC-CLI-038 | FR-CLI-016 | e2e | A fake `claude` that hangs | Send SIGINT, and measure. Repeat with SIGTERM | A message appears at once, exit codes are 130 and 143 within 5 seconds, no child process or temp file remains, and finished summaries are cached |
| TC-CLI-039 | FR-CLI-016 | e2e | A clean-up made to hang | Send SIGINT twice | The second one exits immediately |
| TC-CLI-040 | FR-CLI-017 | e2e | A read-only output folder (POSIX only) | Run with `--yes` | Exit code is 2, and the fake `claude` isn't run |
| TC-CLI-041 | FR-CLI-018 | e2e | A running `cclinic` held by a slow fake `claude` | Start a second run on the same target | The second exits 2 and names the process, and the first finishes normally |
| TC-CLI-042 | FR-CLI-018 | integration | A lock file holding a process ID that doesn't exist | Run | The lock is replaced, and the run succeeds |
| TC-CLI-043 | FR-CLI-018 | e2e | A running `cclinic` holding the lock | Run `--dry-run` and `doctor` on that target | Both work |
| TC-CLI-044 | FR-CLI-019 | e2e | `HOME` set to a temp folder | Run on it with `--yes`, then with `--allow-broad-target --dry-run` | The first exits 2 before scanning, and the second runs |
| TC-CLI-045 | FR-CLI-019 | unit | Filesystem roots, a home folder, and a normal folder, including paths with `..` and trailing slashes | Check the target | Only the first two kinds are refused |
| TC-CLI-046 | FR-CLI-020 | e2e | Each limit option at just below, at, and just above its allowed range | Run with `--dry-run` | Out-of-range values exit 2, and in-range values are accepted |
| TC-CLI-047 | FR-CLI-020 | e2e | A project with more files than `--max-files`, and one above `--max-input-tokens` | Run with `--yes` | Each exits 2 with the actual number, limit, flag and exclusion advice, and the fake `claude` isn't run |
| TC-CLI-048 | FR-CLI-020 | integration | A project above `--max-input-tokens`, whose modules are all cached | Run | It proceeds, because cached modules don't count |
| TC-CLI-049 | FR-CLI-021 | integration | A spy on all network calls, and a run with a fake provider | Run | No connections are made to anywhere other than the provider |
| TC-CLI-050 | FR-CLI-021 | manual | A real run, with outgoing connections monitored | Run | Connections go only to Anthropic |
| TC-CLI-051 | FR-CLI-009 | e2e | A project containing `MARKER-CONTENT-123` | Run with `--debug-file <temp file>` | The file has stage timings, and the marker is absent |
| TC-CLI-052 | FR-CLI-008 | e2e | None | Run `cclinic --help` | It has "How it works", "Get started" and examples, every command, and groups for output, generation and limit options |
| TC-CLI-053 | FR-CLI-022 | e2e | No `claude` and no key | Run `cclinic guide` | Exit code is 0, and it covers each step, every command, all five skills, what's skipped, every limit with its default, common problems, and exit codes |
| TC-CLI-054 | FR-CLI-022 | e2e | The built-in option defaults | Compare with the guide | Each limit's default in the guide matches the real option |
| TC-CLI-055 | FR-CLI-022 | e2e | A successful run | Read the result | It says what to do next, and mentions `cclinic guide` |
