# model-selection

## Goal

Let users choose the Claude model and reasoning level through interactive menus, command-line options, environment variables or a saved default, with built-in defaults (Sonnet, medium) and fully scriptable, non-hanging behaviour.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-MODEL-001 | When no option, environment variable or saved default supplies a value, cclinic must use model sonnet (claude-sonnet-5-5) and reasoning level medium, without asking the user. | confirmed | `sdd/specs/model-selection/spec.md:20-33`, `src/core/constants/models.ts:6-42`, `src/core/models.ts:89-91`, `sdd/specs/model-selection/validation.md:7` |
| FR-MODEL-002 | cclinic must resolve model and reasoning level independently, each in the order: command-line option, environment variable (CCLINIC_MODEL / CCLINIC_EFFORT), saved default, built-in default. | confirmed | `sdd/specs/model-selection/spec.md:51`, `src/core/models.ts:89-91`, `sdd/specs/model-selection/verification.md:17`, `sdd/specs/model-selection/verification.md:27` |
| FR-MODEL-003 | `cclinic model` must open the model menu and then the reasoning menu, save both choices as the default, and must not scan any files. | confirmed | `sdd/specs/model-selection/spec.md:11`, `sdd/specs/model-selection/spec.md:47`, `src/cli/other-commands.ts:32-74`, `sdd/specs/model-selection/verification.md:9` |
| FR-MODEL-004 | `--model` or `--effort` given without a value must open the matching menu for this run only (model menu first when both are bare) and must not change the saved default. | confirmed | `sdd/specs/model-selection/spec.md:12-13`, `sdd/specs/model-selection/spec.md:48`, `sdd/specs/model-selection/verification.md:10-12` |
| FR-MODEL-005 | `--model <value>` and `--effort <value>` must skip the menus and accept the alias (sonnet, opus, haiku, fable; low, medium, high, xhigh, max) and, for models, also the full API model ID. | confirmed | `sdd/specs/model-selection/spec.md:14`, `sdd/specs/model-selection/spec.md:20-33`, `sdd/specs/model-selection/spec.md:49`, `sdd/specs/model-selection/verification.md:13`, `sdd/specs/model-selection/verification.md:24` |
| FR-MODEL-006 | An invalid model or effort value, from an option or an environment variable, must print the valid options and exit with the usage error code (2) before any scan or LLM call. | confirmed | `sdd/specs/model-selection/spec.md:52`, `sdd/specs/model-selection/verification.md:19`, `sdd/specs/model-selection/verification.md:28` |
| FR-MODEL-007 | When a menu is needed but no interactive terminal is available (including `cclinic model`), cclinic must print the valid options and exit with the usage error code (2) instead of waiting. | confirmed | `sdd/specs/model-selection/spec.md:53`, `sdd/specs/model-selection/verification.md:20`, `sdd/specs/model-selection/validation.md:11` |
| FR-MODEL-008 | When the value after `--model` or `--effort` is not a valid option but is an existing directory, cclinic must treat it as the target path and open the menu. | confirmed | `sdd/specs/model-selection/spec.md:54`, `sdd/specs/model-selection/verification.md:21-22` |
| FR-MODEL-009 | `cclinic model --list` must print every model and reasoning option with label, value and hint and mark the current choice; with `--json` it must print parseable JSON; it must work without a terminal. | confirmed | `sdd/specs/model-selection/spec.md:15`, `sdd/specs/model-selection/spec.md:57`, `sdd/specs/model-selection/verification.md:29`, `src/cli/other-commands.ts:32-74` |
| FR-MODEL-010 | `cclinic model --reset` must remove the saved model and reasoning level, confirm it, and succeed even if nothing was saved. | confirmed | `sdd/specs/model-selection/spec.md:16`, `sdd/specs/model-selection/spec.md:58`, `sdd/specs/model-selection/verification.md:30` |
| FR-MODEL-011 | Cancelling a menu with Ctrl+C must exit with code 130 and must leave the saved default unchanged. | confirmed | `sdd/specs/model-selection/spec.md:50`, `sdd/specs/model-selection/verification.md:15-16` |
| FR-MODEL-012 | Menus must list all options with labels and hints, support arrow keys and Enter, and start on the current choice; options must come from the single shared model constants. | confirmed | `sdd/specs/model-selection/spec.md:37-43`, `sdd/specs/model-selection/spec.md:55`, `sdd/specs/model-selection/verification.md:14`, `src/cli/menus.ts:2` |
| FR-MODEL-013 | The saved default must be stored as JSON with only `model` and `effort` at $XDG_CONFIG_HOME/cclinic/config.json (or ~/.config/cclinic/config.json); an unreadable file or unknown saved value must produce a warning and fall back to the built-in default for the bad setting only. | confirmed | `sdd/specs/model-selection/spec.md:56`, `sdd/specs/model-selection/spec.md:63`, `src/adapters/config/user-config.ts:10-13`, `src/adapters/config/user-config.ts:25-58`, `sdd/specs/model-selection/verification.md:25-26` |
| FR-MODEL-014 | `--dry-run` with a bare `--model` must still open the model menu, and the dry-run summary must show the resolved model and effort. | confirmed | `sdd/specs/model-selection/spec.md:62`, `sdd/specs/model-selection/verification.md:12`, `sdd/specs/model-selection/verification.md:18` |

## Edge cases

- Config file contains invalid JSON: warning, both settings fall back to defaults.
- Config has a valid effort but an unknown (retired) model: only the model falls back; effort kept.
- Env var CCLINIC_MODEL is invalid while --model is valid: option wins (check whether the env value is still rejected).
- XDG_CONFIG_HOME unset: config is read and written under the home folder's .config.
- `--model` followed by a path to an existing folder: folder is the target, menu opens.
- `--reset` when no config exists succeeds.
- Full API model ID (e.g. claude-opus-5-5) given as value.
- Ctrl+C at the second (reasoning) menu: nothing is saved, exit 130.
- Output piped (no TTY) with `--list --json`: still works.

## Non-goals

- Fetching the model list remotely; new models need a cclinic update.
- Per-project default model or effort.
- Storing API keys or project data in the saved config.
