/** The `tasks` commands: the roadmap and its tasks, with no Claude usage (spec: task-tracking). */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { projectPaths } from "../adapters/storage/document-store.js";
import { openTaskStore, type OpenMode, type TaskStore } from "../adapters/storage/task-store.js";
import { UsageError } from "../core/errors.js";
import {
  buildRoadmap,
  milestoneInputSchema,
  parseId,
  parseInput,
  renderRoadmap,
  renderTask,
  renderTaskList,
  taskInputSchema,
  type TaskStatus,
} from "../core/tasks.js";
import type { CommandContext } from "./command-context.js";
import { commandHelp } from "./guide.js";

interface TasksOptions {
  readonly dir?: string;
  readonly json?: boolean;
}

async function toolFolder(dir: string | undefined): Promise<string> {
  const absolute = path.resolve(dir ?? process.cwd());
  const isFolder = await stat(absolute).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isFolder) throw new UsageError(`"${dir ?? absolute}" isn't a folder.`);
  return projectPaths(absolute, undefined).tool;
}

/** Runs one command against the store, then prints text or JSON (FR-TASK-013). */
async function withStore(
  options: TasksOptions,
  mode: OpenMode,
  context: CommandContext,
  run: (store: TaskStore | undefined) => { readonly text: string; readonly json: Record<string, unknown> },
): Promise<void> {
  const store = openTaskStore(await toolFolder(options.dir), mode);
  try {
    const output = run(store);
    context.reporter.result(
      options.json === true ? JSON.stringify({ status: "success", ...output.json }) : output.text,
    );
  } finally {
    store?.close();
  }
}

/** With no database, nothing the user names can exist, so it's reported like a missing ID (FR-TASK-011). */
function requireStore(store: TaskStore | undefined, missing: string): TaskStore {
  if (store === undefined) throw new UsageError(`${missing} doesn't exist.`);
  return store;
}

function withCommonOptions(command: Command, example: string): Command {
  return command
    .option("-C, --dir <path>", "project folder (default: the current folder)")
    .option("--json", "print JSON")
    .addHelpText("after", commandHelp(`cclinic tasks ${command.name()}`, example));
}

export function addTasksCommand(program: Command, context: CommandContext): void {
  const tasks = program
    .command("tasks")
    .description("Plan the roadmap and track tasks, without using any Claude usage");

  withCommonOptions(
    tasks.command("list").description("List open and in-progress tasks in roadmap order"),
    "cclinic tasks list --all --json",
  )
    .option("--all", "include done tasks")
    .action(async (options: TasksOptions & { all?: boolean }) => {
      await withStore(options, "read", context, (store) => {
        const found = store?.listTasks(options.all === true) ?? [];
        return { text: renderTaskList(found), json: { tasks: found } };
      });
    });

  withCommonOptions(
    tasks.command("roadmap").description("Show milestones in order, with their tasks"),
    "cclinic tasks roadmap --json",
  ).action(async (options: TasksOptions) => {
    await withStore(options, "read", context, (store) => {
      const roadmap = buildRoadmap(store?.listMilestones() ?? [], store?.listTasks(true) ?? []);
      return { text: renderRoadmap(roadmap), json: { ...roadmap } };
    });
  });

  withCommonOptions(
    tasks.command("show").description("Show every detail of a task").argument("<id>", "task ID"),
    "cclinic tasks show 3 --json",
  ).action(async (given: string, options: TasksOptions) => {
    const id = parseId(given, "task");
    await withStore(options, "read", context, (store) => {
      const task = store?.getTask(id);
      if (task === undefined) throw new UsageError(`Task ${id} doesn't exist.`);
      const milestone = store?.listMilestones().find((item) => item.id === task.milestoneId);
      return { text: renderTask(task, milestone), json: { task } };
    });
  });

  withCommonOptions(
    tasks
      .command("add")
      .description("Add a task")
      .requiredOption("--title <text>", "what the task delivers")
      .option("--description <text>", "details and acceptance notes")
      .option("--milestone <id>", "milestone it belongs to")
      .option("--spec <name>", "spec it belongs to, such as user-login"),
    'cclinic tasks add --title "Lock accounts" --milestone 1 --spec auth --json',
  ).action(
    async (options: TasksOptions & { title: string; description?: string; milestone?: string; spec?: string }) => {
      const input = parseInput(taskInputSchema, {
        title: options.title,
        description: options.description,
        milestoneId: options.milestone === undefined ? undefined : parseId(options.milestone, "milestone"),
        spec: options.spec,
      });
      await withStore(options, "create", context, (store) => {
        const task = requireStore(store, "The task database").addTask(input);
        return { text: `Added task ${task.id}: ${task.title}`, json: { task } };
      });
    },
  );

  const statusCommands: readonly (readonly [string, TaskStatus, string])[] = [
    ["start", "in-progress", "Mark a task as in progress"],
    ["done", "done", "Mark a task as done"],
  ];
  for (const [name, status, description] of statusCommands) {
    withCommonOptions(
      tasks.command(name).description(description).argument("<id>", "task ID"),
      `cclinic tasks ${name} 3`,
    ).action(async (given: string, options: TasksOptions) => {
      const id = parseId(given, "task");
      await withStore(options, "update", context, (store) => {
        const task = requireStore(store, `Task ${id}`).setStatus(id, status);
        return { text: `Task ${task.id} is ${task.status}: ${task.title}`, json: { task } };
      });
    });
  }

  withCommonOptions(
    tasks.command("remove").description("Delete a task permanently").argument("<id>", "task ID"),
    "cclinic tasks remove 3",
  ).action(async (given: string, options: TasksOptions) => {
    const id = parseId(given, "task");
    await withStore(options, "update", context, (store) => {
      requireStore(store, `Task ${id}`).removeTask(id);
      return { text: `Removed task ${id}.`, json: { removed: id } };
    });
  });

  const milestone = tasks.command("milestone").description("Add or remove roadmap milestones");

  withCommonOptions(
    milestone
      .command("add")
      .description("Add a milestone after the existing ones")
      .requiredOption("--title <text>", "milestone name")
      .option("--goal <text>", "what it achieves"),
    'cclinic tasks milestone add --title MVP --goal "First release" --json',
  ).action(async (options: TasksOptions & { title: string; goal?: string }) => {
    const input = parseInput(milestoneInputSchema, { title: options.title, goal: options.goal });
    await withStore(options, "create", context, (store) => {
      const added = requireStore(store, "The task database").addMilestone(input);
      return { text: `Added milestone ${added.id}: ${added.title}`, json: { milestone: added } };
    });
  });

  withCommonOptions(
    milestone
      .command("remove")
      .description("Delete a milestone. Its tasks are kept, with no milestone")
      .argument("<id>", "milestone ID"),
    "cclinic tasks milestone remove 2",
  ).action(async (given: string, options: TasksOptions) => {
    const id = parseId(given, "milestone");
    await withStore(options, "update", context, (store) => {
      requireStore(store, `Milestone ${id}`).removeMilestone(id);
      return { text: `Removed milestone ${id}. Its tasks have no milestone now.`, json: { removed: id } };
    });
  });
}
