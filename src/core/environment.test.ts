import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, AGENT_WORKFLOW, renderAgentsBlock } from "./agent-skills.js";
import { ENVIRONMENT_AGENT_ALLOWED_TOOLS, ENVIRONMENT_AGENT_DENIED_TOOLS } from "./constants/environment.js";
import { changedOutsideEnvironment, environmentFileSchema, formatEnvironmentReview } from "./environment.js";

const webPart = {
  name: "web",
  type: "web",
  start: "docker compose up",
  stop: "docker compose down",
  url: "http://shop.localhost:5173",
  fallbackUrl: "http://localhost:5173",
  review: "Open the link",
};
const cliPart = { name: "tool", type: "cli", start: "node bin/tool.js --help", review: "It prints the options" };
const file = (overrides: Record<string, unknown> = {}): unknown => ({
  version: 1,
  alias: "shop",
  parts: [webPart],
  ...overrides,
});
const isValid = (value: unknown): boolean => environmentFileSchema.safeParse(value).success;
const localEnv = AGENT_SKILLS.find((skill) => skill.name === "local-env")?.body ?? "";

describe("the environment file", () => {
  it("TC-ENV-028: only a correct file passes", () => {
    expect(isValid(file())).toBe(true);
    expect(isValid(file({ parts: [cliPart] }))).toBe(true);
    expect(isValid(file({ parts: [] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...cliPart, type: "unknown" }] }))).toBe(false);
    expect(isValid(file({ extra: true }))).toBe(false);
    expect(isValid(file({ parts: [{ ...webPart, url: undefined }] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...webPart, fallbackUrl: undefined }] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...cliPart, url: "http://shop.localhost:1" }] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...webPart, stop: undefined }] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...webPart, url: "http://other.localhost:5173" }] }))).toBe(false);
    expect(isValid(file({ parts: [{ ...cliPart, review: "line\u001b[31m" }] }))).toBe(false);
  });

  it.each([
    ["my-shop", true],
    ["app", true],
    ["My_Shop", false],
    ["-shop", false],
    ["shop-", false],
    ["my--shop", false],
    ["", false],
    ["a".repeat(63), true],
    ["a".repeat(64), false],
  ])("TC-ENV-026: alias %j valid: %j", (alias, expected) => {
    expect(isValid(file({ alias, parts: [cliPart] }))).toBe(expected);
  });

  it("shows each part's review details", () => {
    const text = formatEnvironmentReview(environmentFileSchema.parse(file({ parts: [webPart, cliPart] })));
    for (const value of [webPart.url, webPart.fallbackUrl, webPart.stop, webPart.review, cliPart.start]) {
      expect(text).toContain(value);
    }
  });

  it("lists only changes outside the environment folder", () => {
    const before = new Map([
      ["a.ts", "1"],
      ["gone.ts", "1"],
      [".cclinic/environment/compose.yaml", "1"],
    ]);
    const after = new Map([
      ["a.ts", "2"],
      ["new.ts", "1"],
      [".cclinic/environment/compose.yaml", "2"],
    ]);
    expect(changedOutsideEnvironment(before, after)).toEqual(["a.ts", "gone.ts", "new.ts"]);
  });
});

describe("what Claude may do", () => {
  it("TC-ENV-013: no git, no sudo and no unrestricted shell", () => {
    const allowed = ENVIRONMENT_AGENT_ALLOWED_TOOLS;
    expect(allowed).not.toContain("Bash");
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toContain("Edit");
    expect(allowed.filter((tool) => /git|sudo|Bash\(\*/.test(tool))).toEqual([]);
    expect(ENVIRONMENT_AGENT_DENIED_TOOLS).toContain("Bash(git *)");
    expect(ENVIRONMENT_AGENT_DENIED_TOOLS).toContain("Bash(sudo *)");
    expect(ENVIRONMENT_AGENT_DENIED_TOOLS).toContain("Read(**/.env)");
  });
});

describe("the local-env skill", () => {
  it("TC-ENV-003: prohibits committing and pushing", () => {
    expect(localEnv).toContain("Don't commit or push");
  });

  it("states the safety rules for new web environments", () => {
    for (const text of [
      "127.0.0.1",
      "health check",
      "privileged mode",
      "Docker socket",
      "never `.env` or other secret files",
      "Don't change the project's existing Docker files",
      "Don't read or copy `.env`",
      "hosts file",
      "Don't install or start software",
      "up --build --wait",
      "<alias>.localhost",
      "already running under that project name",
    ]) {
      expect(localEnv).toContain(text);
    }
  });

  it("TC-ENV-041: the workflow and implement-spec require a preview before asking for approval", () => {
    const stage3 = AGENT_WORKFLOW.slice(AGENT_WORKFLOW.indexOf("**3. Implement"), AGENT_WORKFLOW.indexOf("**4. Ask"));
    expect(stage3.indexOf("real results")).toBeLessThan(stage3.indexOf("`local-env`"));
    expect(stage3.indexOf("`local-env`")).toBeLessThan(stage3.indexOf("Ask the user to approve"));
    expect(stage3).toContain(".cclinic/environment/environment.json");
    expect(stage3).toContain("A server you start yourself doesn't count");
    const body = AGENT_SKILLS.find((skill) => skill.name === "implement-spec")?.body ?? "";
    expect(body.indexOf("`local-env`")).toBeGreaterThan(body.indexOf("Verify everything"));
    expect(body.indexOf("`local-env`")).toBeLessThan(body.indexOf("Report and ask for review"));
  });

  it("TC-ENV-053: a failed preview still asks for review, unless QA failed 3 times", () => {
    const step = localEnv.slice(localEnv.indexOf("**If the preview can't start,**"));
    expect(step).toContain("still ask for review");
    expect(step).toContain("If the 3rd QA run failed, report the failures and don't ask for approval");
  });

  it("states what to show after each implementation", () => {
    for (const text of [
      "no preview is needed",
      "Rebuild or restart",
      "Leave it running",
      "Stop it:",
      "Checked:",
      "still ask for review",
    ]) {
      expect(localEnv).toContain(text);
    }
  });

  it("TC-ENV-001: the AGENTS.md section lists the skill", () => {
    expect(renderAgentsBlock("docs")).toContain("`local-env`");
  });
});
