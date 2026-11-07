/** All terminal output. Progress goes to stderr, and results go to stdout (FR-CLI-006). */
import { appendFileSync, writeFileSync } from "node:fs";
import { ENV_VARS } from "../core/constants/llm.js";
import { ANSI } from "../core/constants/terminal.js";
import type { Logger } from "../core/ports.js";

export type ColorMode = "auto" | "always" | "never";

interface OutputStream {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** Each stream is checked separately (FR-CLI-011). */
export function isColorEnabled(mode: ColorMode, stream: OutputStream, environment: NodeJS.ProcessEnv): boolean {
  if (mode !== "auto") return mode === "always";
  const noColor = environment[ENV_VARS.NO_COLOR];
  if (noColor !== undefined && noColor !== "") return false;
  if (environment[ENV_VARS.TERM] === "dumb") return false;
  return stream.isTTY === true;
}

export interface ReporterOptions {
  readonly quiet: boolean;
  readonly debug: boolean;
  readonly debugFile?: string;
  readonly color: ColorMode;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly now?: () => number;
}

export interface Reporter extends Logger {
  /** Goes to stderr even under --quiet, because it's needed to answer a prompt. */
  notice(message: string): void;
  error(message: string): void;
  result(message: string): void;
  bold(text: string): string;
}

const paint = (isEnabled: boolean, code: number, text: string): string =>
  isEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;

export function createReporter(options: ReporterOptions): Reporter {
  const { stdout, stderr, quiet, environment, color } = options;
  const isErrColored = isColorEnabled(color, stderr, environment);
  const isOutColored = isColorEnabled(color, stdout, environment);
  const now = options.now ?? Date.now;
  const start = now();
  const isDebug = options.debug || options.debugFile !== undefined;
  if (options.debugFile !== undefined) writeFileSync(options.debugFile, "");

  const debug = (message: string): void => {
    if (!isDebug) return;
    const line = `[+${now() - start}ms] ${message}\n`;
    if (options.debug) stderr.write(paint(isErrColored, ANSI.DIM, line));
    if (options.debugFile !== undefined) appendFileSync(options.debugFile, line);
  };

  return {
    info(message) {
      debug(message);
      if (!quiet) stderr.write(`${message}\n`);
    },
    warn(message) {
      debug(`warning: ${message}`);
      if (!quiet) stderr.write(`${paint(isErrColored, ANSI.YELLOW, "Warning:")} ${message}\n`);
    },
    debug,
    notice(message) {
      stderr.write(`${message}\n`);
    },
    error(message) {
      debug(`error: ${message}`);
      stderr.write(`${paint(isErrColored, ANSI.RED, "Error:")} ${message}\n`);
    },
    result(message) {
      stdout.write(`${message}\n`);
    },
    bold: (text) => paint(isOutColored, ANSI.BOLD, text),
  };
}
