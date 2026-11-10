/** The roadmaps' SQLite database, using Node's built-in driver (FR-TASK-001). */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASKS_DB_FILE } from "../../core/constants/paths.js";
import { TaskDatabaseError, UsageError } from "../../core/errors.js";
import {
  dependencyEdges,
  findCycle,
  type Milestone,
  type RoadmapPlan,
  type RoadmapRecord,
  type Task,
  type TaskInput,
  type TaskStatus,
} from "../../core/tasks.js";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE roadmaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
  title TEXT NOT NULL,
  goal TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER REFERENCES milestones(id),
  title TEXT NOT NULL,
  description TEXT,
  spec TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'done', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

const TASK_COLUMNS = `t.id, t.title, t.description, t.status, t.milestone_id AS milestoneId, t.spec,
  t.created_at AS createdAt, t.updated_at AS updatedAt`;
const MILESTONE_COLUMNS = "id, roadmap_id AS roadmapId, title, goal, position, created_at AS createdAt";
const ROADMAP_COLUMNS = "id, title, goal, created_at AS createdAt";
/** Roadmap order: roadmaps by ID, milestones by position, then tasks with no milestone, then by ID (FR-TASK-007). */
const ROADMAP_ORDER = "ORDER BY m.id IS NULL, m.roadmap_id, m.position, t.id";

export interface SavedPlan {
  readonly roadmapId: number;
  readonly taskIds: Readonly<Record<string, number>>;
}

export interface TaskStore {
  listTasks(includeDone: boolean): readonly Task[];
  getTask(id: number): Task | undefined;
  listMilestones(): readonly Milestone[];
  listRoadmaps(): readonly RoadmapRecord[];
  removeMilestone(id: number): void;
  removeRoadmap(id: number): void;
  /** Saves the task and its dependencies together. A milestone is only given by `cclinic plan`. */
  addTask(input: TaskInput): Task;
  addDependency(taskId: number, dependsOnId: number): Task;
  removeDependency(taskId: number, dependsOnId: number): Task;
  savePlan(plan: RoadmapPlan): SavedPlan;
  setStatus(id: number, status: TaskStatus): Task;
  removeTask(id: number): void;
  close(): void;
}

export function tasksDatabaseFile(toolFolder: string): string {
  return path.join(toolFolder, TASKS_DB_FILE);
}

function checkVersion(database: DatabaseSync, file: string): number {
  let version: number;
  try {
    version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } catch (error) {
    database.close();
    throw new TaskDatabaseError(
      `${file} isn't a readable task database (${error instanceof Error ? error.message : String(error)}). It was left unchanged.`,
    );
  }
  if (version > SCHEMA_VERSION) {
    database.close();
    throw new TaskDatabaseError(
      `${file} was written by a newer version of cclinic. Update cclinic to use it. It was left unchanged.`,
    );
  }
  return version;
}

/**
 * Copies version 1 rows into the version 2 tables. Existing milestones go into one roadmap named
 * "Roadmap", in their order (FR-TASK-022). `from` is the prefix of the version 1 tables.
 */
function copyVersion1(database: DatabaseSync, from: { milestones: string; tasks: string }, now: string): void {
  if (database.prepare(`SELECT 1 FROM ${from.milestones} LIMIT 1`).get() !== undefined) {
    database.prepare("INSERT INTO roadmaps (id, title, goal, created_at) VALUES (1, 'Roadmap', NULL, ?)").run(now);
  }
  database.exec(`INSERT INTO milestones (id, roadmap_id, title, goal, position, created_at)
    SELECT id, 1, title, goal, position, created_at FROM ${from.milestones}`);
  database.exec(`INSERT INTO tasks (id, milestone_id, title, description, spec, status, created_at, updated_at)
    SELECT id, milestone_id, title, description, spec, status, created_at, updated_at FROM ${from.tasks}`);
}

function upgradeInPlace(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database.exec("ALTER TABLE milestones RENAME TO v1_milestones; ALTER TABLE tasks RENAME TO v1_tasks;");
    database.exec(SCHEMA);
    copyVersion1(database, { milestones: "v1_milestones", tasks: "v1_tasks" }, new Date().toISOString());
    // Keeps removed IDs from being reused, since the new tables start their own sequence.
    database.exec(`INSERT INTO sqlite_sequence (name, seq)
      SELECT substr(name, 4), 0 FROM sqlite_sequence
      WHERE name IN ('v1_milestones', 'v1_tasks') AND substr(name, 4) NOT IN (SELECT name FROM sqlite_sequence)`);
    database.exec(`UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE(
      (SELECT seq FROM sqlite_sequence AS old WHERE old.name = 'v1_' || sqlite_sequence.name), 0))
      WHERE name IN ('milestones', 'tasks')`);
    database.exec(
      "DROP TABLE v1_tasks; DROP TABLE v1_milestones; DELETE FROM sqlite_sequence WHERE name IN ('v1_milestones', 'v1_tasks');",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Reads a version 1 file through a version 2 copy in memory, so the file isn't changed (FR-TASK-022). */
function readVersion1(file: string, database: DatabaseSync): DatabaseSync {
  database.close();
  const memory = new DatabaseSync(":memory:");
  memory.exec(SCHEMA);
  memory.prepare("ATTACH DATABASE ? AS v1").run(file);
  copyVersion1(memory, { milestones: "v1.milestones", tasks: "v1.tasks" }, new Date().toISOString());
  memory.exec("DETACH DATABASE v1");
  return memory;
}

/** `read` and `update` never create the database (FR-TASK-002). Only `create` does. */
export type OpenMode = "read" | "update" | "create";

/**
 * Opens the database, or returns undefined when there's none and the mode doesn't create one.
 * A newer or unreadable file is refused before anything is written (FR-TASK-016).
 */
export function openTaskStore(toolFolder: string, mode: OpenMode): TaskStore | undefined {
  const file = tasksDatabaseFile(toolFolder);
  if (!existsSync(file)) {
    if (mode !== "create") return undefined;
    mkdirSync(toolFolder, { recursive: true });
  }
  const database = new DatabaseSync(file, { readOnly: mode === "read" });
  const version = checkVersion(database, file);
  if (version === 0) {
    if (mode !== "create") {
      database.close();
      return undefined;
    }
    database.exec(`BEGIN; ${SCHEMA} COMMIT;`);
  } else if (version < SCHEMA_VERSION) {
    if (mode === "read") return createStore(readVersion1(file, database));
    upgradeInPlace(database);
  }
  return createStore(database);
}

function inTransaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec("BEGIN");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createStore(database: DatabaseSync): TaskStore {
  const now = (): string => new Date().toISOString();

  const dependenciesOf = (id: number): number[] =>
    (
      database
        .prepare("SELECT depends_on_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_id")
        .all(id) as { id: number }[]
    ).map((row) => row.id);

  const withDependencies = (row: Omit<Task, "dependsOn">): Task => ({ ...row, dependsOn: dependenciesOf(row.id) });

  const listTasks = (includeDone: boolean): Task[] =>
    (
      database
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN milestones m ON m.id = t.milestone_id
           ${includeDone ? "" : "WHERE t.status <> 'done'"} ${ROADMAP_ORDER}`,
        )
        .all() as unknown as Omit<Task, "dependsOn">[]
    ).map(withDependencies);

  const getTask = (id: number): Task | undefined => {
    const row = database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ?`).get(id) as
      Omit<Task, "dependsOn"> | undefined;
    return row === undefined ? undefined : withDependencies(row);
  };

  const requireTask = (id: number): Task => {
    const task = getTask(id);
    if (task === undefined) throw new UsageError(`Task ${id} doesn't exist.`);
    return task;
  };

  const requireRow = (table: "milestones" | "roadmaps", kind: string, id: number): void => {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) === undefined)
      throw new UsageError(`${kind} ${id} doesn't exist.`);
  };

  /** Refuses a dependency on itself, on a missing task, or one that makes a cycle (FR-TASK-018). */
  const insertDependency = (taskId: number, dependsOnId: number): void => {
    if (taskId === dependsOnId) throw new UsageError(`Task ${taskId} can't depend on itself.`);
    requireTask(dependsOnId);
    const edges = dependencyEdges(listTasks(true));
    edges.set(taskId, [...(edges.get(taskId) ?? []), dependsOnId]);
    const cycle = findCycle(edges);
    if (cycle !== undefined) {
      throw new UsageError(
        `Task ${taskId} can't depend on task ${dependsOnId}: it would make a cycle (${[...cycle, cycle[0]].map((id) => `#${String(id)}`).join(" -> ")}).`,
      );
    }
    database
      .prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)")
      .run(taskId, dependsOnId);
  };

  const insertTask = (input: {
    title: string;
    description?: string | null | undefined;
    spec?: string | null | undefined;
    milestoneId?: number | undefined;
  }): number => {
    const time = now();
    const { lastInsertRowid } = database
      .prepare(
        "INSERT INTO tasks (title, description, milestone_id, spec, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
      )
      .run(input.title, input.description ?? null, input.milestoneId ?? null, input.spec ?? null, time, time);
    return Number(lastInsertRowid);
  };

  const insertMilestone = (roadmapId: number, title: string, goal: string): number => {
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO milestones (roadmap_id, title, goal, position, created_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM milestones WHERE roadmap_id = ?), ?)`,
      )
      .run(roadmapId, title, goal, roadmapId, now());
    return Number(lastInsertRowid);
  };

  return {
    listTasks,
    getTask,

    listMilestones: () =>
      database
        .prepare(`SELECT ${MILESTONE_COLUMNS} FROM milestones ORDER BY roadmap_id, position, id`)
        .all() as unknown as Milestone[],

    listRoadmaps: () =>
      database.prepare(`SELECT ${ROADMAP_COLUMNS} FROM roadmaps ORDER BY id`).all() as unknown as RoadmapRecord[],

    removeMilestone: (id) => {
      requireRow("milestones", "Milestone", id);
      inTransaction(database, () => {
        database.prepare("UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?").run(id);
        database.prepare("DELETE FROM milestones WHERE id = ?").run(id);
      });
    },

    removeRoadmap: (id) => {
      requireRow("roadmaps", "Roadmap", id);
      inTransaction(database, () => {
        database
          .prepare(
            "UPDATE tasks SET milestone_id = NULL WHERE milestone_id IN (SELECT id FROM milestones WHERE roadmap_id = ?)",
          )
          .run(id);
        database.prepare("DELETE FROM milestones WHERE roadmap_id = ?").run(id);
        database.prepare("DELETE FROM roadmaps WHERE id = ?").run(id);
      });
    },

    addTask: (input) =>
      inTransaction(database, () => {
        if (input.milestoneId !== undefined) requireRow("milestones", "Milestone", input.milestoneId);
        // Checked before the insert, so a missing ID isn't mistaken for the new task's own.
        for (const dependsOnId of input.dependsOn ?? []) requireTask(dependsOnId);
        const id = insertTask(input);
        for (const dependsOnId of input.dependsOn ?? []) insertDependency(id, dependsOnId);
        return requireTask(id);
      }),

    addDependency: (taskId, dependsOnId) =>
      inTransaction(database, () => {
        requireTask(taskId);
        insertDependency(taskId, dependsOnId);
        return requireTask(taskId);
      }),

    removeDependency: (taskId, dependsOnId) => {
      requireTask(taskId);
      requireTask(dependsOnId);
      database
        .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?")
        .run(taskId, dependsOnId);
      return requireTask(taskId);
    },

    savePlan: (plan) =>
      inTransaction(database, () => {
        let roadmapId: number;
        if ("id" in plan.roadmap) {
          roadmapId = plan.roadmap.id;
          requireRow("roadmaps", "Roadmap", roadmapId);
        } else {
          const { lastInsertRowid } = database
            .prepare("INSERT INTO roadmaps (title, goal, created_at) VALUES (?, ?, ?)")
            .run(plan.roadmap.title, plan.roadmap.goal, now());
          roadmapId = Number(lastInsertRowid);
        }
        const taskIds: Record<string, number> = {};
        for (const milestone of plan.milestones) {
          const milestoneId = insertMilestone(roadmapId, milestone.title, milestone.goal);
          for (const task of milestone.tasks) taskIds[task.key] = insertTask({ ...task, milestoneId });
        }
        for (const task of plan.milestones.flatMap((milestone) => milestone.tasks)) {
          for (const dependency of task.dependsOn) {
            const dependsOnId = typeof dependency === "number" ? dependency : taskIds[dependency];
            if (dependsOnId === undefined)
              throw new UsageError(`Task "${task.key}" depends on unknown "${dependency}".`);
            insertDependency(taskIds[task.key] ?? 0, dependsOnId);
          }
        }
        return { roadmapId, taskIds };
      }),

    setStatus: (id, status) => {
      requireTask(id);
      database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      return requireTask(id);
    },

    removeTask: (id) => {
      requireTask(id);
      inTransaction(database, () => {
        database.prepare("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?").run(id, id);
        database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      });
    },

    close: () => {
      database.close();
    },
  };
}
