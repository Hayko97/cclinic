/** Keeps cclinic's auto-run worktrees working after `.cclinic/` moves to `.luseen/` (FR-CLI-033). */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { runGit, type GitOptions } from "./git-repository.js";

const WORKTREE_LINE = "worktree ";

/** The registered worktrees inside `folder`, relative to it. Empty outside a repository. */
export async function worktreesUnder(target: string, folder: string, options: GitOptions): Promise<string[]> {
  const listed = await runGit(["worktree", "list", "--porcelain"], target, options);
  if (!listed.isOk) return [];
  const root = path.join(await realpath(target), folder);
  return listed.stdout
    .split("\n")
    .filter((line) => line.startsWith(WORKTREE_LINE))
    .map((line) => line.slice(WORKTREE_LINE.length))
    .filter((worktree) => worktree.startsWith(`${root}${path.sep}`))
    .map((worktree) => path.relative(root, worktree));
}

/** Points Git at each worktree's new folder. True when Git repaired them all. */
export async function repairWorktrees(
  target: string,
  worktrees: readonly string[],
  options: GitOptions,
): Promise<boolean> {
  if (worktrees.length === 0) return true;
  return (await runGit(["worktree", "repair", ...worktrees], target, options)).isOk;
}
