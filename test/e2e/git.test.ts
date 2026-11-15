/** Git behaviour through the built binary, with a fake `claude` and real Git repositories. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function binFolder(): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
  chmodSync(path.join(folder, "claude"), 0o755);
  return folder;
}

interface Sandbox {
  readonly env: NodeJS.ProcessEnv;
  readonly gitConfig: string;
}

function sandbox(): Sandbox {
  const home = makeTempFolder();
  const gitConfig = path.join(home, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = Test Person\n\temail = test@example.com\n");
  return {
    gitConfig,
    env: {
      PATH: `${binFolder()}:${path.dirname(REAL_GIT)}`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "c"),
      GIT_CONFIG_GLOBAL: gitConfig,
    },
  };
}

function gitWrapper(script: string): string {
  const folder = makeTempFolder();
  writeFileSync(path.join(folder, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(folder, "git"), 0o755);
  return folder;
}

function luseen(args: readonly string[], box: Sandbox, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/luseen.js"), ...args], {
    cwd: makeTempFolder(),
    encoding: "utf8",
    env: { ...box.env, ...extra },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, box: Sandbox, ...args: readonly string[]): string {
  return execFileSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    env: { ...box.env, GIT_AUTHOR_NAME: "MARKER-AUTHOR", GIT_AUTHOR_EMAIL: "marker-email@example.com" },
  });
}

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = makeTempFolder();
  writeProject(root, { "src/a.ts": "export const a = 1;\n", ...files });
  return root;
}

function repositoryWithCommits(box: Sandbox, count = 1): string {
  const root = project();
  git(root, box, "init", "-q");
  git(root, box, "add", "-A");
  git(root, box, "commit", "-q", "-m", "Initial work");
  for (let index = 1; index < count; index += 1) {
    writeProject(root, { [`src/f${index}.ts`]: `export const f = ${index};\n` });
    git(root, box, "add", "-A");
    git(root, box, "commit", "-q", "-m", `Change ${index}`);
  }
  return root;
}

function calls(file: string): { prompt: string; watched: boolean | null }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as never);
}

describe("reporting status", () => {
  it("TC-GIT-002: --dry-run says what would happen, and changes nothing", () => {
    const root = project();
    const { code, stdout } = luseen([root, "--dry-run"], sandbox());
    expect(code).toBe(0);
    expect(stdout).toContain("a local one will be created");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("TC-GIT-003: the summary shows the commits used", () => {
    const box = sandbox();
    expect(luseen([repositoryWithCommits(box, 3), "--dry-run"], box).stdout).toContain(
      "3 commits from the last 14 days",
    );
  });

  it("TC-GIT-004: doctor reports each state, and stays ready", () => {
    const box = sandbox();
    const plain = project();
    const noRepository = luseen(["doctor", plain], box);
    expect(noRepository.code).toBe(0);
    expect(noRepository.stdout).toContain("Git repository: none");
    expect(existsSync(path.join(plain, ".git"))).toBe(false);

    const noRemote = luseen(["doctor", repositoryWithCommits(box)], box);
    expect(noRemote.code).toBe(0);
    expect(noRemote.stdout).toContain("Git remote: none");
    expect(noRemote.stdout).toContain("git remote add origin");

    const noGit = luseen(["doctor", project()], box, { PATH: binFolder() });
    expect(noGit.code).toBe(0);
    expect(noGit.stdout).toContain("Git: not installed");
  });
});

describe("setting up a repository", () => {
  it("TC-GIT-005: creates and reports a local repository", () => {
    const root = project();
    const { code, stderr, stdout } = luseen([root, "--yes"], sandbox());
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".git"))).toBe(true);
    expect(stderr).toContain("Created a local Git repository");
    expect(stdout).toContain("created a local repository");
  });

  it("TC-GIT-008: the repository exists before the first Claude call", () => {
    const root = project();
    const record = path.join(makeTempFolder(), "calls.jsonl");
    luseen([root, "--yes"], sandbox(), { FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_WATCH: path.join(root, ".git") });
    expect(calls(record)[0]?.watched).toBe(true);
  });

  it("TC-GIT-009: no nested repository inside a parent's", () => {
    const box = sandbox();
    const parent = repositoryWithCommits(box);
    const child = path.join(parent, "sub");
    mkdirSync(child);
    writeProject(child, { "b.ts": "b\n" });
    expect(luseen([child, "--yes"], box).code).toBe(0);
    expect(existsSync(path.join(child, ".git"))).toBe(false);
  });

  it("TC-GIT-010: nothing is staged or committed, and the global config is unchanged", () => {
    const box = sandbox();
    const before = readFileSync(box.gitConfig, "utf8");
    const root = project();
    luseen([root, "--yes"], box);
    expect(
      git(root, box, "status", "--porcelain")
        .split("\n")
        .filter((line) => /^[AMDRC]/.test(line)),
    ).toEqual([]);
    expect(() => git(root, box, "rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
    expect(readFileSync(box.gitConfig, "utf8")).toBe(before);
  });

  it("TC-GIT-011: recommends a .gitignore only when missing, and never creates one", () => {
    const without = project();
    expect(luseen([without, "--yes"], sandbox()).stdout).toContain("Add a .gitignore");
    expect(existsSync(path.join(without, ".gitignore"))).toBe(false);
    expect(luseen([project({ ".gitignore": "x\n" }), "--yes"], sandbox()).stdout).not.toContain("Add a .gitignore");
  });

  it("TC-GIT-012: --no-git leaves Git alone", () => {
    const box = sandbox();
    const plain = project();
    const { stdout } = luseen([plain, "--yes", "--no-git"], box);
    expect(existsSync(path.join(plain, ".git"))).toBe(false);
    expect(stdout).not.toContain("git remote add");

    const record = path.join(makeTempFolder(), "calls.jsonl");
    luseen([repositoryWithCommits(box), "--yes", "--no-git"], box, { FAKE_CLAUDE_RECORD: record });
    expect(calls(record).some((call) => call.prompt.includes("Initial work"))).toBe(false);
  });
});

describe("the remote alert", () => {
  it("TC-GIT-013: appears with no remote, and doesn't change the exit code", () => {
    const box = sandbox();
    const { code, stdout } = luseen([repositoryWithCommits(box), "--yes"], box);
    expect(code).toBe(0);
    for (const text of [
      "github.com/new",
      "gitlab.com/projects/new",
      "bitbucket.org/repo/create",
      "git remote add origin",
      "git push",
    ]) {
      expect(stdout).toContain(text);
    }
  });

  it("TC-GIT-014: doesn't appear with a remote", () => {
    const box = sandbox();
    const root = repositoryWithCommits(box);
    git(root, box, "remote", "add", "origin", "https://github.com/me/repo.git");
    expect(luseen([root, "--yes"], box).stdout).not.toContain("git remote add");
  });

  it("TC-GIT-015: luseen never adds a remote, stages, commits or pushes", () => {
    const log = path.join(makeTempFolder(), "git.log");
    const wrapper = gitWrapper(`echo "$@" >> "${log}"\nexec "${REAL_GIT}" "$@"`);
    const box = sandbox();
    const root = project();
    luseen([root, "--yes"], box, { PATH: `${wrapper}:${box.env["PATH"] ?? ""}` });
    const commands = readFileSync(log, "utf8");
    expect(commands).toContain("init");
    for (const forbidden of [" remote add", " push", " add ", " commit"]) expect(commands).not.toContain(forbidden);
  });

  it("TC-GIT-016: credentials in a remote URL appear nowhere", () => {
    const box = sandbox();
    const root = repositoryWithCommits(box);
    git(root, box, "remote", "add", "origin", "https://MARKER-TOKEN@github.com/me/repo.git");
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const run = luseen([root, "--yes", "--debug", "--json"], box, { FAKE_CLAUDE_RECORD: record });
    const doctor = luseen(["doctor", root], box);
    const everything = run.stdout + run.stderr + doctor.stdout + readFileSync(record, "utf8");
    expect(everything).not.toContain("MARKER-TOKEN");
    expect(run.stderr).toContain("origin (github.com)");
    expect(doctor.stdout).toContain("origin (github.com)");
    expect(calls(record).some((call) => call.prompt.includes("github.com"))).toBe(false);
  });
});

describe("history", () => {
  it("TC-GIT-019: diffs and authors never reach Claude", () => {
    const box = sandbox();
    const root = repositoryWithCommits(box);
    writeProject(root, { "src/secret.ts": "MARKER-DIFF\n" });
    git(root, box, "add", "-A");
    git(root, box, "commit", "-q", "-m", "Add thing");
    writeProject(root, { "src/secret.ts": "clean\n" });
    git(root, box, "add", "-A");
    git(root, box, "commit", "-q", "-m", "Remove thing");
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const { stdout, stderr } = luseen([root, "--yes", "--debug"], box, { FAKE_CLAUDE_RECORD: record });
    const prompts = calls(record)
      .map((call) => call.prompt)
      .join("\n");
    expect(prompts).toContain("Remove thing");
    for (const marker of ["MARKER-DIFF", "MARKER-AUTHOR", "marker-email"])
      expect(prompts + stdout + stderr).not.toContain(marker);
  });

  it("TC-GIT-025: history counts toward the token limit", () => {
    const box = sandbox();
    const root = project();
    git(root, box, "init", "-q");
    git(root, box, "add", "-A");
    git(root, box, "commit", "-q", "-m", `Big\n\n${"word ".repeat(4000)}`);
    const record = path.join(makeTempFolder(), "calls.jsonl");
    expect(luseen([root, "--dry-run", "--no-git", "--max-input-tokens", "1000"], box).code).toBe(0);
    expect(luseen([root, "--yes", "--max-input-tokens", "1000"], box, { FAKE_CLAUDE_RECORD: record }).code).toBe(2);
    expect(existsSync(record)).toBe(false);
  });

  it("TC-GIT-033: creating the repository doesn't cause reprocessing", () => {
    const box = sandbox();
    const root = project();
    expect(luseen([root, "--yes"], box).code).toBe(0);
    const record = path.join(makeTempFolder(), "calls.jsonl");
    expect(luseen([root, "--yes"], box, { FAKE_CLAUDE_RECORD: record }).code).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it("TC-GIT-034: committing luseen's output changes nothing", () => {
    const box = sandbox();
    const root = repositoryWithCommits(box);
    expect(luseen([root, "--yes"], box).code).toBe(0);
    const readme = readFileSync(path.join(root, ".luseen/sdd/README.md"), "utf8");
    git(root, box, "add", "-A");
    git(root, box, "commit", "-q", "-m", "Add luseen documents");
    const record = path.join(makeTempFolder(), "calls.jsonl");
    expect(luseen([root, "--yes"], box, { FAKE_CLAUDE_RECORD: record }).code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(readFileSync(path.join(root, ".luseen/sdd/README.md"), "utf8")).toBe(readme);
  });

  it("TC-GIT-037: JSON has the status and commit count", () => {
    const box = sandbox();
    const parsed = JSON.parse(luseen([repositoryWithCommits(box, 2), "--yes", "--json"], box).stdout) as {
      git: unknown;
    };
    expect(parsed.git).toMatchObject({ status: "repository", commitsUsed: 2, createdRepository: false, remote: null });
    expect(parsed.git).toHaveProperty("remoteAlert");
  });
});

describe("Git problems never stop a run", () => {
  it("TC-GIT-038: a damaged .git folder, or a failing git", () => {
    const damaged = project();
    mkdirSync(path.join(damaged, ".git"));
    writeFileSync(path.join(damaged, ".git/HEAD"), "garbage");
    const first = luseen([damaged, "--yes"], sandbox());
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("Warning");
    expect(existsSync(path.join(damaged, ".luseen/sdd/README.md"))).toBe(true);

    const box = sandbox();
    const failing = gitWrapper("exit 1");
    const second = project();
    const result = luseen([second, "--yes"], box, { PATH: `${failing}:${box.env["PATH"] ?? ""}` });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Warning");
    expect(existsSync(path.join(second, ".luseen/sdd/README.md"))).toBe(true);
  });

  it("TC-GIT-039: a shallow clone warns", () => {
    const box = sandbox();
    const source = repositoryWithCommits(box, 3);
    const clone = path.join(makeTempFolder(), "clone");
    git(makeTempFolder(), box, "clone", "-q", "--depth", "1", `file://${source}`, clone);
    const { code, stderr } = luseen([clone, "--yes"], box);
    expect(code).toBe(0);
    expect(stderr).toContain("shallow clone");
  });

  it("TC-GIT-040: an unsafe folder warns, and isn't bypassed", () => {
    const log = path.join(makeTempFolder(), "git.log");
    const wrapper = gitWrapper(
      `echo "$@" >> "${log}"\ncase "$*" in\n  *is-inside-work-tree*) echo "fatal: detected dubious ownership in repository" >&2; exit 128;;\nesac\nexec "${REAL_GIT}" "$@"`,
    );
    const box = sandbox();
    const root = project();
    const { code, stderr } = luseen([root, "--yes"], box, { PATH: `${wrapper}:${box.env["PATH"] ?? ""}` });
    expect(code).toBe(0);
    expect(stderr).toContain("unsafe");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("safe.directory");
  });
});

describe("the MCP server's config, QA", () => {
  it("TC-MCP-064: committing luseen's own .mcp.json alone causes no Claude call and no document change", () => {
    const box = sandbox();
    const root = repositoryWithCommits(box);
    expect(luseen([root, "--yes"], box).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { luseen: { command: "npx", args: ["luseen", "mcp"] } },
    });
    git(root, box, "add", "-A", "--", ".", ":!.mcp.json");
    git(root, box, "commit", "-q", "-m", "Add luseen output");
    git(root, box, "add", ".mcp.json");
    git(root, box, "commit", "-q", "-m", "Add the MCP server");
    const out = path.join(root, ".luseen/sdd");
    const snapshot = () =>
      Object.fromEntries(
        readdirSync(out)
          .filter((name) => name.endsWith(".md"))
          .map((name) => [name, readFileSync(path.join(out, name), "utf8")]),
      );
    const before = snapshot();
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const run = luseen([root, "--yes"], box, { FAKE_CLAUDE_RECORD: record });
    expect(run.code, run.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
