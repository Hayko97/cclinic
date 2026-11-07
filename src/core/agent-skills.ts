/**
 * The skills cclinic installs for a project's coding agent (spec: agent-skills).
 * They're generic and read the project's own documents, so they fit any stack and need no Claude call.
 * {{DOCS}} is replaced with the documents folder, relative to the project root.
 */

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
7. **Check your work** using the checklist below, then summarise the spec and any open questions for the user.

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
7. **Report** what changed and why, what you asked, and what's still open.

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
3. **Follow the \`write-code\` skill** for all code. If your agent can't load it, read \`.agents/skills/write-code/SKILL.md\`.
4. **Plan briefly.** List the requirements in a sensible build order, and what each one touches. For a large spec, share the plan with the user before starting.
5. **Build one requirement at a time:**
   1. Write its tests from the \`TC\`s that cover it, naming each test with its ID, such as \`TC-AUTH-001: locks the account after 5 failed logins\`.
   2. Confirm that they fail for the right reason, where that's practical.
   3. Write the smallest code that meets the requirement.
   4. Run the tests, then the wider suite for what you touched.
6. **Stay in scope.** Build only what the spec says. If the spec is wrong or incomplete, stop and tell the user, or use the \`refine-spec\` skill with their agreement. Don't quietly build something different.
7. **Verify everything.** Run the project's full checks. Then read each \`VAL\`, and judge whether the result would really meet it.
8. **Update the spec.** Set each finished requirement's status to \`confirmed\`, and update its evidence to point to the code. Only do this for requirements that work.
9. **Report,** using the format below.

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
- Don't commit or push unless the user asks.
`,
  },
  {
    name: "test-spec",
    description:
      "Acts as QA for a spec or feature: automates its test cases, runs them, explores edge cases, and reports results and defects. Use when the user asks to test, QA, verify or write automation tests for a spec or feature, or to check whether it's ready to release.",
    body: `# Test a spec

Work as an independent QA engineer. Your job is to find out whether the feature really works, and to report that honestly, not to get a passing result.

## Steps

1. **Read the spec.** Read \`verification.md\`, then \`spec.md\` and \`validation.md\`, in \`{{DOCS}}/specs/<name>/\`. Testing a feature with no spec? Ask whether to use the \`create-spec\` skill first. ${MISSING_DOCS}
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
8. **Investigate each failure.** Decide whether the code, the test or the spec is wrong, with evidence.
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

## Gaps
Behaviour with no test case, and anything you couldn't test.
\`\`\`
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

export function renderAgentsBlock(docsPath: string): string {
  const rows = AGENT_SKILLS.map((skill) => {
    const when = skill.description.split(". ")[0] ?? skill.description;
    return `| \`${skill.name}\` | ${when.replace(/\.$/, "")} |`;
  });
  return `${BLOCK_START}
## Project documents and skills

This project uses spec-driven development. Project documents are in \`${docsPath}\`. Start with \`${docsPath}/README.md\`, and follow \`${docsPath}/developer-guidelines.md\` for all code.

Skills are in \`.agents/skills/<name>/SKILL.md\`. If your tool doesn't load skills automatically, read the matching file and follow it:

| Skill | Purpose |
|---|---|
${rows.join("\n")}

This section is managed by cclinic, so keep your own notes outside the markers.
${BLOCK_END}`;
}

/** Returns the new file content, or undefined if the markers are damaged (FR-SKILL-010). */
export function mergeAgentsFile(existing: string | undefined, block: string): string | undefined {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 && end === -1) return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) return undefined;
  return `${existing.slice(0, start)}${block}${existing.slice(end + BLOCK_END.length)}`;
}

/** Removes cclinic's section before analysis, so installing skills doesn't change results (FR-SKILL-012). */
export function stripAgentsBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start).replace(/\s*$/, "");
  const after = content.slice(end + BLOCK_END.length).replace(/^\s*/, "");
  if (before === "") return after;
  return after === "" ? `${before}\n` : `${before}\n\n${after}`;
}
