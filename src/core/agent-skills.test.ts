import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS,
  AGENT_WORKFLOW,
  classifySkill,
  isSameSkill,
  mergeManagedSection,
  renderAgentsBlock,
  renderClaudeBlock,
  renderSkill,
  stripManagedSection,
  type AgentSkill,
} from "./agent-skills.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const skill = (name: string): AgentSkill => {
  const found = AGENT_SKILLS.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No skill named ${name}`);
  return found;
};
const render = (name: string): string => renderSkill(skill(name), ".cclinic/sdd", hash);
const CLAUDE_CODE_STEP = /4\. \*\*Run Claude Code's review[^\n]*\n/;

describe("skill format", () => {
  it("TC-SKILL-040: provides the nine skills", () => {
    expect(AGENT_SKILLS.map((item) => item.name)).toEqual([
      "create-spec",
      "refine-spec",
      "write-code",
      "implement-spec",
      "test-spec",
      "local-env",
      "product-engineer",
      "review-doc",
      "review-code",
    ]);
  });

  it.each(AGENT_SKILLS.map((item) => item.name))("TC-SKILL-002: %s follows the Agent Skills format", (name) => {
    const file = render(name);
    const frontmatter = /^---\nname: (.+)\ndescription: (.+)\nmetadata:\n/.exec(file);
    expect(frontmatter?.[1]).toBe(name);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    const description = JSON.parse(frontmatter?.[2] ?? "") as string;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use (when|whenever)/);
    expect(file.split("\n").length).toBeLessThan(500);
    expect(file).not.toContain("{{DOCS}}");
  });
});

describe("protecting existing work", () => {
  it("TC-SKILL-013: rendered skills are marked, and classify as managed", () => {
    const file = render("write-code");
    expect(file).toContain("generated-by: cclinic");
    expect(file).toMatch(/content-hash: "[0-9a-f]{64}"/);
    expect(classifySkill(file, hash)).toBe("managed");
  });

  it("TC-SKILL-014: an edit is detected, and other people's skills are foreign", () => {
    expect(classifySkill(`${render("write-code")}\nMy addition.\n`, hash)).toBe("edited");
    expect(classifySkill("---\nname: write-code\ndescription: Mine\n---\nBody\n", hash)).toBe("foreign");
  });

  it("TC-SKILL-017: Windows line endings don't count as an edit", () => {
    const windows = render("write-code").replace(/\n/g, "\r\n");
    expect(classifySkill(windows, hash)).toBe("managed");
    expect(isSameSkill(windows, render("write-code"))).toBe(true);
  });

  it("TC-SKILL-018: only the marked section changes", () => {
    const original = `# Mine\n\n${renderAgentsBlock("old/path")}\n\nMore of mine.\n`;
    const merged = mergeManagedSection(original, renderAgentsBlock("new/path")) ?? "";
    expect(merged.startsWith("# Mine\n\n")).toBe(true);
    expect(merged.endsWith("\n\nMore of mine.\n")).toBe(true);
    expect(merged).toContain("new/path");
    expect(merged).not.toContain("old/path");
  });

  it("creates the section when the file is missing or blank, and refuses damaged markers", () => {
    const block = renderAgentsBlock("docs");
    expect(mergeManagedSection(undefined, block)).toBe(`${block}\n`);
    expect(mergeManagedSection("  \n", block)).toBe(`${block}\n`);
    expect(mergeManagedSection("<!-- cclinic:start -->\nno end", block)).toBeUndefined();
    expect(mergeManagedSection("no start\n<!-- cclinic:end -->", block)).toBeUndefined();
    expect(mergeManagedSection("<!-- cclinic:end --> <!-- cclinic:start -->", block)).toBeUndefined();
  });

  it("TC-SKILL-022: stripping leaves only the user's text", () => {
    const block = renderAgentsBlock("docs");
    expect(stripManagedSection(`# Mine\n\n${block}\n`)).toBe("# Mine\n");
    expect(stripManagedSection(`${block}\n`)).toBe("");
    expect(stripManagedSection(`# Mine\n\n${block}\n\nEnd\n`)).toBe("# Mine\n\nEnd\n");
    expect(stripManagedSection("# Only mine\n")).toBe("# Only mine\n");
    expect(stripManagedSection(mergeManagedSection("# Mine\n", block) ?? "")).toBe("# Mine\n");
  });

  it("TC-SKILL-004: the section lists every skill and the documents folder", () => {
    const block = renderAgentsBlock("docs/sdd");
    for (const { name } of AGENT_SKILLS) expect(block).toContain(`\`${name}\``);
    expect(block).toContain("docs/sdd/README.md");
    expect(block).toContain(".agents/skills/");
  });
});

describe("skill content", () => {
  it.each(AGENT_SKILLS.map((item) => item.name))("TC-SKILL-024: %s names no specific agent or stack", (name) => {
    const body = skill(name).body.replace(CLAUDE_CODE_STEP, "");
    for (const word of [
      "Claude",
      "Codex",
      "Cursor",
      "Copilot",
      "Gemini",
      "npm ",
      "TypeScript",
      "Python",
      "pytest",
      "Jest",
      "vitest",
    ]) {
      expect(body).not.toContain(word);
    }
    expect(render(name)).toContain(".cclinic/sdd");
  });

  it("TC-SKILL-009: the documents folder follows --out", () => {
    const file = renderSkill(skill("implement-spec"), "docs/sdd", hash);
    expect(file).toContain("docs/sdd/specs/");
    expect(file).not.toContain(".cclinic/sdd");
  });

  it.each(["create-spec", "refine-spec"])("TC-SKILL-025: %s requires the spec format", (name) => {
    const body = skill(name).body;
    for (const text of [
      "spec.md",
      "validation.md",
      "verification.md",
      "permanent",
      "at least one `VAL` and one `TC`",
      "**Evidence:**",
      "**Status:**",
      "open-questions.md",
      "cclinic --force",
    ]) {
      expect(body).toContain(text);
    }
  });

  it("TC-SKILL-026: write-code requires reading first, and covers each sign", () => {
    const body = skill("write-code").body;
    for (const text of [
      "stack.md",
      "architecture.md",
      "developer-guidelines.md",
      "Read the code nearby",
      "Search before creating",
      "Comments restating the code",
      "Unused helpers",
      "can't happen",
      "Unrequested features",
      "Keep the change small",
    ]) {
      expect(body).toContain(text);
    }
    expect(body).toContain("Never hide or remove attribution");
    expect(body.toLowerCase()).not.toMatch(/hide (that|the fact)|avoid detection|undetect/);
  });

  it("TC-SKILL-027: implement-spec covers order, blockers, tests, commands and honesty", () => {
    const body = skill("implement-spec").body;
    for (const text of [
      "one requirement at a time",
      "stop and ask the user",
      "`TC`s",
      "full checks",
      "Never say something passes unless you ran it",
      "Never skip, delete or weaken a test",
      "write-code",
    ]) {
      expect(body).toContain(text);
    }
  });

  it("TC-SKILL-028: test-spec covers naming, manual steps, defects and integrity", () => {
    const body = skill("test-spec").body;
    for (const text of [
      "Name each test with its ID",
      "`manual`",
      "Steps to reproduce",
      "Never weaken a test",
      "Don't change production code",
      "Never claim a result you didn't see",
      "Not run",
    ]) {
      expect(body).toContain(text);
    }
  });
});

describe("agent workflow", () => {
  const workflow = AGENT_WORKFLOW;

  it("TC-INSTR-006: the section stays under 200 lines", () => {
    expect(renderAgentsBlock("docs").split("\n").length).toBeLessThan(200);
  });

  it("TC-INSTR-015: every rule is stated", () => {
    for (const text of [
      "If it's a question, an explanation or a review with no change requested, just answer",
      "work out which spec it belongs to, and tell the user",
      "`refine-spec`",
      "`create-spec`",
      "Add a test case that reproduces it",
      "offer the user three options, and stop until they choose one",
      "Don't change production code until they clearly approve",
      "`implement-spec`",
      "`write-code`",
      "go back to stage 2",
      "real results",
      "No behaviour change",
      "say which stage was skipped",
      "run `cclinic` first",
      "stop at stage 2",
      "ask whether to commit",
      "Only if they agree",
      "spec, code and tests for this change together",
      "referencing the requirement IDs",
      "Stage only files that belong to this change",
      "Don't push unless asked",
      "leave the changes uncommitted",
    ]) {
      expect(workflow).toContain(text);
    }
  });

  it.each(["create-spec", "refine-spec"])("TC-INSTR-016: %s asks for review and doesn't implement", (name) => {
    const body = skill(name).body;
    expect(body).toContain("Ask for review, and stop");
    expect(body).toContain("offer the user three options, and stop until they choose one");
    expect(body).toContain("Don't implement it in this skill");
  });

  it("TC-INSTR-016: implement-spec checks approval, asks for review, then asks to commit", () => {
    const body = skill("implement-spec").body;
    const order = ["Check that it's approved", "Report and ask for review", "Ask to commit"].map((text) =>
      body.indexOf(text),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(body).toContain("Never push unless the user asks");
    expect(body).toContain(
      "State any test that failed or wasn't run, and any `blocking` or `should-fix` finding still open, before asking",
    );
    expect(body).not.toContain("Don't commit or push unless");
  });

  it("TC-INSTR-029: stage 3 runs QA and fixes failures before the preview and manual testing", () => {
    const stage3 = workflow.slice(workflow.indexOf("**3. Implement"), workflow.indexOf("**4. Ask"));
    const order = [
      "`implement-spec`",
      "`test-spec`",
      "`write-code` skill and send it back to QA",
      "go back to stage 2. Never weaken",
      "If the 3rd QA run still fails",
      "show the preview if it can start, and don't ask for approval",
      "Show a preview",
      "test it by hand",
      "Ask the user to approve",
    ].map((text) => stage3.indexOf(text));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    for (const text of [
      "`verification.md` and `validation.md`, even if the spec didn't change",
      "separate agent",
      "Never weaken a test",
      "`manual` test case",
      "through QA and the review again, show the preview again, and ask again",
    ]) {
      expect(stage3).toContain(text);
    }
  });

  it("TC-INSTR-036: a QA run started by the implementing agent only follows test-spec", () => {
    expect(workflow).toContain(
      "If you're running QA for the agent that implemented the change, follow only the `test-spec` skill. Don't start this lifecycle, change the spec or stop at stage 2.",
    );
  });

  it("TC-INSTR-038, TC-INSTR-039: wrong tests get fixed, and every QA run counts toward the limit", () => {
    const step = workflow.slice(workflow.indexOf("**Fix what fails.**"), workflow.indexOf("3. **Review the code.**"));
    for (const text of [
      "Fix a wrong test the same way, so it checks what the spec says",
      "Never weaken a test",
      "QA runs at most 3 times for a change, counting every run, whatever was fixed",
      "The count starts again only after the user replies",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-INSTR-040: a change no spec covers gets the project's full checks", () => {
    const step = workflow.slice(workflow.indexOf("**Test it as QA.**"), workflow.indexOf("**Fix what fails.**"));
    expect(step).toContain("If no spec covers the change, QA runs the project's full checks and reports that");
  });

  it("TC-SKILL-034: implement-spec fixes wrong tests and caps QA runs per change", () => {
    const body = skill("implement-spec").body;
    const step = body.slice(body.indexOf("Hand it to QA"), body.indexOf("Update the spec"));
    for (const text of [
      "a wrong test so it checks what the spec says",
      "QA runs at most 3 times for a change, counting every run",
      "the count starts again only after the user replies",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-SKILL-035: test-spec runs the full checks when no spec covers the change", () => {
    const body = skill("test-spec").body;
    const step = body.slice(body.indexOf("1. **Read the spec.**"), body.indexOf("2. **Learn the test setup.**"));
    const fullChecks = step.indexOf("run the project's full checks and report that no spec covers it");
    expect(fullChecks).toBeGreaterThan(step.indexOf("running QA for the agent that implemented"));
    expect(step.indexOf("Otherwise, ask whether to use the `create-spec` skill")).toBeGreaterThan(fullChecks);
  });

  it("TC-SKILL-032: implement-spec hands the change to QA and fixes defects before review", () => {
    const body = skill("implement-spec").body;
    const order = ["Verify everything", "Hand it to QA", "Show how to review it"].map((text) => body.indexOf(text));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    const step = body.slice(order[1], body.indexOf("Update the spec"));
    for (const text of [
      "`test-spec`",
      "separate agent",
      "`write-code`",
      "run QA again",
      "spec is wrong",
      "If the 3rd QA run still fails",
      "instead of asking for approval",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-SKILL-033: test-spec classifies failures and lists manual steps for the user", () => {
    const body = skill("test-spec").body;
    expect(body).toContain("code, the test or the spec");
    expect(body).toContain("Steps for each `manual` test case you didn't run");
  });

  it("the import sits outside any code span, so Claude Code reads it", () => {
    expect(renderClaudeBlock().split("\n")).toContain("@AGENTS.md");
  });
});

describe("product engineer and tasks", () => {
  const planner = render("product-engineer");
  const position = (text: string): number => {
    const found = planner.indexOf(text);
    expect(found, text).toBeGreaterThan(-1);
    return found;
  };

  it("TC-SKILL-036: reads the context and asks before proposing", () => {
    for (const text of [".cclinic/sdd/overview.md", ".cclinic/sdd/README.md", "`cclinic tasks roadmap --json`"]) {
      expect(position(text)).toBeLessThan(position("**Ask before proposing.**"));
    }
    for (const text of ["**Goal:**", "**Users:**", "**Scope:**", "**Constraints:**", "**Done:**"]) {
      expect(position(text)).toBeLessThan(position("**Propose the roadmap.**"));
    }
    expect(planner).toContain("add it to `.cclinic/sdd/open-questions.md`");
  });

  it("TC-SKILL-037: each task names its spec, and saving waits for approval", () => {
    expect(planner).toContain("name the existing spec it belongs to, or say that a new spec is needed");
    expect(planner).toContain("Save nothing until the user approves");
    expect(position("**Get approval.**")).toBeLessThan(position("**Save it.** Only after approval"));
    expect(position("**Save it.**")).toBeLessThan(position("cclinic tasks milestone add"));
    expect(planner).toContain("cclinic tasks add --title");
  });

  it("TC-SKILL-038: plans without changing code, tests or specs", () => {
    expect(planner).toContain("Don't write or change production code, tests or specs");
    expect(planner).toContain("`refine-spec` or `create-spec`");
  });

  it("TC-INSTR-043: every prompt checks open tasks first, and offers work, remove or keep", () => {
    const step = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**0."), AGENT_WORKFLOW.indexOf("**1."));
    expect(AGENT_WORKFLOW.indexOf("**0. Check open tasks.**")).toBeGreaterThan(-1);
    for (const text of [
      "On every prompt, first run `cclinic tasks list --json`",
      "the prompt isn't about one of them",
      "wait for the user to choose",
      "work on one of them",
      "remove it with `cclinic tasks remove <id>` and continue with the prompt",
      "keep it and continue with the prompt",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-INSTR-044: kept tasks aren't raised again, and a failed check doesn't block", () => {
    expect(AGENT_WORKFLOW).toContain(
      "don't ask about the same tasks again in this conversation, only when a new task appears",
    );
    expect(AGENT_WORKFLOW).toContain("If the command fails, say so in one line and continue");
  });

  it("TC-INSTR-045: planning prompts go to product-engineer", () => {
    const stage = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**1."), AGENT_WORKFLOW.indexOf("**2."));
    expect(stage).toContain(
      "If the user wants to plan, build a roadmap, create or refine tasks, or decide what to build, use the `product-engineer` skill",
    );
  });

  it("TC-INSTR-046: tasks are started with the work, and done after approval", () => {
    expect(AGENT_WORKFLOW).toContain("When work starts on a task, run `cclinic tasks start <id>`");
    const stage = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**4."));
    expect(stage).toContain("Once the user approves the implementation, run `cclinic tasks done <id>`");
  });

  it("TC-INSTR-047: the section with the task steps stays under 200 lines", () => {
    expect(renderAgentsBlock(".cclinic/sdd").split("\n").length).toBeLessThan(200);
    expect(renderAgentsBlock(".cclinic/sdd")).toContain("| `product-engineer` |");
  });
});

describe("review doc", () => {
  const reviewer = render("review-doc");
  const stage = (from: string, to?: string): string =>
    AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf(from), to === undefined ? undefined : AGENT_WORKFLOW.indexOf(to));
  const at = (text: string): number => {
    const found = reviewer.indexOf(text);
    expect(found, text).toBeGreaterThan(-1);
    return found;
  };

  it("TC-INSTR-050: stage 2 ends with approve, refine or review-doc, and waits", () => {
    const review = stage("**2.", "**3.");
    expect(review).toContain("offer the user three options, and stop until they choose one");
    expect(review.match(/^- \*\*`[a-z-]+`:\*\*/gm)).toEqual([
      "- **`approve`:**",
      "- **`refine`:**",
      "- **`review-doc`:**",
    ]);
    expect(review).toContain("- **`approve`:** go to stage 3.");
    expect(review).toContain(
      "- **`refine`:** refine the spec with the changes they ask for, and offer the three options again.",
    );
    expect(review).toContain("Don't change production code until they clearly approve");
    expect(review).toContain("Any other reply, such as a question, isn't approval");
  });

  it("TC-INSTR-051: review-doc uses its skill, gives the path, and then asks to approve or refine", () => {
    const review = stage("**2.", "**3.");
    for (const text of [
      "use the `review-doc` skill",
      "`.cclinic/reviews/<spec-name>/review.md`",
      "Give the user its path, ask them to review it, and offer `approve` or `refine`",
      "A review doc isn't approval, and it changes no production code",
    ]) {
      expect(review).toContain(text);
    }
  });

  it("TC-INSTR-052: commits leave out review docs unless asked", () => {
    expect(stage("**4.")).toContain("leave out review docs in `.cclinic/reviews/` unless the user asks for them");
  });

  it("TC-INSTR-053: the section with the stage 2 options stays under 200 lines", () => {
    const block = renderAgentsBlock(".cclinic/sdd");
    expect(block.split("\n").length).toBeLessThan(200);
    expect(block).toContain("| `review-doc` |");
  });

  it("TC-SKILL-041: reads the change and writes one doc per spec, replacing the old one", () => {
    for (const text of [
      "`spec.md`, `validation.md` and `verification.md` in `.cclinic/sdd/specs/<spec-name>/`",
      "the spec's uncommitted changes",
      "read the code that the changed requirements touch",
      "If `.cclinic/reviews/<spec-name>/` already exists, delete it",
      "`.cclinic/reviews/<spec-name>/review.md`",
      "`images/after-<n>.svg`",
    ]) {
      expect(reviewer).toContain(text);
    }
  });

  it("TC-SKILL-042: the doc has the six sections, in order, with a Mermaid diagram", () => {
    const sections = [
      "**Summary:**",
      "**What changes in the spec:** each added, changed or removed requirement, with its ID",
      "**How it works now and after:** at least one Mermaid diagram of the behaviour after the change",
      "**How it looks:**",
      "**How it will be tested:** each changed requirement, with the test cases",
      "**Open questions and risks:**",
    ].map(at);
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
  });

  it("TC-SKILL-043: real screenshots of today, or why not, and labelled mockups of after", () => {
    expect(reviewer).toContain("run its `start` commands, and take screenshots");
    expect(reviewer).toContain("`.cclinic/environment/environment.json`");
    expect(reviewer).toContain("If the environment can't start, or you can't take screenshots, say why in the doc");
    expect(reviewer).toContain('Caption every image of the behaviour after the change with "Mockup, not built yet"');
    expect(reviewer).toContain("every after image says it's a mockup");
  });

  it("TC-SKILL-044: changes nothing else, and ends by asking to approve or refine", () => {
    expect(reviewer).toContain("Don't change production code, tests or the spec's files");
    const last = reviewer.slice(at("**Ask for review, and stop.**"));
    expect(last).toContain("Give the user the doc's path, and ask them to review it and choose");
    expect(last).toContain("- **`approve`:**");
    expect(last).toContain("- **`refine`:**");
    expect(last).not.toContain("- **`review-doc`:**");
    expect(last).toContain("A review doc isn't approval");
  });

  it.each(["create-spec", "refine-spec"])("TC-SKILL-045: %s offers approve, refine and review-doc", (name) => {
    const step = skill(name).body.slice(skill(name).body.indexOf("**Ask for review, and stop.**"));
    for (const text of ["- **`approve`:**", "- **`refine`:**", "- **`review-doc`:** use the `review-doc` skill"]) {
      expect(step).toContain(text);
    }
  });
});

describe("code review", () => {
  const reviewer = render("review-code");
  const stage3 = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**3. Implement"), AGENT_WORKFLOW.indexOf("**4. Ask"));
  const reviewStep = stage3.slice(stage3.indexOf("**Review the code.**"), stage3.indexOf("4. Report each requirement"));
  const at = (text: string, within = reviewer): number => {
    const found = within.indexOf(text);
    expect(found, text).toBeGreaterThan(-1);
    return found;
  };

  it("TC-CREV-002: the skill is review-code, so Claude Code's own code-review isn't hidden", () => {
    const names = AGENT_SKILLS.map((item) => item.name);
    expect(names).toContain("review-code");
    expect(names).not.toContain("code-review");
  });

  it("TC-CREV-004: only the optional Claude Code step names Claude Code", () => {
    expect(reviewer).toMatch(CLAUDE_CODE_STEP);
    const outside = reviewer.replace(CLAUDE_CODE_STEP, "");
    expect(outside).not.toContain("Claude Code");
    expect(outside).not.toMatch(/\b(Codex|Cursor|Copilot|Gemini)\b/);
  });

  it("TC-CREV-005: rule sources are the project's, then the guidelines, then the checklist", () => {
    const order = [
      "**The project's own rules:**",
      "`.cclinic/sdd/developer-guidelines.md`",
      "**The checklist below.**",
    ].map((text) => at(text));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    at("When two conflict, the earlier one wins");
    at("Cite the rule for every finding");
    expect(renderSkill(skill("review-code"), "docs/specs-home", hash)).toContain(
      "`docs/specs-home/developer-guidelines.md`",
    );
  });

  it("TC-CREV-006: the checklist covers the agreed areas", () => {
    const checklist = reviewer.slice(at("## Checklist"), at("## Severity"));
    for (const area of [
      "Correctness",
      "Design",
      "SOLID",
      "KISS and YAGNI",
      "DRY",
      "No hardcoded values",
      "constants",
      "Naming",
      "Errors",
      "Security",
      "Tests",
      "Comments and dead code",
      "Docs",
    ]) {
      expect(checklist).toContain(area);
    }
  });

  it("TC-CREV-007: reviews only the changed files, and lists the rest as follow-ups", () => {
    at(
      "Review the files the change touched, as the implementing agent names them, or every uncommitted file if none are named: their diff, including new files, spec files and tests",
    );
    at("Read enough of the surrounding code to judge each changed line");
    at(
      "List problems in other files, or in code the change doesn't touch, as follow-ups. They don't affect the verdict",
    );
  });

  it("TC-CREV-008: runs the project's checks first, and a failure is blocking", () => {
    const step = reviewer.slice(at("2. **Run the checks first.**"), at("3. **Review against the rules.**"));
    for (const text of [
      "formatter, linter, type checker and tests",
      "Each failure in the changed files, or caused by them, is a `blocking` finding",
      "A failure only in other files is a follow-up",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-CREV-009: defines the severities and what each finding contains", () => {
    const severity = reviewer.slice(at("## Severity"), at("## Report format"));
    expect(severity.match(/^- \*\*`[a-z-]+`:\*\*/gm)).toEqual([
      "- **`blocking`:**",
      "- **`should-fix`:**",
      "- **`nit`:**",
    ]);
    at("| Severity | Where | Rule (source) | Problem | Fix |");
  });

  it("TC-CREV-010: runs Claude Code's code-review at an explicit medium level, without fixing or posting", () => {
    const step = reviewer.slice(at("**Run Claude Code's review"), at("5. **Confirm every finding.**"));
    for (const text of [
      "built-in `code-review`",
      "at the level `medium`, passing it explicitly",
      "with no level, it reuses the last level the user typed",
      "Don't pass `--fix`, `--comment`, `max` or `ultra` unless the user asks",
      "If it isn't available, say so in the report",
    ]) {
      expect(step).toContain(text);
    }
  });

  it("TC-CREV-011: confirms each finding, and drops what it can't confirm", () => {
    at("Confirm each finding in the code, and drop any you can't confirm, rather than report a guess");
  });

  it("TC-CREV-012: changes nothing, and ends with a report and a verdict", () => {
    at("**Don't change code, tests or specs.**");
    at("The verdict is `approve` when no `blocking` or `should-fix` findings remain, otherwise `changes`");
  });

  it("TC-CREV-013: stage 3 reviews after QA and before the preview", () => {
    const order = ["**Test it as QA.**", "**Fix what fails.**", "**Review the code.**", "**Show a preview."].map(
      (text) => at(text, stage3),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    for (const text of ["`review-code` skill", "even if the spec didn't change", "separate agent"]) {
      expect(reviewStep).toContain(text);
    }
  });

  it("TC-CREV-014: findings are fixed with write-code, disputed with a reason, or sent back to the spec", () => {
    for (const text of [
      "Fix each `blocking` and `should-fix` finding with the `write-code` skill, without changing behaviour the spec doesn't ask to change",
      "or say in the report why you think it's wrong",
      "If a finding shows the spec is wrong, go back to stage 2",
      "Report `nit` findings, and fix them only if the user asks",
    ]) {
      expect(reviewStep).toContain(text);
    }
  });

  it("TC-CREV-015: fixes go back through QA and review, at most 3 reviews", () => {
    for (const text of [
      "run QA again, which counts toward its limit, then the review again",
      "If the fixes need QA and the 3 QA runs are used up, stop: report the findings and the untested fixes, show the preview if it can start, and don't ask for approval",
      "The review runs at most 3 times for a change, counting every run",
      "the count starts again only after the user replies",
    ]) {
      expect(reviewStep).toContain(text);
    }
  });

  it("TC-CREV-016: after the 3rd failing review, it stops without asking for approval", () => {
    expect(reviewStep).toContain(
      "If the 3rd review still has `blocking` or `should-fix` findings, stop: report them, show the preview if it can start, and don't ask for approval",
    );
  });

  it("TC-CREV-017: the report includes the review", () => {
    const report = stage3.slice(at("4. Report each requirement", stage3), at("**Show a preview.", stage3));
    for (const text of [
      "findings fixed",
      "findings you disagreed with and why",
      "`nit` findings and follow-ups left",
      "whether Claude Code's review ran",
    ]) {
      expect(report).toContain(text);
    }
  });

  it("TC-CREV-018: open findings are stated before the commit question", () => {
    const stage4 = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**4. Ask"));
    expect(stage4.indexOf("state any `blocking` or `should-fix` review finding that's still open")).toBeGreaterThan(-1);
    expect(stage4.indexOf("state any `blocking` or `should-fix` review finding that's still open")).toBeLessThan(
      stage4.indexOf("ask whether to commit it"),
    );
  });

  it("TC-CREV-019: a review run for the implementing agent only follows review-code", () => {
    expect(reviewStep).toContain(
      "If you're reviewing for the agent that implemented the change, follow only the `review-code` skill. Don't start this lifecycle, change the spec or stop at stage 2.",
    );
    at("If you're reviewing for the agent that implemented the change, follow only this skill");
  });

  it("TC-CREV-020: implement-spec has the same review step, after QA", () => {
    const body = skill("implement-spec").body;
    const order = ["Hand it to QA", "Review the code", "Update the spec", "Show how to review it"].map((text) =>
      at(text, body),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    const step = body.slice(at("Review the code", body), at("Update the spec", body));
    for (const text of [
      "`review-code` skill",
      "with `write-code`",
      "run QA again, then the review again",
      "If the fixes need QA and the 3 QA runs are used up, stop: report the findings and the untested fixes",
      "instead of asking for approval",
      "at most 3 times for a change",
      "If the 3rd review still has `blocking` or `should-fix` findings, stop",
      "without changing behaviour the spec doesn't ask to change",
      "say in the report why you think it's wrong",
      "If a finding shows the spec is wrong, stop and use the `refine-spec` skill",
      "Fix `nit` findings only if the user asks",
      "the count starts again only after the user replies",
    ]) {
      expect(step).toContain(text);
    }
    const report = body.slice(at("Report and ask for review", body), at("Ask to commit", body));
    expect(report).toContain("the review findings fixed, disputed and left");
    expect(report, "FR-CREV-016: whether the built-in review ran").toMatch(/review ran/);
  });

  it("TC-CREV-021: the section with the review step stays under 200 lines", () => {
    const block = renderAgentsBlock(".cclinic/sdd");
    expect(block.split("\n").length).toBeLessThan(200);
    expect(block).toContain("| `review-code` |");
  });

  it("TC-CREV-030: changes the user requests go through QA and the review again", () => {
    expect(stage3).toContain(
      "If they request changes, make them, take them through QA and the review again, show the preview again, and ask again",
    );
    expect(skill("implement-spec").body).toContain(
      "If they request changes, make them, run QA and the review again, show how to review it again, and ask again",
    );
  });

  it("TC-CREV-031: the reviewer is told which files the change touched", () => {
    expect(reviewStep).toContain("and name the files the change touched");
    const body = skill("implement-spec").body;
    expect(body.slice(at("Review the code", body), at("Update the spec", body))).toContain(
      "naming the files the change touched",
    );
  });
});
