# LLM providers: verification

Test cases for automation testers. See [conventions](../../README.md#verification-conventions) for levels and fixtures.

**Setup:**
- **Claude CLI:** put a fake `claude` executable first on `PATH`. It records its arguments, stdin and working directory, and replays a chosen file from `recorded-cli-output`.
- **API:** use a mocked SDK client or local HTTP stub. Never use a real key in CI.
- **Manual tests** use real accounts and spend real usage. Use the smallest fixture.

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-LLM-001 | FR-LLM-001 | unit | Each combination: CLI logged in, logged out or missing, with and without a key | Select provider with `auto` | CLI if logged in, else API if there's a key, else a no-provider error |
| TC-LLM-002 | FR-LLM-001 | e2e | No `claude` and no key | Run `cclinic --yes` | Exit code is 3, and the message explains both options |
| TC-LLM-003 | FR-LLM-001 | unit | `ANTHROPIC_API_KEY` set to an empty string | Select provider with `auto` | The key is treated as missing |
| TC-LLM-004 | FR-LLM-002 | e2e | Only a key available, with `--provider claude-cli`. Then only a CLI login, with `--provider anthropic-api` | Run each | Each exits 3, and the other provider isn't used |
| TC-LLM-005 | FR-LLM-003 | integration | A CLI that fails mid-run, with a key set | Run | It stops with code 4, and the API client gets no calls |
| TC-LLM-006 | FR-LLM-004 | integration | Source code | Run `npm run check:arch` | No provider imports exist outside the allowed adapters |
| TC-LLM-007 | FR-LLM-005 | integration | The fake `claude` | Generate | Arguments match the spec exactly, and the prompt is on stdin and not in arguments |
| TC-LLM-008 | FR-LLM-005 | manual | A real Claude CLI | Send a prompt over 1 MB | The call succeeds |
| TC-LLM-009 | FR-LLM-006 | integration | A target with `CLAUDE.md`, and the fake `claude` | Generate | The working directory is an empty temp folder outside the target, and is removed afterwards |
| TC-LLM-010 | FR-LLM-007 | integration | The fake `claude` | Generate | `--bare` is absent from the arguments |
| TC-LLM-011 | FR-LLM-008 | unit | Recorded success | Parse | Data is returned |
| TC-LLM-012 | FR-LLM-008 | unit | Recorded invalid-model output (`is_error: true`, `subtype: "success"`, exit code 1) | Parse | It raises an error, and `subtype` doesn't make it pass |
| TC-LLM-013 | FR-LLM-008 | unit | Exit code 0 with `structured_output` missing, and exit code 0 with malformed JSON | Parse | Each raises an error |
| TC-LLM-014 | FR-LLM-009 | integration | Recorded auth status and success | Run | The summary shows `authMethod`, and the manifest has the model from `modelUsage` |
| TC-LLM-015 | FR-LLM-009 | manual | A real Claude CLI with `ANTHROPIC_API_KEY` set | Run, and check the account usage | Record the `authMethod` and account billed. The summary must make this clear |
| TC-LLM-016 | FR-LLM-010 | unit | Each menu value, and a mocked client | Generate | The request has the matching API ID |
| TC-LLM-017 | FR-LLM-011 | unit | Default settings, and a mocked client | Inspect the request | It streams, with `max_tokens` 64000, adaptive thinking, and effort `medium` |
| TC-LLM-018 | FR-LLM-012 | unit | A mocked client returning JSON that fails the schema | Generate | The request has `output_config.format`, and the result is rejected locally |
| TC-LLM-019 | FR-LLM-013 | unit | Two runs on different projects | Compare requests | System prompts are byte-identical with `cache_control`, and no prohibited fields are sent |
| TC-LLM-020 | FR-LLM-014 | unit | Mocked `stop_reason` of `refusal`, then `max_tokens` | Generate | They raise `RefusalError` and `TruncatedError`, and no partial content is used |
| TC-LLM-021 | FR-LLM-015 | unit | Each model, and a mocked client | Inspect requests | Fallback beta and `fallbacks` appear for Sonnet, Opus and Fable, and not for Haiku |
| TC-LLM-022 | FR-LLM-015 | unit | A response from a different model than requested | Generate | `actualModel` is the model that answered |
| TC-LLM-023 | FR-LLM-016 | unit | Simulated 429, 500, connection error and timeout, with fake timers | Generate | Each is retried at most twice with growing delays |
| TC-LLM-024 | FR-LLM-016 | unit | Simulated 401, invalid model, refusal and budget error | Generate | Each fails once, with no retry |
| TC-LLM-025 | FR-LLM-017 | integration | A fake `claude` that hangs, with fake timers | Generate | It times out after 15 minutes, and the child process is killed |
| TC-LLM-026 | FR-LLM-017 | e2e | A fake `claude` that hangs | Send SIGINT to `cclinic` | It exits 130, and no child process remains |
| TC-LLM-027 | FR-LLM-018 | unit | Invalid output once, and then always | Generate | One retry recovers, and two failures raise `SchemaError` |
| TC-LLM-028 | FR-LLM-019 | unit | Recorded CLI costs, and mocked API usage on each model | Add up | The totals are correct, and subscription spend is labelled an estimate |
| TC-LLM-029 | FR-LLM-020 | integration | A budget lower than several calls' total cost | Run | Each CLI call gets the remaining amount, no new calls start after the limit, exit code is 4, and summaries are cached |
| TC-LLM-030 | FR-LLM-021 | unit | Known text | Estimate on each provider | The API calls `count_tokens`, and the CLI gives characters divided by 4 |
| TC-LLM-031 | FR-LLM-022 | unit | Known tokens per model, including Haiku above 100K | Estimate cost | Totals match the price table with 25% assumed output, and are labelled as estimates |
| TC-LLM-032 | FR-LLM-023 | unit | Content from `injection-project` | Build prompts | Content is inside delimiters, and the system prompt calls it untrusted data |
| TC-LLM-033 | FR-LLM-023, FR-LLM-024 | manual | `injection-project`, and a real provider | Run | No actions are taken, and the injected instructions aren't followed |
| TC-LLM-034 | FR-LLM-024 | integration | Both providers | Inspect requests | CLI arguments have `--tools ""`, and API requests have no `tools` field |
| TC-LLM-035 | FR-LLM-025 | integration | A marker key and marker prompt, with failures forced | Search logs, errors, cache and output | Neither marker is found |
| TC-LLM-036 | FR-LLM-005, FR-LLM-008, FR-LLM-009 | manual | `sample-project`, and a real Claude CLI login | Run | Documents are generated, and the manifest shows `claude-sonnet-5-5` at medium |
| TC-LLM-037 | FR-LLM-010, FR-LLM-011, FR-LLM-012, FR-LLM-013, FR-LLM-014, FR-LLM-015 | manual | `sample-project`, and a real key with `--provider anthropic-api` | Run on Sonnet and Haiku | Documents are generated with both, and later requests show cache reads in usage |
| TC-LLM-038 | FR-LLM-016 | unit | `--max-retries 0`, then `--max-retries 5`, with a simulated 500 | Generate | There are 0 retries, then 5 |
| TC-LLM-039 | FR-LLM-016 | unit | A 429 with `retry-after: 30`, with fake timers | Generate | The retry waits at least 30 seconds |
| TC-LLM-040 | FR-LLM-016 | integration | Concurrency of 3, with one call receiving a 429 | Run | No new calls start during the backoff |
| TC-LLM-041 | FR-LLM-017 | integration | `--timeout-minutes 1`, with a fake `claude` that hangs and fake timers | Generate | It times out after 1 minute |
| TC-LLM-042 | FR-LLM-021 | unit | `count_tokens` unavailable on the API provider | Estimate | It uses characters divided by 4, and says so |
| TC-LLM-043 | FR-LLM-026 | integration | A provider that always returns 429 after two modules finish | Run, then run again with the limit lifted | It stops with code 4 and no further calls. The message explains the limit and how to continue, and the second run only processes remaining modules |
| TC-LLM-044 | FR-LLM-026 | manual | A real subscription with its usage limit reached | Run | Record the real output, add it to `recorded-cli-output`, and confirm the message is clear |
| TC-LLM-045 | FR-LLM-027 | unit | Fake `claude --version` values below, at and above 2.1.319, and an unreadable value | Check the version | Only the older version warns, an unreadable value warns too, and none stop the run |
| TC-LLM-046 | FR-LLM-028 | integration | `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` set, `--max-retries 5`, and the fake `claude` recording its environment | Generate | The two variables are absent, and the three `CLAUDE_CODE_*` variables have the specified values |
| TC-LLM-047 | FR-LLM-028 | manual | A real login and a fake key in the shell | Run | The summary shows `claude.ai`, and the call succeeds |
| TC-LLM-048 | FR-LLM-029 | integration | The fake `claude` emits `system/api_retry` events, including `rate_limit` | Generate | Progress shows attempt and cause, no prompt text appears, and new calls wait for the delay |
| TC-LLM-049 | FR-LLM-030 | unit | Recorded output with `api_error_status` 401 | Parse | It raises `AuthError` with the login, provider and `-p` guidance |
| TC-LLM-050 | FR-LLM-031 | unit | Recorded invalid-model output | Parse | The message names the model and suggests `cclinic model` |
| TC-LLM-051 | FR-LLM-020 | unit | Recorded `error_max_budget_usd` output | Parse | It raises `BudgetError` |
| TC-LLM-052 | FR-LLM-026 | unit | A result message saying "You've hit your Opus limit" | Parse | It raises `RateLimitError` and suggests another model |
| TC-LLM-053 | FR-LLM-032 | unit | The constants file | Read `CLAUDE_MODELS` and `CODEX_MODELS` | Each has the entries in the spec's tables, with those IDs, and the Claude default is Sonnet |
| TC-LLM-054 | FR-LLM-033 | unit | All files in `src/`, excluding tests and the constants file | Search for each model ID and CLI model value as a string literal | None are found |
| TC-LLM-055 | FR-LLM-033 | unit | A temporary change to a label in the constants, using a mocked module | Build the menu, valid options text and an unavailable-model error | All show the changed label |
| TC-LLM-056 | FR-LLM-034 | e2e | None | Run `--model gpt-6.1-sol --dry-run`, then `cclinic model --list` | The first exits 2, and the list shows no Codex models |
| TC-LLM-057 | FR-LLM-035 | unit | The provider source files | Search for `64000`, the beta name and `CLAUDE_CODE_` variable names as literals | None are found outside `constants/llm.ts` |
| TC-LLM-058 | FR-LLM-036 | unit | All files in `src/core/constants/` | Search for key-shaped text | None are found |
