/** Chooses a provider at startup only. A failure later never switches provider (FR-LLM-003). */
import { execFile } from "node:child_process";
import {
  CLAUDE_COMMAND,
  CLAUDE_PROBE_MAX_OUTPUT_BYTES,
  CLAUDE_PROBE_TIMEOUT_MS,
  ENV_VARS,
  PROVIDER_CHOICES,
} from "../../core/constants/llm.js";
import { NoProviderError } from "../../core/errors.js";
import { isClaudeVersionUntested, TESTED_CLAUDE_VERSION_TEXT } from "../../core/node-version.js";
import type { Logger, LlmProvider } from "../../core/ports.js";
import { createAnthropicApiProvider } from "./anthropic-api.js";
import { claudeEnvironment, createClaudeCliProvider } from "./claude-cli.js";

export type ProviderChoice = (typeof PROVIDER_CHOICES)[number];

export const SETUP_INSTRUCTIONS = `To set up a provider, do one of these:
  - Install Claude Code and log in: claude auth login
  - Set an Anthropic API key: export ANTHROPIC_API_KEY=<your key>
Run "luseen doctor" to check your setup.`;

function runClaude(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; found: boolean }> {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_COMMAND,
      args,
      { env: environment, timeout: CLAUDE_PROBE_TIMEOUT_MS, maxBuffer: CLAUDE_PROBE_MAX_OUTPUT_BYTES },
      (error, stdout) => {
        // A missing command has a string code. A non-zero exit, such as "not logged in", has a numeric one.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({ stdout, found: typeof code !== "string" });
      },
    );
  });
}

export interface ClaudeStatus {
  readonly isInstalled: boolean;
  readonly isLoggedIn: boolean;
  readonly authMethod: string;
  readonly version: string;
}

/** Runs without any API key, because a key in the environment replaces the login (FR-LLM-028). */
export async function probeClaude(environment: NodeJS.ProcessEnv): Promise<ClaudeStatus> {
  const clean = claudeEnvironment(environment, 0);
  const { stdout: versionOutput, found } = await runClaude(["--version"], clean);
  if (!found) return { isInstalled: false, isLoggedIn: false, authMethod: "none", version: "" };
  const { stdout } = await runClaude(["auth", "status", "--json"], clean);
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return {
      isInstalled: true,
      isLoggedIn: status.loggedIn === true,
      authMethod: typeof status.authMethod === "string" ? status.authMethod : "unknown",
      version: versionOutput.trim(),
    };
  } catch {
    return { isInstalled: true, isLoggedIn: false, authMethod: "unknown", version: versionOutput.trim() };
  }
}

export interface SelectOptions {
  readonly choice: ProviderChoice;
  readonly environment: NodeJS.ProcessEnv;
  readonly maxRetries: number;
  readonly timeoutMinutes: number;
  readonly logger: Logger;
}

export function hasApiKey(environment: NodeJS.ProcessEnv): boolean {
  const key = environment[ENV_VARS.ANTHROPIC_API_KEY];
  return key !== undefined && key !== "";
}

export type ResolvedProvider =
  | { readonly kind: "claude-cli"; readonly status: ClaudeStatus }
  | { readonly kind: "anthropic-api" }
  | { readonly kind: "none"; readonly reason: string };

/** Pure decision, kept separate from the probing so it's simple to test (FR-LLM-001, FR-LLM-002). */
export function decideProvider(choice: ProviderChoice, status: ClaudeStatus, hasKey: boolean): ResolvedProvider {
  const cliUsable = status.isInstalled && status.isLoggedIn;
  if (choice === "claude-cli") {
    if (cliUsable) return { kind: "claude-cli", status };
    return {
      kind: "none",
      reason: status.isInstalled
        ? `The Claude CLI isn't logged in. Run "claude auth login".`
        : "The Claude CLI isn't installed.",
    };
  }
  if (choice === "anthropic-api") {
    return hasKey ? { kind: "anthropic-api" } : { kind: "none", reason: "ANTHROPIC_API_KEY isn't set." };
  }
  if (cliUsable) return { kind: "claude-cli", status };
  if (hasKey) return { kind: "anthropic-api" };
  return { kind: "none", reason: `No Claude provider is available.\n${SETUP_INSTRUCTIONS}` };
}

export async function selectProvider(options: SelectOptions): Promise<LlmProvider> {
  const { environment, logger, maxRetries, timeoutMinutes } = options;
  const status =
    options.choice === "anthropic-api"
      ? { isInstalled: false, isLoggedIn: false, authMethod: "none", version: "" }
      : await probeClaude(environment);
  const resolved = decideProvider(options.choice, status, hasApiKey(environment));

  if (resolved.kind === "none") throw new NoProviderError(resolved.reason);
  if (resolved.kind === "anthropic-api") {
    return createAnthropicApiProvider({
      apiKey: environment[ENV_VARS.ANTHROPIC_API_KEY] ?? "",
      maxRetries,
      timeoutMinutes,
      logger,
    });
  }
  if (isClaudeVersionUntested(status.version)) {
    logger.warn(
      `Your Claude CLI (${status.version || "unknown version"}) is older than the tested version ${TESTED_CLAUDE_VERSION_TEXT}, so this run may fail.`,
    );
  }
  return createClaudeCliProvider({ environment, maxRetries, timeoutMinutes, authMethod: status.authMethod, logger });
}
