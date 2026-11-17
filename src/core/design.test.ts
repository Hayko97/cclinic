import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, renderAgentsBlock, renderDesignerAgent } from "./agent-skills.js";
import {
  DESIGN_AGENT_ALLOWED_TOOLS,
  DESIGN_AGENT_DENIED_TOOLS,
  DESIGN_AGENT_TOOLS,
  DESIGN_MAX_BUDGET_USD,
  DESIGN_SECTIONS,
  DESIGN_TIMEOUT_MS,
  DESIGNER_AGENT_TOOLS,
} from "./constants/design.js";
import { SECRET_FILES } from "./constants/environment.js";
import { checkDesignSystem, checkTokens, hasUserInterface, UI_DESIGN_SKILL } from "./design.js";
import type { EnvironmentFile } from "./environment.js";

const body = UI_DESIGN_SKILL.body;
const skill = (name: string): string => AGENT_SKILLS.find((entry) => entry.name === name)?.body ?? "";

const VALID_MARKDOWN = DESIGN_SECTIONS.map(
  (section) => `## ${section}\n\n${section === "Status" ? "approved" : "Text."}\n`,
).join("\n");
const VALID_TOKENS = JSON.stringify({
  color: {
    $type: "color",
    blue: { "600": { $value: "#2563eb" } },
    text: { default: { $value: "{color.blue.600}" } },
  },
  space: { "4": { $type: "dimension", $value: { value: 16, unit: "px" } } },
});
const valid = { designSystem: VALID_MARKDOWN, tokens: VALID_TOKENS, hasStyleGuide: true };

function problemsOf(files: Partial<typeof valid>): readonly string[] {
  const check = checkDesignSystem({ ...valid, ...files });
  return check.kind === "invalid" ? check.problems : [];
}

function environmentWith(...types: EnvironmentFile["parts"][number]["type"][]): EnvironmentFile {
  return { version: 1, alias: "app", parts: types.map((type) => ({ name: type, type, start: "run", review: "Try" })) };
}

describe("ui-design skill", () => {
  it("TC-DSGN-004: follows the skill format, names no agent's tools, and prohibits committing and pushing", () => {
    expect(UI_DESIGN_SKILL.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(UI_DESIGN_SKILL.description.length).toBeGreaterThan(0);
    expect(UI_DESIGN_SKILL.description.length).toBeLessThanOrEqual(1024);
    expect(body.split("\n").length).toBeLessThan(500);
    expect(body).not.toMatch(/\b(Bash|WebSearch|WebFetch|Glob|Grep)\b/);
    expect(body).toContain("Don't commit or push.");
    expect(AGENT_SKILLS.at(-1)?.name).toBe("ui-design");
  });

  it("TC-DSGN-005: stops without a UI, reads the project, researches, and asks or records assumptions", () => {
    for (const text of [
      "say that no design system is needed, and stop without creating files",
      "{{DOCS}}/overview.md",
      "{{DOCS}}/stack.md",
      "style sheets, theme files, design-token files, component folders, and logo or brand assets",
      "Search the web",
      "Name each page you used under Sources",
      "Never put secrets, file contents or private details of the project in a search query or URL",
      "at most 3 questions in one message",
      "2 or 3 visual directions",
      "recommend one",
      "**When nobody can answer,**",
      "set the status to `draft`",
    ])
      expect(body).toContain(text);
  });

  it("TC-DSGN-006: names the files, sections, token format and tiers, foundations, components and style guide", () => {
    for (const text of [
      ".luseen/design/design.tokens.json",
      ".luseen/design/design-system.md",
      ".luseen/design/style-guide.html",
      "Design Tokens Format Module 2025.10",
      "`$value`",
      "`$type`",
      "**Primitive:**",
      "**Semantic:**",
      "**Component:**",
      "at least 9 steps",
      "success, warning, danger and info",
      "A light and a dark theme",
      "4.5:1",
      "3:1",
      "4 px base",
      "reduced motion",
      "24 by 24 CSS pixels, and 44 by 44 on touch screens",
      "focus-visible",
      "empty state and loading indicator",
      "320 px",
      "loads nothing from the network",
      "switch between the light and dark themes",
    ])
      expect(body).toContain(text);
    const positions = DESIGN_SECTIONS.map((section, index) => body.indexOf(`${index + 1}. ${section}`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("TC-DSGN-007: extends what exists, asks for approval, and keeps code changes in the lifecycle", () => {
    for (const text of [
      "document it and extend it, rather than replace it",
      "**`approve`:**",
      "**`refine`:**",
      "Change only `.luseen/design/` while designing.",
      "the `write-code` skill",
      "Don't add a styling framework or component library",
      "Use only tokens in UI code",
      "Reuse existing components before making new ones",
      "add it to the design system first, and tell the user",
      "Build every state",
      "create it first, and get the user's approval before writing UI code",
    ])
      expect(body).toContain(text);
  });
});

describe("design system checks", () => {
  it("TC-DSGN-008: a complete design system passes, with its status", () => {
    expect(checkDesignSystem(valid)).toEqual({ kind: "valid", status: "approved" });
  });

  it("TC-DSGN-009: a token without $value or $type, a broken reference and invalid JSON fail", () => {
    expect(checkTokens(JSON.stringify({ color: { blue: { $type: "color", "600": "#2563eb" } } }))).toEqual([
      "design.tokens.json: color.blue.600 is neither a token nor a group",
    ]);
    expect(checkTokens(JSON.stringify({ size: { small: { $value: "4px" } } }))).toEqual([
      "design.tokens.json: size.small has no $type",
    ]);
    expect(checkTokens(JSON.stringify({ color: { $type: "color", text: { $value: "{color.gone}" } } }))).toEqual([
      "design.tokens.json: color.text refers to {color.gone}, which doesn't exist",
    ]);
    expect(checkTokens("{ not json")[0]).toMatch(/^design\.tokens\.json: isn't valid JSON/);
    expect(checkTokens("[]")).toEqual(["design.tokens.json: must be a JSON object of token groups"]);
    expect(checkTokens("{}")).toEqual(["design.tokens.json: has no tokens"]);
  });

  it("TC-DSGN-009: references inside composite values are checked", () => {
    const tokens = {
      color: { $type: "color", ink: { $value: "#000" } },
      shadow: { $type: "shadow", raised: { $value: { color: "{color.missing}", offsetX: "0px" } } },
    };
    expect(checkTokens(JSON.stringify(tokens))).toEqual([
      "design.tokens.json: shadow.raised refers to {color.missing}, which doesn't exist",
    ]);
  });

  it("TC-DSGN-010: a missing or misplaced section fails, naming it", () => {
    expect(problemsOf({ designSystem: VALID_MARKDOWN.replace("## Templates", "## Pages") })).toEqual([
      'design-system.md: the "Templates" section is missing',
    ]);
    const swapped = VALID_MARKDOWN.replace("## Shape and elevation", "## TEMP")
      .replace("## Motion", "## Shape and elevation")
      .replace("## TEMP", "## Motion");
    expect(problemsOf({ designSystem: swapped })).toContain('design-system.md: the "Motion" section is out of order');
  });

  it("a status that isn't draft or approved, or a missing style guide, fails", () => {
    expect(problemsOf({ designSystem: VALID_MARKDOWN.replace("approved", "done") })).toEqual([
      "design-system.md: the Status section must start with draft or approved, alone on its line",
    ]);
    expect(problemsOf({ hasStyleGuide: false })).toEqual(["style-guide.html is missing"]);
  });
});

describe("setup step", () => {
  it("TC-DSGN-033: the agent can't run commands, writes only design files, and can't read secrets", () => {
    expect(DESIGN_AGENT_ALLOWED_TOOLS).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Write(./.luseen/design/**)",
      "Edit(./.luseen/design/**)",
    ]);
    expect(DESIGN_AGENT_ALLOWED_TOOLS.some((tool) => tool.startsWith("Bash"))).toBe(false);
    expect(DESIGN_AGENT_DENIED_TOOLS).toContain("Bash");
    for (const file of SECRET_FILES) expect(DESIGN_AGENT_DENIED_TOOLS).toContain(`Read(**/${file})`);
  });

  it("TC-DSGN-033: the tool list offers no shell", () => {
    expect(DESIGN_AGENT_TOOLS).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write", "Edit"]);
  });

  it("TC-DSGN-034, TC-DSGN-035: the default limits are 15 minutes and 2 USD", () => {
    expect(DESIGN_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(DESIGN_MAX_BUDGET_USD).toBe(2);
  });

  it("only command-line and library parts mean there's no UI", () => {
    expect(hasUserInterface(environmentWith("cli"))).toBe(false);
    expect(hasUserInterface(environmentWith("library", "cli"))).toBe(false);
    expect(hasUserInterface(environmentWith("cli", "web"))).toBe(true);
    expect(hasUserInterface(environmentWith("ios"))).toBe(true);
    expect(hasUserInterface(undefined)).toBe(true);
  });
});

describe("other skills and the workflow", () => {
  it("TC-DSGN-045: the PM proposes the design system first for a product with UI", () => {
    expect(skill("product-engineer")).toContain(
      "propose a task in the first milestone to create or approve the design system with the `ui-design` skill, and make each task that builds UI depend on it",
    );
  });

  it("TC-DSGN-047: the workflow names ui-design at stages 1 and 2, and stays under 200 lines", () => {
    const block = renderAgentsBlock(".luseen/sdd");
    const stage1 = block.slice(block.indexOf("**1. Understand the prompt.**"), block.indexOf("**2. Refine"));
    const stage2 = block.slice(block.indexOf("**2. Refine"), block.indexOf("**3. Implement"));
    expect(stage1).toContain("For a design request");
    expect(stage1).toContain("use it with `write-code` for every change that touches UI");
    expect(stage2).toContain("UI change with no approved design system");
    expect(stage2).toContain("before stage 3");
    expect(block).toContain("| `ui-design` |");
    expect(block.split("\n").length).toBeLessThan(200);
  });

  it("TC-DSGN-048: the code review checks UI against the design system", () => {
    const review = skill("review-code");
    for (const text of [
      "`.luseen/design/design.tokens.json` exists",
      "always `should-fix`",
      "each raw color, font size, spacing, radius, shadow or duration",
      "each component state",
      "below 4.5:1",
    ])
      expect(review).toContain(text);
  });

  it("TC-DSGN-050: the designer agent has its name, tools, instructions and the lifecycle line", () => {
    const agent = renderDesignerAgent(".luseen/sdd", () => "hash");
    expect(agent).toMatch(/^---\nname: designer\n/);
    expect(agent).toContain(`tools: ${DESIGNER_AGENT_TOOLS.join(", ")}`);
    expect(DESIGNER_AGENT_TOOLS).toHaveLength(8);
    expect(agent).toContain("design systems, UI/UX design and building UI");
    expect(agent).toContain("Follow the project's `AGENTS.md` lifecycle for every code change");
    expect(agent).toContain("# Design the user interface");
    expect(agent).not.toContain("{{DOCS}}");
  });
});

describe("design system checks against DTCG 2025.10 and Markdown", () => {
  it("TC-DSGN-056: $root, $extends and $ref are accepted, and whole-string aliases are the only references", () => {
    const tokens = {
      color: {
        $type: "color",
        accent: { $root: { $value: "#000000" }, light: { $value: "#333333" } },
        text: { $value: "{color.accent.$root}" },
      },
      brand: { $extends: "{color.accent}", link: { $type: "color", $value: "{brand.light}" } },
      font: { $type: "fontFamily", body: { $value: "My {Font}" } },
      size: {
        $type: "dimension",
        base: { $value: { value: 16, unit: "px" } },
        big: { $value: { $ref: "#/size/base/$value" } },
      },
    };
    expect(checkTokens(JSON.stringify(tokens))).toEqual([]);
  });

  it("TC-DSGN-056: null values, $type-only groups, missing $extends groups, broken $ref and alias loops fail", () => {
    expect(checkTokens(JSON.stringify({ color: { $type: "color", ink: { $value: null } } }))).toEqual([
      "design.tokens.json: color.ink has no $value",
    ]);
    expect(
      checkTokens(JSON.stringify({ color: { $type: "color", ink: { $value: "#000" }, paper: { $type: "color" } } })),
    ).toEqual(["design.tokens.json: color.paper has no $value"]);
    expect(
      checkTokens(
        JSON.stringify({ color: { $type: "color", ink: { $value: "#000" } }, brand: { $extends: "{gone}" } }),
      ),
    ).toEqual(["design.tokens.json: brand extends {gone}, which isn't a group"]);
    expect(
      checkTokens(JSON.stringify({ size: { $type: "dimension", big: { $value: { $ref: "#/size/missing" } } } })),
    ).toEqual(["design.tokens.json: size.big refers to #/size/missing, which doesn't exist"]);
    expect(
      checkTokens(
        JSON.stringify({ color: { $type: "color", a: { $value: "{color.b}" }, b: { $value: "{color.a}" } } }),
      ),
    ).toEqual([
      "design.tokens.json: color.a is part of a circular reference",
      "design.tokens.json: color.b is part of a circular reference",
    ]);
  });

  it("TC-DSGN-057: the status must stand alone on its line", () => {
    for (const status of ["approved (was draft)", "Not approved yet"])
      expect(problemsOf({ designSystem: VALID_MARKDOWN.replace("\napproved\n", `\n${status}\n`) })).toEqual([
        "design-system.md: the Status section must start with draft or approved, alone on its line",
      ]);
    expect(
      checkDesignSystem({ ...valid, designSystem: VALID_MARKDOWN.replace("\napproved\n", "\n**Draft**\n") }),
    ).toEqual({
      kind: "valid",
      status: "draft",
    });
  });

  it("TC-DSGN-057: closing hashes, CRLF and a byte-order mark are accepted, and code blocks hold no sections", () => {
    const closed = VALID_MARKDOWN.replace("## Color", "## Color ##").replaceAll("\n", "\r\n");
    expect(checkDesignSystem({ ...valid, designSystem: closed, tokens: `﻿${VALID_TOKENS}` })).toEqual({
      kind: "valid",
      status: "approved",
    });
    const fenced = VALID_MARKDOWN.replace("## Templates\n", "```markdown\n## Templates\n```\n");
    expect(problemsOf({ designSystem: fenced })).toEqual(['design-system.md: the "Templates" section is missing']);
  });
});

describe("design system checks: QA run 2", () => {
  it("TC-DSGN-056: an extending group takes the base group's $type", () => {
    const tokens = { a: { $type: "number", x: { $value: 1 } }, b: { $extends: "{a}", y: { $value: 2 } } };
    expect(checkTokens(JSON.stringify(tokens))).toEqual([]);
  });

  it("TC-DSGN-056: $extends loops, $ref loops and bad $root tokens fail", () => {
    const loop = {
      a: { $type: "number", $extends: "{b}", x: { $value: 1 } },
      b: { $extends: "{a}", y: { $value: 2 } },
    };
    expect(checkTokens(JSON.stringify(loop))).toEqual([
      "design.tokens.json: a extends itself through a loop",
      "design.tokens.json: b extends itself through a loop",
    ]);
    const self = { a: { $type: "number", $extends: "{a}", x: { $value: 1 } } };
    expect(checkTokens(JSON.stringify(self))).toEqual(["design.tokens.json: a extends itself through a loop"]);
    const refLoop = {
      n: { $type: "number", a: { $value: { $ref: "#/n/b/$value" } }, b: { $value: { $ref: "#/n/a/$value" } } },
    };
    expect(checkTokens(JSON.stringify(refLoop))).toEqual([
      "design.tokens.json: n.a refers to #/n/b/$value, which leads back to itself",
      "design.tokens.json: n.b refers to #/n/a/$value, which leads back to itself",
    ]);
    const roots = { color: { $type: "color", a: { $root: { $type: "color" } }, b: { $root: "#000" } } };
    expect(checkTokens(JSON.stringify(roots))).toEqual([
      "design.tokens.json: color.a.$root has no $value",
      "design.tokens.json: color.b.$root is neither a token nor a group",
    ]);
  });

  it("TC-DSGN-056: a $ref to a built-in object key such as #/constructor doesn't exist", () => {
    for (const pointer of ["#/constructor", "#/toString", "#/n/__proto__"])
      expect(checkTokens(JSON.stringify({ n: { $type: "number", a: { $value: { $ref: pointer } } } }))).toEqual([
        `design.tokens.json: n.a refers to ${pointer}, which doesn't exist`,
      ]);
  });

  it("TC-DSGN-056: $ref pointers follow RFC 6901: array bounds, no leading zeros, percent-encoding and #", () => {
    const refTo = (pointer: string) =>
      checkTokens(
        JSON.stringify({
          n: { $type: "number", a: { $value: { $ref: pointer } } },
          ease: { $type: "cubicBezier", out: { $value: [0.1, 0.2, 0.3, 0.4] } },
          keyed: { $type: "shadow", odd: { $value: { "a b": 1, "c/d": 2 } } },
        }),
      );
    for (const pointer of [
      "#/ease/out/$value/5",
      "#/ease/out/$value/01",
      "#/ease/out/$value/-1",
      "#/keyed/%zz",
      "ease/out/$value/0",
    ])
      expect(refTo(pointer)).toEqual([`design.tokens.json: n.a refers to ${pointer}, which doesn't exist`]);
    for (const pointer of [
      "#/ease/out/$value/3",
      "#/ease/out/$value/0",
      "#/keyed/odd/$value/a%20b",
      "#/keyed/odd/$value/c~1d",
      "#",
    ])
      expect(refTo(pointer)).toEqual([]);
  });

  it("TC-DSGN-056: many groups extending a large base are checked quickly", () => {
    const base = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`t${index}`, { $value: index }]));
    const tokens: Record<string, unknown> = { base: { $type: "number", ...base } };
    for (let index = 0; index < 200; index++) tokens[`g${index}`] = { $extends: "{base}" };
    const startedMs = performance.now();
    expect(checkTokens(JSON.stringify(tokens))).toEqual([]);
    expect(performance.now() - startedMs).toBeLessThan(2000);
  });

  it("TC-DSGN-057: code fences follow CommonMark", () => {
    const unclosed = VALID_MARKDOWN.replace("## Templates\n", "```\n## Templates\n");
    expect(problemsOf({ designSystem: unclosed })).toContain('design-system.md: the "Templates" section is missing');
    const indented = VALID_MARKDOWN.replace("## Templates\n", "   ~~~\n## Templates\n   ~~~\n");
    expect(problemsOf({ designSystem: indented })).toEqual(['design-system.md: the "Templates" section is missing']);
    const nested = VALID_MARKDOWN.replace("## Templates\n", "````\n```\n## Templates\n```\n````\n");
    expect(problemsOf({ designSystem: nested })).toEqual(['design-system.md: the "Templates" section is missing']);
  });
});
