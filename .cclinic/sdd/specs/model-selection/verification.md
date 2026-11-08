# model-selection: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest (npm scripts in package.json; `npm run verify` is the documented full check). Test locations: test/integration/cli-commands.test.ts, test/e2e/cli.test.ts, src/core/core.test.ts, src/core/constants/constants.test.ts.
- Set XDG_CONFIG_HOME to a fresh temp folder in every test so the real user config is never touched.
- Integration level: mock the @inquirer/prompts menus; real menus are checked manually in a real terminal.
- For non-interactive cases run the CLI with stdin/stdout not attached to a TTY.
- Use test/fixtures/fake-claude/claude in place of the real Claude CLI and never call the Anthropic API; use a small temp project folder as the target.
- Use --dry-run so no provider or cost is involved.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-MODEL-001 | FR-MODEL-001 | integration | XDG_CONFIG_HOME is an empty temp folder, CCLINIC_MODEL and CCLINIC_EFFORT are unset, a small temp project exists | Run `cclinic <project> --dry-run --json --yes` with no model options | No menu is opened and the output shows model sonnet / claude-sonnet-5-5 and effort medium; exit code 0. |
| TC-MODEL-002 | FR-MODEL-002 | integration | Saved config {"model":"haiku","effort":"low"}, CCLINIC_MODEL=opus, CCLINIC_EFFORT=high | Run a dry run with `--model sonnet` and no --effort | Model is sonnet (option beats env and saved); effort is high (env beats saved). |
| TC-MODEL-003 | FR-MODEL-002 | integration | Saved config {"model":"haiku","effort":"low"}, no env vars | Run a dry run with no options; then unset the config and run again | First run resolves haiku/low; second resolves sonnet/medium. Model and effort resolve independently when only one is saved. |
| TC-MODEL-004 | FR-MODEL-003 | integration | Temp XDG_CONFIG_HOME; menus mocked to choose opus then high; a project folder with files | Run `cclinic model` | Model menu appears before reasoning menu; config.json contains model opus and effort high; no files scanned and no provider called; exit 0. |
| TC-MODEL-005 | FR-MODEL-004 | integration | Saved config opus/high; menus mocked to choose haiku | Run `cclinic <project> --model --dry-run` | Menu opened once for model; dry-run summary shows haiku; config.json still contains opus/high. |
| TC-MODEL-006 | FR-MODEL-004 | integration | Menus mocked and call order recorded | Run `cclinic <project> --model --effort --dry-run` | The model menu opens first, then the reasoning menu; saved config unchanged. |
| TC-MODEL-007 | FR-MODEL-005 | e2e | No TTY, empty temp config | Run `cclinic <project> --model opus --effort high --dry-run` | No menu is attempted, summary shows opus and high, exit 0. |
| TC-MODEL-008 | FR-MODEL-005 | integration | Empty temp config | Run a dry run with `--model claude-opus-5-5` | The value is accepted and resolves to the opus model; exit 0. |
| TC-MODEL-009 | FR-MODEL-006 | e2e | A temp project | Run `cclinic <project> --model gpt --dry-run` and separately `--effort extreme` | Each exits with code 2, output lists the valid options (sonnet, opus, haiku, fable / low, medium, high, xhigh, max), and no scan happens. |
| TC-MODEL-010 | FR-MODEL-006 | e2e | CCLINIC_MODEL=bogus | Run `cclinic <project> --dry-run` | Exit code 2 and valid options are printed; no scan or LLM call. |
| TC-MODEL-011 | FR-MODEL-007 | e2e | stdin/stdout not a TTY | Run `cclinic <project> --model`, then `--effort`, then `cclinic model` | Each prints the valid options and exits 2 within a short time (does not hang). |
| TC-MODEL-012 | FR-MODEL-008 | integration | Menus mocked; an existing temp folder <project> | Run `cclinic --model <project> --dry-run` and `cclinic --effort <project> --dry-run` | <project> is the target folder, the matching menu opens, and no invalid-value error occurs. |
| TC-MODEL-013 | FR-MODEL-009 | e2e | Saved config opus/high, no TTY | Run `cclinic model --list` | Output lists all four models and five effort levels with label, value and hint, marks opus and high as current; exit 0. |
| TC-MODEL-014 | FR-MODEL-009 | e2e | Empty config, no TTY | Run `cclinic model --list --json` and parse stdout | Stdout is valid JSON containing all options and the current choice sonnet/medium. |
| TC-MODEL-015 | FR-MODEL-010 | integration | Saved config opus/high | Run `cclinic model --reset`, then `cclinic model --list` | Confirmation message printed; saved values are removed; current choice shows sonnet/medium. |
| TC-MODEL-016 | FR-MODEL-010 | integration | No config file exists | Run `cclinic model --reset` | Exit code 0 with a confirmation, no error. |
| TC-MODEL-017 | FR-MODEL-011 | integration | Saved config opus/high; menu mock rejects as cancelled (Ctrl+C) | Run `cclinic model`, cancelling at the first menu; repeat cancelling at the reasoning menu | Exit code 130 both times and config.json is unchanged. |
| TC-MODEL-018 | FR-MODEL-012 | manual | A real terminal and saved config opus/high | Run `cclinic model` and use arrow keys and Enter | Every option shows label and hint, the initial highlight is opus then high, arrows move, Enter selects. |
| TC-MODEL-019 | FR-MODEL-012 | unit | Model constants in src/core/constants/models.ts | Build menu choices, valid values list and error text | All three contain exactly the same set of options. |
| TC-MODEL-020 | FR-MODEL-013 | integration | XDG_CONFIG_HOME=<temp>; menus mocked to choose haiku/low | Run `cclinic model` | <temp>/cclinic/config.json exists with only keys model and effort. |
| TC-MODEL-021 | FR-MODEL-013 | integration | XDG_CONFIG_HOME unset and HOME set to a temp folder | Run `cclinic model` with mocked menus | Config written to <HOME>/.config/cclinic/config.json. |
| TC-MODEL-022 | FR-MODEL-013 | integration | config.json containing invalid JSON | Run a dry run | A warning is shown, the run succeeds with sonnet/medium. |
| TC-MODEL-023 | FR-MODEL-013 | integration | config.json {"model":"retired-model","effort":"high"} | Run a dry run | Warning about the model; model is sonnet; effort remains high. |
| TC-MODEL-024 | FR-MODEL-014 | integration | Menu mocked to choose opus; effort option high | Run `cclinic <project> --model --effort high --dry-run` | The model menu opens even in dry-run, and the summary shows opus and high; nothing scanned for sending or written. |
