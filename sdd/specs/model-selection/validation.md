# Model selection: validation

Acceptance criteria from the user's point of view.

| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-MODEL-001 | FR-MODEL-005 | It works well without any choices | A first-time user gets Sonnet at medium without having to answer anything about models |
| VAL-MODEL-002 | FR-MODEL-001, FR-MODEL-004, FR-MODEL-010 | I can choose a default without knowing any values | Someone who has never heard of the model names can pick a model and reasoning level from the menus using the hints, and later runs use that choice |
| VAL-MODEL-003 | FR-MODEL-002, FR-MODEL-004, FR-MODEL-008 | I can try another model once | I can choose a different model for one run, and my saved default stays the same |
| VAL-MODEL-004 | FR-MODEL-003, FR-MODEL-005 | Scripts can set exact values | A script can set both values without any menu appearing |
| VAL-MODEL-005 | FR-MODEL-006, FR-MODEL-007, FR-MODEL-009 | A wrong value tells me what's valid | A mistyped value, or a menu with no terminal, shows me the valid options and never hangs |
| VAL-MODEL-006 | FR-MODEL-011, FR-MODEL-012 | I can see and undo my choice | I can see the available options and my current choice, and go back to the defaults with one command |
