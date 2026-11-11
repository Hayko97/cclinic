/** The GUI's lock in `.cclinic/gui/`, which allows one GUI per project (FR-GUI-007, FR-GUI-047). */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { layoutSchema, type Layout } from "../../core/canvas.js";
import { GUI_FOLDER, GUI_HOST, GUI_LAYOUT_FILE, GUI_LOCK_FILE } from "../../core/constants/gui.js";
import { LOCK_WAIT_MS } from "../../core/constants/limits.js";
import { UsageError } from "../../core/errors.js";
import { ensureIgnoredFolder } from "./document-store.js";
import { takeLock, type LockHolder } from "./file-lock.js";

export interface GuiLock {
  /** Records the port, so a second GUI can say where the first one is. */
  setPort(port: number): Promise<void>;
  release(): Promise<void>;
}

export function guiFolder(target: string): string {
  return path.join(target, GUI_FOLDER);
}

function alreadyRunning(holder: LockHolder, lockFile: string): UsageError {
  const port = typeof holder["port"] === "number" ? holder["port"] : undefined;
  const where =
    port === undefined
      ? `A cclinic GUI is starting for this project (process ${holder.pid}).`
      : `A cclinic GUI is already running for this project on port ${port}: http://${GUI_HOST}:${port}/`;
  return new UsageError(`${where} If no cclinic GUI is running, delete ${lockFile}.`);
}

export async function acquireGuiLock(target: string): Promise<GuiLock> {
  const folder = guiFolder(target);
  await ensureIgnoredFolder(folder);
  const lock = await takeLock(
    path.join(folder, GUI_LOCK_FILE),
    { port: null },
    { signal: AbortSignal.timeout(LOCK_WAIT_MS), refuse: alreadyRunning },
  );
  return { setPort: (port) => lock.rewrite({ port }), release: lock.release };
}

/** FR-GUI-073: the saved canvas layout. A missing, damaged or older file means everything is placed automatically. */
export async function readLayout(target: string): Promise<Layout | undefined> {
  try {
    const parsed = layoutSchema.safeParse(
      JSON.parse(await readFile(path.join(guiFolder(target), GUI_LAYOUT_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Written whole and renamed into place, so a reader never sees half a layout. */
export async function saveLayout(target: string, layout: Layout): Promise<void> {
  const folder = guiFolder(target);
  await ensureIgnoredFolder(folder);
  const file = path.join(folder, GUI_LAYOUT_FILE);
  // Its own temporary file per save, so two saves at once can't mix their content (FR-GUI-073).
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(layout)}\n`);
    await rename(temporary, file);
  } catch (error) {
    // Only the lock and the layout belong in the GUI's folder (FR-GUI-047).
    await rm(temporary, { force: true });
    throw error;
  }
}
