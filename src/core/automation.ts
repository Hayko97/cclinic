/** Running a roadmap with developer, PM and QA agents, with no human (spec: automated-mode). */
import { z } from "zod";
import {
  AUTO_BRANCH_PREFIX,
  FIRST_RUN_ID_SUFFIX,
  MAX_REVIEW_DIFF_CHARS,
  RUN_ID_FIELD_DIGITS,
  WIP_COMMIT_MARKER,
} from "./constants/agents.js";
import { USD_DECIMAL_PLACES } from "./constants/terminal.js";
import { findCycle, type Roadmap, type Task } from "./tasks.js";

export const RUN_OUTCOMES = ["completed", "partial", "budget-reached", "interrupted"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** `open` is a task put back for a later run, after the budget ran out or the run was stopped. */
export type TaskRunStatus = "waiting" | "running" | "done" | "blocked" | "skipped" | "open";

export interface StageRounds {
  readonly specReviews: number;
  readonly qaRuns: number;
  readonly implementationReviews: number;
}

export interface TaskRun {
  readonly taskId: number;
  readonly title: string;
  readonly dependsOn: readonly number[];
  readonly status: TaskRunStatus;
  readonly branch: string | null;
  readonly rounds: StageRounds;
  readonly costUsd: number;
  readonly reason: string | null;
  readonly requirementIds: readonly string[];
}

export const AGENT_SESSION_ROLES = ["developer", "pm", "qa", "reviewer"] as const;

/** FR-AUTO-039: which Claude Code session each agent of a run used. It never holds a prompt or output. */
export const agentSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  taskId: z.number().int().positive(),
  role: z.enum(AGENT_SESSION_ROLES),
  step: z.string(),
  cwd: z.string(),
  transcriptPath: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Null while running, or when the process was stopped before it exited. */
  exitCode: z.number().int().nullable(),
  /** What Claude Code reported the agent cost, once it ended. Older session files have none. */
  costUsd: z.number().min(0).nullable().default(null),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export interface RunState {
  readonly runId: string;
  readonly roadmapId: number;
  readonly roadmapTitle: string;
  readonly runBranch: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: RunOutcome | null;
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly developers: number;
  readonly tasks: readonly TaskRun[];
  /** In progress when the run started, so left alone (FR-AUTO-001). */
  readonly skippedInProgress: readonly { readonly taskId: number; readonly title: string }[];
}

const pad = (value: number): string => String(value).padStart(RUN_ID_FIELD_DIGITS, "0");

/** UTC `YYYYMMDD-HHMMSS`, with `-2`, `-3`... when it's already used (FR-AUTO-010). */
export function createRunId(now: Date, isUsed: (runId: string) => boolean): string {
  const base = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  if (!isUsed(base)) return base;
  for (let suffix = FIRST_RUN_ID_SUFFIX; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isUsed(candidate)) return candidate;
  }
}

/** Git can't hold `a/b` next to `a/b/c`, so the run branch has its own name under the run (FR-AUTO-010). */
export function runBranchName(runId: string): string {
  return `${AUTO_BRANCH_PREFIX}/${runId}/run`;
}

export function taskBranchName(runId: string, taskId: number): string {
  return `${AUTO_BRANCH_PREFIX}/${runId}/task-${taskId}`;
}

/** The roadmap's tasks to run, in roadmap order, and those left alone because they're in progress. */
export function selectRoadmapTasks(roadmap: Roadmap): { selected: readonly Task[]; inProgress: readonly Task[] } {
  const tasks = roadmap.milestones.flatMap((milestone) => milestone.tasks);
  return {
    selected: tasks.filter((task) => task.status === "open" || task.status === "blocked"),
    inProgress: tasks.filter((task) => task.status === "in-progress"),
  };
}

export interface RunPlan {
  /** Tasks that won't run, with the reason (FR-AUTO-004, FR-AUTO-008). */
  readonly blockedBefore: ReadonlyMap<number, string>;
  readonly runnable: readonly Task[];
}

/** Every selected task that depends, directly or indirectly, on `taskId`. */
export function dependentsOf(taskId: number, tasks: readonly Pick<Task, "id" | "dependsOn">[]): number[] {
  const found = new Set<number>();
  const visit = (id: number): void => {
    for (const task of tasks) {
      if (task.dependsOn.includes(id) && !found.has(task.id)) {
        found.add(task.id);
        visit(task.id);
      }
    }
  };
  visit(taskId);
  return [...found];
}

/** Returns the tasks in a dependency cycle among the selected tasks and what they depend on. */
export function findRunCycle(selected: readonly Task[], all: readonly Task[]): readonly number[] | undefined {
  const byId = new Map(all.map((task) => [task.id, task]));
  const edges = new Map<number, readonly number[]>();
  const add = (task: Task): void => {
    if (edges.has(task.id)) return;
    edges.set(task.id, task.dependsOn);
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      if (dependency !== undefined) add(dependency);
    }
  };
  for (const task of selected) add(task);
  return findCycle(edges);
}

/** FR-AUTO-004: a dependency that's neither done nor selected blocks the task, and everything after it. */
export function planRun(selected: readonly Task[], all: readonly Task[]): RunPlan {
  const selectedIds = new Set(selected.map((task) => task.id));
  const doneIds = new Set(all.filter((task) => task.status === "done").map((task) => task.id));
  const blockedBefore = new Map<number, string>();
  for (const task of selected) {
    const missing = task.dependsOn.find((id) => !doneIds.has(id) && !selectedIds.has(id));
    if (missing === undefined || blockedBefore.has(task.id)) continue;
    const status = all.find((item) => item.id === missing)?.status ?? "missing";
    blockedBefore.set(task.id, `Blocked by task #${missing}, which is ${status} and not in this run.`);
    for (const id of dependentsOf(task.id, selected)) {
      if (!blockedBefore.has(id)) blockedBefore.set(id, `Blocked by task #${task.id}, which can't run.`);
    }
  }
  return { blockedBefore, runnable: selected.filter((task) => !blockedBefore.has(task.id)) };
}

/** Dependencies first, and otherwise roadmap order, for showing the plan (FR-AUTO-005). */
export function runOrder(tasks: readonly Task[]): Task[] {
  const ids = new Set(tasks.map((task) => task.id));
  const placed = new Set<number>();
  const ordered: Task[] = [];
  while (ordered.length < tasks.length) {
    const next = tasks.find(
      (task) => !placed.has(task.id) && task.dependsOn.every((id) => !ids.has(id) || placed.has(id)),
    );
    // A cycle is refused before this is called, so `next` is only missing if one slipped through.
    const chosen = next ?? tasks.find((task) => !placed.has(task.id));
    if (chosen === undefined) break;
    placed.add(chosen.id);
    ordered.push(chosen);
  }
  return ordered;
}

/** Waiting tasks whose dependencies are all done, in roadmap order (FR-AUTO-006, FR-AUTO-007). */
export function readyTasks(runs: readonly TaskRun[], doneIds: ReadonlySet<number>, freeSlots: number): TaskRun[] {
  return runs
    .filter((run) => run.status === "waiting" && run.dependsOn.every((id) => doneIds.has(id)))
    .slice(0, Math.max(freeSlots, 0));
}

export function decideOutcome(runs: readonly TaskRun[], isInterrupted: boolean, isBudgetReached: boolean): RunOutcome {
  if (isInterrupted) return "interrupted";
  if (isBudgetReached) return "budget-reached";
  return runs.every((run) => run.status === "done") ? "completed" : "partial";
}

export function commitMessage(
  task: Pick<Task, "id" | "title">,
  requirementIds: readonly string[],
  isWip: boolean,
): string {
  const subject = `#${task.id} ${task.title}${isWip ? ` (${WIP_COMMIT_MARKER})` : ""}`;
  const body = isWip
    ? `${WIP_COMMIT_MARKER}: unfinished work from cclinic automated mode, not approved.`
    : `Requirements: ${requirementIds.length === 0 ? "none reported" : requirementIds.join(", ")}`;
  return `${subject}\n\n${body}`;
}

// Agent replies. Shapes are flat objects so the Claude CLI can enforce them.

/** The shape an agent's reply must have, so callers outside core don't depend on zod. */
export type ReplySchema<T = unknown> = z.ZodType<T>;

export const specReviewSchema = z.object({
  verdict: z.enum(["approve", "refine"]),
  feedback: z.string(),
});
export type SpecReview = z.infer<typeof specReviewSchema>;

export const qaResultSchema = z.object({
  result: z.enum(["pass", "fail"]),
  failures: z.array(z.object({ testCase: z.string(), output: z.string() })),
  summary: z.string(),
});
export type QaResult = z.infer<typeof qaResultSchema>;

export const implementationReviewSchema = z.object({
  verdict: z.enum(["approve", "changes"]),
  feedback: z.string(),
  requirementIds: z.array(z.string()),
});
export type ImplementationReview = z.infer<typeof implementationReviewSchema>;

export interface TaskContext {
  readonly task: Task;
  readonly roadmapTitle: string;
  readonly roadmapGoal: string | null;
  readonly milestoneTitle: string;
  readonly milestoneGoal: string | null;
  readonly docsPath: string;
}

function describeTask(context: TaskContext): string {
  const { task } = context;
  return [
    `Task #${task.id}: ${task.title}`,
    `Spec: ${task.spec === null ? "none yet (create one with the create-spec skill)" : task.spec}`,
    `Roadmap: ${context.roadmapTitle}${context.roadmapGoal === null ? "" : ` (goal: ${context.roadmapGoal})`}`,
    `Milestone: ${context.milestoneTitle}${context.milestoneGoal === null ? "" : ` (goal: ${context.milestoneGoal})`}`,
    ...(task.description === null ? [] : ["", "Description:", task.description]),
  ].join("\n");
}

const AUTOMATED_RULES = `You're working in cclinic's automated mode. No human is watching, so never wait for a human or ask the user anything.
Follow the project's AGENTS.md lifecycle and skills, except:
- The PM agent gives every approval instead of the user. Don't ask for approval; finish your stage and stop.
- Don't commit, push or run git. cclinic commits approved work itself.
- Don't change .cclinic/tasks.db, and don't run \`cclinic tasks\` commands.
- Work only inside the current folder.`;

export type DeveloperStage =
  | { readonly kind: "spec"; readonly feedback: string | null }
  | { readonly kind: "implement" }
  | { readonly kind: "fix-qa"; readonly qa: QaResult }
  | { readonly kind: "fix-review"; readonly feedback: string };

function stageInstructions(stage: DeveloperStage): string {
  switch (stage.kind) {
    case "spec":
      return [
        "## Stage: spec",
        "Refine the task's spec with the refine-spec skill, or write it with the create-spec skill when it has none. Change only the spec's files, not production code or tests. End with a short summary of the spec change.",
        ...(stage.feedback === null ? [] : ["", "The PM sent the spec back with this feedback:", stage.feedback]),
      ].join("\n");
    case "implement":
      return "## Stage: implement\nThe PM approved the spec. Implement it with the implement-spec skill, using the write-code skill for all code, and run the project's checks. End with a short summary.";
    case "fix-qa":
      return [
        "## Stage: fix QA failures",
        "QA found these failures. Fix the code, or a wrong test so it checks what the spec says. Never weaken a test.",
        ...stage.qa.failures.map((failure) => `- ${failure.testCase}: ${failure.output}`),
        `QA summary: ${stage.qa.summary}`,
      ].join("\n");
    case "fix-review":
      return `## Stage: fix the PM's review\nThe PM asked for these changes:\n${stage.feedback}`;
  }
}

/** FR-AUTO-018 */
export function buildDeveloperPrompt(context: TaskContext, stage: DeveloperStage): string {
  return ["You are a developer agent.", AUTOMATED_RULES, "", describeTask(context), "", stageInstructions(stage)].join(
    "\n",
  );
}

/** FR-AUTO-021 */
export function buildQaPrompt(context: TaskContext): string {
  const spec = context.task.spec;
  return [
    "You are the QA agent. You didn't write this change.",
    AUTOMATED_RULES,
    "",
    describeTask(context),
    "",
    "## Your job",
    spec === null
      ? "Follow the test-spec skill for the spec this task created or changed, in the project's specs folder."
      : `Follow the test-spec skill for the \`${spec}\` spec, in ${context.docsPath}/specs/${spec}/.`,
    "Automate and run its test cases, including the end-to-end tests where the spec has them, and the project's full checks. If no spec covers the change, run the full checks and say so.",
    "Don't change production code. Never weaken a test to get a pass.",
    'Reply with JSON: { "result": "pass" or "fail", "failures": [{ "testCase", "output" }], "summary" }.',
  ].join("\n");
}

function clipped(diff: string): string {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_REVIEW_DIFF_CHARS)}\n[The diff was cut at ${MAX_REVIEW_DIFF_CHARS} characters. Read the files for the rest.]`;
}

/** FR-AUTO-019 */
export function buildSpecReviewPrompt(context: TaskContext, specDiff: string): string {
  return [
    "You are the PM agent, reviewing a spec change in cclinic's automated mode. You only read: you can't change files or run commands.",
    "",
    describeTask(context),
    "",
    "Check that the spec change matches the task's title and description, and serves its milestone's and roadmap's goals. Check that requirements are testable and every requirement has acceptance criteria and test cases.",
    "",
    "## Spec change (diff)",
    specDiff.trim() === "" ? "(no change to the spec)" : clipped(specDiff),
    "",
    'Reply with JSON: { "verdict": "approve" or "refine", "feedback": what to change, or "" }.',
  ].join("\n");
}

/** FR-AUTO-022 */
export function buildImplementationReviewPrompt(context: TaskContext, diff: string, qa: QaResult): string {
  return [
    "You are the PM agent, reviewing finished work in cclinic's automated mode. You only read: you can't change files or run commands.",
    "",
    describeTask(context),
    "",
    "Check that the change does what the task and its spec say, that the bug or feature is really handled, and that QA's result supports it.",
    "",
    "## QA result",
    JSON.stringify(qa),
    "",
    "## Change (diff)",
    clipped(diff),
    "",
    'Reply with JSON: { "verdict": "approve" or "changes", "feedback": what to change, or "", "requirementIds": the FR IDs this change covers }.',
  ].join("\n");
}

const usd = (value: number): string => `$${value.toFixed(USD_DECIMAL_PLACES)}`;

function roundsText(rounds: StageRounds): string {
  return `${rounds.specReviews} spec, ${rounds.qaRuns} QA, ${rounds.implementationReviews} review`;
}

/** FR-AUTO-028 */
export function renderReport(state: RunState): string {
  const lines = [
    `# Automated run ${state.runId}`,
    "",
    `- Roadmap: #${state.roadmapId} ${state.roadmapTitle}`,
    `- Run branch: \`${state.runBranch}\``,
    `- Outcome: ${state.outcome ?? "running"}`,
    `- Started: ${state.startedAt}`,
    `- Finished: ${state.finishedAt ?? "not yet"}`,
    `- Total cost: ${usd(state.spentUsd)} of ${usd(state.budgetUsd)} (estimate)`,
    "",
    "## Tasks",
    "",
    "| Task | Result | Branch | Rounds | Cost | Reason |",
    "|---|---|---|---|---|---|",
    ...state.tasks.map(
      (run) =>
        `| #${run.taskId} ${run.title.replaceAll("|", "\\|")} | ${run.status} | ${run.branch === null ? "" : `\`${run.branch}\``} | ${roundsText(run.rounds)} | ${usd(run.costUsd)} | ${(run.reason ?? "").replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    ),
  ];
  if (state.skippedInProgress.length > 0) {
    lines.push("", "## Left alone because they were in progress", "");
    lines.push(...state.skippedInProgress.map((task) => `- #${task.taskId} ${task.title}`));
  }
  lines.push(
    "",
    "## Review and merge",
    "",
    "Nothing was pushed, and your own branch wasn't changed. To review and merge the work:",
    "",
    "```bash",
    `git log --oneline ${state.runBranch}`,
    `git diff HEAD...${state.runBranch}`,
    `git merge ${state.runBranch}`,
    "```",
    "",
  );
  return lines.join("\n");
}

/** FR-AUTO-029 */
export function notificationText(state: RunState): { readonly title: string; readonly message: string } {
  const count = (status: TaskRunStatus): number => state.tasks.filter((run) => run.status === status).length;
  return {
    title: `cclinic: ${state.roadmapTitle}`,
    message: `Run ${state.outcome ?? "ended"}: ${count("done")} done, ${count("blocked") + count("skipped")} blocked.`,
  };
}

export function renderPlan(input: {
  roadmap: Pick<Roadmap, "id" | "title">;
  runnable: readonly Task[];
  blockedBefore: ReadonlyMap<number, string>;
  inProgress: readonly Task[];
  runBranch: string;
  developers: number;
  budgetUsd: number;
}): string {
  const needs = (task: Task): string =>
    task.dependsOn.length === 0 ? "" : ` (after ${task.dependsOn.map((id) => `#${id}`).join(", ")})`;
  return [
    `Roadmap #${input.roadmap.id}: ${input.roadmap.title}`,
    `Run branch: ${input.runBranch}`,
    `Developers: ${input.developers}`,
    `Budget: ${usd(input.budgetUsd)}`,
    "",
    "Tasks in run order:",
    ...input.runnable.map((task) => `  #${task.id} ${task.title}${needs(task)}`),
    ...(input.blockedBefore.size === 0
      ? []
      : ["", "Won't run:", ...[...input.blockedBefore].map(([id, reason]) => `  #${id}: ${reason}`)]),
    ...(input.inProgress.length === 0
      ? []
      : ["", "Left alone, in progress:", ...input.inProgress.map((task) => `  #${task.id} ${task.title}`)]),
  ].join("\n");
}
