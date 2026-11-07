import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthError, CancelledError, ProviderError, RateLimitError } from "../../core/errors.js";
import { createAnthropicApiProvider, type ApiClient } from "./anthropic-api.js";
import { createClaudeCliProvider, parseStreamLines } from "./claude-cli.js";
import { BackoffGate, sleep } from "./retry.js";

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };
const request = { system: "s", prompt: "p", schema: z.object({}), model: "sonnet", effort: "low" } as const;

function providerFailingWith(error: unknown) {
  const stream = vi.fn<ApiClient["stream"]>().mockRejectedValue(error);
  const client: ApiClient = { stream, countTokens: () => Promise.resolve(1) };
  return createAnthropicApiProvider({ apiKey: "k", maxRetries: 0, timeoutMinutes: 1, logger: silent, client });
}

function statusError(status: number): Error {
  return Anthropic.APIError.generate(status, { error: { message: "failure" } }, "failure", new Headers());
}

describe("Anthropic API error translation", () => {
  it.each<[string, unknown, new (...args: never[]) => Error]>([
    ["a forbidden key", statusError(403), AuthError],
    ["an unavailable model", statusError(404), ProviderError],
    ["a rate limit", statusError(429), RateLimitError],
    ["a bad request", statusError(400), ProviderError],
    ["a server error", statusError(500), ProviderError],
    ["a connection failure", new Anthropic.APIConnectionError({ message: "offline" }), ProviderError],
    ["a cancelled call", new Anthropic.APIUserAbortError(), CancelledError],
  ])("translates %s", async (_name, error, expected) => {
    await expect(providerFailingWith(error).generate(request)).rejects.toBeInstanceOf(expected);
  });

  it("passes other errors through unchanged", async () => {
    const original = new Error("something else");
    await expect(providerFailingWith(original).generate(request)).rejects.toBe(original);
  });

  it("wraps values that aren't errors", async () => {
    await expect(providerFailingWith("text").generate(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("stops before calling when already cancelled", async () => {
    const stream = vi.fn<ApiClient["stream"]>();
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 0,
      timeoutMinutes: 1,
      logger: silent,
      client: { stream, countTokens: () => Promise.resolve(1) },
    });
    await expect(provider.generate({ ...request, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError);
    expect(stream).not.toHaveBeenCalled();
  });

  it("describes itself as API-billed", async () => {
    const provider = providerFailingWith(new Error("unused"));
    expect(provider.isSubscription).toBe(false);
    await expect(provider.describeAuth()).resolves.toBe("ANTHROPIC_API_KEY");
  });
});

describe("Claude CLI provider", () => {
  const environment = { PATH: "/nonexistent" };

  it("reports a missing command clearly", async () => {
    const provider = createClaudeCliProvider({
      environment,
      maxRetries: 0,
      timeoutMinutes: 1,
      authMethod: "claude.ai",
      logger: silent,
    });
    await expect(provider.generate(request)).rejects.toThrow(/doctor/);
  });

  it("stops before starting when already cancelled", async () => {
    const provider = createClaudeCliProvider({
      environment,
      maxRetries: 0,
      timeoutMinutes: 1,
      authMethod: "claude.ai",
      logger: silent,
    });
    await expect(provider.generate({ ...request, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(CancelledError);
  });

  it.each([
    ["claude.ai", true],
    ["oauth_token", true],
    ["api_key_helper", false],
  ])("treats %s login as subscription: %s", async (authMethod, expected) => {
    const provider = createClaudeCliProvider({
      environment,
      maxRetries: 0,
      timeoutMinutes: 1,
      authMethod,
      logger: silent,
    });
    expect(provider.isSubscription).toBe(expected);
    await expect(provider.describeAuth()).resolves.toContain(authMethod);
    await expect(provider.estimateTokens("12345678", "sonnet")).resolves.toBe(2);
  });

  it("ignores lines that aren't JSON", () => {
    expect(parseStreamLines('garbage\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
});

describe("waiting", () => {
  it("a cancelled sleep rejects, both before and during the wait", async () => {
    await expect(sleep(10, AbortSignal.abort())).rejects.toBeInstanceOf(CancelledError);
    const controller = new AbortController();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(CancelledError);
  });

  it("the gate holds calls until the pause ends", async () => {
    const gate = new BackoffGate();
    await gate.wait();
    gate.pause(30);
    const start = Date.now();
    await gate.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
