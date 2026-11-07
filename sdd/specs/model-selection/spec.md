# Model selection

## Goal

Let users choose a model and reasoning level from console menus without knowing any values, use sensible defaults, and let scripts pass values directly.

## Commands

| Command | What it does |
|---|---|
| `cclinic model` | Opens the model menu and then the reasoning menu, and saves the choices as the default |
| `cclinic --model` | Opens the model menu for this run only |
| `cclinic --effort` | Opens the reasoning menu for this run only |
| `cclinic --model opus --effort high` | Skips the menus, for scripts and CI |
| `cclinic model --list` | Prints the options and the current choice, with `--json` for scripts |
| `cclinic model --reset` | Removes the saved default, going back to Sonnet at medium |

## Model and reasoning options

| Menu label | Value | API model ID | Hint |
|---|---|---|---|
| Sonnet 5.5 (default) | `sonnet` | `claude-sonnet-5-5` | Balanced speed and quality |
| Opus 5.5 | `opus` | `claude-opus-5-5` | Deeper analysis, higher cost |
| Haiku 5.5 | `haiku` | `claude-haiku-5-5` | Fastest and cheapest, for simple or very large projects |
| Fable 5.1 | `fable` | `claude-fable-5-1` | Most capable, highest cost |

| Menu label | Value | Hint |
|---|---|---|
| Low | `low` | Fastest, least thorough |
| Medium (default) | `medium` | Good balance for most projects |
| High | `high` | More thorough, slower |
| Extra high | `xhigh` | For complex codebases |
| Max | `max` | Most thorough, slowest and most expensive |

## Example menu

```
? Choose a model  (use arrow keys, Enter to select)
❯ Sonnet 5.5 (default)   Balanced speed and quality
  Opus 5.5               Deeper analysis, higher cost
  Haiku 5.5              Fastest and cheapest, for simple or very large projects
  Fable 5.1              Most capable, highest cost
```

## Requirements

- **FR-MODEL-001** `cclinic model` MUST show the model menu and then the reasoning menu, and save both choices. It MUST NOT scan any files.
- **FR-MODEL-002** `--model` without a value MUST open the model menu, and `--effort` without a value MUST open the reasoning menu. These choices apply to the current run only and MUST NOT change the saved default. When both are used, the model menu comes first.
- **FR-MODEL-003** `--model <value>` and `--effort <value>` MUST use the value without opening a menu.
- **FR-MODEL-004** Menus MUST list every option in the tables above with its label and hint, work with arrow keys and Enter, and mark the currently selected option. Pressing Ctrl+C MUST cancel without saving or running anything, and exit with code 130.
- **FR-MODEL-005** The model and reasoning level MUST be resolved separately, each in this order: command-line option, environment variable (`CCLINIC_MODEL`, `CCLINIC_EFFORT`), saved default, built-in default (`sonnet`, `medium`).
- **FR-MODEL-006** An invalid model or reasoning value, whether from an option or an environment variable, MUST print the valid options and exit with the usage error code, before any scan or LLM call.
- **FR-MODEL-007** If a menu is needed with no interactive terminal, including for `cclinic model`, cclinic MUST print the valid options and exit with the usage error code instead of waiting for input.
- **FR-MODEL-008** Because `--model` and `--effort` take optional values, `cclinic --model ./my-project` could be misread. If the value isn't a valid option but is an existing directory, cclinic MUST treat it as the target path and open the menu.
- **FR-MODEL-009** The options MUST come from the model constants in `src/core/constants/models.ts` ([llm-providers](../llm-providers/spec.md#model-constants)), shared by menus, validation and error messages. Model values MUST also accept the full API model ID.
- **FR-MODEL-010** The saved default MUST be stored at `$XDG_CONFIG_HOME/cclinic/config.json`, or `~/.config/cclinic/config.json` if that variable isn't set, as `{"model": "...", "effort": "..."}`. It MUST NOT hold API keys or project data. If the file is unreadable or holds an unknown value, cclinic MUST warn and use the built-in default for that setting.
- **FR-MODEL-011** `cclinic model --list` MUST print every model and reasoning option with its label, value and hint, and mark the current choice. With `--json`, it MUST print the same information as JSON. It MUST work with no terminal.
- **FR-MODEL-012** `cclinic model --reset` MUST remove the saved model and reasoning level, and confirm that it did. It MUST succeed if nothing was saved.

## Edge cases

- `--dry-run` with a bare `--model` still opens the menu, because the estimate depends on the model.
- If the user saved a model that a later cclinic version no longer lists, FR-MODEL-010's warning applies.

## Non-goals

- Fetching available models from a remote service. New models require a cclinic update.
- Different defaults per project.
