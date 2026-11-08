/** Values for command-line output. */

export const COMMANDS = ["model", "doctor", "skills", "environment", "clean", "guide", "help"] as const;
export const MAX_TYPO_DISTANCE = 2;

/** Skips the Node.js executable and script path in process.argv. */
export const ARGV_OFFSET = 2;

export const ANSI = { BOLD: 1, DIM: 2, RED: 31, YELLOW: 33 } as const;

export const LIST_VALUE_WIDTH = 8;
export const LIST_LABEL_WIDTH = 22;
export const MENU_COLUMN_GAP = 2;

export const JSON_INDENT = 2;
export const USD_DECIMAL_PLACES = 2;
export const SIZE_DECIMAL_PLACES = 1;
