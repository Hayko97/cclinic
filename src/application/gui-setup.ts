/** Setup from the GUI: generate's questions, from a dry run the GUI runs as a job (spec: gui, FR-GUI-016). */
import { UsageError } from "../core/errors.js";
import type { GenerateOptions } from "../core/gui.js";
import { dryRunSchema, generateQuestions, type SetupQuestion } from "../core/gui-setup.js";
import type { Jobs, JobView } from "./gui-jobs.js";

export function ended(jobs: Jobs, id: string): Promise<JobView> {
  const waiting = jobs.whenEnded(id);
  if (waiting === undefined) throw new UsageError(`The dry run (${id}) is no longer known to the GUI.`);
  return waiting;
}

/** The last line of output that is a JSON object, which is what a `--json` command prints as its result. */
export function resultOf(job: JobView): unknown {
  for (const line of [...job.output.lines].reverse()) {
    if (line.stream !== "stdout") continue;
    try {
      const parsed: unknown = JSON.parse(line.text);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // Not JSON: progress text before the result.
    }
  }
  return undefined;
}

/** The CLI's own message when a dry run was refused, or why it gave no result (FR-GUI-016, FR-GUI-028). */
export function refusalOf(job: JobView, result: unknown): string {
  return typeof result === "object" && result !== null && "message" in result && typeof result.message === "string"
    ? result.message
    : `The dry run didn't finish: ${job.exitMeaning ?? "no result"}.`;
}

export interface GenerateQuestions {
  readonly preview: string;
  readonly questions: readonly SetupQuestion[];
}

/**
 * FR-GUI-016: runs `luseen --dry-run --json` with the form's options, which uses no Claude usage, and turns its
 * summary into the questions the CLI would ask. A dry run the CLI refuses is refused with its own message.
 */
export async function askGenerate(jobs: Jobs, options: GenerateOptions): Promise<GenerateQuestions> {
  const job = await ended(jobs, jobs.start({ command: "generate-preview", options }).id);
  const result = resultOf(job);
  const dryRun = dryRunSchema.safeParse(result);
  if (job.exitCode !== 0 || !dryRun.success) throw new UsageError(refusalOf(job, result));
  return { preview: job.id, questions: generateQuestions(options, dryRun.data) };
}
