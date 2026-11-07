# CLI

## Goal

Make cclinic usable with a single command, keep users informed about what will be sent to Claude, prevent expensive or unsafe mistakes, and behave predictably in terminals and scripts.

## Commands

```
cclinic [path] [options]    Generate documents. path defaults to the current directory
cclinic model [options]     Choose, list or reset the default model and reasoning level
cclinic doctor [path]       Check that cclinic is ready to run
cclinic skills [path]       Install the coding agent skills (see agent-skills)
cclinic clean [path]        Delete the cache and failed drafts
cclinic guide               Show the full walkthrough
cclinic help [command]      Same as --help
```

## Options

### General

| Option | Default | Meaning |
|---|---|---|
| `-h`, `--help` | | Show help |
| `-v`, `--version` | | Show the version |
| `-q`, `--quiet` | Off | Show only errors and the final result |
| `-d`, `--debug` | Off | Show diagnostic details on stderr |
| `--debug-file <path>` | None | Write diagnostic details to a file. Turns on debug details |
| `--json` | Off | Write the final result as JSON on stdout |
| `--color <mode>` | `auto` | `auto`, `always` or `never` |

### Generation

| Option | Default | Meaning |
|---|---|---|
| `-o`, `--out <dir>` | `<target>/.cclinic/sdd` | Output folder |
| `--provider <name>` | `auto` | `auto`, `claude-cli` or `anthropic-api` |
| `-m`, `--model [value]` | Saved default, or `sonnet` | See [model-selection](../model-selection/spec.md) |
| `--effort [value]` | Saved default, or `medium` | See [model-selection](../model-selection/spec.md) |
| `--include <glob>` | None | Force a path into the scan. Repeatable |
| `--exclude <glob>` | None | Force a path out of the scan. Repeatable |
| `-n`, `--dry-run` | Off | Scan and report only, with no generation or file writes |
| `-f`, `--force` | Off | Overwrite documents that were edited by hand |
| `-y`, `--yes` | Off | Skip the confirmation prompt |
| `--no-cache` | Off | Re-analyse everything, ignoring cached results |
| `--no-skills` | Off | Don't install the agent skills. See [agent-skills](../agent-skills/spec.md) |
| `--allow-broad-target` | Off | Allow running on a home folder or filesystem root |

### Limits

| Option | Default | Allowed | What it protects against |
|---|---|---|---|
| `--max-files <n>` | `10000` | 1 or more | Scanning far more than intended |
| `--max-input-tokens <n>` | `2000000` | 1 or more | Sending far more than intended. Cached modules don't count |
| `--max-file-size-mib <n>` | `1` | 1 to 50 | Large text files. Documents always have a 50 MiB limit |
| `--max-budget-usd <n>` | None | Above 0 | Spending too much in one run |
| `--concurrency <n>` | `4` | 1 to 16 | Hitting rate limits |
| `--timeout-minutes <n>` | `30` | 1 to 120 | A hung Claude call |
| `--max-retries <n>` | `2` | 0 to 10 | Temporary failures ending a run, or endless retrying |

The defaults are this project's choices, and should be reviewed once cclinic has been tested on real projects.

## Environment variables

| Variable | Meaning |
|---|---|
| `CCLINIC_PROVIDER` | Same as `--provider` |
| `CCLINIC_MODEL` | Same as `--model <value>` |
| `CCLINIC_EFFORT` | Same as `--effort <value>` |
| `ANTHROPIC_API_KEY` | API key for the Anthropic API provider |
| `NO_COLOR` | Turns off color when set and not empty |
| `XDG_CONFIG_HOME` | Base folder for saved defaults |

## Requirements

### Running

- **FR-CLI-001** `cclinic [path]` MUST analyse the given folder, or the current directory when no path is given. A missing path, or one that isn't a directory, MUST exit with the usage error code.
- **FR-CLI-002** cclinic MUST support the commands, options and environment variables above. Invalid option values MUST exit with the usage error code before any scan. Options MUST beat environment variables, which MUST beat saved defaults.
- **FR-CLI-003** `--dry-run` MUST print the pre-run summary and the skipped-file totals by reason. It MUST NOT generate anything with an LLM or write any files.
- **FR-CLI-004** Before any LLM call, cclinic MUST show the target folder, provider, auth method, model, reasoning level, included file counts by type, skipped file count, estimated tokens, and estimated cost where it can be calculated. It MUST also state that project content will be sent to Anthropic.
- **FR-CLI-005** cclinic MUST ask for confirmation after the summary unless `--yes` is set. If the user declines, it MUST exit with code 0 without sending anything. With no interactive terminal and no `--yes`, it MUST exit with the usage error code and not wait for input.
- **FR-CLI-006** Progress MUST go to stderr. The final result MUST go to stdout. Normal output MUST NOT include scanned file contents. Prompts and menus MUST write to stderr, so stdout stays clean for scripts.
- **FR-CLI-007** cclinic MUST use the [exit codes](#exit-codes) below.

### Help and output

- **FR-CLI-008** `--help` and `-h` MUST work in any position and for every command, with `cclinic help [command]` giving the same result. Help MUST include a description, at least two examples, every option with its default, and a pointer to `cclinic guide`. The main help MUST also explain how cclinic works and how to get started, and group its options. A mistyped command or option MUST suggest the closest match, and MUST NOT run it.
- **FR-CLI-009** `--quiet` MUST hide progress and warnings. `--debug` MUST add stage timings, provider commands with prompts removed, and stack traces on stderr. It MUST NOT show file contents, prompts, keys or secrets. Using both MUST be a usage error. `--debug-file` MUST write the same details to the given file, and MUST follow the same content rules.
- **FR-CLI-010** With `--json`, stdout MUST contain exactly one JSON object and nothing else, for success and for failure:
  - **Success:** `status`, output folder, spec, requirement and test case counts, warnings, tokens, estimated cost, duration
  - **Failure:** `status`, exit code, error type, message
  - **With `--dry-run`:** the summary, plus every included path and every skipped path or folder with its reason
- **FR-CLI-011** In `auto` mode, color MUST be off when the output stream isn't a terminal, `NO_COLOR` is set and not empty, or `TERM` is `dumb`, and each stream MUST be checked separately. `--color always` and `--color never` MUST override this. Output MUST still make sense without color.
- **FR-CLI-012** After a run, the result MUST show the output folder, counts of specs, requirements and test cases, tokens used, estimated cost, duration, how many modules came from the cache, and any warnings. When an LLM failure stops a run, the message MUST say that re-running the same command continues from where it stopped.

### Commands

- **FR-CLI-013** `cclinic doctor` MUST report each check as passed, failed or skipped, with a fix for each failure: Node.js version, Claude CLI found and its version, Claude CLI login, whether `ANTHROPIC_API_KEY` is set (never its value), which provider would be selected, saved model and reasoning level, whether the config is valid, whether the output folder is writable, whether the agent skills are installed, and whether a newer cclinic is on npm (skipped after a 5-second timeout). It MUST support `--json`. It MUST NOT call a model or read project contents. It MUST exit 0 if a provider is usable, and 3 if not.
- **FR-CLI-014** `cclinic clean` MUST delete only `.cclinic/cache/` and `.cclinic/failed/`, and report the space freed. It MUST NOT touch `.cclinic/sdd/`. It MUST ask for confirmation unless `--yes` is set, because cached results cost usage to rebuild. With no interactive terminal and no `--yes`, it MUST exit with the usage error code.

### Safety and limits

- **FR-CLI-015** At startup, cclinic MUST check the Node.js version. Below the minimum in [stack.md](../../stack.md#runtime), it MUST say which version is needed and exit with the usage error code.
- **FR-CLI-016** On Ctrl+C or SIGTERM, cclinic MUST print a message at once, stop running calls, remove temp files, and exit within 5 seconds. A second Ctrl+C MUST exit immediately. Completed summaries MUST stay in the cache.
- **FR-CLI-017** Before any LLM call, cclinic MUST check that the output and cache folders are writable. If not, it MUST exit with the usage error code without using any usage.
- **FR-CLI-018** Only one run MUST be active per target folder, using a lock file at `.cclinic/.lock` that holds the process ID. A second run MUST exit with the usage error code and name the active process. A lock left by a process that no longer exists MUST be replaced. `--dry-run` and `doctor` MUST NOT need the lock.
- **FR-CLI-019** If the target is the user's home folder or a filesystem root, cclinic MUST refuse with the usage error code unless `--allow-broad-target` is set, even with `--yes`.
- **FR-CLI-020** Each limit MUST be enforced within its allowed range. If the scan exceeds `--max-files` or the estimate exceeds `--max-input-tokens`, cclinic MUST stop before any generation, exit with the usage error code, and show the actual number, the limit, the flag to change it, and how to exclude files.
- **FR-CLI-021** cclinic MUST NOT collect analytics or telemetry. It MUST connect only to Anthropic through the selected provider, and to npm during the `doctor` version check. The Claude CLI is a separate program, so cclinic MUST ask it to turn off its nonessential traffic (FR-LLM-028).

### Guide

- **FR-CLI-022** `cclinic guide` MUST print a walkthrough covering requirements, each step from checking the setup to re-running, every command, how to use each skill, what's skipped, the limits with their defaults, common problems, and exit codes. It MUST work offline with no provider. After a successful generation, the result MUST say what to do next, and mention `cclinic guide`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, or the user declined at confirmation |
| 1 | Unexpected internal error |
| 2 | Usage error, including a reached scan limit, or a target that's locked or not writable |
| 3 | No provider available, or the requested provider isn't available |
| 4 | LLM failure, including exhausted retries and a reached budget |
| 5 | Generated documents failed validation |
| 130 | Cancelled with Ctrl+C |
| 143 | Stopped with SIGTERM |

## Edge cases

- A folder named `model`, `doctor`, `skills`, `clean`, `guide` or `help` is reached with `./`, such as `cclinic ./model`, because the plain name is the command.
- `--yes` doesn't suppress menus that were explicitly requested with a bare `--model` or `--effort`.
- `--json` with a bare `--model` still opens the menu in a terminal, because menus write to stderr.

## Non-goals

- Accepting API keys as command-line options, because they'd end up in shell history.
- A config file per project, or named profiles.
- Shell completions, a self-update command, or anything else listed in [ADR 0001](../../decisions/0001-cli-feature-scope.md).
