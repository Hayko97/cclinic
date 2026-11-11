/** Reads Claude Code session transcripts, only from where Claude Code keeps them (FR-GUI-040 to FR-GUI-043). */
import { realpathSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { TranscriptLines, TranscriptLocation, TranscriptPosition } from "../../core/canvas.js";
import { SESSION_ID_PATTERN, TRANSCRIPT_MAX_READ_BYTES } from "../../core/constants/gui.js";

const TRANSCRIPT_EXTENSION = ".jsonl";
const SESSION_ID = new RegExp(`^${SESSION_ID_PATTERN}$`);

/** Only a path that isn't there counts as missing; any other error, such as no permission, is reported. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real path, following links, or nothing when it isn't there. */
function realPath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** The real path of a regular `.jsonl` file, following links; nothing for anything else. */
function realTranscript(file: string): string | undefined {
  const real = realPath(file);
  return real !== undefined && real.endsWith(TRANSCRIPT_EXTENSION) && statSync(real).isFile() ? real : undefined;
}

async function folderNames(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * FR-GUI-041: the recorded file, if it's a `.jsonl` file inside Claude Code's projects folder (links followed);
 * else, when it doesn't exist, the session's file in any project folder, since Claude Code shortens long names.
 */
export async function locateTranscript(
  recorded: string,
  sessionId: string,
  projectsFolder: string,
): Promise<TranscriptLocation> {
  const projectsPath = path.resolve(projectsFolder);
  const projects = realPath(projectsPath);
  const inside = (file: string) => projects !== undefined && file.startsWith(`${projects}${path.sep}`);
  const resolved = path.resolve(recorded);
  if (!resolved.endsWith(TRANSCRIPT_EXTENSION)) return { kind: "refused" };
  if (realPath(resolved) !== undefined) {
    const real = realTranscript(resolved);
    return real !== undefined && inside(real) ? { kind: "found", file: real } : { kind: "refused" };
  }
  // A path that doesn't exist must still be one Claude Code could have written there.
  if (!resolved.startsWith(`${projectsPath}${path.sep}`) && !inside(resolved)) return { kind: "refused" };
  if (projects === undefined || !SESSION_ID.test(sessionId)) return { kind: "missing" };
  for (const folder of await folderNames(projects)) {
    const candidate = realTranscript(path.join(projects, folder, `${sessionId}${TRANSCRIPT_EXTENSION}`));
    if (candidate !== undefined && inside(candidate)) return { kind: "found", file: candidate };
  }
  return { kind: "missing" };
}

const START: TranscriptPosition = { offset: 0, fileId: "" };

/**
 * FR-GUI-042: the whole lines added since `from`. A last line still being written is left for the next read,
 * so it's never split, and at most the newest TRANSCRIPT_MAX_READ_BYTES are read at once.
 */
export async function readTranscriptLines(file: string, from: TranscriptPosition = START): Promise<TranscriptLines> {
  const info = await stat(file);
  const fileId = `${info.dev}:${info.ino}`;
  const isRestart = from.fileId !== "" && (fileId !== from.fileId || info.size < from.offset);
  let start = isRestart ? 0 : from.offset;
  const isTruncated = info.size - start > TRANSCRIPT_MAX_READ_BYTES;
  if (isTruncated) start = info.size - TRANSCRIPT_MAX_READ_BYTES;
  if (info.size === start) return { lines: [], next: { offset: start, fileId }, isRestart, isTruncated };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const read = buffer.subarray(0, bytesRead);
    // After a jump to the newest part, the first line is only part of one.
    const first = isTruncated ? read.indexOf("\n") + 1 : 0;
    const end = read.lastIndexOf("\n");
    if (end < first) return { lines: [], next: { offset: start + first, fileId }, isRestart, isTruncated };
    const lines = read
      .subarray(first, end)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return { lines, next: { offset: start + end + 1, fileId }, isRestart, isTruncated };
  } finally {
    await handle.close();
  }
}
