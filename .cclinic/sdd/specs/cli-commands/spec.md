# cli-commands

## Goal

Provide the cclinic command-line interface with commands, options, limits, confirmation, output modes, safety checks and exit codes.

`cclinic environment`, `--environment` and `--no-environment` are specified in [local-environment](../local-environment/spec.md).

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-CLI-001 | The CLI must provide the commands `cclinic [path]` (generate), `model`, `doctor [path]`, `skills [path]`, `clean [path]`, `guide` and `help [command]`, with the target defaulting to the current directory. | confirmed | `sdd/specs/cli/spec.md:9-17`, `src/cli/main.ts:69-173` |
| FR-CLI-002 | The CLI must exit with code 2 when the target path is missing or is not a directory. | confirmed | `sdd/specs/cli/spec.md:80`, `sdd/specs/cli/verification.md:9-11` |
| FR-CLI-003 | The CLI must accept the general options -h/--help, -v/--version, -q/--quiet, -d/--debug, --debug-file <path>, --json and --color auto\|always\|never (default auto). | confirmed | `sdd/specs/cli/spec.md:23-31`, `src/cli/main.ts:69-123` |
| FR-CLI-004 | The generate command must accept the options --out, --provider, --model, --effort, repeatable --include and --exclude, --dry-run, --force, --yes, --no-cache, --no-skills, --no-git and --allow-broad-target, with --out defaulting to <target>/.cclinic/sdd. | confirmed | `sdd/specs/cli/spec.md:35-49`, `src/cli/main.ts:71-116` |
| FR-CLI-005 | The CLI must validate limit options against their ranges and defaults (--max-files 10000 >=1; --max-input-tokens 2000000 >=1; --max-file-size-mib 1 in 1-50; --max-budget-usd >0 with no default; --concurrency 4 in 1-16; --timeout-minutes 30 in 1-120; --max-retries 2 in 0-10) and exit with code 2 on invalid values before any scan. | confirmed | `sdd/specs/cli/spec.md:53-61`, `sdd/specs/cli/spec.md:81`, `src/core/constants/limits.ts:9-16`, `sdd/specs/cli/verification.md:14` |
| FR-CLI-006 | Option values must take precedence over environment variables (CCLINIC_PROVIDER, CCLINIC_MODEL, CCLINIC_EFFORT), which must take precedence over saved defaults. | confirmed | `sdd/specs/cli/spec.md:67-74`, `sdd/specs/cli/spec.md:81`, `sdd/specs/cli/verification.md:26` |
| FR-CLI-007 | With --dry-run the CLI must print a summary and skipped totals by reason without any LLM generation call and without writing files. | confirmed | `sdd/specs/cli/spec.md:82`, `src/cli/generate-command.ts:370-392`, `sdd/specs/cli/verification.md:16` |
| FR-CLI-008 | Before any LLM call the CLI must show a summary (target, provider, auth, model, effort, file counts, skipped count, token estimate, cost estimate where applicable, Git status and a notice that content is sent to Anthropic). | confirmed | `sdd/specs/cli/spec.md:83`, `sdd/specs/cli/verification.md:17-18`, `src/cli/generate-command.ts:222-223` |
| FR-CLI-009 | The CLI must ask for confirmation before sending unless --yes is given; declining must exit 0 sending and writing nothing, and without a TTY and without --yes it must exit 2 without waiting. | confirmed | `sdd/specs/cli/spec.md:84`, `src/cli/generate-command.ts:398-409`, `sdd/specs/cli/verification.md:19-22` |
| FR-CLI-010 | Progress, prompts and menus must go to stderr and the final result to stdout, and normal output must never include scanned file contents. | confirmed | `sdd/specs/cli/spec.md:85`, `src/cli/reporter.ts:1`, `src/cli/menus.ts:1`, `sdd/specs/cli/verification.md:23` |
| FR-CLI-011 | With --json stdout must be exactly one JSON object with status (dry-run, success, declined or error); errors include exitCode, errorType and message, and the object's exit code must match the process exit code. | confirmed | `sdd/specs/cli/spec.md:92-95`, `src/cli/generate-command.ts:371-385`, `src/cli/main.ts:187-197`, `sdd/specs/cli/verification.md:34-35` |
| FR-CLI-012 | Using --quiet together with --debug must be a usage error (exit 2); --quiet must show only the final result, and --debug and --debug-file must never reveal file contents, prompts, keys or secrets. | confirmed | `sdd/specs/cli/spec.md:91`, `sdd/specs/cli/verification.md:31-33` |
| FR-CLI-013 | Color must be off when the stream is not a TTY, NO_COLOR is non-empty or TERM is dumb, each stream checked separately, and --color always/never must override. | confirmed | `sdd/specs/cli/spec.md:96`, `src/cli/reporter.test.ts:1-5`, `sdd/specs/cli/verification.md:36` |
| FR-CLI-014 | The CLI must use the exit codes 0 (success or declined), 1 (internal), 2 (usage), 3 (no provider), 4 (LLM failure or budget), 5 (validation failure), 130 (SIGINT) and 143 (SIGTERM). | confirmed | `sdd/specs/cli/spec.md:120-129`, `src/core/errors.ts:37-55`, `src/cli/guide.ts:179-184` |
| FR-CLI-015 | The executable must exit with code 2 and a stderr message naming the required version when Node.js is older than 22.18. | confirmed | `bin/cclinic.js:4-12`, `sdd/specs/cli/spec.md:106`, `sdd/specs/cli/verification.md:45` |
| FR-CLI-016 | On LLM failure the error message must say that re-running the same command continues where it stopped. | confirmed | `sdd/specs/cli/spec.md:97`, `sdd/specs/cli/verification.md:38` |
| FR-CLI-017 | `cclinic doctor` must report pass/fail/skipped checks with fixes, support --json, never call a model, print the API key value or read project contents, skip the npm update check after 5 seconds, and exit 0 if a provider is usable else 3. | confirmed | `sdd/specs/cli/spec.md:101`, `src/cli/other-commands.ts:142-250`, `sdd/specs/cli/verification.md:39-42` |
| FR-CLI-018 | `cclinic clean` must delete only .cclinic/cache and .cclinic/failed, leave .cclinic/sdd untouched, report space freed, and ask for confirmation unless --yes is given. | confirmed | `sdd/specs/cli/spec.md:102`, `src/cli/main.ts:165-173`, `sdd/specs/cli/verification.md:43-44` |
| FR-CLI-019 | `cclinic guide` must print an offline walkthrough with exit 0, and help (help [command], -h/--help in any position) must show examples and defaults and suggest the closest match for typos with exit 2. | confirmed | `sdd/specs/cli/spec.md:90`, `sdd/specs/cli/spec.md:116`, `src/cli/guide.ts:144-145`, `sdd/specs/cli/verification.md:28-30`, `sdd/specs/cli/verification.md:61` |
| FR-CLI-020 | On SIGINT or SIGTERM the CLI must print a message at once, stop calls, remove temp files and exit 130 or 143 within 5 seconds, a second Ctrl+C must exit immediately, and completed summaries must stay cached. | confirmed | `sdd/specs/cli/spec.md:107`, `src/cli/main.ts:178-257`, `sdd/specs/cli/verification.md:46-47` |
| FR-CLI-021 | Output and cache folders must be writable before any LLM call, otherwise the CLI must exit 2. | confirmed | `sdd/specs/cli/spec.md:108`, `sdd/specs/cli/verification.md:48` |
| FR-CLI-022 | Only one run per target must be allowed using .cclinic/.lock holding the PID; a second run must exit 2 naming the process, stale locks must be replaced, and dry-run and doctor must not need the lock. | confirmed | `sdd/specs/cli/spec.md:109`, `src/adapters/storage/document-store.ts:225-245`, `sdd/specs/cli/verification.md:49-51` |
| FR-CLI-023 | A home folder or filesystem root target must be refused unless --allow-broad-target is given, even with --yes. | confirmed | `sdd/specs/cli/spec.md:110`, `src/cli/generate-command.ts:128-142`, `sdd/specs/cli/verification.md:52-53` |
| FR-CLI-024 | Exceeding --max-files or --max-input-tokens, or finding no files, must stop before generation with exit 2 showing the actual number, the limit, the flag and how to exclude files; cached modules must not count toward the token limit. | confirmed | `sdd/specs/cli/spec.md:111`, `src/cli/generate-command.ts:328-335`, `src/cli/generate-command.ts:353-355`, `sdd/specs/cli/verification.md:54-56` |
| FR-CLI-025 | The CLI must not send telemetry and must connect only to the chosen Anthropic provider and, for doctor, to npm. | confirmed | `sdd/specs/cli/spec.md:112`, `sdd/specs/cli/validation.md:20`, `sdd/specs/cli/verification.md:57-58` |
| FR-CLI-026 | `cclinic model` must list, choose or reset the saved default model and reasoning level. | confirmed | `sdd/specs/cli/spec.md:11`, `src/cli/main.ts:132-141`, `src/cli/other-commands.ts:32-74` |
| FR-CLI-027 | `cclinic skills [path]` must install the agent skills without using any LLM, supporting --out, --force and --json. | confirmed | `sdd/specs/cli/spec.md:13`, `src/cli/main.ts:153-163` |
| FR-CLI-028 | The CLI must provide `cclinic mcp`, which starts the MCP server as the [mcp-server](../mcp-server/spec.md) spec describes, accepting `-C, --dir`, `--approver`, `--run`, `--task` and `--max-budget-usd`. | confirmed | `src/cli/mcp-command.ts`, `src/cli/main.ts`, `test/e2e/mcp.test.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-001, FR-MCP-002, `user request` |
| FR-CLI-029 | The CLI must provide `cclinic approve [path]`, which lists the gate questions waiting in the project's workflow state, lets the user choose an answer for one, and records it with approver `user`. With no question waiting it must say so and exit 0. Without a TTY it must exit 2 and record nothing. | confirmed | `src/cli/mcp-command.ts`, `test/e2e/mcp.test.ts`, `.cclinic/sdd/specs/mcp-server/spec.md` FR-MCP-029, `user request` |

## Edge cases

- Folder named like a command is reached with ./ prefix (e.g. cclinic ./model).
- Typo such as `docter` or `--dry-rn` exits 2 with a suggestion and runs nothing.
- Path argument that is a file rather than a directory exits 2.
- No TTY and no --yes exits 2 immediately instead of hanging.
- Stale lock file from a dead process is replaced.
- Subscription login hides cost figures; API provider shows an estimate.
- Home folder or filesystem root with --yes still refused without --allow-broad-target.
- A skills installation failure after successful generation is only a warning.
- NO_COLOR set but empty does not disable color in a TTY.
- Second Ctrl+C exits immediately.

## Non-goals

- API keys as CLI options.
- Per-project config or profiles.
- Shell completions.
- Self-update.
- Analytics or telemetry.
