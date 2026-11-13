/** Typed errors. Only cli/ turns these into messages and exit codes. */

export class CclinicError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends CclinicError {}
export class NoProviderError extends CclinicError {}
export class ValidationFailedError extends CclinicError {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
  }
}
export class CancelledError extends CclinicError {}
/** Exits like a Claude failure, but re-running starts this step again rather than continuing it. */
export class EnvironmentStepError extends CclinicError {}
/** A PM, developer or QA session stopped at a limit or on unusable replies. Re-running starts it again. */
export class AgentSessionError extends CclinicError {}

export class LlmError extends CclinicError {}
export class AuthError extends LlmError {}
export class RateLimitError extends LlmError {
  constructor(message: string, options?: ErrorOptions & { retryAfterMs?: number }) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
  readonly retryAfterMs: number | undefined;
}
export class RefusalError extends LlmError {}
export class TruncatedError extends LlmError {}
export class SchemaError extends LlmError {}
export class BudgetError extends LlmError {}
export class ProviderError extends LlmError {}
/** An agent's `claude` process failed. It keeps what the process cost before it stopped. */
export class AgentCallError extends LlmError {
  /** The agent process's exit code, or null when it didn't exit on its own (FR-AUTO-039). */
  readonly exitCode: number | null;

  /** FR-AUTO-025: Claude refused the call because a plan usage limit is reached. */
  readonly isUsageLimit: boolean;
  /** When that limit resets, if Claude Code said. */
  readonly resetsAt: string | null;

  constructor(
    message: string,
    readonly costUsd: number | null,
    options?: ErrorOptions & {
      readonly exitCode?: number | null;
      readonly isUsageLimit?: boolean;
      readonly resetsAt?: string | null;
    },
  ) {
    super(message, options);
    this.exitCode = options?.exitCode ?? null;
    this.isUsageLimit = options?.isUsageLimit ?? false;
    this.resetsAt = options?.resetsAt ?? null;
  }
}

/** The task database can't be used. It's expected, so it's reported without "unexpected" (FR-TASK-016). */
export class TaskDatabaseError extends CclinicError {}

export const EXIT_CODES = {
  success: 0,
  internal: 1,
  usage: 2,
  noProvider: 3,
  llm: 4,
  validation: 5,
  sigint: 130,
  sigterm: 143,
} as const;

export function exitCodeFor(error: unknown): number {
  if (error instanceof CancelledError) return EXIT_CODES.sigint;
  if (error instanceof UsageError) return EXIT_CODES.usage;
  if (error instanceof NoProviderError) return EXIT_CODES.noProvider;
  if (error instanceof LlmError || error instanceof EnvironmentStepError || error instanceof AgentSessionError)
    return EXIT_CODES.llm;
  if (error instanceof ValidationFailedError) return EXIT_CODES.validation;
  return EXIT_CODES.internal;
}

export const RESUME_HINT = "Re-running the same command continues from where it stopped.";
