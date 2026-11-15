/** Uses real Git repositories in temp folders. Dates are set, so history tests are repeatable. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@inquirer/prompts";
import { createPathFilter } from "../../src/adapters/discovery/file-walker.js";
import { createRepository, detectGit, readRawHistory } from "../../src/adapters/git/git-repository.js";
import { createCache, createDocumentStore, projectPaths, sha256 } from "../../src/adapters/storage/document-store.js";
import { generateDocuments, prepareRun, type HistoryForRun } from "../../src/application/pipeline.js";
import { runGenerate, type CommandContext, type GenerateOptions } from "../../src/cli/generate-command.js";
import { createReporter } from "../../src/cli/reporter.js";
import { buildHistoryContext } from "../../src/core/git-history.js";
import type { ExtractedFile, LlmRequest, ScannedFile } from "../../src/core/ports.js";
import { moduleSummarySchema, projectDataSchema, specContentSchema } from "../../src/core/schemas.js";
import { FakeLlm, makeTempFolder, silentLogger, writeProject } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ select: vi.fn(), confirm: vi.fn() }));

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-11-07T12:00:00Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function isolatedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = makeTempFolder();
  return { PATH: process.env["PATH"], HOME: home, GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), ...extra };
}

function git(cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv, date?: string): string {
  return execFileSync("git", ["-c", "user.name=Test Person", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...environment, ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) },
  });
}

function commitFile(cwd: string, file: string, message: string, environment: NodeJS.ProcessEnv, age = 1): void {
  writeProject(cwd, { [file]: `${message}\n` });
  git(cwd, ["add", "-A"], environment);
  git(cwd, ["commit", "-q", "-m", message], environment, daysAgo(age));
}

function repository(environment: NodeJS.ProcessEnv): string {
  const root = makeTempFolder();
  git(root, ["init", "-q"], environment);
  return root;
}

const history = (root: string, environment: NodeJS.ProcessEnv, now: Date = NOW) =>
  readRawHistory(root, { environment, now });

describe("detecting", () => {
  it("TC-GIT-001: each state is detected, and nothing changes", async () => {
    const environment = isolatedEnvironment();
    await expect(detectGit(makeTempFolder(), { environment: { PATH: makeTempFolder() } })).resolves.toEqual({
      kind: "not-installed",
    });

    const plain = makeTempFolder();
    await expect(detectGit(plain, { environment })).resolves.toEqual({ kind: "no-repository" });
    expect(existsSync(path.join(plain, ".git"))).toBe(false);

    const noCommits = repository(environment);
    await expect(detectGit(noCommits, { environment })).resolves.toMatchObject({
      kind: "repository",
      hasCommits: false,
      remote: undefined,
    });

    commitFile(noCommits, "a.ts", "first", environment);
    await expect(detectGit(noCommits, { environment })).resolves.toMatchObject({ hasCommits: true, remote: undefined });
    const before = git(noCommits, ["status", "--porcelain"], environment);

    git(noCommits, ["remote", "add", "origin", "https://github.com/me/repo.git"], environment);
    await expect(detectGit(noCommits, { environment })).resolves.toMatchObject({
      remote: { name: "origin", host: "github.com" },
    });
    expect(git(noCommits, ["status", "--porcelain"], environment)).toBe(before);

    mkdirSync(path.join(noCommits, "sub"));
    await expect(detectGit(path.join(noCommits, "sub"), { environment })).resolves.toMatchObject({
      kind: "repository",
    });
  });

  it("TC-GIT-006: the configured default branch is respected, or main is used", async () => {
    const unset = isolatedEnvironment();
    const first = makeTempFolder();
    await expect(createRepository(first, { environment: unset })).resolves.toBe(true);
    expect(git(first, ["symbolic-ref", "--short", "HEAD"], unset).trim()).toBe("main");

    const configured = isolatedEnvironment();
    writeFileSync(configured["GIT_CONFIG_GLOBAL"] ?? "", "[init]\n\tdefaultBranch = trunk\n");
    const second = makeTempFolder();
    await createRepository(second, { environment: configured });
    expect(git(second, ["symbolic-ref", "--short", "HEAD"], configured).trim()).toBe("trunk");
  });
});

describe("reading history", () => {
  it("TC-GIT-017: only recent, non-merge commits on the current branch", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "old.ts", "too old", environment, 15);
    commitFile(root, "edge.ts", "thirteen days", environment, 13);
    git(root, ["checkout", "-q", "-b", "other"], environment);
    commitFile(root, "other.ts", "other branch", environment, 1);
    git(root, ["checkout", "-q", "-"], environment);
    // This branch's commit is too old for the window, so only the merge commit itself could appear.
    git(root, ["checkout", "-q", "-b", "merged"], environment);
    commitFile(root, "merged.ts", "merged long ago", environment, 20);
    git(root, ["checkout", "-q", "-"], environment);
    commitFile(root, "new.ts", "one day", environment, 1);
    git(root, ["merge", "-q", "--no-ff", "-m", "merge commit", "merged"], environment, daysAgo(1));
    expect(git(root, ["log", "--format=%s", "-1"], environment).trim()).toBe("merge commit");

    const raw = await history(root, environment);
    const messages = raw?.commits.map((item) => item.message) ?? [];
    expect(messages).toContain("thirteen days");
    expect(messages).toContain("one day");
    expect(messages).not.toContain("too old");
    expect(messages).not.toContain("other branch");
    expect(messages).not.toContain("merge commit");
    const first = raw?.commits.find((item) => item.message === "one day");
    expect(first?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(first?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first?.paths).toEqual(["new.ts"]);
    expect(raw?.totalInWindow).toBe(messages.length);
  });

  it("TC-GIT-018: only commits touching the target subfolder", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "pkg/in.ts", "inside", environment);
    commitFile(root, "other/out.ts", "outside", environment);
    const raw = await history(path.join(root, "pkg"), environment);
    expect(raw?.commits.map((item) => item.message)).toEqual(["inside"]);
    expect(raw?.commits[0]?.paths).toEqual(["in.ts"]);
  });

  it("TC-GIT-020: commits touching only luseen's output are left out", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "src/a.ts", "project change", environment);
    const projectCommit = git(root, ["rev-parse", "HEAD"], environment).trim();
    writeProject(root, {
      ".luseen/sdd/README.md": "x",
      ".agents/skills/a/SKILL.md": "x",
      ".claude/skills/a/SKILL.md": "x",
      "AGENTS.md": "x",
    });
    git(root, ["add", "-A"], environment);
    git(root, ["commit", "-q", "-m", "tool output"], environment, daysAgo(1));
    const raw = await history(root, environment);
    expect(raw?.commits.map((item) => item.message)).toEqual(["project change"]);
    expect(raw?.newestCommit).toBe(projectCommit);
  });

  it("TC-INSTR-014: commits touching only CLAUDE.md are left out", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "src/a.ts", "project change", environment);
    const projectCommit = git(root, ["rev-parse", "HEAD"], environment).trim();
    commitFile(root, "CLAUDE.md", "add instructions", environment);
    const raw = await history(root, environment);
    expect(raw?.commits.map((item) => item.message)).toEqual(["project change"]);
    expect(raw?.newestCommit).toBe(projectCommit);
  });

  it("TC-GIT-021: scan rules apply to real history", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    writeProject(root, { ".env": "S=1", "node_modules/x.js": "x", "src/a.ts": "a" });
    git(root, ["add", "-A"], environment);
    git(root, ["commit", "-q", "-m", "Key AKIAIOSFODNN7EXAMPLE"], environment, daysAgo(1));
    const raw = await history(root, environment);
    const filter = createPathFilter({
      target: root,
      outFolder: path.join(root, ".luseen/sdd"),
      include: [],
      exclude: [],
    });
    const context = buildHistoryContext(raw?.commits ?? [], raw?.totalInWindow ?? 0, filter);
    expect(context.text).toContain("Files: src/a.ts");
    expect(context.text).not.toContain("node_modules");
    expect(context.text).not.toContain(".env");
    expect(context.text).toContain("[REDACTED:aws-access-key]");
  });

  it("TC-GIT-023: real history reports how many are in the window", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    for (let index = 0; index < 3; index += 1) commitFile(root, `f${index}.ts`, `change ${index}`, environment);
    await expect(history(root, environment)).resolves.toMatchObject({ totalInWindow: 3 });
  });

  it("TC-GIT-031: commits ageing out of the window don't change the newest commit", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "a.ts", "only commit", environment);
    const now = await history(root, environment);
    const later = await history(root, environment, new Date(NOW.getTime() + 20 * 86_400_000));
    expect(now?.commits).toHaveLength(1);
    expect(later?.commits).toHaveLength(0);
    expect(later?.newestCommit).toBe(now?.newestCommit);
  });
});

describe("safety", () => {
  function markerScript(folder: string, marker: string): string {
    const script = path.join(folder, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);
    return script;
  }

  it("TC-GIT-041: repository settings can't run programs", async () => {
    const environment = isolatedEnvironment();
    const root = repository(environment);
    commitFile(root, "a.ts", "first", environment);
    commitFile(root, "a.ts", "second", environment);
    const marker = path.join(makeTempFolder(), "ran");
    const script = markerScript(makeTempFolder(), marker);
    for (const setting of ["core.fsmonitor", "diff.external", "gpg.program"])
      git(root, ["config", setting, script], environment);
    git(root, ["config", "log.showSignature", "true"], environment);
    git(root, ["config", "core.pager", script], environment);

    await detectGit(root, { environment });
    const raw = await history(root, environment);
    expect(raw?.commits).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
  });

  it("TC-GIT-042: paths are literal, and a hang times out", async () => {
    const environment = isolatedEnvironment();
    const parent = makeTempFolder();
    const odd = path.join(parent, "with space $(touch marker)");
    mkdirSync(odd);
    await expect(detectGit(odd, { environment })).resolves.toEqual({ kind: "no-repository" });
    await createRepository(odd, { environment });
    expect(existsSync(path.join(odd, ".git"))).toBe(true);
    expect(existsSync(path.join(odd, "marker"))).toBe(false);
    expect(existsSync(path.join(parent, "marker"))).toBe(false);

    const bin = makeTempFolder();
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(path.join(bin, "git"), 0o755);
    await expect(
      detectGit(makeTempFolder(), { environment: { PATH: `${bin}:/bin:/usr/bin` }, timeoutMs: 200 }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "Git didn't respond in time",
    });
  });
});

describe("pipeline use", () => {
  function codeFile(file: string, content = "line one"): ExtractedFile {
    return {
      path: file,
      kind: "code",
      sha256: sha256(content),
      positioning: "line",
      units: [{ ref: "1", text: content }],
      warnings: [],
    };
  }
  const FILES = [codeFile("a/one.ts"), codeFile("b/two.ts")];
  const isSummary = (call: LlmRequest<unknown>): boolean => call.schema === moduleSummarySchema;
  const isLater = (call: LlmRequest<unknown>): boolean =>
    call.schema === projectDataSchema || call.schema === specContentSchema;

  async function run(
    root: string,
    llm: FakeLlm,
    runHistory: HistoryForRun | undefined,
    files: readonly ExtractedFile[] = FILES,
  ) {
    const paths = projectPaths(root, undefined);
    const cache = createCache(paths.cache);
    const settings = {
      model: "sonnet",
      effort: "medium",
      concurrency: 2,
      noCache: false,
      luseenVersion: "1",
      ...(runHistory === undefined ? {} : { history: runHistory }),
    } as const;
    const scan = {
      included: files.map((file): ScannedFile => ({
        path: file.path,
        absolutePath: file.path,
        kind: file.kind,
        sizeBytes: 1,
      })),
      skipped: [],
    };
    const prepared = await prepareRun({ scan, extracted: files, settings }, { hash: sha256, cache });
    const now = (): Date => new Date();
    return generateDocuments(prepared, settings, {
      llm,
      cache,
      store: createDocumentStore(paths, now),
      logger: silentLogger,
      hash: sha256,
      now,
      signal: new AbortController().signal,
    });
  }

  const recent = { newestCommit: "abc", text: "abc 2026-11-01\nAdd login\nFiles: a/one.ts" };

  it("TC-GIT-026: combine and spec prompts have history, and summaries don't", async () => {
    const llm = new FakeLlm();
    await run(makeTempFolder(), llm, recent);
    expect(llm.calls.filter(isLater).length).toBeGreaterThan(0);
    for (const call of llm.calls.filter(isLater)) expect(call.prompt).toContain("Add login");
    for (const call of llm.calls.filter(isSummary)) expect(call.prompt).not.toContain("Add login");
  });

  it("TC-GIT-031: the same newest commit makes no calls, even with different text", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm(), recent);
    const llm = new FakeLlm();
    await run(root, llm, { newestCommit: "abc", text: "" });
    expect(llm.calls).toHaveLength(0);
  });

  it("TC-GIT-032: a new commit reruns combine and specs, with summaries cached", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm(), recent);
    const llm = new FakeLlm();
    await run(root, llm, { newestCommit: "def", text: recent.text });
    expect(llm.calls.filter(isSummary)).toHaveLength(0);
    expect(llm.calls.filter(isLater).length).toBeGreaterThan(0);
  });

  it("TC-GIT-033: no history matches a run with no repository", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm(), undefined);
    const llm = new FakeLlm();
    await run(root, llm, { newestCommit: "", text: "" });
    expect(llm.calls).toHaveLength(0);
  });

  it("TC-GIT-035: a changed file only regenerates its own module's summary", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm(), recent);
    const llm = new FakeLlm();
    await run(root, llm, { newestCommit: "def", text: recent.text }, [
      codeFile("a/one.ts", "changed"),
      FILES[1] as ExtractedFile,
    ]);
    const summaries = llm.calls.filter(isSummary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.prompt).toContain("a/one.ts");
  });

  it("TC-GIT-036: documents don't change when the window does, and hold no commit dates", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm(), recent);
    const out = path.join(root, ".luseen/sdd");
    const read = (name: string): string => readFileSync(path.join(out, name), "utf8");
    const names = ["README.md", "overview.md", "stack.md", "architecture.md", "scan-report.md", "open-questions.md"];
    const before = names.map(read);
    await run(root, new FakeLlm(), { newestCommit: "abc", text: "different window" });
    expect(names.map(read)).toEqual(before);
    for (const content of before) {
      expect(content).not.toContain("2026-11-01");
      expect(content).not.toMatch(/recent commits/i);
    }
  });
});

describe("the run", () => {
  function fakeClaudeFolder(): string {
    const folder = makeTempFolder();
    symlinkSync(process.execPath, path.join(folder, "node"));
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
    chmodSync(path.join(folder, "claude"), 0o755);
    return folder;
  }

  function context(): CommandContext {
    const environment = isolatedEnvironment({ PATH: `${fakeClaudeFolder()}:${process.env["PATH"] ?? ""}` });
    const reporter = createReporter({
      quiet: false,
      debug: false,
      color: "never",
      environment,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    return { reporter, environment, signal: new AbortController().signal, version: "1" };
  }

  const options: GenerateOptions = {
    include: [],
    exclude: [],
    cache: true,
    maxFiles: 100,
    maxInputTokens: 2_000_000,
    maxFileSizeMib: 1,
    concurrency: 2,
    timeoutMinutes: 1,
    maxRetries: 0,
  };
  const original = process.stdin.isTTY;
  beforeEach(() => {
    process.stdin.isTTY = true;
    vi.mocked(confirm).mockReset();
  });
  afterEach(() => {
    process.stdin.isTTY = original;
  });

  it("TC-GIT-007: declining creates no repository", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const root = makeTempFolder();
    writeProject(root, { "a.ts": "a\n" });
    await runGenerate(root, options, context());
    expect(existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("TC-GIT-007: nothing to analyse creates no repository", async () => {
    const root = makeTempFolder();
    writeProject(root, { "node_modules/a.js": "a\n" });
    await expect(runGenerate(root, { ...options, yes: true }, context())).rejects.toThrow("No files to analyse");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
  });
});
