/** Moves a project cclinic set up over to Luseen's folder and ignore file (FR-CLI-033). */
import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { AUTO_FOLDER, AUTO_LOCK_FILE } from "../../core/constants/agents.js";
import { GUI_FOLDER, GUI_LOCK_FILE } from "../../core/constants/gui.js";
import {
  LEGACY_IGNORE_FILE,
  LEGACY_TOOL_FOLDER_NAME,
  LOCK_FILE_NAME,
  LUSEEN_IGNORE_FILE,
  TOOL_FOLDER_NAME,
} from "../../core/constants/paths.js";
import { STATE_LOCK_FILE, WORKFLOW_FOLDER } from "../../core/constants/workflow.js";
import { UsageError } from "../../core/errors.js";
import { readLiveHolder } from "./file-lock.js";

export interface LegacyMove {
  readonly from: string;
  readonly to: string;
}

export type LegacyProjectState =
  | { readonly status: "none" }
  /** Both folders exist, so only a lone `.cclinicignore` moves, and only `.luseen/` is read. */
  | { readonly status: "both"; readonly moves: readonly LegacyMove[] }
  /** `hasRuns`: it holds auto runs, whose worktrees and Git exclude entry move with it. */
  | { readonly status: "planned"; readonly moves: readonly LegacyMove[]; readonly hasRuns: boolean };

/** The locks of the runs that may still be working in the folder, relative to it. */
const RUN_LOCKS = [
  LOCK_FILE_NAME,
  path.posix.join(path.posix.relative(TOOL_FOLDER_NAME, AUTO_FOLDER), AUTO_LOCK_FILE),
  path.posix.join(path.posix.relative(TOOL_FOLDER_NAME, GUI_FOLDER), GUI_LOCK_FILE),
  path.posix.join(path.posix.relative(TOOL_FOLDER_NAME, WORKFLOW_FOLDER), STATE_LOCK_FILE),
];

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function isFolder(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** The ignore file, unless Luseen already has one (FR-CLI-033). */
async function ignoreMoves(target: string): Promise<readonly LegacyMove[]> {
  const isLone =
    (await exists(path.join(target, LEGACY_IGNORE_FILE))) && !(await exists(path.join(target, LUSEEN_IGNORE_FILE)));
  return isLone ? [{ from: LEGACY_IGNORE_FILE, to: LUSEEN_IGNORE_FILE }] : [];
}

/** Never moves files under a cclinic process that is still running. */
async function refuseWhileHeld(target: string): Promise<void> {
  for (const lock of RUN_LOCKS) {
    const file = path.posix.join(LEGACY_TOOL_FOLDER_NAME, lock);
    const holder = await readLiveHolder(path.join(target, file));
    if (holder !== undefined)
      throw new UsageError(
        `Can't move ${LEGACY_TOOL_FOLDER_NAME}/ to ${TOOL_FOLDER_NAME}/ while process ${holder.pid} holds ${file}. Stop it, then try again.`,
      );
  }
}

/** What a move would do, without moving anything. */
export async function planLegacyProject(target: string): Promise<LegacyProjectState> {
  if (!(await isFolder(path.join(target, LEGACY_TOOL_FOLDER_NAME)))) return { status: "none" };
  if (await exists(path.join(target, TOOL_FOLDER_NAME))) return { status: "both", moves: await ignoreMoves(target) };
  const runs = path.join(target, LEGACY_TOOL_FOLDER_NAME, path.posix.relative(TOOL_FOLDER_NAME, AUTO_FOLDER));
  const moves = [{ from: LEGACY_TOOL_FOLDER_NAME, to: TOOL_FOLDER_NAME }, ...(await ignoreMoves(target))];
  return { status: "planned", moves, hasRuns: await isFolder(runs) };
}

export async function applyLegacyMoves(target: string, moves: readonly LegacyMove[]): Promise<void> {
  if (moves.some((move) => move.from === LEGACY_TOOL_FOLDER_NAME)) await refuseWhileHeld(target);
  // The ignore file goes first: once the folder has moved, no later run looks for it again.
  for (const move of [...moves].reverse()) {
    try {
      await rename(path.join(target, move.from), path.join(target, move.to));
    } catch (error) {
      // Another luseen process started at the same moment, and has already moved it.
      const isGone = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!isGone || !(await exists(path.join(target, move.to)))) throw error;
    }
  }
}
