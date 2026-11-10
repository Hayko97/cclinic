import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import {
  buildOverview,
  buildRoadmap,
  findCycle,
  parseId,
  parseInput,
  renderOverview,
  renderRoadmap,
  renderRoadmapList,
  renderTask,
  renderTaskList,
  roadmapStatus,
  summarizeRoadmap,
  taskInputSchema,
  type Milestone,
  type RoadmapRecord,
  type Task,
} from "./tasks.js";

const TIME = "2026-11-08T10:00:00.000Z";
const milestone = (id: number, position: number, goal: string | null = null, roadmapId = 1): Milestone => ({
  id,
  roadmapId,
  title: `M${id}`,
  goal,
  position,
  createdAt: TIME,
});
const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id,
  title: `T${id}`,
  description: null,
  status: "open",
  milestoneId: null,
  spec: null,
  dependsOn: [],
  createdAt: TIME,
  updatedAt: TIME,
  ...extra,
});

describe("task input", () => {
  it("TC-TASK-002: no SQLite package is added", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => /sqlite/i.test(name))).toEqual([]);
  });

  it("TC-TASK-007: titles, descriptions and spec names are validated", () => {
    const accepts = (input: Record<string, unknown>): boolean => taskInputSchema.safeParse(input).success;
    expect(accepts({ title: "" })).toBe(false);
    expect(accepts({ title: "   " })).toBe(false);
    expect(accepts({ title: "x".repeat(201) })).toBe(false);
    expect(accepts({ title: "x".repeat(200) })).toBe(true);
    expect(accepts({ title: "x", description: "d".repeat(4001) })).toBe(false);
    expect(accepts({ title: "x", description: "d".repeat(4000) })).toBe(true);
    for (const spec of ["Auth", "auth--x", "-auth", "auth-"]) expect(accepts({ title: "x", spec }), spec).toBe(false);
    expect(accepts({ title: "x", spec: "auth-2" })).toBe(true);
  });

  it("TC-TASK-007: invalid input is a usage error naming the field", () => {
    expect(() => parseInput(taskInputSchema, { title: " " })).toThrow(UsageError);
    expect(() => parseInput(taskInputSchema, { title: "x", spec: "Auth" })).toThrow(/Invalid spec/);
    expect(parseInput(taskInputSchema, { title: "  Lock  " }).title).toBe("Lock");
  });

  it("TC-TASK-013: only positive whole numbers are IDs, and the error names the value", () => {
    expect(parseId("12", "task")).toBe(12);
    for (const value of ["0", "-1", "abc", "1.5", "", "1e3", String(Number.MAX_SAFE_INTEGER + 2)]) {
      expect(() => parseId(value, "task"), value).toThrow(UsageError);
    }
    expect(() => parseId("abc", "milestone")).toThrow(`"abc" isn't a valid milestone ID.`);
  });
});

const roadmapRecord = (id: number, goal: string | null = null): RoadmapRecord => ({
  id,
  title: `R${id}`,
  goal,
  createdAt: TIME,
});

describe("rendering", () => {
  it("TC-TASK-036: the overview shows roadmaps in ID order with milestones in position order, then tasks with no milestone", () => {
    const overview = buildOverview(
      [roadmapRecord(2), roadmapRecord(1, "Ship it")],
      [milestone(1, 2), milestone(2, 1, "First"), milestone(3, 1, null, 2)],
      [
        task(1, { milestoneId: 1, status: "done" }),
        task(2, { milestoneId: 2, spec: "auth" }),
        task(4, { milestoneId: 3, dependsOn: [2] }),
        task(3),
      ],
    );
    expect(overview.roadmaps.map((item) => item.id)).toEqual([1, 2]);
    expect(overview.unassigned.map((item) => item.id)).toEqual([3]);
    expect(renderOverview(overview)).toBe(
      [
        "Roadmap #1: R1 [in-progress]",
        "  Goal: Ship it",
        "  Milestone #2: M2",
        "    Goal: First",
        "    #2 [open] T2 (spec: auth)",
        "  Milestone #1: M1",
        "    #1 [done] T1",
        "",
        "Roadmap #2: R2 [planned]",
        "  Milestone #3: M3",
        "    #4 [open] T4 (needs #2)",
        "",
        "No milestone",
        "  #3 [open] T3",
      ].join("\n"),
    );
  });

  it("TC-TASK-014: milestones show in position order with goals and task statuses, then the unassigned task", () => {
    const text = renderOverview(
      buildOverview(
        [roadmapRecord(1)],
        [milestone(1, 2, "Later goal"), milestone(2, 1, "Sooner goal")],
        [task(1, { milestoneId: 1, status: "in-progress" }), task(2, { milestoneId: 2 }), task(3)],
      ),
    );
    expect(text).toBe(
      [
        "Roadmap #1: R1 [in-progress]",
        "  Milestone #2: M2",
        "    Goal: Sooner goal",
        "    #2 [open] T2",
        "  Milestone #1: M1",
        "    Goal: Later goal",
        "    #1 [in-progress] T1",
        "",
        "No milestone",
        "  #3 [open] T3",
      ].join("\n"),
    );
  });

  it("TC-TASK-036: empty milestones, roadmaps and overviews are stated", () => {
    expect(renderOverview(buildOverview([], [], []))).toBe("No roadmaps or tasks.");
    expect(renderRoadmap(buildRoadmap(roadmapRecord(1), [], []))).toBe("Roadmap #1: R1 [planned]\n  No milestones.");
    expect(renderRoadmap(buildRoadmap(roadmapRecord(1), [milestone(1, 1)], []))).toBe(
      "Roadmap #1: R1 [planned]\n  Milestone #1: M1\n    No tasks.",
    );
  });

  it("TC-TASK-033: a roadmap's status comes from its tasks", () => {
    expect(roadmapStatus([])).toBe("planned");
    expect(roadmapStatus([task(1), task(2)])).toBe("planned");
    expect(roadmapStatus([task(1), task(2, { status: "blocked" })])).toBe("in-progress");
    expect(roadmapStatus([task(1, { status: "in-progress" })])).toBe("in-progress");
    expect(roadmapStatus([task(1, { status: "done" }), task(2)])).toBe("in-progress");
    expect(roadmapStatus([task(1, { status: "done" }), task(2, { status: "done" })])).toBe("done");
  });

  it("TC-TASK-030: the roadmap list shows status, milestone count and task counts", () => {
    const roadmap = buildRoadmap(
      roadmapRecord(1, "First release"),
      [milestone(1, 1), milestone(2, 2)],
      [
        task(1, { milestoneId: 1 }),
        task(2, { milestoneId: 1, status: "in-progress" }),
        task(3, { milestoneId: 2, status: "done" }),
        task(4, { milestoneId: 2, status: "blocked" }),
      ],
    );
    const summary = summarizeRoadmap(roadmap);
    expect(summary).toMatchObject({
      id: 1,
      status: "in-progress",
      milestoneCount: 2,
      taskCounts: { open: 1, "in-progress": 1, done: 1, blocked: 1 },
    });
    expect(renderRoadmapList([summary])).toBe(
      "#1 R1 [in-progress]\n  Goal: First release\n  2 milestones; tasks: 1 open, 1 in-progress, 1 done, 1 blocked",
    );
    expect(renderRoadmapList([])).toContain("cclinic plan");
  });

  it("TC-TASK-024: a dependency cycle is found and named in order", () => {
    expect(
      findCycle(
        new Map([
          [1, [2]],
          [2, [3]],
          [3, []],
        ]),
      ),
    ).toBeUndefined();
    expect(
      findCycle(
        new Map([
          [1, [2]],
          [2, [3]],
          [3, [1]],
        ]),
      ),
    ).toEqual([1, 2, 3]);
    expect(findCycle(new Map([["a", ["a"]]]))).toEqual(["a"]);
  });

  it("TC-TASK-010: a task's details include every field", () => {
    const text = renderTask(
      task(4, { description: "Details", spec: "auth", milestoneId: 1, dependsOn: [1, 2] }),
      milestone(1, 1),
    );
    for (const part of [
      "#4 T4",
      "Status: open",
      "Milestone: #1 M1",
      "Spec: auth",
      "Depends on: #1, #2",
      `Created: ${TIME}`,
      "Details",
    ]) {
      expect(text).toContain(part);
    }
    expect(renderTask(task(5), undefined)).toContain("Milestone: none");
    expect(renderTask(task(5), undefined)).toContain("Depends on: none");
  });

  it("TC-TASK-009: the list keeps the given order, and says when it's empty", () => {
    expect(renderTaskList([])).toBe("No tasks.");
    expect(renderTaskList([task(2), task(1, { status: "blocked", dependsOn: [2] })])).toBe(
      "  #2 [open] T2\n  #1 [blocked] T1 (needs #2)",
    );
  });
});
