/** The canvas, its layout and session transcripts, as the GUI's API serves them (spec: gui). */
import {
  allSessions,
  buildCanvas,
  layoutSchema,
  parseTranscriptLine,
  pruneLayout,
  resolveLayout,
  tidyFrame,
  tidyRequestSchema,
  cardOrder,
  frameWidths,
  nextStep,
  type NextStep,
  type CanvasSources,
  type CanvasView,
  type Layout,
  type SessionView,
  type TranscriptEntry,
  type TranscriptLines,
  type TranscriptLocation,
  type TranscriptPosition,
} from "../core/canvas.js";
import {
  CANVAS_POLL_MS,
  LAYOUT,
  LAYOUT_VERSION,
  TRANSCRIPT_MAX_ENTRIES,
  TRANSCRIPT_POLL_MS,
} from "../core/constants/gui.js";
import type { SendEvent } from "../core/gui.js";
import { redact } from "../core/redaction.js";

export interface CanvasPorts {
  readonly readSources: () => Promise<CanvasSources>;
  readonly readLayout: () => Promise<Layout | undefined>;
  /** Whether `cclinic` has generated the project's documents yet (FR-GUI-053). */
  readonly hasDocuments: () => boolean;
  /** Saves what `change` makes of the saved layout, one change at a time, so none is lost to another. */
  readonly updateLayout: (change: (saved: Layout | undefined) => Layout) => Promise<void>;
  /** FR-GUI-041: where a session's transcript may be read from, if anywhere. */
  readonly locateTranscript: (session: SessionView) => Promise<TranscriptLocation>;
  /** The whole lines added to a transcript since `from`, where `from` undefined means its start. */
  readonly readTranscript: (file: string, from: TranscriptPosition | undefined) => Promise<TranscriptLines>;
  readonly now: () => Date;
  /** Runs `run` every `ms`, and returns what stops it. `run` resolves once its check is done. */
  readonly every: (ms: number, run: () => Promise<void>) => () => void;
}

/** FR-GUI-011: an error's message can quote the file it failed on, so it's redacted too. */
export function problemOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).text;
}

const EMPTY_LAYOUT: Layout = { version: LAYOUT_VERSION, frames: {}, cards: {} };

export interface CanvasPayload {
  readonly canvas: CanvasView;
  /** Every frame and card's position: saved where it was moved by hand, else placed automatically. */
  readonly layout: Layout;
  /** Each frame's width, by frame key: the one rule the server lays frames out by (FR-GUI-074). */
  readonly frameWidths: Readonly<Record<string, number>>;
  /** FR-GUI-080: the order keyboard focus goes through the cards. */
  readonly cardOrder: readonly string[];
  /** FR-GUI-053: the step the canvas suggests, if any. */
  readonly nextStep: NextStep | null;
  /** The automatic layout's sizes, so the page draws frames and columns on the same grid (FR-GUI-074). */
  readonly sizes: typeof LAYOUT;
}

export async function readCanvas(ports: CanvasPorts): Promise<CanvasPayload> {
  const canvas = buildCanvas(await ports.readSources(), ports.now());
  const saved = await ports.readLayout();
  return {
    canvas,
    layout: resolveLayout(canvas, saved),
    frameWidths: frameWidths(canvas),
    cardOrder: cardOrder(canvas),
    nextStep: nextStep(canvas, ports.hasDocuments()),
    sizes: LAYOUT,
  };
}

/** FR-GUI-022, FR-GUI-075: the canvas now, then each time it changes. */
export function streamCanvas(ports: CanvasPorts, send: SendEvent): () => void {
  let last = "";
  let lastProblem = "";
  let isBusy = false;
  const check = async (): Promise<void> => {
    if (isBusy) return;
    isBusy = true;
    try {
      const payload = await readCanvas(ports);
      const text = JSON.stringify(payload);
      lastProblem = "";
      if (text !== last) {
        last = text;
        send("canvas", payload);
      }
    } catch (error) {
      // Sent once while it lasts, not on every check.
      const message = problemOf(error);
      if (message !== lastProblem) send("problem", { message });
      lastProblem = message;
    } finally {
      isBusy = false;
    }
  };
  void check();
  return ports.every(CANVAS_POLL_MS, check);
}

/**
 * FR-GUI-075: positions of what's gone are dropped, but only when everything was read. A task database or
 * workflow state that couldn't be read looks like removed tasks, and their positions must survive it.
 */
function prunedIfComplete(canvas: CanvasView, layout: Layout): Layout {
  return canvas.problems.length === 0 ? pruneLayout(canvas, layout) : layout;
}

/**
 * FR-GUI-073: positions the browser moved, refused unless they have the saved shape. They're added to what's
 * saved, so a tab that sends only its own move never undoes another tab's.
 */
export async function saveCanvasLayout(ports: CanvasPorts, body: unknown): Promise<Layout | undefined> {
  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const moved = parsed.data;
  const canvas = buildCanvas(await ports.readSources(), ports.now());
  let layout: Layout = EMPTY_LAYOUT;
  await ports.updateLayout((saved) => {
    const base = saved ?? EMPTY_LAYOUT;
    layout = prunedIfComplete(canvas, {
      version: LAYOUT_VERSION,
      frames: { ...base.frames, ...moved.frames },
      cards: { ...base.cards, ...moved.cards },
    });
    return layout;
  });
  return layout;
}

/** FR-GUI-074: Tidy up forgets one frame's saved positions, so it's placed automatically again. */
export async function tidyCanvasFrame(
  ports: CanvasPorts,
  body: unknown,
): Promise<{ readonly status: "invalid" | "unknown" } | { readonly status: "done"; readonly layout: Layout }> {
  const parsed = tidyRequestSchema.safeParse(body);
  if (!parsed.success) return { status: "invalid" };
  const canvas = buildCanvas(await ports.readSources(), ports.now());
  // FR-GUI-010: only a frame that's on the canvas.
  if (!Object.hasOwn(resolveLayout(canvas, undefined).frames, parsed.data.frame)) return { status: "unknown" };
  let tidied: Layout | undefined;
  await ports.updateLayout((saved) => {
    // Only what was saved: frames nobody moved keep being placed automatically.
    tidied = prunedIfComplete(canvas, tidyFrame(canvas, saved ?? EMPTY_LAYOUT, parsed.data.frame));
    return tidied;
  });
  return { status: "done", layout: resolveLayout(canvas, tidied) };
}

export async function findSession(ports: CanvasPorts, id: string): Promise<SessionView | undefined> {
  return allSessions(await ports.readSources(), ports.now()).find((session) => session.id === id);
}

export interface TranscriptPart {
  readonly entries: readonly TranscriptEntry[];
  /** The file was too large, so only its newest part is shown. */
  readonly isTruncated: boolean;
  /** FR-GUI-043: lines that couldn't be read. */
  readonly skipped: number;
  /** Older entries left out to keep the newest within the limit. */
  readonly dropped: number;
}

function toEntries(lines: readonly string[], isTruncated: boolean): TranscriptPart {
  let skipped = 0;
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    const parsed = parseTranscriptLine(line);
    if (parsed.isSkipped) skipped += 1;
    entries.push(...parsed.entries);
  }
  const dropped = Math.max(0, entries.length - TRANSCRIPT_MAX_ENTRIES);
  return { entries: entries.slice(dropped), isTruncated, skipped, dropped };
}

export type TranscriptRead =
  ({ readonly status: "found" } & TranscriptPart) | { readonly status: "missing" | "refused" };

/** FR-GUI-040, FR-GUI-043: a session's transcript as it is now. */
export async function readSessionTranscript(ports: CanvasPorts, session: SessionView): Promise<TranscriptRead> {
  const location = await ports.locateTranscript(session);
  if (location.kind !== "found") return { status: location.kind };
  const read = await ports.readTranscript(location.file, undefined);
  return { status: "found", ...toEntries(read.lines, read.isTruncated) };
}

/**
 * FR-GUI-042: the transcript so far, then its new entries as Claude Code writes them, for as long as it's open.
 * A `transcript` event replaces what was shown: first, and when the file was replaced or shrank.
 */
export function streamTranscript(ports: CanvasPorts, session: SessionView, send: SendEvent): () => void {
  let file: string | undefined;
  let position: TranscriptPosition | undefined;
  let isBusy = false;
  let lastStatus = "";
  const check = async (): Promise<void> => {
    if (isBusy) return;
    isBusy = true;
    try {
      if (file === undefined) {
        const location = await ports.locateTranscript(session);
        if (location.kind !== "found") {
          // Said once, and looked for again, since a transcript can appear after its session starts.
          if (location.kind !== lastStatus) send(location.kind, { session });
          lastStatus = location.kind;
          return;
        }
        file = location.file;
        position = undefined;
      }
      const read = await ports.readTranscript(file, position);
      const isFirst = position === undefined;
      position = read.next;
      lastStatus = "found";
      // FR-GUI-042: a replaced, shrunk or far-grown file replaces what's shown, so old and new lines never mix.
      if (isFirst || read.isRestart || read.isTruncated)
        send("transcript", { session, ...toEntries(read.lines, read.isTruncated) });
      // New lines only: the session's live state comes from the canvas stream, which stays current.
      else if (read.lines.length > 0) send("entries", toEntries(read.lines, read.isTruncated));
    } catch (error) {
      // The file went away: it's looked for again on the next check.
      file = undefined;
      const message = problemOf(error);
      if (message !== lastStatus) send("problem", { message });
      lastStatus = message;
    } finally {
      isBusy = false;
    }
  };
  void check();
  return ports.every(TRANSCRIPT_POLL_MS, check);
}
