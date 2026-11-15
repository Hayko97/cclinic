# local-environment

## Goal

Let a person try every change for real, not just read test results. A `local-env` skill sets up a local environment suited to the project. During `luseen` setup, Claude follows that skill if the user agrees. After each implementation, the coding agent shows how to review the change, such as a link or a simulator build.

## Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-ENV-001 | The system must provide a `local-env` skill, installed in `.agents/skills` and `.claude/skills` like the others, protected from overwriting like the others, and listed in the `AGENTS.md` skills table. | confirmed | `src/core/agent-skills.ts:295`, `src/core/constants/environment.ts:5`, `user request` |
| FR-ENV-002 | The skill must work with any coding agent, and must prohibit committing and pushing. | confirmed | `src/core/agent-skills.ts:293`, `user request` |
| FR-ENV-003 | After a run installs the skills in an interactive terminal with no valid environment file, luseen must say that Claude will edit files and run commands that can build and run the project's code, then ask whether to continue, defaulting to yes. | confirmed | `src/cli/environment-step.ts:138`, `user request` |
| FR-ENV-004 | With `--yes`, `--json`, `--quiet` or no interactive terminal, a run must not start Claude for the environment unless `--environment` is set. | confirmed | `src/cli/environment-step.ts:136`, `user request` |
| FR-ENV-005 | `--no-environment`, `--no-skills` and `--dry-run` must skip this step without asking, and combining `--environment` with `--no-environment` or `--no-skills` must exit with code 2. | confirmed | `src/cli/main.ts:130`, `user request` |
| FR-ENV-006 | `luseen environment [path]` must install the skills and run this step, whether or not documents exist, and must accept `--yes`, `--force`, `--json`, `--model`, `--effort`, `--max-budget-usd`, `--out` and `--allow-broad-target`. | confirmed | `src/cli/main.ts:175`, `user request` |
| FR-ENV-007 | If the Claude CLI isn't installed and logged in, or the provider is the API, luseen must start nothing, print one sentence the user can give any coding agent, and exit with code 0. | confirmed | `src/core/environment.ts:57`, `user request` |
| FR-ENV-008 | Claude must run in the target folder with the selected model and reasoning level, with `ANTHROPIC_API_KEY` removed, in `--safe-mode`, using the built-in skill text, with allowed tools from a constant list that excludes `git`, `sudo` and unrestricted shell access. Writes through its file tools must be limited to `.luseen/environment/`. | confirmed | `src/core/constants/environment.ts:53`, `user request` |
| FR-ENV-009 | The step must stop at 15 minutes, and at `--max-budget-usd` or else 2 USD, both defaults being constants, and Ctrl+C must stop Claude. | confirmed | `src/core/constants/environment.ts:12`, `user request` |
| FR-ENV-010 | After the step, luseen must validate the environment file and show each part's review details. `luseen environment` must exit 4 if Claude fails or a limit is reached, and 5 if the file is missing or invalid. In a generation run both must be warnings that don't change the exit code. | confirmed | `src/cli/environment-step.ts:146`, `user request` |
| FR-ENV-011 | luseen must warn about every file changed outside `.luseen/environment/` during the step, skipping Git and dependency folders. | confirmed | `src/core/environment.ts:83`, `user request` |
| FR-ENV-012 | If a valid environment file exists, luseen must not ask or start Claude and must show its review details, and `luseen environment --force` must set it up again without replacing edited skills. | confirmed | `src/cli/environment-command.ts:39`, `user request` |
| FR-ENV-013 | Creating or changing `.luseen/environment/` must not invalidate the cache, change the generated documents, or count as a hand edit. | confirmed | `src/core/constants/discovery.ts:85`, `user request` |
| FR-ENV-014 | The skill must identify each runnable part and its type (`web`, `ios`, `android`, `desktop`, `cli` or `library`). If that's unclear it must ask, and where nobody can answer it must stop and report what it found. | confirmed | `src/core/agent-skills.ts:304`, `user request` |
| FR-ENV-015 | The alias must come from the manifest name or else the folder name, lowercased, with each run of other characters replaced by one hyphen, leading and trailing hyphens removed, limited to 63 characters, and `app` if nothing remains. All parts must share it. | confirmed | `src/core/agent-skills.ts:317`, `user request` |
| FR-ENV-016 | The environment file must hold only a version, a valid alias and at least one part. Each part must have a name, type, start command and review text. Web parts must have `stop`, `url` and `fallbackUrl`, and other parts must not have URLs. | confirmed | `src/core/environment.ts:23`, `user request` |
| FR-ENV-017 | The skill must start a `web` part with Docker Compose using `-p <alias>` and `up --build --wait`, with new Docker files in `.luseen/environment/` and a health check on each new web service. | confirmed | `src/core/agent-skills.ts:354`, `user request` |
| FR-ENV-018 | The skill must not change a project's existing Docker files, must use them if they can run the project, and must report any port not limited to this computer. | docs-only | `src/core/agent-skills.ts:346`, `user request` |
| FR-ENV-019 | New Compose files must publish on `127.0.0.1` only, must not use privileged mode, mount the Docker socket or mount anything outside the project folder, and images must not contain `.env` or other secret files. | confirmed | `src/core/agent-skills.ts:348`, `user request` |
| FR-ENV-020 | The skill must choose a free port, preferring the project's usual one, and must not stop another project's containers to free a port. | docs-only | `src/core/agent-skills.ts:353`, `user request` |
| FR-ENV-021 | The skill must provide `http://<alias>.localhost:<port>` and `http://localhost:<port>`, and request each. If the alias is refused it must say why and present the fallback. It must not edit the hosts file, or install certificates, DNS tools or a proxy. | confirmed | `src/core/agent-skills.ts:355`, `user request` |
| FR-ENV-022 | The skill must not read or copy `.env` or other secret files, or connect to production services, and must use example configuration and placeholders, reporting what's missing. | confirmed | `src/core/agent-skills.ts:296`, `user request` |
| FR-ENV-023 | If Docker isn't installed or running, the skill must not install or start it, must say what's needed, and must use the project's development command if it has one. | docs-only | `src/core/agent-skills.ts:345`, `user request` |
| FR-ENV-024 | For `ios` and `android`, the skill must build and launch the app on a simulator or emulator without signing or a real device, checking commands against the tools' own help, and say what's needed if a tool or platform is missing. | docs-only | `src/core/agent-skills.ts:357`, `user request` |
| FR-ENV-025 | For `desktop`, `cli` and `library`, the skill must not add Docker or a server, and must run the build and record a command to try with its expected result. | confirmed | `src/core/agent-skills.ts:361`, `user request` |
| FR-ENV-026 | The skill must run each start command it records and report the real result, and must not describe a failed part as working. | confirmed | `src/core/agent-skills.ts:341`, `user request` |
| FR-ENV-027 | After tests and before asking for approval, the agent must run each `start` command in the environment file, setting it up with the `local-env` skill if the file doesn't exist. A server the agent starts itself doesn't count. | confirmed | `src/core/agent-skills.ts:448`, `user request` |
| FR-ENV-028 | The preview must include the new change, so the agent must rebuild or restart before checking it. | confirmed | `src/core/agent-skills.ts:371`, `user request` |
| FR-ENV-029 | The review message must state the link or command, any fallback, what to look at, how to stop the preview, and whether the agent checked it. | confirmed | `src/core/agent-skills.ts:375`, `user request` |
| FR-ENV-030 | If the preview can't start, the agent must say why, report the test results, and still ask for review, unless the 3rd QA run failed, in which case it must report the failures without asking for approval (FR-INSTR-023). | docs-only | `src/core/agent-skills.ts:387`, `src/core/environment.test.ts:124`, `user request` |
| FR-ENV-031 | If a change has nothing to run, the agent must say no preview is needed. | docs-only | `src/core/agent-skills.ts:369`, `user request` |
| FR-ENV-032 | The agent must leave the preview running for review, and must not delete data volumes or stop anything it didn't start without asking. | confirmed | `src/core/agent-skills.ts:372`, `user request` |
| FR-ENV-033 | luseen must not commit environment files, and an agent must commit them only when the user agrees. | confirmed | `src/cli/environment-step.ts:58`, `user request` |
| FR-ENV-034 | If containers from another folder are running under the same Compose project name, the skill must tell the user before starting. | docs-only | `src/core/agent-skills.ts:354`, `user request` |

## Decisions

| Decision | Reason |
|---|---|
| Setup starts the Claude CLI with limited tools, after asking | The user asked for this during setup, and projects vary too much for fixed templates |
| `--yes` doesn't agree to it | Analysis allows no tools. This step can run project code, so it needs its own agreement |
| The built-in skill text is sent to Claude | A project's own `local-env` file can't change what runs |
| New files go in `.luseen/environment/` | The scan already skips it, so there's no re-analysis, and it can't overwrite project files |
| `<alias>.localhost` with a `localhost` fallback | It needs no hosts file, proxy or certificates, but RFC 6761 only says resolvers "SHOULD" return loopback |
| The workflow names the `start` command, not just the skill | In real trials with full shell access, agents skipped "use the `devops` skill" 3 times out of 3, and followed the concrete command 3 times out of 3 |

## Limits

- **The tool limits reduce risk, but don't remove it.** Build tools must be allowed, so in a real trial `node -e` could still read `.env` and write outside the environment folder. The changed-file warning reports such writes, but a read can't be detected.
- Workflow rules are guidance, so an agent can still fail to follow them.
- Environments can go stale. `luseen environment --force` rebuilds them.

## Edge cases

- A dev server may reject unknown hosts. The alias check catches this, and the fallback link is used.
- A project's own `local-env` skill is left alone, and isn't what Claude follows during setup.
- An invalid environment file is reported, then set up again.
- A project needing a database runs it as a local container with example values.

## Non-goals

- Deploying anywhere, or sharing a preview outside this computer.
- HTTPS, or addresses with no port.
- Installing Docker, Xcode, Android Studio or other tools.
- Running on a real phone, or signing a mobile build.
- Starting agents other than the Claude CLI during setup.
- Enforcing the workflow.
