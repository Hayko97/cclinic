/** Model and reasoning options as the rest of the tool uses them, built from the constants (FR-MODEL-009). */
import { CHARS_PER_TOKEN } from "./constants/llm.js";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_PRICES,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  ESTIMATED_OUTPUT_RATIO,
  HAIKU_LONG_PROMPT,
  TOKENS_PER_MILLION,
} from "./constants/models.js";
import { LIST_VALUE_WIDTH } from "./constants/terminal.js";

export type ModelChoice = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS]["value"];
export type Effort = (typeof CLAUDE_EFFORTS)[keyof typeof CLAUDE_EFFORTS]["value"];

export interface ModelOption {
  readonly value: ModelChoice;
  readonly label: string;
  readonly apiId: string;
  readonly hint: string;
}

export interface EffortOption {
  readonly value: Effort;
  readonly label: string;
  readonly hint: string;
}

const withDefaultMark = (label: string, isDefault: boolean): string => (isDefault ? `${label} (default)` : label);

export const DEFAULT_MODEL: ModelChoice = DEFAULT_CLAUDE_MODEL.value;
export const DEFAULT_EFFORT: Effort = DEFAULT_CLAUDE_EFFORT.value;

export const MODEL_OPTIONS: readonly ModelOption[] = Object.values(CLAUDE_MODELS).map((model) => ({
  ...model,
  label: withDefaultMark(model.label, model.value === DEFAULT_MODEL),
}));

export const EFFORT_OPTIONS: readonly EffortOption[] = Object.values(CLAUDE_EFFORTS).map((effort) => ({
  ...effort,
  label: withDefaultMark(effort.label, effort.value === DEFAULT_EFFORT),
}));

/** Accepts a menu value or a full API model ID. */
export function parseModel(value: string): ModelChoice | undefined {
  return MODEL_OPTIONS.find((option) => option.value === value || option.apiId === value)?.value;
}

export function parseEffort(value: string): Effort | undefined {
  return EFFORT_OPTIONS.find((option) => option.value === value)?.value;
}

export function apiIdFor(model: ModelChoice): string {
  const option = MODEL_OPTIONS.find((candidate) => candidate.value === model);
  if (option === undefined) throw new Error(`Unknown model: ${model}`);
  return option.apiId;
}

export function labelForModel(model: ModelChoice): string {
  return Object.values(CLAUDE_MODELS).find((option) => option.value === model)?.label ?? model;
}

export function labelForEffort(effort: Effort): string {
  return Object.values(CLAUDE_EFFORTS).find((option) => option.value === effort)?.label ?? effort;
}

export function validOptionsText(): string {
  const models = MODEL_OPTIONS.map(
    (option) => `  ${option.value.padEnd(LIST_VALUE_WIDTH)}${option.label}: ${option.hint}`,
  );
  const efforts = EFFORT_OPTIONS.map(
    (option) => `  ${option.value.padEnd(LIST_VALUE_WIDTH)}${option.label}: ${option.hint}`,
  );
  return ["Models (--model):", ...models, "", "Reasoning levels (--effort):", ...efforts].join("\n");
}

export interface SettingSources<T> {
  readonly option: T | undefined;
  readonly environment: T | undefined;
  readonly saved: T | undefined;
  readonly fallback: T;
}

/** Option, then environment variable, then saved default, then built-in default (FR-MODEL-005). */
export function resolveSetting<T>(sources: SettingSources<T>): T {
  return sources.option ?? sources.environment ?? sources.saved ?? sources.fallback;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export function costFromUsage(apiId: string, usage: TokenUsage): number | null {
  const base = CLAUDE_PRICES[apiId];
  if (base === undefined) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const promptTokens = usage.inputTokens + cacheRead + cacheWrite;
  const price =
    apiId === HAIKU_LONG_PROMPT.modelId && promptTokens > HAIKU_LONG_PROMPT.tokens ? HAIKU_LONG_PROMPT.price : base;
  const dollars =
    usage.inputTokens * price.input +
    cacheRead * price.input * CACHE_READ_MULTIPLIER +
    cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
    usage.outputTokens * price.output;
  return dollars / TOKENS_PER_MILLION;
}

/** Input tokens plus an assumed 25% output (FR-LLM-022). A rough guide, not a quote. */
export function estimateCostUsd(model: ModelChoice, inputTokens: number): number | null {
  const outputTokens = Math.ceil(inputTokens * ESTIMATED_OUTPUT_RATIO);
  return costFromUsage(apiIdFor(model), { inputTokens, outputTokens });
}

export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
