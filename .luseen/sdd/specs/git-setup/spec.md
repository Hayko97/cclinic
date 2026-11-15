# git-setup

## Goal

Detect Git state (installed, repository, remote) read-only, create a local repository with git init only after user confirmation, alert non-fatally when no remote exists, and use the last 14 days of sanitised commit history as context for combine and spec generation, without ever committing, staging, adding remotes or pushing.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-GIT-001 | luseen must detect whether Git is installed, whether the target is inside a repository (including a parent-folder repository) and whether the repository has a remote, without changing anything and without needing Claude or the network. | confirmed | `sdd/specs/git-setup/spec.md:21`, `src/adapters/git/git-repository.ts:85-173`, `sdd/specs/git-setup/verification.md:9` |
| FR-GIT-002 | luseen must report the detected Git status (Git, repository, remote) and the planned Git action in the pre-run summary and in --dry-run output without creating a .git folder. | confirmed | `sdd/specs/git-setup/spec.md:22`, `sdd/specs/git-setup/verification.md:10-11`, `sdd/decisions/0004-git-setup.md:28` |
| FR-GIT-003 | luseen doctor must report Git installed, repository present and remote present, and a missing repository or remote must not make doctor report luseen as not ready. | confirmed | `sdd/specs/git-setup/spec.md:23`, `sdd/specs/git-setup/verification.md:12`, `src/cli/other-commands.ts:142-250` |
| FR-GIT-004 | When no repository exists, luseen must run git init in the target only after the user confirms (or --yes is given) and before the first Claude call, using init.defaultBranch and falling back to main. | confirmed | `sdd/specs/git-setup/spec.md:27-30`, `sdd/specs/git-setup/verification.md:13-14`, `sdd/decisions/0004-git-setup.md:16`, `src/adapters/git/git-repository.ts:92-96` |
| FR-GIT-005 | luseen must not run git init when the user declines confirmation or when the scan finds nothing to analyse. | confirmed | `sdd/specs/git-setup/spec.md:27-28`, `sdd/specs/git-setup/verification.md:15-16`, `sdd/decisions/0004-git-setup.md:16` |
| FR-GIT-006 | luseen must not create a nested repository when the target is inside an existing repository, and a submodule or subfolder repository must not count as the parent. | confirmed | `sdd/specs/git-setup/spec.md:85-86`, `sdd/specs/git-setup/verification.md:17` |
| FR-GIT-007 | luseen must never stage files, make commits, change Git config, create a .gitignore, add or create a remote, or push. | confirmed | `sdd/specs/git-setup/spec.md:29-30`, `sdd/specs/git-setup/spec.md:36`, `sdd/decisions/0004-git-setup.md:14-15`, `sdd/specs/git-setup/verification.md:18-19` |
| FR-GIT-008 | When a repository has no remote, luseen must include in the run result a non-failing alert with GitHub, GitLab and Bitbucket instructions to create a remote, add it and push, and the exit code must be unchanged. | confirmed | `sdd/specs/git-setup/spec.md:35-36`, `sdd/specs/git-setup/spec.md:64-79`, `sdd/specs/git-setup/verification.md:20-21` |
| FR-GIT-009 | luseen must not show the remote alert when a remote exists or when --no-git is used, and --quiet must hide the alert while --json must still include it. | confirmed | `sdd/specs/git-setup/verification.md:22`, `sdd/specs/git-setup/spec.md:56`, `sdd/specs/git-setup/spec.md:87` |
| FR-GIT-010 | luseen must show only the remote name and host, never URL credentials, and must not send remote URLs to Claude. | confirmed | `sdd/specs/git-setup/spec.md:37`, `sdd/specs/git-setup/verification.md:24`, `sdd/specs/git-setup/validation.md:11` |
| FR-GIT-011 | The --no-git option must disable repository creation, history reading and the remote alert for the run. | confirmed | `sdd/specs/git-setup/spec.md:31`, `sdd/decisions/0004-git-setup.md:28`, `sdd/specs/git-setup/validation.md:9` |
| FR-GIT-012 | luseen must read commits from the last 14 days on the current branch that touch the target folder, excluding merges, with short hash, date, message and changed file paths only. | confirmed | `sdd/specs/git-setup/spec.md:41-45`, `sdd/specs/git-setup/verification.md:25-26`, `src/core/constants/git.ts:11-14`, `src/core/git-history.ts:61-156` |
| FR-GIT-013 | luseen must not read or send diffs, author names or author emails from Git history. | confirmed | `sdd/specs/git-setup/spec.md:41`, `sdd/decisions/0004-git-setup.md:17-18`, `sdd/specs/git-setup/verification.md:27` |
| FR-GIT-014 | luseen must exclude commits touching only .luseen, .agents, .claude or AGENTS.md, remove secret, dependency and skipped paths from changed paths using file-discovery rules, and redact secrets in messages. | confirmed | `sdd/specs/git-setup/spec.md:42-44`, `sdd/decisions/0004-git-setup.md:19`, `sdd/decisions/0004-git-setup.md:22`, `sdd/specs/git-setup/verification.md:28-29` |
| FR-GIT-015 | luseen must limit history to the newest 300 commits and 100,000 characters, warn how many were omitted, and count the history size toward the token estimate and --max-input-tokens. | confirmed | `sdd/specs/git-setup/spec.md:45`, `sdd/specs/git-setup/verification.md:31-33`, `src/core/constants/git.ts:11-14` |
| FR-GIT-016 | luseen must provide the history to the combine step and each spec generation call, but not to module summary calls, as delimited untrusted context. | confirmed | `sdd/specs/git-setup/spec.md:49-50`, `sdd/specs/git-setup/verification.md:34-35`, `src/core/prompts.ts:46-57` |
| FR-GIT-017 | Generated requirements must not rest on a commit message alone or cite commit hashes as evidence, and conflicts between history and code or documents must be recorded as open questions. | confirmed | `sdd/specs/git-setup/spec.md:50`, `sdd/decisions/0004-git-setup.md:20`, `src/core/git-history.test.ts:138-142`, `sdd/specs/git-setup/verification.md:36-38` |
| FR-GIT-018 | Combine and spec cache keys must use the newest commit hash of the whole history rather than the 14-day window, keys with no history must match a no-repo run, and module summaries must not depend on history. | confirmed | `sdd/specs/git-setup/spec.md:54-55`, `sdd/decisions/0004-git-setup.md:21`, `sdd/decisions/0004-git-setup.md:27`, `sdd/specs/git-setup/verification.md:39-43` |
| FR-GIT-019 | Commit counts and dates must not appear in generated Markdown, only in the run result and --json output, so output is byte-identical when the newest commit is unchanged. | confirmed | `sdd/specs/git-setup/spec.md:56`, `sdd/decisions/0004-git-setup.md:23`, `sdd/specs/git-setup/verification.md:44-45` |
| FR-GIT-020 | Git failures (missing Git, corrupt or shallow repository, unsafe ownership, timeout) must produce a warning and let the run continue without history, and a shallow clone must warn that history may be incomplete. | confirmed | `sdd/specs/git-setup/spec.md:60`, `sdd/specs/git-setup/spec.md:11`, `sdd/decisions/0004-git-setup.md:30`, `sdd/specs/git-setup/verification.md:46-48`, `src/cli/generate-command.ts:259-284` |
| FR-GIT-021 | luseen must never bypass Git's dubious-ownership protection. | confirmed | `src/adapters/git/git-repository.ts:117-126`, `sdd/specs/git-setup/verification.md:48` |
| FR-GIT-022 | luseen must invoke Git with an argument array and no shell, a timeout, a cleaned environment and hardening options (--no-ext-diff, --no-textconv, core.fsmonitor=false) so repository config cannot run programs, and must pass paths literally. | confirmed | `sdd/specs/git-setup/spec.md:61`, `src/core/constants/git.ts:23-41`, `sdd/specs/git-setup/verification.md:49-50`, `sdd/specs/git-setup/validation.md:15` |
| FR-GIT-023 | The 14-day window, history limits, excluded paths and provider links must be defined only as named constants in src/core/constants/git.ts. | confirmed | `sdd/specs/git-setup/spec.md:62`, `sdd/specs/git-setup/verification.md:51`, `src/core/git-history.test.ts:146-161` |
| FR-GIT-024 | luseen must recommend adding a .gitignore when one is missing in a newly created repository without creating it. | confirmed | `sdd/specs/git-setup/spec.md:29-30`, `sdd/specs/git-setup/verification.md:19` |

## Edge cases

- Git is not installed (PATH without git): warn and continue without history.
- Target is a subfolder of a parent repository: no new .git, only commits touching the subfolder used, remote check applies to whole repo.
- Repository with no commits: no history; remote alert still shown if no remote.
- Detached HEAD: history comes from the checked-out commit.
- Shallow clone (e.g. CI): warning that history may be incomplete.
- Corrupt repository or unsafe (dubious) ownership: warning, exit 0, safety not bypassed.
- Commit at 13 days is included; commit at 15 days is excluded.
- More than 300 commits or over 100,000 characters: newest kept, omitted count warned.
- Commit touching only .luseen/.agents/.claude/AGENTS.md is ignored.
- Commit message with a secret or a closing delimiter tag: redacted/escaped.
- Remote URL contains a token: only name and host shown.
- Hostile repo config (core.fsmonitor, diff.external) must not execute.
- Git command times out: warning, run continues.
- Declined confirmation or nothing to analyse: no repository created.
- Non-interactive without --yes: usage error, no repository created.

## Non-goals

- Creating commits, branches or remotes
- Pushing to a remote
- Provider login
- Sending full diffs
- History beyond 14 days or a flag to change the window
- Citing commits as evidence
- Non-Git version control systems
