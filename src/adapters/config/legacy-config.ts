/** Copies the saved settings cclinic kept over to Luseen's config folder (FR-CLI-036). */
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { LEGACY_NAME, LIMITS_FILE, USER_CONFIG_FILE } from "../../core/constants/paths.js";
import { configFile } from "./user-config.js";

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

/** The folder the settings were copied from, or undefined when there was nothing to copy. */
export async function copyLegacyConfig(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const folder = path.dirname(configFile(environment));
  const legacy = path.join(path.dirname(folder), LEGACY_NAME);
  if (await exists(folder)) return undefined;
  const files: string[] = [];
  for (const file of [USER_CONFIG_FILE, LIMITS_FILE]) if (await exists(path.join(legacy, file))) files.push(file);
  if (files.length === 0) return undefined;
  await mkdir(folder, { recursive: true });
  for (const file of files) await copyFile(path.join(legacy, file), path.join(folder, file));
  return legacy;
}
