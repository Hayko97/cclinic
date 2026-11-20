/** A new project's first files: the approved brief as README.md, and the user's files in docs/ (FR-PLAN-051). */
import { constants } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BRIEF_FILE, PROJECT_DOCS_FOLDER } from "../../core/constants/agents.js";
import { UsageError } from "../../core/errors.js";

/** `name`, or `name-2`, `name-3` and so on before the extension, for the n-th try. */
function numbered(name: string, attempt: number): string {
  if (attempt === 1) return name;
  const extension = path.extname(name);
  return `${name.slice(0, name.length - extension.length)}-${attempt}${extension}`;
}

/** Copies a file into `folder` under its name, numbered on a clash, never overwriting one. Returns the name used. */
async function copyUnique(file: string, folder: string, name: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = numbered(name, attempt);
    try {
      await copyFile(file, path.join(folder, candidate), constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * A name for a copy in docs/: the file's own name, without any folders, so a name such as `../x.png` can't reach
 * outside it. Refuses one that is only dots.
 */
function docsName(name: string): string {
  const base = path.basename(name.replaceAll("\\", "/"));
  if (base === "" || /^\.+$/.test(base)) throw new UsageError(`${name} can't be copied to ${PROJECT_DOCS_FOLDER}/.`);
  return base;
}

/**
 * Writes the brief, refusing when README.md exists, then copies each file, given relative to the project, to docs/.
 * A copy that fails removes what this wrote, so a refused or failed brief writes nothing. Returns the paths
 * written, relative to the project.
 */
export async function writeProjectBrief(
  target: string,
  markdown: string,
  files: readonly { readonly path: string; readonly name: string }[],
): Promise<string[]> {
  const readme = path.join(target, BRIEF_FILE);
  try {
    await writeFile(readme, `${markdown.trim()}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new UsageError(
      `${BRIEF_FILE} already exists, so the brief wasn't saved. Move or remove ${BRIEF_FILE}, then approve the brief again.`,
    );
  }
  const docs = path.join(target, PROJECT_DOCS_FOLDER);
  const copied: string[] = [];
  let madeDocs = false;
  try {
    if (files.length > 0) madeDocs = (await mkdir(docs, { recursive: true })) !== undefined;
    for (const file of files) copied.push(await copyUnique(path.join(target, file.path), docs, docsName(file.name)));
  } catch (error) {
    const written = madeDocs ? [readme, docs] : [readme, ...copied.map((name) => path.join(docs, name))];
    await Promise.all(written.map((file) => rm(file, { recursive: true, force: true })));
    throw error;
  }
  return [BRIEF_FILE, ...copied.map((name) => `${PROJECT_DOCS_FOLDER}/${name}`)];
}
