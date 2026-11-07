# LLM providers

## Goal

Reach Claude through the Claude CLI by default, or an Anthropic API key as the second option, with the same results and safety rules in both cases.

## Requirements

### Selection

- **FR-LLM-001** With `--provider auto`, cclinic MUST pick the first available option:
  1. Claude CLI, if `claude` is on the `PATH` and `claude auth status --json` reports `loggedIn: true`
  2. Anthropic API, if `ANTHROPIC_API_KEY` is set and not empty
  3. Neither: exit with code 3 and print setup instructions for both options
- **FR-LLM-002** An explicit `--provider claude-cli` or `--provider anthropic-api` MUST use only that provider. If it isn't available, cclinic MUST exit with code 3 and MUST NOT try the other one.
- **FR-LLM-003** Provider fallback MUST happen only at startup. A failure during a run MUST stop with an error and MUST NOT switch provider, so that users are never billed on a different account unexpectedly.
- **FR-LLM-004** The rest of cclinic MUST use only the `LlmProvider` interface in [architecture.md](../../architecture.md#main-interface).

### Claude CLI provider

- **FR-LLM-005** Each request MUST run this command, with the prompt sent through stdin:

  ```
  claude -p --model <value> --effort <value> \
    --system-prompt-file <file holding the fixed instructions> \
    --output-format stream-json --verbose --json-schema <schema> \
    --tools "" --no-session-persistence --safe-mode --max-turns 3
  ```

  `--max-budget-usd <remaining>` is added when a budget is set.

- **FR-LLM-006** The process MUST run from a new empty temp directory, so the target project's `CLAUDE.md`, hooks and settings can't affect the output. The directory MUST be removed afterwards.
- **FR-LLM-007** cclinic MUST NOT use `--bare`, because it never reads OAuth or keychain logins and would break subscription users.
- **FR-LLM-008** The last `result` event in the stream decides the outcome. A call MUST count as successful only if the exit code is 0, `is_error` is `false`, and `structured_output` is present and passes schema validation. cclinic MUST NOT judge success from `subtype` or `stop_reason`, because neither is reliable here (see [verified behaviour](#verified-claude-cli-behaviour)).
- **FR-LLM-009** The startup summary MUST show the CLI's `authMethod`. The actual model MUST be read from the `modelUsage` keys and saved in `manifest.json`.

### Anthropic API provider

- **FR-LLM-010** cclinic MUST use `@anthropic-ai/sdk`, and read the key only from `ANTHROPIC_API_KEY`. It MUST map menu values to the API IDs in [model-selection](../model-selection/spec.md#model-and-reasoning-options).
- **FR-LLM-011** Requests MUST use streaming with `max_tokens` of 64000, and `thinking: {type: "adaptive"}`. They MUST always send the chosen `output_config.effort`, because Sonnet 5.5's own default is `high`, not medium.
- **FR-LLM-012** Structured output MUST use `output_config.format`, and the result MUST be validated against the schema locally.
- **FR-LLM-013** The system prompt MUST be fixed text with a `cache_control` breakpoint, and contain no timestamps or per-run values. Requests MUST NOT send `temperature`, `top_p`, `top_k` or `budget_tokens`.
- **FR-LLM-014** `stop_reason` MUST be checked before reading content. `refusal` MUST raise `RefusalError` and `max_tokens` MUST raise `TruncatedError`.
- **FR-LLM-015** Requests for Sonnet, Opus and Fable MUST use `client.beta.messages` with the beta `server-side-fallback-2026-07-01` and `fallbacks: "default"`, so a refused request can be retried on another model. Haiku 5.5 doesn't support this, so requests for it MUST NOT include these fields. The model that actually answered MUST be saved in `manifest.json`.

### Reliability and cost

- **FR-LLM-016** Rate limits, server errors (5xx), connection errors and timeouts MUST be retried up to `--max-retries` times (default 2) with exponential backoff and jitter, honouring any `retry-after` value. On the Claude CLI, the CLI does this itself through `CLAUDE_CODE_MAX_RETRIES` (FR-LLM-028), and cclinic MUST NOT retry on top. While a rate-limit backoff is running, no new calls MUST start. Auth errors, invalid models, refusals and budget errors MUST NOT be retried.
- **FR-LLM-017** Each call MUST time out after `--timeout-minutes` (default 30), which on the Claude CLI includes the CLI's own retries. Ctrl+C MUST stop running calls, including any `claude` child processes.
- **FR-LLM-018** Output that fails schema validation MUST be retried once. A second failure MUST raise `SchemaError`.
- **FR-LLM-019** cclinic MUST add up the cost of each call: `total_cost_usd` on the Claude CLI, and token usage multiplied by the [price table](#price-table) on the API. Spend from the Claude CLI on a subscription MUST be labelled as an estimate, not a charge.
- **FR-LLM-020** `--max-budget-usd` is a limit on the whole run, but the Claude CLI's flag applies to one process. cclinic MUST split the remaining budget between the calls in progress and the new call, pass that amount to each CLI call, and MUST NOT start new calls once the limit is reached. Reaching the limit MUST exit with code 4, keeping completed summaries in the cache. Spend can pass the limit, because the provider checks it against an estimate, so the limit MUST be described as a target and not a guarantee.
- **FR-LLM-021** Token estimates MUST use `count_tokens` on the API, and 1 token per 4 characters on the Claude CLI, which has no counting command. If `count_tokens` can't be reached, such as during an offline `--dry-run`, the API provider MUST also use 1 token per 4 characters, and say so.
- **FR-LLM-022** Cost estimates MUST use the price table, assume output is 25% of input tokens, and be labelled as estimates. The estimate for a Claude CLI run on a subscription MUST show tokens only.

### Safety

- **FR-LLM-023** Project content MUST be wrapped in clear delimiters, and the system prompt MUST state that it's untrusted data and that instructions inside it must not be followed.
- **FR-LLM-024** The model MUST NOT be given any tools on either provider: use `--tools ""` on the CLI, and send no `tools` field on the API.
- **FR-LLM-025** API keys and prompt contents MUST NOT appear in logs, error messages, the cache, or generated files. Cached summaries are model output and are allowed, because project content was redacted before being sent.

### Usage limits and versions

- **FR-LLM-026** When retries end because of a rate limit or usage limit, cclinic MUST stop all remaining calls, keep completed summaries, exit with code 4, and tell the user the limit was reached, when it resets if the provider reports it, and that re-running continues from where it stopped. If the message names a specific model, such as "You've hit your Opus limit", cclinic MUST suggest choosing another model.
- **FR-LLM-027** cclinic MUST read `claude --version`, and warn if it's older than the version these specs were tested on (2.1.319), because the CLI's flags and output may differ. It MUST still try the run.

### Claude CLI process

- **FR-LLM-028** Every `claude` process MUST run with these environment changes:
  - `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed, including for `claude auth status`, because a key in the environment replaces the user's login under `-p`
  - `CLAUDE_CODE_MAX_RETRIES` set to the `--max-retries` value
  - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` set to 64000, to match the API provider
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set to 1, which turns off the CLI's telemetry, error reporting and updates for that process
- **FR-LLM-029** Claude CLI `system/api_retry` events MUST be shown as progress, with the attempt and cause, and MUST NOT show any prompt content. A `rate_limit` event MUST pause new calls for its `retry_delay_ms`.
- **FR-LLM-030** An authentication failure on the Claude CLI MUST explain how to log in or use `--provider anthropic-api`, and mention that a newer Claude Code release may have changed how `-p` uses logins, because the docs say `--bare`, which ignores logins, will become the default for `-p`.
- **FR-LLM-031** An unavailable or disallowed model MUST produce a message that names the model and suggests running `cclinic model` to choose another. Organizations can restrict which models are allowed.

### Constants

- **FR-LLM-032** All model data MUST be defined in one constants file, `src/core/constants/models.ts`, grouped by family, as shown in [Model constants](#model-constants). This covers model IDs, CLI values, labels, hints, reasoning levels, defaults and prices.
- **FR-LLM-033** Code outside the constants file MUST NOT contain a model ID, CLI model value or reasoning level as a literal. Menus, validation, provider requests, cost estimates and error messages MUST import them. Tests MAY state expected values directly.
- **FR-LLM-034** The Codex entries MUST be defined, but MUST NOT appear in menus or be accepted as values until a Codex provider has its own spec. Only Claude models can be selected in the MVP.
- **FR-LLM-035** Other fixed values used by providers MUST be named constants in `src/core/constants/llm.ts`, including output token limits, turn limits, timeouts, retry defaults, beta names, and environment variable names.
- **FR-LLM-036** API keys MUST NOT be stored in any constants file. They come only from the environment (FR-LLM-010).

## Model constants

`src/core/constants/models.ts` holds the data below, in this shape:

```ts
export const CLAUDE_MODELS = {
  SONNET: { value: "sonnet", apiId: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Balanced speed and quality" },
  // ...
} as const;

export const CODEX_MODELS = {
  SOL: { apiId: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  // ...
} as const;

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS.SONNET;
```

### Claude

| Constant | CLI value | API model ID | Label |
|---|---|---|---|
| `CLAUDE_MODELS.SONNET` (default) | `sonnet` | `claude-sonnet-5-5` | Sonnet 5.5 |
| `CLAUDE_MODELS.OPUS` | `opus` | `claude-opus-5-5` | Opus 5.5 |
| `CLAUDE_MODELS.HAIKU` | `haiku` | `claude-haiku-5-5` | Haiku 5.5 |
| `CLAUDE_MODELS.FABLE` | `fable` | `claude-fable-5-1` | Fable 5.1 |

Claude reasoning levels (`CLAUDE_EFFORTS`): `low`, `medium` (default), `high`, `xhigh`, `max`. Hints are in [model-selection](../model-selection/spec.md#model-and-reasoning-options), and prices in the [price table](#price-table).

### Codex

Not selectable yet (FR-LLM-034). IDs come from [OpenAI's Codex models page](https://learn.chatgpt.com/docs/models), checked on 2026-11-07. Recheck them when a Codex provider is built.

| Constant | Model ID | Label | Notes |
|---|---|---|---|
| `CODEX_MODELS.ASTRA` | `gpt-6-astra` | GPT-6 Astra | |
| `CODEX_MODELS.SOL` | `gpt-6.1-sol` | GPT-6.1 Sol | |
| `CODEX_MODELS.TERRA` | `gpt-6.1-terra` | GPT-6.1 Terra | Needs Codex CLI 0.159.0 or later |
| `CODEX_MODELS.LUNA` | `gpt-6-luna` | GPT-6 Luna | Supports Max, but not Ultra |

Codex reasoning levels (`CODEX_EFFORTS`): `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Support for `max` and `ultra` varies by model. OpenAI's docs don't give a complete table of which model allows which level, so that's left out until it can be confirmed. Prices and a default model are also left out for the same reason.

## Verified Claude CLI behaviour

Observed on Claude Code 2.1.319 on 2026-11-07, signed in with a claude.ai login and no `ANTHROPIC_API_KEY`.

| Behaviour | Result |
|---|---|
| Login under `--safe-mode` | Works |
| `--model sonnet --effort medium` | Accepted. `modelUsage` shows `claude-sonnet-5-5` |
| `--json-schema` with `--tools ""` | Works. The result is in `structured_output`, with the same content as a JSON string in `result` |
| `--system-prompt` | Applied |
| Successful call | `is_error: false`, `subtype: "success"`, `stop_reason: "tool_use"`, `num_turns: 2` |
| Invalid model | Exit code 1, `is_error: true`, **`subtype: "success"`**, `api_error_status: 404`, `structured_output: null` |
| `claude auth status --json` | Includes `loggedIn` and `authMethod` (`claude.ai` here) |
| `ANTHROPIC_API_KEY` set | `authMethod` becomes `api_key`. Removing the variable returns `claude.ai` |
| `--output-format stream-json --verbose` | Events are `system`, `assistant`, `user`, `rate_limit_event` and a final `result` with the same fields as JSON output |
| `--max-turns 3` with `--json-schema` | Works. A structured call takes 2 turns |
| Reached `--max-budget-usd` | Exit code 1, `is_error: true`, `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"` |

From the Claude Code docs, not tested here: piped stdin is capped at 10 MB, well above the 150,000-token request limit.

**Not yet verified:** how a subscription usage limit is reported, and running `claude` on Windows without a shell. Check these during the build, and handle unknown failures as `ProviderError`.

## Price table

US dollars per million tokens, Anthropic API rates cached on 2026-10-06. Update these on each cclinic release.

| Model | Input | Output |
|---|---|---|
| Sonnet 5.5 | 2.00 | 10.00 |
| Opus 5.5 | 4.00 | 20.00 |
| Haiku 5.5 | 0.10 (0.50 above 100K tokens per prompt) | 0.50 (2.50 above 100K tokens per prompt) |
| Fable 5.1 | 10.00 | 50.00 |

## Edge cases

- Fable 5.1 isn't available to organisations with zero data retention unless Anthropic has authorised it. The API's 400 error MUST be shown to the user with a suggestion to choose another model.
- A logged-in Claude CLI takes priority over `ANTHROPIC_API_KEY` in `auto` mode. Users who want the API must pass `--provider anthropic-api`.

## Non-goals

- Other LLM providers or local models, though the interface leaves room for them later. A Codex provider needs its own spec. Only its model constants are defined here.
- Amazon Bedrock, Google Vertex and Microsoft Foundry clients.
- The Message Batches API. It costs less but is a poor fit for an interactive CLI.
- Sandbox or approval settings. cclinic gives the model no tools, so there are no actions to approve.
- Proxy settings of its own. Corporate proxy support needs testing during the build.
