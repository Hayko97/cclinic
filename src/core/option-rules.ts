/** How an option value is refused, in the same words wherever it's checked: the CLI or the GUI (FR-GUI-015). */
import { validOptionsText } from "./models.js";

export function wholeNumberRule(minimum: number, maximum: number): string {
  const range = maximum === Number.MAX_SAFE_INTEGER ? `${minimum} or more` : `${minimum} to ${maximum}`;
  return `It must be a whole number from ${range}.`;
}

export const POSITIVE_NUMBER_RULE = "It must be a number above 0.";

export function oneOfRule(allowed: readonly string[]): string {
  return `It must be one of: ${allowed.join(", ")}.`;
}

/** The message the CLI's option parser gives, such as for `--max-files 0`. */
export function invalidOptionMessage(flag: string, value: unknown, rule: string): string {
  return `option '${flag}' argument '${String(value)}' is invalid. ${rule}`;
}

export function unknownModelMessage(value: string, source: string): string {
  return `"${value}" from ${source} isn't a known model.\n\n${validOptionsText()}`;
}

export function unknownEffortMessage(value: string, source: string): string {
  return `"${value}" from ${source} isn't a known reasoning level.\n\n${validOptionsText()}`;
}
