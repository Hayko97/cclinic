/** The `tasks` commands: the roadmap and its tasks, with no Claude usage (spec: task-tracking). */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { projectPaths } from "../adapters/storage/document-store.js";
import { openTaskStore, type OpenMode, type TaskStore } from "../adapters/storage/task-store.js";
import { UsageError } from "../core/errors.js";
import {
  buildOverview,
  buildRoadmap,
  parseId,
  parseInput,
  PLAN_HINT,
  renderOverview,
  renderRoadmap,
  renderRoadmapList,
  renderTask,
  renderTaskList,
  summarizeRoadmap,
  taskInputSchema,
  type TaskStatus,
} from "../core/tasks.js";
import type { CommandContext } from "./command-context.js";
import { commandHelp } from "./guide.js";
import { collect } from "./options.js";

interface TasksOptions {
  readonly dir?: string;
  readonly json?: boolean;
}

/** The project folder for `-C, --dir`, defaulting to the current folder (FR-TASK-014). */
export async function projectFolder(dir: string | undefined): Promise<string> {
  const absolute = path.resolve(dir ?? process.cwd());
  const isFolder = await stat(absolute).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isFolder) throw new UsageError(`"${dir ?? absolute}" isn't a folder.`);
  return absolute;
}

async function toolFolder(dir: string | undefined): Promise<string> {
  return projectPaths(await projectFolder(dir), undefined).tool;
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

/** Creating roadmaps and milestones is left to the PM agent (FR-TASK-003, FR-TASK-023). */
function addPlanOnlyCommand(parent: Command, name: string, what: string, context: CommandContext): void {
  withCommonOptions(
    parent.command(name).description(`${what} (use cclinic plan instead)`).allowUnknownOption().allowExcessArguments(),
    "cclinic plan",
  ).action(() => {
    context.reporter.debug(`Refused tasks ${parent.name()} ${name}.`);
    throw new UsageError(`${what} isn't available here. ${PLAN_HINT}`);
  });
}

export function readOverview(store: TaskStore | undefined) {
  return buildOverview(store?.listRoadmaps() ?? [], store?.listMilestones() ?? [], store?.listTasks(true) ?? []);
}

export function addTasksCommand(program: Command, context: CommandContext): void {
  const tasks = program.command("tasks").description("See roadmaps and track tasks, without using any Claude usage");

  withCommonOptions(
    tasks.command("list").description("List open, in-progress and blocked tasks in roadmap order"),
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
    tasks.command("roadmaps").description("List every roadmap with its status and task counts"),
    "cclinic tasks roadmaps --json",
  ).action(async (options: TasksOptions) => {
    await withStore(options, "read", context, (store) => {
      const summaries = readOverview(store).roadmaps.map(summarizeRoadmap);
      return { text: renderRoadmapList(summaries), json: { roadmaps: summaries } };
    });
  });

  const roadmap = withCommonOptions(
    tasks.command("roadmap").description("Show every roadmap in full, then tasks with no milestone"),
    "cclinic tasks roadmap --json",
  ).action(async (options: TasksOptions) => {
    await withStore(options, "read", context, (store) => {
      const overview = readOverview(store);
      return { text: renderOverview(overview), json: { ...overview } };
    });
  });

  withCommonOptions(
    roadmap.command("show").description("Show one roadmap's milestones and tasks").argument("<id>", "roadmap ID"),
    "cclinic tasks roadmap show 1 --json",
  ).action(async (given: string, options: TasksOptions) => {
    const id = parseId(given, "roadmap");
    await withStore(options, "read", context, (store) => {
      const record = store?.listRoadmaps().find((item) => item.id === id);
      if (record === undefined) throw new UsageError(`Roadmap ${id} doesn't exist.`);
      const found = buildRoadmap(record, store?.listMilestones() ?? [], store?.listTasks(true) ?? []);
      return { text: renderRoadmap(found), json: { roadmap: found } };
    });
  });

  withCommonOptions(
    roadmap
      .command("remove")
      .description("Delete a roadmap and its milestones. Their tasks are kept, with no milestone")
      .argument("<id>", "roadmap ID"),
    "cclinic tasks roadmap remove 2",
  ).action(async (given: string, options: TasksOptions) => {
    const id = parseId(given, "roadmap");
    await withStore(options, "update", context, (store) => {
      requireStore(store, `Roadmap ${id}`).removeRoadmap(id);
      return { text: `Removed roadmap ${id}. Its tasks have no milestone now.`, json: { removed: id } };
    });
  });

  addPlanOnlyCommand(roadmap, "add", "Creating a roadmap", context);

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
      .description("Add a task with no milestone. Use cclinic plan --task to add one to a roadmap")
      .requiredOption("--title <text>", "what the task delivers")
      .option("--description <text>", "details and acceptance notes")
      .option("--spec <name>", "spec it belongs to, such as user-login")
      .option("--depends-on <id>", "a task that must be done first. Repeatable", collect, [])
      .option("--milestone <id>", "not available: use cclinic plan --task"),
    'cclinic tasks add --title "Lock accounts" --spec auth --depends-on 2 --json',
  ).action(
    async (
      options: TasksOptions & {
        title: string;
        description?: string;
        spec?: string;
        dependsOn: readonly string[];
        milestone?: string;
      },
    ) => {
      if (options.milestone !== undefined) {
        throw new UsageError(`A task joins a roadmap's milestone only through cclinic plan --task. ${PLAN_HINT}`);
      }
      const input = parseInput(taskInputSchema, {
        title: options.title,
        description: options.description,
        spec: options.spec,
        dependsOn: options.dependsOn.map((value) => parseId(value, "task")),
      });
      await withStore(options, "create", context, (store) => {
        const task = requireStore(store, "The task database").addTask(input);
        return { text: `Added task ${task.id}: ${task.title}`, json: { task } };
      });
    },
  );

  const dependencyCommands = [
    ["depend", "Make a task depend on another", "addDependency", "now depends on"],
    ["undepend", "Remove a dependency between two tasks", "removeDependency", "no longer depends on"],
  ] as const;
  for (const [name, description, method, verb] of dependencyCommands) {
    withCommonOptions(
      tasks
        .command(name)
        .description(description)
        .argument("<id>", "task ID")
        .requiredOption("--on <id>", "the task it depends on"),
      `cclinic tasks ${name} 3 --on 2`,
    ).action(async (given: string, options: TasksOptions & { on: string }) => {
      const id = parseId(given, "task");
      const dependsOnId = parseId(options.on, "task");
      await withStore(options, "update", context, (store) => {
        const task = requireStore(store, `Task ${id}`)[method](id, dependsOnId);
        return { text: `Task ${id} ${verb} task ${dependsOnId}.`, json: { task } };
      });
    });
  }

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

  const milestone = tasks.command("milestone").description("Remove roadmap milestones");

  addPlanOnlyCommand(milestone, "add", "Creating a milestone", context);

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
