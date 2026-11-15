/** Option parsing rules that don't depend on the terminal. */
import { InvalidArgumentError } from "commander";
import { PLAN_ID_PATTERN } from "../core/constants/agents.js";
import { COMMANDS, MAX_TYPO_DISTANCE } from "../core/constants/terminal.js";
import { UsageError } from "../core/errors.js";
import { parseEffort, parseModel, type Effort, type ModelChoice } from "../core/models.js";
import {
  oneOfRule,
  POSITIVE_NUMBER_RULE,
  unknownEffortMessage,
  unknownModelMessage,
  wholeNumberRule,
} from "../core/option-rules.js";

export function integerInRange(minimum: number, maximum: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
      throw new InvalidArgumentError(wholeNumberRule(minimum, maximum));
    return parsed;
  };
}

export function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError(POSITIVE_NUMBER_RULE);
  return parsed;
}

export function positiveId(value: string): number {
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new InvalidArgumentError("It must be a whole number above 0.");
  return id;
}

export function oneOf<T extends string>(allowed: readonly T[]) {
  return (value: string): T => {
    const match = allowed.find((item) => item === value);
    if (match === undefined) throw new InvalidArgumentError(oneOfRule(allowed));
    return match;
  };
}

export function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function requireModel(value: string, source: string): ModelChoice {
  const model = parseModel(value);
  if (model === undefined) throw new UsageError(unknownModelMessage(value, source));
  return model;
}

export function requireEffort(value: string, source: string): Effort {
  const effort = parseEffort(value);
  if (effort === undefined) throw new UsageError(unknownEffortMessage(value, source));
  return effort;
}

export function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export function closestCommand(value: string): string | undefined {
  return COMMANDS.find((command) => editDistance(value, command) <= MAX_TYPO_DISTANCE);
}

/** FR-PLAN-001, FR-MCP-046: a planning session's ID, such as plan-3. */
export function planId(value: string): string {
  if (!PLAN_ID_PATTERN.test(value)) throw new InvalidArgumentError("must be a planning session ID, such as plan-3.");
  return value;
}
