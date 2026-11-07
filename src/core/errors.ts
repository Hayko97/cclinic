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
  if (error instanceof LlmError) return EXIT_CODES.llm;
  if (error instanceof ValidationFailedError) return EXIT_CODES.validation;
  return EXIT_CODES.internal;
}

export const RESUME_HINT = "Re-running the same command continues from where it stopped.";
