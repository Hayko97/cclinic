import { describe, expect, it } from "vitest";
import {
  decideOutcome,
  buildDeveloperPrompt,
  buildImplementationReviewPrompt,
  buildQaPrompt,
  buildSpecReviewPrompt,
  commitMessage,
  createRunId,
  findRunCycle,
  notificationText,
  planRun,
  readyTasks,
  renderPlan,
  renderReport,
  runOrder,
  selectRoadmapTasks,
  type RunState,
  type TaskContext,
  type TaskRun,
} from "./automation.js";
import { buildRoadmap, type Roadmap, type Task, type TaskStatus } from "./tasks.js";

const TIME = "2026-11-09T08:05:03.000Z";
const task = (
  id: number,
  dependsOn: number[] = [],
  status: TaskStatus = "open",
  milestoneId: number | null = 1,
): Task => ({
  id,
  title: `T${id}`,
  description: null,
  status,
  milestoneId,
  spec: null,
  dependsOn,
  createdAt: TIME,
  updatedAt: TIME,
});

const run = (taskId: number, dependsOn: number[] = [], status: TaskRun["status"] = "waiting"): TaskRun => ({
  taskId,
  title: `T${taskId}`,
  dependsOn,
  status,
  branch: null,
  rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
  costUsd: 0,
  reason: null,
  requirementIds: [],
});

const context: TaskContext = {
  task: { ...task(7), title: "Lock accounts", description: "After 5 failures", spec: "auth" },
  roadmapTitle: "Launch",
  roadmapGoal: "First release",
  milestoneTitle: "Security",
  milestoneGoal: "Stop guessing",
  docsPath: ".cclinic/sdd",
};

describe("run IDs and branches", () => {
  it("TC-AUTO-015: the run ID is the UTC time, with a suffix when it's taken", () => {
    const now = new Date(TIME);
    expect(createRunId(now, () => false)).toBe("20261109-080503");
    const taken = new Set(["20261109-080503"]);
    expect(createRunId(now, (id) => taken.has(id))).toBe("20261109-080503-2");
    taken.add("20261109-080503-2");
    expect(createRunId(now, (id) => taken.has(id))).toBe("20261109-080503-3");
  });
});

describe("choosing and ordering tasks", () => {
  const roadmap = (tasks: Task[]): Roadmap => ({
    id: 1,
    title: "R",
    goal: null,
    createdAt: TIME,
    status: "planned",
    milestones: [{ id: 1, roadmapId: 1, title: "M", goal: null, position: 1, createdAt: TIME, tasks }],
  });

  it("TC-AUTO-001: open and blocked tasks run; done ones don't; in-progress ones are left alone", () => {
    const { selected, inProgress } = selectRoadmapTasks(
      roadmap([task(1), task(2, [], "blocked"), task(3, [], "done"), task(4, [], "in-progress")]),
    );
    expect(selected.map((item) => item.id)).toEqual([1, 2]);
    expect(inProgress.map((item) => item.id)).toEqual([4]);
  });

  it("TC-AUTO-012: tasks follow milestone position, not task ID", () => {
    const record = { id: 1, title: "R", goal: null, createdAt: TIME };
    const milestones = [
      { id: 1, roadmapId: 1, title: "Later", goal: null, position: 2, createdAt: TIME },
      { id: 2, roadmapId: 1, title: "First", goal: null, position: 1, createdAt: TIME },
    ];
    const { selected } = selectRoadmapTasks(
      buildRoadmap(record, milestones, [task(1, [], "open", 1), task(5, [], "open", 2)]),
    );
    expect(selected.map((item) => item.id)).toEqual([5, 1]);
    expect(
      readyTasks(
        selected.map((item) => run(item.id)),
        new Set(),
        1,
      ).map((item) => item.taskId),
    ).toEqual([5]);
  });

  it("TC-AUTO-005: a cycle through the selected tasks is found", () => {
    const tasks = [task(1, [2]), task(2, [3]), task(3, [1])];
    expect(findRunCycle([tasks[0] as Task], tasks)).toEqual([1, 2, 3]);
    expect(findRunCycle([task(1, [2])], [task(1, [2]), task(2)])).toBeUndefined();
  });

  it("TC-AUTO-006: a dependency outside the run blocks the task and its dependants", () => {
    const all = [task(1), task(2, [1]), task(3, [2]), task(4), task(5, [6]), task(6, [], "done")];
    const plan = planRun([all[1], all[2], all[3], all[4]] as Task[], all);
    expect([...plan.blockedBefore.keys()]).toEqual([2, 3]);
    expect(plan.blockedBefore.get(2)).toContain("task #1, which is open");
    expect(plan.blockedBefore.get(3)).toContain("task #2");
    expect(plan.runnable.map((item) => item.id)).toEqual([4, 5]);
  });

  it("TC-AUTO-008: run order puts dependencies first, and otherwise keeps roadmap order", () => {
    expect(runOrder([task(1, [3]), task(2), task(3)]).map((item) => item.id)).toEqual([2, 3, 1]);
  });

  it("TC-AUTO-009, TC-AUTO-011: only tasks whose dependencies are done start, up to the free slots", () => {
    const runs = [run(1), run(2, [1]), run(3), run(4), run(5, [9])];
    expect(readyTasks(runs, new Set(), 2).map((item) => item.taskId)).toEqual([1, 3]);
    expect(readyTasks(runs, new Set([1, 9]), 10).map((item) => item.taskId)).toEqual([1, 2, 3, 4, 5]);
    expect(readyTasks(runs, new Set(), 0)).toEqual([]);
  });
});

describe("agent prompts", () => {
  it("TC-AUTO-023: the developer prompt names the task and spec, and the automated-mode rules", () => {
    const prompt = buildDeveloperPrompt(context, { kind: "spec", feedback: null });
    for (const part of [
      "Task #7: Lock accounts",
      "Spec: auth",
      "After 5 failures",
      "automated mode",
      "AGENTS.md",
      "skills",
      "The PM agent gives every approval",
      "never wait for a human",
      "Don't commit, push or run git",
      ".cclinic/tasks.db",
      "refine-spec",
    ]) {
      expect(prompt, part).toContain(part);
    }
    expect(
      buildDeveloperPrompt({ ...context, task: { ...context.task, spec: null } }, { kind: "spec", feedback: null }),
    ).toContain("create-spec");
  });

  it("TC-AUTO-024: feedback and failures reach the developer", () => {
    expect(buildDeveloperPrompt(context, { kind: "spec", feedback: "add an error case" })).toContain(
      "add an error case",
    );
    const fix = buildDeveloperPrompt(context, {
      kind: "fix-qa",
      qa: { result: "fail", failures: [{ testCase: "TC-AUTH-002", output: "expected 401" }], summary: "1 failed" },
    });
    expect(fix).toContain("TC-AUTH-002: expected 401");
    expect(buildDeveloperPrompt(context, { kind: "implement" })).toContain("implement-spec");
    expect(buildDeveloperPrompt(context, { kind: "fix-review", feedback: "rename it" })).toContain("rename it");
  });

  it("TC-AUTO-019, TC-AUTO-021, TC-AUTO-022: PM and QA prompts carry what they review", () => {
    const specReview = buildSpecReviewPrompt(context, "+ FR-AUTH-009");
    for (const part of [
      "Lock accounts",
      "After 5 failures",
      "Stop guessing",
      "First release",
      "+ FR-AUTH-009",
      '"approve" or "refine"',
    ]) {
      expect(specReview, part).toContain(part);
    }
    expect(buildSpecReviewPrompt(context, " ")).toContain("(no change to the spec)");
    const qa = buildQaPrompt(context);
    for (const part of ["test-spec", "end-to-end", "`auth` spec", "didn't write this change"])
      expect(qa, part).toContain(part);
    const review = buildImplementationReviewPrompt(context, "+code", {
      result: "pass",
      failures: [],
      summary: "all good",
    });
    for (const part of ["+code", "all good", '"approve" or "changes"', "requirementIds"])
      expect(review, part).toContain(part);
    expect(
      buildImplementationReviewPrompt(context, "x".repeat(200_001), { result: "pass", failures: [], summary: "" }),
    ).toContain("The diff was cut");
  });
});

describe("commits, report and notification", () => {
  it("TC-AUTO-018: an approved commit starts with the task and lists requirements; unfinished work is WIP", () => {
    expect(commitMessage({ id: 1, title: "Lock" }, ["FR-AUTH-001"], false)).toBe(
      "#1 Lock\n\nRequirements: FR-AUTH-001",
    );
    expect(commitMessage({ id: 1, title: "Lock" }, [], true)).toMatch(/^#1 Lock \(WIP\)/);
  });

  const state: RunState = {
    runId: "20261109-080503",
    roadmapId: 1,
    roadmapTitle: "Launch",
    runBranch: "cclinic/auto/20261109-080503/run",
    startedAt: TIME,
    finishedAt: TIME,
    outcome: "partial",
    model: "haiku",
    effort: "low",
    timeoutMinutes: 30,
    limitResetsAt: null,
    spentUsd: 1.5,
    developers: 2,
    tasks: [
      { ...run(1, [], "done"), branch: "cclinic/auto/20261109-080503/task-1", costUsd: 1 },
      { ...run(2, [], "blocked"), reason: "Stopped after 3 QA runs. Last: TC-X-001", costUsd: 0.5 },
      { ...run(3, [2], "skipped"), reason: "Blocked by task #2" },
    ],
    skippedInProgress: [{ taskId: 4, title: "T4" }],
  };

  it("TC-AUTO-033: the report has the roadmap, branch, outcome, tasks, reasons and how to merge, and no dollars", () => {
    const report = renderReport(state);
    for (const part of [
      "Roadmap: #1 Launch",
      "`cclinic/auto/20261109-080503/run`",
      "Outcome: partial",
      "| #1 T1 | done | `cclinic/auto/20261109-080503/task-1` |",
      "Stopped after 3 QA runs. Last: TC-X-001",
      "git merge cclinic/auto/20261109-080503/run",
      "#4 T4",
    ]) {
      expect(report, part).toContain(part);
    }
    expect(report).not.toContain("$");
  });

  it("TC-AUTO-034: the notification names the roadmap, the outcome and the counts", () => {
    expect(notificationText(state)).toEqual({ title: "cclinic: Launch", message: "Run partial: 1 done, 2 blocked." });
  });

  it("TC-AUTO-008: the plan lists the roadmap, run order, dependencies, branch and developers, and no budget", () => {
    const plan = renderPlan({
      roadmap: { id: 1, title: "Launch" },
      runnable: [task(1), task(2, [1])],
      blockedBefore: new Map([[3, "Blocked by task #9"]]),
      inProgress: [task(4)],
      runBranch: "cclinic/auto/x",
      developers: 2,
    });
    expect(plan).not.toContain("$");
    for (const part of [
      "Roadmap #1: Launch",
      "Run branch: cclinic/auto/x",
      "Developers: 2",
      "#2 T2 (after #1)",
      "#3: Blocked by task #9",
      "#4 T4",
    ]) {
      expect(plan, part).toContain(part);
    }
    expect(plan.indexOf("#1 T1")).toBeLessThan(plan.indexOf("#2 T2"));
  });
});

describe("run outcome", () => {
  it("FR-AUTO-025: a limit reached with tasks left ends limit-reached; with every task done, the run is completed", () => {
    expect(decideOutcome([run(1, [], "done"), run(2, [], "open")], false, true)).toBe("limit-reached");
    expect(decideOutcome([run(1, [], "done"), run(2, [], "done")], false, true)).toBe("completed");
    expect(decideOutcome([run(1, [], "done"), run(2, [], "blocked")], false, false)).toBe("partial");
    expect(decideOutcome([run(1, [], "done")], true, true)).toBe("interrupted");
  });
});
