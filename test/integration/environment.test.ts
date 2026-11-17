/** The environment step in-process, with mocked prompts and a fake `claude` on PATH. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@inquirer/prompts";
import { readEnvironmentFile, snapshotFiles } from "../../src/adapters/storage/environment-store.js";
import type { CommandContext } from "../../src/cli/command-context.js";
import { runEnvironmentCommand } from "../../src/cli/environment-command.js";
import {
  formatEnvironmentOutcome,
  setUpAfterGenerate,
  type AfterGenerateInput,
} from "../../src/cli/environment-step.js";
import { createReporter } from "../../src/cli/reporter.js";
import { EnvironmentStepError, UsageError, ValidationFailedError } from "../../src/core/errors.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn() }));
const confirmMock = vi.mocked(confirm);

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ENVIRONMENT_FILE = ".luseen/environment/environment.json";
const VALID = JSON.stringify({
  version: 1,
  alias: "tool",
  parts: [{ name: "tool", type: "cli", start: "node tool.js", review: "It prints hello" }],
});

function fakeClaudePath(withClaude = true): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  if (withClaude) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
    chmodSync(path.join(folder, "claude"), 0o755);
  }
  return folder;
}

function harness(extra: NodeJS.ProcessEnv = {}, withClaude = true) {
  const home = makeTempFolder();
  const record = path.join(makeTempFolder(), "calls.jsonl");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${fakeClaudePath(withClaude)}:/usr/bin:/bin`,
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

function afterGenerate(root: string, overrides: Partial<AfterGenerateInput> = {}): AfterGenerateInput {
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

describe("luseen environment", () => {
  it("TC-ENV-009: asks first, and declining starts nothing", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const root = project();
    const test = harness();
    await runEnvironmentCommand(root, {}, test.context);
    expect(test.agentCalls()).toBe(0);
    expect(test.stdout()).toContain("Use the local-env skill");
    expect(existsSync(path.join(root, ".agents/skills/local-env/SKILL.md"))).toBe(true);
  });

  it("agreeing starts Claude, and shows how to review", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const test = harness();
    await runEnvironmentCommand(project(), {}, test.context);
    expect(test.agentCalls()).toBe(1);
    expect(test.stdout()).toContain("http://sample.localhost:3000");
    expect(test.stdout()).toContain("about $0.25 (estimate)");
  });

  it("with no terminal and no --yes, it's a usage error", async () => {
    process.stdin.isTTY = false;
    const test = harness();
    await expect(runEnvironmentCommand(project(), {}, test.context)).rejects.toBeInstanceOf(UsageError);
    expect(test.agentCalls()).toBe(0);
  });

  it("TC-ENV-011: with the API provider, or no login, nothing starts", async () => {
    for (const test of [harness({ LUSEEN_PROVIDER: "anthropic-api" }), harness({ FAKE_CLAUDE_LOGGED_OUT: "1" })]) {
      await runEnvironmentCommand(project(), { yes: true }, test.context);
      expect(test.agentCalls()).toBe(0);
      expect(test.stdout()).toContain("Use the local-env skill");
    }
    const noClaude = harness({}, false);
    await runEnvironmentCommand(project(), { yes: true }, noClaude.context);
    expect(noClaude.stdout()).toContain("Use the local-env skill");
  });

  it("TC-ENV-021: an existing file is shown, and --json reports it", async () => {
    const root = project({ [ENVIRONMENT_FILE]: VALID });
    const test = harness();
    await runEnvironmentCommand(root, { json: true }, test.context);
    expect(test.agentCalls()).toBe(0);
    expect(confirmMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(test.stdout()) as { environment: { status: string } };
    expect(parsed.environment.status).toBe("existing");
  });

  it("TC-ENV-022: --force doesn't replace an edited skill", async () => {
    const root = project();
    const first = harness();
    await runEnvironmentCommand(root, { yes: true }, first.context);
    const skill = path.join(root, ".agents/skills/local-env/SKILL.md");
    const edited = `${readFileSync(skill, "utf8")}\nMy addition.\n`;
    writeFileSync(skill, edited);
    const second = harness();
    await runEnvironmentCommand(root, { yes: true, force: true }, second.context);
    expect(second.agentCalls()).toBe(1);
    expect(readFileSync(skill, "utf8")).toBe(edited);
  });

  it("TC-ENV-002: another person's skill named local-env is left alone and reported", async () => {
    const own = "---\nname: local-env\ndescription: Mine\n---\nBody\n";
    const root = project({ ".agents/skills/local-env/SKILL.md": own });
    const test = harness();
    await runEnvironmentCommand(root, { yes: true }, test.context);
    expect(readFileSync(path.join(root, ".agents/skills/local-env/SKILL.md"), "utf8")).toBe(own);
    expect(test.stderr()).toContain("1 skipped");
  });

  it("TC-ENV-018: failures have their own error types", async () => {
    await expect(
      runEnvironmentCommand(project(), { yes: true }, harness({ FAKE_CLAUDE_ENVIRONMENT: "fail" }).context),
    ).rejects.toBeInstanceOf(EnvironmentStepError);
    const invalid = runEnvironmentCommand(
      project(),
      { yes: true },
      harness({ FAKE_CLAUDE_ENVIRONMENT: "invalid" }).context,
    );
    await expect(invalid).rejects.toBeInstanceOf(ValidationFailedError);
    const caught = (await invalid.catch((error: unknown) => error)) as ValidationFailedError;
    expect(caught.problems.join(" ")).toContain("alias");
    const none = runEnvironmentCommand(project(), { yes: true }, harness({ FAKE_CLAUDE_ENVIRONMENT: "none" }).context);
    await expect(none).rejects.toThrow("I couldn't tell what runs here");
  });

  it("TC-ENV-020: changes outside the folder are warned about", async () => {
    const test = harness({ FAKE_CLAUDE_ALSO_WRITE: "src/a.ts" });
    await runEnvironmentCommand(project(), { yes: true }, test.context);
    expect(test.stderr()).toContain("also changed: src/a.ts");
  });
});

describe("at the end of a generation run", () => {
  it("TC-ENV-007: skipped when turned off, or when the skills weren't installed", async () => {
    const root = project();
    const test = harness();
    expect(await setUpAfterGenerate(afterGenerate(root, { requested: false }), test.context)).toEqual({
      status: "skipped",
    });
    expect(await setUpAfterGenerate(afterGenerate(root, { wereSkillsInstalled: false }), test.context)).toEqual({
      status: "skipped",
    });
    expect(formatEnvironmentOutcome({ status: "skipped" })).toBeUndefined();
    expect(test.agentCalls()).toBe(0);
  });

  it("TC-ENV-004: doesn't ask when it may not, or with no terminal, or with the API provider", async () => {
    const root = project();
    const test = harness();
    const cases: Partial<AfterGenerateInput>[] = [{ mayAsk: false }, { isClaudeCli: false }];
    for (const overrides of cases) {
      const outcome = await setUpAfterGenerate(afterGenerate(root, overrides), test.context);
      expect(outcome.status).toBe("not-started");
    }
    process.stdin.isTTY = false;
    expect((await setUpAfterGenerate(afterGenerate(root), test.context)).status).toBe("not-started");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(test.agentCalls()).toBe(0);
  });

  it("an existing file is reused without asking", async () => {
    const test = harness();
    const outcome = await setUpAfterGenerate(afterGenerate(project({ [ENVIRONMENT_FILE]: VALID })), test.context);
    expect(outcome.status).toBe("existing");
    expect(formatEnvironmentOutcome(outcome)).toContain("It prints hello");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("declining reports the next step", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const outcome = await setUpAfterGenerate(afterGenerate(project()), harness().context);
    expect(outcome.status).toBe("declined");
    expect(formatEnvironmentOutcome(outcome)).toContain("luseen environment");
  });

  it.each(["fail", "invalid", "none"])("TC-ENV-019: %s only warns", async (mode) => {
    const test = harness({ FAKE_CLAUDE_ENVIRONMENT: mode });
    const outcome = await setUpAfterGenerate(afterGenerate(project(), { requested: true }), test.context);
    expect(outcome.status).toBe("failed");
    expect(formatEnvironmentOutcome(outcome)).toBeUndefined();
    expect(test.stderr()).toContain("Couldn't set up the local environment");
  });

  it("stops if the run is cancelled", async () => {
    const test = harness({ FAKE_CLAUDE_MODE: "hang" });
    const controller = new AbortController();
    const running = setUpAfterGenerate(afterGenerate(project(), { requested: true }), {
      ...test.context,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 200);
    await expect(running).rejects.toThrow("Cancelled");
  });
});

describe("the environment store", () => {
  it("reports missing, malformed and invalid files", async () => {
    expect(await readEnvironmentFile(project())).toEqual({ kind: "missing" });
    expect(await readEnvironmentFile(project({ [ENVIRONMENT_FILE]: "{ not json" }))).toEqual({
      kind: "invalid",
      problems: ["It isn't valid JSON."],
    });
    const state = await readEnvironmentFile(project({ [ENVIRONMENT_FILE]: "[]" }));
    expect(state.kind).toBe("invalid");
    expect((await readEnvironmentFile(project({ [ENVIRONMENT_FILE]: VALID }))).kind).toBe("valid");
  });

  it("an unreadable path is an error, not a missing file", async () => {
    const root = project();
    mkdirSync(path.join(root, ENVIRONMENT_FILE), { recursive: true });
    await expect(readEnvironmentFile(root)).rejects.toThrow();
  });

  it("the snapshot skips Git, dependencies and the environment folder", async () => {
    const root = project({
      ".git/config": "x",
      "node_modules/a/index.js": "x",
      ".luseen/environment/compose.yaml": "x",
      ".luseen/sdd/overview.md": "x",
    });
    expect([...(await snapshotFiles(root, ".luseen/environment")).keys()].sort()).toEqual([
      ".luseen/sdd/overview.md",
      "src/a.ts",
    ]);
  });
});
