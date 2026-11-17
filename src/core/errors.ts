/** Typed errors. Only cli/ turns these into messages and exit codes. */

export class LuseenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends LuseenError {}
export class NoProviderError extends LuseenError {}
export class ValidationFailedError extends LuseenError {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
  }
}
export class CancelledError extends LuseenError {}
/** Exits like a Claude failure, but re-running starts this step again rather than continuing it. */
export class EnvironmentStepError extends LuseenError {}
/** The design system step failed or reached a limit, so it exits like a Claude failure (FR-DSGN-030). */
export class DesignStepError extends LuseenError {}
/** A planning session approved or cancelled elsewhere, so it takes no more turns (FR-PLAN-032). */
export class SessionClosedError extends UsageError {
  constructor(
    readonly id: string,
    readonly status: string,
    readonly outcome: string | null,
  ) {
    super(`Planning session ${id} was ${status} elsewhere.${outcome === null ? "" : ` ${outcome}`}`);
  }
}
/** A PM, developer or QA session stopped at a limit or on unusable replies. Re-running starts it again. */
export class AgentSessionError extends LuseenError {}

export class LlmError extends LuseenError {}
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
export class TaskDatabaseError extends LuseenError {}

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
  if (
    error instanceof LlmError ||
    error instanceof EnvironmentStepError ||
    error instanceof DesignStepError ||
    error instanceof AgentSessionError
  )
    return EXIT_CODES.llm;
  if (error instanceof ValidationFailedError) return EXIT_CODES.validation;
  return EXIT_CODES.internal;
}

export const RESUME_HINT = "Re-running the same command continues from where it stopped.";
