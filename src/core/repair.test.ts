import { describe, expect, it } from "vitest";
import { GUIDELINE_SECTIONS } from "./guidelines-baseline.js";
import { repairProject, repairSpec } from "./repair.js";
import type { GeneratedSpec, ProjectData } from "./schemas.js";
import { buildFileIndex, repairLinks, validateProject, validateRendered, validateSpec } from "./validation.js";

const index = buildFileIndex([
  {
    path: "src/a.ts",
    kind: "code",
    sha256: "x",
    positioning: "line",
    units: [1, 2, 3].map((line) => ({ ref: String(line), text: "code" })),
    warnings: [],
  },
]);

function spec(overrides: Partial<GeneratedSpec> = {}): GeneratedSpec {
  return {
    name: "alpha",
    area: "AB",
    goal: "Do it.",
    requirements: [{ id: "FR-AB-001", statement: "It must work.", status: "code-only", evidence: ["src/a.ts:1"] }],
    edgeCases: [],
    nonGoals: [],
    testSetup: [],
    acceptanceCriteria: [{ id: "VAL-AB-001", covers: ["FR-AB-001"], userNeed: "Need", acceptedWhen: "It works" }],
    testCases: [{ id: "TC-AB-001", covers: ["FR-AB-001"], level: "unit", given: "G", when: "W", then: "T" }],
    openQuestions: [],
    ...overrides,
  };
}

describe("repairing generated specs", () => {
  it("TC-ANA-041: malformed and retired requirement IDs get new numbers, and their links follow", () => {
    const input = spec({
      requirements: [
        { id: "FR-AB-1", statement: "One.", status: "code-only", evidence: ["src/a.ts:1"] },
        { id: "FR-AB-002", statement: "Two.", status: "code-only", evidence: ["src/a.ts:2"] },
      ],
      acceptanceCriteria: [
        { id: "VAL-AB-001", covers: ["FR-AB-1", "FR-AB-002"], userNeed: "Need", acceptedWhen: "Works" },
      ],
      testCases: [
        { id: "TC-AB-001", covers: ["FR-AB-1", "FR-AB-002"], level: "unit", given: "G", when: "W", then: "T" },
      ],
    });
    const { value, repairs } = repairSpec(input, index, ["FR-AB-002"]);
    expect(value?.requirements.map((item) => item.id)).toEqual(["FR-AB-003", "FR-AB-004"]);
    expect(value?.acceptanceCriteria[0]?.covers).toEqual(["FR-AB-003", "FR-AB-004"]);
    expect(value?.testCases[0]?.covers).toEqual(["FR-AB-003", "FR-AB-004"]);
    expect(repairs).toContain("alpha: renumbered FR-AB-1 to FR-AB-003");
    expect(validateSpec(value as GeneratedSpec, index, ["FR-AB-002"])).toEqual([]);
  });

  it("TC-ANA-043: unknown links are removed, and a VAL or TC left incomplete is removed", () => {
    const input = spec({
      acceptanceCriteria: [
        { id: "VAL-AB-001", covers: ["FR-AB-001", "FR-AB-009"], userNeed: "Need", acceptedWhen: "Works" },
      ],
      testCases: [
        { id: "TC-AB-001", covers: ["FR-AB-001"], level: "unit", given: "G", when: "W", then: "T" },
        { id: "TC-AB-002", covers: ["FR-AB-009"], level: "unit", given: "G", when: "W", then: "T" },
        { id: "TC-AB-003", covers: ["FR-AB-001"], level: "unit", given: "G", when: "W", then: " " },
      ],
    });
    const { value } = repairSpec(input, index, []);
    expect(value?.acceptanceCriteria[0]?.covers).toEqual(["FR-AB-001"]);
    expect(value?.testCases.map((item) => item.id)).toEqual(["TC-AB-001"]);
    expect(validateSpec(value as GeneratedSpec, index, [])).toEqual([]);
  });

  it("TC-ANA-043: a whole-file citation stays only on open questions", () => {
    const input = spec({
      requirements: [
        { id: "FR-AB-001", statement: "It must work.", status: "code-only", evidence: ["src/a.ts:1", "src/a.ts"] },
      ],
      openQuestions: [{ question: "Why?", evidence: ["src/a.ts", "gone.ts:1"] }],
    });
    const { value } = repairSpec(input, index, []);
    expect(value?.requirements[0]?.evidence).toEqual(["src/a.ts:1"]);
    expect(value?.openQuestions[0]?.evidence).toEqual(["src/a.ts"]);
  });

  it("TC-ANA-041: a new number skips IDs the previous run used", () => {
    const input = spec({
      requirements: [
        { id: "FR-AB-001", statement: "One.", status: "code-only", evidence: ["src/a.ts:1"] },
        { id: "FR-7", statement: "Seven.", status: "code-only", evidence: ["src/a.ts:2"] },
      ],
      acceptanceCriteria: [
        { id: "VAL-AB-001", covers: ["FR-AB-001", "FR-7"], userNeed: "Need", acceptedWhen: "Works" },
      ],
      testCases: [{ id: "TC-AB-001", covers: ["FR-AB-001", "FR-7"], level: "unit", given: "G", when: "W", then: "T" }],
    });
    const { value } = repairSpec(input, index, [], ["FR-AB-001", "FR-AB-002"]);
    expect(value?.requirements.map((item) => item.id)).toEqual(["FR-AB-001", "FR-AB-003"]);
  });

  it("TC-ANA-041: when a malformed ID is repeated, the links stay with the first requirement", () => {
    const input = spec({
      requirements: [
        { id: "FR-AB-X", statement: "First.", status: "code-only", evidence: ["src/a.ts:1"] },
        { id: "FR-AB-X", statement: "Second.", status: "code-only", evidence: ["src/a.ts:2"] },
      ],
      acceptanceCriteria: [{ id: "VAL-AB-001", covers: ["FR-AB-X"], userNeed: "Need", acceptedWhen: "Works" }],
      testCases: [{ id: "TC-AB-001", covers: ["FR-AB-X"], level: "unit", given: "G", when: "W", then: "T" }],
    });
    const { value } = repairSpec(input, index, []);
    expect(value?.requirements.map((item) => item.statement)).toEqual(["First."]);
    expect(value?.acceptanceCriteria[0]?.covers).toEqual(["FR-AB-001"]);
  });

  it("TC-ANA-044: a spec with no verifiable requirement is removed", () => {
    const input = spec({
      requirements: [{ id: "FR-AB-001", statement: "It must work.", status: "code-only", evidence: ["gone.ts:1"] }],
    });
    const { value, repairs } = repairSpec(input, index, []);
    expect(value).toBeUndefined();
    expect(repairs.join()).toContain("removed the spec");
  });

  it("TC-ANA-044: a valid spec is returned unchanged, with no repairs", () => {
    const input = spec();
    expect(repairSpec(input, index, [])).toEqual({ value: input, repairs: [] });
  });
});

describe("repairing project data", () => {
  it("TC-ANA-045: names, areas, evidence and labels are repaired until validation passes", () => {
    const project: ProjectData = {
      overview: { purpose: "P", users: [], scope: [], nonGoals: [], glossary: [] },
      stack: [
        { category: "Language", name: "TypeScript", version: "6", evidence: ["src/a.ts:1"] },
        { category: "Tool", name: "Ghost", version: "1", evidence: ["abc1234"] },
      ],
      architecture: { parts: [], dataFlow: [], externalSystems: [], problems: [] },
      guidelines: [{ section: "Naming", guidance: "Use camelCase.", label: "observed", evidence: [] }],
      specs: [
        { name: "Public Site", area: "PS", goal: "G", modules: [] },
        { name: "beta", area: "AB", goal: "G", modules: [] },
        { name: "gamma", area: "AB", goal: "G", modules: [] },
        { name: "beta", area: "x", goal: "G", modules: [] },
      ],
      openQuestions: [],
    };
    const { value } = repairProject(project, index);
    expect(value.specs.map((entry) => entry.name)).toEqual(["public-site", "beta", "gamma", "beta-2"]);
    expect(new Set(value.specs.map((entry) => entry.area)).size).toBe(4);
    expect(value.stack.map((item) => item.name)).toEqual(["TypeScript"]);
    expect(value.guidelines[0]?.label).toBe("recommended");
    expect(validateProject(value, index)).toEqual([]);
  });
});

describe("validating rendered documents", () => {
  it("TC-ANA-050: broken links become text, even with brackets in the text, and valid links stay", () => {
    const files = new Map([
      ["README.md", "# Read me\n"],
      ["specs/alpha/spec.md", "See [the [v2] guide](docs/guide.md), `[x](missing.md)` and [README](../../README.md)."],
    ]);
    const { files: repaired, repairs } = repairLinks(files);
    expect(repaired.get("specs/alpha/spec.md")).toBe("See the [v2] guide, `x` and [README](../../README.md).");
    expect(repairs).toHaveLength(2);
    expect(validateRendered(repaired, []).filter((problem) => problem.includes("broken link"))).toEqual([]);
  });

  it("TC-ANA-048: a missing guideline section is still reported", () => {
    const guidelines = GUIDELINE_SECTIONS.slice(1)
      .map((section) => `\n## ${section}\n`)
      .join("");
    const problems = validateRendered(new Map([["developer-guidelines.md", guidelines]]), []);
    expect(problems).toEqual([`developer-guidelines.md: "${GUIDELINE_SECTIONS[0]}" is missing`]);
  });
});
