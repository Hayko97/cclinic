import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AuthError,
  BudgetError,
  ProviderError,
  RateLimitError,
  RefusalError,
  SchemaError,
  TruncatedError,
} from "../../core/errors.js";
import { MODEL_OPTIONS, type ModelChoice } from "../../core/models.js";
import type { LlmRequest } from "../../core/ports.js";
import { buildApiRequest, createAnthropicApiProvider, interpretMessage, type ApiClient } from "./anthropic-api.js";
import { buildClaudeArgs, claudeEnvironment, interpretOutcome, parseStreamLines } from "./claude-cli.js";
import { backoffDelayMs, withSchemaRetry } from "./retry.js";
import { decideProvider } from "./select-provider.js";

const schema = z.object({ answer: z.string() });
const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };
const recorded = (name: string): unknown[] =>
  parseStreamLines(
    readFileSync(new URL(`../../../test/fixtures/recorded-cli-output/${name}.jsonl`, import.meta.url), "utf8"),
  );

function request(model: ModelChoice = "sonnet"): LlmRequest<{ answer: string }> {
  return { system: "system", prompt: "prompt", schema, model, effort: "medium" };
}

const goodMessage = {
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"answer":"ok"}' }],
  usage: { input_tokens: 100, output_tokens: 50 },
};

function fakeClient(
  stream: ApiClient["stream"],
  countTokens: ApiClient["countTokens"] = () => Promise.resolve(42),
): ApiClient {
  return { stream, countTokens };
}

function apiError(status: number, headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(status, { error: { message: "failure" } }, "failure", new Headers(headers));
}

describe("provider selection", () => {
  const loggedIn = { isInstalled: true, isLoggedIn: true, authMethod: "claude.ai", version: "2.1.319" };
  const loggedOut = { ...loggedIn, isLoggedIn: false };
  const missing = { ...loggedOut, isInstalled: false };

  it("TC-LLM-001: picks the CLI, then the API, or nothing", () => {
    expect(decideProvider("auto", loggedIn, true).kind).toBe("claude-cli");
    expect(decideProvider("auto", loggedIn, false).kind).toBe("claude-cli");
    expect(decideProvider("auto", loggedOut, true).kind).toBe("anthropic-api");
    expect(decideProvider("auto", missing, true).kind).toBe("anthropic-api");
    expect(decideProvider("auto", loggedOut, false).kind).toBe("none");
    expect(decideProvider("auto", missing, false).kind).toBe("none");
  });

  it("explicit choices don't fall back", () => {
    expect(decideProvider("claude-cli", missing, true).kind).toBe("none");
    expect(decideProvider("anthropic-api", loggedIn, false).kind).toBe("none");
  });
});

describe("Claude CLI output", () => {
  it("TC-LLM-011: a recorded success returns its data", () => {
    const outcome = interpretOutcome(recorded("success"), 0, "sonnet");
    expect(outcome.data).toEqual({ answer: "ok" });
    expect(outcome.actualModel).toBe("claude-sonnet-5-5");
    expect(outcome.costUsd).toBeCloseTo(0.0067889);
  });

  it("TC-LLM-012: subtype success doesn't make an invalid model pass", () => {
    expect(() => interpretOutcome(recorded("invalid-model"), 1, "sonnet")).toThrow(ProviderError);
  });

  it("TC-LLM-013: missing output and malformed lines are errors", () => {
    expect(() => interpretOutcome([{ type: "result", is_error: false }], 0, "sonnet")).toThrow(SchemaError);
    expect(() => interpretOutcome(parseStreamLines("not json\n"), 0, "sonnet")).toThrow(ProviderError);
  });

  it("TC-LLM-049: a 401 explains login, the other provider, and -p changes", () => {
    const run = (): unknown =>
      interpretOutcome([{ type: "result", is_error: true, api_error_status: 401 }], 1, "sonnet");
    expect(run).toThrow(AuthError);
    expect(run).toThrow(/claude auth login.*anthropic-api.*-p/s);
  });

  it("TC-LLM-050: an invalid model names it and suggests luseen model", () => {
    expect(() => interpretOutcome(recorded("invalid-model"), 1, "opus")).toThrow(/Opus 5\.5.*luseen model/);
  });

  it("TC-LLM-051: a reached budget raises BudgetError", () => {
    expect(() => interpretOutcome(recorded("budget"), 1, "sonnet")).toThrow(BudgetError);
  });

  it("TC-LLM-052: a model limit raises RateLimitError and suggests another model", () => {
    const events = [{ type: "result", is_error: true, result: "You've hit your Opus limit" }];
    const run = (): unknown => interpretOutcome(events, 1, "opus");
    expect(run).toThrow(RateLimitError);
    expect(run).toThrow(/choose another model/);
  });

  it("refusals and cut-offs are typed", () => {
    expect(() => interpretOutcome([{ type: "result", is_error: false, stop_reason: "refusal" }], 0, "sonnet")).toThrow(
      RefusalError,
    );
    expect(() =>
      interpretOutcome([{ type: "result", is_error: false, stop_reason: "max_tokens" }], 0, "sonnet"),
    ).toThrow(TruncatedError);
    expect(() =>
      interpretOutcome([{ type: "result", is_error: true, result: "max_output_tokens reached" }], 1, "sonnet"),
    ).toThrow(TruncatedError);
  });

  it("TC-LLM-046: API keys are removed, and limits are set", () => {
    const environment = claudeEnvironment({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", KEEP: "yes" }, 5);
    expect(environment["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(environment["KEEP"]).toBe("yes");
    expect(environment["CLAUDE_CODE_MAX_RETRIES"]).toBe("5");
    expect(environment["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("64000");
    expect(environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
  });

  it("TC-LLM-007: never uses --bare, and always disables tools", () => {
    const args = buildClaudeArgs({ model: "sonnet", effort: "medium", systemPromptFile: "f", schema: "{}" });
    expect(args).not.toContain("--bare");
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--max-budget-usd");
    expect(
      buildClaudeArgs({ model: "sonnet", effort: "low", systemPromptFile: "f", schema: "{}", maxBudgetUsd: 1.5 }),
    ).toContain("--max-budget-usd");
  });
});

describe("Anthropic API provider", () => {
  it("TC-LLM-016: each menu value sends its API ID", () => {
    for (const option of MODEL_OPTIONS) {
      expect(buildApiRequest(request(option.value) as LlmRequest<unknown>)["model"]).toBe(option.apiId);
    }
  });

  it("TC-LLM-017: defaults send 64000 tokens, adaptive thinking and medium effort", () => {
    const built = buildApiRequest(request());
    expect(built["max_tokens"]).toBe(64000);
    expect(built["thinking"]).toEqual({ type: "adaptive" });
    expect(built["output_config"]).toMatchObject({ effort: "medium" });
  });

  it("TC-LLM-018: the schema is sent, and bad output is rejected locally", () => {
    const built = buildApiRequest(request());
    expect(built["output_config"]).toMatchObject({ format: { type: "json_schema", schema: { type: "object" } } });
    const bad = { ...goodMessage, content: [{ type: "text", text: '{"wrong":1}' }] };
    expect(() => interpretMessage(bad, request())).toThrow(SchemaError);
    expect(() =>
      interpretMessage({ ...goodMessage, content: [{ type: "text", text: "not json" }] }, request()),
    ).toThrow(SchemaError);
  });

  it("TC-LLM-019: the system prompt is cached, and prohibited fields are absent", () => {
    const built = buildApiRequest(request());
    expect(built["system"]).toEqual([{ type: "text", text: "system", cache_control: { type: "ephemeral" } }]);
    for (const field of ["temperature", "top_p", "top_k", "budget_tokens"]) expect(built).not.toHaveProperty(field);
  });

  it("TC-LLM-020: refusal and cut-off raise typed errors", () => {
    expect(() => interpretMessage({ ...goodMessage, stop_reason: "refusal" }, request())).toThrow(RefusalError);
    expect(() => interpretMessage({ ...goodMessage, stop_reason: "max_tokens" }, request())).toThrow(TruncatedError);
  });

  it("TC-LLM-021: fallbacks are on for all models except Haiku", () => {
    for (const model of ["sonnet", "opus", "fable"] as const) {
      expect(buildApiRequest(request(model) as LlmRequest<unknown>)).toMatchObject({
        fallbacks: "default",
        betas: ["server-side-fallback-2026-07-01"],
      });
    }
    const haiku = buildApiRequest(request("haiku"));
    expect(haiku).not.toHaveProperty("fallbacks");
    expect(haiku).not.toHaveProperty("betas");
  });

  it("TC-LLM-022: actualModel is the model that answered", () => {
    expect(interpretMessage({ ...goodMessage, model: "claude-opus-5-5" }, request()).actualModel).toBe(
      "claude-opus-5-5",
    );
  });

  it.each([429, 500, 503])("TC-LLM-023: retries status %i at most the configured number of times", async (status) => {
    vi.useFakeTimers();
    try {
      const stream = vi.fn<ApiClient["stream"]>().mockRejectedValue(apiError(status));
      const provider = createAnthropicApiProvider({
        apiKey: "k",
        maxRetries: 2,
        timeoutMinutes: 1,
        logger: silent,
        client: fakeClient(stream),
      });
      const result = provider.generate(request()).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(Error);
      expect(stream).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TC-LLM-023: backoff delays grow with each attempt", () => {
    expect(backoffDelayMs(0, () => 1)).toBeLessThan(backoffDelayMs(1, () => 1));
    expect(backoffDelayMs(2, () => 0)).toBeGreaterThan(0);
  });

  it.each([401, 404, 400])("TC-LLM-024: status %i fails once, with no retry", async (status) => {
    const stream = vi.fn<ApiClient["stream"]>().mockRejectedValue(apiError(status));
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 5,
      timeoutMinutes: 1,
      logger: silent,
      client: fakeClient(stream),
    });
    await expect(provider.generate(request())).rejects.toBeInstanceOf(status === 401 ? AuthError : ProviderError);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("TC-LLM-027: one schema retry recovers, and two failures raise SchemaError", async () => {
    let calls = 0;
    await expect(
      withSchemaRetry(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new SchemaError("bad")) : Promise.resolve("good");
      }),
    ).resolves.toBe("good");
    await expect(withSchemaRetry(() => Promise.reject(new SchemaError("bad")))).rejects.toBeInstanceOf(SchemaError);
  });

  it("TC-LLM-028: API cost comes from token usage", async () => {
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 0,
      timeoutMinutes: 1,
      logger: silent,
      client: fakeClient(() => Promise.resolve(goodMessage)),
    });
    const result = await provider.generate(request());
    expect(result.data).toEqual({ answer: "ok" });
    expect(result.costUsd).toBeCloseTo((100 * 2 + 50 * 10) / 1_000_000);
  });

  it("TC-LLM-030: the API uses count_tokens", async () => {
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 0,
      timeoutMinutes: 1,
      logger: silent,
      client: fakeClient(() => Promise.resolve(goodMessage)),
    });
    await expect(provider.estimateTokens("text", "sonnet")).resolves.toBe(42);
  });

  it.each<[number, number]>([
    [0, 1],
    [5, 6],
  ])("TC-LLM-038: --max-retries %i makes %i attempts", async (maxRetries, attempts) => {
    vi.useFakeTimers();
    try {
      const stream = vi.fn<ApiClient["stream"]>().mockRejectedValue(apiError(500));
      const provider = createAnthropicApiProvider({
        apiKey: "k",
        maxRetries,
        timeoutMinutes: 1,
        logger: silent,
        client: fakeClient(stream),
      });
      const result = provider.generate(request()).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      await result;
      expect(stream).toHaveBeenCalledTimes(attempts);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TC-LLM-039: honours retry-after", async () => {
    vi.useFakeTimers();
    try {
      const stream = vi
        .fn<ApiClient["stream"]>()
        .mockRejectedValueOnce(apiError(429, { "retry-after": "30" }))
        .mockResolvedValue(goodMessage);
      const provider = createAnthropicApiProvider({
        apiKey: "k",
        maxRetries: 1,
        timeoutMinutes: 1,
        logger: silent,
        client: fakeClient(stream),
      });
      const result = provider.generate(request());
      await vi.advanceTimersByTimeAsync(29_000);
      expect(stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      await result;
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TC-LLM-042: falls back to characters when count_tokens fails, and says so", async () => {
    const warn = vi.fn();
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 0,
      timeoutMinutes: 1,
      logger: { ...silent, warn },
      client: fakeClient(
        () => Promise.resolve(goodMessage),
        () => Promise.reject(new Error("offline")),
      ),
    });
    await expect(provider.estimateTokens("12345678", "sonnet")).resolves.toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });
});
