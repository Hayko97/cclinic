/**
 * The file locks of luseen's runs, the workflow state and the GUI (FR-CLI-022, FR-AUTO-032, FR-MCP-045,
 * FR-GUI-007). A lock is created with its content in one step, taken over only when abandoned, and removed
 * only by its holder, so two processes can never both hold it.
 */
import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { LOCK_RETRY_MS, LOCK_WRITE_GRACE_MS } from "../../core/constants/limits.js";
import { LOCK_BREAKER_SUFFIX } from "../../core/constants/paths.js";
import { UsageError } from "../../core/errors.js";

/** A lock's holder: JSON with a `pid`, or, in older locks, the bare process ID. */
export type LockHolder = Readonly<Record<string, unknown>> & { readonly pid: number };

export interface HeldLock {
  /** Replaces the lock's extra fields, such as the GUI's port, in one step. */
  readonly rewrite: (fields: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Removes the lock, unless another process has since taken it over. */
  readonly release: () => Promise<void>;
}

export interface LockOptions {
  /** Waiting for the lock stops when this is aborted. */
  readonly signal: AbortSignal;
  /** Fails at once, with this error, while another live process holds the lock. Otherwise it waits. */
  readonly refuse?: (holder: LockHolder, lockFile: string) => UsageError;
  /** A lock held longer than this is treated as abandoned. Only for locks held for moments, never for runs. */
  readonly staleAfterMs?: number;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parseHolder(text: string): LockHolder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed === "number") return { pid: parsed };
  if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || typeof parsed.pid !== "number")
    return undefined;
  return parsed as LockHolder;
}

function readText(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

/** The lock's holder while its process runs. */
export async function readLiveHolder(lockFile: string): Promise<LockHolder | undefined> {
  const holder = parseHolder((await readText(lockFile)) ?? "");
  return holder !== undefined && holder.pid > 0 && isProcessRunning(holder.pid) ? holder : undefined;
}

/** File systems such as FAT and some network mounts have no hard links. */
const NO_HARD_LINK_CODES: ReadonlySet<string | undefined> = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Creates `file` with its content, failing if it exists. Where it can, the content goes to a file of its own
 * that is then linked in, so nobody reads it half written. Without hard links it's created, then written,
 * and a lock found empty is given a moment to be written (`isAbandoned`).
 */
export async function createExclusive(file: string, content: string): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await link(temporary, file);
    return true;
  } catch (error) {
    if (isExisting(error)) return false;
    if (!NO_HARD_LINK_CODES.has((error as NodeJS.ErrnoException).code)) throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  try {
    await writeFile(file, content, { flag: "wx" });
    return true;
  } catch (error) {
    if (isExisting(error)) return false;
    throw error;
  }
}

async function ageMs(file: string): Promise<number> {
  return stat(file).then(
    (info) => Date.now() - info.mtimeMs,
    () => 0,
  );
}

/** Its process has ended, it's been unreadable for longer than writing takes, or it's older than `staleAfterMs`. */
async function isAbandoned(file: string, text: string, staleAfterMs: number | undefined): Promise<boolean> {
  const age = await ageMs(file);
  if (staleAfterMs !== undefined && age > staleAfterMs) return true;
  const holder = parseHolder(text);
  if (holder === undefined) return age > LOCK_WRITE_GRACE_MS;
  return holder.pid <= 0 || !isProcessRunning(holder.pid);
}

/**
 * Removes an abandoned lock. Only the holder of a short-lived second lock may do it, and it checks the lock
 * again first, so a lock someone has just taken is never removed.
 */
async function removeAbandoned(lockFile: string, text: string, staleAfterMs: number | undefined): Promise<void> {
  const breaker = `${lockFile}${LOCK_BREAKER_SUFFIX}`;
  if (!(await createExclusive(breaker, JSON.stringify({ pid: process.pid })))) {
    const other = await readText(breaker);
    if (other !== undefined && (await isAbandoned(breaker, other, staleAfterMs))) await rm(breaker, { force: true });
    else await wait(LOCK_RETRY_MS);
    return;
  }
  try {
    const current = await readText(lockFile);
    if (current === text && (await isAbandoned(lockFile, current, staleAfterMs))) await rm(lockFile, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
}

export async function takeLock(
  lockFile: string,
  fields: Readonly<Record<string, unknown>>,
  options: LockOptions,
): Promise<HeldLock> {
  const owner = randomUUID();
  const contentWith = (extra: Readonly<Record<string, unknown>>) =>
    JSON.stringify({ pid: process.pid, owner, ...extra });
  for (;;) {
    if (options.signal.aborted)
      throw new UsageError(
        `Another luseen process holds ${lockFile}. Try again, or delete it if no luseen process is running.`,
      );
    if (await createExclusive(lockFile, contentWith(fields))) break;
    const text = await readText(lockFile);
    if (text === undefined) {
      // Gone since, or not readable at all, such as a folder: try again, without spinning.
      await wait(LOCK_RETRY_MS);
      continue;
    }
    if (await isAbandoned(lockFile, text, options.staleAfterMs)) {
      await removeAbandoned(lockFile, text, options.staleAfterMs);
      continue;
    }
    const holder = parseHolder(text);
    if (holder !== undefined && options.refuse !== undefined) throw options.refuse(holder, lockFile);
    await wait(LOCK_RETRY_MS);
  }
  const isMine = async () => parseHolder((await readText(lockFile)) ?? "")?.["owner"] === owner;
  return {
    rewrite: async (extra) => {
      // Never put back a lock that was removed or taken over meanwhile.
      if (!(await isMine())) return;
      const temporary = `${lockFile}.${owner}.tmp`;
      await writeFile(temporary, contentWith(extra));
      await rename(temporary, lockFile);
    },
    release: async () => {
      if (await isMine()) await rm(lockFile, { force: true });
    },
  };
}
