/** `cclinic gui`: the local web GUI for a project (spec: gui). */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openInBrowser } from "../adapters/browser/open-browser.js";
import { createAssetReader, startGuiServer } from "../adapters/http/gui-server.js";
import { startProcess } from "../adapters/process/job-process.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { acquireGuiLock } from "../adapters/storage/gui-store.js";
import { createJobs, type JobProcess } from "../application/gui-jobs.js";
import { createGuiHandler } from "../application/gui-routes.js";
import { GUI_DEFAULT_PORT, GUI_HOST, GUI_TOKEN_BYTES, GUI_TOKEN_QUERY } from "../core/constants/gui.js";
import { UsageError } from "../core/errors.js";
import type { CommandContext } from "./command-context.js";
import { projectFolder } from "./tasks-command.js";

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
}

/** The `cclinic` entry point that started this process: `bin/cclinic.js`, from `dist` or from `src/cli`. */
function cclinicBin(): string {
  const candidates = ["../bin/cclinic.js", "../../bin/cclinic.js"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new UsageError("cclinic's own program file is missing. Reinstall cclinic.");
  return found;
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
    const handle = createGuiHandler({
      get port() {
        return port;
      },
      token,
      project: {
        name: path.basename(target),
        folder: target,
        hasDocuments: () => existsSync(projectPaths(target, undefined).out),
      },
      jobs,
      readAsset: createAssetReader(),
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
      // FR-GUI-005: the jobs are stopped first, so none is left running without the GUI.
      await jobs.stopAll();
      await server.close();
    }
  } finally {
    process.off("SIGHUP", onHangup);
    await lock.release();
  }
}
