/** Backoff shared by a provider's parallel calls (FR-LLM-016), and the schema retry (FR-LLM-018). */
import { z, type ZodType } from "zod";
import {
  RETRY_BACKOFF_FACTOR,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_SHARE,
  RETRY_MAX_DELAY_MS,
} from "../../core/constants/llm.js";
import { CancelledError, SchemaError } from "../../core/errors.js";

/** The JSON Schema providers receive, without the `$schema` field that some of them reject. */
export function toJsonSchemaObject(schema: ZodType): Record<string, unknown> {
  const result: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete result["$schema"];
  return result;
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CancelledError("Cancelled."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancelledError("Cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** While a rate-limit backoff is running, no new calls start. */
export class BackoffGate {
  private pausedUntil = 0;

  pause(milliseconds: number): void {
    // Rounded up, because a fractional delay could leave wait() spinning without time passing.
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.ceil(milliseconds));
  }

  async wait(signal?: AbortSignal): Promise<void> {
    while (Date.now() < this.pausedUntil) {
      await sleep(this.pausedUntil - Date.now(), signal);
    }
  }
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = exponential * RETRY_JITTER_SHARE;
  return exponential - jitter + random() * jitter;
}

export function parseValidated<T>(value: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new SchemaError(`Claude's response didn't match the expected format: ${parsed.error.issues.length} problems.`);
}

/** Output that fails the schema gets one more try. */
export async function withSchemaRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return attempt();
  }
}
