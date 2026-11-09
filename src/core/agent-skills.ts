/**
 * The skills cclinic installs for a project's coding agent (spec: agent-skills).
 * They're generic and read the project's own documents, so they fit any stack and need no Claude call.
 * {{DOCS}} is replaced with the documents folder, relative to the project root.
 */

import { LOCAL_ENV_SKILL_NAME, ENVIRONMENT_FILE, ENVIRONMENT_FOLDER } from "./constants/environment.js";
import { AGENTS_FILE, REVIEW_DOC_SKILL_NAME, REVIEWS_FOLDER } from "./constants/paths.js";
export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const REGENERATE_WARNING = `## Don't lose this work

cclinic treats edits in \`{{DOCS}}\` as hand edits. Re-running \`cclinic\` then refuses to continue, and \`cclinic --force\` replaces the whole folder, including these edits. Never run \`cclinic --force\` without asking the user first.`;

const SPEC_FORMAT = `## Spec format

Each spec is a folder, \`{{DOCS}}/specs/<kebab-case-name>/\`, with exactly three files. Copy the structure of an existing spec if there is one.

**\`spec.md\`:** a goal, then requirements, then edge cases and non-goals.

\`\`\`markdown
| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-AUTH-001 | The system must lock an account after 5 failed logins. | docs-only | \`docs/security.md:12\` |
\`\`\`

**\`validation.md\`:** acceptance criteria in plain language, with no implementation details.

\`\`\`markdown
| ID | Covers | User need | Accepted when |
|---|---|---|---|
| VAL-AUTH-001 | FR-AUTH-001 | My account is protected from guessing | After 5 wrong passwords, I can't log in until I reset it |
\`\`\`

**\`verification.md\`:** test setup, then test cases detailed enough to automate without reading the code. Include error and edge cases.

\`\`\`markdown
| ID | Covers | Level | Given | When | Then |
|---|---|---|---|---|---|
| TC-AUTH-001 | FR-AUTH-001 | integration | An account with 4 failed logins | A 5th login fails | The account is locked, and a correct password is rejected |
\`\`\`

**Rules:**

- **IDs:** \`FR-\`, \`VAL-\` and \`TC-<AREA>-NNN\`. The area is 2 to 8 uppercase letters, unique to the spec. IDs are permanent: never renumber or reuse one, even if its requirement is removed.
- **Coverage:** every requirement has at least one \`VAL\` and one \`TC\`. Every \`Covers\` entry points to a real requirement.
- **Requirements:** one testable behaviour each, using "must". Avoid words that can't be tested, such as "fast", "secure" or "user-friendly".
- **Status:** \`confirmed\` (code and documents agree), \`code-only\` (only in code), or \`docs-only\` (not built yet, or only in documents).
- **Evidence:** cite \`path:line\`, \`path:start-end\`, \`document.pdf:page\` or \`document.docx#Heading\`. For a new request with no document, cite where it came from, such as \`user request\`.
- **Unknowns:** never invent an answer. Add it to \`{{DOCS}}/open-questions.md\`.`;

const REVIEW_OPTIONS = `Then offer the user three options, and stop until they choose one:
   - **\`approve\`:** the spec is ready to implement.
   - **\`refine\`:** refine the spec with the changes they ask for, and ask again.
   - **\`review-doc\`:** use the \`${REVIEW_DOC_SKILL_NAME}\` skill to write a visual doc of how the project will work and look after the change.

   Don't implement it in this skill.`;

const MISSING_DOCS = `If \`{{DOCS}}\` doesn't exist, stop and ask the user to run \`cclinic\` in the project root to generate it.`;

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "create-spec",
    description:
      "Writes a new spec for a feature or capability, with requirements, acceptance criteria and test cases. Use when the user asks to spec, plan or document something new before building it, or describes a feature that has no spec yet.",
    body: `# Create a spec

Write a spec that a developer and an automation tester could each work from without asking more questions. Don't write production code in this skill.

## Steps

1. **Read the context.** Read \`{{DOCS}}/README.md\`, \`overview.md\`, \`architecture.md\` and \`open-questions.md\`. ${MISSING_DOCS}
2. **Check for overlap.** Read the goals of the existing specs in \`{{DOCS}}/specs/\`. If this belongs in an existing spec, use the \`refine-spec\` skill instead.
3. **Look at the code.** Find what already exists for this capability, so that requirements reflect reality and can cite evidence.
4. **Ask before assuming.** If the goal, users or scope are unclear, ask the user. Ask only about what would change the spec, and record anything unresolved as an open question.
5. **Write the three files,** using the format below. Scope one capability per spec, and split it if it's growing into several.
6. **Add it to the specs table** in \`{{DOCS}}/README.md\`.
7. **Check your work** using the checklist below.
8. **Ask for review, and stop.** Summarise the spec and any open questions. ${REVIEW_OPTIONS}

${SPEC_FORMAT}

## Checklist

- [ ] Every requirement is one testable behaviour, with a status and evidence
- [ ] Every requirement has at least one \`VAL\` and one \`TC\`
- [ ] Error and edge cases have test cases, not only the success path
- [ ] The area code and IDs don't clash with another spec, or with \`retiredIds\` in \`{{DOCS}}/manifest.json\`
- [ ] Nothing was invented. Unknowns are open questions

${REGENERATE_WARNING}
`,
  },
  {
    name: "refine-spec",
    description:
      "Improves an existing spec: fixes vague or untestable requirements, fills coverage gaps, updates it to match the code, and resolves open questions. Use when the user asks to review, refine, update or tighten a spec, or when code and spec have drifted apart.",
    body: `# Refine a spec

Make an existing spec more accurate and testable, without changing what the project intends unless the user agrees.

## Steps

1. **Read the spec's three files,** plus \`{{DOCS}}/open-questions.md\`. ${MISSING_DOCS}
2. **Check it against the code and cited evidence.** Open what each requirement cites, and confirm it still says that.
3. **Find the problems:**
   - Requirements that are vague, untestable, or combine several behaviours
   - Requirements with no \`VAL\` or \`TC\`, and test cases with no failure scenarios
   - Test cases that an automation tester couldn't write without more information
   - Acceptance criteria that mention implementation details
   - Wrong statuses or stale evidence
   - Conflicts with other specs, code or documents
4. **Separate what you can fix from what the user must decide.** Fix wording, coverage, evidence and status yourself. Anything that changes intended behaviour is the user's decision, so ask. If they can't answer now, record an open question.
5. **Make the changes,** keeping IDs stable. When a requirement is removed, delete it and don't reuse its ID. When one is split, keep the ID for the closest match, and give the rest new numbers.
6. **Remove resolved items** from \`open-questions.md\`, and reflect the answers in the spec.
7. **Ask for review, and stop.** Report what changed and why, what you asked, and what's still open. ${REVIEW_OPTIONS}

${SPEC_FORMAT}

${REGENERATE_WARNING}
`,
  },
  {
    name: "write-code",
    description:
      "Writes or changes code the way a careful maintainer of this project would: following its stack, architecture and conventions, in small changes without unnecessary comments or abstractions. Use whenever writing, changing or refactoring production code in this project.",
    body: `# Write code

Write what an experienced maintainer of this project would write. A reviewer should find it hard to tell your code from the code around it, because it fits, and it should be no bigger than the task needs.

## Before writing

1. **Read the project's rules:** \`{{DOCS}}/stack.md\`, \`architecture.md\` and \`developer-guidelines.md\`. They set the languages, versions, layers, naming and test tools. Where they conflict with habit, they win.
2. **Read the code nearby.** Read the file you'll change, its neighbours and its tests. Where nearby code and general best practice differ, follow the project, and mention the difference instead of introducing a second style.
3. **Search before creating.** Look for an existing function, type, helper or pattern that does this. Extend or reuse it.

## While writing

**Match the project:** naming, file layout, error handling, logging, formatting and test style. Use the libraries it already uses. Don't add a dependency without a clear need, and tell the user if you do.

**Keep the change small:**

- Do what was asked, and nothing else. Note other problems you see instead of fixing them in this change.
- Don't reformat, rename or reorganise code you aren't otherwise changing.
- Delete what your change makes unused.

**Design for today's need:**

- Write the simple, direct version first. Don't add interfaces, factories, options or configuration for needs that don't exist yet.
- Apply SOLID and the project's architecture rules where they reduce the cost of change, not as ceremony.
- Duplicate a little rather than build the wrong abstraction. But if the same logic is already there, reuse it.

## Avoid these habits of careless generated code

| Avoid | Instead |
|---|---|
| Comments restating the code, such as \`// increment the counter\` | Clear names. Comment only on why, such as a surprising constraint or workaround |
| Long doc comments on every small function | Follow the project's documentation habits |
| Unused helpers, parameters, imports and variables | Write only what's called |
| Checks for cases that can't happen, and catching errors only to log and rethrow | Validate at boundaries. Trust internal code. Handle errors where you can act on them |
| New wrappers, managers and utility files around one call | Call it directly, or use what exists |
| Unrequested features, flags, fallbacks and backwards compatibility | Ask, or leave them out |
| Duplicating logic because editing existing code seems riskier | Refactor the existing code when the task needs it, with tests |
| Placeholders, TODOs and stubs presented as finished | Finish it, or say clearly what's incomplete |
| Invented APIs and options | Check the source, types or docs of the version in use |
| Vague names such as \`data\`, \`result\`, \`handler\`, \`processItem\` | Names from the project's domain |
| Summary files, and changelogs nobody asked for | Update existing docs only when behaviour changes |

## Before finishing

1. Run the project's formatter, linter, type checker and tests, using the commands in \`{{DOCS}}/stack.md\` or the project's own scripts.
2. Read your whole diff as a reviewer would. Remove anything the task doesn't need.
3. Say plainly what you changed, what you ran and the results, including anything that failed or that you couldn't run.

Follow the project's rules on commit messages and on disclosing AI assistance. Writing like a maintainer is about code quality. Never hide or remove attribution that the project or the user requires.
`,
  },
  {
    name: "implement-spec",
    description:
      "Builds a spec requirement by requirement, with tests from its test cases, and reports proof that each one works. Use when the user asks to implement, build or complete a spec, feature or requirement that has a spec folder.",
    body: `# Implement a spec

Turn a spec into working, tested code, and report honestly on each requirement.

## Steps

1. **Read the spec.** Read its \`spec.md\`, \`validation.md\` and \`verification.md\` in \`{{DOCS}}/specs/<name>/\`. ${MISSING_DOCS} If the spec doesn't exist, use the \`create-spec\` skill first.
2. **Check for blockers.** Read \`{{DOCS}}/open-questions.md\`. If an open question affects a requirement you're about to build, stop and ask the user. Don't guess.
3. **Check that it's approved.** If the spec was changed for this work and the user hasn't approved it, show them the changes and ask first. Don't write code until they approve.
4. **Follow the \`write-code\` skill** for all code. If your agent can't load it, read \`.agents/skills/write-code/SKILL.md\`.
5. **Plan briefly.** List the requirements in a sensible build order, and what each one touches. For a large spec, share the plan with the user before starting.
6. **Build one requirement at a time:**
   1. Write its tests from the \`TC\`s that cover it, naming each test with its ID, such as \`TC-AUTH-001: locks the account after 5 failed logins\`.
   2. Confirm that they fail for the right reason, where that's practical.
   3. Write the smallest code that meets the requirement.
   4. Run the tests, then the wider suite for what you touched.
7. **Stay in scope.** Build only what the spec says. If the spec is wrong or incomplete, stop and tell the user, or use the \`refine-spec\` skill with their agreement. Don't quietly build something different.
8. **Verify everything.** Run the project's full checks. Then read each \`VAL\`, and judge whether the result would really meet it.
9. **Hand it to QA.** Test the change with the \`test-spec\` skill, in a separate agent if your tool can run one. For each defect, decide whether the code, the test or the spec is wrong. Fix wrong code with \`write-code\`, or a wrong test so it checks what the spec says, then run QA again. If the spec is wrong, stop and use the \`refine-spec\` skill with the user's agreement. QA runs at most 3 times for a change, counting every run, and the count starts again only after the user replies. If the 3rd QA run still fails, stop: report the failures and show how to review it if the preview can start, instead of asking for approval.
10. **Update the spec.** Set each finished requirement's status to \`confirmed\`, and update its evidence to point to the code. Only do this for requirements that work.
11. **Show how to review it.** Run each \`start\` command in \`${ENVIRONMENT_FOLDER}/${ENVIRONMENT_FILE}\`, so the local environment includes this change, leave it running, and give the user a link, build or command to try. If the file doesn't exist, set it up with the \`local-env\` skill.
12. **Report and ask for review,** using the format below. Give the steps for each \`manual\` test case QA didn't run, so the user can test it by hand. Ask the user to approve the implementation or request changes. If they request changes, make them, run QA again, show how to review it again, and ask again.
13. **Ask to commit.** Once they approve the implementation, ask whether to commit. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change, and don't include secrets. State any test that failed or wasn't run before asking. If they decline, leave the changes uncommitted.

## Report format

\`\`\`markdown
| Requirement | Result | Code | Test cases |
|---|---|---|---|
| FR-AUTH-001 | Done | \`src/auth/lockout.ts:12\` | TC-AUTH-001 passed, TC-AUTH-002 passed |
| FR-AUTH-002 | Blocked | | Waiting on an open question about reset emails |
\`\`\`

Also list the commands you ran with their results, any manual test cases still to do, and any problems you found.

## Honesty rules

- Never say something passes unless you ran it and saw it pass.
- If you couldn't run something, say so.
- Never skip, delete or weaken a test to get a pass. A failing test is either a bug to fix or a question for the user.
- "Done" means built and tested. Report anything else as partial or blocked.
- Approving a spec or an implementation doesn't mean agreeing to commit, so always ask.
- Never push unless the user asks.
`,
  },
  {
    name: "test-spec",
    description:
      "Acts as QA for a spec or feature: automates its test cases, runs them, explores edge cases, and reports results and defects. Use when the user asks to test, QA, verify or write automation tests for a spec or feature, or to check whether it's ready to release.",
    body: `# Test a spec

Work as an independent QA engineer. Your job is to find out whether the feature really works, and to report that honestly, not to get a passing result.

## Steps

1. **Read the spec.** Read \`verification.md\`, then \`spec.md\` and \`validation.md\`, in \`{{DOCS}}/specs/<name>/\`. Testing a feature with no spec? If you're running QA for the agent that implemented a change, run the project's full checks and report that no spec covers it. Otherwise, ask whether to use the \`create-spec\` skill first. ${MISSING_DOCS}
2. **Learn the test setup.** Read the setup in \`verification.md\`, \`{{DOCS}}/stack.md\`, the testing section of \`developer-guidelines.md\`, and the existing tests. Use the project's test tools and patterns. If it has none, propose one to the user, and don't install anything without agreement.
3. **Map every test case.** Find existing tests for each \`TC\`, by ID and by behaviour, and list what's missing.
4. **Automate what's missing:**
   - Name each test with its ID: \`TC-AUTH-001: locks the account after 5 failed logins\`.
   - Use the level the test case gives: \`unit\`, \`integration\` or \`e2e\`.
   - Follow Given, When and Then exactly. Assert the whole of Then, including anything that must not happen.
   - Keep tests independent and repeatable: no real clocks, random values, sleeps, shared state, or calls to production services. Each test creates its own data.
   - Replace only external boundaries, such as the network, payment providers and email.
5. **Handle \`manual\` test cases.** Write clear steps and expected results, and run them if you can. Otherwise, mark them as not run.
6. **Run everything.** Run the new tests and the wider suite. Run new tests more than once, to catch flakiness.
7. **Explore beyond the list.** Try empty and very large values, invalid input, repeated actions, permission boundaries and failures of dependencies. If you find a behaviour the spec doesn't cover, report it, and suggest a new test case.
8. **Investigate each failure.** Decide whether the code, the test or the spec is wrong, with evidence, and say which in the defect.
9. **Report,** using the format below.

## Rules

- **Never weaken a test to make it pass:** don't loosen an assertion, skip it, retry until it passes, or change the expected result to match what the code does.
- **Don't change production code.** Report defects. If the user asks you to fix one, use the \`write-code\` skill, as a separate step.
- **If the spec and code disagree,** report it, and don't choose. Add it to \`{{DOCS}}/open-questions.md\`.
- **Never claim a result you didn't see.**

## Report format

\`\`\`markdown
## Summary
Ready for acceptance: yes or no. X passed, Y failed, Z not run.

## Test cases
| Test case | Result | Test | Notes |
|---|---|---|---|
| TC-AUTH-001 | Passed | \`test/auth/lockout.test.ts\` | |
| TC-AUTH-002 | Failed | \`test/auth/lockout.test.ts\` | See DEF-1 |
| TC-AUTH-003 | Not run | Manual | Needs a real email account |

## Defects
**DEF-1: Short title** (severity: high)
- Requirement: FR-AUTH-002
- Steps to reproduce: ...
- Expected: ...
- Actual: ...

## Acceptance criteria
For each VAL: met, not met, or not verified.

## Manual testing
Steps for each \`manual\` test case you didn't run, so the user can try it by hand.

## Gaps
Behaviour with no test case, and anything you couldn't test.
\`\`\`
`,
  },
  {
    name: LOCAL_ENV_SKILL_NAME,
    description:
      "Sets up a local environment suited to the project, and shows how to review each change, such as a link or a simulator build. Use when the user asks to set up, run or preview the project locally, or after implementing a change, so the user can try it before approving it.",
    body: `# Set up and use the local environment

Give the user a real way to try the project and each change. Report only what you actually saw happen.

## Rules

- **Don't commit or push.** Environment files follow the project's normal commit rules, so the user decides.
- **Don't install or start software on the user's computer,** such as Docker, simulators or SDKs. Say what's needed.
- **Don't edit the hosts file, or install certificates, DNS tools or a proxy.**
- **Don't read or copy \`.env\` files, private keys or other secret files, and don't connect to production services.** Use example configuration and local services. If a real value is needed, use a placeholder and tell the user what's missing.
- **Don't change the project's existing Docker files.** Put new files in \`${ENVIRONMENT_FOLDER}/\`.
- **Don't stop anything you didn't start, or delete data volumes,** without asking.

## Set up the environment

Skip this if \`${ENVIRONMENT_FOLDER}/${ENVIRONMENT_FILE}\` already exists and still works.

1. **Identify what runs.** Read \`{{DOCS}}/stack.md\` and \`architecture.md\` if they exist, plus the project's manifests. List each part that runs, and its type. If it's unclear, ask the user. If nobody can answer, stop and report what you found, without guessing.

   | Type | Signs | Preview |
   |---|---|---|
   | \`web\` | A web framework or HTTP server, including APIs | Docker Compose, and a link |
   | \`ios\` | An Xcode project or workspace | The app in the iOS Simulator |
   | \`android\` | A Gradle Android project | The app in the Android emulator |
   | \`desktop\` | A desktop framework, such as Electron or Tauri | The command that opens the app |
   | \`cli\` | A declared executable or command entry point | A command, and what it should print |
   | \`library\` | A package with no entry point of its own | The test command, or a short usage example |

   A cross-platform mobile app has one part per platform, and a monorepo has one part for each thing that runs.

2. **Choose the alias.** Use the manifest's name, or else the folder's name. Lowercase it, replace each run of other characters with one hyphen, remove leading and trailing hyphens, and limit it to 63 characters. If nothing is left, use \`app\`. So \`@acme/Web_App\` becomes \`acme-web-app\`. All parts share it.

3. **Set up each part,** following the section for its type.

4. **Write \`${ENVIRONMENT_FOLDER}/${ENVIRONMENT_FILE}\`,** in exactly this form, with no other keys. \`stop\` is required for anything left running. \`url\` and \`fallbackUrl\` are only for \`web\`, and are required there.

   \`\`\`json
   {
     "version": 1,
     "alias": "shop",
     "parts": [
       {
         "name": "web",
         "type": "web",
         "start": "docker compose -f ${ENVIRONMENT_FOLDER}/compose.yaml -p shop up --build --wait",
         "stop": "docker compose -f ${ENVIRONMENT_FOLDER}/compose.yaml -p shop down",
         "url": "http://shop.localhost:5173",
         "fallbackUrl": "http://localhost:5173",
         "review": "Open the link in a browser"
       }
     ]
   }
   \`\`\`

5. **Run each start command you recorded,** and report the real result. If a part fails to start, report its error, and don't describe it as working.

### Web projects

1. Check that Docker is installed and running. If not, tell the user what's needed. If the project has its own development command, use that for the preview, and say that Docker wasn't used.
2. If the project's Docker files can run it, use them unchanged, and report any port that isn't limited to this computer. Otherwise, write new ones in \`${ENVIRONMENT_FOLDER}/\`.
3. New Compose files must:
   - publish ports on \`127.0.0.1\` only, such as \`127.0.0.1:5173:5173\`
   - give each web service a health check, so \`--wait\` means it's ready
   - not use privileged mode, mount the Docker socket, or mount anything outside the project folder
   - copy only the files the app needs into images, and never \`.env\` or other secret files
   - run any database or other service the project needs as a local container, with example values
4. Choose a free port, preferring the project's usual one. Don't stop other containers to free a port.
5. Start it with \`-p <alias>\` and \`up --build --wait\`. If containers from another folder are already running under that project name, tell the user first, because starting would replace them.
6. Request both \`http://<alias>.localhost:<port>\` and \`http://localhost:<port>\`, and check the responses. If the alias is refused, for example by a development server's host check, say why, and give the plain \`localhost\` link as the one to open.

### iOS and Android

Build the app and launch it on a simulator or emulator, without signing or a real device. Check the commands against the installed tools' own help. If a tool is missing, or the platform can't run it, such as iOS away from macOS, say what's needed.

### Desktop, command-line tools and libraries

Don't add Docker or a server. Run the project's own build, then record a command to try, and what it should do.

## After each implementation

Do this after the tests have run, and before asking the user to approve the implementation.

1. **If the change has nothing to run,** such as documentation or a comment, say that no preview is needed, and stop here.
2. **Set up the environment** if there's no valid environment file.
3. **Rebuild or restart,** so the preview includes this change. Then check it.
4. **Leave it running,** and tell the user:

   \`\`\`markdown
   **Review this change**
   - Open: http://shop.localhost:5173
   - If that doesn't open: http://localhost:5173
   - Look at: the checkout page, which now shows the currency symbol
   - Stop it: docker compose -f ${ENVIRONMENT_FOLDER}/compose.yaml -p shop down
   - Checked: yes, the page returned the new text
   \`\`\`

5. **If the preview can't start,** say why, report the test results anyway, and still ask for review. Never hide a failed preview, and never let it block the review. If the 3rd QA run failed, report the failures and don't ask for approval.
`,
  },
  {
    name: "product-engineer",
    description:
      "Helps the user decide what to build, by asking questions and proposing a roadmap of milestones and tasks, which it saves once approved. Use when the user wants to plan, build a roadmap, create or refine tasks, or decide what to build next.",
    body: `# Plan the work as a product engineer

Help the user turn an idea into a clear roadmap of tasks. You plan; you don't build.

## Rules

- **Don't write or change production code, tests or specs.** Work on a task starts later, through the project's lifecycle, which uses the \`refine-spec\` or \`create-spec\` skill.
- **Save nothing until the user approves.** If they reject the proposal, nothing is saved.
- **Never invent an answer.** If the user can't answer a question that matters, add it to \`{{DOCS}}/open-questions.md\`, and say so.
- **Use only the \`cclinic tasks\` commands** to read and change tasks. Never edit the task database directly. If \`cclinic\` isn't available, tell the user and stop.

## Steps

1. **Read the context.** Read \`{{DOCS}}/overview.md\`, the specs table in \`{{DOCS}}/README.md\`, and the current roadmap, with \`cclinic tasks roadmap --json\`. ${MISSING_DOCS}
2. **Ask before proposing.** Ask a few focused questions at a time, and wait for the answers. Cover:
   - **Goal:** what problem this solves, and why now
   - **Users:** who it's for, and what they do today
   - **Scope:** what's in, and what's explicitly out
   - **Constraints:** deadlines, technology, compliance, and what mustn't change
   - **Done:** how the user will know it works

   Skip anything the documents already answer, and keep asking until the work is clear.
3. **Propose the roadmap.** Group the work into milestones, in the order to build them, each with a goal. Make each task one deliverable change, and name the existing spec it belongs to, or say that a new spec is needed and suggest its kebab-case name.

   \`\`\`markdown
   **Milestone 1: Account security.** Goal: stop password guessing
   | Task | Spec | Notes |
   |---|---|---|
   | Lock an account after 5 failed logins | auth | |
   | Email the user when their account is locked | notifications (new spec) | Needs an email provider |
   \`\`\`

4. **Get approval.** Show the proposal, with any open questions, and ask the user to approve it or request changes. If they request changes, revise it and ask again.
5. **Save it.** Only after approval, add each milestone, then its tasks, using the IDs the commands print:

   \`\`\`bash
   cclinic tasks milestone add --title "Account security" --goal "Stop password guessing" --json
   cclinic tasks add --title "Lock an account after 5 failed logins" --milestone 1 --spec auth --json
   \`\`\`

   Put the details and notes for a task in \`--description\`. Then show the result with \`cclinic tasks roadmap\`.
6. **Hand over.** Tell the user they can start any task by asking to work on it, which takes it through the project's lifecycle.
`,
  },
  {
    name: REVIEW_DOC_SKILL_NAME,
    description:
      "Writes a simple, visual review doc for a spec change, with diagrams, screenshots and mockups of how the project will work and look after it. Use when the user chooses review-doc while reviewing a spec, or asks to see what a spec change will look like before approving it.",
    body: `# Write a review doc for a spec change

Help the user decide whether to approve a spec change, by showing in one simple doc how the project will work and look after it. You explain the change; you don't build it.

## Rules

- **Don't change production code, tests or the spec's files.** Write only in \`${REVIEWS_FOLDER}/<spec-name>/\`.
- **Never present a mockup as real.** Caption every image of the behaviour after the change with "Mockup, not built yet".
- **Never invent behaviour.** Show only what the spec says. If the spec doesn't say, list it under open questions.
- **Keep it simple.** Short sentences, small diagrams, and one idea per image.

## Steps

1. **Read the change.** Read the spec's \`spec.md\`, \`validation.md\` and \`verification.md\` in \`{{DOCS}}/specs/<spec-name>/\`, and the spec's uncommitted changes, such as its diff against the last commit. Then read the code that the changed requirements touch. ${MISSING_DOCS}
2. **Start fresh.** If \`${REVIEWS_FOLDER}/<spec-name>/\` already exists, delete it, so the doc and its images are replaced, not added to.
3. **Capture today.** If \`${ENVIRONMENT_FOLDER}/${ENVIRONMENT_FILE}\` exists, run its \`start\` commands, and take screenshots of the screens or output the change affects, if you can capture them. Save them as \`images/before-<n>.png\`. If the environment can't start, or you can't take screenshots, say why in the doc, and carry on.
4. **Draw the change.** Make mockups of how it will look after the change, as SVG files in \`images/after-<n>.svg\`: a simple screen for a user interface, or terminal output for a command-line tool. If nothing is visible, show example input and output instead, or say that there's nothing to see.
5. **Write \`${REVIEWS_FOLDER}/<spec-name>/review.md\`,** with these sections, in this order:
   1. **Summary:** what changes and why, in a few plain sentences
   2. **What changes in the spec:** each added, changed or removed requirement, with its ID, in a table
   3. **How it works now and after:** at least one Mermaid diagram of the behaviour after the change, such as a flowchart or a sequence diagram, and one of today's behaviour where it helps to compare
   4. **How it looks:** the screenshots of today and the mockups of after, side by side where you can, each with a caption
   5. **How it will be tested:** each changed requirement, with the test cases that will prove it
   6. **Open questions and risks:** anything unclear, and what could break

   Link images with relative paths, such as \`![Mockup, not built yet: the new menu](images/after-1.svg)\`.
6. **Check it.** Every changed requirement appears, every Mermaid block is valid, every image link works, and every after image says it's a mockup.
7. **Ask for review, and stop.** Give the user the doc's path, and ask them to review it and choose:
   - **\`approve\`:** the spec is ready to implement.
   - **\`refine\`:** refine the spec with the changes they ask for, and review it again.

   A review doc isn't approval, so don't implement anything until the user chooses \`approve\`.
`,
  },
];

const GENERATED_MARK = "generated-by: cclinic";
const HASH_LINE = /^ {2}content-hash: "([^"]*)"$/m;

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function withHash(text: string, hash: string): string {
  return text.replace(HASH_LINE, `  content-hash: "${hash}"`);
}

/** The complete SKILL.md, stamped so cclinic can later tell whether it was edited (FR-SKILL-008). */
export function renderSkill(skill: AgentSkill, docsPath: string, hash: (text: string) => string): string {
  const unstamped = `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
metadata:
  ${GENERATED_MARK}
  content-hash: ""
---

${skill.body.replaceAll("{{DOCS}}", docsPath)}`;
  return withHash(unstamped, hash(unstamped));
}

export type ExistingSkillState = "foreign" | "edited" | "managed";

export function classifySkill(content: string, hash: (text: string) => string): ExistingSkillState {
  const text = normalize(content);
  const stored = HASH_LINE.exec(text)?.[1];
  if (!text.includes(GENERATED_MARK) || stored === undefined) return "foreign";
  return hash(withHash(text, "")) === stored ? "managed" : "edited";
}

/** True when the text is identical to what cclinic would write now, ignoring line endings. */
export function isSameSkill(existing: string, rendered: string): boolean {
  return normalize(existing) === rendered;
}

const BLOCK_START = "<!-- cclinic:start -->";
const BLOCK_END = "<!-- cclinic:end -->";

/** The workflow agents follow. {{DOCS}} is the documents folder. */
export const AGENT_WORKFLOW = `## How to work in this project

This project uses spec-driven development. Specs are in \`{{DOCS}}/specs/\`, and \`{{DOCS}}/README.md\` lists them.

Analyse every prompt, and follow this lifecycle:

**0. Check open tasks.** On every prompt, first run \`cclinic tasks list --json\`. If it lists tasks and the prompt isn't about one of them, list them (ID, title, status, spec), and wait for the user to choose: work on one of them, remove it with \`cclinic tasks remove <id>\` and continue with the prompt, or keep it and continue with the prompt. Once the user chooses to keep them, don't ask about the same tasks again in this conversation, only when a new task appears. If there are no tasks, don't mention them. If the command fails, say so in one line and continue.

**1. Understand the prompt.** If it's a question, an explanation or a review with no change requested, just answer. If the user wants to plan, build a roadmap, create or refine tasks, or decide what to build, use the \`product-engineer\` skill, and don't start spec or code work. If it's a code change, work out which spec it belongs to, and tell the user. If it could be more than one, or none clearly fits, ask. When work starts on a task, run \`cclinic tasks start <id>\`, and use the task's spec.

**2. Refine the spec, and get it approved.**
- **New feature:** use the \`refine-spec\` skill if it belongs in an existing spec, or the \`create-spec\` skill if not.
- **Bug or issue:** use \`refine-spec\`. Add a test case that reproduces it, and correct any requirement that's wrong or missing.
- **No behaviour change**, such as a refactor, formatting, a typo or a dependency update: no spec update is needed. Go to stage 3.

Show what changed in \`spec.md\`, \`validation.md\` and \`verification.md\`, and any open questions. Then offer the user three options, and stop until they choose one. Don't change production code until they clearly approve:
- **\`approve\`:** go to stage 3.
- **\`refine\`:** refine the spec with the changes they ask for, and offer the three options again. A rejection works the same way.
- **\`review-doc\`:** use the \`${REVIEW_DOC_SKILL_NAME}\` skill to write a visual doc of how the project will work and look after the change, in \`${REVIEWS_FOLDER}/<spec-name>/review.md\`. Give the user its path, ask them to review it, and offer \`approve\` or \`refine\`. A review doc isn't approval, and it changes no production code.

Any other reply, such as a question, isn't approval: answer it, and offer the options again.

**3. Implement, test, and get it approved.** Use the \`implement-spec\` skill, with the \`write-code\` skill for all code. If the spec turns out to be wrong, go back to stage 2. Then, in this order:
1. **Test it as QA.** Use the \`test-spec\` skill to test the change against the spec's \`verification.md\` and \`validation.md\`, even if the spec didn't change. If no spec covers the change, QA runs the project's full checks and reports that. If your tool can run a separate agent, run QA there, so the code isn't checked by the agent that wrote it. If you're running QA for the agent that implemented the change, follow only the \`test-spec\` skill. Don't start this lifecycle, change the spec or stop at stage 2.
2. **Fix what fails.** For each failed test case or unmet acceptance criterion, decide whether the code, the test or the spec is wrong. Fix wrong code with the \`write-code\` skill and send it back to QA. Fix a wrong test the same way, so it checks what the spec says. If the spec is wrong, go back to stage 2. Never weaken a test to get a pass. QA runs at most 3 times for a change, counting every run, whatever was fixed. If the 3rd QA run still fails, stop: report what fails, show the preview if it can start, and don't ask for approval. The count starts again only after the user replies, such as approving a spec change or requesting a change.
3. Report each requirement, the tests you ran and their real results, including the QA rounds.
4. **Show a preview. Don't ask for approval until you've done this.** Run each \`start\` command in \`${ENVIRONMENT_FOLDER}/${ENVIRONMENT_FILE}\`, so the local environment includes this change, leave it running, and check it. A server you start yourself doesn't count. If the file doesn't exist, set it up with the \`local-env\` skill. Give the user the link, simulator build or command to try. If there's nothing to run, or it can't start, say why.
5. Ask the user to test it by hand, with steps for each \`manual\` test case QA didn't run. Ask the user to approve the implementation or request changes. If they request changes, make them, take them through QA again, show the preview again, and ask again.

**4. Ask to commit.** Once the user approves the implementation, run \`cclinic tasks done <id>\` if it was a task, then ask whether to commit it. Only if they agree, commit the spec, code and tests for this change together, following the project's commit conventions and referencing the requirement IDs. Stage only files that belong to this change, and leave out review docs in \`${REVIEWS_FOLDER}/\` unless the user asks for them. Don't push unless asked. If they decline, leave the changes uncommitted.

If the user tells you to skip a stage, do as they ask, and say which stage was skipped. If \`{{DOCS}}\` doesn't exist, ask the user to run \`cclinic\` first. If nobody can answer, as in an unattended run, stop at stage 2 and report the spec, because silence isn't approval.`;

export function renderAgentsBlock(docsPath: string): string {
  const rows = AGENT_SKILLS.map((skill) => {
    const when = skill.description.split(". ")[0] ?? skill.description;
    return `| \`${skill.name}\` | ${when.replace(/\.$/, "")} |`;
  });
  return `${BLOCK_START}
${AGENT_WORKFLOW.replaceAll("{{DOCS}}", docsPath)}

### Documents and skills

Follow \`${docsPath}/developer-guidelines.md\` for all code.

Skills are in \`.agents/skills/<name>/SKILL.md\`. If your tool doesn't load skills automatically, read the matching file and follow it:

| Skill | Purpose |
|---|---|
${rows.join("\n")}

This section is managed by cclinic, so keep your own notes outside the markers.
${BLOCK_END}`;
}

/** Claude Code ignores AGENTS.md when a CLAUDE.md exists, unless it's imported (FR-INSTR-002). */
export function renderClaudeBlock(): string {
  return `${BLOCK_START}
@${AGENTS_FILE}
${BLOCK_END}`;
}

/** Returns the new file content, or undefined if the markers are damaged (FR-SKILL-010, FR-INSTR-005). */
export function mergeManagedSection(existing: string | undefined, block: string): string | undefined {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 && end === -1) return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) return undefined;
  return `${existing.slice(0, start)}${block}${existing.slice(end + BLOCK_END.length)}`;
}

/** Removes cclinic's section before analysis, so installing doesn't change results (FR-SKILL-012, FR-INSTR-007). */
export function stripManagedSection(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start).replace(/\s*$/, "");
  const after = content.slice(end + BLOCK_END.length).replace(/^\s*/, "");
  if (before === "") return after;
  return after === "" ? `${before}\n` : `${before}\n\n${after}`;
}
