/** The saved default model and reasoning level. It never holds keys or project data (FR-MODEL-010). */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ENV_VARS } from "../../core/constants/llm.js";
import { USER_CONFIG_BASE_FOLDER, USER_CONFIG_FILE, USER_CONFIG_FOLDER } from "../../core/constants/paths.js";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { parseEffort, parseModel, type Effort, type ModelChoice } from "../../core/models.js";

export function configFile(environment: NodeJS.ProcessEnv): string {
  const base = environment[ENV_VARS.XDG_CONFIG_HOME] ?? path.join(homedir(), USER_CONFIG_BASE_FOLDER);
  return path.join(base, USER_CONFIG_FOLDER, USER_CONFIG_FILE);
}

export interface SavedSettings {
  readonly model?: ModelChoice;
  readonly effort?: Effort;
  readonly warnings: readonly string[];
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readSavedSettings(environment: NodeJS.ProcessEnv): Promise<SavedSettings> {
  const file = configFile(environment);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return { warnings: isMissingFile(error) ? [] : [`Couldn't read ${file}, so the defaults are being used.`] };
  }
  const values = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const warnings: string[] = [];
  const read = <T>(key: string, parse: (value: string) => T | undefined): T | undefined => {
    const value = values[key];
    if (value === undefined) return undefined;
    const parsed = typeof value === "string" ? parse(value) : undefined;
    if (parsed === undefined) warnings.push(`Ignoring the saved ${key} in ${file}, because it isn't a known value.`);
    return parsed;
  };
  const model = read("model", parseModel);
  const effort = read("effort", parseEffort);
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), warnings };
}

export async function saveSettings(
  environment: NodeJS.ProcessEnv,
  settings: { readonly model: ModelChoice; readonly effort: Effort },
): Promise<void> {
  const file = configFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ model: settings.model, effort: settings.effort }, null, JSON_INDENT)}\n`);
}

export async function resetSettings(environment: NodeJS.ProcessEnv): Promise<void> {
  await rm(configFile(environment), { force: true });
}
