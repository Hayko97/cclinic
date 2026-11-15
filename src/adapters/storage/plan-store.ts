/** Planning session records and their attachments in `.luseen/plans/<id>/` (FR-PLAN-023, FR-PLAN-030). */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PLAN_ATTACHMENTS_FOLDER,
  PLAN_ID_PATTERN,
  PLAN_SESSION_FILE,
  PLANS_FOLDER,
} from "../../core/constants/agents.js";
import { LOCK_WAIT_MS } from "../../core/constants/limits.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { STATE_LOCK_FILE, STATE_LOCK_STALE_MS } from "../../core/constants/workflow.js";
import { UsageError } from "../../core/errors.js";
import {
  attachmentKind,
  nextPlanId,
  planSessionSchema,
  type PlanSession,
  type StoredAttachment,
} from "../../core/planning.js";
import { redact } from "../../core/redaction.js";
import { ensureIgnoredFolder } from "./document-store.js";
import { takeLock } from "./file-lock.js";
import { listFolder } from "./folder-listing.js";

export interface AttachmentSource {
  /** The file to copy, absolute. */
  readonly file: string;
  /** Its name as the user knows it. */
  readonly name: string;
}

export interface PlanStore {
  /** Every record that can be read, and why each other one can't. */
  list(): Promise<{ readonly sessions: readonly PlanSession[]; readonly problems: readonly string[] }>;
  read(id: string): Promise<PlanSession | undefined>;
  /** Creates a record under the next free ID, in one step with choosing it. */
  create(make: (id: string) => PlanSession): Promise<PlanSession>;
  /**
   * Re-reads the record under the lock and saves what `decide` returns, if anything, before the lock is
   * released, so two processes never overwrite each other's change.
   */
  update<T>(
    id: string,
    decide: (session: PlanSession) => { readonly save?: PlanSession; readonly value: T },
  ): Promise<T>;
  /** FR-PLAN-023: copies the files into the session folder, under unique names; a DOCX also gets its text. */
  copyAttachments(id: string, files: readonly AttachmentSource[]): Promise<StoredAttachment[]>;
  /** FR-PLAN-013, FR-PLAN-014: an approved or cancelled session keeps no attachments. */
  deleteAttachments(id: string): Promise<void>;
}

export function plansFolder(target: string): string {
  return path.join(target, PLANS_FOLDER);
}

async function readSession(file: string): Promise<PlanSession | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: ReturnType<typeof planSessionSchema.safeParse> | undefined;
  try {
    parsed = planSessionSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  // A damaged or newer record is named, and never changed (FR-PLAN-031).
  if (parsed?.success !== true) throw new UsageError(`${file} isn't a readable planning session.`);
  return parsed.data;
}

/** Written to a temporary file and renamed, so a failed write leaves the last record whole (FR-PLAN-030). */
async function writeSession(file: string, session: PlanSession): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${redact(JSON.stringify(session, null, JSON_INDENT)).text}\n`);
  await rename(temporary, file);
}

/** The second file with the same name is `-2`. */
const FIRST_COPY_NUMBER = 2;

/** A name not used yet in the folder: `notes.md`, then `notes-2.md`... */
function uniqueName(name: string, used: ReadonlySet<string>): string {
  // Compared without case, since folders on macOS and Windows treat Notes.md and notes.md as one file.
  const isUsed = (candidate: string) => used.has(candidate.toLowerCase());
  const base = path.basename(name);
  if (!isUsed(base)) return base;
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  for (let number = FIRST_COPY_NUMBER; ; number += 1) {
    const candidate = `${stem}-${number}${extension}`;
    if (!isUsed(candidate)) return candidate;
  }
}

/** Extracts a document's text locally, for the PM to read (FR-PLAN-023). */
export type DocumentReader = (file: string, name: string) => Promise<string>;

export function openPlanStore(target: string, readDocument?: DocumentReader): PlanStore {
  const folder = plansFolder(target);
  const sessionFile = (id: string) => path.join(folder, id, PLAN_SESSION_FILE);
  const withLock = async <T>(run: () => Promise<T>): Promise<T> => {
    // The records and attachments stay on this machine, so they're never committed (FR-PLAN-023).
    await ensureIgnoredFolder(folder);
    const lock = await takeLock(
      path.join(folder, STATE_LOCK_FILE),
      {},
      { signal: AbortSignal.timeout(LOCK_WAIT_MS), staleAfterMs: STATE_LOCK_STALE_MS },
    );
    try {
      return await run();
    } finally {
      // A failed release mustn't hide the save's own error; a lock left behind is replaced later.
      await lock.release().catch(() => undefined);
    }
  };
  const ids = async (): Promise<string[]> => {
    try {
      return (await readdir(folder)).filter((name) => PLAN_ID_PATTERN.test(name));
    } catch (error) {
      // No folder yet means no sessions; any other error, such as no permission, is reported.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  return {
    list: async () => {
      const listing = await listFolder(folder);
      if (listing.kind === "unreadable") return { sessions: [], problems: [listing.problem] };
      const results = await Promise.allSettled((await ids()).map((id) => readSession(sessionFile(id))));
      return {
        sessions: results.flatMap((result) =>
          result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
        ),
        problems: results.flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : [],
        ),
      };
    },
    read: (id) => readSession(sessionFile(id)),
    create: (make) =>
      withLock(async () => {
        const session = make(nextPlanId(await ids()));
        await mkdir(path.dirname(sessionFile(session.id)), { recursive: true });
        await writeSession(sessionFile(session.id), session);
        return session;
      }),
    update: (id, decide) =>
      withLock(async () => {
        const session = await readSession(sessionFile(id));
        if (session === undefined) throw new UsageError(`There's no planning session ${id}.`);
        const { save, value } = decide(session);
        if (save !== undefined) await writeSession(sessionFile(id), save);
        return value;
      }),
    copyAttachments: async (id, files) => {
      const attachments = path.join(folder, id, PLAN_ATTACHMENTS_FOLDER);
      await mkdir(attachments, { recursive: true });
      const used = new Set((await readdir(attachments)).map((name) => name.toLowerCase()));
      const stored: StoredAttachment[] = [];
      for (const file of files) {
        const kind = attachmentKind(file.name);
        if (kind === undefined) throw new UsageError(`${file.name} can't be attached.`);
        const name = uniqueName(file.name, used);
        used.add(name.toLowerCase());
        const copy = path.join(attachments, name);
        await copyFile(file.file, copy);
        let textPath: string | null = null;
        if (path.extname(name).toLowerCase() === ".docx") {
          if (readDocument === undefined) throw new UsageError(`${file.name} needs a document reader to be attached.`);
          const textName = uniqueName(`${name}.md`, used);
          used.add(textName.toLowerCase());
          // Secrets are redacted, as in every text luseen writes for an agent (FR-PLAN-023).
          await writeFile(path.join(attachments, textName), redact(await readDocument(copy, file.name)).text);
          textPath = path.relative(target, path.join(attachments, textName));
        }
        stored.push({
          name: file.name,
          kind,
          path: path.relative(target, copy),
          textPath,
          sizeBytes: (await stat(copy)).size,
        });
      }
      return stored;
    },
    deleteAttachments: (id) => rm(path.join(folder, id, PLAN_ATTACHMENTS_FOLDER), { recursive: true, force: true }),
  };
}
