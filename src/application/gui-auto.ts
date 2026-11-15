/** Run with AI from the GUI: the plan from a dry run, shown before the run starts (spec: gui, FR-GUI-027). */
import { UsageError } from "../core/errors.js";
import { autoPlanSchema, type AutoOptions, type AutoPlan } from "../core/gui.js";
import type { Jobs } from "./gui-jobs.js";
import { ended, refusalOf, resultOf } from "./gui-setup.js";

/**
 * FR-GUI-027, FR-GUI-028: runs `luseen auto --dry-run --json` with the form's options, which starts nothing, and
 * returns the plan `luseen auto` would show. A run the CLI would refuse is refused with its own message.
 */
export async function askAuto(jobs: Jobs, options: AutoOptions): Promise<AutoPlan> {
  const job = await ended(jobs, jobs.start({ command: "auto-preview", options }).id);
  const result = resultOf(job);
  const plan = autoPlanSchema.safeParse(result);
  if (job.exitCode !== 0 || !plan.success) throw new UsageError(refusalOf(job, result));
  return plan.data;
}
