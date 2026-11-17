/** Reads the environment file, and records file states to spot changes made by the environment step. */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DEPENDENCY_FOLDERS } from "../../core/constants/discovery.js";
import { GIT_FOLDER } from "../../core/constants/git.js";
import { ENVIRONMENT_FILE_PATH, environmentFileSchema, type EnvironmentFile } from "../../core/environment.js";

export type EnvironmentFileState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "valid"; readonly file: EnvironmentFile };

export async function readEnvironmentFile(target: string): Promise<EnvironmentFileState> {
  let text: string;
  try {
    text = await readFile(path.join(target, ENVIRONMENT_FILE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", problems: ["It isn't valid JSON."] };
  }
  const result = environmentFileSchema.safeParse(parsed);
  if (result.success) return { kind: "valid", file: result.data };
  return {
    kind: "invalid",
    problems: result.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`),
  };
}

/**
 * Sizes and modified times are enough here. Dependency folders are skipped because builds rewrite them, and the
 * step's own folder because it's allowed to write there (FR-ENV-011, FR-DSGN-031).
 */
export async function snapshotFiles(target: string, ownFolder: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(path.join(target, folder), { withFileTypes: true })) {
      const relative = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== GIT_FOLDER && !DEPENDENCY_FOLDERS.has(entry.name) && relative !== ownFolder) {
          await walk(relative);
        }
      } else if (entry.isFile()) {
        const info = await stat(path.join(target, relative));
        files.set(relative, `${info.size}:${info.mtimeMs}`);
      }
    }
  };
  await walk("");
  return files;
}
