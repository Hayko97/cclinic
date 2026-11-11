/** Starts one child process for a GUI job, with an argument array and no shell (FR-GUI-013, FR-GUI-033). */
import { spawn, type ChildProcess } from "node:child_process";
import { EXIT_CODES } from "../../core/errors.js";
import type { OutputStream } from "../../core/gui.js";

export interface StartedProcess {
  onOutput(listener: (stream: OutputStream, chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  signal(name: "SIGINT" | "SIGTERM"): void;
}

/** Jobs still running, which are stopped if the GUI's process exits before it could stop them itself. */
const running = new Set<ChildProcess>();
let isExitHandlerAdded = false;

/** FR-GUI-033: run when the GUI's process exits. Jobs run in their own process group, so nothing else would stop them. */
export function stopRunningJobs(): void {
  for (const job of running) job.kill("SIGTERM");
}

function stopOnExit(child: ChildProcess): void {
  running.add(child);
  child.on("close", () => running.delete(child));
  if (isExitHandlerAdded) return;
  isExitHandlerAdded = true;
  process.on("exit", stopRunningJobs);
}

const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: EXIT_CODES.sigint,
  SIGTERM: EXIT_CODES.sigterm,
};

export function startProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): StartedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    // Its own process group, so Ctrl+C in the GUI's terminal reaches only the GUI, which then stops the
    // job once. A second SIGINT would make cclinic exit at once, skipping its own clean stop. Windows has
    // no process groups, and there it would only open a console window.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  stopOnExit(child);
  const outputListeners: ((stream: OutputStream, chunk: string) => void)[] = [];
  const exitListeners: ((exitCode: number) => void)[] = [];
  let hasExited = false;
  const exit = (exitCode: number): void => {
    if (hasExited) return;
    hasExited = true;
    for (const listener of exitListeners) listener(exitCode);
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      for (const listener of outputListeners) listener(stream, chunk);
    });
  }
  child.on("error", (error) => {
    for (const listener of outputListeners) listener("stderr", `Couldn't start the command: ${error.message}\n`);
    exit(EXIT_CODES.internal);
  });
  child.on("close", (code, signal) => {
    exit(code ?? (signal === null ? EXIT_CODES.internal : (SIGNAL_EXIT_CODES[signal] ?? EXIT_CODES.internal)));
  });
  return {
    onOutput: (listener) => outputListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    signal: (name) => {
      if (!hasExited) child.kill(name);
    },
  };
}
