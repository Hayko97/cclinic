/** The files of an automated run in `.cclinic/auto/<run-id>`, and the lock that allows one run at a time. */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSessionSchema, type AgentSession, type RunFiles, type RunState } from "../../core/automation.js";
import {
  AUTO_FOLDER,
  AUTO_LOCK_FILE,
  RUN_LOGS_FOLDER,
  RUN_ID_PATTERN,
  RUN_ID_TIME_LENGTH,
  RUN_FILE_MAX_CHARS,
  RUN_REPORT_FILE,
  RUN_SESSIONS_FOLDER,
  RUN_STATE_FILE,
} from "../../core/constants/agents.js";
import { LOCK_WAIT_MS } from "../../core/constants/limits.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { UsageError } from "../../core/errors.js";
import { redact } from "../../core/redaction.js";
import { readLiveHolder, takeLock, type LockHolder } from "./file-lock.js";
import { listFolder } from "./folder-listing.js";

export function autoFolder(target: string): string {
  return path.join(target, AUTO_FOLDER);
}

export function runFolder(target: string, runId: string): string {
  return path.join(autoFolder(target), runId);
}

export function isRunFolderUsed(target: string, runId: string): boolean {
  return existsSync(runFolder(target, runId));
}

function runIdOf(holder: LockHolder): string | undefined {
  return typeof holder["runId"] === "string" ? holder["runId"] : undefined;
}

function lockedError(holder: LockHolder, cause?: unknown): UsageError {
  return new UsageError(
    `Automated run ${runIdOf(holder) ?? "unknown"} (process ${holder.pid}) is already working on this project.`,
    cause === undefined ? undefined : { cause },
  );
}

/** Refuses early, creating nothing, when another run is working on the project (FR-AUTO-032). */
export async function checkNoRunGoing(target: string): Promise<void> {
  const holder = await readLiveHolder(path.join(autoFolder(target), AUTO_LOCK_FILE));
  if (holder !== undefined) throw lockedError(holder);
}

/** One run per project. A lock from a process that has ended is replaced (FR-AUTO-032). */
export async function acquireRunLock(target: string, runId: string): Promise<() => Promise<void>> {
  const lockFile = path.join(autoFolder(target), AUTO_LOCK_FILE);
  await mkdir(path.dirname(lockFile), { recursive: true });
  const lock = await takeLock(
    lockFile,
    { runId },
    { signal: AbortSignal.timeout(LOCK_WAIT_MS), refuse: (holder) => lockedError(holder) },
  );
  return lock.release;
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
  const holder = await readLiveHolder(path.join(autoFolder(target), AUTO_LOCK_FILE));
  const runId = holder === undefined ? undefined : runIdOf(holder);
  if (runId === undefined) return undefined;
  const state = await readRunState(target, runId);
  return state?.tasks.some((task) => task.taskId === taskId && task.status === "running") === true ? runId : undefined;
}

/** The sessions recorded for a run's agents (FR-AUTO-039), and why any file of them couldn't be read. */
async function readRunSessions(
  target: string,
  runId: string,
): Promise<{ readonly sessions: AgentSession[]; readonly problems: string[] }> {
  const folder = path.join(runFolder(target, runId), RUN_SESSIONS_FOLDER);
  // A sessions folder that can't be read is reported, not taken for a run with no sessions.
  const listing = await listFolder(folder);
  if (listing.kind === "unreadable") return { sessions: [], problems: [listing.problem] };
  const names = listing.names.filter((name) => name.endsWith(".json"));
  const sessions: AgentSession[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const file = path.join(folder, name);
    try {
      sessions.push(agentSessionSchema.parse(JSON.parse(await readFile(file, "utf8"))));
    } catch {
      problems.push(`${file} isn't a readable agent session, so it's left out.`);
    }
  }
  return { sessions, problems };
}

/** Run IDs newest first: by time, then by the `-2`, `-3`... added to a second run in the same second. */
function newestFirst(a: string, b: string): number {
  const time = (id: string) => id.slice(0, RUN_ID_TIME_LENGTH);
  // The first run in a second has no suffix, and counts as 1.
  const suffix = (id: string) => (id.length > RUN_ID_TIME_LENGTH ? Number(id.slice(RUN_ID_TIME_LENGTH + 1)) : 1);
  return time(b).localeCompare(time(a)) || suffix(b) - suffix(a);
}

export interface RunListing {
  readonly runs: {
    readonly state: RunState;
    readonly sessions: AgentSession[];
    readonly isLive: boolean;
    /** The process running a live run, from the run lock (FR-GUI-031). */
    readonly pid: number | null;
  }[];
  /** Run states and session files that couldn't be read, left out instead of failing (FR-GUI-014). */
  readonly problems: string[];
}

type RunEntry = RunListing["runs"][number];

/**
 * Lists the project's runs, newest first, with their agents' sessions and whether each is still going
 * (FR-GUI-029, FR-GUI-068, FR-GUI-077). Every run is listed, since a task's cost and earlier agents come from
 * all of them. A finished run never changes, so it's read once; runs are read one at a time, so a long history
 * can't exhaust open files.
 */
export function createRunLister(target: string): () => Promise<RunListing> {
  const finished = new Map<string, RunEntry>();
  return async () => {
    const holder = await readLiveHolder(path.join(autoFolder(target), AUTO_LOCK_FILE));
    const liveRunId = holder === undefined ? undefined : runIdOf(holder);
    const ids = (await readdir(autoFolder(target)).catch(() => []))
      .filter((name) => RUN_ID_PATTERN.test(name))
      .sort(newestFirst);
    const listing: RunListing = { runs: [], problems: [] };
    for (const id of ids) {
      const known = finished.get(id);
      if (known !== undefined && id !== liveRunId) {
        listing.runs.push(known);
        continue;
      }
      const state = await readRunState(target, id).catch((error: unknown) => {
        listing.problems.push(error instanceof Error ? error.message : String(error));
        return undefined;
      });
      if (state === undefined) continue;
      const { sessions, problems } = await readRunSessions(target, id);
      listing.problems.push(...problems);
      const isLive = id === liveRunId;
      const entry = { state, sessions, isLive, pid: isLive && holder !== undefined ? holder.pid : null };
      // Kept only once whole: a run with a damaged session file is read again, in case it's fixed.
      if (state.finishedAt !== null && !entry.isLive && problems.length === 0) finished.set(id, entry);
      listing.runs.push(entry);
    }
    // Forget runs whose folders were removed.
    for (const id of finished.keys()) if (!ids.includes(id)) finished.delete(id);
    return listing;
  };
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

/** The newest part of a saved file, so one huge log can't fill the page (FR-GUI-032). */
function newestPart(text: string): { readonly text: string; readonly isTruncated: boolean } {
  if (text.length <= RUN_FILE_MAX_CHARS) return { text, isTruncated: false };
  const part = text.slice(text.length - RUN_FILE_MAX_CHARS);
  // It starts at a whole line, so no line is shown cut in half.
  return { text: part.slice(part.indexOf("\n") + 1), isTruncated: true };
}

/**
 * A run's file, or undefined when it isn't there. Any other failure is reported with the file's name, not shown as
 * a missing or empty file (FR-GUI-014).
 */
async function readRunFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(`${file} can't be read: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/**
 * FR-GUI-032: a run's report and agent logs, redacted again in case a file was edited by hand. Undefined when
 * there's no such run. The ID must be a run ID, so it can't name another folder.
 */
export async function readRunFiles(target: string, runId: string): Promise<RunFiles | undefined> {
  if (!RUN_ID_PATTERN.test(runId)) return undefined;
  const folder = runFolder(target, runId);
  if ((await readRunFile(path.join(folder, RUN_STATE_FILE))) === undefined) return undefined;
  const report = await readRunFile(path.join(folder, RUN_REPORT_FILE));
  const listing = await listFolder(path.join(folder, RUN_LOGS_FOLDER));
  // A logs folder that can't be read is reported, not shown as a run with no logs.
  if (listing.kind === "unreadable") throw new UsageError(listing.problem);
  // Only files are logs; anything else in the folder, such as a folder, isn't one. One that can't be checked is
  // kept, so reading it reports why.
  const names = [];
  for (const name of [...listing.names].sort())
    if ((await stat(path.join(folder, RUN_LOGS_FOLDER, name)).catch(() => undefined))?.isFile() !== false)
      names.push(name);
  const logs = await Promise.all(
    names.map(async (name) => ({
      name,
      ...newestPart(redact((await readRunFile(path.join(folder, RUN_LOGS_FOLDER, name))) ?? "").text),
    })),
  );
  const shownReport = report === undefined ? undefined : newestPart(redact(report).text);
  return { report: shownReport?.text ?? null, reportIsTruncated: shownReport?.isTruncated ?? false, logs };
}
