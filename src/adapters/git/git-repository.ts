/** Runs Git for detection, `git init` and reading history. The target repository is untrusted (FR-GIT-023). */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_BRANCH,
  GIT_COMMAND,
  GIT_ENV_TO_REMOVE,
  GIT_FOLDER,
  GIT_MAX_OUTPUT_BYTES,
  GIT_SAFE_ARGS,
  GIT_TIMEOUT_MS,
  HISTORY_EXCLUDED_PATHS,
  HISTORY_WINDOW_DAYS,
  MAX_HISTORY_COMMITS,
  MS_PER_DAY,
  PREFERRED_REMOTE,
} from "../../core/constants/git.js";
import { GITIGNORE_FILE } from "../../core/constants/paths.js";
import { GIT_LOG_FORMAT, parseGitLog, remoteHost, type GitCommit, type GitStatus } from "../../core/git-history.js";

export interface GitOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

interface GitOutcome {
  readonly isOk: boolean;
  readonly isMissing: boolean;
  readonly hasTimedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function gitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(environment).filter(([name]) => !GIT_ENV_TO_REMOVE.includes(name));
  return { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function runGit(args: readonly string[], cwd: string, options: GitOptions): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      GIT_COMMAND,
      [...GIT_SAFE_ARGS, ...args],
      {
        cwd,
        env: gitEnvironment(options.environment),
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const details = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          isOk: details === null,
          isMissing: details?.code === "ENOENT",
          hasTimedOut: details?.killed === true,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function findRemote(cwd: string, options: GitOptions) {
  const { stdout } = await runGit(["remote"], cwd, options);
  const names = stdout.split("\n").filter((name) => name !== "");
  const name = names.includes(PREFERRED_REMOTE) ? PREFERRED_REMOTE : names[0];
  if (name === undefined) return undefined;
  const url = await runGit(["remote", "get-url", name], cwd, options);
  return { name, host: url.isOk ? remoteHost(url.stdout) : "unknown host" };
}

/** Changes nothing, and needs no network (FR-GIT-001). */
export async function detectGit(target: string, options: GitOptions): Promise<GitStatus> {
  const version = await runGit(["--version"], target, options);
  if (version.hasTimedOut) return { kind: "unavailable", reason: "Git didn't respond in time" };
  if (!version.isOk) return { kind: "not-installed" };

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], target, options);
  if (inside.hasTimedOut) return { kind: "unavailable", reason: "Git didn't respond in time" };
  if (!inside.isOk) {
    if (/dubious ownership/i.test(inside.stderr)) {
      // The owner must approve this with safe.directory. cclinic never bypasses it (FR-GIT-022).
      return { kind: "unavailable", reason: "Git refuses this folder as unsafe, because of its ownership" };
    }
    if (await pathExists(path.join(target, GIT_FOLDER))) {
      return { kind: "unavailable", reason: "the .git folder looks damaged" };
    }
    if (/not a git repository/i.test(inside.stderr)) return { kind: "no-repository" };
    return { kind: "unavailable", reason: "Git reported an error" };
  }
  if (inside.stdout.trim() !== "true") return { kind: "unavailable", reason: "this isn't a working folder" };

  const root = await runGit(["rev-parse", "--show-toplevel"], target, options);
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], target, options);
  const shallow = await runGit(["rev-parse", "--is-shallow-repository"], target, options);
  return {
    kind: "repository",
    root: root.stdout.trim(),
    hasCommits: head.isOk,
    isShallow: shallow.stdout.trim() === "true",
    remote: await findRemote(target, options),
  };
}

/** Honours init.defaultBranch, and uses `main` if it isn't set. Never commits (FR-GIT-004, FR-GIT-006). */
export async function createRepository(target: string, options: GitOptions): Promise<boolean> {
  const configured = await runGit(["config", "--get", "init.defaultBranch"], target, options);
  if (configured.isOk && configured.stdout.trim() !== "") {
    return (await runGit(["init", "--quiet"], target, options)).isOk;
  }
  const withBranch = await runGit(["init", "--quiet", `--initial-branch=${DEFAULT_BRANCH}`], target, options);
  // Git older than 2.28 has no --initial-branch.
  return withBranch.isOk || (await runGit(["init", "--quiet"], target, options)).isOk;
}

export interface RawHistory {
  readonly newestCommit: string;
  readonly commits: readonly GitCommit[];
  readonly totalInWindow: number;
}

export interface HistoryOptions extends GitOptions {
  readonly now: Date;
  /** Relative to the target, when the documents folder is inside it. */
  readonly outFolder?: string;
}

/** Reads messages and paths, and never diffs or authors (FR-GIT-012, FR-GIT-013). */
export async function readRawHistory(target: string, options: HistoryOptions): Promise<RawHistory | undefined> {
  const excluded = [...HISTORY_EXCLUDED_PATHS, ...(options.outFolder === undefined ? [] : [options.outFolder])];
  const pathspec = ["--", ".", ...excluded.map((item) => `:(exclude)${item}`)];
  const since = new Date(options.now.getTime() - HISTORY_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const window = ["--no-merges", `--since=${since}`, "HEAD"];

  // From all history, not the window, so commits ageing out never count as a change (FR-GIT-019).
  const newest = await runGit(["log", "-1", "--format=%H", "HEAD", ...pathspec], target, options);
  const count = await runGit(["rev-list", "--count", ...window, ...pathspec], target, options);
  const log = await runGit(
    [
      "log",
      `--max-count=${MAX_HISTORY_COMMITS}`,
      "--date=short",
      GIT_LOG_FORMAT,
      "--name-only",
      "--relative",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      ...window,
      ...pathspec,
    ],
    target,
    options,
  );
  if (!newest.isOk || !count.isOk || !log.isOk) return undefined;
  return {
    newestCommit: newest.stdout.trim(),
    commits: parseGitLog(log.stdout),
    totalInWindow: Number(count.stdout.trim()),
  };
}

export async function hasGitignore(folder: string): Promise<boolean> {
  return pathExists(path.join(folder, GITIGNORE_FILE));
}
