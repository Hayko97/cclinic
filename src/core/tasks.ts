/** The roadmap and its tasks (spec: task-tracking). Storage is in the task-store adapter. */
import { z } from "zod";
import { UsageError } from "./errors.js";

export const TASK_STATUSES = ["open", "in-progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Milestone {
  readonly id: number;
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const TASK_LIMITS = { title: 200, text: 4000 } as const;
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const title = z
  .string()
  .trim()
  .min(1, "A title is required.")
  .max(TASK_LIMITS.title, `A title can have at most ${TASK_LIMITS.title} characters.`);
const text = z.string().max(TASK_LIMITS.text, `It can have at most ${TASK_LIMITS.text} characters.`);

export const taskInputSchema = z.object({
  title,
  description: text.optional(),
  milestoneId: z.number().int().positive().optional(),
  spec: z
    .string()
    .regex(SPEC_NAME, "A spec name uses lowercase letters, digits and single hyphens, such as user-login.")
    .optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const milestoneInputSchema = z.object({ title, goal: text.optional() });
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

/** Validates input at the command boundary, so a mistake saves nothing (FR-TASK-006). */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") ?? "input";
  throw new UsageError(`Invalid ${field}: ${issue?.message ?? "not accepted"}`);
}

export function parseId(value: string, kind: "task" | "milestone"): number {
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new UsageError(`"${value}" isn't a valid ${kind} ID.`);
  return id;
}

function taskLine(task: Task): string {
  return `  #${task.id} [${task.status}] ${task.title}${task.spec === null ? "" : ` (spec: ${task.spec})`}`;
}

/** Tasks arrive in roadmap order from the store (FR-TASK-007). */
export function renderTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks.map(taskLine).join("\n");
}

export function renderTask(task: Task, milestone: Milestone | undefined): string {
  return [
    `#${task.id} ${task.title}`,
    `  Status: ${task.status}`,
    `  Milestone: ${milestone === undefined ? "none" : `#${milestone.id} ${milestone.title}`}`,
    `  Spec: ${task.spec ?? "none"}`,
    `  Created: ${task.createdAt}`,
    `  Updated: ${task.updatedAt}`,
    ...(task.description === null ? [] : ["", task.description]),
  ].join("\n");
}

export interface Roadmap {
  readonly milestones: readonly (Milestone & { readonly tasks: readonly Task[] })[];
  readonly unassigned: readonly Task[];
}

export function buildRoadmap(milestones: readonly Milestone[], tasks: readonly Task[]): Roadmap {
  return {
    milestones: [...milestones]
      .sort((left, right) => left.position - right.position)
      .map((milestone) => ({ ...milestone, tasks: tasks.filter((task) => task.milestoneId === milestone.id) })),
    unassigned: tasks.filter((task) => task.milestoneId === null),
  };
}

/** Milestones in order with their goals and tasks, then tasks with no milestone (FR-TASK-012). */
export function renderRoadmap(roadmap: Roadmap): string {
  if (roadmap.milestones.length === 0 && roadmap.unassigned.length === 0) return "The roadmap is empty.";
  const sections = roadmap.milestones.map((milestone) =>
    [
      `Milestone #${milestone.id}: ${milestone.title}`,
      ...(milestone.goal === null ? [] : [`  Goal: ${milestone.goal}`]),
      ...(milestone.tasks.length === 0 ? ["  No tasks."] : milestone.tasks.map(taskLine)),
    ].join("\n"),
  );
  if (roadmap.unassigned.length > 0) sections.push(["No milestone", ...roadmap.unassigned.map(taskLine)].join("\n"));
  return sections.join("\n\n");
}
