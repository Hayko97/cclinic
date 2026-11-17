/** The design step and the designer agent in-process, with mocked prompts and a fake `claude` on PATH. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@inquirer/prompts";
import { runEnvironmentAgent } from "../../src/adapters/llm/environment-agent.js";
import { installSkills } from "../../src/adapters/storage/skill-installer.js";
import type { CommandContext } from "../../src/cli/command-context.js";
import { setUpDesignAfterGenerate, type DesignAfterGenerateInput } from "../../src/cli/design-step.js";
import { createReporter } from "../../src/cli/reporter.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn() }));
const confirmMock = vi.mocked(confirm);

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ENVIRONMENT_FILE = ".luseen/environment/environment.json";
const DESIGNER = ".claude/agents/designer.md";

function environmentFile(...types: string[]): string {
  const parts = types.map((type) =>
    type === "web"
      ? {
          name: "web",
          type,
          start: "docker compose up",
          stop: "docker compose down",
          url: "http://app.localhost:3000",
          fallbackUrl: "http://localhost:3000",
          review: "Open it",
        }
      : { name: type, type, start: "node tool.js", review: "Run it" },
  );
  return JSON.stringify({ version: 1, alias: "app", parts });
}

function harness(extra: NodeJS.ProcessEnv = {}) {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
  chmodSync(path.join(bin, "claude"), 0o755);
  const home = makeTempFolder();
  const record = path.join(makeTempFolder(), "calls.jsonl");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    FAKE_CLAUDE_RECORD: record,
    ...extra,
  };
  let out = "";
  let err = "";
  const reporter = createReporter({
    quiet: false,
    debug: false,
    color: "never",
    environment,
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
  });
  const context: CommandContext = { reporter, environment, signal: new AbortController().signal, version: "0.1.0" };
  return {
    context,
    environment,
    stdout: () => out,
    stderr: () => err,
    agentCalls: () => (existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).length : 0),
  };
}

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = makeTempFolder();
  writeProject(root, { "src/a.ts": "export const a = 1;\n", ...files });
  return root;
}

function afterGenerate(root: string, overrides: Partial<DesignAfterGenerateInput> = {}): DesignAfterGenerateInput {
  return {
    target: root,
    out: path.join(root, ".luseen/sdd"),
    model: "sonnet",
    effort: "medium",
    isClaudeCli: true,
    wereSkillsInstalled: true,
    requested: undefined,
    mayAsk: true,
    ...overrides,
  };
}

const originalIsTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = true;
  confirmMock.mockReset();
});
afterEach(() => {
  process.stdin.isTTY = originalIsTty;
});

describe("design step after generation", () => {
  it("TC-DSGN-022: asks with the consent text, defaulting to yes; no starts nothing, yes starts it once", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const declined = harness();
    const first = await setUpDesignAfterGenerate(
      afterGenerate(project({ [ENVIRONMENT_FILE]: environmentFile("web") })),
      declined.context,
    );
    expect(first.status).toBe("declined");
    expect(declined.agentCalls()).toBe(0);
    const question = confirmMock.mock.calls[0]?.[0];
    expect(question?.message).toContain("research the web");
    expect(question?.message).toContain(".luseen/design");
    expect(question?.default).toBe(true);

    confirmMock.mockResolvedValueOnce(true);
    const agreed = harness();
    const second = await setUpDesignAfterGenerate(
      afterGenerate(project({ [ENVIRONMENT_FILE]: environmentFile("web") })),
      agreed.context,
    );
    expect(second).toMatchObject({ status: "ready", designStatus: "draft" });
    expect(agreed.agentCalls()).toBe(1);
  });

  it.each([["cli"], ["library"]])("TC-DSGN-023: a project with only a %s part isn't asked", async (type) => {
    const test = harness();
    const outcome = await setUpDesignAfterGenerate(
      afterGenerate(project({ [ENVIRONMENT_FILE]: environmentFile(type) })),
      test.context,
    );
    expect(outcome).toMatchObject({ status: "no-ui" });
    expect(outcome.status === "no-ui" ? outcome.message : "").toContain("no user interface");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(test.agentCalls()).toBe(0);
  });

  it("TC-DSGN-024: with no environment file, it asks", async () => {
    confirmMock.mockResolvedValueOnce(false);
    await setUpDesignAfterGenerate(afterGenerate(project()), harness().context);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("a failure in a generation run warns, and returns a failed outcome", async () => {
    const test = harness({ FAKE_CLAUDE_DESIGN: "invalid" });
    const outcome = await setUpDesignAfterGenerate(afterGenerate(project(), { requested: true }), test.context);
    expect(outcome.status).toBe("failed");
    expect(test.stderr()).toContain("Couldn't create the design system");
  });

  it("TC-DSGN-034: a run with a time limit stops at it", async () => {
    const test = harness({ FAKE_CLAUDE_MODE: "hang" });
    await expect(
      runEnvironmentAgent({
        target: project(),
        prompt: "Create the design system for the project in the current folder.",
        model: "sonnet",
        effort: "medium",
        maxBudgetUsd: 1,
        environment: test.environment,
        signal: new AbortController().signal,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("stopped at its limit");
  });
});

describe("designer agent install", () => {
  it("TC-DSGN-051: luseen skills installs it, and --plugin doesn't", async () => {
    const root = makeTempFolder();
    const entries = await installSkills({ target: root, out: path.join(root, ".luseen/sdd"), isForced: false });
    expect(entries).toContainEqual({ path: DESIGNER, status: "installed" });
    expect(readFileSync(path.join(root, DESIGNER), "utf8")).toMatch(/^---\nname: designer\n/);

    const plugin = makeTempFolder();
    await installSkills({
      target: plugin,
      out: path.join(plugin, ".luseen/sdd"),
      isForced: false,
      skillSource: "plugin",
    });
    expect(existsSync(path.join(plugin, DESIGNER))).toBe(false);
  });

  it("TC-DSGN-052: an edited or foreign designer agent is left alone and reported", async () => {
    const edited = makeTempFolder();
    const out = path.join(edited, ".luseen/sdd");
    await installSkills({ target: edited, out, isForced: false });
    const changed = `${readFileSync(path.join(edited, DESIGNER), "utf8")}\nMy own note.\n`;
    writeFileSync(path.join(edited, DESIGNER), changed);
    const again = await installSkills({ target: edited, out, isForced: false });
    expect(again).toContainEqual({ path: DESIGNER, status: "skipped: edited, use --force to replace" });
    expect(readFileSync(path.join(edited, DESIGNER), "utf8")).toBe(changed);

    const foreign = makeTempFolder();
    mkdirSync(path.join(foreign, ".claude/agents"), { recursive: true });
    writeFileSync(path.join(foreign, DESIGNER), "---\nname: designer\n---\nMine.\n");
    const entries = await installSkills({ target: foreign, out: path.join(foreign, ".luseen/sdd"), isForced: false });
    expect(entries).toContainEqual({ path: DESIGNER, status: "skipped: not created by luseen" });
    expect(readFileSync(path.join(foreign, DESIGNER), "utf8")).toBe("---\nname: designer\n---\nMine.\n");
  });

  it("TC-DSGN-001, TC-DSGN-002: ui-design is in both skill folders and AGENTS.md, and an edited copy is kept", async () => {
    const root = makeTempFolder();
    const out = path.join(root, ".luseen/sdd");
    await installSkills({ target: root, out, isForced: false });
    const agents = readFileSync(path.join(root, ".agents/skills/ui-design/SKILL.md"), "utf8");
    expect(readFileSync(path.join(root, ".claude/skills/ui-design/SKILL.md"), "utf8")).toBe(agents);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("| `ui-design` |");

    writeFileSync(path.join(root, ".agents/skills/ui-design/SKILL.md"), `${agents}\nEdited.\n`);
    const again = await installSkills({ target: root, out, isForced: false });
    expect(again).toContainEqual({
      path: ".agents/skills/ui-design/SKILL.md",
      status: "skipped: edited, use --force to replace",
    });

    const foreign = makeTempFolder();
    writeProject(foreign, { ".claude/skills/ui-design/SKILL.md": "---\nname: ui-design\n---\nMine.\n" });
    const entries = await installSkills({ target: foreign, out: path.join(foreign, ".luseen/sdd"), isForced: false });
    expect(entries).toContainEqual({
      path: ".claude/skills/ui-design/SKILL.md",
      status: "skipped: not created by luseen",
    });
  });
});
