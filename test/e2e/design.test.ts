/** The design step through the built binary, with a fake `claude` (spec: ui-design). */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DESIGN = ".luseen/design";

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

function luseen(args: readonly string[], options: { noClaude?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const home = makeTempFolder();
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/luseen.js"), ...args], {
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

describe("design step", () => {
  it.each([["--yes"], ["--yes --json"], ["--yes --quiet"]])("TC-DSGN-025: %s doesn't start the step", (flags) => {
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen([project(), ...flags.split(" ")], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toEqual([]);
    if (flags.includes("json")) {
      expect((JSON.parse(stdout) as { design: { status: string } }).design.status).toBe("not-started");
    } else if (!flags.includes("quiet")) {
      expect(stdout).toContain("Use the ui-design skill");
    }
  });

  it("TC-DSGN-026: --yes --design starts it without asking", () => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen([root, "--yes", "--design"], { env });
    expect(code).toBe(0);
    expect(agentCalls().filter((call) => call.prompt.startsWith("Create the design system"))).toHaveLength(1);
    expect(stdout).toContain("Design system (draft):");
  });

  it.each([["--no-design"], ["--no-skills"], ["--dry-run"]])("TC-DSGN-027: %s skips it", (flag) => {
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen([project(), "--yes", flag], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toEqual([]);
    expect(stdout).not.toContain("ui-design skill");
  });

  it.each([["--no-design"], ["--no-skills"]])("TC-DSGN-028: --design with %s is a usage error", (flag) => {
    const root = project();
    expect(luseen([root, "--design", flag]).code).toBe(2);
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-DSGN-029: luseen design works with no documents", () => {
    const root = project();
    const { env, agentCalls } = recorder();
    const { code } = luseen(["design", root, "--yes"], { env });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".agents/skills/ui-design/SKILL.md"))).toBe(true);
    expect(agentCalls()).toHaveLength(1);
    expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);
  });

  it("TC-DSGN-030: the command passes its options, and prints JSON", () => {
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen(
      ["design", project(), "--yes", "--model", "opus", "--effort", "high", "--max-budget-usd", "1", "--json"],
      { env },
    );
    expect(code).toBe(0);
    const { args } = agentCalls()[0] as Recorded;
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(Number(args[args.indexOf("--max-budget-usd") + 1])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ design: { status: "ready", designStatus: "draft" } });
  });

  it("TC-DSGN-031: without the Claude CLI, or with the API, it prints the sentence and starts nothing", () => {
    const noClaude = project();
    const first = luseen(["design", noClaude, "--yes"], { noClaude: true });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Use the ui-design skill");
    expect(existsSync(path.join(noClaude, DESIGN))).toBe(false);

    const { env, agentCalls } = recorder();
    const api = luseen(["design", project(), "--yes"], { env: { ...env, LUSEEN_PROVIDER: "anthropic-api" } });
    expect(api.code).toBe(0);
    expect(api.stdout).toContain("Use the ui-design skill");
    expect(agentCalls()).toEqual([]);
  });

  it("TC-DSGN-032: Claude runs in the target, with no API key, limited tools and the built-in instructions", () => {
    const root = project();
    writeProject(root, { ".agents/skills/ui-design/SKILL.md": "---\nname: ui-design\n---\nDELETE-EVERYTHING\n" });
    const { env, agentCalls } = recorder();
    luseen(["design", root, "--yes"], { env: { ...env, ANTHROPIC_API_KEY: "sk-ant-fake" } });
    const call = agentCalls()[0] as Recorded;
    expect(path.basename(call.cwd)).toBe(path.basename(root));
    expect(call.env["ANTHROPIC_API_KEY"]).toBeNull();
    expect(call.args).toContain("--safe-mode");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(call.args[call.args.indexOf("--effort") + 1]).toBe("medium");
    expect(call.args).toContain("Write(./.luseen/design/**)");
    expect(call.args).not.toContain("Bash(npm *)");
    expect(call.prompt).toContain("Nobody can answer questions in this run");
    expect(call.prompt).toContain("# Design the user interface");
    expect(call.prompt).not.toContain("DELETE-EVERYTHING");
  });

  it("TC-DSGN-032: Claude is given no shell tool, and reading secret files is denied", () => {
    const { env, agentCalls } = recorder();
    luseen(["design", project(), "--yes"], { env });
    const { args } = agentCalls()[0] as Recorded;
    const tools = args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools"));
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((tool) => tool.startsWith("Bash"))).toBe(false);
    expect(allowed.some((tool) => tool.startsWith("Bash"))).toBe(false);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toContain("Read(**/.env)");
  });

  it("TC-DSGN-035: the budget is the option, or else the default", () => {
    const first = recorder();
    luseen(["design", project(), "--yes", "--max-budget-usd", "1"], { env: first.env });
    const second = recorder();
    luseen(["design", project(), "--yes"], { env: second.env });
    const budget = (call: Recorded): number => Number(call.args[call.args.indexOf("--max-budget-usd") + 1]);
    expect(budget(first.agentCalls()[0] as Recorded)).toBe(1);
    expect(budget(second.agentCalls()[0] as Recorded)).toBe(2);
  });

  it("TC-DSGN-037: a valid design system exits 0, and shows its paths and status", () => {
    const { code, stdout } = luseen(["design", project(), "--yes"]);
    expect(code).toBe(0);
    for (const text of [
      "Design system (draft):",
      ".luseen/design/design-system.md",
      ".luseen/design/design.tokens.json",
      ".luseen/design/style-guide.html",
    ])
      expect(stdout).toContain(text);
  });

  it.each([
    ["fail", 4, "Server error"],
    ["invalid", 5, "isn't valid JSON"],
  ])("TC-DSGN-038: %s exits with %i", (outcome, expected, cause) => {
    const { code, stderr } = luseen(["design", project(), "--yes"], { env: { FAKE_CLAUDE_DESIGN: outcome } });
    expect(code).toBe(expected);
    expect(stderr).toContain(cause);
  });

  it("TC-DSGN-039: in a generation run, a failure only warns", () => {
    const root = project();
    const { code, stderr } = luseen([root, "--yes", "--design"], { env: { FAKE_CLAUDE_DESIGN: "fail" } });
    expect(code).toBe(0);
    expect(stderr).toContain("Couldn't create the design system");
    expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
  });

  it("TC-DSGN-040: names files changed outside the design folder, skipping dependencies", () => {
    const root = project();
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const { stderr } = luseen(["design", root, "--yes"], {
      env: { FAKE_CLAUDE_ALSO_WRITE: "src/app.css,node_modules/x.js" },
    });
    expect(stderr).toContain("src/app.css");
    expect(stderr).not.toContain("node_modules/x.js");
    expect(stderr).not.toContain("design-system.md");
  });

  it("TC-DSGN-041: a valid design system means no Claude", () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen(["design", root, "--yes"], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toEqual([]);
    expect(stdout).toContain("Design system (draft):");
  });

  it("TC-DSGN-042: --force replaces a valid design, and restores the old one when the new one is invalid", () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const markdown = path.join(root, DESIGN, "design-system.md");
    writeFileSync(markdown, `${readFileSync(markdown, "utf8")}\nOld marker.\n`);
    const old = readFileSync(markdown, "utf8");

    const failed = luseen(["design", root, "--yes", "--force"], { env: { FAKE_CLAUDE_DESIGN: "invalid" } });
    expect(failed.code).toBe(5);
    expect(readFileSync(markdown, "utf8")).toBe(old);
    expect(existsSync(path.join(root, DESIGN, "previous"))).toBe(false);

    const { env, agentCalls } = recorder();
    expect(luseen(["design", root, "--yes", "--force"], { env }).code).toBe(0);
    expect(agentCalls()).toHaveLength(1);
    expect(readFileSync(markdown, "utf8")).not.toContain("Old marker.");
    expect(existsSync(path.join(root, DESIGN, "previous"))).toBe(false);
  });

  it.each([
    ["invalid", 5],
    ["fail", 4],
  ])("TC-DSGN-042: --force with a %s run restores every old file unchanged, and exits %i", (outcome, expected) => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const folder = path.join(root, DESIGN);
    writeFileSync(
      path.join(folder, "design-system.md"),
      `${readFileSync(path.join(folder, "design-system.md"), "utf8")}\nOld.\n`,
    );
    writeFileSync(path.join(folder, "notes.md"), "Mine.\n");
    const snapshot = () =>
      Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(path.join(folder, name), "utf8")]));
    const before = snapshot();
    const { code } = luseen(["design", root, "--yes", "--force"], { env: { FAKE_CLAUDE_DESIGN: outcome } });
    expect(code).toBe(expected);
    expect(snapshot()).toEqual(before);
  });

  it("TC-DSGN-043: the design folder causes no reprocessing and no hand-edit refusal", () => {
    const root = project();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Add code");
    expect(luseen([root, "--yes", "--no-design"]).code).toBe(0);
    const overview = path.join(root, ".luseen/sdd/overview.md");
    const before = readFileSync(overview, "utf8");
    luseen(["design", root, "--yes"]);
    writeFileSync(path.join(root, DESIGN, "notes.md"), "A change.\n");
    git(root, "add", DESIGN);
    git(root, "commit", "-qm", "Add design");
    const { env, agentCalls } = recorder();
    const record = env["FAKE_CLAUDE_RECORD"] ?? "";
    const { code } = luseen([root, "--yes"], { env });
    expect(code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(agentCalls()).toEqual([]);
    expect(readFileSync(overview, "utf8")).toBe(before);
  });

  it("TC-DSGN-044: the step makes no commits and stages nothing", () => {
    const root = project();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "Add code");
    const before = git(root, "rev-list", "--count", "HEAD");
    expect(luseen(["design", root, "--yes"]).code).toBe(0);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe(before);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  it("TC-DSGN-054: a hand-broken design system is reported, never overwritten without --force", () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const tokens = path.join(root, DESIGN, "design.tokens.json");
    writeFileSync(tokens, "{ broken by hand");
    const markdown = path.join(root, DESIGN, "design-system.md");
    writeFileSync(markdown, `${readFileSync(markdown, "utf8")}\nMy edit.\n`);
    const before = readFileSync(markdown, "utf8");

    const first = recorder();
    const command = luseen(["design", root, "--yes"], { env: first.env });
    expect(command.code).toBe(5);
    expect(command.stderr).toContain("isn't valid JSON");
    expect(command.stderr).toContain("luseen design --force");
    expect(first.agentCalls()).toEqual([]);

    const second = recorder();
    const generation = luseen([root, "--yes", "--design"], { env: second.env });
    expect(generation.code).toBe(0);
    expect(generation.stderr).toContain("isn't a complete design system");
    expect(second.agentCalls().filter((call) => call.prompt.startsWith("Create the design system"))).toEqual([]);
    expect(readFileSync(markdown, "utf8")).toBe(before);
    expect(readFileSync(tokens, "utf8")).toBe("{ broken by hand");
  });

  it("TC-DSGN-055: a design set aside by a killed --force run is put back", () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const folder = path.join(root, DESIGN);
    const original = readFileSync(path.join(folder, "design-system.md"), "utf8");
    mkdirSync(path.join(folder, "previous"));
    for (const file of ["design-system.md", "design.tokens.json", "style-guide.html"])
      renameSync(path.join(folder, file), path.join(folder, "previous", file));
    writeFileSync(path.join(folder, "design-system.md"), "# Half written\n");

    const { env, agentCalls } = recorder();
    const { code, stdout, stderr } = luseen(["design", root, "--yes"], { env });
    expect(code).toBe(0);
    expect(stderr).toContain("an interrupted run had set aside");
    expect(stdout).toContain("Design system (draft):");
    expect(agentCalls()).toEqual([]);
    expect(readFileSync(path.join(folder, "design-system.md"), "utf8")).toBe(original);
    expect(existsSync(path.join(folder, "previous"))).toBe(false);
  });

  it("TC-DSGN-058: a second run while --force is running is refused, and the original design survives", async () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const markdown = path.join(root, DESIGN, "design-system.md");
    writeFileSync(markdown, `${readFileSync(markdown, "utf8")}\nOriginal marker.\n`);
    const original = readFileSync(markdown, "utf8");
    const home = makeTempFolder();
    const running = spawn(process.execPath, [path.join(REPO, "bin/luseen.js"), "design", root, "--yes", "--force"], {
      env: {
        PATH: `${binFolder(true)}:/usr/bin:/bin`,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "c"),
        FAKE_CLAUDE_MODE: "hang",
      },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => running.on("exit", resolve));
    for (let waitedMs = 0; !existsSync(path.join(root, DESIGN, "previous")) && waitedMs < 10_000; waitedMs += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(path.join(root, DESIGN, "previous"))).toBe(true);

    const second = luseen(["design", root, "--yes"]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("already working on this folder");
    expect(existsSync(path.join(root, DESIGN, "previous", "design-system.md"))).toBe(true);

    running.kill("SIGTERM");
    await exited;
    expect(readFileSync(markdown, "utf8")).toBe(original);
    expect(existsSync(path.join(root, DESIGN, "previous"))).toBe(false);
  });

  it("TC-DSGN-059: a design folder with files but no design-system.md is reported, and kept by --force", () => {
    const root = project();
    const tokens = path.join(root, DESIGN, "design.tokens.json");
    mkdirSync(path.dirname(tokens), { recursive: true });
    writeFileSync(tokens, '{"mine":{"$type":"color","ink":{"$value":"#000"}}}');

    const { env, agentCalls } = recorder();
    const refused = luseen(["design", root, "--yes"], { env });
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("design-system.md is missing");
    expect(agentCalls()).toEqual([]);

    const failed = luseen(["design", root, "--yes", "--force"], { env: { FAKE_CLAUDE_DESIGN: "invalid" } });
    expect(failed.code).toBe(5);
    expect(readFileSync(tokens, "utf8")).toBe('{"mine":{"$type":"color","ink":{"$value":"#000"}}}');
    expect(readdirSync(path.join(root, DESIGN))).toEqual(["design.tokens.json"]);
  });

  it("TC-DSGN-060: a failed first run leaves nothing, so the next run needs no --force", () => {
    const root = project();
    expect(luseen(["design", root, "--yes"], { env: { FAKE_CLAUDE_DESIGN: "fail" } }).code).toBe(4);
    expect(existsSync(path.join(root, DESIGN))).toBe(false);
    expect(luseen(["design", root, "--yes"], { env: { FAKE_CLAUDE_DESIGN: "invalid" } }).code).toBe(5);
    expect(existsSync(path.join(root, DESIGN))).toBe(false);
    const { code, stdout } = luseen(["design", root, "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Design system (draft):");
  });

  it("TC-DSGN-061: a failed first run in a generation run warns and leaves no files", () => {
    const root = project();
    const { code, stderr } = luseen([root, "--yes", "--design"], { env: { FAKE_CLAUDE_DESIGN: "invalid" } });
    expect(code).toBe(0);
    expect(stderr).toContain("Couldn't create the design system");
    expect(existsSync(path.join(root, DESIGN))).toBe(false);
  });

  it("TC-DSGN-062: when Claude writes nothing, the project has no user interface, and the run succeeds", () => {
    const env = { FAKE_CLAUDE_DESIGN: "none" };
    const text = luseen(["design", project(), "--yes"], { env });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("found no user interface");
    expect(text.stdout).toContain("I couldn't finish the design system");

    const json = luseen(["design", project(), "--yes", "--json"], { env });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ design: { status: "no-ui" } });

    const generation = luseen([project(), "--yes", "--design"], { env });
    expect(generation.code).toBe(0);
    expect(generation.stdout).toContain("found no user interface");
    expect(generation.stderr).not.toContain("Couldn't create the design system");
  });

  it.each([
    ["a .DS_Store file", ".DS_Store"],
    ["an empty folder", "empty/"],
  ])("TC-DSGN-063: a design folder holding only %s counts as no design system", (_label, entry) => {
    const root = project();
    const folder = path.join(root, DESIGN);
    if (entry.endsWith("/")) mkdirSync(path.join(folder, entry), { recursive: true });
    else {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, entry), "");
    }
    const { env, agentCalls } = recorder();
    const { code, stdout } = luseen(["design", root, "--yes"], { env });
    expect(code).toBe(0);
    expect(agentCalls()).toHaveLength(1);
    expect(stdout).toContain("Design system (draft):");
  });

  it("TC-DSGN-064: --force where Claude writes nothing reports no user interface, and keeps the old design", () => {
    const root = project();
    luseen(["design", root, "--yes"]);
    const markdown = path.join(root, DESIGN, "design-system.md");
    writeFileSync(markdown, `${readFileSync(markdown, "utf8")}\nOriginal marker.\n`);
    const original = readFileSync(markdown, "utf8");
    const env = { FAKE_CLAUDE_DESIGN: "none" };

    const text = luseen(["design", root, "--yes", "--force"], { env });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("found no user interface");
    const json = luseen(["design", root, "--yes", "--force", "--json"], { env });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ design: { status: "no-ui" } });
    expect(readFileSync(markdown, "utf8")).toBe(original);
    expect(existsSync(path.join(root, DESIGN, "previous"))).toBe(false);
  });

  it("TC-DSGN-040: a change in the environment folder is named too", () => {
    const root = project();
    mkdirSync(path.join(root, ".luseen/environment"), { recursive: true });
    const { stderr } = luseen(["design", root, "--yes"], {
      env: { FAKE_CLAUDE_ALSO_WRITE: ".luseen/environment/notes.txt" },
    });
    expect(stderr).toContain(".luseen/environment/notes.txt");
  });

  it("TC-DSGN-060: a failed first run that wrote inside an existing empty folder leaves only what was there", () => {
    const root = project();
    mkdirSync(path.join(root, DESIGN, "components"), { recursive: true });
    writeFileSync(path.join(root, DESIGN, ".DS_Store"), "");
    const failed = luseen(["design", root, "--yes"], {
      env: { FAKE_CLAUDE_DESIGN: "invalid", FAKE_CLAUDE_ALSO_WRITE: `${DESIGN}/components/button.md` },
    });
    expect(failed.code).toBe(5);
    expect(readdirSync(path.join(root, DESIGN)).sort()).toEqual([".DS_Store", "components"]);
    expect(readdirSync(path.join(root, DESIGN, "components"))).toEqual([]);
    const { code, stdout } = luseen(["design", root, "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Design system (draft):");
  });

  it.each([
    ["fail", 4],
    ["invalid", 5],
  ])("TC-DSGN-065: a failed first run (%s) keeps the user's files in subfolders", (outcome, expected) => {
    const root = project();
    const icons = path.join(root, DESIGN, "icons");
    mkdirSync(icons, { recursive: true });
    writeFileSync(path.join(icons, ".gitkeep"), "keep me");
    writeFileSync(path.join(icons, ".draft-notes.md"), "my notes");
    const { code } = luseen(["design", root, "--yes"], {
      env: { FAKE_CLAUDE_DESIGN: outcome, FAKE_CLAUDE_ALSO_WRITE: `${DESIGN}/icons/logo.svg` },
    });
    expect(code).toBe(expected);
    expect(readdirSync(icons).sort()).toEqual([".draft-notes.md", ".gitkeep"]);
    expect(readFileSync(path.join(icons, ".gitkeep"), "utf8")).toBe("keep me");
    expect(readdirSync(path.join(root, DESIGN))).toEqual(["icons"]);
  });

  it("help lists the command", () => {
    expect(luseen(["--help"]).stdout).toContain("design");
    expect(luseen(["help", "design"]).stdout).toContain("Examples:");
  });
});
