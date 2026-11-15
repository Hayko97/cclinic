/** The `luseen auto` command: runs a whole roadmap with developer, PM and QA agents (spec: automated-mode). */
import { randomUUID } from "node:crypto";
import { openRunRepository, readRepositoryState, branchExists, missingFromHead } from "../adapters/git/run-branches.js";
import { savePlanLimits } from "../adapters/config/limits-store.js";
import { claudeTranscriptPath, runAgent } from "../adapters/llm/agent-process.js";
import { toJsonSchemaObject } from "../adapters/llm/retry.js";
import { notifyUser } from "../adapters/notify/desktop-notifier.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import {
  acquireRunLock,
  checkNoRunGoing,
  createRunFiles,
  isRunFolderUsed,
  runFolder,
} from "../adapters/storage/run-store.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import { openTaskStore } from "../adapters/storage/task-store.js";
import { runAutomation, type AgentCall, type AutomationPorts } from "../application/automation.js";
import {
  createRunId,
  findRunCycle,
  notificationText,
  planRun,
  renderPlan,
  renderReport,
  runBranchName,
  runOrder,
  selectRoadmapTasks,
  type AgentSession,
  type RunState,
  type TaskContext,
  type TaskRun,
} from "../core/automation.js";
import {
  AGENT_DENIED_TOOLS,
  AUTO_REQUIRED_SKILLS,
  READ_ONLY_TOOLS,
  WORKTREE_AGENT_ALLOWED_TOOLS,
  WRITING_TOOLS,
} from "../core/constants/agents.js";
import { MS_PER_MINUTE } from "../core/constants/limits.js";
import { SKILL_FILE, SKILL_FOLDERS } from "../core/constants/paths.js";
import { AgentCallError, CancelledError, UsageError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import type { Roadmap, RoadmapOverview, Task, TaskStatus } from "../core/tasks.js";
import { requireClaudeCli } from "./agent-checks.js";
import type { CommandContext } from "./command-context.js";
import { resolveModelAndEffort } from "./generate-command.js";
import { askToConfirm, chooseFrom, isInteractive } from "./menus.js";
import { projectFolder, readOverview } from "./tasks-command.js";

export interface AutoOptions {
  readonly dir?: string;
  readonly roadmap?: number;
  readonly developers: number;
  readonly model?: string | true;
  readonly effort?: string | true;
  readonly timeoutMinutes: number;
  readonly yes?: boolean;
  readonly json?: boolean;
  /** FR-AUTO-040: check and show the plan, then stop before anything starts. */
  readonly dryRun?: boolean;
}

/** FR-AUTO-003 */
async function checkProject(target: string, context: CommandContext): Promise<void> {
  await requireClaudeCli("luseen auto", context);
  const options = { environment: context.environment };
  const repository = await readRepositoryState(target, options);
  if (!repository.isRepository) {
    throw new UsageError(`${target} isn't a Git repository. Run "git init", and commit the project first.`);
  }
  if (!repository.hasCommit) throw new UsageError("The repository has no commits yet. Commit the project first.");
  if (repository.hasTrackedChanges) {
    throw new UsageError("The working tree has uncommitted changes to tracked files. Commit or stash them first.");
  }
  const [agentsFolder, claudeFolder] = SKILL_FOLDERS;
  const missing: string[] = [];
  for (const skill of AUTO_REQUIRED_SKILLS) {
    const paths = [`${agentsFolder}/${skill}/${SKILL_FILE}`, `${claudeFolder}/${skill}/${SKILL_FILE}`];
    if ((await missingFromHead(target, paths, options)).length === paths.length) missing.push(skill);
  }
  if (missing.length > 0) {
    throw new UsageError(
      `The luseen skills ${missing.join(", ")} aren't installed and committed. Agents work from the last commit, so run "luseen skills" and commit the result.`,
    );
  }
}

function tasksToRun(roadmap: Roadmap): number {
  return selectRoadmapTasks(roadmap).selected.length;
}

/** FR-AUTO-034 */
async function chooseRoadmap(given: number | undefined, overview: RoadmapOverview): Promise<Roadmap> {
  if (given !== undefined) {
    const found = overview.roadmaps.find((roadmap) => roadmap.id === given);
    if (found === undefined)
      throw new UsageError(`Roadmap ${given} doesn't exist. See your roadmaps with: luseen tasks roadmaps`);
    return found;
  }
  if (overview.roadmaps.length === 0) {
    throw new UsageError("There are no roadmaps to run. Create one with the PM agent: luseen plan");
  }
  if (!isInteractive()) {
    const ids = overview.roadmaps.map((roadmap) => roadmap.id).join(", ");
    throw new UsageError(
      `Choose a roadmap with --roadmap <id>. Roadmaps: ${ids}. See them with: luseen tasks roadmaps`,
    );
  }
  const id = await chooseFrom(
    "Which roadmap should the agents run?",
    overview.roadmaps.map((roadmap) => ({
      value: roadmap.id,
      name: `#${roadmap.id} ${roadmap.title} [${roadmap.status}] - ${tasksToRun(roadmap)} tasks to run`,
    })),
  );
  return overview.roadmaps.find((roadmap) => roadmap.id === id) ?? (overview.roadmaps[0] as Roadmap);
}

function taskContexts(roadmap: Roadmap): Map<number, Omit<TaskContext, "task" | "docsPath">> {
  const contexts = new Map<number, Omit<TaskContext, "task" | "docsPath">>();
  for (const milestone of roadmap.milestones) {
    for (const task of milestone.tasks) {
      contexts.set(task.id, {
        roadmapTitle: roadmap.title,
        roadmapGoal: roadmap.goal,
        milestoneTitle: milestone.title,
        milestoneGoal: milestone.goal,
      });
    }
  }
  return contexts;
}

function agentRunner(settings: {
  model: ModelChoice;
  effort: Effort;
  timeoutMinutes: number;
  context: CommandContext;
  saveSession: (session: AgentSession) => Promise<void>;
}) {
  return async (call: AgentCall) => {
    const isPm = call.role === "pm";
    // FR-AUTO-039: recorded before the agent starts, so a viewer can follow it while it works.
    const sessionId = randomUUID();
    const session: AgentSession = {
      sessionId,
      taskId: call.taskId,
      role: call.role,
      step: call.step,
      cwd: call.cwd,
      transcriptPath: claudeTranscriptPath(settings.context.environment, call.cwd, sessionId),
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      costUsd: null,
    };
    await settings.saveSession(session);
    const end = (exitCode: number | null, costUsd: number | null) =>
      settings.saveSession({ ...session, endedAt: new Date().toISOString(), exitCode, costUsd });
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent({
        cwd: call.cwd,
        prompt: call.prompt,
        model: settings.model,
        effort: settings.effort,
        // FR-AUTO-041: each plan-limits report is saved for the GUI; failing to save it never stops the agent.
        onLimits: (limits) => {
          savePlanLimits(settings.context.environment, limits).catch(() => undefined);
        },
        ...(call.schema === undefined ? {} : { jsonSchema: toJsonSchemaObject(call.schema) }),
        tools: isPm ? READ_ONLY_TOOLS : WRITING_TOOLS,
        allowedTools: isPm ? READ_ONLY_TOOLS : WORKTREE_AGENT_ALLOWED_TOOLS,
        deniedTools: AGENT_DENIED_TOOLS,
        environment: settings.context.environment,
        signal: settings.context.signal,
        timeoutMs: settings.timeoutMinutes * MS_PER_MINUTE,
        sessionId,
      });
    } catch (error) {
      // The agent's failure is what the run must report, even if recording its end fails too.
      const failure = error instanceof AgentCallError ? error : undefined;
      await end(failure?.exitCode ?? null, failure?.costUsd ?? null).catch(() => undefined);
      throw error;
    }
    // The agent's work and cost count even if recording its end fails.
    await end(0, result.costUsd).catch(() => undefined);
    return {
      costUsd: result.costUsd,
      finalMessage: result.finalMessage,
      output: result.structuredOutput,
      limitReached: result.limitReached,
    };
  };
}

function taskList(target: string) {
  const tool = projectPaths(target, undefined).tool;
  return {
    get: (id: number): Task | undefined => {
      const store = openTaskStore(tool, "read");
      try {
        return store?.getTask(id);
      } finally {
        store?.close();
      }
    },
    setStatus: (id: number, status: TaskStatus): void => {
      const store = openTaskStore(tool, "update");
      try {
        store?.setStatus(id, status);
      } finally {
        store?.close();
      }
    },
  };
}

function initialRuns(
  runnable: readonly Task[],
  blockedBefore: ReadonlyMap<number, string>,
  all: readonly Task[],
): TaskRun[] {
  const base = (task: Task): Omit<TaskRun, "status" | "reason"> => ({
    taskId: task.id,
    title: task.title,
    dependsOn: task.dependsOn,
    branch: null,
    rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
    costUsd: 0,
    requirementIds: [],
  });
  return [
    ...runOrder(runnable).map((task) => ({ ...base(task), status: "waiting" as const, reason: null })),
    ...[...blockedBefore].map(([id, reason]) => {
      const task = all.find((item) => item.id === id) as Task;
      return { ...base(task), status: "skipped" as const, reason };
    }),
  ];
}

function summary(state: RunState, reportFile: string): string {
  const lines = state.tasks.map(
    (run) => `  #${run.taskId} ${run.title}: ${run.status}${run.reason === null ? "" : ` (${run.reason})`}`,
  );
  return [
    `Run ${state.runId} ${state.outcome ?? "ended"}. Branch: ${state.runBranch}`,
    ...lines,
    `Report: ${reportFile}`,
  ].join("\n");
}

/** Returns the exit code: 0 when every task is done, otherwise 1 (FR-AUTO-030). */
export async function runAutoCommand(options: AutoOptions, context: CommandContext): Promise<number> {
  const target = await projectFolder(options.dir);
  const paths = projectPaths(target, undefined);
  await checkNoRunGoing(target);
  await checkProject(target, context);

  const store = openTaskStore(paths.tool, "read");
  const overview = readOverview(store);
  const allTasks = store?.listTasks(true) ?? [];
  store?.close();

  const roadmap = await chooseRoadmap(options.roadmap, overview);
  const { selected, inProgress } = selectRoadmapTasks(roadmap);
  if (selected.length === 0) {
    throw new UsageError(`Roadmap ${roadmap.id} has no open or blocked tasks to run.`);
  }
  const cycle = findRunCycle(selected, allTasks);
  if (cycle !== undefined) {
    throw new UsageError(
      `The tasks depend on each other in a cycle: ${[...cycle, cycle[0]].map((id) => `#${String(id)}`).join(" -> ")}. Fix it with luseen tasks undepend.`,
    );
  }
  const { runnable, blockedBefore } = planRun(selected, allTasks);
  const runId = createRunId(new Date(), (id) => isRunFolderUsed(target, id));
  const runBranch = runBranchName(runId);
  if (await branchExists(target, runBranch, { environment: context.environment })) {
    throw new UsageError(`Branch ${runBranch} already exists. Try again in a second.`);
  }

  const ordered = runOrder(runnable);
  const plan = renderPlan({
    roadmap,
    runnable: ordered,
    blockedBefore,
    inProgress,
    runBranch,
    developers: options.developers,
  });
  if (options.dryRun === true) {
    // The model and reasoning are checked as the run checks them, but no menu opens.
    await resolveModelAndEffort(
      {
        model: options.model === true ? undefined : options.model,
        effort: options.effort === true ? undefined : options.effort,
      },
      context,
    );
    context.reporter.result(
      options.json === true
        ? JSON.stringify({
            status: "plan",
            roadmapId: roadmap.id,
            plan,
            runnable: ordered.map((task) => task.id),
            blocked: [...blockedBefore.keys()],
          })
        : plan,
    );
    return 0;
  }
  if (options.yes !== true) {
    if (!isInteractive()) {
      throw new UsageError("Confirmation needs an interactive terminal. Use --yes to run without asking.");
    }
    context.reporter.notice(`\n${plan}\n`);
    if (!(await askToConfirm("Start the automated run?", false)))
      throw new UsageError("Cancelled. Nothing was started.");
  } else {
    context.reporter.info(plan);
  }

  const { model, effort } = await resolveModelAndEffort({ model: options.model, effort: options.effort }, context);
  const folder = runFolder(target, runId);
  const releaseLock = await acquireRunLock(target, runId);
  try {
    const files = createRunFiles(folder);
    const repository = await openRunRepository({
      target,
      runFolder: folder,
      runBranch,
      environment: context.environment,
    });
    let state: RunState = {
      runId,
      roadmapId: roadmap.id,
      roadmapTitle: roadmap.title,
      runBranch,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      spentUsd: 0,
      developers: options.developers,
      model,
      effort,
      timeoutMinutes: options.timeoutMinutes,
      limitResetsAt: null,
      tasks: initialRuns(runnable, blockedBefore, allTasks),
      skippedInProgress: inProgress.map((task) => ({ taskId: task.id, title: task.title })),
    };
    context.reporter.info(`Started run ${runId} on branch ${runBranch}. Progress is in ${folder}.`);
    const ports: AutomationPorts = {
      git: repository,
      runAgent: agentRunner({
        model,
        effort,
        timeoutMinutes: options.timeoutMinutes,
        context,
        saveSession: files.saveSession,
      }),
      tasks: taskList(target),
      saveState: files.saveState,
      saveLog: files.saveLog,
      now: () => new Date(),
      signal: context.signal,
      docsPath: relativeDocsPath(target, paths.out),
    };
    try {
      state = await runAutomation(
        {
          state,
          contexts: taskContexts(roadmap),
          doneBefore: new Set(allTasks.filter((task) => task.status === "done").map((task) => task.id)),
        },
        ports,
      );
    } finally {
      await repository.close();
    }
    const reportFile = await files.saveReport(renderReport(state));
    const notification = notificationText(state);
    await notifyUser({
      ...notification,
      platform: process.platform,
      environment: context.environment,
      writeTerminal: (text) => {
        context.reporter.notice(text.trimEnd());
      },
    });
    if (options.json === true) {
      context.reporter.result(
        JSON.stringify({
          status: "success",
          outcome: state.outcome,
          runBranch: state.runBranch,
          report: reportFile,
          ...(state.outcome === "limit-reached" ? { limitResetsAt: state.limitResetsAt } : {}),
          tasks: state.tasks.map(({ taskId, title, status, branch, reason }) => ({
            taskId,
            title,
            status,
            branch,
            reason,
          })),
        }),
      );
    } else {
      context.reporter.result(summary(state, reportFile));
    }
    if (state.outcome === "interrupted") throw new CancelledError("The automated run was stopped.");
    return state.outcome === "completed" ? 0 : 1;
  } finally {
    await releaseLock();
  }
}
