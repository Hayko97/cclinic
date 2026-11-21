/** Planning a roadmap or a single task with the PM agent (spec: roadmap-planning). */
import { z } from "zod";
import { TOOL_INPUT_SHORT_CHARS } from "./constants/gui.js";
import {
  ATTACHMENT_LIMITS,
  BRIEF_FILE,
  BRIEF_LIMITS,
  BRIEF_SECTIONS,
  BYTES_PER_MEGABYTE,
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  PLAN_ID_PATTERN,
  PLAN_ID_PREFIX,
  PLAN_ID_SOURCE,
  PLAN_LIMITS,
} from "./constants/agents.js";
import { MCP_SERVER_NAME } from "./constants/workflow.js";
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

/** What the session plans (FR-PLAN-004, FR-PLAN-017), or a new project from an empty folder (FR-PLAN-047). */
export type PlanTarget =
  | { readonly kind: "new-roadmap" }
  | { readonly kind: "new-project" }
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

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "proposal"}: ${issue?.message ?? "not accepted"}`;
}

export type PlannedProposal =
  | { readonly kind: "roadmap"; readonly proposal: RoadmapProposal }
  | { readonly kind: "task"; readonly proposal: TaskProposal };

/** FR-PLAN-007, FR-PLAN-018: the proposal in the target's shape, or which field is wrong. */
export function parseProposal(value: unknown, target: PlanTarget): PlannedProposal | string {
  if (target.kind === "task") {
    const parsed = taskProposalSchema.safeParse(value);
    return parsed.success ? { kind: "task", proposal: parsed.data } : describeIssue(parsed.error);
  }
  const parsed = roadmapProposalSchema.safeParse(value);
  if (!parsed.success) return describeIssue(parsed.error);
  if ((target.kind === "new-roadmap" || target.kind === "new-project") && parsed.data.roadmap === null)
    return "roadmap: a new roadmap needs a title and goal";
  return { kind: "roadmap", proposal: parsed.data };
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

function targetInstruction(target: PlanTarget): string {
  switch (target.kind) {
    case "new-roadmap":
      return "Plan a NEW roadmap. Your proposal must have `roadmap` with a title and goal.";
    case "new-project":
      return [
        "This is a NEW PROJECT in an empty folder: there's no code, no documents and no specs yet, so don't look for them.",
        "Interview the user first, a few questions at a time, until you know: what the project is; who uses it and what each user does; the main features with their concrete rules (with numbers where they apply); the stack, or the one you recommend; how the code is written and tested; what's out of scope for now; and whether it has screens.",
        "Read every file the user attaches. Play back what you understood, then call `brief_propose` with the brief.",
        "Don't call `plan_propose` until luseen tells you the specs are written. Once the user approves the brief, luseen sets up the rest by itself: it writes the specs and the agent setup, saves the roadmap you then propose without asking the user again, and makes the design system.",
      ].join("\n");
    case "extend-roadmap":
      return `EXTEND roadmap ${target.roadmapId}. Set \`roadmap\` to null, and propose only new milestones, which go after its existing ones.`;
    case "task":
      return target.roadmapId === null
        ? "Plan a SINGLE STANDALONE task, with no roadmap. Set `milestoneId` to null."
        : `Plan a SINGLE task for roadmap ${target.roadmapId}. Set \`milestoneId\` to the existing milestone of roadmap ${target.roadmapId} it fits best.`;
  }
}

function proposalShape(target: PlanTarget): string {
  return target.kind === "task"
    ? '{ "task": { "title", "description", "spec": name or null, "dependsOn": [existing task IDs] }, "milestoneId": number or null, "openQuestions": [] }'
    : '{ "roadmap": { "title", "goal" } or null, "milestones": [{ "title", "goal", "tasks": [{ "key", "title", "description", "spec": name or null, "dependsOn": [keys of new tasks, or existing task IDs] }] }], "openQuestions": [] }';
}

export interface PlanContextInput {
  readonly planId: string;
  readonly target: PlanTarget;
  readonly overview: RoadmapOverview;
  /** The project overview and the specs list, relative to the project folder. */
  readonly overviewPath: string;
  readonly specsListPath: string;
}

/** FR-PLAN-049: a new project's context: nothing exists yet, so the PM interviews and proposes a brief. */
function renderProjectContext(input: PlanContextInput): string {
  return [
    `Planning session: ${input.planId}. Pass it as \`planId\` to every plan_* and brief_* tool.`,
    "",
    `## Task\n\n${targetInstruction(input.target)}`,
    "",
    "## Tools",
    "",
    "- `plan_suggest`: up to 4 short answers the user can pick, and the web pages you used as sources. Call it in any turn where an answer is a choice, and write the choices in your text too.",
    `- \`brief_propose\`: the brief, as { "markdown", "hasScreens": true or false }. The Markdown starts with \`# <project name>\` and has these \`##\` sections in this order: ${BRIEF_SECTIONS.join(", ")}. Main features has a \`###\` heading for each feature area, with its rules as a list. If it returns problems, fix them and call it again in the same turn.`,
    "",
    "Reply to the user in plain Markdown text. Never invent an answer: write what the user couldn't answer in the brief as open questions.",
    "",
    IN_CHAT_RULE,
  ].join("\n");
}

/** FR-PLAN-006, FR-PLAN-044: what the PM is planning and what exists, for its first turn or `plan_begin`. */
export function renderPlanContext(input: PlanContextInput): string {
  if (input.target.kind === "new-project") return renderProjectContext(input);
  return [
    `Planning session: ${input.planId}. Pass it as \`planId\` to every plan_* tool.`,
    "",
    `## Task\n\n${targetInstruction(input.target)}`,
    "",
    `Read the project overview at ${input.overviewPath} and the specs list at ${input.specsListPath}.`,
    "",
    "## Existing roadmaps and tasks (JSON)\n",
    JSON.stringify(input.overview),
    "",
    "## Tools",
    "",
    "- `plan_suggest`: up to 4 short answers the user can pick, and the web pages you used as sources. Call it in any turn where an answer is a choice, and write the choices in your text too.",
    `- \`plan_propose\`: your proposal, as ${proposalShape(input.target)}. If it returns problems, fix them and call it again in the same turn.`,
    "",
    "Reply to the user in plain Markdown text. Never invent an answer: list what the user couldn't answer in openQuestions.",
    "",
    IN_CHAT_RULE,
  ].join("\n");
}

/**
 * Marks the user's own first message, which comes first in the first turn's prompt, so it can be shown alone later,
 * even from a transcript that keeps only the start of a long entry.
 */
export const FIRST_MESSAGE_MARKER = "## The user's first message";
const INSTRUCTIONS_MARKER = "## Your instructions as the PM";

/** FR-PLAN-006: the first turn carries the skill and the context; later turns carry only the user's message. */
export function buildFirstTurnPrompt(
  input: PlanContextInput & { readonly skill: string; readonly message: string },
): string {
  return [
    FIRST_MESSAGE_MARKER,
    "",
    input.message,
    "",
    INSTRUCTIONS_MARKER,
    "",
    "You are the PM agent in a luseen planning session. Follow these instructions:",
    "<instructions>",
    input.skill.trim(),
    "</instructions>",
    "",
    renderPlanContext(input),
  ].join("\n");
}

/** How the PM reads each stored attachment: the copy, or a DOCX's extracted text (FR-PLAN-006). */
export function notesOf(stored: readonly StoredAttachment[]): AttachmentNote[] {
  return stored.map((item) => ({ name: item.name, kind: item.kind, readPath: item.textPath ?? item.path }));
}

/** What a user message shows of an attachment (FR-PLAN-006). */
export interface AttachmentNote {
  readonly name: string;
  readonly kind: AttachmentKind;
  /** Where the PM reads it, relative to the project folder: the copy, or a DOCX's extracted text. */
  readonly readPath: string;
}

/** FR-PLAN-006: a user message with its attachments listed for the PM to read. */
export function buildUserMessage(text: string, attachments: readonly AttachmentNote[]): string {
  if (attachments.length === 0) return text;
  const listed = attachments.map((item) => `- ${item.name} (${item.kind}): ${item.readPath}`);
  return [text, "", "Attached (new in this message):", ...listed].join("\n").trim();
}

/** FR-PLAN-010 */
export const NUDGE_MESSAGE = "Your last turn ended without a reply to the user. Reply to the user now, in plain text.";
/** FR-PLAN-031: what a resumed session tells the PM about a waiting proposal that no longer fits. */
export const PROPOSAL_NO_LONGER_FITS =
  "Your waiting proposal no longer fits what exists now. Fix these problems and propose again:";
/** FR-PLAN-024 */
export const PROPOSE_NOW_MESSAGE =
  "Propose now from what you know: call plan_propose, and list everything still unclear as open questions.";
/**
 * FR-PLAN-059: in a session luseen drives, everything happens in its conversation, and a tool that fails is said
 * plainly, so luseen can offer Retry.
 */
export const IN_CHAT_RULE =
  "This whole session happens in this conversation: luseen saves what your tools propose, and shows the user each step. Never tell the user to run a command, use another tool or a terminal, or copy or paste your answer to save it. If a tool returns an error or isn't available, say so in one sentence and end your turn; luseen offers the user Retry.";
/** FR-PLAN-014: a turn that was stopped is asked for again. */
export const ANSWER_LAST_MESSAGE = "Your last turn was stopped. Answer my last message.";

/**
 * FR-PLAN-014: asks for the stopped turn's answer, repeating its message only when Claude Code hadn't written it, so
 * a repeated message is always one the conversation doesn't show yet.
 */
export function answerLastMessage(unanswered: string | null): string {
  return unanswered === null
    ? `${ANSWER_LAST_MESSAGE} ${IN_CHAT_RULE}`
    : `${ANSWER_LAST_MESSAGE} ${IN_CHAT_RULE} In case you didn't get it, it was:\n\n${unanswered}`;
}

/** FR-PLAN-014: the user's message a Retry request repeats, or null when it repeats none. */
export function repeatedMessageOf(text: string): string | null {
  if (!text.startsWith(ANSWER_LAST_MESSAGE)) return null;
  const repeated = text.split("\n\n").slice(1).join("\n\n");
  return repeated === "" ? null : repeated;
}

/** FR-PLAN-050: a waiting brief as the terminal shows it. */
export function renderWaitingBrief(markdown: string): string {
  return `Brief (saved as ${BRIEF_FILE}):\n\n${markdown}`;
}

/** FR-PLAN-053: how luseen's request for a new project's first roadmap starts. */
export const ROADMAP_REQUEST_START = "The specs are written in";

/** FR-PLAN-053: asks the PM, in the same session, for the first roadmap once the specs exist. */
export function roadmapRequest(docsFolder: string, specNames: readonly string[]): string {
  return [
    `${ROADMAP_REQUEST_START} ${docsFolder}. The specs are: ${specNames.join(", ") || "none"}.`,
    "Don't ask again what the brief already answers, and don't ask the user anything now: luseen saves the roadmap you propose without asking. Call plan_propose now with a NEW roadmap for the first release:",
    "its first milestone is Foundation (scaffold, lint, tests and a runnable app shell), then one milestone per feature area, smallest first, with small tasks.",
    "Every task names its spec from the list above.",
    `The proposal's shape: ${proposalShape({ kind: "new-project" })}`,
    IN_CHAT_RULE,
  ].join("\n");
}

/** Whether a message is one luseen wrote to the PM, such as Retry's request or a nudge, not the user's own. */
export function isPlanningNote(text: string): boolean {
  return (
    text.startsWith(ROADMAP_REQUEST_START) ||
    text.startsWith(NUDGE_MESSAGE) ||
    text === PROPOSE_NOW_MESSAGE ||
    text.startsWith(ANSWER_LAST_MESSAGE) ||
    text.startsWith(PROPOSAL_NO_LONGER_FITS)
  );
}

/** The part of a first-turn prompt the user wrote, or the whole message for any other. */
export function userPartOf(message: string): string {
  if (!message.startsWith(FIRST_MESSAGE_MARKER)) return message;
  const end = message.indexOf(INSTRUCTIONS_MARKER);
  return message.slice(FIRST_MESSAGE_MARKER.length, end === -1 ? undefined : end).trim();
}

/**
 * FR-PLAN-031, FR-PLAN-038: what a message in the transcript shows as the user's: their own words, or the message a
 * Retry request repeated; null for luseen's other notes. The terminal, the GUI and the waiting-message rule all read
 * messages this way.
 */
export function shownUserMessage(text: string): string | null {
  const own = userPartOf(text);
  return isPlanningNote(own) ? repeatedMessageOf(own) : own;
}

/** FR-PLAN-007: suggested answers and sources, as `plan_suggest` takes them. */
export const sourceSchema = z.strictObject({
  title: z.string().trim().min(1),
  url: z.string().regex(/^https?:\/\/\S+$/, "must be an http or https URL"),
});
export type Source = z.infer<typeof sourceSchema>;

export const suggestionsSchema = z
  .array(z.string().trim().min(1).max(PLAN_LIMITS.maxSuggestionChars))
  .max(PLAN_LIMITS.maxSuggestions);
export const sourcesSchema = z.array(sourceSchema).max(PLAN_LIMITS.maxSources);

export const planIdSchema = z.string().regex(PLAN_ID_PATTERN, "must be a planning session ID, such as plan-1");

export const planTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new-roadmap") }),
  z.strictObject({ kind: z.literal("extend-roadmap"), roadmapId: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("task"), roadmapId: z.number().int().positive().nullable() }),
]);

/** A session's own target: a planning target, or a new project (FR-PLAN-047), which only luseen starts. */
export const sessionTargetSchema = z.discriminatedUnion("kind", [
  ...planTargetSchema.options,
  z.strictObject({ kind: z.literal("new-project") }),
]);

/** FR-PLAN-048: a new-project session's phases, in order. */
export const PROJECT_PHASES = ["brief", "specs", "roadmap", "design", "done"] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

/** FR-PLAN-050: a brief as `brief_propose` takes it. */
export const briefSchema = z.strictObject({
  markdown: z.string(),
  hasScreens: z.boolean(),
});
export type Brief = z.infer<typeof briefSchema>;

/** FR-PLAN-050: why a brief can't be shown to the user, or nothing when it can. */
export function checkBrief(brief: Brief): string[] {
  const problems: string[] = [];
  const text = brief.markdown.trim();
  if (text.length < BRIEF_LIMITS.minChars || text.length > BRIEF_LIMITS.maxChars) {
    problems.push(
      `The brief must be ${BRIEF_LIMITS.minChars} to ${BRIEF_LIMITS.maxChars} characters; it has ${text.length}.`,
    );
  }
  if (!/^# \S/.test(text)) problems.push("The brief must start with `# <project name>`.");
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => (match[1] ?? "").trim());
  let from = 0;
  for (const section of BRIEF_SECTIONS) {
    const at = headings.indexOf(section, from);
    if (at === -1) {
      problems.push(
        headings.includes(section)
          ? `The section "## ${section}" is out of order: the sections go ${BRIEF_SECTIONS.join(", ")}.`
          : `The section "## ${section}" is missing.`,
      );
      continue;
    }
    from = at + 1;
  }
  const features = /^## Main features$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  if (headings.includes("Main features") && !/^### \S/m.test(features)) {
    problems.push('The section "## Main features" needs a `###` heading for each feature area.');
  }
  return problems;
}

/** FR-PLAN-048, FR-PLAN-050: where a new-project session is, and its waiting brief. */
const projectStateSchema = z.strictObject({
  phase: z.enum(PROJECT_PHASES),
  brief: briefSchema.extend({ proposedAt: z.string() }).nullable(),
  /** From the approved brief; null until then. */
  hasScreens: z.boolean().nullable(),
  /** The first roadmap was asked for, so it isn't asked for again (FR-PLAN-053). */
  isRoadmapAsked: z.boolean(),
  /** The files the approved brief wrote, such as README.md and docs/spec-2.pdf (FR-PLAN-051, FR-PLAN-055). */
  files: z.array(z.string()).default([]),
});
export type ProjectState = z.infer<typeof projectStateSchema>;

export type AttachmentKind = "image" | "document";

const initEventSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  tools: z.array(z.string()).default([]),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
});

/**
 * FR-PLAN-058: why a PM turn can't go on, from its `init` stream event: luseen's server isn't connected, or a planning
 * tool the turn needs isn't offered. Undefined when it can, and for any other event.
 */
export function planningToolsProblem(event: unknown, needed: readonly string[]): string | undefined {
  const parsed = initEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const lead = "The PM can't reach luseen's planning tools:";
  const server = parsed.data.mcp_servers.find((item) => item.name === MCP_SERVER_NAME);
  if (server === undefined) return `${lead} the ${MCP_SERVER_NAME} server isn't running.`;
  if (server.status !== "connected") return `${lead} the ${MCP_SERVER_NAME} server is ${server.status}.`;
  const missing = needed.filter((tool) => !parsed.data.tools.includes(`mcp__${MCP_SERVER_NAME}__${tool}`));
  if (missing.length === 0) return undefined;
  return `${lead} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`;
}

/** FR-PLAN-022: an image or a document, by its extension. */
export function attachmentKind(name: string): AttachmentKind | undefined {
  if (!name.includes(".")) return undefined;
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (DOCUMENT_EXTENSIONS.includes(extension)) return "document";
  return undefined;
}

/** FR-PLAN-022: why a file can't be attached, or undefined when it can. */
export function attachmentProblem(file: { readonly name: string; readonly sizeBytes: number }): string | undefined {
  const kind = attachmentKind(file.name);
  if (kind === undefined) {
    return `${file.name} can't be attached: only images (${IMAGE_EXTENSIONS.join(", ")}) and documents (${DOCUMENT_EXTENSIONS.join(", ")}) can.`;
  }
  const maxBytes = kind === "image" ? ATTACHMENT_LIMITS.imageMaxBytes : ATTACHMENT_LIMITS.documentMaxBytes;
  if (file.sizeBytes > maxBytes) {
    return `${file.name} is too large: ${kind}s can be at most ${maxBytes / BYTES_PER_MEGABYTE} MB.`;
  }
  return undefined;
}

/** FR-PLAN-022: why this many files can't be sent, or undefined when they can. */
export function attachmentCountProblem(inMessage: number, alreadyInSession: number): string | undefined {
  if (inMessage > ATTACHMENT_LIMITS.perMessage) {
    return `A message can have at most ${ATTACHMENT_LIMITS.perMessage} files.`;
  }
  if (inMessage + alreadyInSession > ATTACHMENT_LIMITS.perSession) {
    return `A planning session can have at most ${ATTACHMENT_LIMITS.perSession} files; it has ${alreadyInSession}.`;
  }
  return undefined;
}

/** FR-PLAN-008 */
export function messageProblem(text: string, fileCount: number): string | undefined {
  if (text.trim() === "" && fileCount === 0) return "Write a message or attach a file.";
  if (text.length > PLAN_LIMITS.maxUserMessageChars) {
    return `A message can be at most ${PLAN_LIMITS.maxUserMessageChars} characters.`;
  }
  return undefined;
}

/** What the user typed in the terminal (FR-PLAN-024). */
export type ChatInput =
  | { readonly kind: "approve" }
  | { readonly kind: "cancel" }
  | { readonly kind: "propose" }
  | { readonly kind: "suggestion"; readonly index: number }
  | { readonly kind: "message"; readonly text: string; readonly files: readonly string[] };

const ATTACH_COMMAND = "/attach ";
/** `@"path with spaces"` or `@path`, at the start of a word, so an email address isn't one. */
const FILE_REFERENCE = /[ \t]*(?<!\S)@(?:"([^"]+)"|(\S+))/g;

/** FR-PLAN-024: a terminal message: a command, a suggestion's number, or text with `@file` references. */
export function parseChatInput(typed: string): ChatInput {
  const trimmed = typed.trim();
  if (trimmed === "/approve") return { kind: "approve" };
  if (trimmed === "/cancel") return { kind: "cancel" };
  if (trimmed === "/propose") return { kind: "propose" };
  if (/^[1-9]\d*$/.test(trimmed)) return { kind: "suggestion", index: Number(trimmed) };
  if (trimmed.startsWith(ATTACH_COMMAND)) {
    return {
      kind: "message",
      text: "",
      files: [
        trimmed
          .slice(ATTACH_COMMAND.length)
          .trim()
          .replace(/^"(.*)"$/, "$1"),
      ],
    };
  }
  const files: string[] = [];
  // The reference and the spaces before it are left out; the rest of the message is kept as typed.
  const text = typed.replace(FILE_REFERENCE, (_match, quoted: string | undefined, bare: string | undefined) => {
    files.push(quoted ?? bare ?? "");
    return "";
  });
  return { kind: "message", text: text.trim(), files };
}

/** FR-PLAN-030: who drives a session now. */
export const holderSchema = z.strictObject({
  place: z.enum(["terminal", "gui", "claude-code"]),
  pid: z.number().int().positive(),
});
export type Holder = z.infer<typeof holderSchema>;
export type HolderPlace = Holder["place"];

export const storedAttachmentSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(["image", "document"]),
  /** The copy, relative to the project folder. */
  path: z.string().min(1),
  /** A DOCX's extracted text, relative to the project folder. */
  textPath: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type StoredAttachment = z.infer<typeof storedAttachmentSchema>;

const waitingProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("roadmap"), proposal: roadmapProposalSchema, proposedAt: z.string() }),
  z.strictObject({ kind: z.literal("task"), proposal: taskProposalSchema, proposedAt: z.string() }),
]);
export type WaitingProposal = z.infer<typeof waitingProposalSchema>;

/** FR-PLAN-030: a planning session's record. The conversation itself is the Claude session's transcript. */
export const planSessionSchema = z.strictObject({
  version: z.literal(1),
  id: planIdSchema,
  target: sessionTargetSchema,
  status: z.enum(["open", "approved", "cancelled"]),
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  /** The start of the first message, for lists. */
  summary: z.string(),
  attachments: z.array(storedAttachmentSchema),
  suggestions: suggestionsSchema,
  sources: sourcesSchema,
  proposal: waitingProposalSchema.nullable(),
  /** The user's last message has no complete reply yet (FR-PLAN-014). */
  isAwaitingReply: z.boolean(),
  /**
   * The user's first message, kept only until the Claude session exists, so a session stopped before its first
   * turn reached Claude can still start (FR-PLAN-014).
   */
  pendingFirstMessage: z.string().nullable().default(null),
  /**
   * The newest message sent after the first, kept until it's answered, so a turn stopped before Claude Code wrote
   * it can send it again (FR-PLAN-014).
   */
  unansweredMessage: z.string().nullable().default(null),
  /** When the turn still waiting for a reply started, to find its reply in the transcript (FR-PLAN-014). */
  turnStartedAt: z.string().nullable().default(null),
  holder: holderSchema.nullable(),
  lastPlace: z.enum(["terminal", "gui", "claude-code"]).nullable(),
  /** What happened at the end: the saved IDs, or that it was cancelled. */
  outcome: z.string().nullable(),
  /** Only for a new-project session (FR-PLAN-048). */
  project: projectStateSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlanSession = z.infer<typeof planSessionSchema>;

export function summaryOf(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > PLAN_LIMITS.summaryChars ? `${flat.slice(0, PLAN_LIMITS.summaryChars - 1)}…` : flat;
}

export function newPlanSession(fields: {
  readonly id: string;
  readonly target: PlanTarget;
  readonly summary: string;
  readonly holder: Holder;
  readonly claudeSessionId: string | null;
  readonly transcriptPath: string | null;
  readonly now: string;
}): PlanSession {
  return {
    version: 1,
    id: fields.id,
    target: fields.target,
    status: "open",
    claudeSessionId: fields.claudeSessionId,
    transcriptPath: fields.transcriptPath,
    summary: summaryOf(fields.summary),
    attachments: [],
    suggestions: [],
    sources: [],
    proposal: null,
    isAwaitingReply: false,
    pendingFirstMessage: null,
    unansweredMessage: null,
    turnStartedAt: null,
    holder: fields.holder,
    lastPlace: fields.holder.place,
    outcome: null,
    project:
      fields.target.kind === "new-project"
        ? { phase: "brief", brief: null, hasScreens: null, isRoadmapAsked: false, files: [] }
        : null,
    createdAt: fields.now,
    updatedAt: fields.now,
  };
}

/** The next free ID, after the highest one used in the project (FR-PLAN-030). */
export function nextPlanId(existing: readonly string[]): string {
  const numbers = existing
    .filter((id) => PLAN_ID_PATTERN.test(id))
    .map((id) => Number(id.slice(PLAN_ID_PREFIX.length)));
  return `${PLAN_ID_PREFIX}${Math.max(0, ...numbers) + 1}`;
}

const PLACE_NAMES: Readonly<Record<HolderPlace, string>> = {
  terminal: "a terminal (luseen plan)",
  gui: "the GUI",
  "claude-code": "Claude Code",
};

export function placeName(place: HolderPlace): string {
  return PLACE_NAMES[place];
}

/** FR-PLAN-043: both ways to continue a session. */
export function resumeCommands(session: Pick<PlanSession, "id" | "claudeSessionId">): string[] {
  return [
    `luseen plan --resume ${session.id}`,
    ...(session.claudeSessionId === null ? [] : [`claude --resume ${session.claudeSessionId}`]),
  ];
}

/** A dependency as shown: an existing task's ID as `#3`, a new task's key as it is. */
export function dependencyLabel(dependency: string | number): string {
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

/**
 * FR-PLAN-032: takes the session for `holder`, or says where it's held. A hold whose process no longer runs is
 * taken over. A closed session can't be driven.
 */
export function takeHold(
  session: PlanSession,
  holder: Holder,
  isRunning: (pid: number) => boolean,
  now: string,
): PlanSession | string {
  if (session.status !== "open") return `Planning session ${session.id} is ${session.status}, so it can't continue.`;
  const current = session.holder;
  const isOwn = current !== null && current.pid === holder.pid && current.place === holder.place;
  if (current !== null && !isOwn && isRunning(current.pid)) {
    return `Planning session ${session.id} is open in ${placeName(current.place)}. Close it there to continue here.`;
  }
  return { ...session, holder, lastPlace: holder.place, updatedAt: now };
}

/** Lets go of the session, unless another process holds it now. */
export function releaseHold(session: PlanSession, holder: Holder, now: string): PlanSession {
  const isOwn = session.holder?.pid === holder.pid && session.holder.place === holder.place;
  return isOwn ? { ...session, holder: null, updatedAt: now } : session;
}

/** Problems with the target a resumed session plans for, from what exists now (FR-PLAN-031). */
export function missingTarget(target: PlanTarget, overview: RoadmapOverview): string | undefined {
  const roadmapId = target.kind === "new-roadmap" || target.kind === "new-project" ? null : target.roadmapId;
  if (roadmapId === null || overview.roadmaps.some((roadmap) => roadmap.id === roadmapId)) return undefined;
  return `Roadmap ${roadmapId}, which this session plans for, doesn't exist any more.`;
}

/** FR-PLAN-011, FR-PLAN-020: the waiting proposal as text. */
export function renderWaitingProposal(proposal: WaitingProposal, target: PlanTarget): string {
  return proposal.kind === "task"
    ? renderTaskProposal(proposal.proposal, target)
    : renderRoadmapProposal(proposal.proposal, target);
}

/** FR-PLAN-009, FR-PLAN-019: the problems with a proposal against what exists now. */
export function checkProposal(
  proposal: PlannedProposal,
  context: { readonly tasks: readonly Task[]; readonly target: PlanTarget; readonly overview: RoadmapOverview },
): string[] {
  if (proposal.kind === "roadmap") return checkRoadmapProposal(proposal.proposal, context.tasks);
  const roadmapId = context.target.kind === "task" ? context.target.roadmapId : null;
  const milestones = context.overview.roadmaps.find((roadmap) => roadmap.id === roadmapId)?.milestones;
  return checkTaskProposal(proposal.proposal, {
    existing: context.tasks,
    roadmapMilestoneIds: roadmapId === null ? undefined : (milestones ?? []).map((milestone) => milestone.id),
  });
}

/** FR-PLAN-044: the target and the user's request in their words, for the session list. */
export const planBeginInputSchema = z.strictObject({
  target: planTargetSchema,
  request: z.string().trim().min(1),
});
export const planIdInputSchema = z.strictObject({ planId: planIdSchema });
/** FR-PLAN-007 */
export const planSuggestInputSchema = z.strictObject({
  planId: planIdSchema,
  suggestions: suggestionsSchema,
  sources: sourcesSchema.default([]),
});
/** FR-PLAN-007: the proposal's own shape is checked against the session's target when it runs. */
export const planProposeInputSchema = z.strictObject({
  planId: planIdSchema,
  proposal: z.record(z.string(), z.unknown()),
});

/** FR-PLAN-052: the arguments of the `luseen` run that writes a new project's specs and agent setup. */
export function projectSpecsArgs(model: string, effort: string): string[] {
  return ["--yes", "--no-design", "--no-environment", `--model=${model}`, `--effort=${effort}`];
}

/** FR-PLAN-054, FR-DSGN-043: the arguments of the `luseen design` run for a new project; the user agreed already. */
export function projectDesignArgs(model: string, effort: string): string[] {
  return ["design", "--yes", `--model=${model}`, `--effort=${effort}`];
}

/** FR-MCP-048 */
export const briefProposeInputSchema = z.strictObject({
  planId: planIdSchema,
  markdown: z.string(),
  hasScreens: z.boolean(),
});

/** FR-PLAN-045: what the user may answer to a proposal asked about in Claude Code. */
export const PROPOSAL_ANSWERS = ["approve", "keep chatting", "cancel"] as const;

function shortened(text: string): string {
  return text.length > TOOL_INPUT_SHORT_CHARS ? `${text.slice(0, TOOL_INPUT_SHORT_CHARS - 1)}…` : text;
}

function field(input: unknown, name: string): string {
  if (typeof input !== "object" || input === null || !(name in input)) return "";
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

/** FR-PLAN-038, FR-PLAN-042: one tool call as a short line, such as "Read brief.pdf" or "Searched the web: …". */
export function activityOf(tool: string, input: unknown): string {
  const planTool = /^mcp__\w+__(plan_\w+)$/.exec(tool)?.[1];
  if (planTool !== undefined) return planTool;
  switch (tool) {
    case "Read":
      return `Read ${shortened(field(input, "file_path").split("/").at(-1) ?? "")}`;
    case "Glob":
    case "Grep":
      return `Searched the project: ${shortened(field(input, "pattern"))}`;
    case "WebSearch":
      return `Searched the web: ${shortened(field(input, "query"))}`;
    case "WebFetch":
      return `Read ${shortened(field(input, "url"))}`;
    default:
      return tool;
  }
}

/** The tool calls in one `stream-json` event from Claude Code, as activity lines. */
export function activitiesOfEvent(event: unknown): string[] {
  if (typeof event !== "object" || event === null) return [];
  const message = (event as { type?: unknown; message?: { content?: unknown } }).message;
  if ((event as { type?: unknown }).type !== "assistant" || !Array.isArray(message?.content)) return [];
  return message.content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) return [];
    const { type, name, input } = block as { type?: unknown; name?: unknown; input?: unknown };
    return type === "tool_use" && typeof name === "string" ? [activityOf(name, input)] : [];
  });
}

/** Only the calls that take a session link a Claude session to it, so a look from elsewhere never moves it. */
const LINKING_TOOL_PATTERN = /^mcp__\w+__plan_(begin|resume)$/;
const PLAN_TOOL_PATTERN = /^mcp__\w+__plan_\w+$/;
/** `"planId":"plan-3"` in a reply, however many times the reply was quoted as JSON. */
const TAKEN_PLAN_ID = new RegExp(`\\\\*"planId\\\\*"\\s*:\\s*\\\\*"(${PLAN_ID_SOURCE})\\\\*"`);

/** Whether a tool call is one of luseen's planning tools, which never link to a change (FR-MCP-045). */
export function isPlanToolCall(toolName: string | undefined): boolean {
  return toolName !== undefined && PLAN_TOOL_PATTERN.test(toolName);
}

/**
 * FR-MCP-045: the planning session a `plan_begin` or `plan_resume` call took, from its input or its reply.
 * Undefined for any other tool.
 */
export function planIdOfToolCall(toolName: string | undefined, response: unknown): string | undefined {
  if (toolName === undefined || !LINKING_TOOL_PATTERN.test(toolName)) return undefined;
  // Only a reply that took the session names it as `planId`; a refusal never does.
  return TAKEN_PLAN_ID.exec(JSON.stringify(response ?? ""))?.[1];
}

/** FR-PLAN-044, FR-MCP-045: the Claude Code session that used a planning tool is the session's conversation. */
export function linkClaudeSession(
  session: PlanSession,
  claude: { readonly sessionId: string; readonly transcriptPath: string },
  now: string,
): PlanSession {
  if (session.claudeSessionId === claude.sessionId && session.transcriptPath === claude.transcriptPath) return session;
  return {
    ...session,
    claudeSessionId: claude.sessionId,
    transcriptPath: claude.transcriptPath,
    lastPlace: "claude-code",
    updatedAt: now,
  };
}

/**
 * FR-PLAN-014, FR-PLAN-038: whether the transcript already shows the user's waiting message, so it's shown and sent
 * once: one of their own messages, or a Retry request repeating it, was written after the turn started. With no turn
 * time, the newest of those must be it, with no finished reply after it.
 */
export function isWaitingMessageWritten(
  entries: readonly { readonly kind: string; readonly text: string; readonly at: string | null }[],
  turnStartedAt: string | null,
  waiting: string,
): boolean {
  const own = entries.flatMap((entry) => {
    const shown = entry.kind === "user" ? shownUserMessage(entry.text) : null;
    return shown === null ? [] : [{ ...entry, text: shown }];
  });
  const start = turnStartedAt === null ? Number.NaN : Date.parse(turnStartedAt);
  if (Number.isNaN(start)) {
    const newest = own.at(-1);
    return newest !== undefined && newest.text === waiting && entries.at(-1)?.kind !== "assistant";
  }
  return own.some((entry) => entry.at !== null && Date.parse(entry.at) >= start);
}

/**
 * FR-PLAN-014: whether the waiting turn has a complete reply in the transcript, here or in Claude Code after this turn
 * was stopped. Only what was written after the turn started counts: the conversation moved on (the user wrote another
 * message of their own), or the PM's newest entry is text, so a lead-in followed by a tool call isn't a reply. An
 * entry with no time can't be placed, so it never counts as a reply.
 */
export function isTurnAnswered(
  entries: readonly { readonly kind: string; readonly text: string; readonly at: string | null }[],
  turnStartedAt: string | null,
): boolean {
  const start = turnStartedAt === null ? Number.NaN : Date.parse(turnStartedAt);
  if (Number.isNaN(start)) return false;
  const since = entries.filter((entry) => entry.at !== null && Date.parse(entry.at) >= start);
  const ownMessages = since.filter((entry) => entry.kind === "user" && !isPlanningNote(userPartOf(entry.text)));
  if (ownMessages.length > 1) return true;
  return since.at(-1)?.kind === "assistant";
}
