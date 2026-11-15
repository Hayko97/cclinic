/** The steps and gates of one change, as the MCP server runs them (spec: mcp-server). Pure: no I/O. */
import { z } from "zod";
import { REVIEWS_FOLDER } from "./constants/paths.js";
import { WORKFLOW_LIMITS, WORKFLOW_STATE_VERSION } from "./constants/workflow.js";
import { specNameSchema, TASK_LIMITS, textSchema } from "./tasks.js";

export const STEPS = ["spec", "implement", "qa", "review", "preview", "approval", "commit", "done"] as const;
export type Step = (typeof STEPS)[number];
export const CHANGE_TYPES = ["feature", "bug", "no-behaviour"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export const APPROVERS = ["user", "pm-agent"] as const;
export type Approver = (typeof APPROVERS)[number];
export const GATES = ["G1", "G2", "G3", "G4", "G5", "G6"] as const;
export type Gate = (typeof GATES)[number];
/** Steps whose gate the user may agree to skip (FR-MCP-026). Approvals and the commit are never skipped. */
export const SKIPPABLE_STEPS = ["spec", "qa", "review", "preview"] as const;
export type SkippableStep = (typeof SKIPPABLE_STEPS)[number];
export const REVIEW_VERDICTS = ["approve", "changes"] as const;
export const CHANGE_STATUSES = ["open", "stopped", "blocked", "done"] as const;

/** Gates that only an approver can pass, with the answers they accept (FR-MCP-018, FR-MCP-024, FR-MCP-025). */
export const GATE_ANSWERS = {
  G1: ["approve", "refine", "review-doc"],
  G5: ["approve", "request changes"],
  G6: ["yes", "no"],
} as const;
export type AskedGate = keyof typeof GATE_ANSWERS;
const ASKED_GATES = Object.keys(GATE_ANSWERS) as AskedGate[];
export const CONFIRM_ANSWERS = ["yes", "no"] as const;
/** Answers that carry the user's notes to the agent. */
const ANSWERS_WITH_NOTES: readonly string[] = ["refine", "request changes"];

/** The gate a change must pass to enter each step. */
const GATE_INTO: Readonly<Record<Step, Gate | undefined>> = {
  spec: undefined,
  implement: "G1",
  qa: undefined,
  review: "G2",
  preview: "G3",
  approval: "G4",
  commit: "G5",
  done: "G6",
};
const SKIPPED_GATE: Readonly<Record<SkippableStep, Gate>> = { spec: "G1", qa: "G2", review: "G3", preview: "G4" };
const GATE_TITLES: Readonly<Record<Gate, string>> = {
  G1: "G1 spec approved",
  G2: "G2 QA passed",
  G3: "G3 review approved",
  G4: "G4 preview tried",
  G5: "G5 change approved",
  G6: "G6 commit agreed",
};
/** Steps a wrong spec can be sent back from (FR-MCP-027). */
const RESETTABLE_STEPS: readonly Step[] = ["implement", "qa", "review", "preview", "approval"];

const reasonSchema = z.string().trim().min(1, "A reason is required.").max(TASK_LIMITS.text);
const taskIdSchema = z.number().int().positive();
const findingsSchema = z.strictObject({
  blocking: z.number().int().min(0),
  shouldFix: z.number().int().min(0),
  nit: z.number().int().min(0),
});

export const beginInputSchema = z.strictObject({
  changeType: z.enum(CHANGE_TYPES),
  spec: specNameSchema,
  taskId: taskIdSchema.optional(),
});
export const advanceInputSchema = z.strictObject({ to: z.enum(STEPS.slice(1) as [Step, ...Step[]]) });
export const skipInputSchema = z.strictObject({ step: z.enum(SKIPPABLE_STEPS), reason: reasonSchema });
export const resetInputSchema = z.strictObject({ reason: reasonSchema });
export const qaReportInputSchema = z.strictObject({
  passed: z.boolean(),
  failures: z.array(textSchema).default([]),
});
export const reviewReportInputSchema = z.strictObject({ verdict: z.enum(REVIEW_VERDICTS), findings: findingsSchema });
export const taskBlockInputSchema = z.strictObject({ id: taskIdSchema, reason: reasonSchema });
export const taskIdInputSchema = z.strictObject({ id: taskIdSchema });
export const tasksListInputSchema = z.strictObject({ includeDone: z.boolean().optional() });
export const autoStatusInputSchema = z.strictObject({
  runId: z
    .string()
    .regex(/^[\w-]+$/)
    .optional(),
});

const atSchema = z.string();
const pendingSchema = z.strictObject({
  kind: z.enum(["gate", "skip", "resume"]),
  gate: z.enum(ASKED_GATES as [AskedGate, ...AskedGate[]]).nullable(),
  step: z.enum(SKIPPABLE_STEPS).nullable(),
  reason: z.string().nullable(),
  question: z.string(),
  answers: z.array(z.string()),
  answer: z.string().nullable(),
  notes: z.string().nullable(),
});

/** The saved state of one change. Parsed when read, so a damaged file is refused rather than trusted. */
export const workflowStateSchema = z.strictObject({
  version: z.literal(WORKFLOW_STATE_VERSION),
  key: z.string(),
  taskId: taskIdSchema.nullable(),
  spec: z.string(),
  changeType: z.enum(CHANGE_TYPES),
  approverMode: z.enum(APPROVERS),
  step: z.enum(STEPS),
  status: z.enum(CHANGE_STATUSES),
  reason: z.string().nullable(),
  qaRuns: z.array(z.strictObject({ passed: z.boolean(), failures: z.array(z.string()), at: atSchema })),
  reviews: z.array(z.strictObject({ verdict: z.enum(REVIEW_VERDICTS), findings: findingsSchema, at: atSchema })),
  /** Runs before these indexes don't count toward the limits, after the user replied (FR-INSTR-027). */
  qaCountFrom: z.number().int().min(0),
  reviewCountFrom: z.number().int().min(0),
  /** Results before these indexes were for code that changed since, so no gate accepts them. */
  qaValidFrom: z.number().int().min(0),
  reviewValidFrom: z.number().int().min(0),
  preview: z.strictObject({ isRunning: z.boolean(), detail: z.string(), at: atSchema }).nullable(),
  decisions: z.array(
    z.strictObject({
      gate: z.enum(GATES),
      answer: z.string(),
      approver: z.enum(APPROVERS),
      notes: z.string().nullable(),
      at: atSchema,
    }),
  ),
  skips: z.array(z.strictObject({ step: z.enum(SKIPPABLE_STEPS), reason: z.string(), at: atSchema })),
  resets: z.array(z.strictObject({ reason: z.string(), at: atSchema })),
  blockReasons: z.array(z.strictObject({ taskId: taskIdSchema, reason: z.string(), at: atSchema })),
  isReviewDocWritten: z.boolean(),
  isCommitted: z.boolean().nullable(),
  pending: pendingSchema.nullable(),
  costUsd: z.number().min(0),
  /** FR-MCP-045: the Claude Code sessions that worked on this change. Older states have none. */
  sessions: z
    .array(
      z.strictObject({
        sessionId: z.string(),
        transcriptPath: z.string(),
        firstSeenAt: atSchema,
        lastSeenAt: atSchema,
      }),
    )
    .default([]),
  startedAt: atSchema,
  updatedAt: atSchema,
});
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type PendingQuestion = NonNullable<WorkflowState["pending"]>;
export type QaReport = z.output<typeof qaReportInputSchema>;
export type ReviewReport = z.output<typeof reviewReportInputSchema>;
/** The shape of every tool input schema, so callers outside core needn't import zod. */
export type InputSchema = z.ZodObject;

/** A step that changed the state, or a refusal that changed nothing. */
export type Outcome = { readonly state: WorkflowState; readonly message: string } | { readonly refusal: string };

export interface Question {
  readonly question: string;
  readonly answers: readonly string[];
}

/** FR-MCP-038: by task, or by branch when there's no task. Safe as a file name. */
export function stateKey(taskId: number | null, branch: string): string {
  return taskId === null ? `branch-${branch.replace(/[^\w.-]/g, "-")}` : `task-${taskId}`;
}

export function isOpenChange(state: WorkflowState): boolean {
  return state.status === "open" || state.status === "stopped";
}

/** The fields cclinic reads from Claude Code's `PostToolUse` hook input (FR-MCP-045). Others are ignored. */
export const hookInputSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
});

/** FR-MCP-045: adds a session once, and after that only moves its last-seen time. */
export function linkSession(
  state: WorkflowState,
  session: { readonly sessionId: string; readonly transcriptPath: string },
  now: string,
): WorkflowState {
  const isKnown = state.sessions.some((item) => item.sessionId === session.sessionId);
  return {
    ...state,
    sessions: isKnown
      ? state.sessions.map((item) => (item.sessionId === session.sessionId ? { ...item, lastSeenAt: now } : item))
      : [...state.sessions, { ...session, firstSeenAt: now, lastSeenAt: now }],
  };
}

/** FR-MCP-010: a feature or bug starts at the spec, a change with no new behaviour skips the spec gate. */
export function beginChange(
  input: z.output<typeof beginInputSchema>,
  context: { readonly key: string; readonly approverMode: Approver; readonly now: string },
): WorkflowState {
  const isBehaviourKept = input.changeType === "no-behaviour";
  return {
    version: WORKFLOW_STATE_VERSION,
    key: context.key,
    taskId: input.taskId ?? null,
    spec: input.spec,
    changeType: input.changeType,
    approverMode: context.approverMode,
    step: isBehaviourKept ? "implement" : "spec",
    status: "open",
    reason: null,
    qaRuns: [],
    reviews: [],
    qaCountFrom: 0,
    reviewCountFrom: 0,
    qaValidFrom: 0,
    reviewValidFrom: 0,
    preview: null,
    decisions: [],
    skips: isBehaviourKept ? [{ step: "spec", reason: "No behaviour change.", at: context.now }] : [],
    resets: [],
    blockReasons: [],
    isReviewDocWritten: false,
    isCommitted: null,
    pending: null,
    costUsd: 0,
    sessions: [],
    startedAt: context.now,
    updatedAt: context.now,
  };
}

export function qaRunsUsed(state: WorkflowState): number {
  return state.qaRuns.length - state.qaCountFrom;
}

export function codeReviewsUsed(state: WorkflowState): number {
  return state.reviews.length - state.reviewCountFrom;
}

function nextStep(step: Step): Step | undefined {
  return STEPS[STEPS.indexOf(step) + 1];
}

function isSkipped(state: WorkflowState, gate: Gate): boolean {
  return state.skips.some((skip) => SKIPPED_GATE[skip.step] === gate);
}

function closedReason(state: WorkflowState): string | undefined {
  if (state.status === "stopped")
    return `The change is stopped: ${state.reason ?? ""} Ask the user whether to continue with workflow_resume.`;
  if (state.status === "blocked") return `The change is blocked: ${state.reason ?? ""}`;
  if (state.status === "done") return "The change is done. Start a new one with workflow_begin.";
  return undefined;
}

export type AdvanceCheck =
  { readonly refusal: string } | { readonly gate: Gate | undefined; readonly isAnswerNeeded: boolean };

/** FR-MCP-017: only the next step, and only when its gate has passed or needs only the approver's answer. */
export function checkAdvance(state: WorkflowState, to: Step, missingSpecFiles: readonly string[]): AdvanceCheck {
  const closed = closedReason(state);
  if (closed !== undefined) return { refusal: closed };
  const expected = nextStep(state.step);
  if (to !== expected)
    return { refusal: `Out of order: the change is at "${state.step}", so the next step is "${expected ?? "none"}".` };
  const gate = GATE_INTO[to];
  if (gate === undefined || isSkipped(state, gate)) return { gate, isAnswerNeeded: false };
  const title = GATE_TITLES[gate];
  if (gate === "G1" && missingSpecFiles.length > 0)
    return { refusal: `${title}: the spec is missing ${missingSpecFiles.join(", ")}.` };
  if (gate === "G2" && latestSince(state.qaRuns, state.qaValidFrom)?.passed !== true)
    return { refusal: `${title}: there's no passing QA run yet. Report each QA run with qa_report.` };
  if (gate === "G3" && latestSince(state.reviews, state.reviewValidFrom)?.verdict !== "approve")
    return { refusal: `${title}: the latest code review hasn't approved the change. Report it with review_report.` };
  if (gate === "G4" && state.preview === null)
    return { refusal: `${title}: start the preview with preview_start first.` };
  return { gate, isAnswerNeeded: gate in GATE_ANSWERS };
}

function latestSince<T>(items: readonly T[], from: number): T | undefined {
  return items.length > from ? items.at(-1) : undefined;
}

function touch(state: WorkflowState, now: string): WorkflowState {
  return { ...state, updatedAt: now };
}

/** Moves into a step whose gate has passed. */
export function enterStep(state: WorkflowState, to: Step, now: string): Outcome {
  const entered = touch({ ...state, step: to, status: to === "done" ? "done" : state.status }, now);
  return { state: entered, message: `The change is now at "${to}".` };
}

export function gateQuestion(state: WorkflowState, gate: AskedGate): Question {
  const answers: readonly string[] =
    gate === "G1" && state.isReviewDocWritten ? ["approve", "refine"] : GATE_ANSWERS[gate];
  const subject = state.taskId === null ? `spec "${state.spec}"` : `task #${state.taskId} (spec "${state.spec}")`;
  const question = {
    G1: `Approve the spec change for ${subject}?`,
    G5: `Approve the implementation of ${subject}?`,
    G6: `Commit this change to ${subject}?`,
  }[gate];
  return { question, answers };
}

export function isNotesAnswer(answer: string): boolean {
  return ANSWERS_WITH_NOTES.includes(answer);
}

function restartCounts(state: WorkflowState): WorkflowState {
  return { ...state, qaCountFrom: state.qaRuns.length, reviewCountFrom: state.reviews.length };
}

/** The code is about to change, so earlier QA runs, reviews and the preview no longer count (FR-MCP-021, FR-MCP-024). */
function startRework(state: WorkflowState): WorkflowState {
  return { ...state, qaValidFrom: state.qaRuns.length, reviewValidFrom: state.reviews.length, preview: null };
}

/** Applies the approver's answer at G1, G5 or G6 (FR-MCP-018, FR-MCP-024, FR-MCP-025, FR-MCP-030). */
export function applyAnswer(
  state: WorkflowState,
  gate: AskedGate,
  answer: string,
  context: { readonly approver: Approver; readonly notes: string | null; readonly now: string },
): Outcome {
  if (!gateQuestion(state, gate).answers.includes(answer))
    return { refusal: `"${answer}" isn't an answer to ${GATE_TITLES[gate]}.` };
  const decided = touch(
    {
      ...state,
      pending: null,
      decisions: [
        ...state.decisions,
        { gate, answer, approver: context.approver, notes: context.notes, at: context.now },
      ],
    },
    context.now,
  );
  const notes = context.notes === null ? "" : ` Their notes: ${context.notes}`;
  switch (`${gate}:${answer}`) {
    case "G1:approve":
      return {
        state: startRework(restartCounts({ ...decided, step: "implement", isReviewDocWritten: false })),
        message: "The spec is approved. Implement it.",
      };
    case "G1:refine":
      return { state: decided, message: `Refine the spec, then call workflow_advance again.${notes}` };
    case "G1:review-doc":
      return {
        state: { ...decided, isReviewDocWritten: true },
        message:
          "Write a review doc with the review-doc skill, give the user its path, then call workflow_advance again.",
      };
    case "G5:approve":
      return { state: { ...decided, step: "commit" }, message: "The implementation is approved." };
    case "G5:request changes":
      return {
        state: startRework(restartCounts({ ...decided, step: "implement" })),
        message: `Make the requested changes, then take them through QA and the review again.${notes}`,
      };
    case "G6:yes":
      return {
        state: { ...decided, step: "done", status: "done", isCommitted: true },
        message: `Commit the spec, code and tests of this change only, with the requirement IDs. Leave out ${REVIEWS_FOLDER}/ unless the user asks for it, and don't push.`,
      };
    default:
      return {
        state: { ...decided, step: "done", status: "done", isCommitted: false },
        message: "The change is done, with nothing committed.",
      };
  }
}

function requireOpenAt(state: WorkflowState, step: Step, tool: string): string | undefined {
  const closed = closedReason(state);
  if (closed !== undefined) return closed;
  if (state.step !== step)
    return `${tool} is only accepted at the "${step}" step, and the change is at "${state.step}".`;
  return undefined;
}

/** FR-MCP-019, FR-MCP-020: one QA run, and a stop after the last allowed run fails. */
export function recordQaRun(state: WorkflowState, report: QaReport, now: string): Outcome {
  const refusal = requireOpenAt(state, "qa", "qa_report");
  if (refusal !== undefined) return { refusal };
  const recorded = touch(
    { ...state, qaRuns: [...state.qaRuns, { passed: report.passed, failures: report.failures, at: now }] },
    now,
  );
  const used = qaRunsUsed(recorded);
  if (report.passed) return { state: recorded, message: `QA run ${used} passed. Advance to "review".` };
  if (used >= WORKFLOW_LIMITS.qaRuns)
    return stop(
      recorded,
      `QA failed ${used} times. Report what fails, show the preview if it can start, and don't ask for approval.`,
    );
  return { state: recorded, message: `QA run ${used} failed. Fix it and report the next run.` };
}

function stop(state: WorkflowState, reason: string): Outcome {
  return { state: { ...state, status: "stopped", reason }, message: `The change is stopped: ${reason}` };
}

/** FR-MCP-021, FR-MCP-022: a code review, back to the build after changes, and a stop at the limits. */
export function recordReview(state: WorkflowState, report: ReviewReport, now: string): Outcome {
  const refusal = requireOpenAt(state, "review", "review_report");
  if (refusal !== undefined) return { refusal };
  const recorded = touch(
    { ...state, reviews: [...state.reviews, { verdict: report.verdict, findings: report.findings, at: now }] },
    now,
  );
  if (report.verdict === "approve")
    return { state: recorded, message: 'The review approved the change. Advance to "preview".' };
  const reworked = startRework({ ...recorded, step: "implement" });
  if (codeReviewsUsed(reworked) >= WORKFLOW_LIMITS.codeReviews)
    return stop(
      reworked,
      `${WORKFLOW_LIMITS.codeReviews} code reviews still found changes. Report what's left, show the preview if it can start, and don't ask for approval.`,
    );
  if (qaRunsUsed(reworked) >= WORKFLOW_LIMITS.qaRuns)
    return stop(
      reworked,
      `The review's fixes need QA, and the ${WORKFLOW_LIMITS.qaRuns} QA runs are used. Report the findings and the untested fixes, and don't ask for approval.`,
    );
  return { state: reworked, message: "Fix the findings, then take the change through QA and the review again." };
}

/**
 * FR-MCP-023: a preview at the "preview" step is recorded for G4. A stopped change may still show one in its
 * report, but it isn't recorded, since the code may change before the change goes on.
 */
export function checkPreview(state: WorkflowState): { readonly refusal: string } | { readonly isRecorded: boolean } {
  if (state.status === "stopped") return { isRecorded: false };
  const refusal = requireOpenAt(state, "preview", "preview_start");
  return refusal === undefined ? { isRecorded: true } : { refusal };
}

/** FR-MCP-023: the preview's result, whatever it was. */
export function recordPreview(state: WorkflowState, isRunning: boolean, detail: string, now: string): Outcome {
  const refusal = requireOpenAt(state, "preview", "preview_start");
  if (refusal !== undefined) return { refusal };
  return {
    state: touch({ ...state, preview: { isRunning, detail, at: now } }, now),
    message: isRunning
      ? 'The preview is ready. Advance to "approval".'
      : 'The preview couldn\'t start. Tell the user why, then advance to "approval".',
  };
}

/** FR-MCP-026: only a step not yet passed can be skipped. */
export function checkSkip(state: WorkflowState, step: SkippableStep): string | undefined {
  const closed = closedReason(state);
  if (closed !== undefined) return closed;
  if (STEPS.indexOf(step) < STEPS.indexOf(state.step)) return `The "${step}" step is already passed.`;
  return undefined;
}

export function skipStep(state: WorkflowState, step: SkippableStep, reason: string, now: string): Outcome {
  return {
    state: touch({ ...state, pending: null, skips: [...state.skips, { step, reason, at: now }] }, now),
    message: `The user agreed to skip "${step}". Say which stage was skipped.`,
  };
}

/** FR-MCP-027: back to the spec, which then needs approving again. */
export function resetToSpec(state: WorkflowState, reason: string, now: string): Outcome {
  const closed = closedReason(state);
  if (closed !== undefined) return { refusal: closed };
  if (!RESETTABLE_STEPS.includes(state.step))
    return { refusal: `A change at "${state.step}" can't go back to the spec.` };
  return {
    state: touch(
      {
        ...state,
        step: "spec",
        isReviewDocWritten: false,
        pending: null,
        skips: state.skips.filter((skip) => skip.step !== "spec"),
        resets: [...state.resets, { reason, at: now }],
      },
      now,
    ),
    message: "The change is back at the spec. Correct it, then ask for approval again with workflow_advance.",
  };
}

/** FR-MCP-020: the user agreed to continue, so the counts start again. */
export function resumeChange(state: WorkflowState, now: string): Outcome {
  if (state.status !== "stopped") return { refusal: "Only a stopped change can be resumed." };
  return {
    state: touch(restartCounts({ ...state, status: "open", reason: null, pending: null }), now),
    message: `The user agreed to continue. The change is at "${state.step}".`,
  };
}

/** FR-MCP-043: the user chose not to continue, so the change ends, with nothing committed. */
export function endStoppedChange(state: WorkflowState, now: string): Outcome {
  if (state.status !== "stopped") return { refusal: "Only a stopped change can be ended this way." };
  return {
    state: touch(
      { ...state, status: "done", isCommitted: false, reason: "The user chose not to continue.", pending: null },
      now,
    ),
    message: "The user chose not to continue, so the change has ended with nothing committed. A new change can start.",
  };
}

export function recordBlockReason(state: WorkflowState, taskId: number, reason: string, now: string): WorkflowState {
  return touch({ ...state, blockReasons: [...state.blockReasons, { taskId, reason, at: now }] }, now);
}

export function withPending(state: WorkflowState, pending: PendingQuestion, now: string): WorkflowState {
  return touch({ ...state, pending }, now);
}

/** Whether `question` is still the one waiting for an answer, so an answer to it may be recorded (FR-GUI-038). */
export function isStillWaiting(state: WorkflowState | undefined, question: string): boolean {
  return state?.pending?.question === question && state.pending.answer === null;
}

/** Records the user's answer to a waiting question, from `cclinic approve` or the GUI (FR-MCP-029, FR-GUI-038). */
export function answerPending(state: WorkflowState, answer: string, notes: string | null, now: string): Outcome {
  if (state.pending === null) return { refusal: "No question is waiting." };
  if (!state.pending.answers.includes(answer)) return { refusal: `"${answer}" isn't one of the answers.` };
  return {
    state: touch({ ...state, pending: { ...state.pending, answer, notes } }, now),
    message: `Recorded "${answer}". The agent picks it up on its next call.`,
  };
}

/** What `workflow_status` returns (FR-MCP-009). */
export function summarizeState(state: WorkflowState) {
  return {
    step: state.step,
    status: state.status,
    reason: state.reason,
    taskId: state.taskId,
    spec: state.spec,
    changeType: state.changeType,
    approverMode: state.approverMode,
    qaRunsUsed: qaRunsUsed(state),
    codeReviewsUsed: codeReviewsUsed(state),
    preview: state.preview,
    decisions: state.decisions,
    skips: state.skips,
    waitingQuestion: state.pending === null ? null : state.pending.question,
  };
}
