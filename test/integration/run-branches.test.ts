/** Task worktrees for automated runs, created and removed by tasks that start and finish together (FR-AUTO-042). */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gitRepository from "../../src/adapters/git/git-repository.js";
import { openRunRepository } from "../../src/adapters/git/run-branches.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

vi.mock("../../src/adapters/git/git-repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/git/git-repository.js")>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});

const runGit = vi.mocked(gitRepository.runGit);
let realRunGit: typeof gitRepository.runGit;

beforeEach(() => {
  const wrapped = runGit.getMockImplementation();
  if (wrapped === undefined) throw new Error("runGit isn't wrapped");
  realRunGit = wrapped;
});

// The mock comes from vi.mock, which restoreAllMocks doesn't reset, so each test's recorder is removed here.
afterEach(() => {
  runGit.mockImplementation(realRunGit);
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(): string {
  const root = makeTempFolder();
  writeProject(root, { "README.md": "# App\n" });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}

async function openRun(root: string) {
  return openRunRepository({
    target: root,
    runFolder: path.join(root, ".luseen/auto/run-1"),
    runBranch: "luseen/auto/run-1/run",
    environment: process.env,
  });
}

describe("task worktrees for tasks that run at the same time", () => {
  it("TC-AUTO-065: 8 worktrees created and removed at the same time all succeed, 5 times over", async () => {
    const root = repository();
    const run = await openRun(root);
    for (let round = 0; round < 5; round++) {
      const branches = Array.from({ length: 8 }, (_, index) => `luseen/auto/run-1/task-${round * 8 + index + 1}`);
      const worktrees = await Promise.all(branches.map((branch) => run.createTaskWorktree(branch)));
      expect(worktrees.every((worktree) => existsSync(worktree))).toBe(true);
      await Promise.all(worktrees.map((worktree) => run.removeWorktree(worktree)));
      expect(worktrees.some((worktree) => existsSync(worktree))).toBe(false);
    }
    await run.close();
    const listed = git(root, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(listed).toEqual([`worktree ${git(root, "rev-parse", "--show-toplevel")}`]);
  });

  it("TC-AUTO-066: no two worktree commands overlap", async () => {
    const root = repository();
    const commands: string[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    runGit.mockImplementation(async (args, cwd, options) => {
      if (args[0] !== "worktree") return realRunGit(args, cwd, options);
      commands.push(args.slice(0, 2).join(" "));
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        return await realRunGit(args, cwd, options);
      } finally {
        inFlight--;
      }
    });
    const run = await openRun(root);
    const [first, second] = await Promise.all([
      run.createTaskWorktree("luseen/auto/run-1/task-1"),
      run.createTaskWorktree("luseen/auto/run-1/task-2"),
    ]);
    // Two tasks finish while a third starts, as happens when a developer slot frees up.
    const [, , third] = await Promise.all([
      run.removeWorktree(first),
      run.removeWorktree(second),
      run.createTaskWorktree("luseen/auto/run-1/task-3"),
    ]);
    await run.removeWorktree(third);
    await run.close();

    const count = (command: string) => commands.filter((item) => item === command).length;
    // The run's own worktree is added first, then the 3 tasks'.
    expect(count("worktree add")).toBe(4);
    // The 3 tasks' worktrees, then the run's own at close, each followed by a prune.
    expect(count("worktree remove")).toBe(4);
    expect(count("worktree prune")).toBe(4);
    expect(mostInFlight).toBe(1);
  });
});
