/** The newest Claude plan limits luseen saw, kept next to the saved model (automated-mode FR-AUTO-041). */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS_FILE } from "../../core/constants/paths.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { planLimitsSchema, type PlanLimits } from "../../core/limits.js";
import { configFile } from "./user-config.js";

export function limitsFile(environment: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(configFile(environment)), LIMITS_FILE);
}

async function writePlanLimits(environment: NodeJS.ProcessEnv, limits: PlanLimits): Promise<void> {
  const file = limitsFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(planLimitsSchema.parse(limits), null, JSON_INDENT)}\n`);
  await rename(temporary, file);
}

let saving: Promise<void> = Promise.resolve();

/**
 * Written to its own temporary file and renamed, so a reader never sees half of it. Agents running side by side
 * report at about the same time, so saves run one after another, and the newest report is the one that stays.
 */
export function savePlanLimits(environment: NodeJS.ProcessEnv, limits: PlanLimits): Promise<void> {
  const saved = saving.then(() => writePlanLimits(environment, limits));
  saving = saved.catch(() => undefined);
  return saved;
}

/** FR-GUI-083: the saved limits, or null when there are none yet or the file can't be used. */
export async function readPlanLimits(environment: NodeJS.ProcessEnv): Promise<PlanLimits | null> {
  let text: string;
  try {
    text = await readFile(limitsFile(environment), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = planLimitsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    // Not JSON, such as a file being replaced by hand: no limits are known, as before the first agent call.
    return null;
  }
}
