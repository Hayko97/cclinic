/** A new project's ports for a folder (spec: roadmap-planning FR-PLAN-047 to FR-PLAN-057), shared by the terminal and the GUI. */
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { scanFolder } from "../adapters/discovery/file-walker.js";
import { startProcess } from "../adapters/process/job-process.js";
import { approveDesignSystem } from "../adapters/storage/design-store.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { writeProjectBrief } from "../adapters/storage/project-files.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import type { ProjectPorts } from "../application/new-project.js";
import type { PlanRecords } from "../application/planning-session.js";
import { DESIGN_FOLDER } from "../core/constants/design.js";
import { LIMITS } from "../core/constants/limits.js";
import { DESIGN_SYSTEM_PATH } from "../core/design.js";
import { AgentSessionError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import { projectDesignArgs, projectSpecsArgs, type PlanSession } from "../core/planning.js";
import type { CommandContext } from "./command-context.js";
import { luseenBin } from "./luseen-bin.js";
import { SPECS_FOLDER_NAME } from "../core/constants/paths.js";
import { readPlanningContext } from "./planning-ports.js";

/** FR-PLAN-047: no `.luseen/sdd`, and nothing for file discovery to analyse. */
export async function isEmptyProject(target: string): Promise<boolean> {
  const { out } = projectPaths(target, undefined);
  if (existsSync(out)) return false;
  const scan = await scanFolder({
    target,
    outFolder: out,
    include: [],
    exclude: [],
    maxFileSizeMib: LIMITS.maxFileSizeMib.default,
  });
  return scan.included.length === 0;
}

/** The newest roadmap's tasks, in milestone order: a new project's first roadmap (FR-PLAN-055). */
function newestRoadmapTasks(target: string) {
  const roadmap = readPlanningContext(target).overview.roadmaps.at(-1);
  return roadmap?.milestones.flatMap((milestone) => milestone.tasks) ?? [];
}

/** The open new-project session, if any (FR-PLAN-048). */
export async function openNewProjectSession(records: Pick<PlanRecords, "list">): Promise<PlanSession | undefined> {
  const { sessions } = await records.list();
  return sessions.find((session) => session.status === "open" && session.target.kind === "new-project");
}

/**
 * FR-GUI-090: once a new project's setup is done, its first task, until work on its roadmap has started.
 */
export async function newProjectTask(target: string, records: PlanRecords): Promise<number | null> {
  const { sessions } = await records.list();
  const isSetUp = sessions.some(
    (session) => session.target.kind === "new-project" && session.project?.phase === "done",
  );
  if (!isSetUp) return null;
  const tasks = newestRoadmapTasks(target);
  return tasks.every((task) => task.status === "open") ? (tasks[0]?.id ?? null) : null;
}

/** How the specs and the design step run: as a child process in the terminal, or as a job in the GUI. */
export interface ProjectSteps {
  writeSpecs(): Promise<void>;
  writeDesign(): Promise<void>;
}

export function projectPorts(target: string, records: PlanRecords, steps: ProjectSteps): ProjectPorts {
  const { out } = projectPaths(target, undefined);
  return {
    records,
    now: () => new Date().toISOString(),
    writeBrief: (markdown, attachments) => writeProjectBrief(target, markdown, attachments),
    hasDocuments: () => existsSync(out),
    writeSpecs: () => steps.writeSpecs(),
    specs: () => {
      const folder = path.join(out, SPECS_FOLDER_NAME);
      const names = existsSync(folder)
        ? readdirSync(folder, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        : [];
      return { folder: relativeDocsPath(target, out), names };
    },
    writeDesign: () => steps.writeDesign(),
    hasDesign: () => existsSync(path.join(target, DESIGN_SYSTEM_PATH)),
    approveDesign: () => approveDesignSystem(target),
    discardDesign: () => rm(path.join(target, DESIGN_FOLDER), { recursive: true, force: true }),
    firstOpenTaskId: () => newestRoadmapTasks(target).find((task) => task.status === "open")?.id ?? null,
  };
}

/** Runs `luseen` in the project with its output shown as it comes; Ctrl+C stops it too. */
function runLuseen(target: string, args: readonly string[], context: CommandContext): Promise<number> {
  const child = startProcess(process.execPath, [luseenBin(), ...args], {
    cwd: target,
    environment: context.environment,
  });
  const stop = (): void => {
    child.signal("SIGINT");
  };
  context.signal.addEventListener("abort", stop, { once: true });
  child.onOutput((stream, chunk) => {
    (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
  });
  return new Promise((resolve) => {
    child.onExit((exitCode) => {
      context.signal.removeEventListener("abort", stop);
      resolve(exitCode);
    });
  });
}

/** FR-PLAN-057: in the terminal, the specs and the design step print their progress as `luseen` does. */
export function terminalSteps(
  target: string,
  settings: { readonly model: ModelChoice; readonly effort: Effort },
  context: CommandContext,
): ProjectSteps {
  const run = async (args: readonly string[], what: string): Promise<void> => {
    const exitCode = await runLuseen(target, args, context);
    if (exitCode !== 0)
      throw new AgentSessionError(`${what} stopped (exit code ${exitCode}), so the setup waits here.`);
  };
  return {
    writeSpecs: () => run(projectSpecsArgs(settings.model, settings.effort), "Writing the specs"),
    writeDesign: () => run(projectDesignArgs(settings.model, settings.effort), "The design step"),
  };
}
