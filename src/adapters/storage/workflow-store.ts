/** The saved state of each change in `.cclinic/workflow/`, one file per change (FR-MCP-038). */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import {
  STATE_LOCK_BREAKER_SUFFIX,
  STATE_LOCK_FILE,
  STATE_LOCK_RETRY_MS,
  STATE_LOCK_STALE_MS,
  STATE_LOCK_WAIT_MS,
  STATE_LOCK_WRITE_GRACE_MS,
  WORKFLOW_FOLDER,
} from "../../core/constants/workflow.js";
import { UsageError } from "../../core/errors.js";
import { redact } from "../../core/redaction.js";
import { isOpenChange, workflowStateSchema, type WorkflowState } from "../../core/workflow.js";
import { ensureIgnoredFolder, isProcessRunning } from "./document-store.js";

const STATE_EXTENSION = ".json";

export interface WorkflowStore {
  list(): Promise<readonly WorkflowState[]>;
  /** Saves under the folder's lock, keeping the sessions a hook linked meanwhile (FR-MCP-038, FR-MCP-045). */
  save(state: WorkflowState): Promise<void>;
  /** Re-reads the open change under the lock and saves what `change` makes of it (FR-MCP-045). */
  updateOpen(change: (state: WorkflowState) => WorkflowState, signal?: AbortSignal): Promise<void>;
}

interface LockHolder {
  readonly pid: number;
  readonly owner: string;
}

async function readHolder(lock: string): Promise<string | undefined> {
  return readFile(lock, "utf8").catch(() => undefined);
}

/** File systems such as FAT and some network mounts have no hard links. */
const NO_HARD_LINK_CODES: ReadonlySet<string | undefined> = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Created with its content in one step where it can be, so nobody reads it half written: the content goes to
 * a file of its own, which is linked in, and linking fails if the file exists. Without hard links, it's
 * created and written, and a lock found empty is given a moment to be written (`isAbandoned`).
 */
async function createWith(file: string, content: string, owner: string): Promise<boolean> {
  const temporary = `${file}.${owner}.tmp`;
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

/** A holder whose process ended, or that held on longer than any save takes, such as after its PID was reused. */
async function isAbandoned(file: string, text: string): Promise<boolean> {
  const age = await stat(file).then(
    (info) => Date.now() - info.mtimeMs,
    () => 0,
  );
  if (age > STATE_LOCK_STALE_MS) return true;
  try {
    const holder = JSON.parse(text) as Partial<LockHolder>;
    return typeof holder.pid !== "number" || !isProcessRunning(holder.pid);
  } catch {
    return age > STATE_LOCK_WRITE_GRACE_MS;
  }
}

/**
 * Removes a lock whose process has ended. Only the holder of a second, short-lived lock may do it, and it
 * checks the lock again first, so a lock someone has just taken is never removed.
 */
async function removeIfAbandoned(lock: string, holder: LockHolder): Promise<void> {
  const text = await readHolder(lock);
  if (text === undefined) return;
  if (!(await isAbandoned(lock, text))) {
    await wait(STATE_LOCK_RETRY_MS);
    return;
  }
  const breaker = `${lock}${STATE_LOCK_BREAKER_SUFFIX}`;
  if (!(await createWith(breaker, JSON.stringify(holder), holder.owner))) {
    const other = await readHolder(breaker);
    if (other !== undefined && (await isAbandoned(breaker, other))) await rm(breaker, { force: true });
    else await wait(STATE_LOCK_RETRY_MS);
    return;
  }
  try {
    // Checked again under the breaker: an empty lock someone has only just made is unchanged, but not abandoned.
    const current = await readHolder(lock);
    if (current === text && (await isAbandoned(lock, current))) await rm(lock, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
}

async function takeLock(lock: string, holder: LockHolder, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted)
      throw new UsageError(
        `Another cclinic process is saving this change. Try again, or delete ${lock} if no cclinic process is running.`,
      );
    if (await createWith(lock, JSON.stringify(holder), holder.owner)) return;
    await removeIfAbandoned(lock, holder);
  }
}

async function releaseLock(lock: string, holder: LockHolder): Promise<void> {
  if ((await readHolder(lock)) === JSON.stringify(holder)) await rm(lock, { force: true });
}

/**
 * One writer at a time. A save merges in the sessions on disk, and `updateOpen` reads the state inside the
 * lock, so no session is lost; other fields are written as the caller read them.
 */
async function withLock(folder: string, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  // The state and preview logs stay on this machine, so they're never listed or committed as changes.
  await ensureIgnoredFolder(folder);
  const lock = path.join(folder, STATE_LOCK_FILE);
  const holder: LockHolder = { pid: process.pid, owner: randomUUID() };
  await takeLock(lock, holder, signal);
  try {
    await run();
  } finally {
    // A failed release mustn't hide the save's own error; a lock left behind is replaced later.
    await releaseLock(lock, holder).catch(() => undefined);
  }
}

type LinkedSession = WorkflowState["sessions"][number];

/**
 * Sessions are only ever added, and their times only move outwards, so a save from a state read earlier
 * never drops a session a hook linked since, or moves its last-seen time back.
 */
function withLinkedSessions(state: WorkflowState, saved: WorkflowState | undefined): WorkflowState {
  // A key is reused by the next change on the same task or branch, which starts with no sessions.
  if (saved === undefined || saved.startedAt !== state.startedAt) return state;
  const merged = new Map<string, LinkedSession>(saved.sessions.map((session) => [session.sessionId, session]));
  for (const session of state.sessions) {
    const other = merged.get(session.sessionId);
    merged.set(
      session.sessionId,
      other === undefined
        ? session
        : {
            ...session,
            firstSeenAt: other.firstSeenAt < session.firstSeenAt ? other.firstSeenAt : session.firstSeenAt,
            lastSeenAt: other.lastSeenAt > session.lastSeenAt ? other.lastSeenAt : session.lastSeenAt,
          },
    );
  }
  return { ...state, sessions: [...merged.values()] };
}

export function workflowFolder(target: string): string {
  return path.join(target, WORKFLOW_FOLDER);
}

async function readState(file: string): Promise<WorkflowState | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: ReturnType<typeof workflowStateSchema.safeParse> | undefined;
  try {
    parsed = workflowStateSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success !== true)
    throw new UsageError(`${file} isn't a readable workflow state. Delete it to start the change again.`);
  return parsed.data;
}

async function writeState(file: string, state: WorkflowState): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${redact(JSON.stringify(state, null, JSON_INDENT)).text}\n`);
  await rename(temporary, file);
}

export function openWorkflowStore(target: string): WorkflowStore {
  const folder = workflowFolder(target);
  const list = async (): Promise<readonly WorkflowState[]> => {
    const names = await readdir(folder).catch(() => []);
    const states = await Promise.all(
      names.filter((name) => name.endsWith(STATE_EXTENSION)).map((name) => readState(path.join(folder, name))),
    );
    return states.filter((state): state is WorkflowState => state !== undefined);
  };
  return {
    list,
    // Written to a temporary file and renamed, so a failed write leaves the last state whole (FR-MCP-038, FR-MCP-039).
    save: (state) =>
      withLock(folder, AbortSignal.timeout(STATE_LOCK_WAIT_MS), async () => {
        const file = path.join(folder, `${state.key}${STATE_EXTENSION}`);
        await writeState(file, withLinkedSessions(state, await readState(file)));
      }),
    updateOpen: async (change, signal = AbortSignal.timeout(STATE_LOCK_WAIT_MS)) => {
      // A project with no workflow folder has no change, and gets no new files.
      if (!existsSync(folder)) return;
      await withLock(folder, signal, async () => {
        const open = (await list()).find(isOpenChange);
        if (open !== undefined) await writeState(path.join(folder, `${open.key}${STATE_EXTENSION}`), change(open));
      });
    },
  };
}
