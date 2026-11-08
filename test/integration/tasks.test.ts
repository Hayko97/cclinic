/** The task store and the `tasks` commands, in-process, on temporary projects. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore, tasksDatabaseFile } from "../../src/adapters/storage/task-store.js";
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

  it("TC-TASK-004: a milestone is placed after the existing ones, with its goal", () => {
    const store = created(makeTempFolder());
    store.addMilestone({ title: "One" });
    store.addMilestone({ title: "Two" });
    const third = store.addMilestone({ title: "Three", goal: "Ship" });
    expect(third).toMatchObject({ id: 3, title: "Three", goal: "Ship", position: 3 });
    expect(store.listMilestones().map((item) => item.title)).toEqual(["One", "Two", "Three"]);
    store.close();
  });

  it("TC-TASK-005: removing a milestone keeps its tasks, with no milestone", () => {
    const store = created(makeTempFolder());
    const { id } = store.addMilestone({ title: "MVP" });
    store.addTask({ title: "A", milestoneId: id });
    store.addTask({ title: "B", milestoneId: id });
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

  it("TC-TASK-006: a task is saved open, with every option", () => {
    const store = created(makeTempFolder());
    const { id } = store.addMilestone({ title: "MVP" });
    const task = store.addTask({ title: "Lock", description: "After 5", milestoneId: id, spec: "auth" });
    expect(task).toMatchObject({ id: 1, title: "Lock", description: "After 5", status: "open", milestoneId: 1 });
    expect(task.spec).toBe("auth");
    expect(store.getTask(task.id)).toEqual(task);
    store.close();
  });

  it("TC-TASK-008: a task for a milestone that doesn't exist isn't saved", () => {
    const store = created(makeTempFolder());
    expect(() => store.addTask({ title: "X", milestoneId: 9 })).toThrow("Milestone 9 doesn't exist.");
    expect(store.listTasks(true)).toEqual([]);
    store.close();
  });

  it("TC-TASK-009: the list is in roadmap order, and leaves out done tasks unless asked", () => {
    const store = created(makeTempFolder());
    const later = store.addMilestone({ title: "Later" });
    const unassigned = store.addTask({ title: "Unassigned" });
    const inLater = store.addTask({ title: "In later", milestoneId: later.id });
    const sooner = store.addMilestone({ title: "Sooner" });
    const inSooner = store.addTask({ title: "In sooner", milestoneId: sooner.id });
    const done = store.addTask({ title: "Done", milestoneId: sooner.id });
    store.setStatus(done.id, "done");
    // Positions follow creation, so "Later" (1) comes before "Sooner" (2).
    expect(store.listTasks(false).map((task) => task.id)).toEqual([inLater.id, inSooner.id, unassigned.id]);
    expect(store.listTasks(true).map((task) => task.id)).toEqual([inLater.id, inSooner.id, done.id, unassigned.id]);
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
    database.exec("PRAGMA user_version = 2");
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
    expect(await json(root, "roadmap")).toEqual({ status: "success", milestones: [], unassigned: [] });
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
    expect(await tasks(root, "milestone", "add", "--title", "MVP", "--goal", "First")).toBe("Added milestone 1: MVP\n");
    const { task } = await json<{ task: Task }>(
      root,
      "add",
      "--title",
      "Lock",
      "--description",
      "After 5",
      "--milestone",
      "1",
      "--spec",
      "auth",
    );
    expect(task).toMatchObject({ id: 1, status: "open", milestoneId: 1, spec: "auth", description: "After 5" });
    expect(await tasks(root, "start", "1")).toBe("Task 1 is in-progress: Lock\n");
    expect(await tasks(root, "show", "1")).toContain("Milestone: #1 MVP");
    expect(await tasks(root, "done", "1")).toBe("Task 1 is done: Lock\n");
    expect(await tasks(root, "list")).toBe("No tasks.\n");
    expect(await json(root, "remove", "1")).toEqual({ status: "success", removed: 1 });
    expect(await json(root, "list", "--all")).toEqual({ status: "success", tasks: [] });
    expect(await tasks(root, "milestone", "remove", "1")).toContain("Removed milestone 1");
  });

  it("TC-TASK-008: invalid input saves nothing", async () => {
    const root = makeTempFolder();
    await expect(tasks(root, "add", "--title", "X", "--milestone", "9")).rejects.toThrow("Milestone 9");
    await expect(tasks(root, "add", "--title", "X", "--milestone", "abc")).rejects.toThrow(UsageError);
    await expect(tasks(root, "add", "--title", " ")).rejects.toThrow(UsageError);
    await expect(tasks(root, "add", "--title", "X", "--spec", "Auth")).rejects.toThrow(UsageError);
    await expect(tasks(root, "milestone", "add", "--title", "")).rejects.toThrow(UsageError);
    expect(await json(root, "list", "--all")).toEqual({ status: "success", tasks: [] });
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

  it("TC-TASK-009: list --json follows milestone position, not milestone ID", async () => {
    const root = makeTempFolder();
    await tasks(root, "milestone", "add", "--title", "First added");
    await tasks(root, "milestone", "add", "--title", "Second added");
    const database = new DatabaseSync(tasksDatabaseFile(tool(root)));
    database.exec("UPDATE milestones SET position = 3 - id");
    database.close();
    await tasks(root, "add", "--title", "Unassigned");
    await tasks(root, "add", "--title", "In position 2", "--milestone", "1");
    await tasks(root, "add", "--title", "In position 1", "--milestone", "2");
    await tasks(root, "add", "--title", "Done", "--milestone", "2");
    await tasks(root, "done", "4");
    const titles = async (...args: string[]): Promise<string[]> =>
      (await json<{ tasks: Task[] }>(root, "list", ...args)).tasks.map((task) => task.title);
    expect(await titles()).toEqual(["In position 1", "In position 2", "Unassigned"]);
    expect(await titles("--all")).toEqual(["In position 1", "Done", "In position 2", "Unassigned"]);
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
