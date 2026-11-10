/** The automated run's decisions, with fake agents, Git and task list. Real Git is in automation.test.ts. */
import { describe, expect, it } from "vitest";
import {
  runAutomation,
  type AgentCall,
  type AgentReply,
  type AutomationPorts,
} from "../../src/application/automation.js";
import type { RunState, TaskRun } from "../../src/core/automation.js";
import { AgentCallError, CancelledError } from "../../src/core/errors.js";
import type { Task, TaskStatus } from "../../src/core/tasks.js";

const TIME = "2026-11-09T08:00:00.000Z";

type Stage = "spec" | "spec-review" | "implement" | "qa" | "review";

function stageOf(call: AgentCall): Stage {
  if (call.role === "qa") return "qa";
  if (call.role === "pm") return call.prompt.includes("reviewing a spec change") ? "spec-review" : "review";
  return call.prompt.includes("## Stage: spec") ? "spec" : "implement";
}

function taskOf(call: AgentCall): number {
  return Number(/Task #(\d+):/.exec(call.prompt)?.[1]);
}

type Responder = (call: AgentCall, count: number) => Partial<AgentReply> | Error | Promise<Partial<AgentReply> | Error>;

const DEFAULT_OUTPUT: Record<Stage, unknown> = {
  spec: null,
  "spec-review": { verdict: "approve", feedback: "" },
  implement: null,
  qa: { result: "pass", failures: [], summary: "ok" },
  review: { verdict: "approve", feedback: "", requirementIds: ["FR-X-001"] },
};

interface FakeOptions {
  readonly tasks: readonly Task[];
  readonly respond?: Partial<Record<Stage, Responder>>;
  readonly conflicts?: readonly number[];
  readonly cost?: number;
  readonly signal?: AbortSignal;
}

function fake(options: FakeOptions) {
  const tasks = new Map(options.tasks.map((task) => [task.id, task]));
  const calls: (AgentCall & { stage: Stage; task: number })[] = [];
  const statuses: [number, TaskStatus][] = [];
  const commits: { worktree: string; message: string }[] = [];
  const merged: string[] = [];
  const removed: string[] = [];
  const events: string[] = [];
  const counts = new Map<string, number>();
  let active = 0;
  let mostActive = 0;
  const states: RunState[] = [];
  const ports: AutomationPorts = {
    git: {
      createTaskWorktree: (branch) => Promise.resolve(`/worktrees/${branch}`),
      diff: (worktree, paths) =>
        Promise.resolve(`diff of ${worktree}${paths === undefined ? "" : ` in ${paths.join()}`}`),
      commitAll: (worktree, message) => {
        commits.push({ worktree, message });
        return Promise.resolve(true);
      },
      mergeIntoRun: (branch) => {
        const id = Number(branch.slice(branch.lastIndexOf("-") + 1));
        if (options.conflicts?.includes(id)) return Promise.resolve({ isMerged: false, conflicts: ["src/shared.ts"] });
        merged.push(branch);
        events.push(`merged ${id}`);
        return Promise.resolve({ isMerged: true });
      },
      removeWorktree: (worktree) => {
        removed.push(worktree);
        return Promise.resolve();
      },
    },
    runAgent: async (call) => {
      const stage = stageOf(call);
      const task = taskOf(call);
      calls.push({ ...call, stage, task });
      events.push(`start ${task} ${stage}`);
      const key = `${task}:${stage}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      active += 1;
      mostActive = Math.max(mostActive, active);
      try {
        const reply = await (options.respond?.[stage]?.(call, count) ?? {});
        if (reply instanceof Error) throw reply;
        return { costUsd: options.cost ?? 0.01, finalMessage: "done", output: DEFAULT_OUTPUT[stage], ...reply };
      } finally {
        active -= 1;
      }
    },
    tasks: {
      get: (id) => tasks.get(id),
      setStatus: (id, status) => {
        statuses.push([id, status]);
        const found = tasks.get(id);
        if (found !== undefined) tasks.set(id, { ...found, status });
      },
    },
    saveState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
    saveLog: () => Promise.resolve(),
    now: () => new Date(TIME),
    signal: options.signal ?? new AbortController().signal,
    docsPath: ".cclinic/sdd",
  };
  return { ports, calls, statuses, commits, merged, removed, events, states, mostActive: () => mostActive };
}

const task = (id: number, dependsOn: number[] = [], status: TaskStatus = "open"): Task => ({
  id,
  title: `T${id}`,
  description: `About ${id}`,
  status,
  milestoneId: 1,
  spec: "core",
  dependsOn,
  createdAt: TIME,
  updatedAt: TIME,
});

function initial(tasks: readonly Task[], extra: Partial<RunState> = {}): RunState {
  return {
    runId: "r1",
    roadmapId: 1,
    roadmapTitle: "Launch",
    runBranch: "cclinic/auto/r1/run",
    startedAt: TIME,
    finishedAt: null,
    outcome: null,
    budgetUsd: 100,
    spentUsd: 0,
    developers: 2,
    tasks: tasks.map((item): TaskRun => ({
      taskId: item.id,
      title: item.title,
      dependsOn: item.dependsOn,
      status: "waiting",
      branch: null,
      rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
      costUsd: 0,
      reason: null,
      requirementIds: [],
    })),
    skippedInProgress: [],
    ...extra,
  };
}

const CONTEXT = { roadmapTitle: "Launch", roadmapGoal: "Ship", milestoneTitle: "M", milestoneGoal: "Start" };

async function run(options: FakeOptions, extra: Partial<RunState> = {}) {
  const harness = fake(options);
  const withContexts = new Map(options.tasks.map((item) => [item.id, CONTEXT]));
  const state = await runAutomation(
    { state: initial(options.tasks, extra), contexts: withContexts, doneBefore: new Set() },
    harness.ports,
  );
  const byId = (id: number) => state.tasks.find((item) => item.taskId === id);
  return { ...harness, state, byId };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("automated run", () => {
  it("TC-AUTO-009: a task starts only after the task it depends on is merged", async () => {
    const { events, state } = await run({
      tasks: [task(1), task(2, [1])],
      respond: { implement: async () => (await delay(20), {}) },
    });
    expect(state.outcome).toBe("completed");
    expect(events.indexOf("start 2 spec")).toBeGreaterThan(events.indexOf("merged 1"));
  });

  it("TC-AUTO-011: no more than --developers tasks run at once, in roadmap order", async () => {
    const { calls, mostActive } = await run({
      tasks: [task(1), task(2), task(3), task(4)],
      respond: { spec: async () => (await delay(15), {}) },
    });
    expect(mostActive()).toBeLessThanOrEqual(2);
    const firstSpecs = calls.filter((call) => call.stage === "spec").map((call) => call.task);
    expect(firstSpecs.slice(0, 2).sort()).toEqual([1, 2]);
  });

  it("TC-AUTO-013: a blocked task skips its dependants, and other tasks carry on", async () => {
    const { state, byId, statuses } = await run({
      tasks: [task(1), task(2, [1]), task(3, [1]), task(4, [3]), task(5)],
      respond: {
        qa: (call) =>
          taskOf(call) === 1
            ? { output: { result: "fail", failures: [{ testCase: "TC-X-1", output: "no" }], summary: "bad" } }
            : {},
      },
    });
    expect(byId(1)?.status).toBe("blocked");
    for (const id of [2, 3, 4]) {
      expect(byId(id)?.status).toBe("skipped");
      expect(byId(id)?.reason).toContain("task #");
    }
    expect(byId(2)?.reason).toContain("task #1");
    expect(byId(5)?.status).toBe("done");
    expect(state.outcome).toBe("partial");
    expect(statuses).toContainEqual([1, "blocked"]);
  });

  it("TC-AUTO-014: the task list shows in-progress, then done or blocked", async () => {
    const { statuses } = await run({ tasks: [task(1)] });
    expect(statuses).toEqual([
      [1, "in-progress"],
      [1, "done"],
    ]);
  });

  it("TC-AUTO-018: an approved task is committed with its requirements, then merged", async () => {
    const { commits, merged, byId } = await run({ tasks: [task(1)] });
    expect(commits).toEqual([
      { worktree: "/worktrees/cclinic/auto/r1/task-1", message: "#1 T1\n\nRequirements: FR-X-001" },
    ]);
    expect(merged).toEqual(["cclinic/auto/r1/task-1"]);
    expect(byId(1)).toMatchObject({ status: "done", branch: "cclinic/auto/r1/task-1", requirementIds: ["FR-X-001"] });
  });

  it("TC-AUTO-019: a conflicting merge blocks the task, naming the files", async () => {
    const { byId, merged } = await run({ tasks: [task(1), task(2)], conflicts: [2] });
    expect(byId(1)?.status).toBe("done");
    expect(byId(2)).toMatchObject({ status: "blocked" });
    expect(byId(2)?.reason).toContain("src/shared.ts");
    expect(merged).toEqual(["cclinic/auto/r1/task-1"]);
  });

  it("TC-AUTO-020: worktrees are removed, and a blocked task's work is committed as WIP", async () => {
    const { removed, commits } = await run({
      tasks: [task(1), task(2)],
      respond: {
        qa: (call) => (taskOf(call) === 2 ? { output: { result: "fail", failures: [], summary: "bad" } } : {}),
      },
    });
    expect(removed.sort()).toEqual(["/worktrees/cclinic/auto/r1/task-1", "/worktrees/cclinic/auto/r1/task-2"]);
    expect(commits.find((commit) => commit.worktree.endsWith("task-2"))?.message).toContain("WIP");
  });

  it("TC-AUTO-021: each agent gets a budget no higher than what's left", async () => {
    const { calls } = await run({ tasks: [task(1)], cost: 0.5 }, { budgetUsd: 5 });
    expect(calls.map((call) => call.maxBudgetUsd)).toEqual([5, 4.5, 4, 3.5, 3]);
  });

  it("TC-AUTO-024: the PM's spec feedback goes back to the developer, with the task's goals", async () => {
    const { calls, byId } = await run({
      tasks: [task(1)],
      respond: {
        "spec-review": (_call, count) =>
          count === 1 ? { output: { verdict: "refine", feedback: "add an error case" } } : {},
      },
    });
    const review = calls.find((call) => call.stage === "spec-review");
    for (const part of ["T1", "About 1", "Start", "Ship"]) expect(review?.prompt).toContain(part);
    expect(review?.prompt).toContain("diff of /worktrees/cclinic/auto/r1/task-1 in .cclinic/sdd");
    const specs = calls.filter((call) => call.stage === "spec");
    expect(specs[1]?.prompt).toContain("add an error case");
    expect(byId(1)?.status).toBe("done");
  });

  it("TC-AUTO-025: implementation never starts without an approved spec", async () => {
    const { calls, byId } = await run({
      tasks: [task(1)],
      respond: { "spec-review": () => ({ output: { verdict: "refine", feedback: "no" } }) },
    });
    expect(calls.some((call) => call.stage === "implement" || call.stage === "qa")).toBe(false);
    expect(byId(1)?.status).toBe("blocked");
  });

  it("TC-AUTO-026: QA runs separately, and its failures go back to the developer", async () => {
    const failure = {
      result: "fail",
      failures: [{ testCase: "TC-AUTH-002", output: "expected 401" }],
      summary: "1 failed",
    };
    const { calls, byId } = await run({
      tasks: [task(1)],
      respond: { qa: (_call, count) => (count === 1 ? { output: failure } : {}) },
    });
    const qa = calls.find((call) => call.stage === "qa");
    expect(qa?.role).toBe("qa");
    expect(qa?.prompt).toContain("test-spec");
    const fixes = calls.filter((call) => call.stage === "implement");
    expect(fixes[1]?.prompt).toContain("TC-AUTH-002: expected 401");
    expect(byId(1)?.status).toBe("done");
  });

  it("TC-AUTO-027: the PM's review sees the diff and QA, and changes go back through QA", async () => {
    const { calls, byId } = await run({
      tasks: [task(1)],
      respond: {
        review: (_call, count) =>
          count === 1 ? { output: { verdict: "changes", feedback: "rename it", requirementIds: [] } } : {},
      },
    });
    const stages = calls.map((call) => call.stage);
    expect(stages).toEqual(["spec", "spec-review", "implement", "qa", "review", "implement", "qa", "review"]);
    const review = calls.find((call) => call.stage === "review");
    expect(review?.prompt).toContain("diff of /worktrees/cclinic/auto/r1/task-1");
    expect(review?.prompt).toContain('"result":"pass"');
    expect(calls[5]?.prompt).toContain("rename it");
    expect(byId(1)?.status).toBe("done");
  });

  it("TC-AUTO-028: an invalid verdict or a failed agent is a rejected round, never an approval", async () => {
    const invalid = await run({
      tasks: [task(1)],
      respond: { "spec-review": () => ({ output: { verdict: "maybe" } }) },
    });
    expect(invalid.byId(1)).toMatchObject({ status: "blocked", rounds: { specReviews: 3 } });
    expect(invalid.byId(1)?.reason).toContain("wasn't a valid verdict");
    const failing = await run({ tasks: [task(1)], respond: { qa: () => new AgentCallError("exit code 1", 0.2) } });
    expect(failing.byId(1)).toMatchObject({ status: "blocked", rounds: { qaRuns: 3 } });
    expect(failing.byId(1)?.reason).toContain("exit code 1");
    expect(failing.calls.some((call) => call.stage === "review")).toBe(false);
  });

  it("TC-AUTO-029: each stage stops after exactly 3 rounds", async () => {
    const qa = await run({
      tasks: [task(1)],
      respond: {
        qa: () => ({ output: { result: "fail", failures: [{ testCase: "TC-9", output: "" }], summary: "" } }),
      },
    });
    expect(qa.calls.filter((call) => call.stage === "qa")).toHaveLength(3);
    expect(qa.byId(1)?.reason).toContain("3 QA runs. Last: TC-9");
    const review = await run({
      tasks: [task(1)],
      respond: { review: () => ({ output: { verdict: "changes", feedback: "again", requirementIds: [] } }) },
    });
    expect(review.calls.filter((call) => call.stage === "review")).toHaveLength(3);
    expect(review.byId(1)?.reason).toContain("implementation reviews. Last: again");
  });

  it("TC-AUTO-030: no agent starts once the budget left can't cover one, and unfinished tasks go back to open", async () => {
    const { calls, state, statuses } = await run(
      { tasks: [task(1), task(2), task(3)], cost: 1 },
      { budgetUsd: 4, developers: 1 },
    );
    expect(calls).toHaveLength(4);
    expect(state.spentUsd).toBeLessThanOrEqual(4);
    expect(state.outcome).toBe("budget-reached");
    expect(state.tasks.map((item) => item.status)).toEqual(["open", "open", "open"]);
    expect(statuses).toContainEqual([1, "open"]);
  });

  it("TC-AUTO-031: an agent that times out counts as a rejected round", async () => {
    const { byId } = await run({
      tasks: [task(1)],
      respond: { implement: () => new AgentCallError("timed out after 1 minutes", null) },
    });
    expect(byId(1)?.reason).toContain("timed out");
  });

  it("TC-AUTO-037: stopping the run puts running tasks back to open and merges nothing more", async () => {
    const controller = new AbortController();
    const { state, merged, statuses, commits } = await run({
      tasks: [task(1), task(2, [1]), task(3)],
      signal: controller.signal,
      respond: {
        implement: (call) => {
          if (taskOf(call) === 3) {
            controller.abort();
            return new CancelledError("Cancelled.");
          }
          return {};
        },
      },
    });
    expect(state.outcome).toBe("interrupted");
    expect(merged.every((branch) => !branch.endsWith("task-3"))).toBe(true);
    expect(state.tasks.find((item) => item.taskId === 3)?.status).toBe("open");
    expect(statuses).toContainEqual([3, "open"]);
    expect(commits.find((commit) => commit.worktree.endsWith("task-3"))?.message).toContain("WIP");
  });

  it("FR-AUTO-001 edge case: a task removed from the list during the run is skipped", async () => {
    const harness = fake({ tasks: [task(1)] });
    const state = await runAutomation(
      { state: initial([task(1), task(2)]), contexts: new Map(), doneBefore: new Set() },
      harness.ports,
    );
    expect(state.tasks.find((item) => item.taskId === 2)).toMatchObject({ status: "skipped" });
  });
});
