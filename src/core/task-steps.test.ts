import { describe, expect, it } from "vitest";
import type { AgentSession, RunState } from "./automation.js";
import { allSessions, newestToolCall, type CanvasSources, type SessionActivity } from "./canvas.js";
import { runSteps, workflowSteps } from "./task-steps.js";
import { beginChange, stateKey, type WorkflowState } from "./workflow.js";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function session(step: string, started: number, ended: number | null, change: Partial<AgentSession> = {}) {
  const role: AgentSession["role"] = step.startsWith("qa")
    ? "qa"
    : step.startsWith("implement") || /^spec-\d/.test(step)
      ? "developer"
      : "pm";
  return {
    sessionId: `session-${step}`,
    taskId: 2,
    role,
    step,
    cwd: "/w",
    transcriptPath: `/home/.claude/projects/w/${step}.jsonl`,
    startedAt: minutesAgo(started),
    endedAt: ended === null ? null : minutesAgo(ended),
    exitCode: ended === null ? null : 0,
    costUsd: ended === null ? null : 0.1,
    ...change,
  } satisfies AgentSession;
}

const shape = (rows: readonly { step: string; round: number | null; status: string }[]) =>
  rows.map((row) => `${row.step} ${row.round ?? "-"} ${row.status}`);

describe("task steps", () => {
  it("TC-GUI-077: a task in a live run lists each round in order, with its result and times", () => {
    const sessions = [
      session("spec-1", 60, 55),
      session("spec-review-1", 55, 50),
      session("implement-1", 50, 40),
      session("qa-1", 40, 35),
      session("implement-2", 35, 25),
      session("qa-2", 25, 20),
      session("review-1", 20, null),
    ];
    const view = runSteps([...sessions].reverse(), { status: "running" }, true);

    expect(shape(view.rows)).toEqual([
      "spec 1 passed",
      "spec-review 1 passed",
      "implement 1 passed",
      "qa 1 sent-back",
      "implement 2 passed",
      "qa 2 passed",
      "review 1 running",
      "merge - not-started",
    ]);
    expect(view.rows[3]).toMatchObject({
      startedAt: minutesAgo(40),
      endedAt: minutesAgo(35),
      sessionId: "session-qa-1",
    });
    expect(view.rows[6]).toMatchObject({ endedAt: null });
    expect(JSON.stringify(view)).not.toContain("costUsd");
    expect(view).toMatchObject({ source: "run" });
  });

  it("TC-GUI-120: the last round of a blocked task, and an agent that exited non-zero, failed", () => {
    const blocked = runSteps(
      [session("qa-1", 30, 25), session("implement-2", 25, 20), session("qa-3", 20, 10)],
      { status: "blocked" },
      false,
    );
    expect(shape(blocked.rows).at(-2)).toBe("qa 3 failed");

    const crashed = runSteps(
      [session("spec-1", 30, 25), session("implement-1", 25, 20, { exitCode: 1 })],
      { status: "running" },
      true,
    );
    expect(shape(crashed.rows)[1]).toBe("implement 1 failed");
  });

  it("a session left open by a run that is no longer live failed, and a done task's merge passed", () => {
    expect(shape(runSteps([session("qa-1", 10, null)], { status: "open" }, false).rows)).toEqual([
      "qa 1 failed",
      "merge - not-started",
    ]);
    expect(shape(runSteps([session("review-1", 10, 5)], { status: "done" }, false).rows)).toEqual([
      "review 1 passed",
      "merge - passed",
    ]);
  });

  it("TC-GUI-121: a change's steps come from its workflow state", () => {
    const begun = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now: minutesAgo(60) },
    );
    const state: WorkflowState = {
      ...begun,
      step: "review",
      qaRuns: [
        { passed: false, failures: ["TC-1"], at: minutesAgo(40) },
        { passed: true, failures: [], at: minutesAgo(30) },
      ],
      reviews: [{ verdict: "changes", findings: { blocking: 1, shouldFix: 0, nit: 0 }, at: minutesAgo(20) }],
      skips: [{ step: "preview", reason: "nothing to run", at: minutesAgo(15) }],
      costUsd: 1.2,
    };
    const view = workflowSteps(state);

    expect(shape(view.rows)).toEqual([
      "spec - passed",
      "implement - passed",
      "qa 1 failed",
      "qa 2 passed",
      "review 1 sent-back",
      "review 2 running",
      "preview - skipped",
      "approval - not-started",
      "commit - not-started",
    ]);
    expect(view.rows[2]).toMatchObject({ endedAt: minutesAgo(40) });
    expect(view).toMatchObject({ source: "workflow" });
  });

  it("a change waiting for an answer, a blocked change and a finished one show it on the current step", () => {
    const begun = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now: minutesAgo(60) },
    );
    const pending = {
      kind: "gate" as const,
      gate: null,
      step: null,
      reason: null,
      question: "Approve the spec?",
      answers: ["approve"],
      answer: null,
      notes: null,
    };
    const waiting = workflowSteps({ ...begun, pending });
    expect(shape(waiting.rows)[0]).toBe("spec - waiting");
    const blocked = workflowSteps({ ...begun, step: "implement", status: "blocked" });
    expect(shape(blocked.rows)[1]).toBe("implement - failed");
    const done = workflowSteps({ ...begun, step: "done", status: "done" });
    expect(done.rows.every((row) => row.status === "passed")).toBe(true);
  });
});

describe("session activity", () => {
  const live: AgentSession = { ...session("qa-1", 10, null), taskId: 2 };
  const quiet: AgentSession = { ...session("review-1", 10, null), taskId: 3 };
  const state: RunState = {
    runId: "20261112-110000",
    roadmapId: 1,
    roadmapTitle: "Roadmap",
    runBranch: "cclinic/auto/x",
    startedAt: minutesAgo(30),
    finishedAt: null,
    outcome: null,
    model: "haiku",
    effort: "low",
    timeoutMinutes: 30,
    limitResetsAt: null,
    spentUsd: 3.4,
    developers: 1,
    tasks: [],
    skippedInProgress: [],
  };
  const sources = (activity: ReadonlyMap<string, SessionActivity>): CanvasSources => ({
    overview: { roadmaps: [], unassigned: [] },
    runs: [{ state, sessions: [live, quiet], isLive: true, pid: 4242 }],
    workflows: [],
    problems: [],
    activity,
  });

  it("TC-GUI-079: a transcript quiet for the stall time is marked, and each gives its newest tool call", () => {
    const tool = { name: "Bash", input: '{"command":"npm test"}' };
    const views = allSessions(
      sources(
        new Map([
          [quiet.sessionId, { modifiedAt: minutesAgo(6), currentTool: tool }],
          [live.sessionId, { modifiedAt: minutesAgo(1), currentTool: tool }],
        ]),
      ),
      NOW,
    );
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get(quiet.sessionId)).toMatchObject({ quietMinutes: 6, currentTool: tool });
    expect(byId.get(live.sessionId)).toMatchObject({ quietMinutes: null, currentTool: tool });
  });

  it("an ended session, or one with no transcript read, has no activity", () => {
    const ended = { ...live, endedAt: minutesAgo(1), exitCode: 0 };
    const views = allSessions(
      { runs: [{ state, sessions: [ended, quiet], isLive: true, pid: 4242 }], workflows: [], activity: new Map() },
      NOW,
    );
    expect(views.map((view) => [view.currentTool, view.quietMinutes])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("TC-GUI-079: the newest tool call is found, with its input cut to the short length", () => {
    const line = (input: unknown, name = "Bash") =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    });
    expect(newestToolCall([line({ file: "a" }, "Read"), line({ command: "x".repeat(200) }), result])).toEqual({
      name: "Bash",
      input: `{"command":"${"x".repeat(67)}…`,
    });
    expect(newestToolCall([result, "not json"])).toBeNull();
  });
});
