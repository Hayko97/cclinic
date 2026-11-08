/** Fixed values used by the providers (FR-LLM-035). API keys never belong here (FR-LLM-036). */

/** Change this whenever a prompt or schema changes, so cached results are not reused. */
export const PROMPT_VERSION = "3";

export const MAX_OUTPUT_TOKENS = 64_000;
export const CHARS_PER_TOKEN = 4;

export const CLAUDE_COMMAND = "claude";
export const CLAUDE_CLI_MAX_TURNS = 3;
export const TESTED_CLAUDE_VERSION = [2, 1, 319] as const;
export const CLAUDE_PROBE_TIMEOUT_MS = 20_000;
export const CLAUDE_PROBE_MAX_OUTPUT_BYTES = 1_048_576;
export const PROCESS_KILL_GRACE_MS = 2000;
export const BUDGET_DECIMAL_PLACES = 6;
export const ERROR_DETAIL_MAX_CHARS = 500;

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const FALLBACK_MODE = "default";

export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRY_BACKOFF_FACTOR = 2;
/** The share of each delay that's randomised, so parallel calls don't all retry together. */
export const RETRY_JITTER_SHARE = 0.5;

export const HTTP_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR_MINIMUM: 500,
} as const;

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  HTTP_STATUS.REQUEST_TIMEOUT,
  HTTP_STATUS.CONFLICT,
  HTTP_STATUS.TOO_MANY_REQUESTS,
]);

/** Names only. The values are read from the environment at startup. */
export const ENV_VARS = {
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  ANTHROPIC_AUTH_TOKEN: "ANTHROPIC_AUTH_TOKEN",
  CLAUDE_MAX_RETRIES: "CLAUDE_CODE_MAX_RETRIES",
  CLAUDE_MAX_OUTPUT_TOKENS: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  PROVIDER: "CCLINIC_PROVIDER",
  MODEL: "CCLINIC_MODEL",
  EFFORT: "CCLINIC_EFFORT",
  NO_COLOR: "NO_COLOR",
  TERM: "TERM",
  XDG_CONFIG_HOME: "XDG_CONFIG_HOME",
} as const;

export const PROVIDER_CHOICES = ["auto", "claude-cli", "anthropic-api"] as const;
