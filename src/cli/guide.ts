/** Help text shown in the terminal. It works offline, so it's always available (FR-CLI-022). */
import { HISTORY_WINDOW_DAYS } from "../core/constants/git.js";
import { LIMITS } from "../core/constants/limits.js";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
} from "../core/constants/models.js";

export const HELP_HOW_IT_WORKS = `
How it works:
  1. Scans your project, skipping dependencies, build output, binaries and secrets
  2. Shows a summary, and asks before sending anything to Anthropic
  3. Uses Claude to write specs and project documents to .cclinic/sdd/
  4. Installs nine skills, so your coding agent can work from those documents
  5. Offers to set up a local environment, so you can try each change yourself

Get started:
  cclinic doctor       check your setup
  cclinic --dry-run    preview what would be analysed
  cclinic              generate documents and install the skills

Examples:
  cclinic ./my-project
  cclinic --model                       choose a model from a menu for this run
  cclinic --model ${CLAUDE_MODELS.OPUS.value} --effort ${CLAUDE_EFFORTS.HIGH.value}    choose without a menu
  cclinic --yes --max-budget-usd 5      run without asking, aiming to stay within $5

Run "cclinic guide" for the full walkthrough, or "cclinic help <command>" for one command.
`;

export function commandHelp(...examples: readonly string[]): string {
  const lines = examples.map((example) => `  ${example}`).join("\n");
  return `\nExamples:\n${lines}\n\nRun "cclinic guide" for the full walkthrough.\n`;
}

export const NEXT_STEPS = `Next: review open-questions.md, then ask your coding agent to use a skill. Run "cclinic guide" for details.`;

export const GUIDE_TEXT = `cclinic guide

cclinic sets up spec-driven development for an existing project. It reads your
own code and documents, and uses Claude to write specs that coding agents and
testers can follow.

BEFORE YOU START

  You need Node.js 22.18 or newer, and one of these:
    - Claude Code, logged in: claude auth login (used by default)
    - An Anthropic API key:   export ANTHROPIC_API_KEY=<your key>

  Project content is sent to Anthropic when you confirm a run.

STEP 1: CHECK YOUR SETUP

  cclinic doctor

  This uses no Claude usage, and tells you how to fix anything that's wrong.

STEP 2: PREVIEW

  cclinic --dry-run

  Shows what would be analysed, what's skipped, and the estimated size. Nothing
  is sent or written. Use --dry-run --json to list every file.

STEP 3: GENERATE

  cclinic

  Review the summary and confirm. When it finishes, your project has:

    .cclinic/sdd/
      README.md                 how to use these documents
      overview.md               purpose, users, scope
      stack.md                  languages, frameworks, tools
      architecture.md           structure and data flow
      developer-guidelines.md   best practices, tailored to your stack
      open-questions.md         conflicts and unknowns
      scan-report.md            what was analysed and skipped
      manifest.json             run details and file hashes
      specs/<spec-name>/
        spec.md                 requirements, with evidence
        validation.md           acceptance criteria
        verification.md         test cases for automation testers

    .agents/skills/  .claude/skills/          skills for your coding agent
    AGENTS.md  CLAUDE.md                      how your coding agent should work

  If there's no Git repository, cclinic creates a local one and tells you how to
  connect a remote, such as GitHub. It never commits or pushes for you. If there
  is a repository, its last ${HISTORY_WINDOW_DAYS} days of commit messages and file names give
  Claude context on recent work. Use --no-git to turn all of this off.

STEP 4: REVIEW

  Start with open-questions.md, which lists conflicts and unknowns. Then check
  each requirement's status:

    confirmed    code and documents agree
    code-only    found only in code
    docs-only    found only in documents, so it may not be built yet

  Commit .cclinic/sdd, .cclinic/environment, .agents, .claude, AGENTS.md and CLAUDE.md, so your team shares them.

  cclinic then offers to set up a local environment. If you agree, Claude creates
  files in .cclinic/environment and runs build and Docker commands. A web project
  gets a link such as http://my-app.localhost:3000, a mobile app gets a simulator
  build, and a command-line tool or library gets a command to try. --yes doesn't
  agree to this, so use --environment, or run "cclinic environment" later.

STEP 5: WORK WITH YOUR CODING AGENT

  AGENTS.md and CLAUDE.md tell your agent to follow this lifecycle for code changes:

    1. Prompt      it analyses your request, and finds the spec
    2. Spec        it refines the spec, and you approve or reject it
    3. Implement   after approval, it builds, tests and reviews the code, shows you a preview,
                   and you review it
    4. Commit      after you approve, it asks to commit. It never pushes on its own

  You can just describe what you want. You can also ask for a skill by name:

    create-spec      "Use create-spec to write a spec for password reset."
    refine-spec      "Use refine-spec on the user-login spec."
    write-code       "Use write-code to add a retry to the payment client."
    implement-spec   "Use implement-spec to build the user-login spec."
    test-spec        "Use test-spec to test the user-login spec."
    local-env        "Use local-env to set up the local environment."
    product-engineer "Help me plan what to build next." (then: cclinic plan)
    review-doc       "Use review-doc to show how the user-login change will look."
    review-code      "Use review-code to review my uncommitted changes."

  Roadmaps are created only by the PM agent, with "cclinic plan". Tasks are kept
  in .cclinic/tasks.db. On each prompt, your agent checks for open tasks, and
  asks whether to work on one, remove it, or keep it.

  "cclinic auto --roadmap <id> --max-budget-usd <n>" runs a whole roadmap with
  developer, PM and QA agents, on its own branches, and notifies you at the end.

  Skills you wrote are never replaced. Skills you edited are kept unless you use
  "cclinic skills --force".

STEP 6: RUN IT AGAIN LATER

  cclinic

  Only what changed is reprocessed, and a failed run continues where it stopped.

  If documents were edited, by you or by an agent, cclinic stops instead of
  overwriting them. "cclinic --force" replaces the whole folder, including those
  edits, so commit first.

COMMANDS

  cclinic [path]          generate documents and install the skills
  cclinic model           choose your default model and reasoning level
  cclinic model --list    show the options and your current choice
  cclinic model --reset   go back to ${DEFAULT_CLAUDE_MODEL.label} at ${DEFAULT_CLAUDE_EFFORT.label.toLowerCase()}
  cclinic skills [path]   install the skills only, with no Claude usage
  cclinic environment [path]  set up a local environment for previews
  cclinic plan            plan a roadmap with the PM agent. --task for one task
  cclinic auto            run a whole roadmap with agents, with no human
  cclinic tasks roadmaps  list roadmaps with their status, with no Claude usage
  cclinic tasks list      list open tasks. Also: roadmap, add, depend, show, start, done, remove
  cclinic doctor [path]   check your setup, with no Claude usage
  cclinic clean [path]    delete the cache and failed drafts
  cclinic guide           show this guide
  cclinic help [command]  show the options for a command

WHAT'S SKIPPED

  Dependency and build folders: node_modules, vendor, dist, build, target and others
  Binary files:                 .dll, .exe, .so, .jar, images, archives and others
  Lockfiles, and minified or generated files
  Files in .gitignore or .cclinicignore
  Secrets, which are never read: .env files, private keys, credential files

  Known secret formats in other files are removed before sending. This is
  best-effort, so review your project first. Use --include and --exclude to
  change what's scanned, though --include can't expose secrets.

LIMITS

  Large runs stop before anything is sent, and tell you which option to change.

  --max-files <n>            ${LIMITS.maxFiles.default}
  --max-input-tokens <n>     ${LIMITS.maxInputTokens.default}
  --max-file-size-mib <n>    ${LIMITS.maxFileSizeMib.default}
  --max-budget-usd <n>       none. Spend can pass this, as it's checked against an estimate
  --concurrency <n>          ${LIMITS.concurrency.default}
  --timeout-minutes <n>      ${LIMITS.timeoutMinutes.default}
  --max-retries <n>          ${LIMITS.maxRetries.default}

COMMON PROBLEMS

  "edited by hand"     Commit or move your edits, then use --force to replace them.
  "above the limit"    Exclude files, or raise the limit named in the message.
  A usage limit        Wait, then run the same command to continue.
  Scanned PDFs         These have no readable text. See the warnings in scan-report.md.
  Anything else        Run cclinic doctor, or add --debug-file debug.log.

EXIT CODES

  0  success, or you declined           4  Claude call failed, or budget reached
  1  unexpected error                   5  documents failed validation
  2  usage error, or a limit reached    130  stopped with Ctrl+C
  3  no provider available              143  stopped with SIGTERM
`;
