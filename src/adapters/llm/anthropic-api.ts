/** Reaches Claude through the Anthropic API. This is the only file that may import the SDK. */
import Anthropic from "@anthropic-ai/sdk";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../../core/constants/limits.js";
import {
  FALLBACK_BETA,
  FALLBACK_MODE,
  HTTP_STATUS,
  MAX_OUTPUT_TOKENS,
  RETRYABLE_STATUSES,
} from "../../core/constants/llm.js";
import { CLAUDE_MODELS_WITH_FALLBACK } from "../../core/constants/models.js";
import {
  AuthError,
  CancelledError,
  ProviderError,
  RateLimitError,
  RefusalError,
  RESUME_HINT,
  SchemaError,
  TruncatedError,
} from "../../core/errors.js";
import {
  apiIdFor,
  costFromUsage,
  estimateTokensFromChars,
  labelForModel,
  type ModelChoice,
} from "../../core/models.js";
import type { Logger, LlmProvider, LlmRequest, LlmResult } from "../../core/ports.js";
import { BackoffGate, backoffDelayMs, parseValidated, sleep, toJsonSchemaObject, withSchemaRetry } from "./retry.js";

export function buildApiRequest(request: LlmRequest<unknown>): Record<string, unknown> {
  const usesFallback = CLAUDE_MODELS_WITH_FALLBACK.includes(request.model);
  return {
    model: apiIdFor(request.model),
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" },
    // Always sent, because Sonnet 5.5's own default is high (FR-LLM-011).
    output_config: {
      effort: request.effort,
      format: { type: "json_schema", schema: toJsonSchemaObject(request.schema) },
    },
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.prompt }],
    ...(usesFallback ? { betas: [FALLBACK_BETA], fallbacks: FALLBACK_MODE } : {}),
  };
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * MS_PER_SECOND : undefined;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (!(error instanceof Anthropic.APIError)) return false;
  const status: unknown = error.status;
  return typeof status === "number" && (status >= HTTP_STATUS.SERVER_ERROR_MINIMUM || RETRYABLE_STATUSES.has(status));
}

function translateError(error: unknown, model: ModelChoice): Error {
  if (error instanceof Anthropic.APIUserAbortError) return new CancelledError("Cancelled.");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AuthError("The Anthropic API rejected ANTHROPIC_API_KEY. Check that it's correct and active.", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError(
      `${labelForModel(model)} isn't available to this account. Run "cclinic model" to choose another model.`,
      { cause: error },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new RateLimitError(`The Anthropic API's rate limit was reached. ${RESUME_HINT}`, { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ProviderError(
      `The Anthropic API rejected the request for ${labelForModel(model)}. Run "cclinic model" to try another model.`,
      { cause: error },
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Couldn't reach the Anthropic API. Check your network connection.", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderError(`The Anthropic API failed with status ${error.status ?? "unknown"}.`, { cause: error });
  }
  return error instanceof Error ? error : new ProviderError("The Anthropic API call failed.");
}

interface ApiMessage {
  readonly model: string;
  readonly stop_reason: string | null;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  };
}

/** Checks `stop_reason` before reading any content (FR-LLM-014). */
export function interpretMessage<T>(message: ApiMessage, request: LlmRequest<T>): LlmResult<T> {
  if (message.stop_reason === "refusal") throw new RefusalError("Claude declined this request.");
  if (message.stop_reason === "max_tokens")
    throw new TruncatedError("Claude's response was cut off by the output limit.");
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SchemaError("Claude's response wasn't valid JSON.", { cause: error });
  }
  const { usage } = message;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    data: parseValidated(parsed, request.schema),
    actualModel: message.model,
    costUsd: costFromUsage(message.model, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    }),
    inputTokens: usage.input_tokens + cacheRead + cacheWrite,
    outputTokens: usage.output_tokens,
  };
}

/** The part of the SDK client this provider uses, so tests can supply a fake. */
export interface ApiClient {
  stream(params: Record<string, unknown>, options: { signal?: AbortSignal; timeout: number }): Promise<ApiMessage>;
  countTokens(params: Record<string, unknown>): Promise<number>;
}

function createSdkClient(apiKey: string): ApiClient {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async stream(params, options) {
      // The fallback and output_config fields are newer than the SDK's parameter types.
      const typedParams = params as unknown as Parameters<typeof client.beta.messages.stream>[0];
      const stream = client.beta.messages.stream(typedParams, options);
      return await stream.finalMessage();
    },
    async countTokens(params) {
      const { input_tokens: tokens } = await client.messages.countTokens(
        params as unknown as Anthropic.MessageCountTokensParams,
      );
      return tokens;
    },
  };
}

export interface AnthropicApiOptions {
  readonly apiKey: string;
  readonly maxRetries: number;
  readonly timeoutMinutes: number;
  readonly logger: Logger;
  readonly client?: ApiClient;
}

export function createAnthropicApiProvider(options: AnthropicApiOptions): LlmProvider {
  const client = options.client ?? createSdkClient(options.apiKey);
  const gate = new BackoffGate();
  let hasWarnedAboutCounting = false;

  const callWithRetries = async <T>(request: LlmRequest<T>): Promise<LlmResult<T>> => {
    const { signal } = request;
    for (let attempt = 0; ; attempt += 1) {
      await gate.wait(signal);
      if (signal?.aborted === true) throw new CancelledError("Cancelled.");
      try {
        const message = await client.stream(buildApiRequest(request), {
          timeout: options.timeoutMinutes * MS_PER_MINUTE,
          ...(signal === undefined ? {} : { signal }),
        });
        return interpretMessage(message, request);
      } catch (error) {
        if (attempt >= options.maxRetries || !isRetryable(error)) throw translateError(error, request.model);
        const headers = error instanceof Anthropic.APIError ? (error.headers as Headers | undefined) : undefined;
        const delay = parseRetryAfterMs(headers) ?? backoffDelayMs(attempt);
        if (error instanceof Anthropic.RateLimitError) gate.pause(delay);
        options.logger.info(
          `  Retrying after a temporary API failure (attempt ${attempt + 1} of ${options.maxRetries})`,
        );
        await sleep(delay, signal);
      }
    }
  };

  return {
    name: "anthropic-api",
    isSubscription: false,
    describeAuth: () => Promise.resolve("ANTHROPIC_API_KEY"),
    async estimateTokens(text, model) {
      try {
        return await client.countTokens({ model: apiIdFor(model), messages: [{ role: "user", content: text }] });
      } catch {
        if (!hasWarnedAboutCounting) {
          options.logger.warn("Couldn't reach the token counter, so tokens are estimated from characters.");
          hasWarnedAboutCounting = true;
        }
        return estimateTokensFromChars(text);
      }
    },
    generate: (request) => withSchemaRetry(() => callWithRetries(request)),
  };
}
