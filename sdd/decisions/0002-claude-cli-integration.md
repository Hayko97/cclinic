# ADR 0002: How cclinic runs the Claude CLI

**Status:** Accepted
**Date:** 2026-11-07

## Context

We compared the provider spec with the Claude Code documentation and tested the choices against Claude Code 2.1.319. Several default behaviours conflicted with what cclinic promises.

## Decision

| Decision | Reason |
|---|---|
| Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from `claude` processes | Under `-p`, a key in the environment replaces the login. Tested: `authMethod` changes to `api_key`. Users with a key and a login would otherwise be billed on the API |
| Set `CLAUDE_CODE_MAX_RETRIES` and don't retry on top | The CLI retries up to 10 times by default. Retrying on top allows up to 33 attempts, and `--max-retries 0` wouldn't mean zero |
| Raise the timeout default from 15 to 30 minutes | The timeout includes the CLI's retries, so 15 minutes could stop a valid call. This value is an estimate |
| Set `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to 64000 | Matches the API provider |
| Use `stream-json` rather than `json` | The JSON format shows nothing during retries. The stream reports each retry and its cause |
| Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | The "no telemetry" requirement can't be met otherwise, because the CLI has its own traffic |
| Use `--safe-mode`, not `--bare` | `--bare` ignores logins. `--safe-mode` keeps them and disables customizations |
| Use `--system-prompt-file` | Long instructions don't need to be passed on the command line |

Using `--fallback-model`, `--add-dir` and waiting for usage limits to reset are deferred until after the MVP.

## Consequences

- **`--bare` is due to become the default for `-p`.** That could break the default provider for subscription users. The docs don't show a way to opt out, so cclinic explains the likely cause in its login error, and this needs retesting on new Claude Code versions.
- cclinic depends on the CLI's stream event format. Parsing stays inside `claude-cli.ts`, and tests use recorded output.

## Sources

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [Manage costs](https://code.claude.com/docs/en/costs)
