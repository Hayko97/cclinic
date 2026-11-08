/** Console menus. They write to stderr, so stdout stays clean for scripts (FR-CLI-006). */
import { confirm, select } from "@inquirer/prompts";
import { MENU_COLUMN_GAP } from "../core/constants/terminal.js";
import { CancelledError, UsageError } from "../core/errors.js";
import { EFFORT_OPTIONS, MODEL_OPTIONS, validOptionsText, type Effort, type ModelChoice } from "../core/models.js";

function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

async function prompting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isCancel(error)) throw new CancelledError("Cancelled.", { cause: error });
    throw error;
  }
}

export function isInteractive(): boolean {
  return process.stdin.isTTY;
}

export function requireTerminal(): void {
  if (!isInteractive()) {
    throw new UsageError(`A menu needs an interactive terminal, so pass a value instead.\n\n${validOptionsText()}`);
  }
}

const WIDTH = Math.max(
  ...MODEL_OPTIONS.map((option) => option.label.length),
  ...EFFORT_OPTIONS.map((option) => option.label.length),
);

export function menuChoices<T extends string>(
  options: readonly { value: T; label: string; hint: string }[],
): { value: T; name: string }[] {
  return options.map((option) => ({
    value: option.value,
    name: `${option.label.padEnd(WIDTH + MENU_COLUMN_GAP)} ${option.hint}`,
  }));
}

export function chooseModel(current: ModelChoice): Promise<ModelChoice> {
  requireTerminal();
  return prompting(() =>
    select(
      {
        message: "Choose a model",
        choices: menuChoices(MODEL_OPTIONS),
        default: current,
        pageSize: MODEL_OPTIONS.length,
      },
      { output: process.stderr },
    ),
  );
}

export function chooseEffort(current: Effort): Promise<Effort> {
  requireTerminal();
  return prompting(() =>
    select(
      {
        message: "Choose a reasoning level",
        choices: menuChoices(EFFORT_OPTIONS),
        default: current,
        pageSize: EFFORT_OPTIONS.length,
      },
      { output: process.stderr },
    ),
  );
}

export function askToConfirm(message: string, defaultAnswer = false): Promise<boolean> {
  return prompting(() => confirm({ message, default: defaultAnswer }, { output: process.stderr }));
}
