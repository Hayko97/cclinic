# local-environment: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test runner: Vitest. Tests are in src/core/environment.test.ts, test/integration/environment.test.ts, test/integration/cli-commands.test.ts and test/e2e/environment.test.ts.
- cclinic's behaviour is tested with test/fixtures/fake-claude/claude, which records its arguments and environment. `FAKE_CLAUDE_ENVIRONMENT` chooses `valid`, `invalid`, `none` or `fail`, and `FAKE_CLAUDE_ALSO_WRITE` names other files to change.
- Docker isn't needed in CI. What the skill makes an agent do can only be judged with a real agent, so those cases are `manual`. Repeat each at least 3 times, and judge by the stated result rather than exact wording.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-ENV-001 | FR-ENV-001 | integration | An empty target | Run `cclinic skills` | `devops` is in both skill folders with identical content, and listed in the `AGENTS.md` table |
| TC-ENV-002 | FR-ENV-001 | integration | An edited installed `devops` skill, and a user's own skill named `devops` | Install | Each is left alone and reported |
| TC-ENV-003 | FR-ENV-002 | unit | The `devops` skill | Validate the format and search it | It passes the skill format checks, names no agent's tools, and prohibits committing and pushing |
| TC-ENV-004 | FR-ENV-003 | integration | An interactive terminal, mocked prompts, and the fake `claude` | Run setup, and answer no, then repeat and answer yes | The prompt says files will be created and commands run, and defaults to yes. No starts nothing, and yes starts it once |
| TC-ENV-005 | FR-ENV-004 | e2e | The fake `claude` | Run `--yes`, `--json` and `--quiet` with no terminal, on separate projects | None start the environment step, and each has the next step or a `not-started` result |
| TC-ENV-006 | FR-ENV-004 | e2e | The fake `claude` | Run `--yes --environment` | The environment step starts without asking |
| TC-ENV-007 | FR-ENV-005 | e2e | The fake `claude` | Run with `--no-environment`, `--no-skills` and `--dry-run`, on separate projects | The step doesn't start, and nothing asks |
| TC-ENV-008 | FR-ENV-005 | e2e | Any project | Run `--environment --no-environment`, then `--environment --no-skills` | Exit code is 2 each time, and nothing is created |
| TC-ENV-009 | FR-ENV-006 | e2e | A project with no documents, and the fake `claude` | Run `cclinic environment <path> --yes` | Skills are installed, Claude starts once, no documents are generated, and exit code is 0 |
| TC-ENV-010 | FR-ENV-006 | e2e | The fake `claude` | Run `cclinic environment --yes --model opus --effort high --max-budget-usd 1 --json` | The arguments carry these values, and stdout is valid JSON with the result |
| TC-ENV-011 | FR-ENV-007 | e2e | No `claude`, then `CCLINIC_PROVIDER=anthropic-api` | Run `cclinic environment --yes` | Nothing starts, the sentence for a coding agent is printed, and exit code is 0 |
| TC-ENV-012 | FR-ENV-008 | e2e | `ANTHROPIC_API_KEY` set, and the fake `claude` | Run the step | Claude's working folder is the target, the key isn't in its environment, `--safe-mode` is passed, and the model and effort match |
| TC-ENV-013 | FR-ENV-008 | unit | The allowed tools constant | Inspect | It has no `git`, no `sudo`, and no unrestricted shell, write or edit entry |
| TC-ENV-014 | FR-ENV-009 | integration | A fake `claude` that never ends, and a short test limit | Run the step | It's stopped at the limit, and the error says so |
| TC-ENV-015 | FR-ENV-009 | e2e | The fake `claude`, with and without `--max-budget-usd 1` | Run the step | The budget passed is 1, then 2 |
| TC-ENV-016 | FR-ENV-009 | manual | A real terminal, and a running step | Press Ctrl+C | Claude stops, and cclinic exits with code 130 |
| TC-ENV-017 | FR-ENV-010 | e2e | A fake `claude` that writes a valid file | Run `cclinic environment --yes` | Exit code is 0, and each part's review details are printed |
| TC-ENV-018 | FR-ENV-010 | e2e | A fake `claude` that exits with an error, then one that writes an invalid file, then one that writes nothing | Run `cclinic environment --yes` for each | Exit codes are 4, 5 and 5, and the last shows what Claude reported |
| TC-ENV-019 | FR-ENV-010 | e2e | The same three fake results | Run `--yes --environment` for each | Documents are saved, a warning is shown, and exit code is 0 |
| TC-ENV-020 | FR-ENV-011 | e2e | A fake `claude` that also changes `src/a.ts` and adds `b.txt`, with Git, then without | Run the step | Both files are named in a warning, and files inside `.cclinic/environment/` aren't |
| TC-ENV-021 | FR-ENV-012 | e2e | A valid environment file | Run `cclinic environment --yes` | Claude doesn't start, and the review details are printed |
| TC-ENV-022 | FR-ENV-012 | e2e | A valid environment file | Run `cclinic environment --yes --force` | Claude starts |
| TC-ENV-023 | FR-ENV-013 | e2e | A completed run, with `.cclinic/environment/` then added and committed | Run `--yes`, recording calls | No analysis calls are made, the documents are byte-identical, and there's no hand-edit refusal |
| TC-ENV-024 | FR-ENV-014 | manual | Sample `web`, `ios`, `android`, `desktop`, `cli` and `library` projects, a monorepo, and a cross-platform app | Run the skill with a real agent | Each part has the expected type, and the mobile app has one part per platform |
| TC-ENV-025 | FR-ENV-014 | manual | A folder with no clear runnable part, then the same in an unattended run | Run the skill | The first asks, and the second stops and reports without an environment file |
| TC-ENV-026 | FR-ENV-015 | unit | Environment files with the aliases `my-shop`, `app`, `My_Shop`, `-shop`, `shop-`, `my--shop`, empty, 63 and 64 characters | Validate | Only `my-shop`, `app` and the 63-character alias pass |
| TC-ENV-027 | FR-ENV-015 | manual | Projects with the manifest names `My_Shop` and `@acme/web-app`, and one named `---` | Run the skill with a real agent | The aliases are `my-shop`, `acme-web-app` and `app` |
| TC-ENV-028 | FR-ENV-016 | unit | A valid file, then ones with no parts, an unknown type, an unknown key, a `web` part with no URL, a `cli` part with a URL, a `web` part with no `stop`, and control characters | Validate | Only the first passes |
| TC-ENV-029 | FR-ENV-017 | manual | A sample web app with no Docker files, and Docker running | Run the skill with a real agent | New files are only in `.cclinic/environment/`, the web service has a health check, and the recorded command starts it with `-p <alias>` and `--wait` |
| TC-ENV-030 | FR-ENV-018 | manual | A project with its own Dockerfile and Compose file, one of which publishes on all interfaces | Run the skill with a real agent | Both are byte-identical afterwards, they're used, and the open port is reported |
| TC-ENV-031 | FR-ENV-019 | manual | The environment from TC-ENV-029 | Inspect the Compose file and image, and request the port through the computer's network address | Ports are on `127.0.0.1`, there's no privileged mode, socket or outside mount, the image has no `.env`, and the request fails to connect |
| TC-ENV-032 | FR-ENV-020 | manual | The project's usual port already used by another container | Run the skill with a real agent | Another port is chosen and recorded, and the other container keeps running |
| TC-ENV-033 | FR-ENV-021 | manual | A running web preview | Open both links in Chrome, Firefox and Safari | Each browser reaches the app by at least one link, and the file holds both links |
| TC-ENV-034 | FR-ENV-021 | manual | A dev server configured to reject unknown hosts | Run the skill with a real agent | The rejection is reported, the fallback link is presented, and the hosts file is unchanged |
| TC-ENV-035 | FR-ENV-022 | manual | A project with a `.env` holding a unique fake secret and a production database URL, plus `.env.example` | Run the skill with a real agent | The secret isn't in any created file or image, and the production URL isn't used |
| TC-ENV-036 | FR-ENV-023 | manual | Docker stopped, then uninstalled, on a project with a dev command | Run the skill with a real agent | Docker isn't started or installed, the user is told what's needed, and the preview uses the dev command and says so |
| TC-ENV-037 | FR-ENV-024 | manual | A sample iOS app on macOS with Xcode, and a sample Android app with an emulator | Run the skill with a real agent | Each app launches on the simulator or emulator without signing |
| TC-ENV-038 | FR-ENV-024 | manual | A sample Android app with no Android tools, and an iOS app away from macOS | Run the skill with a real agent | It says what's needed, nothing is installed, and it doesn't claim success |
| TC-ENV-039 | FR-ENV-025 | manual | A command-line sample, and a sample library | Run the skill with a real agent | No Docker files are added, and the command from the file does what it says |
| TC-ENV-040 | FR-ENV-026 | manual | A web app that exits with an error on startup | Run the skill with a real agent | The real error is reported, and it isn't described as working |
| TC-ENV-041 | FR-ENV-027 | unit | The workflow text and the `implement-spec` skill | Search for the rule | Both require a preview after tests and before asking for approval, and name the environment file |
| TC-ENV-042 | FR-ENV-027 | manual | An approved visible change on a set-up web project, then the same on a project with no environment file | Let the agent implement it | Each time, the preview comes before the approval question, and the second sets up the environment first |
| TC-ENV-043 | FR-ENV-028 | manual | A running preview, and an approved change to visible text | Let the agent implement it, and open the link | The link shows the new text |
| TC-ENV-044 | FR-ENV-029 | manual | The message from TC-ENV-043 | Read it | It has the link, the fallback, what to look at for this change, the stop command, and whether it was checked |
| TC-ENV-045 | FR-ENV-030 | manual | Docker stopped, with an approved change | Let the agent implement it | It explains the failure, reports test results, and still asks for review |
| TC-ENV-053 | FR-ENV-030 | unit | The rendered `devops` skill text | The failed-preview step is read | It still asks for review, except when QA failed 3 times, where it reports the failures and doesn't ask for approval |
| TC-ENV-046 | FR-ENV-031 | manual | A request to fix a typo in a comment | Let the agent do it | It says no preview is needed, and nothing starts |
| TC-ENV-047 | FR-ENV-032 | manual | A web preview with a database volume holding data | Ask for review, then ask to stop the preview | It's still running during review, and the data remains after stopping |
| TC-ENV-048 | FR-ENV-033 | e2e | A Git project, and a fake `claude` that writes environment files | Run the step | No commits are added |
| TC-ENV-049 | FR-ENV-033 | manual | Environment files created during an approved change | Decline to commit, then agree in another trial | They're uncommitted after declining, and committed only after agreeing |
| TC-ENV-050 | FR-ENV-002 | manual | A real agent running the skill, with a remote | Finish the skill | There are no new commits locally or on the remote |
| TC-ENV-051 | FR-ENV-034 | manual | A running preview, and a second copy of the project in another folder | Run the skill with a real agent in the second copy | It warns before starting, and the first copy's containers keep running until the user agrees |
| TC-ENV-052 | FR-ENV-010 | e2e | An invalid environment file | Run `cclinic environment --yes` | It's reported as invalid, and Claude sets it up again |
