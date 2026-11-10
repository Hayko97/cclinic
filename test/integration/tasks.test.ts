/** The task store and the `tasks` commands, in-process, on temporary projects. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore, tasksDatabaseFile, type TaskStore } from "../../src/adapters/storage/task-store.js";
import { runClean } from "../../src/cli/other-commands.js";
import { createReporter } from "../../src/cli/reporter.js";
import { addTasksCommand } from "../../src/cli/tasks-command.js";
import { exitCodeFor, TaskDatabaseError, UsageError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/tasks.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

function tool(root: string): string {
  return path.join(root, ".cclinic");
}

function created(root: string) {
  const store = openTaskStore(tool(root), "create");
  if (store === undefined) throw new Error("The store wasn't created");
  return store;
}

/** Runs `cclinic tasks ...` against a project, returning stdout. Errors propagate, as in main.ts. */
async function tasks(root: string, ...args: string[]): Promise<string> {
  let out = "";
  const reporter = createReporter({
    quiet: false,
    debug: false,
    color: "never",
    environment: {},
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: () => true },
  });
  const program = new Command().exitOverride().enablePositionalOptions();
  addTasksCommand(program, { reporter, environment: {}, signal: new AbortController().signal, version: "0.1.0" });
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  await program.parseAsync(["tasks", ...args.slice(0, end), "-C", root, ...args.slice(end)], { from: "user" });
  return out;
}

/** A version 1 database, as written by the previous cclinic, with milestones A then B and task 3 removed. */
function writeVersion1(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE milestones (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, goal TEXT,
      position INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id INTEGER REFERENCES milestones(id),
      title TEXT NOT NULL, description TEXT, spec TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'done')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version = 1;
    INSERT INTO milestones (title, position, created_at) VALUES ('B', 2, 't'), ('A', 1, 't');
    INSERT INTO tasks (milestone_id, title, status, created_at, updated_at)
      VALUES (2, 'One', 'open', 't', 't'), (1, 'Two', 'open', 't', 't'), (NULL, 'Gone', 'open', 't', 't');
    DELETE FROM tasks WHERE id = 3;
  `);
  database.close();
}

type MilestonePlan = readonly [title: string, tasks: readonly string[]];

/** Saves a roadmap plan the way `cclinic plan` does, with tasks keyed by title. */
function savePlan(
  store: TaskStore,
  roadmap: { title: string; goal: string } | { id: number },
  milestones: readonly MilestonePlan[],
) {
  return store.savePlan({
    roadmap,
    milestones: milestones.map(([title, tasks]) => ({
      title,
      goal: "",
      tasks: tasks.map((task) => ({ key: task, title: task, description: "", spec: null, dependsOn: [] })),
    })),
  });
}

async function json<T>(root: string, ...args: string[]): Promise<T> {
  return JSON.parse(await tasks(root, ...args, "--json")) as T;
}

describe("task store", () => {
  it("TC-TASK-001: tasks are saved in .cclinic/tasks.db and read back by a new store", () => {
    const root = makeTempFolder();
    const first = created(root);
    first.addTask({ title: "Lock accounts" });
    first.close();
    const file = tasksDatabaseFile(tool(root));
    expect(file).toBe(path.join(root, ".cclinic/tasks.db"));
    expect(readFileSync(file).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\u0000");
    const second = openTaskStore(tool(root), "read");
    expect(second?.listTasks(true).map((task) => task.title)).toEqual(["Lock accounts"]);
    second?.close();
  });

  it("TC-TASK-003: read and update modes never create the database", () => {
    const root = makeTempFolder();
    expect(openTaskStore(tool(root), "read")).toBeUndefined();
    expect(openTaskStore(tool(root), "update")).toBeUndefined();
    expect(existsSync(tool(root))).toBe(false);
  });

  it("TC-TASK-034: a plan's milestones go after the roadmap's own, and other roadmaps are unchanged", () => {
    const store = created(makeTempFolder());
    const first = savePlan(store, { title: "One", goal: "" }, [
      ["A", []],
      ["B", []],
    ]);
    const second = savePlan(store, { title: "Two", goal: "" }, [["C", []]]);
    savePlan(store, { id: second.roadmapId }, [["D", []]]);
    const positions = store.listMilestones().map((item) => [item.roadmapId, item.title, item.position]);
    expect(positions).toEqual([
      [first.roadmapId, "A", 1],
      [first.roadmapId, "B", 2],
      [second.roadmapId, "C", 1],
      [second.roadmapId, "D", 2],
    ]);
    store.close();
  });

  it("TC-TASK-005: removing a milestone keeps its tasks, with no milestone", () => {
    const store = created(makeTempFolder());
    savePlan(store, { title: "R", goal: "" }, [["MVP", ["A", "B"]]]);
    const id = store.listMilestones()[0]?.id ?? 0;
    store.removeMilestone(id);
    expect(store.listMilestones()).toEqual([]);
    expect(store.listTasks(true).map((task) => [task.title, task.milestoneId])).toEqual([
      ["A", null],
      ["B", null],
    ]);
    expect(() => {
      store.removeMilestone(id);
    }).toThrow(UsageError);
    store.close();
  });

  it("TC-TASK-006: a task is saved open, with no milestone, a spec, a description and dependencies", () => {
    const store = created(makeTempFolder());
    const first = store.addTask({ title: "First" });
    const task = store.addTask({ title: "Lock", description: "After 5", spec: "auth", dependsOn: [first.id] });
    expect(task).toMatchObject({ id: 2, title: "Lock", description: "After 5", status: "open", milestoneId: null });
    expect(task.spec).toBe("auth");
    expect(task.dependsOn).toEqual([1]);
    expect(store.getTask(task.id)).toEqual(task);
    store.close();
  });

  it("TC-TASK-008: a task for a milestone that doesn't exist isn't saved", () => {
    const store = created(makeTempFolder());
    expect(() => store.addTask({ title: "X", milestoneId: 9 })).toThrow("Milestone 9 doesn't exist.");
    expect(store.listTasks(true)).toEqual([]);
    store.close();
  });

  it("TC-TASK-009: the list is in roadmap order, keeps blocked tasks, and leaves out done ones unless asked", () => {
    const store = created(makeTempFolder());
    store.addTask({ title: "Unassigned" });
    savePlan(store, { title: "R", goal: "" }, [
      ["Sooner", ["In sooner", "Done"]],
      ["Later", ["Blocked"]],
    ]);
    const id = (title: string): number => store.listTasks(true).find((task) => task.title === title)?.id ?? 0;
    store.setStatus(id("Done"), "done");
    store.setStatus(id("Blocked"), "blocked");
    expect(store.listTasks(false).map((task) => task.title)).toEqual(["In sooner", "Blocked", "Unassigned"]);
    expect(store.listTasks(true).map((task) => task.title)).toEqual(["In sooner", "Done", "Blocked", "Unassigned"]);
    store.close();
  });

  it("TC-TASK-011: start and done change the status and the updated time", () => {
    vi.useFakeTimers({ now: new Date("2026-11-08T10:00:00Z"), toFake: ["Date"] });
    const store = created(makeTempFolder());
    const task = store.addTask({ title: "Lock" });
    vi.setSystemTime(new Date("2026-11-08T11:00:00Z"));
    const started = store.setStatus(task.id, "in-progress");
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    const finished = store.setStatus(task.id, "done");
    expect([task.status, started.status, finished.status]).toEqual(["open", "in-progress", "done"]);
    expect(task.updatedAt < started.updatedAt && started.updatedAt < finished.updatedAt).toBe(true);
    expect(finished.createdAt).toBe(task.createdAt);
    expect(() => store.setStatus(99, "done")).toThrow("Task 99 doesn't exist.");
    store.close();
  });

  it("TC-TASK-012: remove deletes only that task", () => {
    const store = created(makeTempFolder());
    const first = store.addTask({ title: "First" });
    store.addTask({ title: "Second" });
    store.removeTask(first.id);
    expect(store.listTasks(true).map((task) => task.title)).toEqual(["Second"]);
    expect(() => {
      store.removeTask(first.id);
    }).toThrow(UsageError);
    store.close();
  });

  it("TC-TASK-019: a database from a newer cclinic is refused and left unchanged", async () => {
    const root = makeTempFolder();
    created(root).close();
    const file = tasksDatabaseFile(tool(root));
    const database = new DatabaseSync(file);
    database.exec("PRAGMA user_version = 3");
    database.close();
    const before = readFileSync(file);
    for (const mode of ["read", "update", "create"] as const) {
      expect(() => openTaskStore(tool(root), mode)).toThrow(TaskDatabaseError);
    }
    await expect(tasks(root, "list")).rejects.toThrow(/newer version of cclinic/);
    await expect(tasks(root, "add", "--title", "X")).rejects.toThrow(TaskDatabaseError);
    expect(exitCodeFor(await tasks(root, "list").catch((error: unknown) => error))).toBe(1);
    expect(exitCodeFor(await tasks(root, "add", "--title", "X").catch((error: unknown) => error))).toBe(1);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("TC-TASK-020: a file that isn't a database is refused and left unchanged", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/tasks.db": "plain text, not a database\n" });
    await expect(tasks(root, "list")).rejects.toThrow(/isn't a readable task database/);
    await expect(tasks(root, "add", "--title", "X")).rejects.toThrow(TaskDatabaseError);
    expect(exitCodeFor(await tasks(root, "list").catch((error: unknown) => error))).toBe(1);
    expect(readFileSync(path.join(root, ".cclinic/tasks.db"), "utf8")).toBe("plain text, not a database\n");
  });
});

describe("tasks commands", () => {
  it("TC-TASK-003: reading a project with no database reports nothing and creates nothing", async () => {
    const root = makeTempFolder();
    expect(await tasks(root, "list")).toBe("No tasks.\n");
    expect(await json(root, "roadmap")).toEqual({ status: "success", roadmaps: [], unassigned: [] });
    expect(await json(root, "roadmaps")).toEqual({ status: "success", roadmaps: [] });
    await expect(tasks(root, "roadmap", "show", "1")).rejects.toThrow("Roadmap 1 doesn't exist.");
    await expect(tasks(root, "show", "1")).rejects.toThrow("Task 1 doesn't exist.");
    for (const args of [
      ["start", "1"],
      ["done", "1"],
      ["remove", "1"],
      ["milestone", "remove", "1"],
    ]) {
      await expect(tasks(root, ...args)).rejects.toThrow(UsageError);
    }
    expect(existsSync(tool(root))).toBe(false);
  });

  it("TC-TASK-006, TC-TASK-012: add, start, done and remove through the commands", async () => {
    const root = makeTempFolder();
    const { task } = await json<{ task: Task }>(
      root,
      "add",
      "--title",
      "Lock",
      "--description",
      "After 5",
      "--spec",
      "auth",
    );
    expect(task).toMatchObject({ id: 1, status: "open", milestoneId: null, spec: "auth", description: "After 5" });
    expect(await tasks(root, "start", "1")).toBe("Task 1 is in-progress: Lock\n");
    expect(await tasks(root, "show", "1")).toContain("Milestone: none");
    expect(await tasks(root, "done", "1")).toBe("Task 1 is done: Lock\n");
    expect(await tasks(root, "list")).toBe("No tasks.\n");
    expect(await json(root, "remove", "1")).toEqual({ status: "success", removed: 1 });
    expect(await json(root, "list", "--all")).toEqual({ status: "success", tasks: [] });
  });

  it("TC-TASK-008: invalid input saves nothing", async () => {
    const root = makeTempFolder();
    await expect(tasks(root, "add", "--title", "X", "--milestone", "9")).rejects.toThrow(/cclinic plan/);
    await expect(tasks(root, "add", "--title", " ")).rejects.toThrow(UsageError);
    await expect(tasks(root, "add", "--title", "X", "--spec", "Auth")).rejects.toThrow(UsageError);
    await expect(tasks(root, "add", "--title", "X", "--depends-on", "abc")).rejects.toThrow(UsageError);
    expect(existsSync(tool(root))).toBe(false);
  });

  it("TC-TASK-004, TC-TASK-029: creating milestones and roadmaps by hand is refused and points to cclinic plan", async () => {
    const root = makeTempFolder();
    await expect(tasks(root, "milestone", "add", "--title", "M", "--goal", "G")).rejects.toThrow(/cclinic plan/);
    await expect(tasks(root, "roadmap", "add", "--title", "Launch")).rejects.toThrow(/cclinic plan/);
    expect(exitCodeFor(await tasks(root, "roadmap", "add").catch((error: unknown) => error))).toBe(2);
    expect(existsSync(tool(root))).toBe(false);
  });

  it("TC-TASK-023: --depends-on, depend and undepend change dependencies", async () => {
    const root = makeTempFolder();
    await tasks(root, "add", "--title", "A");
    await tasks(root, "add", "--title", "B");
    const { task } = await json<{ task: Task }>(root, "add", "--title", "C", "--depends-on", "1", "--depends-on", "2");
    expect(task.dependsOn).toEqual([1, 2]);
    expect(await tasks(root, "depend", "1", "--on", "2")).toBe("Task 1 now depends on task 2.\n");
    expect((await json<{ task: Task }>(root, "show", "1")).task.dependsOn).toEqual([2]);
    expect(await tasks(root, "undepend", "1", "--on", "2")).toBe("Task 1 no longer depends on task 2.\n");
    expect((await json<{ task: Task }>(root, "show", "1")).task.dependsOn).toEqual([]);
  });

  it("TC-TASK-024: a cycle, a self-dependency or a missing task is refused and changes nothing", async () => {
    const root = makeTempFolder();
    await tasks(root, "add", "--title", "A");
    await tasks(root, "add", "--title", "B", "--depends-on", "1");
    const before = readFileSync(tasksDatabaseFile(tool(root)));
    await expect(tasks(root, "depend", "1", "--on", "2")).rejects.toThrow(/cycle \(#1 -> #2 -> #1\)/);
    await expect(tasks(root, "depend", "1", "--on", "1")).rejects.toThrow("Task 1 can't depend on itself.");
    await expect(tasks(root, "depend", "1", "--on", "99")).rejects.toThrow("Task 99 doesn't exist.");
    await expect(tasks(root, "depend", "99", "--on", "1")).rejects.toThrow("Task 99 doesn't exist.");
    await expect(tasks(root, "add", "--title", "X", "--depends-on", "99")).rejects.toThrow("Task 99 doesn't exist.");
    await expect(tasks(root, "add", "--title", "X", "--depends-on", "3")).rejects.toThrow("Task 3 doesn't exist.");
    expect(readFileSync(tasksDatabaseFile(tool(root))).equals(before)).toBe(true);
  });

  it("TC-TASK-025: show, list and roadmap include dependencies", async () => {
    const root = makeTempFolder();
    await tasks(root, "add", "--title", "A");
    await tasks(root, "add", "--title", "B");
    await tasks(root, "add", "--title", "C", "--depends-on", "1", "--depends-on", "2");
    expect((await json<{ task: Task }>(root, "show", "3")).task.dependsOn).toEqual([1, 2]);
    const listed = (await json<{ tasks: Task[] }>(root, "list")).tasks.map((task) => task.dependsOn);
    expect(listed).toEqual([[], [], [1, 2]]);
    expect(await tasks(root, "roadmap")).toContain("#3 [open] C (needs #1, #2)");
    expect(await tasks(root, "show", "3")).toContain("Depends on: #1, #2");
  });

  it("TC-TASK-026: blocked tasks are listed, and start reopens them", async () => {
    const root = makeTempFolder();
    const store = created(root);
    store.setStatus(store.addTask({ title: "Stuck" }).id, "blocked");
    store.close();
    expect((await json<{ tasks: Task[] }>(root, "list")).tasks.map((task) => task.status)).toEqual(["blocked"]);
    expect(await tasks(root, "start", "1")).toBe("Task 1 is in-progress: Stuck\n");
  });

  it("TC-TASK-027: removing a task removes its dependencies both ways", () => {
    const store = created(makeTempFolder());
    store.addTask({ title: "Three" });
    store.addTask({ title: "One", dependsOn: [1] });
    store.addTask({ title: "Two", dependsOn: [2] });
    store.removeTask(2);
    expect(store.getTask(3)?.dependsOn).toEqual([]);
    expect(store.listTasks(true).flatMap((task) => task.dependsOn)).toEqual([]);
    store.close();
  });

  it("TC-TASK-030: roadmaps lists each roadmap with status, milestone count and task counts", async () => {
    const root = makeTempFolder();
    const store = created(root);
    const { taskIds } = savePlan(store, { title: "Launch", goal: "" }, [
      ["M1", ["a", "b"]],
      ["M2", ["c", "d"]],
    ]);
    savePlan(store, { title: "Empty", goal: "" }, []);
    store.setStatus(taskIds.b ?? 0, "in-progress");
    store.setStatus(taskIds.c ?? 0, "done");
    store.setStatus(taskIds.d ?? 0, "blocked");
    store.close();
    const { roadmaps } = await json<{
      roadmaps: { id: number; status: string; milestoneCount: number; taskCounts: object }[];
    }>(root, "roadmaps");
    expect(roadmaps).toMatchObject([
      {
        id: 1,
        status: "in-progress",
        milestoneCount: 2,
        taskCounts: { open: 1, "in-progress": 1, done: 1, blocked: 1 },
      },
      { id: 2, status: "planned", milestoneCount: 0, taskCounts: { open: 0, "in-progress": 0, done: 0, blocked: 0 } },
    ]);
    expect(await tasks(root, "roadmaps")).toContain("#1 Launch [in-progress]");
  });

  it("TC-TASK-032: roadmap show prints one roadmap with milestones in order and dependencies", async () => {
    const root = makeTempFolder();
    const store = created(root);
    store.savePlan({
      roadmap: { title: "Launch", goal: "Ship" },
      milestones: [
        {
          title: "First",
          goal: "Start",
          tasks: [{ key: "a", title: "A", description: "", spec: null, dependsOn: [] }],
        },
        { title: "Second", goal: "", tasks: [{ key: "b", title: "B", description: "", spec: null, dependsOn: ["a"] }] },
      ],
    });
    store.close();
    const database = new DatabaseSync(tasksDatabaseFile(tool(root)));
    database.exec("UPDATE milestones SET position = 3 - position");
    database.close();
    const { roadmap } = await json<{ roadmap: { milestones: { title: string; tasks: Task[] }[] } }>(
      root,
      "roadmap",
      "show",
      "1",
    );
    expect(roadmap.milestones.map((item) => item.title)).toEqual(["Second", "First"]);
    expect(roadmap.milestones[0]?.tasks[0]?.dependsOn).toEqual([1]);
    const text = await tasks(root, "roadmap", "show", "1");
    expect(text).toContain("Roadmap #1: Launch [planned]");
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("First"));
    expect(text).toContain("#2 [open] B (needs #1)");
  });

  it("TC-TASK-034: a plan for an existing roadmap is saved with dependencies by key and by ID", () => {
    const store = created(makeTempFolder());
    savePlan(store, { title: "R", goal: "" }, [
      ["One", []],
      ["Two", []],
    ]);
    const existing = store.addTask({ title: "Existing" });
    const saved = store.savePlan({
      roadmap: { id: 1 },
      milestones: [
        {
          title: "Three",
          goal: "",
          tasks: [
            { key: "A", title: "A", description: "", spec: null, dependsOn: [] },
            { key: "B", title: "B", description: "", spec: "auth", dependsOn: ["A", existing.id] },
          ],
        },
      ],
    });
    expect(store.listMilestones().find((item) => item.title === "Three")?.position).toBe(3);
    const b = store.getTask(saved.taskIds.B ?? 0);
    expect(b).toMatchObject({ status: "open", spec: "auth" });
    expect(b?.dependsOn).toEqual([existing.id, saved.taskIds.A].sort((left, right) => (left ?? 0) - (right ?? 0)));
    store.close();
  });

  it("TC-TASK-035: a plan that fails part way saves nothing", () => {
    const store = created(makeTempFolder());
    expect(() =>
      store.savePlan({
        roadmap: { title: "R", goal: "" },
        milestones: [
          {
            title: "M",
            goal: "",
            tasks: [
              { key: "A", title: "A", description: "", spec: null, dependsOn: [] },
              { key: "B", title: "B", description: "", spec: null, dependsOn: ["missing"] },
            ],
          },
        ],
      }),
    ).toThrow(UsageError);
    expect(store.listRoadmaps()).toEqual([]);
    expect(store.listMilestones()).toEqual([]);
    expect(store.listTasks(true)).toEqual([]);
    store.close();
  });

  it("TC-TASK-040: a single task is saved in a milestone or standalone, all or nothing", () => {
    const store = created(makeTempFolder());
    savePlan(store, { title: "R", goal: "" }, [
      ["One", []],
      ["Two", []],
    ]);
    const four = store.addTask({ title: "Four" });
    const inMilestone = store.addTask({ title: "In two", milestoneId: 2, dependsOn: [four.id] });
    expect(inMilestone).toMatchObject({ milestoneId: 2, status: "open", dependsOn: [four.id] });
    expect(store.addTask({ title: "Alone" }).milestoneId).toBeNull();
    const count = store.listTasks(true).length;
    expect(() => store.addTask({ title: "Broken", dependsOn: [99] })).toThrow(UsageError);
    expect(store.listTasks(true)).toHaveLength(count);
    store.close();
  });

  it("TC-TASK-037: removing a roadmap removes its milestones and keeps their tasks", async () => {
    const root = makeTempFolder();
    const store = created(root);
    savePlan(store, { title: "R", goal: "" }, [["M", ["A", "B"]]]);
    store.close();
    expect(await tasks(root, "roadmap", "remove", "1")).toContain("Removed roadmap 1");
    expect(await json(root, "roadmaps")).toEqual({ status: "success", roadmaps: [] });
    const all = (await json<{ tasks: Task[] }>(root, "list", "--all")).tasks;
    expect(all.map((task) => [task.title, task.milestoneId])).toEqual([
      ["A", null],
      ["B", null],
    ]);
  });

  it("TC-TASK-038: roadmap show and remove with wrong IDs exit 2 and change nothing", async () => {
    const root = makeTempFolder();
    const store = created(root);
    savePlan(store, { title: "R", goal: "" }, []);
    store.close();
    const before = readFileSync(tasksDatabaseFile(tool(root)));
    for (const command of ["show", "remove"]) {
      for (const id of ["0", "-1", "abc", "1.5", "99"]) {
        const error = await tasks(root, "roadmap", command, "--", id).catch((caught: unknown) => caught);
        expect(error, `${command} ${id}`).toBeInstanceOf(UsageError);
        expect(String(error)).toContain(id);
      }
    }
    expect(readFileSync(tasksDatabaseFile(tool(root))).equals(before)).toBe(true);
  });

  it("TC-TASK-028, TC-TASK-039: a version 1 database is read unchanged, then upgraded on the first write", async () => {
    const root = makeTempFolder();
    const file = tasksDatabaseFile(tool(root));
    writeVersion1(file);
    const before = readFileSync(file);
    expect((await json<{ tasks: Task[] }>(root, "list")).tasks.map((task) => task.title)).toEqual(["One", "Two"]);
    expect(await tasks(root, "roadmaps")).toContain("#1 Roadmap [planned]");
    expect(readFileSync(file).equals(before)).toBe(true);
    await tasks(root, "add", "--title", "X");
    const database = new DatabaseSync(file);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    database.close();
    const overview = await json<{ roadmaps: { title: string; milestones: { title: string; tasks: Task[] }[] }[] }>(
      root,
      "roadmap",
    );
    expect(overview.roadmaps.map((item) => item.title)).toEqual(["Roadmap"]);
    expect(overview.roadmaps[0]?.milestones.map((item) => [item.title, item.tasks.map((task) => task.title)])).toEqual([
      ["A", ["One"]],
      ["B", ["Two"]],
    ]);
    // Task 3 was removed under version 1, so its ID isn't reused.
    expect((await json<{ tasks: Task[] }>(root, "list")).tasks.at(-1)).toMatchObject({ id: 4, title: "X" });
  });

  it("TC-TASK-013: wrong IDs exit with a usage error naming them, and change nothing", async () => {
    const root = makeTempFolder();
    await tasks(root, "add", "--title", "Keep");
    const before = readFileSync(tasksDatabaseFile(tool(root)));
    const commands = [["show"], ["start"], ["done"], ["remove"], ["milestone", "remove"]];
    for (const command of commands) {
      for (const id of ["0", "-1", "abc", "1.5", "99"]) {
        // "--" lets "-1" through as a value rather than an option.
        await expect(tasks(root, ...command, "--", id), `${command.join(" ")} ${id}`).rejects.toThrow(
          new RegExp(
            `^(Task|Milestone) ${id} doesn't exist\\.$|^"${id.replace(".", "\\.")}" isn't a valid (task|milestone) ID\\.$`,
          ),
        );
      }
    }
    expect(readFileSync(tasksDatabaseFile(tool(root))).equals(before)).toBe(true);
  });

  it("TC-TASK-016: -C chooses the project, whatever the current folder", async () => {
    const root = makeTempFolder();
    await tasks(root, "add", "--title", "There");
    expect(existsSync(tasksDatabaseFile(tool(root)))).toBe(true);
    expect(existsSync(path.join(process.cwd(), ".cclinic/tasks.db"))).toBe(false);
  });

  it("TC-TASK-017: a folder that doesn't exist, or a file, is a usage error", async () => {
    const root = makeTempFolder();
    writeFileSync(path.join(root, "file.txt"), "x");
    await expect(tasks(path.join(root, "missing"), "list")).rejects.toThrow(UsageError);
    await expect(tasks(path.join(root, "file.txt"), "list")).rejects.toThrow(UsageError);
  });

  it("TC-TASK-021: cleaning keeps the task database", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/cache/a.json": "{}", ".cclinic/failed/b.json": "{}" });
    await tasks(root, "add", "--title", "Keep");
    const before = readFileSync(tasksDatabaseFile(tool(root)));
    const reporter = createReporter({
      quiet: true,
      debug: false,
      color: "never",
      environment: {},
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    await runClean(
      root,
      { yes: true },
      { reporter, environment: {}, signal: new AbortController().signal, version: "0" },
    );
    expect(existsSync(path.join(root, ".cclinic/cache"))).toBe(false);
    expect(existsSync(path.join(root, ".cclinic/failed"))).toBe(false);
    expect(readFileSync(tasksDatabaseFile(tool(root))).equals(before)).toBe(true);
  });
});
