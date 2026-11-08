/** What every command receives from the entry point. */
import type { Reporter } from "./reporter.js";

export interface CommandContext {
  readonly reporter: Reporter;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly version: string;
}
