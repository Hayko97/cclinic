# Model selection: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:** set `XDG_CONFIG_HOME` to a temp folder for each test. For menus, mock `@inquirer/prompts` at integration level. Real menus need a real terminal (`manual`), or a pseudo-terminal if the tester adds one later.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-MODEL-001 | FR-MODEL-001 | integration | Mocked menus choose Opus and High | Run `cclinic model` | Both menus open in order, the config holds `opus` and `high`, and no scan runs |
| TC-MODEL-002 | FR-MODEL-002 | integration | Saved default is Haiku, and a mocked menu chooses Opus | Run `cclinic --model --dry-run` | The summary shows Opus, and the config still says Haiku |
| TC-MODEL-003 | FR-MODEL-002 | integration | Mocked menus | Run `cclinic --effort --dry-run` | Only the reasoning menu opens, and its choice is shown in the summary |
| TC-MODEL-004 | FR-MODEL-002 | integration | Mocked menus | Run `cclinic --model --effort --dry-run` | The model menu opens first, then the reasoning menu |
| TC-MODEL-005 | FR-MODEL-003 | integration | Spy on menus | Run `--model opus --effort high --dry-run` | No menu opens, and the summary shows Opus and High |
| TC-MODEL-006 | FR-MODEL-004 | unit | The built-in tables | Build the menu choices | Every option appears with its label and hint, and the current choice is the initial selection |
| TC-MODEL-007 | FR-MODEL-004 | integration | A mocked menu raises a cancel error | Run `cclinic model` | Exit code is 130, and the config is unchanged |
| TC-MODEL-008 | FR-MODEL-004 | manual | A real terminal | Run `cclinic model`, use the arrow keys and Enter, and repeat with Ctrl+C | Menus work, hints are readable, and Ctrl+C exits with nothing saved |
| TC-MODEL-009 | FR-MODEL-005 | unit | Each combination of option, saved value and neither, for each setting | Resolve settings | Option beats saved beats default, and the two settings resolve separately |
| TC-MODEL-010 | FR-MODEL-005 | e2e | No config file | Run `--dry-run` | The summary shows Sonnet 5.5 and Medium |
| TC-MODEL-011 | FR-MODEL-006 | e2e | None | Run `--model nope`, then `--effort nope` | Each prints the valid options and exits 2, with no scan |
| TC-MODEL-012 | FR-MODEL-007 | e2e | Stdin isn't a terminal | Run bare `--model`, bare `--effort`, and `cclinic model`, each with a 10-second limit | Each prints the valid options and exits 2 before the limit |
| TC-MODEL-013 | FR-MODEL-008 | integration | `sample-project` exists, and a mocked menu | Run `--model ./sample-project` | The folder is the target, and the menu opens |
| TC-MODEL-014 | FR-MODEL-008 | integration | `sample-project` exists, and a mocked menu | Run `--effort ./sample-project` | The folder is the target, and the reasoning menu opens |
| TC-MODEL-015 | FR-MODEL-009 | unit | The built-in tables | Compare menu options, valid values and error text | All come from the same list |
| TC-MODEL-016 | FR-MODEL-009 | e2e | None | Run `--model claude-opus-5-5 --dry-run` | The value is accepted, and Opus 5.5 is shown |
| TC-MODEL-017 | FR-MODEL-010 | integration | `XDG_CONFIG_HOME` set, then unset with a temp `HOME` | Save a choice | The file is in the right place, and holds only `model` and `effort` |
| TC-MODEL-018 | FR-MODEL-010 | integration | A corrupt config, then one with an unknown model and a valid effort | Run `--dry-run` | Each warns and uses the default for the bad setting only, and the valid effort is kept |
| TC-MODEL-019 | FR-MODEL-005 | unit | Each combination of option, environment variable and saved value | Resolve settings | Option beats environment variable beats saved value |
| TC-MODEL-020 | FR-MODEL-006 | e2e | `CCLINIC_MODEL=nope`, then `CCLINIC_EFFORT=nope` | Run `--dry-run` | Each prints the valid options and exits 2 |
| TC-MODEL-021 | FR-MODEL-011 | e2e | A saved choice, and no terminal | Run `cclinic model --list`, then with `--json` | All options appear and the current choice is marked. The JSON form parses |
| TC-MODEL-022 | FR-MODEL-012 | e2e | A saved choice, then nothing saved | Run `cclinic model --reset`, then `--dry-run` | Both resets succeed, and the summary shows Sonnet 5.5 and Medium |
