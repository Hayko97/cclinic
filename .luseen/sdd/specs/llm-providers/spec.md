# llm-providers

## Goal

Reach Claude through the Claude CLI (default) or the Anthropic API with the same results and safety rules on both. This covers one-time provider selection, retries, timeouts, budget and cost estimates, prompt-injection and secret safety, usage-limit handling, and central model constants.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-LLM-001 | With --provider auto, luseen must pick the Claude CLI if it is installed and logged in, else the Anthropic API if ANTHROPIC_API_KEY is set and non-empty, else exit with code 3 and print setup instructions for both options. | confirmed | `sdd/specs/llm-providers/spec.md:11-17`, `src/adapters/llm/select-provider.ts:86-103`, `src/adapters/llm/llm.test.ts:55-67` |
| FR-LLM-002 | When a provider is chosen explicitly (claude-cli or anthropic-api), luseen must never substitute the other provider. If the explicit provider is unavailable it must exit with code 3, and a failure during a run must not switch providers. | confirmed | `sdd/specs/llm-providers/spec.md:13-16`, `src/adapters/llm/select-provider.ts:86-128`, `src/adapters/llm/llm.test.ts:55-67` |
| FR-LLM-003 | The Claude CLI provider must run `claude -p` with --output-format stream-json, --json-schema, --tools "", --no-session-persistence, --safe-mode, --max-turns 3 and a system prompt file, send the prompt on stdin, and never pass --bare. | confirmed | `sdd/specs/llm-providers/spec.md:21-33`, `src/adapters/llm/claude-cli.ts:178-208`, `src/adapters/llm/llm.test.ts:131-140` |
| FR-LLM-004 | The Claude CLI provider must run each call from a fresh empty temporary directory outside the target project and remove it afterwards. | confirmed | `sdd/specs/llm-providers/spec.md:32-33`, `sdd/specs/llm-providers/verification.md:20-21`, `src/adapters/llm/claude-cli.ts:178-274` |
| FR-LLM-005 | The environment passed to claude processes must drop ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN and set CLAUDE_CODE_MAX_RETRIES, CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. | confirmed | `sdd/specs/llm-providers/spec.md:69-73`, `sdd/decisions/0002-claude-cli-integration.md:14-19`, `src/adapters/llm/claude-cli.ts:35-46` |
| FR-LLM-006 | A Claude CLI call must count as successful only when the process exit code is 0, the last result event has is_error false, and structured_output is present and passes the schema; subtype and stop_reason must not decide success. | confirmed | `sdd/specs/llm-providers/spec.md:34`, `src/adapters/llm/claude-cli.ts:113-176`, `sdd/specs/llm-providers/verification.md:23-24` |
| FR-LLM-007 | Claude CLI failures must be classified as authentication, budget, unavailable model, rate/usage limit, truncation or refusal, with messages that say how to fix them: login or --provider anthropic-api (mentioning a possible --bare default) for auth, and the model name plus `luseen model` for an unavailable model. | confirmed | `sdd/specs/llm-providers/spec.md:75-76`, `src/adapters/llm/claude-cli.ts:113-176`, `sdd/specs/llm-providers/verification.md:60-63`, `sdd/decisions/0002-claude-cli-integration.md:27` |
| FR-LLM-008 | The Anthropic API provider must send streaming requests with max_tokens 64000, adaptive thinking, output_config.effort always set, JSON-schema structured output and a fixed cached system prompt (cache_control, no per-run values), and must not send temperature, top_p, top_k or budget_tokens. | confirmed | `sdd/specs/llm-providers/spec.md:39-42`, `src/adapters/llm/anthropic-api.ts:32-216`, `sdd/specs/llm-providers/verification.md:28-31` |
| FR-LLM-009 | For Sonnet, Opus and Fable the API provider must use the beta messages endpoint with the server-side fallback beta and fallbacks "default"; Haiku requests must not include these fields. The model that actually answered must be recorded. | confirmed | `sdd/specs/llm-providers/spec.md:44`, `src/adapters/llm/anthropic-api.ts:32-216`, `sdd/specs/llm-providers/verification.md:32-33` |
| FR-LLM-010 | The API provider must raise RefusalError when stop_reason is refusal and TruncatedError when it is max_tokens, and must not use partial content. | confirmed | `sdd/specs/llm-providers/spec.md:43`, `src/adapters/llm/anthropic-api.ts:32-216`, `sdd/specs/llm-providers/verification.md:31` |
| FR-LLM-011 | The API provider must retry only connection errors and statuses 408, 409, 429 and 5xx, up to --max-retries (default 2, 0 means none) with exponential backoff and jitter, honour retry-after, pause all parallel calls during a 429 backoff, and never retry authentication, 404/400 invalid model, refusal or budget errors. | confirmed | `sdd/specs/llm-providers/spec.md:48`, `src/adapters/llm/anthropic-api.ts:56-61`, `src/adapters/llm/anthropic-api.ts:175-197`, `src/adapters/llm/retry.ts:64-72`, `src/adapters/llm/llm.test.ts:196-232` |
| FR-LLM-012 | The Claude CLI provider must leave retries to the CLI by setting CLAUDE_CODE_MAX_RETRIES from --max-retries and must not add its own retries on top, and must show retry events with their causes as progress. | confirmed | `sdd/decisions/0002-claude-cli-integration.md:15`, `sdd/specs/llm-providers/spec.md:48`, `sdd/specs/llm-providers/spec.md:74`, `sdd/specs/llm-providers/verification.md:59` |
| FR-LLM-013 | Each provider call must time out after --timeout-minutes (default 30, range 1 to 120), and a timed-out Claude CLI call must kill its child process. | confirmed | `sdd/specs/llm-providers/spec.md:49`, `sdd/decisions/0002-claude-cli-integration.md:16`, `src/core/constants/limits.ts:9-16`, `sdd/specs/llm-providers/verification.md:36` |
| FR-LLM-014 | On Ctrl+C (SIGINT) luseen must cancel in-flight provider calls, leave no child claude process running, and exit with code 130. | confirmed | `sdd/specs/llm-providers/spec.md:48-50`, `sdd/specs/llm-providers/verification.md:37`, `src/cli/main.ts:178-257` |
| FR-LLM-015 | Output that fails schema validation must be retried once; a second failure must raise SchemaError. | confirmed | `sdd/specs/llm-providers/spec.md:50`, `src/adapters/llm/retry.ts:52-72`, `sdd/specs/llm-providers/verification.md:38` |
| FR-LLM-016 | luseen must sum the cost of each call and show it, but for subscription logins (claude.ai, oauth_token) it must label spend as an estimate and hide dollar figures, showing tokens only. | confirmed | `sdd/specs/llm-providers/spec.md:51-54`, `src/adapters/llm/claude-cli.ts:269`, `src/cli/generate-command.ts:222-223` |
| FR-LLM-017 | With --max-budget-usd, luseen must split the remaining budget across calls in flight, start no new call once estimated spend reaches the limit, keep completed cached summaries, and exit with code 4. | confirmed | `sdd/specs/llm-providers/spec.md:52`, `src/application/pipeline.ts:236-254`, `src/cli/guide.ts:166`, `sdd/specs/llm-providers/verification.md:40` |
| FR-LLM-018 | Before sending, luseen must estimate input tokens (count_tokens on the API, falling back to 1 token per 4 characters offline; 1 per 4 characters on the CLI) and cost from the model price table assuming output is 25% of input, labelled as an estimate. | confirmed | `sdd/specs/llm-providers/spec.md:53-54`, `sdd/specs/llm-providers/spec.md:150-159`, `src/core/constants/models.ts:95` |
| FR-LLM-019 | Project content must be wrapped in <project_content> delimiters (closing tags inside content escaped), the system prompt must declare it untrusted data, and no tools may be given to the model on either provider. | confirmed | `sdd/specs/llm-providers/spec.md:58-59`, `src/core/prompts.ts:9-29`, `src/core/core.test.ts:362-371`, `src/adapters/llm/claude-cli.ts:178-208` |
| FR-LLM-020 | API keys and prompt contents must not appear in logs, errors, cache or generated files, and no key-shaped text may appear in constants files. | confirmed | `sdd/specs/llm-providers/spec.md:60`, `sdd/specs/llm-providers/spec.md:84`, `sdd/specs/llm-providers/verification.md:46`, `src/core/constants/constants.test.ts:62-96` |
| FR-LLM-021 | On a persistent usage or rate limit, luseen must stop starting calls, keep completed summaries, exit with code 4, tell the user the limit, the reset time if known, and that re-running resumes; if a model-specific limit is named it must suggest another model. | confirmed | `sdd/specs/llm-providers/spec.md:64`, `sdd/specs/llm-providers/verification.md:54`, `sdd/specs/llm-providers/verification.md:63` |
| FR-LLM-022 | If the Claude CLI version is older than 2.1.319 or cannot be read, luseen must warn but still run. | confirmed | `sdd/specs/llm-providers/spec.md:65`, `src/core/constants/llm.ts:9-11`, `sdd/specs/llm-providers/verification.md:56` |
| FR-LLM-023 | All model IDs, CLI values, labels, efforts, defaults and prices must be defined in src/core/constants/models.ts, and other provider constants (64000, beta name, CLAUDE_CODE_ names, timeouts) in src/core/constants/llm.ts, with no such literals elsewhere in source; the Claude default is Sonnet at medium effort. | confirmed | `sdd/specs/llm-providers/spec.md:80-84`, `src/core/constants/constants.test.ts:62-96`, `src/core/constants/models.ts:6-42` |
| FR-LLM-024 | Codex model entries may be defined but must not appear in menus, `luseen model --list` or be accepted as values (for example --model gpt-6.1-sol exits with code 2). | confirmed | `sdd/specs/llm-providers/spec.md:81-82`, `sdd/specs/llm-providers/verification.md:67` |
| FR-LLM-025 | The run summary must show which login or auth method (for example claude.ai) is in use, obtained from `claude auth status --json`. | confirmed | `sdd/specs/llm-providers/spec.md:12`, `sdd/specs/llm-providers/validation.md:10`, `sdd/specs/llm-providers/verification.md:25` |

## Edge cases

- ANTHROPIC_API_KEY set but empty counts as missing in auto mode.
- Both a Claude CLI login and an API key exist: auto uses the CLI login and the key is not billed (key removed from the child environment).
- Result event has is_error true while subtype is "success": the call must fail.
- Result event lacks structured_output or output is malformed JSON: the call fails.
- --max-retries 0 means zero retries on both providers.
- A 429 during parallel calls pauses all new calls, not just the failing one.
- count_tokens unavailable offline: estimate falls back to characters/4 with a notice.
- Claude version unreadable or older than 2.1.319: warning only.
- Fable may be unavailable to zero-data-retention organisations: the API 400 error is shown with a suggestion to pick another model.
- Very large prompts must go through stdin, not arguments.
- Budget exhausted mid-run: completed summaries stay cached so a re-run resumes.

## Non-goals

- Waiting for usage limits to reset (deferred after the MVP).
- --fallback-model and --add-dir for the Claude CLI (deferred).
- Selectable Codex models.
- Switching providers mid-run.
- Model/effort selection menus and precedence (covered by model-selection).
- Exit-code handling and flag parsing in general (covered by cli-commands).
