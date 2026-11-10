/** `cclinic plan` in-process: the planning session with fake ports, and the command with a fake `claude`. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTaskStore, tasksDatabaseFile, type TaskStore } from "../../src/adapters/storage/task-store.js";
import { runPlanningSession, type PlanningPorts, type ReviewChoice } from "../../src/application/planning-session.js";
import { runPlanCommand, type PlanOptions } from "../../src/cli/plan-command.js";
import { AgentSessionError, CancelledError, exitCodeFor, UsageError } from "../../src/core/errors.js";
import type { RoadmapProposal, TaskProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);

/** Starting the fake `claude` can take a few seconds when the machine is busy. */
const SPAWN_WAIT = { timeout: 15_000 };

const isTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

const planned = (key: string, dependsOn: (string | number)[] = [], spec: string | null = null) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec,
  dependsOn,
});

const roadmapProposal = (extra: Partial<RoadmapProposal> = {}): RoadmapProposal => ({
  roadmap: { title: "Launch", goal: "First release" },
  milestones: [
    { title: "First", goal: "Start", tasks: [planned("a", [], "auth")] },
    { title: "Second", goal: "Grow", tasks: [planned("b", ["a"]), planned("c", ["a", "b"])] },
  ],
  openQuestions: ["Which email provider?"],
  ...extra,
});

const taskProposal = (milestoneId: number | null, dependsOn: number[] = []): TaskProposal => ({
  task: { title: "Lock accounts", description: "After 5 failures", spec: null, dependsOn },
  milestoneId,
  openQuestions: [],
});

/** The options of the nth menu shown. */
const menuAt = (index: number): unknown => selectMock.mock.calls[index]?.[0];

const questions = (...asked: string[]) => ({ questions: asked, proposal: null });
const proposing = (proposal: RoadmapProposal | TaskProposal) => ({ questions: [], proposal });

/** Fake ports: scripted PM replies, answers and review choices. */
function ports(replies: unknown[], choices: ReviewChoice[] = ["approve"], answers: string[] = [], cost = 0.01) {
  const prompts: string[] = [];
  const budgets: number[] = [];
  const shown: string[] = [];
  const port: PlanningPorts = {
    callPm: (prompt, maxBudgetUsd) => {
      prompts.push(prompt);
      budgets.push(maxBudgetUsd);
      return Promise.resolve({ reply: replies.shift() ?? questions("More?"), costUsd: cost });
    },
    answer: () => Promise.resolve(answers.shift() ?? ""),
    review: (text) => {
      shown.push(text);
      return Promise.resolve(choices.shift() ?? "cancel");
    },
    feedback: () => Promise.resolve("split task b"),
  };
  return { port, prompts, budgets, shown };
}

const session = (target: Parameters<typeof runPlanningSession>[0]["target"] = { kind: "new-roadmap" }) => ({
  target,
  skill: "PM instructions",
  overview: { roadmaps: [], unassigned: [] },
  existingTasks: [],
  maxBudgetUsd: 2,
});

describe("planning session", () => {
  it("TC-PLAN-010: answers go back to the PM, and an empty answer is sent as unknown", async () => {
    const fake = ports(
      [questions("Who is it for?", "When?"), proposing(roadmapProposal())],
      ["approve"],
      ["Admins", ""],
    );
    const outcome = await runPlanningSession(session(), fake.port);
    expect(fake.prompts[1]).toContain("Q: Who is it for?\nA: Admins");
    expect(fake.prompts[1]).toContain("Q: When?\nA: unknown");
    expect(fake.shown[0]).toContain("Which email provider?");
    expect(outcome.kind).toBe("roadmap");
  });

  it("TC-PLAN-012: a proposal that fails the checks goes back to the PM, unseen", async () => {
    const cyclic = roadmapProposal({
      milestones: [{ title: "M", goal: "", tasks: [planned("A", ["B"]), planned("B", ["A"])] }],
    });
    const fake = ports([proposing(cyclic), proposing(roadmapProposal())]);
    await runPlanningSession(session(), fake.port);
    expect(fake.shown).toHaveLength(1);
    expect(fake.shown[0]).toContain("Roadmap: Launch");
    expect(fake.prompts[1]).toContain("The dependencies make a cycle: A -> B -> A.");
  });

  it("TC-PLAN-013: an invalid reply is sent back once with the error, and the session continues", async () => {
    const fake = ports(["not json", questions("Who?"), proposing(roadmapProposal())], ["approve"], ["Me"]);
    expect((await runPlanningSession(session(), fake.port)).kind).toBe("roadmap");
    expect(fake.prompts[1]).toContain("Your last reply wasn't valid");
  });

  it("TC-PLAN-014: two invalid replies in a row end the session", async () => {
    const fake = ports(["not json", { questions: [] }]);
    const error = await runPlanningSession(session(), fake.port).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(exitCodeFor(error)).toBe(4);
  });

  it("TC-PLAN-016: refine sends the feedback to the PM, which proposes again", async () => {
    const fake = ports(
      [proposing(roadmapProposal()), proposing(roadmapProposal({ openQuestions: [] }))],
      ["refine", "approve"],
    );
    const outcome = await runPlanningSession(session(), fake.port);
    expect(fake.prompts[1]).toContain("Feedback on the proposal: split task b");
    expect(outcome).toMatchObject({ kind: "roadmap", proposal: { openQuestions: [] } });
  });

  it("TC-PLAN-020: cancel ends the session with nothing to save", async () => {
    const fake = ports([proposing(roadmapProposal())], ["cancel"]);
    expect(await runPlanningSession(session(), fake.port)).toMatchObject({ kind: "cancelled" });
  });

  it("TC-PLAN-022: the session stops after 20 PM turns", async () => {
    const fake = ports(
      Array.from({ length: 30 }, () => questions("Again?")),
      [],
      [],
      0.01,
    );
    const error = await runPlanningSession(session(), fake.port).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(String(error)).toContain("20 PM turns");
    expect(fake.prompts).toHaveLength(20);
  });

  it("TC-PLAN-023: no turn starts once the budget left can't cover one, and each turn gets the budget left", async () => {
    const fake = ports(
      Array.from({ length: 5 }, () => questions("Again?")),
      [],
      [],
      0.6,
    );
    const error = await runPlanningSession({ ...session(), maxBudgetUsd: 1 }, fake.port).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).toContain("budget of $1");
    expect(fake.prompts).toHaveLength(1);
    expect(fake.budgets).toEqual([1]);
    expect(exitCodeFor(error)).toBe(4);
  });

  it("TC-PLAN-031: task mode asks, retries invalid replies, takes feedback, and cancels", async () => {
    const fake = ports(
      [questions("Which part?"), "bad", proposing(taskProposal(null)), proposing(taskProposal(null))],
      ["refine", "cancel"],
      [""],
    );
    const outcome = await runPlanningSession(session({ kind: "task", roadmapId: null }), fake.port);
    expect(fake.prompts[1]).toContain("A: unknown");
    expect(fake.prompts[2]).toContain("wasn't valid");
    expect(fake.prompts[3]).toContain("split task b");
    expect(outcome.kind).toBe("cancelled");
  });
});

/** A project with documents, and a store with roadmap 1 (milestones 1 and 2) and a task in each. */
function project(withRoadmap = true): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  if (withRoadmap) {
    const store = openStore(root);
    store.savePlan({
      roadmap: { title: "Launch", goal: "Ship" },
      milestones: [
        { title: "One", goal: "", tasks: [planned("x")] },
        { title: "Two", goal: "", tasks: [planned("y")] },
      ],
    });
    store.close();
  }
  return root;
}

function openStore(root: string): TaskStore {
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  return store;
}

function pmRules(...replies: unknown[]): FakeClaudeRule[] {
  return replies.map((output) => ({ output, cost: 0.01 }));
}

async function plan(root: string, harness: ReturnType<typeof agentHarness>, options: Partial<PlanOptions> = {}) {
  await runPlanCommand(
    { dir: root, maxBudgetUsd: 2, timeoutMinutes: 30, model: "haiku", effort: "low", ...options },
    harness.context,
  );
}

describe("cclinic plan", () => {
  it("TC-PLAN-004: with roadmaps, the user picks one to extend, and the PM is told", async () => {
    const root = project();
    const harness = agentHarness({ rules: pmRules(proposing(roadmapProposal({ roadmap: null }))) });
    selectMock.mockResolvedValueOnce("1").mockResolvedValueOnce("approve");
    await plan(root, harness);
    const menu = menuAt(0) as { choices: { name: string }[] };
    expect(menu.choices.map((choice) => choice.name)).toEqual([
      "A new roadmap",
      "Extend Roadmap #1: Launch [planned]",
      "A single task",
    ]);
    expect(harness.calls()[0]?.prompt).toContain("EXTEND roadmap 1");
  });

  it("TC-PLAN-005: with no roadmaps, only a new roadmap or a single task is offered", async () => {
    const root = project(false);
    const harness = agentHarness({ rules: pmRules(proposing(roadmapProposal())) });
    selectMock.mockResolvedValueOnce("new").mockResolvedValueOnce("approve");
    await plan(root, harness);
    const menu = menuAt(0) as { choices: { name: string }[] };
    expect(menu.choices.map((choice) => choice.name)).toEqual(["A new roadmap", "A single task"]);
    expect(harness.calls()[0]?.prompt).toContain("Plan a NEW roadmap");
  });

  it("TC-PLAN-015, TC-PLAN-017: an approved new roadmap is shown, then saved in order with dependencies", async () => {
    const root = project(false);
    const harness = agentHarness({ rules: pmRules(proposing(roadmapProposal())) });
    selectMock.mockResolvedValueOnce("new").mockResolvedValueOnce("approve");
    await plan(root, harness);
    for (const part of [
      "Roadmap: Launch",
      "Milestone 1: First",
      "spec: auth",
      "spec: new spec (needs a)",
      "Which email provider?",
    ]) {
      expect(harness.output.err, part).toContain(part);
    }
    const review = menuAt(1) as { choices: { value: string }[] };
    expect(review.choices.map((choice) => choice.value)).toEqual(["approve", "refine", "cancel"]);
    expect(harness.output.out).toBe("Saved roadmap #1. Run it with: cclinic auto --roadmap 1\n");
    const store = openStore(root);
    expect(store.listMilestones().map((item) => item.title)).toEqual(["First", "Second"]);
    const tasks = store.listTasks(true);
    expect(tasks.map((task) => [task.title, task.status, task.dependsOn])).toEqual([
      ["Task a", "open", []],
      ["Task b", "open", [1]],
      ["Task c", "open", [1, 2]],
    ]);
    store.close();
  });

  it("TC-PLAN-018: extending a roadmap adds milestones after its own", async () => {
    const root = project();
    const extension = roadmapProposal({
      roadmap: null,
      milestones: [{ title: "Three", goal: "", tasks: [planned("z", [1])] }],
    });
    const harness = agentHarness({ rules: pmRules(proposing(extension)) });
    selectMock.mockResolvedValueOnce("approve");
    await plan(root, harness, { roadmap: 1 });
    const store = openStore(root);
    expect(store.listRoadmaps()).toHaveLength(1);
    expect(store.listMilestones().map((item) => [item.title, item.position])).toEqual([
      ["One", 1],
      ["Two", 2],
      ["Three", 3],
    ]);
    store.close();
  });

  it("TC-PLAN-019: a plan that can't be saved saves nothing, and is printed", async () => {
    const root = project(false);
    // Task 9 exists when the proposal is checked, but is gone when it's saved.
    const store = openStore(root);
    for (let id = 1; id <= 9; id += 1) store.addTask({ title: `T${id}` });
    store.close();
    const proposal = roadmapProposal({
      milestones: [{ title: "M", goal: "", tasks: [planned("a"), planned("b", [9])] }],
    });
    const harness = agentHarness({ rules: pmRules(proposing(proposal)) });
    selectMock.mockResolvedValueOnce("new").mockImplementationOnce(() => {
      const removing = openStore(root);
      removing.removeTask(9);
      removing.close();
      return Promise.resolve("approve");
    });
    const error = await plan(root, harness).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect(harness.output.err).toContain("Couldn't save the approved plan");
    expect(harness.output.err).toContain("Roadmap: Launch");
    const after = openStore(root);
    expect(after.listRoadmaps()).toEqual([]);
    expect(after.listTasks(true)).toHaveLength(8);
    after.close();
  });

  it("TC-PLAN-026: the database isn't written until approval, and the PM gets no write or Bash tool", async () => {
    const root = project();
    const file = tasksDatabaseFile(path.join(root, ".cclinic"));
    const before = statSync(file).mtimeMs;
    const contents = readFileSync(file);
    const harness = agentHarness({ rules: pmRules(questions("Who?"), proposing(roadmapProposal())) });
    inputMock.mockResolvedValueOnce("Admins");
    selectMock.mockResolvedValueOnce("new").mockImplementationOnce(() => {
      expect(readFileSync(file).equals(contents)).toBe(true);
      return Promise.resolve("approve");
    });
    await plan(root, harness);
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(before);
    for (const call of harness.calls()) {
      const tools = call.args.slice(call.args.indexOf("--tools") + 1, call.args.indexOf("--allowedTools"));
      expect(tools).toEqual(["Read", "Glob", "Grep"]);
    }
  });

  it("TC-PLAN-028: --task asks where the task goes, unless --roadmap is given", async () => {
    const root = project();
    const harness = agentHarness({
      rules: pmRules(proposing(taskProposal(2)), proposing(taskProposal(null)), proposing(taskProposal(1))),
    });
    selectMock.mockResolvedValueOnce(1).mockResolvedValueOnce("approve");
    await plan(root, harness, { task: true });
    const where = menuAt(0) as { choices: { name: string }[] };
    expect(where.choices.map((choice) => choice.name)).toEqual([
      "Standalone, in no roadmap",
      "Roadmap #1: Launch [planned]",
    ]);
    selectMock.mockResolvedValueOnce(null).mockResolvedValueOnce("approve");
    await plan(root, harness, { task: true });
    selectMock.mockResolvedValueOnce("approve");
    await plan(root, harness, { task: true, roadmap: 1 });
    const prompts = harness.calls().map((call) => call.prompt);
    expect(prompts[0]).toContain("SINGLE task for roadmap 1");
    expect(prompts[1]).toContain("SINGLE STANDALONE task");
    expect(prompts[2]).toContain("SINGLE task for roadmap 1");
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("TC-PLAN-034, TC-PLAN-036: an approved task is saved in its milestone or standalone, with the right next step", async () => {
    const root = project();
    const harness = agentHarness({ rules: pmRules(proposing(taskProposal(2, [1])), proposing(taskProposal(null))) });
    selectMock.mockResolvedValueOnce("approve");
    await plan(root, harness, { task: true, roadmap: 1 });
    expect(harness.output.err).toContain("Where: milestone #2 of roadmap #1");
    expect(harness.output.err).toContain("Depends on: #1");
    expect(harness.output.out).toBe("Saved task #3. It runs with its roadmap: cclinic auto --roadmap 1\n");
    selectMock.mockResolvedValueOnce(null).mockResolvedValueOnce("approve");
    await plan(root, harness, { task: true });
    expect(harness.output.out).toContain("Saved task #4. It's standalone, so cclinic auto doesn't run it.");
    expect(harness.output.out.split("\n")[1]).not.toContain("cclinic auto --");
    const store = openStore(root);
    expect(store.getTask(3)).toMatchObject({ milestoneId: 2, status: "open", dependsOn: [1], spec: null });
    expect(store.getTask(4)?.milestoneId).toBeNull();
    store.close();
  });

  it("TC-PLAN-035: a task that fails to save leaves nothing behind", async () => {
    const root = project();
    const harness = agentHarness({ rules: pmRules(proposing(taskProposal(null, [1]))) });
    selectMock.mockResolvedValueOnce(null).mockImplementationOnce(() => {
      const removing = openStore(root);
      removing.removeTask(1);
      removing.close();
      return Promise.resolve("approve");
    });
    await expect(plan(root, harness, { task: true })).rejects.toThrow(UsageError);
    const store = openStore(root);
    expect(store.listTasks(true).map((task) => task.id)).toEqual([2]);
    store.close();
  });

  it("TC-PLAN-006, TC-PLAN-029: a roadmap that doesn't exist is a usage error, before Claude is called", async () => {
    const root = project();
    const harness = agentHarness();
    await expect(plan(root, harness, { roadmap: 99 })).rejects.toThrow("Roadmap 99 doesn't exist.");
    await expect(plan(root, harness, { roadmap: 99, task: true })).rejects.toThrow("Roadmap 99 doesn't exist.");
    expect(harness.calls()).toEqual([]);
  });

  it("TC-PLAN-024: a PM turn is stopped at the timeout", async () => {
    const root = project(false);
    const harness = agentHarness({ rules: [{ hang: true }] });
    selectMock.mockResolvedValueOnce("new");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const running = plan(root, harness, { timeoutMinutes: 1 }).catch((caught: unknown) => caught);
    await vi.waitFor(() => {
      expect(harness.calls()).toHaveLength(1);
    }, SPAWN_WAIT);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    const error = await running;
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(String(error)).toContain("timed out");
  });

  it("TC-PLAN-021: stopping the session ends the PM process and saves nothing", async () => {
    const root = project(false);
    const pids = path.join(makeTempFolder(), "pids");
    const harness = agentHarness({ rules: [{ hang: true }], env: { FAKE_CLAUDE_PIDS: pids } });
    selectMock.mockResolvedValueOnce("new");
    const running = plan(root, harness).catch((caught: unknown) => caught);
    await vi.waitFor(() => {
      expect(existsSync(pids)).toBe(true);
    }, SPAWN_WAIT);
    harness.controller.abort();
    const error = await running;
    expect(error).toBeInstanceOf(CancelledError);
    expect(exitCodeFor(error)).toBe(130);
    const pid = Number(readFileSync(pids, "utf8").trim());
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    }, SPAWN_WAIT);
    expect(existsSync(path.join(root, ".cclinic/tasks.db"))).toBe(false);
  });
});
