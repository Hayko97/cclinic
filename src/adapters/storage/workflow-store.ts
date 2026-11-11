/** The saved state of each change in `.cclinic/workflow/`, one file per change (FR-MCP-038). */
import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCK_WAIT_MS } from "../../core/constants/limits.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { STATE_LOCK_FILE, STATE_LOCK_STALE_MS, WORKFLOW_FOLDER } from "../../core/constants/workflow.js";
import { UsageError } from "../../core/errors.js";
import { redact } from "../../core/redaction.js";
import { isOpenChange, workflowStateSchema, type WorkflowState } from "../../core/workflow.js";
import { ensureIgnoredFolder } from "./document-store.js";
import { takeLock } from "./file-lock.js";

const STATE_EXTENSION = ".json";

export interface WorkflowStore {
  list(): Promise<readonly WorkflowState[]>;
  /** Saves under the folder's lock, keeping the sessions a hook linked meanwhile (FR-MCP-038, FR-MCP-045). */
  save(state: WorkflowState): Promise<void>;
  /** Re-reads the open change under the lock and saves what `change` makes of it (FR-MCP-045). */
  updateOpen(change: (state: WorkflowState) => WorkflowState, signal?: AbortSignal): Promise<void>;
}

/**
 * One writer at a time. A save merges in the sessions on disk, and `updateOpen` reads the state inside the
 * lock, so no session is lost; other fields are written as the caller read them.
 */
async function withLock(folder: string, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  // The state and preview logs stay on this machine, so they're never listed or committed as changes.
  await ensureIgnoredFolder(folder);
  const lock = await takeLock(path.join(folder, STATE_LOCK_FILE), {}, { signal, staleAfterMs: STATE_LOCK_STALE_MS });
  try {
    await run();
  } finally {
    // A failed release mustn't hide the save's own error; a lock left behind is replaced later.
    await lock.release().catch(() => undefined);
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
      withLock(folder, AbortSignal.timeout(LOCK_WAIT_MS), async () => {
        const file = path.join(folder, `${state.key}${STATE_EXTENSION}`);
        await writeState(file, withLinkedSessions(state, await readState(file)));
      }),
    updateOpen: async (change, signal = AbortSignal.timeout(LOCK_WAIT_MS)) => {
      // A project with no workflow folder has no change, and gets no new files.
      if (!existsSync(folder)) return;
      await withLock(folder, signal, async () => {
        const open = (await list()).find(isOpenChange);
        if (open !== undefined) await writeState(path.join(folder, `${open.key}${STATE_EXTENSION}`), change(open));
      });
    },
  };
}
