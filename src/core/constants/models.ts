/**
 * All model data, by family (FR-LLM-032). To add or change a model, edit only this file.
 * Everything else imports it, including menus, validation, provider requests and cost estimates.
 */

export const CLAUDE_MODELS = {
  SONNET: {
    value: "sonnet",
    apiId: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    hint: "Balanced speed and quality",
  },
  OPUS: {
    value: "opus",
    apiId: "claude-opus-5-5",
    label: "Opus 5.5",
    hint: "Deeper analysis, higher cost",
  },
  HAIKU: {
    value: "haiku",
    apiId: "claude-haiku-5-5",
    label: "Haiku 5.5",
    hint: "Fastest and cheapest, for simple or very large projects",
  },
  FABLE: {
    value: "fable",
    apiId: "claude-fable-5-1",
    label: "Fable 5.1",
    hint: "Most capable, highest cost",
  },
} as const;

export const CLAUDE_EFFORTS = {
  LOW: { value: "low", label: "Low", hint: "Fastest, least thorough" },
  MEDIUM: { value: "medium", label: "Medium", hint: "Good balance for most projects" },
  HIGH: { value: "high", label: "High", hint: "More thorough, slower" },
  XHIGH: { value: "xhigh", label: "Extra high", hint: "For complex codebases" },
  MAX: { value: "max", label: "Max", hint: "Most thorough, slowest and most expensive" },
} as const;

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS.SONNET;
export const DEFAULT_CLAUDE_EFFORT = CLAUDE_EFFORTS.MEDIUM;

/**
 * Not selectable until a Codex provider has its own spec (FR-LLM-034).
 * IDs are from OpenAI's Codex models page, checked on 2026-11-07. Recheck them when a provider is built.
 */
export const CODEX_MODELS = {
  ASTRA: { apiId: "gpt-6-astra", label: "GPT-6 Astra" },
  SOL: { apiId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  TERRA: { apiId: "gpt-6.1-terra", label: "GPT-6.1 Terra", minimumCliVersion: "0.159.0" },
  LUNA: { apiId: "gpt-6-luna", label: "GPT-6 Luna" },
} as const;

/** `max` and `ultra` vary by model. OpenAI's docs don't give a complete table of which model allows which. */
export const CODEX_EFFORTS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
  MAX: "max",
  ULTRA: "ultra",
} as const;

/** Haiku 5.5 has no server-side refusal fallback (FR-LLM-015). */
export const CLAUDE_MODELS_WITH_FALLBACK: readonly string[] = [
  CLAUDE_MODELS.SONNET.value,
  CLAUDE_MODELS.OPUS.value,
  CLAUDE_MODELS.FABLE.value,
];

export interface Price {
  readonly input: number;
  readonly output: number;
}

/** US dollars per million tokens. API rates cached on 2026-10-06. Update on each release. */
export const CLAUDE_PRICES: Readonly<Record<string, Price>> = {
  [CLAUDE_MODELS.SONNET.apiId]: { input: 2, output: 10 },
  [CLAUDE_MODELS.OPUS.apiId]: { input: 4, output: 20 },
  [CLAUDE_MODELS.HAIKU.apiId]: { input: 0.1, output: 0.5 },
  [CLAUDE_MODELS.FABLE.apiId]: { input: 10, output: 50 },
};

/** Haiku costs more above this many tokens in one prompt. */
export const HAIKU_LONG_PROMPT = {
  modelId: CLAUDE_MODELS.HAIKU.apiId,
  tokens: 100_000,
  price: { input: 0.5, output: 2.5 },
} as const;

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const TOKENS_PER_MILLION = 1_000_000;
export const ESTIMATED_OUTPUT_RATIO = 0.25;
