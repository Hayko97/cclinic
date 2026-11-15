/** Writes the Claude Code plugin's files, and finds the committed ones that differ from them (FR-PLUG-012). */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageInfoSchema, renderClaudePlugin, type PackageInfo } from "../../core/claude-plugin.js";
import { LOGO_FILE, PLUGIN_FOLDER, PLUGIN_ICON_FILE } from "../../core/constants/plugin.js";
import { sha256 } from "./document-store.js";

/** A plugin file's content: text, or the icon's bytes. */
export type PluginFiles = ReadonlyMap<string, string | Buffer>;

export async function readPackageInfo(root: string): Promise<PackageInfo> {
  return packageInfoSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
}

async function filesUnder(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = `${relative}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(root, child) : Promise.resolve([child]);
    }),
  );
  return nested.flat();
}

/** Every plugin file, as `npm run build:plugin` writes it: the rendered text files and the logo (FR-PLUG-015). */
export async function buildPluginFiles(root: string, info?: PackageInfo): Promise<PluginFiles> {
  const rendered = renderClaudePlugin(info ?? (await readPackageInfo(root)), sha256);
  return new Map<string, string | Buffer>([
    ...rendered,
    [`${PLUGIN_FOLDER}/${PLUGIN_ICON_FILE}`, await readFile(path.join(root, LOGO_FILE))],
  ]);
}

/** Replaces the plugin's folder, so a file the plugin no longer has doesn't stay behind. */
export async function writePluginFiles(root: string, files: PluginFiles): Promise<void> {
  await rm(path.join(root, PLUGIN_FOLDER), { recursive: true, force: true });
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** The paths that are missing, different or extra in the repository, sorted. */
export async function findPluginDrift(root: string, files: PluginFiles): Promise<string[]> {
  const drift = new Set<string>();
  for (const [relative, content] of files) {
    const committed = await readFile(path.join(root, relative)).catch(() => undefined);
    if (committed?.equals(typeof content === "string" ? Buffer.from(content) : content) !== true) drift.add(relative);
  }
  for (const relative of await filesUnder(root, PLUGIN_FOLDER)) if (!files.has(relative)) drift.add(relative);
  return [...drift].sort();
}
