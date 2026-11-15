/** Runs the built binary to check the Luseen names, and the move over from cclinic (FR-CLI-032 to FR-CLI-037). */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BIN = path.join(REPO, "bin/luseen.js");
const FAKE = path.join(REPO, "test/fixtures/fake-claude/claude");

interface RunOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function pathFolder(): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  copyFileSync(FAKE, path.join(folder, "claude"));
  chmodSync(path.join(folder, "claude"), 0o755);
  return folder;
}

function luseen(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<RunOutput> {
  const home = makeTempFolder();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: makeTempFolder(),
      env: { PATH: pathFolder(), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function sampleProject(): string {
  const root = makeTempFolder();
  writeProject(root, { "src/app.ts": "export const a = 1;\n", "package.json": "{}\n" });
  return root;
}

/** A project as cclinic left it: one task in its database, a document, and an ignore file. */
async function cclinicProject(): Promise<string> {
  const root = sampleProject();
  expect((await luseen(["tasks", "add", "--title", "Carry me over", "-C", root])).code).toBe(0);
  writeProject(root, { ".luseen/sdd/README.md": "# Specs\n", ".luseenignore": "docs/\n" });
  renameSync(path.join(root, ".luseen"), path.join(root, ".cclinic"));
  renameSync(path.join(root, ".luseenignore"), path.join(root, ".cclinicignore"));
  return root;
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("the Luseen name", () => {
  it("TC-CLI-063: the package, output and installed files never say cclinic", async () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };
    expect(pkg.name).toBe("luseen");
    expect(pkg.bin).toEqual({ luseen: "bin/luseen.js" });

    const root = sampleProject();
    const runs = [await luseen(["--help"]), await luseen(["guide"]), await luseen(["skills", root])];
    for (const run of runs) {
      expect(run.code).toBe(0);
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/cclinic/i);
    }
    for (const file of filesUnder(root)) expect(readFileSync(file, "utf8"), file).not.toMatch(/cclinic/i);
    const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers).toEqual({ luseen: { command: "npx", args: ["luseen", "mcp"] } });
    expect(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).toContain('"mcp__luseen__.*"');
  });

  it("TC-CLI-065: LUSEEN_MODEL chooses the model", async () => {
    const { code, stdout } = await luseen([sampleProject(), "--dry-run", "--yes"], { LUSEEN_MODEL: "haiku" });
    expect(code).toBe(0);
    expect(stdout).toContain("Haiku");
  });
});

describe("moving a project over from cclinic", () => {
  it("TC-CLI-066: the first command moves the folder and ignore file, and keeps every task", async () => {
    const root = await cclinicProject();
    const { code, stdout, stderr } = await luseen(["tasks", "list", "--json", "-C", root]);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
    expect(existsSync(path.join(root, ".cclinicignore"))).toBe(false);
    expect(readFileSync(path.join(root, ".luseen/sdd/README.md"), "utf8")).toBe("# Specs\n");
    expect(readFileSync(path.join(root, ".luseenignore"), "utf8")).toBe("docs/\n");
    expect(stdout).toContain("Carry me over");
    const lines = stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\.cclinic to \.luseen and \.cclinicignore to \.luseenignore.*Commit/);
  });

  it("TC-CLI-067: --dry-run only says what it would move", async () => {
    const root = await cclinicProject();
    const { code, stderr } = await luseen([root, "--dry-run", "--yes"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/Would move \.cclinic to \.luseen and \.cclinicignore to \.luseenignore/);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(true);
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-CLI-068: a running cclinic process stops the move", async () => {
    const root = await cclinicProject();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30_000)"]);
    try {
      writeProject(root, { ".cclinic/gui/gui.lock": JSON.stringify({ pid: sleeper.pid }) });
      const { code, stderr } = await luseen(["tasks", "list", "-C", root]);
      expect(code).toBe(2);
      expect(stderr).toContain(".cclinic/gui/gui.lock");
      expect(existsSync(path.join(root, ".cclinic"))).toBe(true);
      expect(existsSync(path.join(root, ".luseen"))).toBe(false);
    } finally {
      sleeper.kill();
    }
  });

  it("TC-CLI-069: a lock left by a process that has ended doesn't stop the move", async () => {
    const root = await cclinicProject();
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    writeProject(root, { ".cclinic/.lock": JSON.stringify({ pid: Number(ended) }) });
    const { code } = await luseen(["tasks", "list", "-C", root]);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
    expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
  });

  it("TC-CLI-070: with both folders, nothing moves and only .luseen is used", async () => {
    const root = await cclinicProject();
    writeProject(root, { ".luseen/sdd/README.md": "# New\n" });
    for (let run = 0; run < 2; run += 1) {
      const { code, stdout, stderr } = await luseen(["tasks", "list", "--json", "-C", root]);
      expect(code).toBe(0);
      expect(stdout).not.toContain("Carry me over");
      expect(stderr).toContain(".cclinic/ is no longer read");
    }
    expect(readFileSync(path.join(root, ".cclinic/sdd/README.md"), "utf8")).toBe("# Specs\n");
    expect(readFileSync(path.join(root, ".luseen/sdd/README.md"), "utf8")).toBe("# New\n");
  });
});

/** Git on PATH next to node and the fake claude, for the cases that need a repository. */
function withGit(): Record<string, string> {
  const git = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  return { PATH: `${pathFolder()}${path.delimiter}${path.dirname(git)}` };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
  }).toString();
}

/** The files cclinic 0.1.1 installed, apart from the Claude Code settings. */
function cclinicInstall(root: string): void {
  const skill = readFileSync(path.join(REPO, ".agents/skills/write-code/SKILL.md"), "utf8");
  const unstamped = skill
    .replace("generated-by: luseen", "generated-by: cclinic")
    .replace(/^ {2}content-hash: "[^"]*"$/m, '  content-hash: ""');
  const hash = execFileSync("shasum", ["-a", "256"], { input: unstamped }).toString().split(" ")[0] ?? "";
  writeProject(root, {
    ".agents/skills/write-code/SKILL.md": unstamped.replace('content-hash: ""', `content-hash: "${hash}"`),
    "AGENTS.md": "# Mine\n\n<!-- cclinic:start -->\nold\n<!-- cclinic:end -->\n",
    "CLAUDE.md": "<!-- cclinic:start -->\n@AGENTS.md\n<!-- cclinic:end -->\n",
    ".mcp.json": JSON.stringify({ mcpServers: { cclinic: { command: "npx", args: ["cclinic", "mcp"] } } }),
  });
}

describe("moving a project's runs and agent setup over from cclinic", () => {
  it("TC-CLI-076: auto-run worktrees keep working, and run files stay out of git status", async () => {
    const root = sampleProject();
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "start");
    git(root, "worktree", "add", "-q", ".cclinic/auto/r1/worktrees/run", "-b", "luseen/auto/r1");
    writeProject(root, { ".git/info/exclude": "/.cclinic/auto/\n" });

    const { code, stderr } = await luseen(["tasks", "list", "-C", root], withGit());
    expect(code, stderr).toBe(0);
    const moved = path.join(root, ".luseen/auto/r1/worktrees/run");
    expect(existsSync(moved)).toBe(true);
    git(moved, "status");
    const list = git(root, "worktree", "list", "--porcelain");
    expect(list).toContain(
      `worktree ${path.join(execFileSync("realpath", [root]).toString().trim(), ".luseen/auto/r1/worktrees/run")}`,
    );
    expect(list).not.toContain("prunable");
    expect(readFileSync(path.join(root, ".git/info/exclude"), "utf8").split("\n")).toContain("/.luseen/auto/");
    expect(git(root, "status", "--porcelain")).not.toContain(".luseen/auto");
  });

  it("TC-CLI-078: cclinic's section, skills and server are updated, and no new file appears", async () => {
    const root = await cclinicProject();
    cclinicInstall(root);
    const dry = await cclinicProject();
    cclinicInstall(dry);
    const before = readFileSync(path.join(dry, "AGENTS.md"), "utf8");
    const preview = await luseen([dry, "--dry-run", "--yes"]);
    expect(preview.stderr).toMatch(/Would move .* and update .*AGENTS\.md/);
    expect(readFileSync(path.join(dry, "AGENTS.md"), "utf8")).toBe(before);

    const { code, stderr } = await luseen(["tasks", "list", "-C", root]);
    expect(code).toBe(0);
    for (const file of ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".agents/skills/write-code/SKILL.md"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toContain("cclinic");
      expect(text, file).toContain("luseen");
      expect(stderr).toContain(file);
    }
    expect(existsSync(path.join(root, ".claude/settings.json"))).toBe(false);
    expect(existsSync(path.join(root, ".claude/skills"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "FR-CLI-033 QA (DEF-4): a failure after the move is reported, and the command still runs",
    async () => {
      const root = await cclinicProject();
      git(root, "init", "-q");
      writeProject(root, {
        ".cclinic/auto/r1/run.json": "{}",
        ".claude/settings.json": JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: "mcp__cclinic__.*", hooks: [{ type: "command", command: "npx cclinic session-link" }] },
            ],
          },
        }),
      });
      chmodSync(path.join(root, ".git/info/exclude"), 0o444);
      chmodSync(path.join(root, ".claude"), 0o555);
      try {
        const { code, stdout, stderr } = await luseen(["tasks", "list", "--json", "-C", root], withGit());
        expect(code, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ status: "success" });
        expect(stderr).toMatch(/Moved \.cclinic to \.luseen.*Commit the move\./);
        expect(stderr).toMatch(/Couldn't add \/\.luseen\/auto\/ to Git's info\/exclude .*add it by hand\./);
        expect(stderr).toMatch(/Couldn't update cclinic's files .*run `luseen skills`\./);
      } finally {
        chmodSync(path.join(root, ".claude"), 0o755);
      }
    },
  );

  it("TC-CLI-082: a project with its documents elsewhere keeps pointing at them", async () => {
    const root = await cclinicProject();
    const skill = readFileSync(path.join(REPO, ".agents/skills/refine-spec/SKILL.md"), "utf8");
    const unstamped = skill
      .replaceAll(".luseen/sdd", "docs/sdd")
      .replace("run `luseen` in the project root", "run `cclinic` in the project root")
      .replace("generated-by: luseen", "generated-by: cclinic")
      .replace(/^ {2}content-hash: "[^"]*"$/m, '  content-hash: ""');
    const hash = execFileSync("shasum", ["-a", "256"], { input: unstamped }).toString().split(" ")[0] ?? "";
    writeProject(root, {
      ".agents/skills/refine-spec/SKILL.md": unstamped.replace('content-hash: ""', `content-hash: "${hash}"`),
      "AGENTS.md":
        "<!-- cclinic:start -->\nSpecs are in `docs/sdd/specs/`, and `docs/sdd/README.md` lists them.\n<!-- cclinic:end -->\n",
    });
    const { code, stderr } = await luseen(["tasks", "list", "-C", root]);
    expect(code, stderr).toBe(0);
    for (const file of ["AGENTS.md", ".agents/skills/refine-spec/SKILL.md"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).toContain("docs/sdd");
      expect(text, file).not.toContain(".luseen/sdd");
    }
    expect(readFileSync(path.join(root, ".agents/skills/refine-spec/SKILL.md"), "utf8")).toContain(
      "generated-by: luseen",
    );
  });

  it("TC-CLI-079: a project with no agent setup gets none", async () => {
    const root = await cclinicProject();
    const { code } = await luseen(["tasks", "list", "-C", root]);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".luseen"))).toBe(true);
    for (const file of ["AGENTS.md", "CLAUDE.md", ".agents", ".claude", ".mcp.json"])
      expect(existsSync(path.join(root, file)), file).toBe(false);
  });
});

describe("carrying a user's settings over from cclinic", () => {
  it("TC-CLI-074: the saved model and limits are copied once, and the old folder is kept", async () => {
    const config = makeTempFolder();
    writeProject(config, {
      "cclinic/config.json": '{"model":"opus","effort":"medium"}\n',
      "cclinic/limits.json": '{"x":1}\n',
    });
    const env = { XDG_CONFIG_HOME: config };
    const first = await luseen(["model", "--list", "--json"], env);
    expect(first.code).toBe(0);
    expect((JSON.parse(first.stdout) as { current: unknown }).current).toEqual({ model: "opus", effort: "medium" });
    expect(first.stderr.trim().split("\n")).toHaveLength(1);
    expect(first.stderr).toContain("Copied your saved settings");
    for (const file of ["config.json", "limits.json"])
      expect(readFileSync(path.join(config, "luseen", file), "utf8")).toBe(
        readFileSync(path.join(config, "cclinic", file), "utf8"),
      );
    expect(readdirSync(path.join(config, "cclinic")).sort()).toEqual(["config.json", "limits.json"]);
    const second = await luseen(["model", "--list", "--json"], env);
    expect(second.stderr).not.toContain("Copied");
  });

  it("TC-CLI-075: an old variable is ignored and named, unless the new one is set", async () => {
    const config = makeTempFolder();
    writeProject(config, { "luseen/config.json": '{"model":"opus"}\n' });
    const project = sampleProject();
    const old = await luseen([project, "--dry-run", "--yes"], { XDG_CONFIG_HOME: config, CCLINIC_MODEL: "haiku" });
    expect(old.code).toBe(0);
    expect(old.stdout).toContain("Opus");
    expect(old.stderr.match(/CCLINIC_MODEL is no longer read\. Set LUSEEN_MODEL instead\./g)).toHaveLength(1);
    const both = await luseen([project, "--dry-run", "--yes"], {
      XDG_CONFIG_HOME: config,
      CCLINIC_MODEL: "haiku",
      LUSEEN_MODEL: "sonnet",
    });
    expect(both.stdout).toContain("Sonnet");
    expect(both.stderr).not.toContain("CCLINIC_MODEL");
  });
});
