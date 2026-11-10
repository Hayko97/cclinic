/** Planning a roadmap or a single task with the PM agent (spec: roadmap-planning). */
import { z } from "zod";
import { PLAN_LIMITS } from "./constants/agents.js";
import {
  dependencyEdges,
  findCycle,
  specNameSchema,
  textSchema,
  titleSchema,
  type RoadmapOverview,
  type RoadmapPlan,
  type Task,
} from "./tasks.js";

/** What the session plans (FR-PLAN-004, FR-PLAN-017). */
export type PlanTarget =
  | { readonly kind: "new-roadmap" }
  | { readonly kind: "extend-roadmap"; readonly roadmapId: number }
  | { readonly kind: "task"; readonly roadmapId: number | null };

const keySchema = z.string().min(1);

const plannedTaskSchema = z.object({
  key: keySchema,
  title: z.string(),
  description: z.string(),
  spec: z.string().nullable(),
  dependsOn: z.array(z.union([keySchema, z.number().int()])),
});

const roadmapProposalSchema = z.object({
  roadmap: z.object({ title: z.string(), goal: z.string() }).nullable(),
  milestones: z.array(z.object({ title: z.string(), goal: z.string(), tasks: z.array(plannedTaskSchema) })),
  openQuestions: z.array(z.string()),
});
export type RoadmapProposal = z.infer<typeof roadmapProposalSchema>;

const taskProposalSchema = z.object({
  task: z.object({
    title: z.string(),
    description: z.string(),
    spec: z.string().nullable(),
    dependsOn: z.array(z.number().int()),
  }),
  milestoneId: z.number().int().nullable(),
  openQuestions: z.array(z.string()),
});
export type TaskProposal = z.infer<typeof taskProposalSchema>;

/** One JSON shape per reply, so the CLI can ask Claude for it. Exactly one of the two is filled (FR-PLAN-007). */
export const roadmapReplySchema = z.object({
  questions: z.array(z.string()),
  proposal: roadmapProposalSchema.nullable(),
});
export const taskReplySchema = z.object({
  questions: z.array(z.string()),
  proposal: taskProposalSchema.nullable(),
});

export function replySchemaFor(target: PlanTarget): typeof roadmapReplySchema | typeof taskReplySchema {
  return target.kind === "task" ? taskReplySchema : roadmapReplySchema;
}

export type PmReply<P> =
  | { readonly kind: "questions"; readonly questions: readonly string[] }
  | { readonly kind: "proposal"; readonly proposal: P };

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "reply"}: ${issue?.message ?? "not accepted"}`;
}

function parseReply<P>(
  schema: z.ZodType<{ questions: string[]; proposal: P | null }>,
  value: unknown,
): PmReply<P> | string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return `The reply doesn't match the required JSON shape (${describeIssue(parsed.error)}).`;
  const { questions, proposal } = parsed.data;
  if (proposal !== null) {
    return questions.length === 0 ? { kind: "proposal", proposal } : "Send either questions or a proposal, not both.";
  }
  if (questions.length === 0) return "Send 1 or more questions, or a proposal.";
  if (questions.length > PLAN_LIMITS.maxQuestions) {
    return `Ask at most ${PLAN_LIMITS.maxQuestions} questions at a time.`;
  }
  return { kind: "questions", questions };
}

/** Returns the reply, or why it isn't valid (FR-PLAN-010). */
export function parseRoadmapReply(value: unknown, target: PlanTarget): PmReply<RoadmapProposal> | string {
  const reply = parseReply(roadmapReplySchema, value);
  if (typeof reply === "string" || reply.kind === "questions") return reply;
  if (target.kind === "new-roadmap" && reply.proposal.roadmap === null) {
    return "A new roadmap needs a roadmap title and goal.";
  }
  return reply;
}

export function parseTaskReply(value: unknown): PmReply<TaskProposal> | string {
  return parseReply(taskReplySchema, value);
}

function fieldProblems(label: string, fields: { title: string; text: string; spec: string | null }): string[] {
  const problems: string[] = [];
  const title = titleSchema.safeParse(fields.title);
  if (!title.success) problems.push(`${label} title: ${title.error.issues[0]?.message ?? "invalid"}`);
  const text = textSchema.safeParse(fields.text);
  if (!text.success) problems.push(`${label} text: ${text.error.issues[0]?.message ?? "invalid"}`);
  if (fields.spec !== null) {
    const spec = specNameSchema.safeParse(fields.spec);
    if (!spec.success) problems.push(`${label} spec "${fields.spec}": ${spec.error.issues[0]?.message ?? "invalid"}`);
  }
  return problems;
}

function cycleProblem(existing: readonly Task[], added: ReadonlyMap<string, readonly string[]>): string | undefined {
  const edges = new Map<string, readonly string[]>(
    [...dependencyEdges(existing)].map(([id, dependsOn]) => [`#${id}`, dependsOn.map((item) => `#${item}`)]),
  );
  for (const [key, dependsOn] of added) edges.set(key, dependsOn);
  const cycle = findCycle(edges);
  return cycle === undefined ? undefined : `The dependencies make a cycle: ${[...cycle, cycle[0]].join(" -> ")}.`;
}

/** Problems that send the proposal back to the PM before the user sees it (FR-PLAN-009). */
export function checkRoadmapProposal(proposal: RoadmapProposal, existing: readonly Task[]): string[] {
  const problems: string[] = [];
  if (proposal.roadmap !== null) {
    problems.push(
      ...fieldProblems("Roadmap", { title: proposal.roadmap.title, text: proposal.roadmap.goal, spec: null }),
    );
  }
  if (proposal.milestones.length === 0) problems.push("The proposal needs at least one milestone.");
  const tasks = proposal.milestones.flatMap((milestone) => milestone.tasks);
  const keys = new Set(tasks.map((task) => task.key));
  if (keys.size !== tasks.length) problems.push("Every task needs its own key.");
  const existingIds = new Set(existing.map((task) => task.id));
  for (const milestone of proposal.milestones) {
    problems.push(
      ...fieldProblems(`Milestone "${milestone.title}"`, { ...milestone, text: milestone.goal, spec: null }),
    );
    if (milestone.tasks.length === 0) problems.push(`Milestone "${milestone.title}" has no tasks.`);
  }
  for (const task of tasks) {
    problems.push(...fieldProblems(`Task "${task.key}"`, { ...task, text: task.description }));
    for (const dependency of task.dependsOn) {
      const isKnown = typeof dependency === "number" ? existingIds.has(dependency) : keys.has(dependency);
      if (!isKnown) {
        const name = typeof dependency === "number" ? `task ${dependency}` : `"${dependency}"`;
        problems.push(`Task "${task.key}" depends on ${name}, which doesn't exist.`);
      }
    }
  }
  const added = new Map(
    tasks.map((task) => [task.key, task.dependsOn.map((item) => (typeof item === "number" ? `#${item}` : item))]),
  );
  const cycle = cycleProblem(existing, added);
  if (cycle !== undefined) problems.push(cycle);
  return problems;
}

export interface TaskCheckContext {
  readonly existing: readonly Task[];
  /** Milestones of the chosen roadmap, or undefined for a standalone task. */
  readonly roadmapMilestoneIds: readonly number[] | undefined;
}

/** FR-PLAN-019 */
export function checkTaskProposal(proposal: TaskProposal, context: TaskCheckContext): string[] {
  const problems = fieldProblems("Task", { ...proposal.task, text: proposal.task.description });
  const existingIds = new Set(context.existing.map((task) => task.id));
  for (const id of proposal.task.dependsOn) {
    if (!existingIds.has(id)) problems.push(`The task depends on task ${id}, which doesn't exist.`);
  }
  if (context.roadmapMilestoneIds === undefined) {
    if (proposal.milestoneId !== null)
      problems.push("A standalone task has no milestone, so milestoneId must be null.");
  } else if (proposal.milestoneId === null || !context.roadmapMilestoneIds.includes(proposal.milestoneId)) {
    problems.push(
      `milestoneId must be one of the chosen roadmap's milestones: ${context.roadmapMilestoneIds.join(", ") || "none"}.`,
    );
  }
  const cycle = cycleProblem(context.existing, new Map([["new task", proposal.task.dependsOn.map((id) => `#${id}`)]]));
  if (cycle !== undefined) problems.push(cycle);
  return problems;
}

export function toRoadmapPlan(proposal: RoadmapProposal, target: PlanTarget): RoadmapPlan {
  const roadmap =
    target.kind === "extend-roadmap"
      ? { id: target.roadmapId }
      : { title: proposal.roadmap?.title.trim() ?? "", goal: proposal.roadmap?.goal ?? "" };
  return {
    roadmap,
    milestones: proposal.milestones.map((milestone) => ({
      title: milestone.title.trim(),
      goal: milestone.goal,
      tasks: milestone.tasks.map((task) => ({ ...task, title: task.title.trim() })),
    })),
  };
}

export interface ConversationTurn {
  readonly from: "pm" | "user" | "cclinic";
  readonly text: string;
}

export interface PmPromptInput {
  readonly skill: string;
  readonly target: PlanTarget;
  readonly overview: RoadmapOverview;
  readonly conversation: readonly ConversationTurn[];
}

function targetInstruction(target: PlanTarget): string {
  switch (target.kind) {
    case "new-roadmap":
      return "Plan a NEW roadmap. The proposal must have `roadmap` with a title and goal.";
    case "extend-roadmap":
      return `EXTEND roadmap ${target.roadmapId}. Set \`roadmap\` to null, and propose only new milestones, which go after its existing ones.`;
    case "task":
      return target.roadmapId === null
        ? "Plan a SINGLE STANDALONE task, with no roadmap. Set `milestoneId` to null."
        : `Plan a SINGLE task for roadmap ${target.roadmapId}. Set \`milestoneId\` to the existing milestone of roadmap ${target.roadmapId} it fits best.`;
  }
}

function replyFormat(target: PlanTarget): string {
  const proposal =
    target.kind === "task"
      ? '{ "task": { "title", "description", "spec": name or null, "dependsOn": [existing task IDs] }, "milestoneId": number or null, "openQuestions": [] }'
      : '{ "roadmap": { "title", "goal" } or null, "milestones": [{ "title", "goal", "tasks": [{ "key", "title", "description", "spec": name or null, "dependsOn": [keys of new tasks, or existing task IDs] }] }], "openQuestions": [] }';
  return [
    `Reply with JSON only: either { "questions": [1 to ${PLAN_LIMITS.maxQuestions} questions], "proposal": null }`,
    `or { "questions": [], "proposal": ${proposal} }.`,
    'An answer of "unknown" means the user doesn\'t know: list it in openQuestions rather than guessing.',
  ].join("\n");
}

/** FR-PLAN-006 */
export function buildPmPrompt(input: PmPromptInput): string {
  const conversation =
    input.conversation.length === 0
      ? "(none yet)"
      : input.conversation.map((turn) => `[${turn.from}]\n${turn.text}`).join("\n\n");
  return [
    "You are the PM agent run by `cclinic plan`. Follow these instructions:",
    "<instructions>",
    input.skill.trim(),
    "</instructions>",
    "",
    `## Task\n\n${targetInstruction(input.target)}`,
    "",
    "## Existing roadmaps and tasks (JSON)\n",
    JSON.stringify(input.overview),
    "",
    `## Conversation so far\n\n${conversation}`,
    "",
    `## Reply format\n\n${replyFormat(input.target)}`,
  ].join("\n");
}

function dependencyLabel(dependency: string | number): string {
  return typeof dependency === "number" ? `#${dependency}` : dependency;
}

function openQuestionLines(questions: readonly string[]): string[] {
  return questions.length === 0 ? [] : ["", "Open questions:", ...questions.map((question) => `  - ${question}`)];
}

/** FR-PLAN-011 */
export function renderRoadmapProposal(proposal: RoadmapProposal, target: PlanTarget): string {
  const heading =
    target.kind === "extend-roadmap"
      ? [`Extending roadmap #${target.roadmapId}`]
      : [`Roadmap: ${proposal.roadmap?.title ?? ""}`, `Goal: ${proposal.roadmap?.goal ?? ""}`];
  const milestones = proposal.milestones.flatMap((milestone, index) => [
    "",
    `Milestone ${index + 1}: ${milestone.title}`,
    `  Goal: ${milestone.goal}`,
    ...milestone.tasks.map((task) => {
      const needs = task.dependsOn.length === 0 ? "" : ` (needs ${task.dependsOn.map(dependencyLabel).join(", ")})`;
      return `  [${task.key}] ${task.title} - spec: ${task.spec ?? "new spec"}${needs}`;
    }),
  ]);
  return [...heading, ...milestones, ...openQuestionLines(proposal.openQuestions)].join("\n");
}

/** FR-PLAN-020 */
export function renderTaskProposal(proposal: TaskProposal, target: PlanTarget): string {
  const where =
    target.kind === "task" && target.roadmapId !== null
      ? `milestone #${proposal.milestoneId ?? "?"} of roadmap #${target.roadmapId}`
      : "standalone";
  const dependsOn =
    proposal.task.dependsOn.length === 0 ? "none" : proposal.task.dependsOn.map((id) => `#${id}`).join(", ");
  return [
    `Task: ${proposal.task.title}`,
    `  Spec: ${proposal.task.spec ?? "new spec"}`,
    `  Where: ${where}`,
    `  Depends on: ${dependsOn}`,
    "",
    proposal.task.description,
    ...openQuestionLines(proposal.openQuestions),
  ].join("\n");
}
