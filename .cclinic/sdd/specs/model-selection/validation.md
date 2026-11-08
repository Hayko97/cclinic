# model-selection: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-MODEL-001 | FR-MODEL-001 | A first-time user wants to run cclinic without answering model questions. | With no setup, a run uses Sonnet at medium reasoning and no model question appears. |
| VAL-MODEL-002 | FR-MODEL-002, FR-MODEL-013 | A user wants predictable control over which choice wins and wants a damaged settings file not to block work. | A command-line choice overrides an environment setting, which overrides the saved default, which overrides the built-in default; a broken saved setting produces a warning and the run continues with the default. |
| VAL-MODEL-003 | FR-MODEL-003, FR-MODEL-012 | A user unfamiliar with model names wants to pick a model and reasoning level from menus with hints and keep it for later runs. | Running the model command shows a model menu then a reasoning menu with labels and hints, the current choice highlighted, and later runs use the saved choices; no project files are scanned. |
| VAL-MODEL-004 | FR-MODEL-004, FR-MODEL-008, FR-MODEL-014 | A user wants to try a different model or reasoning level for a single run only. | Asking for a menu in a run lets the user choose, the run uses the choice, and the saved default is the same afterwards; giving a folder after the option still works; a dry run shows the chosen values. |
| VAL-MODEL-005 | FR-MODEL-005 | A script author wants to set model and reasoning exactly. | Supplying both values directly runs with those values and no menu appears; short names and full model IDs both work. |
| VAL-MODEL-006 | FR-MODEL-006, FR-MODEL-007 | A user who mistypes a value, or runs without a terminal, wants clear guidance and no hang. | A wrong value or a menu request with no terminal shows the valid options, ends with a usage failure, and nothing is scanned or sent. |
| VAL-MODEL-007 | FR-MODEL-009, FR-MODEL-010 | A user wants to see available options and the current choice and to return to defaults easily. | The list command shows all options and marks the current choice (also as machine-readable output); the reset command returns to Sonnet at medium, even when nothing was saved. |
| VAL-MODEL-008 | FR-MODEL-011 | A user who changes their mind wants to cancel safely. | Pressing Ctrl+C in a menu ends the command as cancelled and the previously saved choice is unchanged. |
