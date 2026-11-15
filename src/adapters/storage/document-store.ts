/** Everything that touches .luseen on disk: cache, safe writes, hand-edit checks and the run lock. */
import { createHash } from "node:crypto";
import { access, constants, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCK_WAIT_MS } from "../../core/constants/limits.js";
import {
  BACKUP_FOLDER_SUFFIX,
  CACHE_FOLDER_NAME,
  DOCUMENTS_FOLDER_NAME,
  DOCUMENT_FILES,
  FAILED_FOLDER_NAME,
  GITIGNORE_FILE,
  LOCK_FILE_NAME,
  TEMP_FOLDER_SUFFIX,
  TOOL_FOLDER_NAME,
} from "../../core/constants/paths.js";
import { UsageError } from "../../core/errors.js";
import type { Cache, DocumentStore } from "../../core/ports.js";
import { manifestSchema, type Manifest } from "../../core/schemas.js";
import { takeLock } from "./file-lock.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export interface ProjectPaths {
  readonly tool: string;
  readonly cache: string;
  readonly failed: string;
  readonly out: string;
  readonly lock: string;
}

export function projectPaths(target: string, out: string | undefined): ProjectPaths {
  const tool = path.join(target, TOOL_FOLDER_NAME);
  return {
    tool,
    cache: path.join(tool, CACHE_FOLDER_NAME),
    failed: path.join(tool, FAILED_FOLDER_NAME),
    out: out === undefined ? path.join(tool, DOCUMENTS_FOLDER_NAME) : path.resolve(out),
    lock: path.join(tool, LOCK_FILE_NAME),
  };
}

/** Creates the folder with a `.gitignore` that keeps everything in it out of Git. */
export async function ensureIgnoredFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const gitignore = path.join(folder, GITIGNORE_FILE);
  if (!(await exists(gitignore))) await writeFile(gitignore, "*\n");
}

export function createCache(folder: string): Cache {
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(path.join(folder, `${key}.json`), "utf8")) as unknown;
      } catch {
        // A missing or corrupt entry is treated as a miss, and gets replaced (FR-ANA-022).
        return undefined;
      }
    },
    async set(key, value) {
      await ensureIgnoredFolder(folder);
      const file = path.join(folder, `${key}.json`);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, file);
    },
  };
}

async function writeFiles(folder: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [relative, content] of files) {
    const file = path.join(folder, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** Cleans up after a killed run. If only a backup survives, it's restored (FR-OUT-015). */
export async function recoverInterruptedWrite(out: string): Promise<void> {
  const parent = path.dirname(out);
  const base = path.basename(out);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(parent, entry);
    if (entry.startsWith(`${base}${BACKUP_FOLDER_SUFFIX}`)) {
      if (await exists(out)) await rm(full, { recursive: true, force: true });
      else await rename(full, out);
    } else if (entry.startsWith(`${base}${TEMP_FOLDER_SUFFIX}`)) {
      await rm(full, { recursive: true, force: true });
    }
  }
}

export function createDocumentStore(paths: ProjectPaths, now: () => Date): DocumentStore {
  return {
    async readManifest() {
      return readManifestFile(paths.out);
    },
    async saveFailedDraft(files) {
      await ensureIgnoredFolder(paths.failed);
      const folder = path.join(paths.failed, now().toISOString().replace(/[:.]/g, "-"));
      await writeFiles(folder, files);
      return folder;
    },
    async publish(files) {
      const temporary = `${paths.out}${TEMP_FOLDER_SUFFIX}${process.pid}`;
      const backup = `${paths.out}${BACKUP_FOLDER_SUFFIX}${process.pid}`;
      await rm(temporary, { recursive: true, force: true });
      await writeFiles(temporary, files);
      if (await exists(paths.out)) await rename(paths.out, backup);
      await rename(temporary, paths.out);
      await rm(backup, { recursive: true, force: true });
    },
  };
}

async function readManifestFile(out: string): Promise<Manifest | undefined> {
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(await readFile(path.join(out, DOCUMENT_FILES.MANIFEST), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function listFiles(folder: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) results.push(...(await listFiles(path.join(folder, entry.name), relative)));
    else results.push(relative);
  }
  return results;
}

/** Returns generated files that differ from the manifest, plus any added by hand. */
export async function findHandEditedFiles(out: string, manifest: Manifest): Promise<string[]> {
  const changed: string[] = [];
  const recorded = new Set(Object.keys(manifest.generatedFiles));
  for (const relative of await listFiles(out)) {
    if (relative === DOCUMENT_FILES.MANIFEST) continue;
    const expected = manifest.generatedFiles[relative];
    if (expected === undefined || sha256(await readFile(path.join(out, relative), "utf8")) !== expected) {
      changed.push(relative);
    }
    recorded.delete(relative);
  }
  return [...changed, ...recorded].sort();
}

export interface OutputCheck {
  readonly overwritten: readonly string[];
}

/** Protects hand edits and unrelated folders, before any usage is spent (FR-OUT-016, FR-OUT-017). */
export async function checkOutputFolder(out: string, isForced: boolean): Promise<OutputCheck> {
  if (!(await exists(out))) return { overwritten: [] };
  const files = await listFiles(out);
  if (files.length === 0) return { overwritten: [] };
  const manifest = await readManifestFile(out);
  if (manifest === undefined) {
    if (isForced) return { overwritten: files };
    throw new UsageError(
      `${out} has files but no luseen manifest, so it may not be luseen's folder. Choose another --out folder, or use --force to replace it.`,
    );
  }
  const edited = await findHandEditedFiles(out, manifest);
  if (edited.length === 0 || isForced) return { overwritten: edited };
  throw new UsageError(
    `These generated files were edited by hand:\n${edited.map((file) => `  ${file}`).join("\n")}\nMove your changes elsewhere, or use --force to replace them.`,
  );
}

async function nearestExisting(target: string): Promise<string> {
  let current = target;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** Fails before any usage is spent if results couldn't be saved (FR-CLI-017). */
export async function checkWritable(paths: ProjectPaths): Promise<void> {
  for (const folder of [paths.out, paths.cache]) {
    const existing = await nearestExisting(folder);
    try {
      await access(existing, constants.W_OK);
      // The parent matters too, because the output folder is swapped into place by renaming.
      if (folder === paths.out && existing === folder) await access(path.dirname(folder), constants.W_OK);
    } catch {
      throw new UsageError(`Can't write to ${existing}. Check its permissions, or choose another --out folder.`);
    }
  }
}

/** Allows one run per target. A lock from a dead process gets replaced (FR-CLI-022). */
export async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const lock = await takeLock(
    lockFile,
    {},
    {
      signal: AbortSignal.timeout(LOCK_WAIT_MS),
      refuse: (holder) =>
        new UsageError(`Another luseen run (process ${holder.pid}) is already working on this folder.`),
    },
  );
  return lock.release;
}

async function folderSize(folder: string): Promise<number> {
  let total = 0;
  for (const file of await listFiles(folder).catch(() => [])) {
    total += (await stat(path.join(folder, file))).size;
  }
  return total;
}

/** Removes only the cache and failed drafts. Generated documents are never touched (FR-CLI-014). */
export async function cleanProject(paths: ProjectPaths): Promise<number> {
  const freed = (await folderSize(paths.cache)) + (await folderSize(paths.failed));
  await rm(paths.cache, { recursive: true, force: true });
  await rm(paths.failed, { recursive: true, force: true });
  return freed;
}
