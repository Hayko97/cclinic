import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS,
  classifySkill,
  isSameSkill,
  mergeAgentsFile,
  renderAgentsBlock,
  renderSkill,
  stripAgentsBlock,
  type AgentSkill,
} from "./agent-skills.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const skill = (name: string): AgentSkill => {
  const found = AGENT_SKILLS.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No skill named ${name}`);
  return found;
};
const render = (name: string): string => renderSkill(skill(name), ".cclinic/sdd", hash);

describe("skill format", () => {
  it("TC-SKILL-001: provides the five skills", () => {
    expect(AGENT_SKILLS.map((item) => item.name)).toEqual([
      "create-spec",
      "refine-spec",
      "write-code",
      "implement-spec",
      "test-spec",
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
    const merged = mergeAgentsFile(original, renderAgentsBlock("new/path")) ?? "";
    expect(merged.startsWith("# Mine\n\n")).toBe(true);
    expect(merged.endsWith("\n\nMore of mine.\n")).toBe(true);
    expect(merged).toContain("new/path");
    expect(merged).not.toContain("old/path");
  });

  it("creates the section when the file is missing or blank, and refuses damaged markers", () => {
    const block = renderAgentsBlock("docs");
    expect(mergeAgentsFile(undefined, block)).toBe(`${block}\n`);
    expect(mergeAgentsFile("  \n", block)).toBe(`${block}\n`);
    expect(mergeAgentsFile("<!-- cclinic:start -->\nno end", block)).toBeUndefined();
    expect(mergeAgentsFile("no start\n<!-- cclinic:end -->", block)).toBeUndefined();
    expect(mergeAgentsFile("<!-- cclinic:end --> <!-- cclinic:start -->", block)).toBeUndefined();
  });

  it("TC-SKILL-022: stripping leaves only the user's text", () => {
    const block = renderAgentsBlock("docs");
    expect(stripAgentsBlock(`# Mine\n\n${block}\n`)).toBe("# Mine\n");
    expect(stripAgentsBlock(`${block}\n`)).toBe("");
    expect(stripAgentsBlock(`# Mine\n\n${block}\n\nEnd\n`)).toBe("# Mine\n\nEnd\n");
    expect(stripAgentsBlock("# Only mine\n")).toBe("# Only mine\n");
    expect(stripAgentsBlock(mergeAgentsFile("# Mine\n", block) ?? "")).toBe("# Mine\n");
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
    const body = skill(name).body;
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
