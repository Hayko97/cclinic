/** `cclinic gui`: the local web GUI for a project (spec: gui). */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openInBrowser } from "../adapters/browser/open-browser.js";
import { claudeConfigFolder, claudeTranscriptPath } from "../adapters/llm/agent-process.js";
import { isProcessRunning } from "../adapters/storage/file-lock.js";
import { createAssetReader, startGuiServer } from "../adapters/http/gui-server.js";
import { startProcess } from "../adapters/process/job-process.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { readPlanLimits } from "../adapters/config/limits-store.js";
import { plansFolder } from "../adapters/storage/plan-store.js";
import { acquireGuiLock, readLayout, readMcpConfig, saveLayout } from "../adapters/storage/gui-store.js";
import { createRunLister, readRunFiles } from "../adapters/storage/run-store.js";
import { openTaskStore } from "../adapters/storage/task-store.js";
import { openWorkflowStore } from "../adapters/storage/workflow-store.js";
import {
  locateTranscript,
  readTranscriptLines,
  readTranscriptTail,
} from "../adapters/transcripts/transcript-reader.js";
import { problemOf, type CanvasPorts } from "../application/gui-canvas.js";
import { createJobs, type JobProcess } from "../application/gui-jobs.js";
import { createPlanner, type PlannerPorts } from "../application/gui-planning.js";
import { createGuiHandler } from "../application/gui-routes.js";
import { GUI_DEFAULT_PORT, GUI_HOST, GUI_TOKEN_BYTES, GUI_TOKEN_QUERY } from "../core/constants/gui.js";
import { PLAN_ATTACHMENTS_FOLDER } from "../core/constants/agents.js";
import { UsageError } from "../core/errors.js";
import { LIMITS } from "../core/constants/limits.js";
import { cclinicBin } from "./cclinic-bin.js";
import { resolveModelAndEffort } from "./generate-command.js";
import { checkPlanning, pmSkill } from "./plan-command.js";
import { decisionPorts, documentPaths, planStoreFor, transcriptChecks, turnPorts } from "./planning-ports.js";
import type { CommandContext } from "./command-context.js";
import { projectFolder, readOverview } from "./tasks-command.js";

export interface GuiOptions {
  readonly dir?: string;
  readonly port?: number;
  readonly open: boolean;
  readonly json?: boolean;
}

export interface GuiDependencies {
  /** Starts `cclinic` with these arguments in the project; replaced in tests. */
  readonly startJob?: (args: readonly string[], cwd: string) => JobProcess;
  /** Whether stdout is a terminal, so a person is there to see the browser open (FR-GUI-004). */
  readonly isTerminal?: boolean;
  /** How the canvas and transcripts are checked for changes; replaced in tests, so no real clock is used. */
  readonly every?: (ms: number, run: () => Promise<void>) => () => void;
}

function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), ms);
  return () => {
    clearInterval(timer);
  };
}

/** Whether `cclinic` has generated the project's documents (FR-GUI-014, FR-GUI-053). */
function documentsCheck(target: string): () => boolean {
  return () => existsSync(projectPaths(target, undefined).out);
}

/** FR-GUI-019, FR-GUI-037, FR-GUI-039: what the canvas is built from, and where transcripts are read. */
function canvasPorts(
  target: string,
  environment: NodeJS.ProcessEnv,
  repeat: (ms: number, run: () => Promise<void>) => () => void,
): CanvasPorts {
  let layoutChanges: Promise<unknown> = Promise.resolve();
  const listRuns = createRunLister(target);
  return {
    readSources: async () => {
      const problems: string[] = [];
      const note = (error: unknown): void => {
        problems.push(problemOf(error));
      };
      let overview = readOverview(undefined);
      try {
        const store = openTaskStore(projectPaths(target, undefined).tool, "read");
        try {
          overview = readOverview(store);
        } finally {
          store?.close();
        }
      } catch (error) {
        note(error);
      }
      const workflows = await openWorkflowStore(target).listReadable();
      for (const problem of workflows.problems) note(new Error(problem));
      const runs = await listRuns().catch((error: unknown) => {
        note(error);
        return { runs: [], problems: [] };
      });
      for (const problem of runs.problems) note(new Error(problem));
      return { overview, runs: runs.runs, workflows: workflows.states, problems };
    },
    readLayout: () => readLayout(target),
    hasDocuments: documentsCheck(target),
    updateLayout: (change) => {
      // One change at a time: a drag saved during Tidy up isn't overwritten by Tidy's older copy.
      const next = layoutChanges.then(async () => saveLayout(target, change(await readLayout(target))));
      layoutChanges = next.catch(() => undefined);
      return next;
    },
    locateTranscript: (session) =>
      locateTranscript(session.transcriptPath, session.id, path.join(claudeConfigFolder(environment), "projects")),
    readTranscript: readTranscriptLines,
    readTranscriptTail,
    readLimits: () => readPlanLimits(environment),
    now: () => new Date(),
    every: repeat,
  };
}

function waitForStop(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
}

/**
 * FR-GUI-023, FR-PLAN-033: the Plan panel's planner, with the same checks, options, defaults and PM as
 * `cclinic plan`. A turn's PM is stopped by its own signal (Stop) as well as by the GUI stopping.
 */
function plannerPorts(
  target: string,
  context: CommandContext,
  repeat: (ms: number, run: () => Promise<void>) => () => void,
): PlannerPorts {
  const records = planStoreFor(target);
  const checks = transcriptChecks();
  // Made once, private to this user (mkdtemp gives 0700), on the first upload, and removed when the GUI stops.
  let uploadFolder: Promise<string> | undefined;
  const folder = (): Promise<string> => (uploadFolder ??= mkdtemp(path.join(os.tmpdir(), "cclinic-plan-uploads-")));
  return {
    prepare: async (options) => {
      await checkPlanning(target, context);
      const { model, effort } = await resolveModelAndEffort({ model: options.model, effort: options.effort }, context);
      const settings = {
        target,
        model,
        effort,
        timeoutMinutes: options.timeoutMinutes ?? LIMITS.timeoutMinutes.default,
      };
      return (signal) =>
        turnPorts(settings, records, { ...context, signal: AbortSignal.any([context.signal, signal]) });
    },
    records,
    decisions: decisionPorts(target, records),
    pmContext: () => ({ skill: pmSkill(target), ...documentPaths(target) }),
    newClaudeSession: () => {
      const claudeSessionId = randomUUID();
      return { claudeSessionId, transcriptPath: claudeTranscriptPath(context.environment, target, claudeSessionId) };
    },
    isRunning: isProcessRunning,
    pid: process.pid,
    now: () => new Date().toISOString(),
    transcriptExists: (transcriptPath) => existsSync(transcriptPath),
    isAnswered: checks.isAnswered,
    isWritten: checks.isWritten,
    readAttachment: async (planId, file) => {
      const folder = path.resolve(plansFolder(target), planId, PLAN_ATTACHMENTS_FOLDER);
      const resolved = path.resolve(folder, file);
      // Only a file directly in the session's attachments folder is ever read.
      if (path.dirname(resolved) !== folder) throw new UsageError("That isn't one of the session's files.");
      return readFile(resolved);
    },
    // Uploaded files wait outside the project until their message is sent, and are removed then (FR-PLAN-033).
    uploads: {
      save: async (bytes) => {
        const file = path.join(await folder(), randomUUID());
        await writeFile(file, bytes, { mode: 0o600 });
        return file;
      },
      remove: (file) => rm(file, { force: true }),
      clear: async () => {
        if (uploadFolder === undefined) return;
        await rm(await uploadFolder, { recursive: true, force: true });
        uploadFolder = undefined;
      },
    },
    transcripts: {
      locate: (transcriptPath, claudeSessionId) =>
        locateTranscript(
          transcriptPath,
          claudeSessionId,
          path.join(claudeConfigFolder(context.environment), "projects"),
        ),
      read: readTranscriptLines,
    },
    every: repeat,
  };
}

/** FR-GUI-001 to FR-GUI-007: serves the GUI on this machine until Ctrl+C or SIGTERM. */
export async function runGuiCommand(
  given: string | undefined,
  options: GuiOptions,
  context: CommandContext,
  dependencies: GuiDependencies = {},
): Promise<void> {
  const target = await projectFolder(options.dir ?? given);
  const lock = await acquireGuiLock(target);
  // Closing the terminal stops the GUI as SIGTERM does, so its jobs, which no longer get the terminal's
  // signals, are stopped too (FR-GUI-036).
  const onHangup = (): void => {
    process.kill(process.pid, "SIGTERM");
  };
  process.on("SIGHUP", onHangup);
  try {
    const startJob =
      dependencies.startJob ??
      ((args: readonly string[], cwd: string) =>
        startProcess(process.execPath, [cclinicBin(), ...args], { cwd, environment: context.environment }));
    const jobs = createJobs({
      start: (args) => startJob(args, target),
      now: () => new Date(),
      later: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
    });
    // FR-GUI-003: a new token each time the GUI starts, never saved anywhere.
    const token = randomBytes(GUI_TOKEN_BYTES).toString("base64url");
    let port = 0;
    const planner = createPlanner(plannerPorts(target, context, dependencies.every ?? every));
    const handle = createGuiHandler({
      get port() {
        return port;
      },
      token,
      project: {
        name: path.basename(target),
        folder: target,
        hasDocuments: documentsCheck(target),
        readMcpConfig: () => readMcpConfig(target),
      },
      jobs,
      readAsset: createAssetReader(),
      canvas: canvasPorts(target, context.environment, dependencies.every ?? every),
      answers: { update: (key, decide) => openWorkflowStore(target).update(key, decide), now: () => new Date() },
      readRunFiles: (runId) => readRunFiles(target, runId),
      planner,
    });
    const server = await startGuiServer({
      host: GUI_HOST,
      port: options.port ?? GUI_DEFAULT_PORT,
      isPortFixed: options.port !== undefined,
      handle,
    });
    port = server.port;
    try {
      await lock.setPort(port);
      const url = `http://${GUI_HOST}:${port}/?${GUI_TOKEN_QUERY}=${token}`;
      context.reporter.info(`cclinic GUI for ${target}. Press Ctrl+C to stop.`);
      context.reporter.result(options.json === true ? JSON.stringify({ url, port }) : url);
      if (options.open && (dependencies.isTerminal ?? process.stdout.isTTY)) {
        await openInBrowser(url, context.environment).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          context.reporter.warn(`Couldn't open your browser (${reason}). Open the link above instead.`);
        });
      }
      await waitForStop(context.signal);
    } finally {
      // FR-GUI-005: the jobs are stopped first, so none is left running without the GUI. A planning session
      // still going saves nothing (FR-GUI-025).
      await Promise.all([jobs.stopAll(), planner.shutdown()]);
      await server.close();
    }
  } finally {
    process.off("SIGHUP", onHangup);
    await lock.release();
  }
}
