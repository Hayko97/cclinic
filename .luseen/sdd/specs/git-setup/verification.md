# git-setup: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test framework: Vitest (colocated src/**/*.test.ts, e.g. src/core/git-history.test.ts; test/integration/git.test.ts; test/e2e/git.test.ts). Run via npm scripts in package.json (npm run verify is the documented full check).
- Use real temporary Git repositories with real git; set GIT_AUTHOR_DATE/GIT_COMMITTER_DATE to place commits in time; isolate HOME and GIT_CONFIG_GLOBAL to temp locations.
- Replace Claude with the fake claude (test/fixtures/fake-claude/claude) or FakeLlm; no network needed.
- Simulate missing Git using a PATH without git; use a fixed clock and fake git wrappers to record commands.
- Support helpers in test/support/helpers.ts.

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-GIT-001 | FR-GIT-001 | integration | Four temp folders: no repo, plain repo without remote, repo with remote, and a subfolder of a parent repo; git available. | Git detection runs on each. | Each reports correct installed/repository/remote values (parent repo detected for the subfolder) and no files or .git are created or modified. |
| TC-GIT-002 | FR-GIT-001, FR-GIT-020 | integration | PATH containing no git executable. | Detection runs and a generation run is made with --yes and fake claude. | Git is reported as not installed, a warning is shown, the run exits 0 and no history is used. |
| TC-GIT-003 | FR-GIT-002 | e2e | A folder with source files and no repository. | Running luseen --dry-run on it. | Output states a repository would be created and the Git status; no .git folder exists afterwards and no Claude call occurs. |
| TC-GIT-004 | FR-GIT-003 | e2e | A folder with no repository and no remote and an available provider. | Running luseen doctor on it. | Doctor reports Git installed, repository absent and remote absent with fixes, creates no .git, and Git items alone do not cause a not-ready exit code. |
| TC-GIT-005 | FR-GIT-004 | e2e | Folder with files, no repo, fake claude that records when it is first called; init.defaultBranch=trunk in the isolated global config. | Running luseen --yes. | .git exists with branch trunk, created before the first fake claude call; with no setting the branch is main. |
| TC-GIT-006 | FR-GIT-005 | e2e | Folder with files, no repo, interactive prompt answered no; and a second folder with nothing to analyse run with --yes. | Running luseen in each. | No .git folder exists in either folder. |
| TC-GIT-007 | FR-GIT-006 | integration | A target subfolder inside a parent repository. | Running luseen --yes on the subfolder. | No .git is created in the subfolder and the parent repository is used. |
| TC-GIT-008 | FR-GIT-007, FR-GIT-024 | integration | A fake git wrapper that records commands; a folder with no .gitignore. | Running a --yes generation. | Recorded commands contain no add, commit, config, remote or push; no .gitignore is created; the output recommends one; repo has zero commits and nothing staged. |
| TC-GIT-009 | FR-GIT-008, FR-GIT-009 | e2e | Repository with no remote. | Running luseen --yes, then with --quiet, then with --json. | Normal run shows alert with GitHub, GitLab, Bitbucket links and remote add and push commands and exit code 0; --quiet hides the alert; --json includes the alert. |
| TC-GIT-010 | FR-GIT-009 | e2e | A repository with a remote; and a repository without remote run with --no-git. | Running luseen --yes on each. | No remote alert is shown in either. |
| TC-GIT-011 | FR-GIT-010 | integration | Remote URL https://user:SECRETTOKEN@github.com/o/r.git, fake claude capturing prompts, --debug on. | Running luseen --yes. | Neither stdout, stderr, debug output nor captured prompts contain SECRETTOKEN; only remote name and host appear. |
| TC-GIT-012 | FR-GIT-011 | e2e | Folder with no repo. | Running luseen --yes --no-git; and in an existing repo with recent commits. | No .git created, no remote alert, and prompts contain no history section. |
| TC-GIT-013 | FR-GIT-012 | unit | Fixed clock and commits dated 13 days ago, 15 days ago, a merge commit and a commit on another branch. | History is read. | Only the 13-day non-merge commit on the current branch is returned with short hash, date, message and paths. |
| TC-GIT-014 | FR-GIT-012 | integration | Repository with commits in folder a/ and folder b/; target is a/; also detached HEAD checkout. | History is read for a/. | Only commits touching a/ appear; with detached HEAD history comes from the checked-out commit; repo with zero commits yields no history without error. |
| TC-GIT-015 | FR-GIT-013 | integration | Commit with author name/email and a diff containing a unique marker line; fake claude capturing prompts. | Running luseen --yes. | Prompts contain neither author name, email nor diff content marker. |
| TC-GIT-016 | FR-GIT-014 | integration | Commits touching only .luseen, .agents, .claude and AGENTS.md; a commit touching src/app.ts and .env and node_modules/x.js; a commit message containing a fake AWS key. | History is built. | The luseen-only commits are absent; changed paths include src/app.ts only; the message shows a redaction marker not the key. |
| TC-GIT-017 | FR-GIT-015 | integration | Repository with more than 300 recent commits; another with messages totalling more than 100,000 characters. | History is built, and run with a small --max-input-tokens. | Newest 300 commits / 100,000 chars kept with warning stating omitted count; size counts to the estimate; exceeding --max-input-tokens exits 2 with no Claude call. |
| TC-GIT-018 | FR-GIT-016 | integration | Repo with recent commits; FakeLlm capturing each prompt. | Running a full generation. | Combine and each spec prompt contain a delimited history block; module summary prompts do not; a message containing a closing project_content tag is escaped. |
| TC-GIT-019 | FR-GIT-017 | unit | Generated spec content with evidence being a commit hash only, and another citing a project file. | Validation runs. | The commit-hash-only evidence is rejected; file evidence is accepted; the prompt text states history is context only and conflicts become open questions. |
| TC-GIT-020 | FR-GIT-018 | integration | Repo, first run completed with fake claude counting calls. | Re-running after time passes; after committing .luseen output; after a new relevant commit; after changing one module file. | First two reruns make zero calls; new commit reruns combine and spec but not summaries; module change regenerates only that module's summary. |
| TC-GIT-021 | FR-GIT-018 | integration | Folder with no repo, run once; then git init created by luseen. | Running again. | No Claude calls are made because cache keys match the no-history run. |
| TC-GIT-022 | FR-GIT-019 | integration | Two runs with the same newest commit but different commit counts or dates in window. | Generating documents with --json. | Generated Markdown files are byte-identical and contain no commit counts or dates; --json includes Git status and commit count. |
| TC-GIT-023 | FR-GIT-020 | integration | A corrupt .git folder; a shallow clone. | Running luseen --yes. | Exit code 0, warnings shown (shallow warns history may be incomplete), documents generated. |
| TC-GIT-024 | FR-GIT-021 | manual | A repository owned by another user so Git reports dubious ownership. | Running luseen --yes. | A warning is shown, run continues without history, and no safe.directory setting is added to any Git config. |
| TC-GIT-025 | FR-GIT-022 | integration | Repository config setting core.fsmonitor and diff.external to scripts that write a marker file; a path containing glob characters and spaces. | Running luseen --yes. | Marker file is not created; recorded Git calls use no shell, include --no-ext-diff, --no-textconv and core.fsmonitor=false, and pass the path literally. |
| TC-GIT-026 | FR-GIT-022, FR-GIT-020 | unit | A fake git wrapper that hangs longer than the timeout. | History is read. | The call is terminated, a warning is produced and the run continues without history. |
| TC-GIT-027 | FR-GIT-023 | unit | Source files under src/ except src/core/constants/git.ts. | The constants test (src/core/git-history.test.ts) scans them. | No hard-coded 14-day window, 300, 100000, excluded path names or provider links appear outside src/core/constants/git.ts. |
