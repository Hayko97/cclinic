import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import {
  buildRoadmap,
  milestoneInputSchema,
  parseId,
  parseInput,
  renderRoadmap,
  renderTask,
  renderTaskList,
  taskInputSchema,
  type Milestone,
  type Task,
} from "./tasks.js";

const TIME = "2026-11-08T10:00:00.000Z";
const milestone = (id: number, position: number, goal: string | null = null): Milestone => ({
  id,
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
    expect(milestoneInputSchema.safeParse({ title: " " }).success).toBe(false);
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

describe("rendering", () => {
  it("TC-TASK-014: the roadmap shows milestones in position order, then tasks with no milestone", () => {
    const roadmap = buildRoadmap(
      [milestone(1, 2), milestone(2, 1, "Ship it")],
      [task(1, { milestoneId: 1, status: "done" }), task(2, { milestoneId: 2, spec: "auth" }), task(3)],
    );
    expect(roadmap.milestones.map((item) => item.id)).toEqual([2, 1]);
    expect(roadmap.unassigned.map((item) => item.id)).toEqual([3]);
    expect(renderRoadmap(roadmap)).toBe(
      [
        "Milestone #2: M2",
        "  Goal: Ship it",
        "  #2 [open] T2 (spec: auth)",
        "",
        "Milestone #1: M1",
        "  #1 [done] T1",
        "",
        "No milestone",
        "  #3 [open] T3",
      ].join("\n"),
    );
  });

  it("TC-TASK-014: empty milestones and an empty roadmap are stated", () => {
    expect(renderRoadmap(buildRoadmap([], []))).toBe("The roadmap is empty.");
    expect(renderRoadmap(buildRoadmap([milestone(1, 1)], []))).toBe("Milestone #1: M1\n  No tasks.");
  });

  it("TC-TASK-010: a task's details include every field", () => {
    const text = renderTask(task(4, { description: "Details", spec: "auth", milestoneId: 1 }), milestone(1, 1));
    for (const part of ["#4 T4", "Status: open", "Milestone: #1 M1", "Spec: auth", `Created: ${TIME}`, "Details"]) {
      expect(text).toContain(part);
    }
    expect(renderTask(task(5), undefined)).toContain("Milestone: none");
  });

  it("TC-TASK-009: the list keeps the given order, and says when it's empty", () => {
    expect(renderTaskList([])).toBe("No tasks.");
    expect(renderTaskList([task(2), task(1, { status: "in-progress" })])).toBe("  #2 [open] T2\n  #1 [in-progress] T1");
  });
});
