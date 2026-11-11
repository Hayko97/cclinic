/**
 * The canvas: roadmaps as frames, tasks as cards with their mode, agents and Claude Code sessions, the
 * transcript entries of a session, and the canvas layout (spec: gui). Pure: no I/O.
 */
import { z } from "zod";
import type { AgentSession, RunState } from "./automation.js";
import {
  LAYOUT,
  LAYOUT_MAX_COORDINATE,
  LAYOUT_MAX_ITEMS,
  LAYOUT_VERSION,
  SESSION_ACTIVITY_MS,
  TRANSCRIPT_MAX_TEXT_CHARS,
} from "./constants/gui.js";
import { redact } from "./redaction.js";
import type { RoadmapOverview, Task, TaskStatus } from "./tasks.js";
import { isOpenChange, type WorkflowState } from "./workflow.js";

export interface RunSource {
  readonly state: RunState;
  readonly sessions: readonly AgentSession[];
  /** The run still holds the project's run lock. */
  readonly isLive: boolean;
}

export interface CanvasSources {
  readonly overview: RoadmapOverview;
  readonly runs: readonly RunSource[];
  readonly workflows: readonly WorkflowState[];
  /** What couldn't be read, such as a damaged workflow state, shown instead of failing (FR-GUI-014). */
  readonly problems: readonly string[];
}

export type SessionRole = AgentSession["role"] | "you";

export interface SessionView {
  readonly id: string;
  readonly source: "agent" | "interactive";
  readonly role: SessionRole;
  readonly step: string | null;
  readonly runId: string | null;
  readonly taskId: number | null;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly isLive: boolean;
  readonly transcriptPath: string;
}

export type TaskMode = "ai" | "manual";

export interface ChangeView {
  readonly key: string;
  readonly taskId: number | null;
  readonly spec: string;
  readonly step: string;
  readonly status: string;
  readonly reason: string | null;
  readonly approverMode: string;
  readonly qaRuns: number;
  readonly reviews: number;
  readonly decisions: number;
  readonly skips: number;
  readonly pendingQuestion: string | null;
  readonly sessions: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface TaskView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly spec: string | null;
  readonly milestoneId: number | null;
  readonly roadmapId: number | null;
  readonly dependsOn: readonly number[];
  /** Its dependencies that aren't done yet (FR-GUI-054). */
  readonly waitingOn: readonly number[];
  readonly mode: TaskMode | null;
  readonly runId: string | null;
  readonly step: string | null;
  /** FR-GUI-077: the sessions working on it now, and those that did before, newest first (FR-GUI-039). */
  readonly sessions: readonly SessionView[];
  readonly costUsd: number;
  readonly needsYou: boolean;
  readonly change: ChangeView | null;
}

export interface RoadmapView {
  readonly id: number;
  readonly title: string;
  readonly goal: string | null;
  readonly status: string;
  readonly mode: "ai" | null;
  readonly runId: string | null;
  readonly done: number;
  readonly total: number;
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly milestones: readonly {
    readonly id: number;
    readonly title: string;
    readonly goal: string | null;
    readonly taskIds: readonly number[];
  }[];
}

export interface CanvasView {
  readonly roadmaps: readonly RoadmapView[];
  readonly unassigned: readonly number[];
  /** FR-GUI-037: changes keyed by branch, with no task. */
  readonly changes: readonly ChangeView[];
  readonly tasks: readonly TaskView[];
  readonly problems: readonly string[];
}

function changeView(state: WorkflowState): ChangeView {
  return {
    key: state.key,
    taskId: state.taskId,
    spec: state.spec,
    step: state.step,
    status: state.status,
    reason: state.reason === null ? null : shown(state.reason),
    approverMode: state.approverMode,
    qaRuns: state.qaRuns.length,
    reviews: state.reviews.length,
    decisions: state.decisions.length,
    skips: state.skips.length,
    pendingQuestion: state.pending !== null && state.pending.answer === null ? shown(state.pending.question) : null,
    sessions: state.sessions.length,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * FR-GUI-039: sessions working now first, as their step is the task's current one, then the newest. Nothing
 * here changes from one check to the next unless a session does, so an unchanged canvas isn't sent again.
 */
function liveThenNewest(a: SessionView, b: SessionView): number {
  return Number(b.isLive) - Number(a.isLive) || b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function agentSessionView(session: AgentSession, run: RunSource): SessionView {
  const isLive = run.isLive && session.endedAt === null;
  return {
    id: session.sessionId,
    source: "agent",
    role: session.role,
    step: session.step,
    runId: run.state.runId,
    taskId: session.taskId,
    startedAt: session.startedAt,
    lastActivityAt: session.endedAt ?? session.startedAt,
    isLive,
    transcriptPath: session.transcriptPath,
  };
}

function interactiveSessionViews(state: WorkflowState, now: Date): SessionView[] {
  return state.sessions.map((session) => ({
    id: session.sessionId,
    source: "interactive",
    role: "you",
    step: state.step,
    runId: null,
    taskId: state.taskId,
    startedAt: session.firstSeenAt,
    lastActivityAt: session.lastSeenAt,
    isLive: now.getTime() - Date.parse(session.lastSeenAt) <= SESSION_ACTIVITY_MS,
    transcriptPath: session.transcriptPath,
  }));
}

/** Every session cclinic knows of: agents of runs (FR-AUTO-039) and the user's own (FR-MCP-045). */
export function allSessions(sources: Pick<CanvasSources, "runs" | "workflows">, now: Date): SessionView[] {
  return [
    ...sources.runs.flatMap((run) => run.sessions.map((session) => agentSessionView(session, run))),
    ...sources.workflows.flatMap((state) => interactiveSessionViews(state, now)),
  ].sort(liveThenNewest);
}

function openThenNewest(a: WorkflowState, b: WorkflowState): number {
  return Number(isOpenChange(b)) - Number(isOpenChange(a)) || b.updatedAt.localeCompare(a.updatedAt);
}

/** FR-GUI-076, FR-GUI-077: everything the canvas shows, from the task database, runs and workflow states. */
export function buildCanvas(sources: CanvasSources, now: Date): CanvasView {
  const { overview } = sources;
  const liveRun = sources.runs.find((run) => run.isLive);
  const sessions = allSessions(sources, now);
  const roadmapOf = new Map<number, number>();
  for (const roadmap of overview.roadmaps)
    for (const milestone of roadmap.milestones) roadmapOf.set(milestone.id, roadmap.id);
  const allTasks: Task[] = [
    ...overview.roadmaps.flatMap((roadmap) => roadmap.milestones.flatMap((milestone) => milestone.tasks)),
    ...overview.unassigned,
  ];
  const statusOf = new Map(allTasks.map((task) => [task.id, task.status]));
  const changeOf = (taskId: number): WorkflowState | undefined =>
    sources.workflows.filter((state) => state.taskId === taskId).sort(openThenNewest)[0];

  const tasks = allTasks.map((task): TaskView => {
    const isInRun = liveRun?.state.tasks.some((run) => run.taskId === task.id && run.status === "running") === true;
    const change = changeOf(task.id);
    const isManual = change !== undefined && isOpenChange(change) && change.approverMode === "user";
    const own = sessions.filter((session) => session.taskId === task.id);
    const liveAgent = own.find((session) => session.source === "agent" && session.runId === liveRun?.state.runId);
    const runCost = sources.runs.reduce(
      (total, run) => total + (run.state.tasks.find((item) => item.taskId === task.id)?.costUsd ?? 0),
      0,
    );
    return {
      id: task.id,
      title: shown(task.title),
      description: task.description === null ? null : shown(task.description),
      status: task.status,
      spec: task.spec,
      milestoneId: task.milestoneId,
      roadmapId: task.milestoneId === null ? null : (roadmapOf.get(task.milestoneId) ?? null),
      dependsOn: task.dependsOn,
      waitingOn: task.dependsOn.filter((id) => statusOf.get(id) !== "done"),
      mode: isInRun ? "ai" : isManual ? "manual" : null,
      runId: isInRun ? liveRun.state.runId : null,
      step: isInRun ? (liveAgent?.step ?? null) : isManual ? change.step : null,
      sessions: own,
      costUsd: runCost + (change?.costUsd ?? 0),
      needsYou: change?.pending !== null && change?.pending !== undefined && change.pending.answer === null,
      change: change === undefined ? null : changeView(change),
    };
  });

  const roadmaps = overview.roadmaps.map((roadmap): RoadmapView => {
    const isRunning = liveRun?.state.roadmapId === roadmap.id;
    const own = roadmap.milestones.flatMap((milestone) => milestone.tasks);
    return {
      id: roadmap.id,
      title: shown(roadmap.title),
      goal: roadmap.goal === null ? null : shown(roadmap.goal),
      status: roadmap.status,
      mode: isRunning ? "ai" : null,
      runId: isRunning ? liveRun.state.runId : null,
      done: own.filter((task) => task.status === "done").length,
      total: own.length,
      spentUsd: isRunning ? liveRun.state.spentUsd : null,
      budgetUsd: isRunning ? liveRun.state.budgetUsd : null,
      milestones: roadmap.milestones.map((milestone) => ({
        id: milestone.id,
        title: shown(milestone.title),
        goal: milestone.goal === null ? null : shown(milestone.goal),
        taskIds: milestone.tasks.map((task) => task.id),
      })),
    };
  });

  return {
    roadmaps,
    unassigned: overview.unassigned.map((task) => task.id),
    // FR-GUI-037: every change keyed by a branch, open and stopped ones first, then the newest.
    changes: sources.workflows
      .filter((state) => state.taskId === null)
      .sort(openThenNewest)
      .map(changeView),
    tasks,
    problems: sources.problems,
  };
}

/** FR-GUI-041: where a session's transcript may be read from, if anywhere. */
export type TranscriptLocation =
  { readonly kind: "found"; readonly file: string } | { readonly kind: "missing" } | { readonly kind: "refused" };

/** Where a transcript read got to, and which file it was, so a file replaced meanwhile is noticed. */
export interface TranscriptPosition {
  readonly offset: number;
  readonly fileId: string;
}

export interface TranscriptLines {
  readonly lines: string[];
  readonly next: TranscriptPosition;
  /** The file was replaced or shrank, so these lines start it again and replace what was read before. */
  readonly isRestart: boolean;
  /** Only the newest part was read, because the file was larger than the read limit. */
  readonly isTruncated: boolean;
}

export type TranscriptKind = "user" | "assistant" | "tool-call" | "tool-result";

export interface TranscriptEntry {
  readonly kind: TranscriptKind;
  readonly text: string;
  readonly tool: string | null;
  readonly at: string | null;
}

/** Lines Claude Code writes that aren't part of the conversation, so they're left out without counting as skipped. */
const NOT_CONVERSATION: ReadonlySet<string> = new Set([
  "summary",
  "system",
  "mode",
  "session-owner",
  "file-history-snapshot",
  "attachment",
  "progress",
  "queue-operation",
]);

const blockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
});

/** Claude Code's transcript format isn't published, so only what's shown is checked, and anything else is skipped. */
const lineSchema = z.looseObject({
  type: z.string(),
  timestamp: z.string().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(blockSchema)]) }).optional(),
});

function shown(text: string): string {
  const clean = redact(text).text;
  return clean.length > TRANSCRIPT_MAX_TEXT_CHARS ? `${clean.slice(0, TRANSCRIPT_MAX_TEXT_CHARS)}…` : clean;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => blockSchema.safeParse(part))
    .map((parsed) => (parsed.success ? (parsed.data.text ?? "") : ""))
    .join("\n");
}

/** FR-GUI-040, FR-GUI-043: one transcript line's messages and tool calls, or that it was skipped. */
export function parseTranscriptLine(line: string): {
  readonly entries: TranscriptEntry[];
  readonly isSkipped: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { entries: [], isSkipped: true };
  }
  const result = lineSchema.safeParse(parsed);
  if (!result.success) return { entries: [], isSkipped: true };
  const { type, timestamp, message } = result.data;
  if (NOT_CONVERSATION.has(type)) return { entries: [], isSkipped: false };
  if ((type !== "user" && type !== "assistant") || message === undefined) return { entries: [], isSkipped: true };
  const at = timestamp ?? null;
  if (typeof message.content === "string")
    return { entries: [{ kind: type, text: shown(message.content), tool: null, at }], isSkipped: false };
  const entries = message.content.flatMap((block): TranscriptEntry[] => {
    if (block.type === "text" && block.text !== undefined)
      return [{ kind: type, text: shown(block.text), tool: null, at }];
    if (block.type === "tool_use")
      return [{ kind: "tool-call", text: shown(JSON.stringify(block.input ?? {})), tool: block.name ?? null, at }];
    if (block.type === "tool_result")
      return [{ kind: "tool-result", text: shown(resultText(block.content)), tool: null, at }];
    // Thinking and other blocks aren't part of what the user reads.
    return [];
  });
  return { entries, isSkipped: false };
}

const pointSchema = z.strictObject({
  x: z.number().min(-LAYOUT_MAX_COORDINATE).max(LAYOUT_MAX_COORDINATE),
  y: z.number().min(-LAYOUT_MAX_COORDINATE).max(LAYOUT_MAX_COORDINATE),
});
const layoutKeySchema = z
  .string()
  .regex(/^(roadmap-[1-9]\d{0,9}|task-[1-9]\d{0,9}|unassigned|changes|change-[\w.-]{1,300})$/);
const pointsSchema = z
  .record(layoutKeySchema, pointSchema)
  .refine((points) => Object.keys(points).length <= LAYOUT_MAX_ITEMS, "Too many positions.");

/** FR-GUI-073: frame positions on the canvas, and card positions inside their frame. */
export const layoutSchema = z.strictObject({
  version: z.literal(LAYOUT_VERSION),
  frames: pointsSchema,
  cards: pointsSchema,
});
export type Layout = z.infer<typeof layoutSchema>;
type Point = z.infer<typeof pointSchema>;

/** Within a column, a task comes after the tasks it depends on in that column. */
function inDependencyOrder(ids: readonly number[], tasks: ReadonlyMap<number, TaskView>): number[] {
  const inColumn = new Set(ids);
  const depth = new Map<number, number>();
  const depthOf = (id: number, seen: ReadonlySet<number>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const parents = (tasks.get(id)?.dependsOn ?? []).filter((parent) => inColumn.has(parent) && !seen.has(parent));
    const value =
      parents.length === 0 ? 0 : 1 + Math.max(...parents.map((parent) => depthOf(parent, new Set([...seen, id]))));
    depth.set(id, value);
    return value;
  };
  return [...ids].sort((a, b) => depthOf(a, new Set()) - depthOf(b, new Set()) || a - b);
}

interface FramePlan {
  readonly key: string;
  readonly columns: readonly (readonly string[])[];
}

function framePlans(view: CanvasView): FramePlan[] {
  const tasks = new Map(view.tasks.map((task) => [task.id, task]));
  const cards = (ids: readonly number[]) => inDependencyOrder(ids, tasks).map((id) => `task-${id}`);
  return [
    ...view.roadmaps.map((roadmap) => ({
      key: `roadmap-${roadmap.id}`,
      columns: roadmap.milestones.map((milestone) => cards(milestone.taskIds)),
    })),
    ...(view.unassigned.length === 0 ? [] : [{ key: "unassigned", columns: [cards(view.unassigned)] }]),
    ...(view.changes.length === 0
      ? []
      : [{ key: "changes", columns: [view.changes.map((change) => `change-${change.key}`)] }]),
  ];
}

/** FR-GUI-074: a frame is as wide as its columns; the page draws it and clamps drops to this same width. */
export function frameWidth(columnCount: number): number {
  const columns = Math.max(1, columnCount);
  return LAYOUT.framePadding + LAYOUT.framePadding + columns * LAYOUT.cardWidth + (columns - 1) * LAYOUT.columnGap;
}

/** Each frame's width, by frame key, so the page never works it out again. */
export function frameWidths(view: CanvasView): Record<string, number> {
  return Object.fromEntries(framePlans(view).map((plan) => [plan.key, frameWidth(plan.columns.length)]));
}

/**
 * FR-GUI-074: frames side by side, each milestone a column, each task after the ones it depends on. A saved
 * position wins; keys of frames and cards that no longer exist are dropped (FR-GUI-075).
 */
export function resolveLayout(view: CanvasView, saved: Layout | undefined): Layout {
  const frames: Record<string, Point> = {};
  const cards: Record<string, Point> = {};
  const plans = framePlans(view);
  const widthOf = (plan: FramePlan) => frameWidth(plan.columns.length);
  // A new frame goes to the right of every frame already placed, by hand or automatically, so none overlap.
  let nextX = 0;
  for (const plan of plans) {
    const point = saved?.frames[plan.key];
    if (point !== undefined) nextX = Math.max(nextX, point.x + widthOf(plan) + LAYOUT.frameGap);
  }
  for (const plan of plans) {
    const point = saved?.frames[plan.key];
    if (point === undefined) {
      frames[plan.key] = { x: nextX, y: 0 };
      nextX += widthOf(plan) + LAYOUT.frameGap;
    } else frames[plan.key] = point;
    plan.columns.forEach((column, columnIndex) => {
      column.forEach((key, row) => {
        cards[key] = saved?.cards[key] ?? {
          x: LAYOUT.framePadding + columnIndex * (LAYOUT.cardWidth + LAYOUT.columnGap),
          y: LAYOUT.frameHeader + row * (LAYOUT.cardHeight + LAYOUT.rowGap),
        };
      });
    });
  }
  return { version: LAYOUT_VERSION, frames, cards };
}

/**
 * FR-GUI-075: only positions of frames and cards on the canvas now, so a removed task's position leaves
 * `layout.json` with the next save, whatever the page that saved it still had.
 */
export function pruneLayout(view: CanvasView, layout: Layout): Layout {
  const known = resolveLayout(view, undefined);
  const keep = (points: Layout["frames"], current: Layout["frames"]) =>
    Object.fromEntries(Object.entries(points).filter(([key]) => Object.hasOwn(current, key)));
  return { version: LAYOUT_VERSION, frames: keep(layout.frames, known.frames), cards: keep(layout.cards, known.cards) };
}

/** The frame Tidy up resets: a roadmap, Unassigned or Changes (FR-GUI-074). */
export const tidyRequestSchema = z.strictObject({
  frame: z.string().regex(/^(roadmap-[1-9]\d{0,9}|unassigned|changes)$/),
});

/** FR-GUI-074: Tidy up forgets a frame's saved positions, so it's placed automatically again. */
export function tidyFrame(view: CanvasView, saved: Layout, frameKey: string): Layout {
  const plan = framePlans(view).find((item) => item.key === frameKey);
  if (plan === undefined) return saved;
  const cardsOfFrame = new Set(plan.columns.flat());
  return {
    version: LAYOUT_VERSION,
    frames: Object.fromEntries(Object.entries(saved.frames).filter(([key]) => key !== frameKey)),
    cards: Object.fromEntries(Object.entries(saved.cards).filter(([key]) => !cardsOfFrame.has(key))),
  };
}
