/** The files of an automated run in `.cclinic/auto/<run-id>`, and the lock that allows one run at a time. */
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession, RunState } from "../../core/automation.js";
import {
  AUTO_FOLDER,
  AUTO_LOCK_FILE,
  RUN_LOGS_FOLDER,
  RUN_REPORT_FILE,
  RUN_SESSIONS_FOLDER,
  RUN_STATE_FILE,
} from "../../core/constants/agents.js";
import { LOCK_ATTEMPTS } from "../../core/constants/limits.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { UsageError } from "../../core/errors.js";
import { redact } from "../../core/redaction.js";
import { isProcessRunning } from "./document-store.js";

export function autoFolder(target: string): string {
  return path.join(target, AUTO_FOLDER);
}

export function runFolder(target: string, runId: string): string {
  return path.join(autoFolder(target), runId);
}

export function isRunFolderUsed(target: string, runId: string): boolean {
  return existsSync(runFolder(target, runId));
}

async function readLiveLock(lockFile: string): Promise<{ pid: number; runId?: string } | undefined> {
  const holder = JSON.parse(await readFile(lockFile, "utf8").catch(() => "{}")) as { pid?: number; runId?: string };
  return typeof holder.pid === "number" && isProcessRunning(holder.pid) ? { ...holder, pid: holder.pid } : undefined;
}

function lockedError(holder: { pid: number; runId?: string }, cause?: unknown): UsageError {
  return new UsageError(
    `Automated run ${holder.runId ?? "unknown"} (process ${holder.pid}) is already working on this project.`,
    cause === undefined ? undefined : { cause },
  );
}

/** Refuses early, creating nothing, when another run is working on the project (FR-AUTO-032). */
export async function checkNoRunGoing(target: string): Promise<void> {
  const holder = await readLiveLock(path.join(autoFolder(target), AUTO_LOCK_FILE));
  if (holder !== undefined) throw lockedError(holder);
}

/** One run per project. A lock from a process that has ended is replaced (FR-AUTO-032). */
export async function acquireRunLock(target: string, runId: string): Promise<() => Promise<void>> {
  const lockFile = path.join(autoFolder(target), AUTO_LOCK_FILE);
  await mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, runId }));
      await handle.close();
      return () => rm(lockFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readLiveLock(lockFile);
      if (holder !== undefined) throw lockedError(holder, error);
      await rm(lockFile, { force: true });
    }
  }
  throw new UsageError(`Couldn't create the lock file ${lockFile}.`);
}

function parseRunState(text: string, runId: string): RunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const isRunState =
    typeof parsed === "object" &&
    parsed !== null &&
    "runId" in parsed &&
    "tasks" in parsed &&
    Array.isArray(parsed.tasks);
  if (!isRunState) throw new UsageError(`The state of automated run ${runId} isn't readable.`);
  return parsed as RunState;
}

/** A run's saved state, or the latest run's when no ID is given (FR-MCP-015). Undefined when there's none. */
export async function readRunState(target: string, runId?: string): Promise<RunState | undefined> {
  const ids = runId === undefined ? (await readdir(autoFolder(target)).catch(() => [])).sort().reverse() : [runId];
  for (const id of ids) {
    const text = await readFile(path.join(runFolder(target, id), RUN_STATE_FILE), "utf8").catch(() => undefined);
    if (text !== undefined) return parseRunState(text, id);
  }
  return undefined;
}

/** The ID of the live run working on this task, if any (FR-MCP-012). */
export async function findRunHoldingTask(target: string, taskId: number): Promise<string | undefined> {
  const holder = await readLiveLock(path.join(autoFolder(target), AUTO_LOCK_FILE));
  if (holder?.runId === undefined) return undefined;
  const state = await readRunState(target, holder.runId);
  return state?.tasks.some((task) => task.taskId === taskId && task.status === "running") === true
    ? holder.runId
    : undefined;
}

/** Secrets are redacted from everything a run saves (FR-AUTO-027). */
async function writeFileRedacted(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, redact(text).text);
  await rename(temporary, file);
}

export function createRunFiles(folder: string) {
  // Tasks run side by side, so writes go one at a time and a newer state never loses to an older one.
  let writing: Promise<unknown> = Promise.resolve();
  const writeRedacted = (file: string, text: string): Promise<void> => {
    const next = writing.then(() => writeFileRedacted(file, text));
    writing = next.catch(() => undefined);
    return next;
  };
  return {
    saveState: (state: RunState) =>
      writeRedacted(path.join(folder, RUN_STATE_FILE), `${JSON.stringify(state, null, JSON_INDENT)}\n`),
    saveLog: (name: string, text: string) =>
      writeRedacted(path.join(folder, RUN_LOGS_FOLDER, `${name}.txt`), `${text}\n`),
    saveSession: (session: AgentSession) =>
      writeRedacted(
        path.join(folder, RUN_SESSIONS_FOLDER, `${session.sessionId}.json`),
        `${JSON.stringify(session, null, JSON_INDENT)}\n`,
      ),
    saveReport: async (markdown: string) => {
      const file = path.join(folder, RUN_REPORT_FILE);
      await writeRedacted(file, markdown);
      return file;
    },
  };
}
