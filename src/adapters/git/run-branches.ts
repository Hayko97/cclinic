/** Branches and worktrees for automated runs. The user's own branch, index and files are never touched (FR-AUTO-012). */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTO_COMMIT_IDENTITY,
  AUTO_FOLDER,
  AUTO_GIT_TIMEOUT_MS,
  RUN_WORKTREES_FOLDER,
} from "../../core/constants/agents.js";
import { TASKS_DB_FILE, TOOL_FOLDER_NAME } from "../../core/constants/paths.js";
import { LuseenError } from "../../core/errors.js";

const TASKS_DB_PATH = `${TOOL_FOLDER_NAME}/${TASKS_DB_FILE}`;
import { runGit, type GitOptions, type GitOutcome } from "./git-repository.js";

export class RunGitError extends LuseenError {}

export interface RepositoryState {
  readonly isRepository: boolean;
  readonly hasCommit: boolean;
  readonly hasTrackedChanges: boolean;
}

export async function readRepositoryState(target: string, options: GitOptions): Promise<RepositoryState> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], target, options);
  if (!inside.isOk || inside.stdout.trim() !== "true") {
    return { isRepository: false, hasCommit: false, hasTrackedChanges: false };
  }
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], target, options);
  // New files are allowed, staged or not, because worktrees start from HEAD without them. The task
  // database is allowed too: luseen updates it during every run (FR-AUTO-003, FR-AUTO-009).
  const changed = head.isOk
    ? await runGit(
        ["diff", "HEAD", "--name-only", "--diff-filter=a", "--", ".", `:(exclude)${TASKS_DB_PATH}`],
        target,
        options,
      )
    : undefined;
  return { isRepository: true, hasCommit: head.isOk, hasTrackedChanges: (changed?.stdout.trim() ?? "") !== "" };
}

export async function branchExists(target: string, branch: string, options: GitOptions): Promise<boolean> {
  return (await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], target, options)).isOk;
}

/** Paths that HEAD doesn't contain, since agents work from HEAD in their worktrees. */
export async function missingFromHead(
  target: string,
  paths: readonly string[],
  options: GitOptions,
): Promise<string[]> {
  const missing: string[] = [];
  for (const item of paths) {
    if (!(await runGit(["cat-file", "-e", `HEAD:${item}`], target, options)).isOk) missing.push(item);
  }
  return missing;
}

function expectOk(outcome: GitOutcome, what: string): string {
  if (!outcome.isOk) throw new RunGitError(`Git couldn't ${what}: ${outcome.stderr.trim() || "unknown error"}`);
  return outcome.stdout;
}

/** Keeps worktrees and run files out of `git status` in the user's own working tree. */
export async function excludeRunFolder(target: string, options: GitOptions): Promise<void> {
  const common = expectOk(
    await runGit(["rev-parse", "--git-common-dir"], target, options),
    "find the repository",
  ).trim();
  const exclude = path.join(path.resolve(target, common), "info", "exclude");
  const line = `/${AUTO_FOLDER}/`;
  const existing = await readFile(exclude, "utf8").catch(() => "");
  if (existing.split("\n").includes(line)) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`);
}

export interface RunRepository {
  readonly runBranch: string;
  createTaskWorktree(taskBranch: string): Promise<string>;
  diff(worktree: string, paths?: readonly string[]): Promise<string>;
  commitAll(worktree: string, message: string): Promise<boolean>;
  mergeIntoRun(
    taskBranch: string,
    message: string,
  ): Promise<{ isMerged: true } | { isMerged: false; conflicts: string[] }>;
  removeWorktree(worktree: string): Promise<void>;
  close(): Promise<void>;
}

/** Creates the run branch from HEAD, with its own worktree for merging (FR-AUTO-010). */
export async function openRunRepository(input: {
  target: string;
  runFolder: string;
  runBranch: string;
  environment: NodeJS.ProcessEnv;
}): Promise<RunRepository> {
  const options: GitOptions = { environment: input.environment, timeoutMs: AUTO_GIT_TIMEOUT_MS };
  const git = (args: readonly string[], cwd = input.target) => runGit(args, cwd, options);
  await excludeRunFolder(input.target, options);
  const worktrees = path.join(input.runFolder, RUN_WORKTREES_FOLDER);
  const runWorktree = path.join(worktrees, "run");
  await mkdir(worktrees, { recursive: true });
  expectOk(await git(["worktree", "add", "-b", input.runBranch, runWorktree, "HEAD"]), "create the run branch");

  const hasIdentity = (await git(["config", "user.email"])).stdout.trim() !== "";
  const identity = hasIdentity
    ? []
    : ["-c", `user.name=${AUTO_COMMIT_IDENTITY.name}`, "-c", `user.email=${AUTO_COMMIT_IDENTITY.email}`];

  const removeWorktree = async (worktree: string): Promise<void> => {
    await git(["worktree", "remove", "--force", worktree]);
    await git(["worktree", "prune"]);
  };

  return {
    runBranch: input.runBranch,

    createTaskWorktree: async (taskBranch) => {
      const worktree = path.join(worktrees, taskBranch.slice(taskBranch.lastIndexOf("/") + 1));
      expectOk(await git(["worktree", "add", "-b", taskBranch, worktree, input.runBranch]), `create ${taskBranch}`);
      return worktree;
    },

    diff: async (worktree, paths = []) => {
      expectOk(await git(["add", "-A"], worktree), "stage the task's changes");
      return expectOk(await git(["diff", "--cached", "--", ...paths], worktree), "read the task's changes");
    },

    // Hooks are skipped: the project's own commit rules apply when the user merges the run branch.
    commitAll: async (worktree, message) => {
      expectOk(await git(["add", "-A"], worktree), "stage the task's changes");
      if ((await git(["diff", "--cached", "--quiet"], worktree)).isOk) return false;
      expectOk(await git([...identity, "commit", "--no-verify", "-m", message], worktree), "commit the task");
      return true;
    },

    mergeIntoRun: async (taskBranch, message) => {
      const merged = await git(
        [...identity, "merge", "--no-ff", "--no-verify", "-m", message, taskBranch],
        runWorktree,
      );
      if (merged.isOk) return { isMerged: true };
      const conflicts = (await git(["diff", "--name-only", "--diff-filter=U"], runWorktree)).stdout
        .split("\n")
        .filter(Boolean);
      await git(["merge", "--abort"], runWorktree);
      return { isMerged: false, conflicts: conflicts.length === 0 ? [merged.stderr.trim()] : conflicts };
    },

    removeWorktree,
    close: () => removeWorktree(runWorktree),
  };
}
