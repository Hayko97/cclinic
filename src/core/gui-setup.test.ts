import { describe, expect, it } from "vitest";
import { ENVIRONMENT_CONSENT_MESSAGE } from "./environment.js";
import { generateOptionsSchema } from "./gui.js";
import { generateQuestions, mcpInfo, type DryRun } from "./gui-setup.js";

const dryRun = (change: Partial<DryRun> = {}): DryRun => ({
  status: "dry-run",
  provider: "anthropic-api",
  model: "sonnet",
  effort: "medium",
  estimatedTokens: 12_345,
  estimatedCostUsd: 0.42,
  included: [{}, {}, {}],
  git: { status: "ready" },
  ...change,
});
const options = (raw: Record<string, unknown> = {}) => generateOptionsSchema.parse(raw);

describe("generate's questions (FR-GUI-016)", () => {
  it("TC-GUI-023: a project with no Git repository is asked about cost, Git and the environment, in that order", () => {
    const questions = generateQuestions(options(), dryRun({ git: { status: "no-repository" } }));
    expect(questions.map((question) => question.id)).toEqual(["cost", "git", "environment"]);
    expect(questions[0]?.text).toBe(
      "luseen will analyse 3 files, about 12,345 input tokens, with Sonnet 5.5 at Medium reasoning. Estimated cost: $0.42. Continue?",
    );
    expect(questions[1]?.answers.map((answer) => answer.value)).toEqual(["create", "no-git"]);
    expect(questions[2]?.text).toBe(ENVIRONMENT_CONSENT_MESSAGE);
  });

  it("TC-GUI-116: --force adds its warning, and a chosen environment option or --no-git asks nothing more", () => {
    const questions = generateQuestions(
      options({ force: true, environment: true }),
      dryRun({ git: { status: "no-repository" }, estimatedCostUsd: null }),
    );
    expect(questions.map((question) => question.id)).toEqual(["cost", "git", "force"]);
    expect(questions[0]?.text).toContain("It uses your Claude Code subscription.");
    expect(questions[2]?.text).toBe(
      "--force replaces .luseen/sdd completely, including any changes made to it by hand.",
    );
    expect(
      generateQuestions(options({ noGit: true, noSkills: true }), dryRun()).map((question) => question.id),
    ).toEqual(["cost"]);
  });

  it("TC-GUI-116: one file is said in the singular", () => {
    expect(generateQuestions(options({ environment: false }), dryRun({ included: [{}] }))[0]?.text).toContain(
      "analyse 1 file,",
    );
  });
});

describe("connecting a host agent (FR-GUI-018)", () => {
  it("TC-GUI-026: says whether luseen's entry is in .mcp.json, and gives the entry to add", () => {
    const read = (content: string) => mcpInfo({ kind: "read", content });
    const missing = mcpInfo({ kind: "missing" });
    expect(missing.status).toBe("missing");
    expect(JSON.parse(missing.entry)).toEqual({
      mcpServers: { luseen: { command: "npx", args: ["luseen", "mcp"] } },
    });
    expect(read(missing.entry).status).toBe("installed");
    expect(read('{"mcpServers":{"other":{"command":"x"}}}').status).toBe("missing");
    expect(read('{"mcpServers":{"luseen":{"command":"node","args":["mine.js"]}}}').status).toBe("changed");
    expect(read("{ not json").status).toBe("unreadable");
    // A file that can't be read at all still gives the entry to add.
    expect(mcpInfo({ kind: "unreadable" })).toEqual({ ...missing, status: "unreadable" });
  });
});

describe("the cost question's amount", () => {
  it("TC-GUI-023: a cost below a cent is said as under $0.01, not $0.00", () => {
    const text = (estimatedCostUsd: number) =>
      generateQuestions(options({ environment: false }), dryRun({ estimatedCostUsd }))[0]?.text;
    expect(text(0.001)).toContain("Estimated cost: under $0.01.");
    expect(text(0.005)).toContain("Estimated cost: $0.01.");
  });
});
