/** A task's workflow steps, as the task panel shows them (spec: gui FR-GUI-056). Pure: no I/O. */
import type { AgentSession, TaskRunStatus } from "./automation.js";
import { STEPS, type WorkflowState } from "./workflow.js";

export type StepStatus = "not-started" | "running" | "waiting" | "passed" | "sent-back" | "failed" | "skipped";

export interface StepRow {
  /** Such as `qa` or `spec-review`, the same in every round. */
  readonly step: string;
  readonly round: number | null;
  readonly status: StepStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly costUsd: number | null;
  readonly sessionId: string | null;
}

export interface StepsView {
  readonly source: "run" | "workflow";
  readonly rows: readonly StepRow[];
  /** The cost of all the steps together. */
  readonly costUsd: number;
}

/** Steps whose rounds review the work before them, so a later round means this one sent it back. */
const REVIEW_STEPS: ReadonlySet<string> = new Set(["spec-review", "qa", "review"]);
const ROUND_NAME = /^(spec-review|spec|implement|qa|review)-(\d+)$/;

function parseStepName(name: string): { readonly step: string; readonly round: number | null } {
  const match = ROUND_NAME.exec(name);
  return match === null ? { step: name, round: null } : { step: match[1] ?? name, round: Number(match[2]) };
}

/**
 * FR-GUI-056: one row per agent session of the task in a run, in the order they started, then the merge. A review
 * round with a later round of the same step sent the work back; the last session of a blocked task failed.
 */
export function runSteps(
  sessions: readonly AgentSession[],
  task: { readonly status: TaskRunStatus; readonly costUsd: number },
  isRunLive: boolean,
): StepsView {
  const own = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const named = own.map((session) => ({ session, ...parseStepName(session.step) }));
  const rows = named.map(({ session, step, round }, index): StepRow => {
    const isLast = index === named.length - 1;
    const hasLaterRound = named.slice(index + 1).some((later) => later.step === step);
    const status: StepStatus =
      session.endedAt === null
        ? isRunLive
          ? "running"
          : "failed"
        : session.exitCode !== 0 || (isLast && task.status === "blocked")
          ? "failed"
          : REVIEW_STEPS.has(step) && hasLaterRound
            ? "sent-back"
            : "passed";
    return {
      step,
      round,
      status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      costUsd: session.costUsd,
      sessionId: session.sessionId,
    };
  });
  const merge: StepRow = {
    step: "merge",
    round: null,
    status: task.status === "done" ? "passed" : "not-started",
    startedAt: null,
    endedAt: null,
    costUsd: null,
    sessionId: null,
  };
  return { source: "run", rows: [...rows, merge], costUsd: task.costUsd };
}

const WORKFLOW_STEPS = STEPS.filter((step) => step !== "done");

function row(step: string, status: StepStatus, round: number | null = null, endedAt: string | null = null): StepRow {
  return { step, round, status, startedAt: null, endedAt, costUsd: null, sessionId: null };
}

/**
 * FR-GUI-056: a change's steps from its workflow state. Steps before the current one passed or were skipped; QA
 * and code review list each round with its result, and the current one has a round in progress.
 */
export function workflowSteps(state: WorkflowState): StepsView {
  const current = state.step === "done" ? WORKFLOW_STEPS.length : WORKFLOW_STEPS.indexOf(state.step);
  const skipped = new Set<string>(state.skips.map((skip) => skip.step));
  const isWaiting = state.pending !== null && state.pending.answer === null;
  const nowStatus: StepStatus =
    state.status === "blocked" ? "failed" : isWaiting ? "waiting" : state.status === "done" ? "passed" : "running";
  const rows = WORKFLOW_STEPS.flatMap((step, index): StepRow[] => {
    const plain: StepStatus = skipped.has(step)
      ? "skipped"
      : index < current
        ? "passed"
        : index === current
          ? nowStatus
          : "not-started";
    const rounds =
      step === "qa"
        ? state.qaRuns.map((run, at) => row(step, run.passed ? "passed" : "failed", at + 1, run.at))
        : step === "review"
          ? state.reviews.map((review, at) =>
              row(step, review.verdict === "approve" ? "passed" : "sent-back", at + 1, review.at),
            )
          : [];
    if (rounds.length === 0) return [row(step, plain)];
    return index === current && plain !== "skipped" ? [...rounds, row(step, plain, rounds.length + 1)] : rounds;
  });
  return { source: "workflow", rows, costUsd: state.costUsd };
}
