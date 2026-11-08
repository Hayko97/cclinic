/** The environment step through the built binary, with a fake `claude`. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ENVIRONMENT_FILE = ".cclinic/environment/environment.json";

function binFolder(withClaude: boolean): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  if (withClaude) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
    chmodSync(path.join(folder, "claude"), 0o755);
  }
  return folder;
}

interface Recorded {
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string | null>;
  readonly prompt: string;
}

function cclinic(args: readonly string[], options: { noClaude?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const home = makeTempFolder();
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...args], {
    cwd: makeTempFolder(),
    encoding: "utf8",
    env: {
      PATH: `${binFolder(options.noClaude !== true)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "c"),
      ...options.env,
    },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { "src/a.ts": "export const a = 1;\n" });
  return root;
}

function recorder(): { env: NodeJS.ProcessEnv; agentCalls: () => Recorded[] } {
  const record = path.join(makeTempFolder(), "calls.jsonl");
  return {
    env: { FAKE_CLAUDE_RECORD: record },
    agentCalls: () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Recorded)
            .filter((call) => !call.args.includes("--json-schema"))
        : [],
  };
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  return result.stdout;
}

describe("during setup", () => {
  it.each([["--yes"], ["--yes --json"], ["--yes --quiet"]])("TC-ENV-005: %s doesn't start the step", (flags) => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code, stdout } = cclinic([root, ...flags.split(" ")], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toEqual([]);
    if (flags.includes("json")) {
      expect((JSON.parse(stdout) as { environment: { status: string } }).environment.status).toBe("not-started");
    } else {
      expect(stdout).toContain("Use the devops skill");
    }
  });

  it("TC-ENV-006: --yes --environment starts it without asking", () => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code, stdout } = cclinic([root, "--yes", "--environment"], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toHaveLength(1);
    expect(stdout).toContain("http://sample.localhost:3000");
  });

  it.each([["--no-environment"], ["--no-skills"], ["--dry-run"]])("TC-ENV-007: %s skips it", (flag) => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code, stdout } = cclinic([root, "--yes", flag], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toEqual([]);
    expect(stdout).not.toContain("devops skill");
  });

  it.each([["--no-environment"], ["--no-skills"]])("TC-ENV-008: --environment with %s is a usage error", (flag) => {
    const root = project();
    expect(cclinic([root, "--environment", flag]).code).toBe(2);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
  });

  it("TC-ENV-009: cclinic environment works with no documents", () => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code } = cclinic(["environment", root, "--yes"], { env });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".agents/skills/devops/SKILL.md"))).toBe(true);
    expect(agentCalls()).toHaveLength(1);
    expect(existsSync(path.join(root, ".cclinic/sdd"))).toBe(false);
  });

  it("TC-ENV-010: the command passes its options, and prints JSON", () => {
    const { env, agentCalls } = recorder();
    const { code, stdout } = cclinic(
      ["environment", project(), "--yes", "--model", "opus", "--effort", "high", "--max-budget-usd", "1", "--json"],
      { env },
    );
    expect(code).toBe(0);
    const { args } = agentCalls()[0] as Recorded;
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(Number(args[args.indexOf("--max-budget-usd") + 1])).toBe(1);
    const parsed = JSON.parse(stdout) as { environment: { status: string; file: { alias: string } } };
    expect(parsed.environment.status).toBe("ready");
    expect(parsed.environment.file.alias).toBe("sample");
  });

  it("TC-ENV-011: without the Claude CLI, it prints the sentence and starts nothing", () => {
    const noClaude = project();
    const first = cclinic(["environment", noClaude, "--yes"], { noClaude: true });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Use the devops skill");
    expect(existsSync(path.join(noClaude, ENVIRONMENT_FILE))).toBe(false);

    const { env, agentCalls } = recorder();
    const api = cclinic(["environment", project(), "--yes"], { env: { ...env, CCLINIC_PROVIDER: "anthropic-api" } });
    expect(api.code).toBe(0);
    expect(api.stdout).toContain("Use the devops skill");
    expect(agentCalls()).toEqual([]);
  });

  it("TC-ENV-012: Claude runs in the target, with no API key, and the chosen settings", () => {
    const root = project();
    const { env, agentCalls } = recorder();
    cclinic(["environment", root, "--yes"], {
      env: { ...env, ANTHROPIC_API_KEY: "sk-ant-fake", FAKE_CLAUDE_LOGGED_OUT: undefined },
    });
    const call = agentCalls()[0] as Recorded;
    expect(path.basename(call.cwd)).toBe(path.basename(root));
    expect(call.env["ANTHROPIC_API_KEY"]).toBeNull();
    expect(call.args).toContain("--safe-mode");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(call.args[call.args.indexOf("--effort") + 1]).toBe("medium");
    expect(call.prompt).toContain("Set up the local environment");
  });

  it("uses the built-in instructions, even if the project has its own devops skill", () => {
    const root = project();
    writeProject(root, { ".agents/skills/devops/SKILL.md": "---\nname: devops\n---\nDELETE-EVERYTHING\n" });
    const { env, agentCalls } = recorder();
    cclinic(["environment", root, "--yes"], { env });
    expect((agentCalls()[0] as Recorded).prompt).not.toContain("DELETE-EVERYTHING");
    expect(readFileSync(path.join(root, ".agents/skills/devops/SKILL.md"), "utf8")).toContain("DELETE-EVERYTHING");
  });

  it("TC-ENV-015: the budget is the option, or else the default", () => {
    const first = recorder();
    cclinic(["environment", project(), "--yes", "--max-budget-usd", "1"], { env: first.env });
    const second = recorder();
    cclinic(["environment", project(), "--yes"], { env: second.env });
    const budget = (call: Recorded): number => Number(call.args[call.args.indexOf("--max-budget-usd") + 1]);
    expect(budget(first.agentCalls()[0] as Recorded)).toBe(1);
    expect(budget(second.agentCalls()[0] as Recorded)).toBe(2);
  });

  it("TC-ENV-017: a valid file exits 0, and shows how to review", () => {
    const { code, stdout } = cclinic(["environment", project(), "--yes"]);
    expect(code).toBe(0);
    for (const text of [
      "http://sample.localhost:3000",
      "http://localhost:3000",
      "docker compose down",
      "Open the link",
    ]) {
      expect(stdout).toContain(text);
    }
  });

  it.each([
    ["fail", 4],
    ["invalid", 5],
    ["none", 5],
  ])("TC-ENV-018: %s exits with %i", (outcome, expected) => {
    const { code, stderr } = cclinic(["environment", project(), "--yes"], {
      env: { FAKE_CLAUDE_ENVIRONMENT: outcome },
    });
    expect(code).toBe(expected);
    if (outcome === "none") expect(stderr).toContain("I couldn't tell what runs here");
  });

  it.each([["fail"], ["invalid"], ["none"]])("TC-ENV-019: in a generation run, %s only warns", (outcome) => {
    const root = project();
    const { code, stderr } = cclinic([root, "--yes", "--environment"], { env: { FAKE_CLAUDE_ENVIRONMENT: outcome } });
    expect(code).toBe(0);
    expect(stderr).toContain("Couldn't set up the local environment");
    expect(existsSync(path.join(root, ".cclinic/sdd/README.md"))).toBe(true);
  });

  it.each([[true], [false]])("TC-ENV-020: names files changed outside the folder, with Git: %s", (withGit) => {
    const root = project();
    if (withGit) git(root, "init", "-q");
    const { stderr } = cclinic(["environment", root, "--yes"], {
      env: { FAKE_CLAUDE_ALSO_WRITE: "src/a.ts,b.txt" },
    });
    expect(stderr).toContain("src/a.ts");
    expect(stderr).toContain("b.txt");
    expect(stderr).not.toContain("environment.json");
  });

  it("TC-ENV-021: a valid file means no Claude, and TC-ENV-022: --force sets it up again", () => {
    const root = project();
    cclinic(["environment", root, "--yes"]);
    const second = recorder();
    const { code, stdout } = cclinic(["environment", root, "--yes"], { env: second.env });
    expect(code).toBe(0);
    expect(second.agentCalls()).toEqual([]);
    expect(stdout).toContain("http://sample.localhost:3000");
    const third = recorder();
    cclinic(["environment", root, "--yes", "--force"], { env: third.env });
    expect(third.agentCalls()).toHaveLength(1);
  });

  it("TC-ENV-052: an invalid file is reported, and set up again", () => {
    const root = project();
    mkdirSync(path.join(root, ".cclinic/environment"), { recursive: true });
    writeFileSync(path.join(root, ENVIRONMENT_FILE), "{ not json");
    const { env, agentCalls } = recorder();
    const { stderr } = cclinic(["environment", root, "--yes"], { env });
    expect(stderr).toContain("isn't valid");
    expect(agentCalls()).toHaveLength(1);
  });

  it("TC-ENV-023: the environment folder causes no reprocessing and no hand-edit refusal", () => {
    const root = project();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Add code");
    expect(cclinic([root, "--yes", "--no-environment"]).code).toBe(0);
    const out = path.join(root, ".cclinic/sdd/overview.md");
    const before = readFileSync(out, "utf8");
    cclinic(["environment", root, "--yes"]);
    git(root, "add", ".cclinic/environment");
    git(root, "commit", "-qm", "Add environment");
    const { env, agentCalls } = recorder();
    const record = env["FAKE_CLAUDE_RECORD"] ?? "";
    const { code } = cclinic([root, "--yes"], { env });
    expect(code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(agentCalls()).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe(before);
  });

  it("TC-ENV-048: the step makes no commits", () => {
    const root = project();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Add code");
    const before = git(root, "rev-list", "--count", "HEAD");
    expect(cclinic(["environment", root, "--yes"]).code).toBe(0);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe(before);
  });

  it("help lists the command, and a typo is suggested", () => {
    expect(cclinic(["--help"]).stdout).toContain("environment");
    expect(cclinic(["help", "environment"]).stdout).toContain("Examples:");
    expect(cclinic(["enviroment"]).stderr).toContain('"cclinic environment"');
  });
});
