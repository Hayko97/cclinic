import { describe, expect, it } from "vitest";
import {
  answerPending,
  applyAnswer,
  beginChange,
  checkAdvance,
  checkSkip,
  endStoppedChange,
  enterStep,
  gateQuestion,
  qaRunsUsed,
  recordPreview,
  recordQaRun,
  recordReview,
  resetToSpec,
  resumeChange,
  skipStep,
  stateKey,
  summarizeState,
  workflowStateSchema,
  type Outcome,
  type Step,
  type WorkflowState,
} from "./workflow.js";

const NOW = "2026-11-10T09:00:00.000Z";
const NO_NOTES = { approver: "user", notes: null, now: NOW } as const;
const FINDINGS = { blocking: 0, shouldFix: 1, nit: 0 };

function begin(changeType: "feature" | "bug" | "no-behaviour" = "feature", taskId?: number): WorkflowState {
  return beginChange(
    { changeType, spec: "user-login", ...(taskId === undefined ? {} : { taskId }) },
    { key: stateKey(taskId ?? null, "main"), approverMode: "user", now: NOW },
  );
}

function stateOf(outcome: Outcome): WorkflowState {
  if ("refusal" in outcome) throw new Error(`Unexpected refusal: ${outcome.refusal}`);
  return outcome.state;
}

function refusalOf(outcome: Outcome | { readonly refusal: string } | object): string {
  if (!("refusal" in outcome)) throw new Error("Expected a refusal");
  return (outcome as { refusal: string }).refusal;
}

function advance(state: WorkflowState, to: Step): WorkflowState {
  const check = checkAdvance(state, to, []);
  if ("refusal" in check) throw new Error(check.refusal);
  return stateOf(enterStep(state, to, NOW));
}

/** A change at `qa`, its spec approved. */
function atQa(): WorkflowState {
  return advance(stateOf(applyAnswer(begin(), "G1", "approve", NO_NOTES)), "qa");
}

/** Reports a failing QA run, then, unless that stopped the change, takes the fix back to `qa`. */
function failQa(state: WorkflowState, failures: string[] = []): WorkflowState {
  const failed = stateOf(recordQaRun(state, { passed: false, failures }, NOW));
  return failed.status === "stopped" ? failed : advance(failed, "qa");
}

function atReview(): WorkflowState {
  return advance(stateOf(recordQaRun(atQa(), { passed: true, failures: [] }, NOW)), "review");
}

describe("workflow", () => {
  it("TC-MCP-013: starts a feature at the spec and a no-behaviour change at implement, recording the skip", () => {
    expect(begin().step).toBe("spec");
    const refactor = begin("no-behaviour");
    expect(refactor.step).toBe("implement");
    expect(refactor.skips.map((skip) => skip.step)).toEqual(["spec"]);
  });

  it("TC-MCP-022: refuses an out-of-order step and an unanswered gate", () => {
    expect(refusalOf(checkAdvance(begin(), "qa", []))).toMatch(/next step is "implement"/);
    expect(checkAdvance(begin(), "implement", [])).toEqual({ gate: "G1", isAnswerNeeded: true });
  });

  it("TC-MCP-023: refuses G1 while a spec file is missing", () => {
    expect(refusalOf(checkAdvance(begin(), "implement", ["validation.md"]))).toMatch(/missing validation\.md/);
  });

  it("TC-MCP-024: refine keeps the spec step, review-doc limits the next answers, approve moves on", () => {
    const refined = applyAnswer(begin(), "G1", "refine", { ...NO_NOTES, notes: "add an error case" });
    expect(stateOf(refined).step).toBe("spec");
    expect("message" in refined && refined.message).toMatch(/add an error case/);
    const reviewDoc = stateOf(applyAnswer(begin(), "G1", "review-doc", NO_NOTES));
    expect(gateQuestion(reviewDoc, "G1").answers).toEqual(["approve", "refine"]);
    expect(refusalOf(applyAnswer(reviewDoc, "G1", "review-doc", NO_NOTES))).toMatch(/isn't an answer/);
    expect(stateOf(applyAnswer(reviewDoc, "G1", "approve", NO_NOTES)).step).toBe("implement");
  });

  it("TC-MCP-025: needs a passing QA run to reach the review", () => {
    const failed = stateOf(recordQaRun(atQa(), { passed: false, failures: ["TC-X-1"] }, NOW));
    expect(refusalOf(checkAdvance(failed, "review", []))).toMatch(/next step is "qa"/);
    const passed = stateOf(recordQaRun(advance(failed, "qa"), { passed: true, failures: [] }, NOW));
    expect(advance(passed, "review").step).toBe("review");
    expect(qaRunsUsed(passed)).toBe(2);
  });

  it("TC-MCP-025: refuses the review after a fix until a QA run passes", () => {
    const fixed = advance(stateOf(recordQaRun(atQa(), { passed: false, failures: [] }, NOW)), "qa");
    expect(refusalOf(checkAdvance(fixed, "review", []))).toMatch(/G2 QA passed/);
  });

  it("TC-MCP-079: a failed QA run with no failures listed still asks for a fix", () => {
    const outcome = recordQaRun(atQa(), { passed: false, failures: [] }, NOW);
    expect("message" in outcome && outcome.message).not.toMatch(/Failures:/);
    expect("message" in outcome && outcome.message).toMatch(/write-code.*"qa"/);
  });

  it("TC-MCP-026: stops after the 3rd failing QA run and refuses more", () => {
    let state = atQa();
    for (let run = 0; run < 3; run += 1) state = failQa(state);
    expect(state.status).toBe("stopped");
    expect(refusalOf(checkAdvance(state, "review", []))).toMatch(/stopped/);
    expect(refusalOf(recordQaRun(state, { passed: true, failures: [] }, NOW))).toMatch(/stopped/);
  });

  it("TC-MCP-077: a failed QA run goes back to the developer, without asking the user", () => {
    const previewed = { ...atQa(), preview: { isRunning: true, detail: "http://localhost", at: NOW } };
    const outcome = recordQaRun(previewed, { passed: false, failures: ["TC-X-001 fails"] }, NOW);
    const failed = stateOf(outcome);
    expect("message" in outcome && outcome.message).toMatch(
      /TC-X-001 fails.*code, the test or the spec.*without asking the user.*"qa".*workflow_reset/,
    );
    expect(failed).toMatchObject({ step: "implement", status: "open", pending: null, preview: null });
    expect(refusalOf(recordQaRun(failed, { passed: true, failures: [] }, NOW))).toMatch(
      /only accepted at the "qa" step/,
    );
    expect(checkAdvance(failed, "qa", [])).toEqual({ gate: undefined, isAnswerNeeded: false });
  });

  it("TC-MCP-078: a 2nd failing QA run still goes back to the developer, not a stop", () => {
    const failed = stateOf(recordQaRun(failQa(atQa()), { passed: false, failures: [] }, NOW));
    expect(failed).toMatchObject({ step: "implement", status: "open" });
    expect(qaRunsUsed(failed)).toBe(2);
  });

  it("TC-MCP-027: resuming a stopped change starts the QA count again", () => {
    let state = atQa();
    for (let run = 0; run < 3; run += 1) state = failQa(state);
    const resumed = stateOf(resumeChange(state, NOW));
    expect(resumed.status).toBe("open");
    expect(qaRunsUsed(resumed)).toBe(0);
    expect(refusalOf(resumeChange(resumed, NOW))).toMatch(/Only a stopped change/);
  });

  it("TC-MCP-028: an approving review opens the preview", () => {
    const approved = stateOf(recordReview(atReview(), { verdict: "approve", findings: FINDINGS }, NOW));
    expect(advance(approved, "preview").step).toBe("preview");
  });

  it("TC-MCP-029: a changes review goes back to implement and needs QA and a review again", () => {
    const changed = stateOf(recordReview(atReview(), { verdict: "changes", findings: FINDINGS }, NOW));
    expect(changed.step).toBe("implement");
    expect(refusalOf(checkAdvance(changed, "preview", []))).toMatch(/Out of order/);
    const retested = stateOf(recordQaRun(advance(changed, "qa"), { passed: true, failures: [] }, NOW));
    const reviewed = stateOf(
      recordReview(advance(retested, "review"), { verdict: "approve", findings: FINDINGS }, NOW),
    );
    expect(advance(reviewed, "preview").step).toBe("preview");
  });

  it("TC-MCP-030: stops after the 3rd review with changes", () => {
    let state = atQa();
    for (let round = 0; round < 3; round += 1) {
      state = advance(stateOf(recordQaRun(state, { passed: true, failures: [] }, NOW)), "review");
      state = stateOf(recordReview(state, { verdict: "changes", findings: FINDINGS }, NOW));
      if (round < 2) state = advance(state, "qa");
    }
    expect(state.status).toBe("stopped");
    expect(state.reason).toMatch(/3 code reviews/);
  });

  it("TC-MCP-031: stops when review fixes would need a 4th QA run", () => {
    let state = atQa();
    state = failQa(failQa(state));
    state = advance(stateOf(recordQaRun(state, { passed: true, failures: [] }, NOW)), "review");
    state = stateOf(recordReview(state, { verdict: "changes", findings: FINDINGS }, NOW));
    expect(state.status).toBe("stopped");
    expect(state.reason).toMatch(/fixes need QA/);
  });

  it("TC-MCP-032: records the preview, which opens the approval step", () => {
    const approved = stateOf(recordReview(atReview(), { verdict: "approve", findings: FINDINGS }, NOW));
    const previewed = stateOf(recordPreview(advance(approved, "preview"), true, "http://app.localhost:3000", NOW));
    expect(previewed.preview?.detail).toBe("http://app.localhost:3000");
    expect(advance(previewed, "approval").step).toBe("approval");
  });

  it("TC-MCP-034: refuses the approval step before the preview was tried", () => {
    const approved = stateOf(recordReview(atReview(), { verdict: "approve", findings: FINDINGS }, NOW));
    expect(refusalOf(checkAdvance(advance(approved, "preview"), "approval", []))).toMatch(/G4 preview tried/);
  });

  it("TC-MCP-035: request changes goes back to implement and starts the counts again", () => {
    const atApproval = { ...atReview(), step: "approval" as const };
    const outcome = applyAnswer(atApproval, "G5", "request changes", { ...NO_NOTES, notes: "rename the button" });
    const state = stateOf(outcome);
    expect(state.step).toBe("implement");
    expect(qaRunsUsed(state)).toBe(0);
    expect("message" in outcome && outcome.message).toMatch(/rename the button/);
  });

  it("TC-MCP-036: approving the implementation moves to the commit step", () => {
    expect(stateOf(applyAnswer({ ...atReview(), step: "approval" }, "G5", "approve", NO_NOTES)).step).toBe("commit");
  });

  it("TC-MCP-037: yes and no at G6 both end the change, recording whether it was committed", () => {
    const atCommit = { ...atReview(), step: "commit" as const };
    const yes = applyAnswer(atCommit, "G6", "yes", NO_NOTES);
    expect(stateOf(yes)).toMatchObject({ status: "done", isCommitted: true });
    expect("message" in yes && yes.message).toMatch(/\.luseen\/reviews\//);
    expect(stateOf(applyAnswer(atCommit, "G6", "no", NO_NOTES))).toMatchObject({ status: "done", isCommitted: false });
  });

  it("TC-MCP-038: a confirmed skip of the review passes G3 without a review", () => {
    const skipped = stateOf(skipStep(atQa(), "review", "user asked", NOW));
    const atReviewStep = advance(stateOf(recordQaRun(skipped, { passed: true, failures: [] }, NOW)), "review");
    expect(advance(atReviewStep, "preview").step).toBe("preview");
    expect(checkSkip(atReviewStep, "qa")).toMatch(/already passed/);
  });

  it("TC-MCP-040: a reset goes back to the spec and needs G1 again", () => {
    const reset = stateOf(resetToSpec(atReview(), "the spec missed a case", NOW));
    expect(reset.step).toBe("spec");
    expect(reset.resets.map((entry) => entry.reason)).toEqual(["the spec missed a case"]);
    expect(checkAdvance(reset, "implement", [])).toEqual({ gate: "G1", isAnswerNeeded: true });
  });

  it("TC-MCP-041: refuses a reset at the spec step", () => {
    expect(refusalOf(resetToSpec(begin(), "why", NOW))).toMatch(/can't go back/);
  });

  it("TC-MCP-012: summarizes the step, counts and decisions", () => {
    const failed = stateOf(recordQaRun(atQa(), { passed: false, failures: ["TC-X-1"] }, NOW));
    expect(summarizeState(failed)).toMatchObject({
      step: "implement",
      qaRunsUsed: 1,
      codeReviewsUsed: 0,
      approverMode: "user",
      decisions: [{ gate: "G1", answer: "approve", approver: "user", at: NOW }],
    });
  });

  it("TC-MCP-057: keys a change by task, or by a branch name made safe for a file name", () => {
    expect(stateKey(7, "main")).toBe("task-7");
    expect(stateKey(null, "feature/fix typo")).toBe("branch-feature-fix-typo");
  });

  it("TC-MCP-046: records an answer to a waiting question, and refuses one that isn't offered", () => {
    const waiting = {
      ...begin(),
      pending: {
        kind: "gate" as const,
        gate: "G1" as const,
        step: null,
        reason: null,
        question: "Approve?",
        answers: ["approve", "refine"],
        answer: null,
        notes: null,
      },
    };
    expect(stateOf(answerPending(waiting, "approve", null, NOW)).pending?.answer).toBe("approve");
    expect(refusalOf(answerPending(waiting, "maybe", null, NOW))).toMatch(/isn't one of the answers/);
    expect(refusalOf(answerPending(begin(), "approve", null, NOW))).toMatch(/No question/);
  });

  it("parses its own saved state, and refuses a damaged one", () => {
    expect(workflowStateSchema.parse(JSON.parse(JSON.stringify(atReview())))).toEqual(atReview());
    expect(workflowStateSchema.safeParse({ ...atReview(), step: "nowhere" }).success).toBe(false);
  });
});

describe("workflow edge cases", () => {
  it("TC-MCP-022: refuses every step for a blocked or done change, and past the last step", () => {
    const blocked = { ...begin(), status: "blocked" as const, reason: "no budget" };
    expect(refusalOf(checkAdvance(blocked, "implement", []))).toMatch(/blocked: no budget/);
    const done = { ...begin(), step: "done" as const, status: "done" as const };
    expect(refusalOf(checkAdvance(done, "implement", []))).toMatch(/done/);
    expect(refusalOf(checkAdvance({ ...done, status: "open" }, "implement", []))).toMatch(/next step is "none"/);
    expect(refusalOf(recordQaRun(done, { passed: true, failures: [] }, NOW))).toMatch(/done/);
    expect(checkSkip(done, "review")).toMatch(/done/);
    expect(refusalOf(resetToSpec(done, "why", NOW))).toMatch(/done/);
  });

  it("TC-MCP-028: refuses the preview step until a review approves", () => {
    expect(refusalOf(checkAdvance(atReview(), "preview", []))).toMatch(/G3 review approved/);
    expect(refusalOf(recordReview(atQa(), { verdict: "approve", findings: FINDINGS }, NOW))).toMatch(
      /only accepted at the "review" step/,
    );
  });

  it("TC-MCP-033: a preview that couldn't start still opens the approval step", () => {
    const approved = stateOf(recordReview(atReview(), { verdict: "approve", findings: FINDINGS }, NOW));
    const outcome = recordPreview(advance(approved, "preview"), false, "port in use", NOW);
    expect("message" in outcome && outcome.message).toMatch(/couldn't start/);
    expect(refusalOf(recordPreview(atQa(), true, "x", NOW))).toMatch(/only accepted at the "preview" step/);
  });

  it("TC-MCP-037: entering done ends the change", () => {
    expect(stateOf(enterStep({ ...atReview(), step: "commit" }, "done", NOW)).status).toBe("done");
  });

  it("TC-MCP-012: names the task in its questions and shows a waiting question in the status", () => {
    const withTask = begin("bug", 4);
    expect(withTask.taskId).toBe(4);
    expect(gateQuestion(withTask, "G5").question).toContain("task #4");
    expect(gateQuestion(withTask, "G6").answers).toEqual(["yes", "no"]);
    const waiting = {
      ...withTask,
      pending: {
        kind: "gate" as const,
        gate: "G1" as const,
        step: null,
        reason: null,
        question: "Approve?",
        answers: ["approve"],
        answer: null,
        notes: null,
      },
    };
    expect(summarizeState(waiting).waitingQuestion).toBe("Approve?");
  });
});

describe("ending a stopped change", () => {
  it("TC-MCP-065: ends a stopped change with nothing committed, and refuses an open one", () => {
    let state = atQa();
    for (let run = 0; run < 3; run += 1) state = failQa(state);
    expect(stateOf(endStoppedChange(state, NOW))).toMatchObject({
      status: "done",
      isCommitted: false,
      reason: "The user chose not to continue.",
    });
    expect(refusalOf(endStoppedChange(atQa(), NOW))).toMatch(/Only a stopped change/);
  });
});
