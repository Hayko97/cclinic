/** Walks the target folder and applies the exclusion rules (spec: file-discovery). */
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { stripManagedSection } from "../../core/agent-skills.js";
import { BINARY_DOCUMENT_EXTENSIONS, REASONS } from "../../core/constants/discovery.js";
import { BINARY_SNIFF_BYTES, BYTES_PER_MIB, MAX_DOCUMENT_BYTES } from "../../core/constants/limits.js";
import { LUSEEN_IGNORE_FILE, GITIGNORE_FILE, MANAGED_INSTRUCTION_FILES } from "../../core/constants/paths.js";
import { MCP_CONFIG_FILE } from "../../core/constants/workflow.js";
import {
  classifyFile,
  evaluatePath,
  extensionOf,
  hasBinaryContent,
  hasGeneratedMarker,
  looksBundled,
  type RuleContext,
} from "../../core/exclusion-rules.js";
import { holdsOnlyLuseenServer } from "../../core/mcp-config.js";
import type { ScanResult, ScannedFile, SkippedEntry } from "../../core/ports.js";

export interface ScanOptions {
  readonly target: string;
  readonly outFolder: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFileSizeMib: number;
}

interface IgnoreLayer {
  readonly base: string;
  readonly matcher: Ignore;
}

async function readIgnoreFile(file: string): Promise<Ignore | undefined> {
  try {
    return ignore().add(await readFile(file, "utf8"));
  } catch {
    // An ignore file is optional, and most folders don't have one.
    return undefined;
  }
}

function isIgnoredBy(layers: readonly IgnoreLayer[], relative: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const { base, matcher } of layers) {
    const inner = base === "" ? relative : relative.slice(base.length + 1);
    if (inner === "") continue;
    const result = matcher.test(isDirectory ? `${inner}/` : inner);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function hasNupkgFiles(folder: string): Promise<boolean> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".nupkg"))) return true;
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const inner = await readdir(path.join(folder, entry.name));
      if (inner.some((name) => name.endsWith(".nupkg"))) return true;
    }
  } catch {
    // An unreadable folder is reported when the walker reaches it.
  }
  return false;
}

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = new Uint8Array(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** luseen created this file, so counting it would look like a project change on the next run. */
async function holdsOnlyLuseenSection(file: string): Promise<boolean> {
  try {
    const content = await readFile(file, "utf8");
    return content.trim() !== "" && stripManagedSection(content).trim() === "";
  } catch {
    return false;
  }
}

/** FR-MCP-042: a `.mcp.json` luseen created, with only its own server in it. */
async function holdsOnlyLuseenMcpServer(file: string): Promise<boolean> {
  return holdsOnlyLuseenServer(await readFile(file, "utf8").catch(() => ""));
}

/** The scan's rules for a path that may not exist any more, such as one named in Git history (FR-GIT-015). */
export function createPathFilter(
  options: Pick<ScanOptions, "target" | "outFolder" | "include" | "exclude">,
): (relative: string) => boolean {
  const includeMatcher = ignore().add([...options.include]);
  const excludeMatcher = ignore().add([...options.exclude]);
  const relativeOut = path.relative(options.target, options.outFolder).split(path.sep).join("/");
  const context: RuleContext = {
    ...(relativeOut === "" || relativeOut.startsWith("..") ? {} : { outFolder: relativeOut }),
    isExcluded: (relative) => excludeMatcher.ignores(relative),
    isIncluded: (relative) => includeMatcher.ignores(relative),
    isIgnored: () => false,
  };
  return (relative) => evaluatePath(relative, false, context).keep;
}

export async function scanFolder(options: ScanOptions): Promise<ScanResult> {
  const { target } = options;
  const included: ScannedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const nupkgFolders = new Set<string>();
  const includeMatcher = ignore().add([...options.include]);
  const excludeMatcher = ignore().add([...options.exclude]);
  const hasIncludes = options.include.length > 0;
  const textLimit = options.maxFileSizeMib * BYTES_PER_MIB;
  const relativeOut = path.relative(target, options.outFolder).split(path.sep).join("/");
  const outFolder = relativeOut === "" || relativeOut.startsWith("..") ? undefined : relativeOut;

  const rootLayers: IgnoreLayer[] = [];
  const luseenIgnore = await readIgnoreFile(path.join(target, LUSEEN_IGNORE_FILE));
  if (luseenIgnore !== undefined) rootLayers.push({ base: "", matcher: luseenIgnore });

  const contextFor = (layers: readonly IgnoreLayer[]): RuleContext => ({
    ...(outFolder === undefined ? {} : { outFolder }),
    nupkgFolders,
    isExcluded: (relative, isDirectory) => excludeMatcher.ignores(isDirectory ? `${relative}/` : relative),
    isIncluded: (relative, isDirectory) => includeMatcher.ignores(isDirectory ? `${relative}/` : relative),
    isIgnored: (relative, isDirectory) => isIgnoredBy(layers, relative, isDirectory),
  });

  const inspectFile = async (relative: string, absolute: string, forced: boolean): Promise<void> => {
    const skip = (reason: string): void => {
      skipped.push({ path: relative, reason });
    };
    try {
      const { size } = await lstat(absolute);
      const isBinaryDocument = BINARY_DOCUMENT_EXTENSIONS.has(extensionOf(relative));
      if (isBinaryDocument) {
        if (size > MAX_DOCUMENT_BYTES && !forced) {
          skip(REASONS.tooLarge);
          return;
        }
      } else {
        if (hasBinaryContent(await readHead(absolute))) {
          skip(forced ? REASONS.unreadableBinary : REASONS.binary);
          return;
        }
        if (size > textLimit && !forced) {
          skip(REASONS.tooLarge);
          return;
        }
        if (!forced) {
          const text = await readFile(absolute, "utf8");
          if (hasGeneratedMarker(text)) {
            skip(REASONS.generated);
            return;
          }
          if (looksBundled(text)) {
            skip(REASONS.minified);
            return;
          }
        }
      }
      included.push({ path: relative, absolutePath: absolute, kind: classifyFile(relative), sizeBytes: size });
    } catch {
      skip(REASONS.unreadable);
    }
  };

  const walk = async (folder: string, relativeFolder: string, parentLayers: readonly IgnoreLayer[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      if (relativeFolder !== "") skipped.push({ path: relativeFolder, reason: REASONS.unreadable });
      return;
    }
    const gitignore = await readIgnoreFile(path.join(folder, GITIGNORE_FILE));
    const layers =
      gitignore === undefined ? parentLayers : [...parentLayers, { base: relativeFolder, matcher: gitignore }];
    const context = contextFor(layers);

    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(folder, entry.name);
      const relative = relativeFolder === "" ? entry.name : `${relativeFolder}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: REASONS.symlink });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "packages" && (await hasNupkgFiles(absolute))) nupkgFolders.add(relative);
        const decision = evaluatePath(relative, true, context);
        if (decision.keep || (decision.overridable && hasIncludes)) {
          await walk(absolute, relative, layers);
        } else {
          skipped.push({ path: `${relative}/`, reason: decision.reason });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (MANAGED_INSTRUCTION_FILES.includes(relative) && (await holdsOnlyLuseenSection(absolute))) continue;
      if (relative === MCP_CONFIG_FILE && (await holdsOnlyLuseenMcpServer(absolute))) continue;
      const decision = evaluatePath(relative, false, context);
      if (decision.keep) await inspectFile(relative, absolute, decision.forced);
      else skipped.push({ path: relative, reason: decision.reason });
    }
  };

  await walk(target, "", rootLayers);
  return { included, skipped };
}
