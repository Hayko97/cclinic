/** Roadmaps, milestones and tasks (spec: task-tracking). Storage is in the task-store adapter. */
import { z } from "zod";
import { UsageError } from "./errors.js";

export const TASK_STATUSES = ["open", "in-progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ROADMAP_STATUSES = ["planned", "in-progress", "done"] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export interface RoadmapRecord {
  readonly id: number;
  readonly title: string;
  readonly goal: string | null;
  readonly createdAt: string;
}

export interface Milestone {
  readonly id: number;
  readonly roadmapId: number;
  readonly title: string;
  readonly goal: string | null;
  readonly position: number;
  readonly createdAt: string;
}

export interface Task {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly milestoneId: number | null;
  readonly spec: string | null;
  readonly dependsOn: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const TASK_LIMITS = { title: 200, text: 4000 } as const;
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const titleSchema = z
  .string()
  .trim()
  .min(1, "A title is required.")
  .max(TASK_LIMITS.title, `A title can have at most ${TASK_LIMITS.title} characters.`);
export const textSchema = z.string().max(TASK_LIMITS.text, `It can have at most ${TASK_LIMITS.text} characters.`);
export const specNameSchema = z
  .string()
  .regex(SPEC_NAME, "A spec name uses lowercase letters, digits and single hyphens, such as user-login.");
const idSchema = z.number().int().positive();

export const taskInputSchema = z.object({
  title: titleSchema,
  description: textSchema.optional(),
  spec: specNameSchema.optional(),
  dependsOn: z.array(idSchema).default([]),
});
export type TaskInput = z.input<typeof taskInputSchema> & { readonly milestoneId?: number };

/** A whole approved plan, saved by `cclinic plan` in one transaction (FR-TASK-027). */
export interface PlannedTask {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly spec: string | null;
  /** Keys of tasks in the same plan, or IDs of existing tasks. */
  readonly dependsOn: readonly (string | number)[];
}

export interface RoadmapPlan {
  readonly roadmap: { readonly title: string; readonly goal: string } | { readonly id: number };
  readonly milestones: readonly {
    readonly title: string;
    readonly goal: string;
    readonly tasks: readonly PlannedTask[];
  }[];
}

/** Validates input at the command boundary, so a mistake saves nothing (FR-TASK-006). */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") ?? "input";
  throw new UsageError(`Invalid ${field}: ${issue?.message ?? "not accepted"}`);
}

export function parseId(value: string, kind: "task" | "milestone" | "roadmap"): number {
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new UsageError(`"${value}" isn't a valid ${kind} ID.`);
  return id;
}

/**
 * Returns the tasks that form a cycle, in order, or undefined when there's none.
 * `edges` maps each task to the tasks it depends on.
 */
export function findCycle<T>(edges: ReadonlyMap<T, readonly T[]>): readonly T[] | undefined {
  const state = new Map<T, "visiting" | "done">();
  const path: T[] = [];
  const visit = (node: T): readonly T[] | undefined => {
    if (state.get(node) === "done") return undefined;
    if (state.get(node) === "visiting") return path.slice(path.indexOf(node));
    state.set(node, "visiting");
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    state.set(node, "done");
    return undefined;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

export function dependencyEdges(tasks: readonly Task[]): Map<number, readonly number[]> {
  return new Map(tasks.map((task) => [task.id, task.dependsOn]));
}

/** FR-TASK-026 */
export function roadmapStatus(tasks: readonly Task[]): RoadmapStatus {
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) return "done";
  return tasks.some((task) => task.status !== "open") ? "in-progress" : "planned";
}

function dependencyText(task: Task): string {
  return task.dependsOn.length === 0 ? "" : ` (needs ${task.dependsOn.map((id) => `#${id}`).join(", ")})`;
}

function taskLine(task: Task): string {
  const spec = task.spec === null ? "" : ` (spec: ${task.spec})`;
  return `  #${task.id} [${task.status}] ${task.title}${spec}${dependencyText(task)}`;
}

/** Tasks arrive in roadmap order from the store (FR-TASK-007). */
export function renderTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks.map(taskLine).join("\n");
}

export function renderTask(task: Task, milestone: Milestone | undefined): string {
  const dependsOn = task.dependsOn.length === 0 ? "none" : task.dependsOn.map((id) => `#${id}`).join(", ");
  return [
    `#${task.id} ${task.title}`,
    `  Status: ${task.status}`,
    `  Milestone: ${milestone === undefined ? "none" : `#${milestone.id} ${milestone.title}`}`,
    `  Spec: ${task.spec ?? "none"}`,
    `  Depends on: ${dependsOn}`,
    `  Created: ${task.createdAt}`,
    `  Updated: ${task.updatedAt}`,
    ...(task.description === null ? [] : ["", task.description]),
  ].join("\n");
}

export type MilestoneWithTasks = Milestone & { readonly tasks: readonly Task[] };

export interface Roadmap extends RoadmapRecord {
  readonly status: RoadmapStatus;
  readonly milestones: readonly MilestoneWithTasks[];
}

export interface RoadmapOverview {
  readonly roadmaps: readonly Roadmap[];
  readonly unassigned: readonly Task[];
}

export function buildRoadmap(record: RoadmapRecord, milestones: readonly Milestone[], tasks: readonly Task[]): Roadmap {
  const own = [...milestones]
    .filter((milestone) => milestone.roadmapId === record.id)
    .sort((left, right) => left.position - right.position)
    .map((milestone) => ({ ...milestone, tasks: tasks.filter((task) => task.milestoneId === milestone.id) }));
  return { ...record, status: roadmapStatus(own.flatMap((milestone) => milestone.tasks)), milestones: own };
}

export function buildOverview(
  records: readonly RoadmapRecord[],
  milestones: readonly Milestone[],
  tasks: readonly Task[],
): RoadmapOverview {
  return {
    roadmaps: [...records]
      .sort((left, right) => left.id - right.id)
      .map((record) => buildRoadmap(record, milestones, tasks)),
    unassigned: tasks.filter((task) => task.milestoneId === null),
  };
}

function renderMilestone(milestone: MilestoneWithTasks): string {
  return [
    `  Milestone #${milestone.id}: ${milestone.title}`,
    ...(milestone.goal === null ? [] : [`    Goal: ${milestone.goal}`]),
    ...(milestone.tasks.length === 0 ? ["    No tasks."] : milestone.tasks.map((task) => `  ${taskLine(task)}`)),
  ].join("\n");
}

/** FR-TASK-025 */
export function renderRoadmap(roadmap: Roadmap): string {
  return [
    `Roadmap #${roadmap.id}: ${roadmap.title} [${roadmap.status}]`,
    ...(roadmap.goal === null ? [] : [`  Goal: ${roadmap.goal}`]),
    ...(roadmap.milestones.length === 0 ? ["  No milestones."] : roadmap.milestones.map(renderMilestone)),
  ].join("\n");
}

/** Every roadmap in order, then tasks with no milestone (FR-TASK-012). */
export function renderOverview(overview: RoadmapOverview): string {
  if (overview.roadmaps.length === 0 && overview.unassigned.length === 0) return "No roadmaps or tasks.";
  const sections = overview.roadmaps.map(renderRoadmap);
  if (overview.unassigned.length > 0) sections.push(["No milestone", ...overview.unassigned.map(taskLine)].join("\n"));
  return sections.join("\n\n");
}

export interface RoadmapSummary extends RoadmapRecord {
  readonly status: RoadmapStatus;
  readonly milestoneCount: number;
  readonly taskCounts: Readonly<Record<TaskStatus, number>>;
}

export function summarizeRoadmap(roadmap: Roadmap): RoadmapSummary {
  const tasks = roadmap.milestones.flatMap((milestone) => milestone.tasks);
  const taskCounts = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length]),
  ) as Record<TaskStatus, number>;
  const { milestones, ...record } = roadmap;
  return { ...record, milestoneCount: milestones.length, taskCounts };
}

/** FR-TASK-024 */
export function renderRoadmapList(summaries: readonly RoadmapSummary[]): string {
  if (summaries.length === 0) return "No roadmaps. Create one with: cclinic plan";
  return summaries
    .map((summary) => {
      const counts = TASK_STATUSES.map((status) => `${summary.taskCounts[status]} ${status}`).join(", ");
      const milestones = `${summary.milestoneCount} milestone${summary.milestoneCount === 1 ? "" : "s"}`;
      return [
        `#${summary.id} ${summary.title} [${summary.status}]`,
        ...(summary.goal === null ? [] : [`  Goal: ${summary.goal}`]),
        `  ${milestones}; tasks: ${counts}`,
      ].join("\n");
    })
    .join("\n");
}

export const PLAN_HINT =
  "Roadmaps and milestones are created by the PM agent: run cclinic plan (or cclinic plan --task for one task).";
