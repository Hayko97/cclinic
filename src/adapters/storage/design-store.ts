/** Reads the design system, and keeps the old one while the setup step makes a new one (FR-DSGN-030, FR-DSGN-032). */
import { access, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DESIGN_FOLDER, DESIGN_PREVIOUS_FOLDER, DESIGN_SYSTEM_FILE } from "../../core/constants/design.js";
import {
  checkDesignSystem,
  DESIGN_SYSTEM_PATH,
  DESIGN_TOKENS_PATH,
  STYLE_GUIDE_PATH,
  type DesignStatus,
} from "../../core/design.js";

export type DesignState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "valid"; readonly status: DesignStatus };

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    // A file that can't be reached counts as missing, and the check reports it.
    return false;
  }
}

/**
 * FR-DSGN-042: system files such as `.DS_Store`, and empty folders, aren't design files. Nor is the old design
 * that a `--force` run keeps in `previous/` (FR-DSGN-032).
 */
async function holdsDesignFiles(folder: string, skipped?: string): Promise<boolean> {
  if (!(await exists(folder))) return false;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === skipped) continue;
    if (!entry.isDirectory() || (await holdsDesignFiles(path.join(folder, entry.name)))) return true;
  }
  return false;
}

/** A folder holding other design files but no design-system.md is incomplete, not missing, so it isn't overwritten (FR-DSGN-032). */
export async function readDesignSystem(target: string): Promise<DesignState> {
  const designSystem = await readIfExists(path.join(target, DESIGN_SYSTEM_PATH));
  if (designSystem === undefined) {
    return (await holdsDesignFiles(path.join(target, DESIGN_FOLDER), DESIGN_PREVIOUS_FOLDER))
      ? { kind: "invalid", problems: [`${DESIGN_SYSTEM_FILE} is missing`] }
      : { kind: "missing" };
  }
  const check = checkDesignSystem({
    designSystem,
    tokens: (await readIfExists(path.join(target, DESIGN_TOKENS_PATH))) ?? "",
    hasStyleGuide: await exists(path.join(target, STYLE_GUIDE_PATH)),
  });
  return check.kind === "valid" ? { kind: "valid", status: check.status } : check;
}

async function moveEntries(from: string, to: string, skipped: string | undefined): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    if (entry !== skipped) await rename(path.join(from, entry), path.join(to, entry));
  }
}

/** Moves the design files into `previous/`, replacing any left by an interrupted run. */
export async function keepPreviousDesign(target: string): Promise<void> {
  const folder = path.join(target, DESIGN_FOLDER);
  const previous = path.join(folder, DESIGN_PREVIOUS_FOLDER);
  await rm(previous, { recursive: true, force: true });
  if (await exists(folder)) await moveEntries(folder, previous, DESIGN_PREVIOUS_FOLDER);
}

/** Puts the kept design files back, removing what the failed run wrote. Without kept files, nothing is removed. */
export async function restorePreviousDesign(target: string): Promise<void> {
  const folder = path.join(target, DESIGN_FOLDER);
  const previous = path.join(folder, DESIGN_PREVIOUS_FOLDER);
  if (!(await exists(previous))) return;
  for (const entry of await readdir(folder)) {
    if (entry !== DESIGN_PREVIOUS_FOLDER) await rm(path.join(folder, entry), { recursive: true, force: true });
  }
  await moveEntries(previous, folder, undefined);
  await rm(previous, { recursive: true, force: true });
}

/** FR-DSGN-032: a `previous/` folder left by a run that was killed holds the design to keep, so it goes back first. */
export async function restoreInterruptedDesign(target: string): Promise<boolean> {
  if (!(await exists(path.join(target, DESIGN_FOLDER, DESIGN_PREVIOUS_FOLDER)))) return false;
  await restorePreviousDesign(target);
  return true;
}

/** Every file and folder in the design folder, as paths relative to it. The folder itself is "". */
export async function listDesignPaths(target: string): Promise<ReadonlySet<string>> {
  const folder = path.join(target, DESIGN_FOLDER);
  const paths = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    paths.add(relative);
    for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else paths.add(child);
    }
  };
  if (await exists(folder)) await walk("");
  return paths;
}

/**
 * FR-DSGN-040: removes only what a failed first run wrote: files and folders that weren't there before it, deepest
 * first, so everything the user had in the design folder stays, at any depth.
 */
export async function removeDesignPathsExcept(target: string, kept: ReadonlySet<string>): Promise<void> {
  const folder = path.join(target, DESIGN_FOLDER);
  const added = [...(await listDesignPaths(target))].filter((relative) => !kept.has(relative));
  for (const relative of added.sort((first, second) => second.length - first.length))
    await rm(path.join(folder, relative), { recursive: true, force: true });
}

export async function discardPreviousDesign(target: string): Promise<void> {
  await rm(path.join(target, DESIGN_FOLDER, DESIGN_PREVIOUS_FOLDER), { recursive: true, force: true });
}
