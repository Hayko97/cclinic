/** The roadmap's SQLite database, using Node's built-in driver (FR-TASK-001). */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASKS_DB_FILE } from "../../core/constants/paths.js";
import { TaskDatabaseError, UsageError } from "../../core/errors.js";
import type { Milestone, MilestoneInput, Task, TaskInput, TaskStatus } from "../../core/tasks.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  status TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

const TASK_COLUMNS = `t.id, t.title, t.description, t.status, t.milestone_id AS milestoneId, t.spec,
  t.created_at AS createdAt, t.updated_at AS updatedAt`;
const MILESTONE_COLUMNS = "id, title, goal, position, created_at AS createdAt";
/** Roadmap order: milestones by position, then tasks with no milestone, then by ID (FR-TASK-007). */
const ROADMAP_ORDER = "ORDER BY m.position IS NULL, m.position, t.id";

export interface TaskStore {
  listTasks(includeDone: boolean): readonly Task[];
  getTask(id: number): Task | undefined;
  listMilestones(): readonly Milestone[];
  addMilestone(input: MilestoneInput): Milestone;
  removeMilestone(id: number): void;
  addTask(input: TaskInput): Task;
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
  if (checkVersion(database, file) === 0) {
    if (mode !== "create") {
      database.close();
      return undefined;
    }
    database.exec(`BEGIN; ${SCHEMA} COMMIT;`);
  }
  return createStore(database);
}

function createStore(database: DatabaseSync): TaskStore {
  const now = (): string => new Date().toISOString();

  const getTask = (id: number): Task | undefined =>
    database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ?`).get(id) as Task | undefined;

  const requireTask = (id: number): Task => {
    const task = getTask(id);
    if (task === undefined) throw new UsageError(`Task ${id} doesn't exist.`);
    return task;
  };

  const requireMilestone = (id: number): void => {
    if (database.prepare("SELECT 1 FROM milestones WHERE id = ?").get(id) === undefined)
      throw new UsageError(`Milestone ${id} doesn't exist.`);
  };

  return {
    listTasks: (includeDone) =>
      database
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN milestones m ON m.id = t.milestone_id
           ${includeDone ? "" : "WHERE t.status <> 'done'"} ${ROADMAP_ORDER}`,
        )
        .all() as unknown as Task[],

    getTask,

    listMilestones: () =>
      database
        .prepare(`SELECT ${MILESTONE_COLUMNS} FROM milestones ORDER BY position, id`)
        .all() as unknown as Milestone[],

    addMilestone: ({ title, goal }) => {
      const { lastInsertRowid } = database
        .prepare(
          "INSERT INTO milestones (title, goal, position, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM milestones), ?)",
        )
        .run(title, goal ?? null, now());
      return database
        .prepare(`SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE id = ?`)
        .get(lastInsertRowid) as unknown as Milestone;
    },

    removeMilestone: (id) => {
      requireMilestone(id);
      database.exec("BEGIN");
      database.prepare("UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?").run(id);
      database.prepare("DELETE FROM milestones WHERE id = ?").run(id);
      database.exec("COMMIT");
    },

    addTask: ({ title, description, milestoneId, spec }) => {
      if (milestoneId !== undefined) requireMilestone(milestoneId);
      const time = now();
      const { lastInsertRowid } = database
        .prepare(
          "INSERT INTO tasks (title, description, milestone_id, spec, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
        )
        .run(title, description ?? null, milestoneId ?? null, spec ?? null, time, time);
      return requireTask(Number(lastInsertRowid));
    },

    setStatus: (id, status) => {
      requireTask(id);
      database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      return requireTask(id);
    },

    removeTask: (id) => {
      requireTask(id);
      database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    },

    close: () => {
      database.close();
    },
  };
}
