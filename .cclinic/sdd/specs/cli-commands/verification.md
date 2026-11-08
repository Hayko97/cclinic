# cli-commands: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Unit/integration: `npm test` (Vitest); with coverage `npm run test:coverage`; CLI-related integration tests in test/integration/cli-commands.test.ts, reporter unit tests in src/cli/reporter.test.ts.
- E2E: `npm run test:e2e` (builds with tsup, then runs test/e2e/cli.test.ts against the built bin/cclinic.js as a child process).
- Full gate: `npm run verify`.
- Replace Claude with the fake executable test/fixtures/fake-claude/claude or a fake LlmProvider; recorded outputs in test/fixtures/recorded-cli-output/*.jsonl; helpers in test/support/helpers.ts.
- Use a temporary copy of a sample project and a temporary XDG_CONFIG_HOME; no real Anthropic API or network; use a marker string such as MARKER-CONTENT-123 in project files to check content never leaks.
- Replace npm registry lookup for doctor with a fake fetcher.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-CLI-001 | FR-CLI-001, FR-CLI-002 | e2e | A temp sample project and a nonexistent path, and a path to a regular file | Run `cclinic <missing> --dry-run` and `cclinic <file> --dry-run` | Both exit with code 2 with a message about the path, and nothing is written. |
| TC-CLI-002 | FR-CLI-001, FR-CLI-019 | e2e | Built CLI | Run `cclinic --help`, `cclinic help doctor`, `cclinic doctor -h`, `cclinic --version` | Each exits 0 and prints help (with examples/defaults) or the version on stdout. |
| TC-CLI-003 | FR-CLI-019 | e2e | Built CLI | Run `cclinic docter` and `cclinic --dry-rn` | Each exits 2, suggests `doctor` / `--dry-run`, and runs nothing. |
| TC-CLI-004 | FR-CLI-005 | integration | Sample project | Run with --concurrency 17, --concurrency 0, --max-budget-usd -1, --max-file-size-mib 51, --max-retries 11, --timeout-minutes 121, --unknown-flag | Each exits 2 with a clear message before any scan starts. |
| TC-CLI-005 | FR-CLI-004, FR-CLI-005 | integration | Fake provider | Run with --concurrency 8 --max-retries 5 --out <dir> --include/--exclude globs | The values reach the pipeline and output is written to <dir>. |
| TC-CLI-006 | FR-CLI-006 | e2e | CCLINIC_PROVIDER=anthropic-api and no key | Run with `--provider claude-cli` and with `--provider auto` | The option wins over the environment variable; with the variable only, the env provider is used. |
| TC-CLI-007 | FR-CLI-007 | e2e | Sample project with fake provider recording calls | Run `cclinic --dry-run` | Exit 0, no generate calls, .cclinic is unchanged, summary and skipped totals by reason are printed. |
| TC-CLI-008 | FR-CLI-007, FR-CLI-011 | e2e | Sample project | Run `cclinic --dry-run --json` | Stdout is a single JSON object with status dry-run, included paths and skipped paths with reasons. |
| TC-CLI-009 | FR-CLI-008 | integration | Fake API provider and fake CLI provider with subscription login | Run interactively with confirmation prompt | Summary lists target, provider, auth, model, effort, counts, tokens, Git status and an Anthropic notice; cost shown for API, not for subscription. |
| TC-CLI-010 | FR-CLI-009 | integration | Interactive terminal, answer no | Run cclinic | Exit 0, no generate calls, no files written. |
| TC-CLI-011 | FR-CLI-009 | e2e | No TTY on stdin | Run `cclinic` without --yes, then with --yes | First exits 2 immediately without provider calls; second proceeds. |
| TC-CLI-012 | FR-CLI-010 | e2e | Project file containing MARKER-CONTENT-123, fake provider | Run `cclinic --yes` capturing both streams | Progress is on stderr, result on stdout, and the marker appears in neither. |
| TC-CLI-013 | FR-CLI-011, FR-CLI-014 | e2e | Failing provider (fake claude returning budget error) | Run `cclinic --yes --json` | Stdout is one JSON object with status error, exitCode 4, errorType and message; process exit is 4. |
| TC-CLI-014 | FR-CLI-012 | e2e | Sample project | Run with `--quiet --debug`; then `--quiet`; then `--debug --debug-file f` | First exits 2; second prints only the final result; debug output and file contain no MARKER-CONTENT-123, prompts or API key. |
| TC-CLI-015 | FR-CLI-013 | unit | Reporter with simulated TTY/non-TTY streams and env | Use auto with NO_COLOR=1, NO_COLOR empty, TERM=dumb, non-TTY; and --color always / never | ANSI codes appear only for TTY with empty NO_COLOR or --color always; never otherwise. |
| TC-CLI-016 | FR-CLI-014 | e2e | Fakes for success, no provider, invalid output | Run the CLI in each scenario | Exit codes are 0, 3 and 5 respectively; an internal fault gives 1. |
| TC-CLI-017 | FR-CLI-015 | manual | Node.js older than 22.18 available (e.g. 20) | Run `node bin/cclinic.js` | Stderr names the needed version 22.18 and exit code is 2. |
| TC-CLI-018 | FR-CLI-016 | integration | Provider failing with retries exhausted | Run cclinic --yes | Exit 4 and message states re-running the same command continues where it stopped. |
| TC-CLI-019 | FR-CLI-017 | e2e | Fake claude logged in, ANTHROPIC_API_KEY set to a known value, temp XDG_CONFIG_HOME | Run `cclinic doctor` and `cclinic doctor --json` | Exit 0, key reported as set but its value never printed, no generate calls, no project content. |
| TC-CLI-020 | FR-CLI-017 | e2e | No claude on PATH and no ANTHROPIC_API_KEY | Run `cclinic doctor` | Exit 3 with fixes listed. |
| TC-CLI-021 | FR-CLI-017 | integration | Fetcher for npm version that never responds | Run doctor | The npm check is skipped after 5 seconds and doctor still completes. |
| TC-CLI-022 | FR-CLI-018 | e2e | .cclinic/cache, .cclinic/failed and .cclinic/sdd with files | Run `cclinic clean --yes` | cache and failed are removed, sdd unchanged, space freed reported, exit 0. |
| TC-CLI-023 | FR-CLI-018 | e2e | No TTY | Run `cclinic clean` without --yes | Exits without deleting anything and with a usage error. |
| TC-CLI-024 | FR-CLI-019 | e2e | Network disabled | Run `cclinic guide` | Exit 0; output covers steps, commands, five skills, skipped items, limits with defaults matching real options, problems and exit codes. |
| TC-CLI-025 | FR-CLI-020 | e2e | Slow fake claude running | Send SIGINT, then in another run SIGTERM, then two SIGINTs | Message printed at once; exits 130/143 within 5 seconds with no child processes or temp files; finished summaries remain cached; second SIGINT exits immediately. |
| TC-CLI-026 | FR-CLI-021 | integration | Output folder not writable | Run cclinic --yes | Exit 2 before any provider call. |
| TC-CLI-027 | FR-CLI-022 | integration | A live run holding .cclinic/.lock | Start a second run on the same target, then run with --dry-run and doctor | Second run exits 2 naming the PID; dry-run and doctor ignore the lock. |
| TC-CLI-028 | FR-CLI-022 | integration | .cclinic/.lock containing the PID of a dead process | Run cclinic --yes | Lock is replaced and the run proceeds. |
| TC-CLI-029 | FR-CLI-023 | integration | HOME pointing to a temp folder, and filesystem root | Run targeting each with --yes, then with --allow-broad-target | Refused with exit 2 without the flag; accepted with it; a normal folder is accepted. |
| TC-CLI-030 | FR-CLI-024 | integration | Project of 5 files | Run with --max-files 2, then --max-input-tokens 10 | Each exits 2 before generation, message includes actual number, limit, flag name and exclusion advice. |
| TC-CLI-031 | FR-CLI-024 | integration | Project with every module cached and a tiny --max-input-tokens | Run cclinic --yes | The token limit is not exceeded because cached modules do not count. |
| TC-CLI-032 | FR-CLI-024 | integration | Folder where all files are excluded | Run cclinic --yes | Stops before sending because no files remain. |
| TC-CLI-033 | FR-CLI-025 | integration | Network connections monitored/blocked except fake provider | Run generate and doctor | No connections other than the provider (and the npm check for doctor) are attempted. |
| TC-CLI-034 | FR-CLI-026 | integration | Temp XDG_CONFIG_HOME | Run `cclinic model --list`, set a default, `cclinic model --reset` | List shows models; config.json under XDG_CONFIG_HOME/cclinic holds model and effort after setting; reset removes them. |
| TC-CLI-035 | FR-CLI-027 | e2e | Temp project | Run `cclinic skills <path> --json` | Skills are installed in .agents/skills and .claude/skills, no LLM call, and stdout is one JSON object. |
| TC-CLI-036 | FR-CLI-001 | e2e | A folder named model inside the working directory | Run `cclinic ./model --dry-run` | It is treated as the target path, not the model command. |
| TC-CLI-037 | FR-CLI-003 | e2e | Built CLI | Run with -q, -d, --debug-file, --json, --color never on a dry run | All options are accepted and no unknown-option error occurs. |
