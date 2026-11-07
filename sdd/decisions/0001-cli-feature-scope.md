# ADR 0001: CLI feature scope for the MVP

**Status:** Accepted
**Date:** 2026-11-07

## Context

We compared the `cclinic` CLI spec with Codex CLI (`@openai/codex`, using its documentation on 2026-11-07), Claude Code 2.1.319, and the [Command Line Interface Guidelines](https://clig.dev/).

Codex is an interactive coding agent that edits files and runs commands. cclinic is a one-shot tool that reads a project and writes documents. Many Codex features exist to control an agent's actions, or to manage long conversations, so they don't apply here.

## Decision

Adopt features that prevent mistakes, support scripting, or help users fix problems themselves. Leave out those that belong to interactive agents or aren't needed for a first version.

### Added to the MVP

| Feature | Precedent | Why it's needed |
|---|---|---|
| `doctor` command | `codex doctor`, `claude doctor` | Setup problems are the most likely first failure |
| `--json` result | `codex exec --json` | Scripts shouldn't parse text. Simpler than Codex's event stream, because one result is enough |
| `--color`, `NO_COLOR` | `codex exec --color`, no-color.org | Keeps logs free of color codes |
| `--quiet`, `--debug` | clig.dev | Quieter for scripts, more detail for diagnosing problems |
| Short flags, help examples, typo suggestions | Codex, clig.dev | Standard expectations |
| `model --list`, `model --reset` | `codex debug models` | Scripts can see valid values, and users can undo a choice |
| Environment variables | `CODEX_API_KEY`, clig.dev | Setting values in CI without editing commands |
| `--max-retries`, `--timeout-minutes` | Codex `request_max_retries`, `stream_idle_timeout_ms` | clig.dev says network timeouts should be configurable |
| `--max-files`, `--max-input-tokens`, `--max-file-size-mib` | Codex has token and byte limits such as `tool_output_token_limit` | Stops accidental large or expensive runs |
| Refusal to run on a home folder or root | `codex exec`'s Git repository check | Same purpose: stop a tool running somewhere unintended. A Git requirement doesn't suit cclinic, because projects may not use Git |
| `clean`, `--no-cache` | None directly | The cache needs a way to be cleared and bypassed |
| Run lock, writable-folder check | clig.dev (robustness) | Prevents corruption and wasted usage |
| Clear handling of usage limits | None directly | Long runs on a subscription will sometimes hit limits |
| No telemetry | Codex `analytics.enabled` opt-out | clig.dev says not to collect data without consent. Simplest choice is to collect nothing |

### Already covered

| Codex feature | cclinic equivalent |
|---|---|
| `--model`, `/model` with reasoning | `--model`, `--effort`, `cclinic model` |
| `exec --output-schema` | Built in through schema-validated output |
| `exec --ephemeral` | `--no-session-persistence` on Claude CLI calls |
| `resume` | Automatic: re-running continues from cached results |
| `login`, `logout` | Handled by the Claude CLI, or `ANTHROPIC_API_KEY` |
| Sandbox and approval modes | Not needed: the model has no tools |

### Deferred until after the MVP

| Feature | Reason |
|---|---|
| Shell completions (`codex completion`) | Convenient but not needed, and `commander` has no built-in support |
| Self-update (`codex update`) | `npm update -g cclinic` works, and `doctor` reports new versions |
| Project config file, named profiles (`--profile`) | `.cclinicignore` and flags cover the MVP |
| `--config key=value`, `--strict-config` | Few settings so far, each with its own flag |
| Proxy settings, custom base URLs | Needs testing first. Add when requested |
| Regenerating a single spec | Caching already avoids repeating unchanged work |
| `--no-input` | The terminal check and `--yes` cover the main cases |
| `--ignore-user-config` | Flags and environment variables override saved values |

### Not applicable

Interactive UI, slash commands and sessions (`resume`, `fork`, `archive`, `delete`, `queue`), `exec`, `review`, `apply`, `sandbox`, approvals, MCP, plugins, hooks, cloud tasks, remote control, app server, worktrees, image input, web search, and local model providers.

## Consequences

- The CLI has more to build and test, but each addition is small.
- All limit defaults are this project's own estimates, and need review after testing on real projects.
- Limits can stop a legitimate large project. The message always shows which flag to change.
- `--json` output and flags become a stable interface, so changing them later counts as a breaking change.

## Sources

- [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Command Line Interface Guidelines](https://clig.dev/)
- [NO_COLOR](https://no-color.org/)
