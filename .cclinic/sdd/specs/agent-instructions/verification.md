# agent-instructions: verification

Test cases for automation testers. Start each automated test's name with its `TC` ID.

## Test setup

- Test framework: Vitest (package.json:47, vitest.config.ts:1); existing relevant files: src/core/agent-skills.test.ts, test/integration/skills.test.ts, test/e2e/skills.test.ts, test/support/helpers.ts.
- Docs state the full check is `npm run verify` (sdd/stack.md:82; package.json:30); exact Vitest invocation is not shown.
- Replace Claude with the fake executable test/fixtures/fake-claude/claude placed on PATH for e2e runs; record its calls to assert none are made.
- Use a temporary target folder per test; for git-related cases run `git init` inside it and create commits locally with no remote.
- Prepare fixtures: empty folder; folder with existing AGENTS.md/CLAUDE.md containing user text; file with an unterminated start marker; CLAUDE.md containing only the installed section.
- Manual agent-behaviour cases need a real agent (Claude Code, Codex, Cursor or Copilot); repeat each at least 3 times and judge by outcome, not wording (verification.md:5).

## Test cases

| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-INSTR-001 | FR-INSTR-001, FR-INSTR-004 | e2e | An empty temporary target folder and fake claude on PATH. | Run `cclinic skills <folder> --yes`. | Exit code 0; AGENTS.md exists with one marked section containing the four lifecycle stages and the skills table; output reports AGENTS.md and CLAUDE.md as installed. |
| TC-INSTR-002 | FR-INSTR-002 | e2e | An empty temporary target folder. | Run `cclinic skills <folder> --out docs/sdd --yes`. | AGENTS.md section references docs/sdd/specs/ and docs/sdd/README.md and does not contain `.cclinic/sdd` or an unreplaced {{DOCS}} placeholder. |
| TC-INSTR-003 | FR-INSTR-003 | e2e | An empty temporary target folder. | Run `cclinic skills <folder> --yes`. | CLAUDE.md exists with a marked section containing `@AGENTS.md` outside any code span and none of the workflow text (e.g. no skill names such as create-spec). |
| TC-INSTR-004 | FR-INSTR-004 | integration | A small sample project in a temp folder and a fake provider. | Run a successful generation with --yes. | After generation both AGENTS.md and CLAUDE.md sections exist and the report lists them. |
| TC-INSTR-005 | FR-INSTR-005 | e2e | An empty temp folder. | Run `cclinic skills <folder> --yes --no-skills`, then separately `cclinic <folder> --dry-run`. | In both runs neither AGENTS.md nor CLAUDE.md exists afterwards. |
| TC-INSTR-006 | FR-INSTR-006 | e2e | PATH without `claude` and ANTHROPIC_API_KEY unset; empty temp folder. | Run `cclinic skills <folder> --yes`. | Exit code 0 and both files exist. |
| TC-INSTR-007 | FR-INSTR-007, FR-INSTR-002 | integration | AGENTS.md with user text before and after an installed section, and CLAUDE.md with user text and no section. | Reinstall with a different --out. | Only the text inside the AGENTS.md markers differs (user text byte-identical); CLAUDE.md keeps its user text and gains a section appended at the end. |
| TC-INSTR-008 | FR-INSTR-008 | integration | Files already installed. | Run the install again with the same options and record file modification times. | Modification times and contents are unchanged and output reports both files as unchanged. |
| TC-INSTR-009 | FR-INSTR-009 | integration | CLAUDE.md containing a start marker with no end marker; no AGENTS.md. | Run the install. | CLAUDE.md is byte-identical to before; the output reports it as damaged/skipped; AGENTS.md is created with its section. |
| TC-INSTR-010 | FR-INSTR-009 | unit | AGENTS.md content with an unterminated start marker. | The section-merge function is applied. | Result signals a skipped/unchanged outcome and returns the original text unchanged. |
| TC-INSTR-011 | FR-INSTR-010 | unit | Generated AGENTS.md section text for default and custom --out. | Count its lines. | Count is below 200. |
| TC-INSTR-012 | FR-INSTR-011 | unit | Root CLAUDE.md with user text plus an installed section. | Content is extracted for analysis and hashed, before and after changing only the section. | The extracted text contains the user text but not the section, and the hash is identical in both cases. |
| TC-INSTR-013 | FR-INSTR-012 | integration | A project whose only CLAUDE.md contains just the installed section. | Run `cclinic <folder> --dry-run --json`. | CLAUDE.md is not in the files to analyse and not in the skipped list. |
| TC-INSTR-014 | FR-INSTR-013 | integration | A local git repo (no remote) whose newest commit changes only CLAUDE.md. | The history for context is read. | That commit is not included in the history. |
| TC-INSTR-015 | FR-INSTR-011, FR-INSTR-012, FR-INSTR-013 | e2e | A project already generated once with --yes, then instruction files installed and committed; fake claude records calls. | Run `cclinic <folder> --yes` again. | Fake claude records zero calls and no generated Markdown file changes. |
| TC-INSTR-016 | FR-INSTR-014 | manual | A temp project with cclinic docs and instructions installed, using a real agent. | Ask a question such as "how does the login work?". | The agent answers directly and no spec or code file changes (check git status clean). |
| TC-INSTR-017 | FR-INSTR-014 | manual | Project with several specs, real agent. | Request a clearly scoped code change, then an ambiguous one. | For the clear one the agent names the matching spec before acting; for the ambiguous one it asks which spec. |
| TC-INSTR-018 | FR-INSTR-015 | manual | Real agent in an installed project. | Request a new feature, then separately report a bug. | Feature uses create-spec or refine-spec; bug uses refine-spec with a new reproducing test case; each ends by asking for spec review; no production code files changed. |
| TC-INSTR-019 | FR-INSTR-015 | manual | Agent has proposed a spec update. | Reject it or request changes. | The agent refines the spec and asks again; no production code changes until an explicit approval. |
| TC-INSTR-020 | FR-INSTR-016 | manual | An approved spec update. | Tell the agent to proceed. | It implements using implement-spec/write-code, runs tests and reports actual results, asks for review, and makes no commit. |
| TC-INSTR-021 | FR-INSTR-016 | manual | A spec change not yet reviewed. | Invoke implement-spec directly. | It checks approval and asks for review before coding. |
| TC-INSTR-022 | FR-INSTR-016 | manual | Implementation under review. | Request a further change. | The agent applies it and asks for review again without committing. |
| TC-INSTR-023 | FR-INSTR-017 | manual | Real agent in an installed project. | Request fixing a typo in a code comment. | No spec review is requested; the agent names the spec, asks for code review, then asks whether to commit. |
| TC-INSTR-024 | FR-INSTR-018 | manual | Real agent. | Request a change and say "skip the spec update". | The agent skips the spec stage and states that it was skipped. |
| TC-INSTR-025 | FR-INSTR-018 | manual | Project without the docs folder; and a separate unattended agent run. | Request a code change in each. | The first agent asks the user to run cclinic; the unattended agent stops at the spec and changes no code. |
| TC-INSTR-026 | FR-INSTR-019 | manual | Implementation approved in a git repo with extra unrelated uncommitted changes. | Answer "yes" to the agent's commit question. | One commit contains only this change's spec, code and tests, follows the project commit format and references requirement IDs; unrelated changes remain uncommitted and are mentioned. |
| TC-INSTR-027 | FR-INSTR-019 | manual | Implementation approved; a remote exists. | Approve the implementation but decline committing; repeat approving with a failing test. | No commit is created when declined; with the failing test the agent states the failure before asking to commit; no push occurs in any case. |
| TC-INSTR-028 | FR-INSTR-020 | integration | A local git repo with one commit. | Run `cclinic skills <folder> --yes` and a full generation with the fake provider. | `git log` shows the same commit count and head as before; no push attempted. |
