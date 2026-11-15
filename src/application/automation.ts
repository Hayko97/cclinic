/** Runs a roadmap's tasks with developer, PM and QA agents, in dependency order (spec: automated-mode). */
import {
  buildDeveloperPrompt,
  buildImplementationReviewPrompt,
  buildQaPrompt,
  buildSpecReviewPrompt,
  commitMessage,
  decideOutcome,
  dependentsOf,
  implementationReviewSchema,
  qaResultSchema,
  readyTasks,
  specReviewSchema,
  taskBranchName,
  type DeveloperStage,
  type QaResult,
  type ReplySchema,
  type RunState,
  type StageRounds,
  type TaskContext,
  type TaskRun,
} from "../core/automation.js";
import { AUTO_LIMITS } from "../core/constants/agents.js";
import { AgentCallError, CancelledError, LuseenError } from "../core/errors.js";
import type { Task, TaskStatus } from "../core/tasks.js";

export type AgentRole = "developer" | "qa" | "pm";

export interface AgentCall {
  readonly taskId: number;
  /** The step the call is for, such as `qa-2`. It also names the call's log. */
  readonly step: string;
  readonly role: AgentRole;
  readonly cwd: string;
  readonly prompt: string;
  readonly schema?: ReplySchema;
}

export interface AgentReply {
  readonly costUsd: number | null;
  readonly finalMessage: string;
  readonly output: unknown;
  /** FR-AUTO-025: Claude said a plan usage limit is reached, though this call finished. */
  readonly limitReached?: { readonly resetsAt: string | null } | null;
}

export type MergeResult =
  { readonly isMerged: true } | { readonly isMerged: false; readonly conflicts: readonly string[] };

/** Everything the run needs from outside. Only this module decides what happens; the ports carry it out. */
export interface AutomationPorts {
  readonly git: {
    createTaskWorktree(taskBranch: string): Promise<string>;
    /** Stages everything in the worktree, and returns the diff against where the task branch started. */
    diff(worktree: string, paths?: readonly string[]): Promise<string>;
    /** Commits everything in the worktree. Returns false when there was nothing to commit. */
    commitAll(worktree: string, message: string): Promise<boolean>;
    mergeIntoRun(taskBranch: string, message: string): Promise<MergeResult>;
    removeWorktree(worktree: string): Promise<void>;
  };
  readonly runAgent: (call: AgentCall) => Promise<AgentReply>;
  readonly tasks: {
    get(id: number): Task | undefined;
    setStatus(id: number, status: TaskStatus): void;
  };
  readonly saveState: (state: RunState) => Promise<void>;
  readonly saveLog: (name: string, text: string) => Promise<void>;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  /** The documents folder, relative to the project, such as `.luseen/sdd`. */
  readonly docsPath: string;
}

export interface AutomationInput {
  readonly state: RunState;
  readonly contexts: ReadonlyMap<number, Omit<TaskContext, "task" | "docsPath">>;
  readonly doneBefore: ReadonlySet<number>;
}

/** Why a task stopped early. The stage limit and merge conflicts block it; a plan usage limit and Ctrl+C put it back. */
class TaskStop extends LuseenError {
  constructor(
    readonly status: "blocked" | "open",
    readonly reason: string,
  ) {
    super(reason);
  }
}

const NO_ROUNDS: StageRounds = { specReviews: 0, qaRuns: 0, implementationReviews: 0 };

export async function runAutomation(input: AutomationInput, ports: AutomationPorts): Promise<RunState> {
  let state = input.state;
  /** Claude Code's estimate of what the agents cost, kept in `run.json` only (FR-AUTO-027). */
  let spentUsd = 0;
  /** FR-AUTO-025: a plan usage limit is reached, so no new agent starts. */
  let isLimitReached = false;
  let limitResetsAt: string | null = null;
  const doneIds = new Set(input.doneBefore);
  let merging: Promise<unknown> = Promise.resolve();

  const save = async (): Promise<void> => {
    await ports.saveState({ ...state, spentUsd, limitResetsAt });
  };
  const update = (taskId: number, change: Partial<TaskRun>): void => {
    state = { ...state, tasks: state.tasks.map((run) => (run.taskId === taskId ? { ...run, ...change } : run)) };
  };
  const current = (taskId: number): TaskRun | undefined => state.tasks.find((item) => item.taskId === taskId);
  const addCost = (taskId: number, costUsd: number | null): void => {
    spentUsd += costUsd ?? 0;
    update(taskId, { costUsd: (current(taskId)?.costUsd ?? 0) + (costUsd ?? 0) });
  };
  // Read through a function, because the signal can be aborted while an agent runs.
  const isStopped = (): boolean => ports.signal.aborted;

  const limitReason = (): string =>
    `Claude's usage limit is reached${limitResetsAt === null ? "" : `; it resets ${limitResetsAt}`}.`;

  /** Runs one agent. A plan usage limit stops the run, putting the task back, not counting a round (FR-AUTO-025). */
  const callAgent = async <T>(
    taskId: number,
    name: string,
    call: Omit<AgentCall, "taskId" | "step">,
    schema?: ReplySchema<T>,
  ) => {
    if (isStopped()) throw new TaskStop("open", "The run was stopped.");
    if (isLimitReached) throw new TaskStop("open", limitReason());
    let reply: AgentReply;
    try {
      reply = await ports.runAgent({
        ...call,
        taskId,
        step: name,
        ...(schema === undefined ? {} : { schema }),
      });
    } catch (error) {
      if (error instanceof CancelledError || isStopped()) throw new TaskStop("open", "The run was stopped.");
      if (error instanceof AgentCallError && error.isUsageLimit) {
        isLimitReached = true;
        limitResetsAt = error.resetsAt ?? limitResetsAt;
        addCost(taskId, error.costUsd);
        await ports.saveLog(`task-${taskId}-${name}`, `STOPPED: ${error.message}`);
        throw new TaskStop("open", limitReason());
      }
      addCost(taskId, error instanceof AgentCallError ? error.costUsd : null);
      const message = error instanceof Error ? error.message : String(error);
      await ports.saveLog(`task-${taskId}-${name}`, `FAILED: ${message}`);
      return { isOk: false as const, reason: `The ${call.role} agent failed: ${message}` };
    }
    addCost(taskId, reply.costUsd);
    // The call's own work counts; the limit only stops the agents after it.
    if (reply.limitReached !== undefined && reply.limitReached !== null) {
      isLimitReached = true;
      limitResetsAt = reply.limitReached.resetsAt ?? limitResetsAt;
    }
    await ports.saveLog(`task-${taskId}-${name}`, `${reply.finalMessage}\n\n${JSON.stringify(reply.output ?? null)}`);
    await save();
    if (schema === undefined) return { isOk: true as const, value: undefined as T };
    const parsed = schema.safeParse(reply.output);
    if (!parsed.success) {
      return { isOk: false as const, reason: `The ${call.role} agent's reply wasn't a valid verdict.` };
    }
    return { isOk: true as const, value: parsed.data };
  };

  const addRound = (taskId: number, stage: keyof StageRounds): number => {
    const before = current(taskId)?.rounds ?? NO_ROUNDS;
    const rounds = { ...before, [stage]: before[stage] + 1 };
    update(taskId, { rounds });
    return rounds[stage];
  };

  const limitReached = (stage: string, reason: string): TaskStop =>
    new TaskStop("blocked", `Stopped after ${AUTO_LIMITS.roundsPerStage} ${stage}. Last: ${reason}`);

  const runTask = async (task: Task, worktree: string): Promise<readonly string[]> => {
    const context: TaskContext = {
      ...(input.contexts.get(task.id) ?? fallbackContext(task)),
      task,
      docsPath: ports.docsPath,
    };
    const develop = async (name: string, stage: DeveloperStage) =>
      callAgent(task.id, name, { role: "developer", cwd: worktree, prompt: buildDeveloperPrompt(context, stage) });

    // Spec, approved by the PM before any implementation (FR-AUTO-019, FR-AUTO-020).
    let feedback: string | null = null;
    for (;;) {
      const round = addRound(task.id, "specReviews");
      const developed = await develop(`spec-${round}`, { kind: "spec", feedback });
      let rejection: string;
      if (developed.isOk) {
        const specDiff = await ports.git.diff(worktree, [ports.docsPath]);
        const review = await callAgent(
          task.id,
          `spec-review-${round}`,
          { role: "pm", cwd: worktree, prompt: buildSpecReviewPrompt(context, specDiff) },
          specReviewSchema,
        );
        if (review.isOk && review.value.verdict === "approve") break;
        rejection = review.isOk ? review.value.feedback : review.reason;
      } else {
        rejection = developed.reason;
      }
      if (round >= AUTO_LIMITS.roundsPerStage) throw limitReached("spec reviews", rejection);
      feedback = rejection;
    }

    // Implementation, QA and the PM's review (FR-AUTO-021 to FR-AUTO-024).
    let stage: DeveloperStage = { kind: "implement" };
    for (let step = 1; ; step += 1) {
      const developed = await develop(`implement-${step}`, stage);
      if (!developed.isOk) {
        const runs = addRound(task.id, "qaRuns");
        if (runs >= AUTO_LIMITS.roundsPerStage) throw limitReached("QA runs", developed.reason);
        continue;
      }
      const qaRun = addRound(task.id, "qaRuns");
      const qa = await callAgent(
        task.id,
        `qa-${qaRun}`,
        { role: "qa", cwd: worktree, prompt: buildQaPrompt(context) },
        qaResultSchema,
      );
      if (!qa.isOk || qa.value.result === "fail") {
        const failed: QaResult = qa.isOk ? qa.value : { result: "fail", failures: [], summary: qa.reason };
        if (qaRun >= AUTO_LIMITS.roundsPerStage) {
          throw limitReached("QA runs", failed.failures.map((item) => item.testCase).join(", ") || failed.summary);
        }
        stage = { kind: "fix-qa", qa: failed };
        continue;
      }
      const reviewRound = addRound(task.id, "implementationReviews");
      const review = await callAgent(
        task.id,
        `review-${reviewRound}`,
        {
          role: "pm",
          cwd: worktree,
          prompt: buildImplementationReviewPrompt(context, await ports.git.diff(worktree), qa.value),
        },
        implementationReviewSchema,
      );
      if (review.isOk && review.value.verdict === "approve") return review.value.requirementIds;
      const rejection = review.isOk ? review.value.feedback : review.reason;
      if (reviewRound >= AUTO_LIMITS.roundsPerStage) throw limitReached("implementation reviews", rejection);
      stage = { kind: "fix-review", feedback: rejection };
    }
  };

  /** Merges one task at a time, so the run branch is never merged into twice at once (FR-AUTO-013). */
  const mergeTask = (task: Task, branch: string, worktree: string, requirementIds: readonly string[]) => {
    const merged = merging.then(async () => {
      await ports.git.commitAll(worktree, commitMessage(task, requirementIds, false));
      return ports.git.mergeIntoRun(branch, `Merge task #${task.id}: ${task.title}`);
    });
    merging = merged.catch(() => undefined);
    return merged;
  };

  const skipDependents = (taskId: number): void => {
    for (const id of dependentsOf(
      taskId,
      state.tasks.map((run) => ({ id: run.taskId, dependsOn: run.dependsOn })),
    )) {
      if (current(id)?.status === "waiting") {
        update(id, { status: "skipped", reason: `Blocked by task #${taskId}, which didn't finish.` });
      }
    }
  };

  const startTask = async (taskId: number): Promise<void> => {
    const task = ports.tasks.get(taskId);
    // The task list can change during a run, so each task is read again before it starts.
    if (task === undefined || (task.status !== "open" && task.status !== "blocked")) {
      update(taskId, { status: "skipped", reason: "It was removed or changed while the run was going." });
      skipDependents(taskId);
      await save();
      return;
    }
    const branch = taskBranchName(state.runId, taskId);
    update(taskId, { status: "running", branch, rounds: NO_ROUNDS });
    ports.tasks.setStatus(taskId, "in-progress");
    await save();
    const worktree = await ports.git.createTaskWorktree(branch);
    try {
      const requirementIds = await runTask(task, worktree);
      const merged = await mergeTask(task, branch, worktree, requirementIds);
      if (!merged.isMerged) {
        throw new TaskStop("blocked", `Merging into the run branch conflicted in: ${merged.conflicts.join(", ")}`);
      }
      doneIds.add(taskId);
      update(taskId, { status: "done", requirementIds, reason: null });
      ports.tasks.setStatus(taskId, "done");
    } catch (error) {
      const stop =
        error instanceof TaskStop
          ? error
          : new TaskStop(isStopped() ? "open" : "blocked", error instanceof Error ? error.message : String(error));
      // Unapproved work stays on the task branch only (FR-AUTO-015, FR-AUTO-031).
      await ports.git.commitAll(worktree, commitMessage(task, [], true)).catch(() => false);
      update(taskId, { status: stop.status, reason: stop.reason });
      ports.tasks.setStatus(taskId, stop.status);
      if (stop.status === "blocked") skipDependents(taskId);
    } finally {
      await ports.git.removeWorktree(worktree);
      await save();
    }
  };

  await save();
  const running = new Map<number, Promise<void>>();
  for (;;) {
    const canStartMore = !isStopped() && !isLimitReached;
    if (canStartMore) {
      for (const run of readyTasks(state.tasks, doneIds, state.developers - running.size)) {
        update(run.taskId, { status: "running" });
        running.set(
          run.taskId,
          startTask(run.taskId).finally(() => running.delete(run.taskId)),
        );
      }
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  // Tasks that never started keep their status in the task list.
  const wasCutShort = isStopped() || isLimitReached;
  for (const run of state.tasks.filter((item) => item.status === "waiting")) {
    update(run.taskId, {
      status: wasCutShort ? "open" : "skipped",
      reason: wasCutShort ? "The run ended before it started." : "Its dependencies didn't finish.",
    });
  }
  state = {
    ...state,
    spentUsd,
    limitResetsAt,
    finishedAt: ports.now().toISOString(),
    outcome: decideOutcome(state.tasks, isStopped(), isLimitReached),
  };
  await ports.saveState(state);
  return state;
}

function fallbackContext(task: Task): Omit<TaskContext, "task" | "docsPath"> {
  return { roadmapTitle: "", roadmapGoal: null, milestoneTitle: `#${task.milestoneId ?? "none"}`, milestoneGoal: null };
}
