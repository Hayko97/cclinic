/** The `cclinic plan` command: the PM agent creates a roadmap or a task with the user (spec: roadmap-planning). */
import { savePlanLimits } from "../adapters/config/limits-store.js";
import { runAgent } from "../adapters/llm/agent-process.js";
import { toJsonSchemaObject } from "../adapters/llm/retry.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import { openTaskStore } from "../adapters/storage/task-store.js";
import {
  runPlanningSession,
  type PlanningOutcome,
  type PreparedSession,
  type ReviewChoice,
} from "../application/planning-session.js";
import { AGENT_SKILLS } from "../core/agent-skills.js";
import { AGENT_DENIED_TOOLS, READ_ONLY_TOOLS } from "../core/constants/agents.js";
import { MS_PER_MINUTE } from "../core/constants/limits.js";
import { AgentCallError, AgentSessionError, LlmError, UsageError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import { replySchemaFor, toRoadmapPlan, type PlanTarget } from "../core/planning.js";
import type { RoadmapOverview, Task } from "../core/tasks.js";
import { requireClaudeCli, requireDocuments } from "./agent-checks.js";
import type { CommandContext } from "./command-context.js";
import { resolveModelAndEffort } from "./generate-command.js";
import { askText, chooseFrom, isInteractive } from "./menus.js";
import { projectFolder, readOverview } from "./tasks-command.js";

export interface PlanOptions {
  readonly dir?: string;
  readonly roadmap?: number;
  readonly task?: boolean;
  readonly model?: string | true;
  readonly effort?: string | true;
  readonly timeoutMinutes: number;
}

const PM_SKILL = "product-engineer";

function roadmapChoices(overview: RoadmapOverview) {
  return overview.roadmaps.map((roadmap) => ({
    value: roadmap.id,
    name: `Roadmap #${roadmap.id}: ${roadmap.title} [${roadmap.status}]`,
  }));
}

/** FR-PLAN-004, FR-PLAN-017 */
async function chooseTarget(options: PlanOptions, overview: RoadmapOverview): Promise<PlanTarget> {
  const roadmapId = options.roadmap;
  if (roadmapId !== undefined && !overview.roadmaps.some((roadmap) => roadmap.id === roadmapId)) {
    throw new UsageError(`Roadmap ${roadmapId} doesn't exist. See your roadmaps with: cclinic tasks roadmaps`);
  }
  if (options.task === true) {
    if (roadmapId !== undefined) return { kind: "task", roadmapId };
    const where = await chooseFrom<number | null>("Where does the task go?", [
      { value: null, name: "Standalone, in no roadmap" },
      ...roadmapChoices(overview),
    ]);
    return { kind: "task", roadmapId: where };
  }
  if (roadmapId !== undefined) return { kind: "extend-roadmap", roadmapId };
  const choice = await chooseFrom<string>("What should the PM plan?", [
    { value: "new", name: "A new roadmap" },
    ...roadmapChoices(overview).map((item) => ({ value: String(item.value), name: `Extend ${item.name}` })),
    { value: "task", name: "A single task" },
  ]);
  if (choice === "new") return { kind: "new-roadmap" };
  if (choice === "task") return chooseTarget({ ...options, task: true }, overview);
  return { kind: "extend-roadmap", roadmapId: Number(choice) };
}

function readPlanningState(target: string): { overview: RoadmapOverview; tasks: readonly Task[] } {
  const store = openTaskStore(projectPaths(target, undefined).tool, "read");
  try {
    return { overview: readOverview(store), tasks: store?.listTasks(true) ?? [] };
  } finally {
    store?.close();
  }
}

/** Saves only after approval, in one transaction (FR-PLAN-013, FR-PLAN-020). */
export function savePlanningOutcome(
  target: string,
  planTarget: PlanTarget,
  outcome: PlanningOutcome,
  context: CommandContext,
): string {
  if (outcome.kind === "cancelled") return "Cancelled. Nothing was saved.";
  const store = openTaskStore(projectPaths(target, undefined).tool, "create");
  if (store === undefined) throw new UsageError("Couldn't open the task database.");
  try {
    if (outcome.kind === "roadmap") {
      const { roadmapId } = store.savePlan(toRoadmapPlan(outcome.proposal, planTarget));
      return `Saved roadmap #${roadmapId}. Run it with: cclinic auto --roadmap ${roadmapId}`;
    }
    const { task, milestoneId } = outcome.proposal;
    const saved = store.addTask({
      title: task.title.trim(),
      description: task.description,
      ...(task.spec === null ? {} : { spec: task.spec }),
      dependsOn: task.dependsOn,
      ...(milestoneId === null ? {} : { milestoneId }),
    });
    return planTarget.kind === "task" && planTarget.roadmapId !== null
      ? `Saved task #${saved.id}. It runs with its roadmap: cclinic auto --roadmap ${planTarget.roadmapId}`
      : `Saved task #${saved.id}. It's standalone, so cclinic auto doesn't run it. Ask your coding agent to work on task ${saved.id}, which takes it through the project's lifecycle.`;
  } catch (error) {
    // The proposal is printed so the planning isn't lost.
    context.reporter.notice(
      `Couldn't save the approved plan, so nothing was saved. The plan was:\n\n${outcome.text}\n`,
    );
    throw error;
  } finally {
    store.close();
  }
}

function pmCaller(settings: {
  target: string;
  planTarget: PlanTarget;
  model: ModelChoice;
  effort: Effort;
  timeoutMinutes: number;
  context: CommandContext;
}) {
  const jsonSchema = toJsonSchemaObject(replySchemaFor(settings.planTarget));
  return async (prompt: string) => {
    settings.context.reporter.info("The PM is thinking...");
    try {
      const result = await runAgent({
        cwd: settings.target,
        prompt,
        model: settings.model,
        effort: settings.effort,
        // FR-AUTO-041: each plan-limits report is saved for the GUI; failing to save it never stops the PM.
        onLimits: (limits) => {
          savePlanLimits(settings.context.environment, limits).catch(() => undefined);
        },
        jsonSchema,
        tools: READ_ONLY_TOOLS,
        allowedTools: READ_ONLY_TOOLS,
        deniedTools: AGENT_DENIED_TOOLS,
        environment: settings.context.environment,
        signal: settings.context.signal,
        timeoutMs: settings.timeoutMinutes * MS_PER_MINUTE,
      });
      return { reply: result.structuredOutput, costUsd: result.costUsd };
    } catch (error) {
      if (error instanceof AgentCallError && error.isUsageLimit) {
        const resets = error.resetsAt === null ? "" : ` It resets ${error.resetsAt}.`;
        throw new AgentSessionError(
          `The PM stopped: Claude's usage limit is reached.${resets} Nothing was saved. Plan again once it resets.`,
          { cause: error },
        );
      }
      if (error instanceof LlmError) {
        throw new AgentSessionError(`The PM stopped: ${error.message} Nothing was saved.`, { cause: error });
      }
      throw error;
    }
  };
}

/** The checks `cclinic plan` makes before anything else: Claude Code and the documents (FR-PLAN-003). */
export async function checkPlanning(target: string, context: CommandContext): Promise<void> {
  await requireClaudeCli("cclinic plan", context);
  requireDocuments(projectPaths(target, undefined).out);
}

/**
 * A planning session's input, its PM and its save, the same for `cclinic plan` and the GUI (FR-GUI-023), once the
 * target, model and effort are chosen.
 */
export function preparePlanning(
  settings: {
    readonly target: string;
    readonly planTarget: PlanTarget;
    readonly model: ModelChoice;
    readonly effort: Effort;
    readonly timeoutMinutes: number;
  },
  context: CommandContext,
): PreparedSession {
  const { target, planTarget } = settings;
  const { overview, tasks } = readPlanningState(target);
  const roadmapId = planTarget.kind === "new-roadmap" ? null : planTarget.roadmapId;
  if (roadmapId !== null && !overview.roadmaps.some((roadmap) => roadmap.id === roadmapId)) {
    throw new UsageError(`Roadmap ${roadmapId} doesn't exist. See your roadmaps with: cclinic tasks roadmaps`);
  }
  const skill = (AGENT_SKILLS.find((item) => item.name === PM_SKILL)?.body ?? "").replaceAll(
    "{{DOCS}}",
    relativeDocsPath(target, projectPaths(target, undefined).out),
  );
  const milestones = overview.roadmaps.find((roadmap) => roadmap.id === roadmapId)?.milestones ?? [];
  return {
    input: {
      target: planTarget,
      skill,
      overview,
      existingTasks: tasks,
      roadmapMilestoneIds: milestones.map((milestone) => milestone.id),
    },
    callPm: pmCaller({ ...settings, context }),
    save: (outcome) => savePlanningOutcome(target, planTarget, outcome, context),
  };
}

export async function runPlanCommand(options: PlanOptions, context: CommandContext): Promise<void> {
  const target = await projectFolder(options.dir);
  await checkPlanning(target, context);
  const { overview } = readPlanningState(target);
  if (!isInteractive()) {
    throw new UsageError("cclinic plan asks you questions, so it needs an interactive terminal.");
  }
  const { model, effort } = await resolveModelAndEffort({ model: options.model, effort: options.effort }, context);
  const planTarget = await chooseTarget(options, overview);
  const prepared = preparePlanning(
    { target, planTarget, model, effort, timeoutMinutes: options.timeoutMinutes },
    context,
  );
  const outcome = await runPlanningSession(prepared.input, {
    callPm: prepared.callPm,
    answer: (question) => askText(question),
    review: (text) => {
      context.reporter.notice(`\n${text}\n`);
      return chooseFrom<ReviewChoice>("What would you like to do?", [
        { value: "approve", name: "approve: save it" },
        { value: "refine", name: "refine: send the PM feedback" },
        { value: "cancel", name: "cancel: save nothing" },
      ]);
    },
    feedback: () => askText("Your feedback for the PM"),
  });
  context.reporter.result(prepared.save(outcome));
}
